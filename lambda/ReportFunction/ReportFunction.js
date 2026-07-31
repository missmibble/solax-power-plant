'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const {
    logInfo,
    logError,
    findImportRateWindow,
    importCostForWindow,
    exportCredit,
    localDateString
} = require('powerplant-shared');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

const LOOKBACK_DAYS = Number(process.env.REPORT_LOOKBACK_DAYS) || 1;
const AI_HISTORY_LOOKBACK_DAYS = Number(process.env.AI_HISTORY_LOOKBACK_DAYS) || 14;
const PEAK_WINDOW_LABEL = 'peak-evening';
const LOW_SOC_THRESHOLD = 30;

// Report records share the readings table (same partition/sort key schema)
// under a sentinel DeviceSn that can't collide with a real inverter serial —
// DashboardApiFunction's /insights route queries the same prefix to surface
// the latest one on the dashboard.
const REPORT_RECORD_PREFIX = 'REPORT#';

const AI_SYSTEM_PROMPT = `You are an energy analyst for a home solar + battery system. You are given \
today's usage assessment (import broken down by tariff window, PV yield, export, and battery charge/ \
discharge/SOC if available) plus a day-by-day summary of the recent history for context. Respond with \
ONLY a JSON object of the form {"narrative": string, "anomalies": string[]} — no text outside the JSON.

"narrative": 2-4 plain-English sentences assessing today against the recent pattern, and whether the \
existing recommendation still makes sense in that context.
"anomalies": notable deviations from the recent pattern (empty array if none) — e.g. an unusual drop in \
PV yield, an import spike outside the normal pattern, or battery behaviour that differs from recent days. \
Do not restate ordinary day-to-day variation as an anomaly.`;

// Battery charge/discharge/SOC fields are only present when PollerFunction
// successfully attached them (it discovers the battery device automatically —
// see PollerFunction.js). Without them, the recommendation falls back to
// grid-pattern-only reasoning.

// event.sendEmail — defaults true (bare EventBridge scheduled invocations, and
// anything else with no payload, keep today's behavior). Explicitly false for
// the 6x/day refresh schedule and the dashboard's manual "run assessment now"
// trigger — both want a fresh assessment + stored record without also
// sending another nightly-style email each time.
exports.handler = async (event) => {
    const sendEmail = event?.sendEmail !== false;

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
        const aiInsights = await getAiInsights(assessment, tariff, deviceSn, endSeconds);
        const recommendationText = recommendation(assessment, tariff);
        const report = formatReport(assessment, tariff, LOOKBACK_DAYS, aiInsights);

        if (sendEmail) {
            await snsClient.send(new PublishCommand({
                TopicArn: process.env.REPORTS_TOPIC_ARN,
                Subject: `PowerPlant nightly report — ${LOOKBACK_DAYS}-day summary`,
                Message: report
            }));
        }

        // Best-effort — the dashboard's "AI insights" section just falls back to
        // its last successfully stored record if this write fails, so it never
        // blocks a sent email (if any, above) on a DynamoDB hiccup.
        try {
            await docClient.send(new PutCommand({
                TableName: process.env.ENERGY_READINGS_TABLE,
                Item: buildReportRecord(deviceSn, endSeconds, LOOKBACK_DAYS, assessment, recommendationText, aiInsights)
            }));
        } catch (err) {
            logError('Failed to store report record for the dashboard', { error: err.message });
        }

        logInfo(sendEmail ? 'Nightly report published' : 'Assessment refreshed (no email)', { deviceSn, readingCount: readings.length });
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

// Groups readings into calendar-day PV yield/import/export deltas (local time,
// per tariff.timezone) as compact context for the AI insights prompt — sending
// day totals instead of the raw 5-minute time series keeps the prompt small.
function dailySummaries(readings, tariff) {
    const byDate = new Map();

    for (let i = 1; i < readings.length; i++) {
        const deltaPv = readings[i].totalYield - readings[i - 1].totalYield;
        const deltaImport = readings[i].totalImportEnergy - readings[i - 1].totalImportEnergy;
        const deltaExport = readings[i].totalExportEnergy - readings[i - 1].totalExportEnergy;

        const date = localDateString(readings[i].Timestamp, tariff.timezone);
        const day = byDate.get(date) || { date, pvYieldKwh: 0, importKwh: 0, exportKwh: 0 };
        // Each counter is checked independently (rather than dropping the whole
        // interval) so one reset counter doesn't also discard the others' deltas.
        if (deltaPv > 0) day.pvYieldKwh += deltaPv;
        if (deltaImport > 0) day.importKwh += deltaImport;
        if (deltaExport > 0) day.exportKwh += deltaExport;
        byDate.set(date, day);
    }

    return [...byDate.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(d => ({
            date: d.date,
            pvYieldKwh: round2(d.pvYieldKwh),
            importKwh: round2(d.importKwh),
            exportKwh: round2(d.exportKwh)
        }));
}

// AI narrative + pattern-based anomaly flags, layered on top of (not replacing)
// the deterministic recommendation() heuristic above. Never fails the report:
// a missing model config, a Bedrock error, or an unparsable response all just
// mean the report goes out without this section.
async function getAiInsights(assessment, tariff, deviceSn, endSeconds) {
    const modelId = process.env.BEDROCK_MODEL_ID;
    if (!modelId) return null;

    try {
        const historyStart = endSeconds - AI_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60;
        const historyReadings = await queryReadings(deviceSn, historyStart, endSeconds);
        const recentDays = dailySummaries(historyReadings, tariff);

        const prompt = JSON.stringify({
            today: assessment,
            recentDays,
            feedInRate: tariff.feedInRate,
            currency: tariff.currency
        });

        const response = await bedrockClient.send(new InvokeModelCommand({
            modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 500,
                system: AI_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: prompt }]
            })
        }));

        const payload = JSON.parse(new TextDecoder().decode(response.body));
        return parseAiResponse(payload.content?.[0]?.text || '');
    } catch (err) {
        logError('AI insights failed', { error: err.message });
        return null;
    }
}

function parseAiResponse(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (typeof parsed.narrative !== 'string') return null;

    return {
        narrative: parsed.narrative,
        anomalies: Array.isArray(parsed.anomalies) ? parsed.anomalies : []
    };
}

function formatReport(assessment, tariff, lookbackDays, aiInsights) {
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

    if (aiInsights) {
        lines.push('', 'AI insights:', `  ${aiInsights.narrative}`);
        lines.push('', aiInsights.anomalies.length
            ? 'Anomalies flagged:'
            : 'Anomalies flagged: none');
        for (const anomaly of aiInsights.anomalies) {
            lines.push(`  - ${anomaly}`);
        }
    }

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

function buildReportRecord(deviceSn, timestampSeconds, lookbackDays, assessment, recommendationText, aiInsights) {
    return {
        DeviceSn: `${REPORT_RECORD_PREFIX}${deviceSn}`,
        Timestamp: timestampSeconds,
        lookbackDays,
        assessment,
        recommendation: recommendationText,
        aiInsights: aiInsights || null
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports.assessUsage = assessUsage;
module.exports.formatReport = formatReport;
module.exports.dailySummaries = dailySummaries;
module.exports.parseAiResponse = parseAiResponse;
module.exports.getAiInsights = getAiInsights;
module.exports.recommendation = recommendation;
module.exports.buildReportRecord = buildReportRecord;
module.exports.REPORT_RECORD_PREFIX = REPORT_RECORD_PREFIX;
