'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { logInfo, logError, findImportRateWindow, importCostForWindow, exportCredit } = require('powerplant-shared');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const snsClient = new SNSClient({ region: process.env.AWS_REGION });

const LOOKBACK_DAYS = Number(process.env.REPORT_LOOKBACK_DAYS) || 1;
const PEAK_WINDOW_LABEL = 'peak-evening';
const LOW_SOC_THRESHOLD = 30;

// Battery charge/discharge/SOC fields are only present when PollerFunction
// successfully attached them (it discovers the battery device automatically —
// see PollerFunction.js). Without them, the recommendation falls back to
// grid-pattern-only reasoning.

exports.handler = async () => {
    try {
        const tariff = JSON.parse(process.env.TARIFF_STRUCTURE);
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const endSeconds = Math.floor(Date.now() / 1000);
        const startSeconds = endSeconds - LOOKBACK_DAYS * 24 * 60 * 60;

        const readings = await queryReadings(deviceSn, startSeconds, endSeconds);

        if (readings.length < 2) {
            logInfo('Not enough readings for a report yet', { deviceSn, count: readings.length });
            return { statusCode: 200 };
        }

        const assessment = assessUsage(readings, tariff);
        const report = formatReport(assessment, tariff, LOOKBACK_DAYS);

        await snsClient.send(new PublishCommand({
            TopicArn: process.env.REPORTS_TOPIC_ARN,
            Subject: `PowerPlant nightly report — ${LOOKBACK_DAYS}-day summary`,
            Message: report
        }));

        logInfo('Nightly report published', { deviceSn, readingCount: readings.length });
        return { statusCode: 200 };
    } catch (err) {
        logError('Nightly report failed', { error: err.message });
        throw err;
    }
};

async function queryReadings(deviceSn, startSeconds, endSeconds) {
    const readings = [];
    let exclusiveStartKey;

    do {
        const result = await docClient.send(new QueryCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            KeyConditionExpression: 'DeviceSn = :sn AND #ts BETWEEN :start AND :end',
            ExpressionAttributeNames: { '#ts': 'Timestamp' },
            ExpressionAttributeValues: { ':sn': deviceSn, ':start': startSeconds, ':end': endSeconds },
            ExclusiveStartKey: exclusiveStartKey
        }));

        readings.push(...(result.Items || []));
        exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return readings;
}

function assessUsage(readings, tariff) {
    const byWindow = {};
    for (const w of tariff.importRates) {
        byWindow[w.label] = { importKwh: 0, cost: 0, rate: w.rate };
    }

    let exportKwh = 0;
    const pvYieldKwh = readings[readings.length - 1].totalYield - readings[0].totalYield;

    for (let i = 1; i < readings.length; i++) {
        const deltaImport = readings[i].totalImportEnergy - readings[i - 1].totalImportEnergy;
        const deltaExport = readings[i].totalExportEnergy - readings[i - 1].totalExportEnergy;

        if (deltaExport > 0) exportKwh += deltaExport;

        if (deltaImport > 0) {
            const { window } = importCostForWindow(tariff, readings[i].Timestamp, deltaImport);
            if (window && byWindow[window]) {
                byWindow[window].importKwh += deltaImport;
                byWindow[window].cost += deltaImport * byWindow[window].rate;
            }
        }
    }

    const totalImportCost = Object.values(byWindow).reduce((sum, w) => sum + w.cost, 0);
    const totalExportCredit = exportCredit(tariff, exportKwh);
    const peakImportKwh = byWindow[PEAK_WINDOW_LABEL]?.importKwh || 0;

    return {
        pvYieldKwh: round2(pvYieldKwh),
        exportKwh: round2(exportKwh),
        byWindow,
        totalImportCost: round2(totalImportCost),
        totalExportCredit: round2(totalExportCredit),
        netCost: round2(totalImportCost - totalExportCredit),
        peakImportKwh: round2(peakImportKwh),
        ...batterySummary(readings, tariff)
    };
}

function batterySummary(readings, tariff) {
    const first = readings[0];
    const last = readings[readings.length - 1];
    if (typeof first.totalDeviceCharge !== 'number' || typeof last.totalDeviceCharge !== 'number') {
        return {};
    }

    const peakReadings = readings.filter(
        r => findImportRateWindow(tariff, r.Timestamp)?.label === PEAK_WINDOW_LABEL
    );

    return {
        batteryChargeKwh: round2(last.totalDeviceCharge - first.totalDeviceCharge),
        batteryDischargeKwh: round2(last.totalDeviceDischarge - first.totalDeviceDischarge),
        currentBatterySOC: last.batterySOC,
        peakWindowStartSOC: peakReadings[0]?.batterySOC,
        peakWindowEndSOC: peakReadings[peakReadings.length - 1]?.batterySOC
    };
}

function formatReport(assessment, tariff, lookbackDays) {
    const lines = [
        `PowerPlant usage report — last ${lookbackDays} day(s)`,
        '',
        `PV yield: ${assessment.pvYieldKwh} kWh`,
        `Grid export: ${assessment.exportKwh} kWh (credit: ${assessment.totalExportCredit} ${tariff.currency})`
    ];

    if (typeof assessment.batteryChargeKwh === 'number') {
        lines.push(
            `Battery: charged ${assessment.batteryChargeKwh} kWh, discharged ${assessment.batteryDischargeKwh} kWh, ` +
            `currently at ${assessment.currentBatterySOC}% SOC`
        );
    }

    lines.push('', 'Import by tariff window:');

    for (const [label, w] of Object.entries(assessment.byWindow)) {
        lines.push(`  ${label}: ${round2(w.importKwh)} kWh @ ${w.rate}/kWh = ${round2(w.cost)} ${tariff.currency}`);
    }

    lines.push('');
    lines.push(`Total import cost: ${assessment.totalImportCost} ${tariff.currency}`);
    lines.push(`Net cost (import - export credit): ${assessment.netCost} ${tariff.currency}`);
    lines.push('');
    lines.push(recommendation(assessment, tariff));

    return lines.join('\n');
}

function recommendation(assessment, tariff) {
    if (assessment.peakImportKwh <= 0.5) {
        return 'Recommendation: no significant peak-window import detected — current battery configuration looks to be covering peak demand.';
    }

    const peakRate = tariff.importRates.find(w => w.label === PEAK_WINDOW_LABEL)?.rate;
    const base =
        `Recommendation: ${assessment.peakImportKwh} kWh was imported during the peak window ` +
        `(${peakRate}/kWh). Feed-in is only ${tariff.feedInRate}/kWh, so holding more battery charge into ` +
        `this window — rather than exporting surplus earlier — would likely be worth more than any credit ` +
        `from exporting it.`;

    if (typeof assessment.peakWindowStartSOC !== 'number' || typeof assessment.peakWindowEndSOC !== 'number') {
        return base;
    }

    if (assessment.peakWindowStartSOC < LOW_SOC_THRESHOLD) {
        return (
            `${base} Battery SOC was already only ${assessment.peakWindowStartSOC}% when the peak window started ` +
            `(ended at ${assessment.peakWindowEndSOC}%) — the battery was depleted before peak even began, so ` +
            `increasing the overnight/solar charge target is likely more effective here than changing peak-window behaviour.`
        );
    }

    return (
        `${base} Battery SOC went from ${assessment.peakWindowStartSOC}% to ${assessment.peakWindowEndSOC}% across ` +
        `the peak window, so it ran out before covering all of it — a higher discharge cutoff SOC or larger capacity ` +
        `would extend coverage.`
    );
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports.assessUsage = assessUsage;
module.exports.formatReport = formatReport;
