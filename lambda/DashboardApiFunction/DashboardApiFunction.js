'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { logInfo, logError, importCostForWindow, exportCredit } = require('powerplant-shared');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const RANGE_SECONDS = {
    day: 24 * 60 * 60,
    week: 7 * 24 * 60 * 60
};

// pvYieldKwh/importKwh/exportKwh are deltas of the Inverter device's cumulative
// totalYield/totalImportEnergy/totalExportEnergy counters. batteryChargeKwh/
// batteryDischargeKwh/currentBatterySOC are only present when PollerFunction
// successfully attached battery fields to every reading in range (it discovers
// the battery device automatically — see PollerFunction.js — but can still come
// up empty if none is configured/discoverable).

exports.handler = async (event) => {
    const range = event.queryStringParameters?.range || 'day';
    logInfo('DashboardApiFunction invoked', { range });

    if (!RANGE_SECONDS[range]) {
        return response(400, {
            message: `Invalid range "${range}" — expected one of: ${Object.keys(RANGE_SECONDS).join(', ')}`
        });
    }

    try {
        const tariff = JSON.parse(process.env.TARIFF_STRUCTURE);
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const endSeconds = Math.floor(Date.now() / 1000);
        const startSeconds = endSeconds - RANGE_SECONDS[range];

        const readings = await queryReadings(deviceSn, startSeconds, endSeconds);

        if (readings.length === 0) {
            return response(200, { range, deviceSn, readingCount: 0 });
        }

        const rollup = aggregateReadings(readings, tariff);
        logInfo('Rollup computed', { range, deviceSn, readingCount: readings.length });
        return response(200, { range, deviceSn, ...rollup });
    } catch (err) {
        logError('Dashboard query failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
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

function aggregateReadings(readings, tariff) {
    const first = readings[0];
    const last = readings[readings.length - 1];

    const pvYieldKwh = last.totalYield - first.totalYield;
    const importKwh = last.totalImportEnergy - first.totalImportEnergy;
    const exportKwh = last.totalExportEnergy - first.totalExportEnergy;

    let importCost = 0;
    for (let i = 1; i < readings.length; i++) {
        const deltaImportKwh = readings[i].totalImportEnergy - readings[i - 1].totalImportEnergy;
        if (deltaImportKwh <= 0) continue;
        importCost += importCostForWindow(tariff, readings[i].Timestamp, deltaImportKwh).cost;
    }

    const credit = exportCredit(tariff, exportKwh);

    return {
        readingCount: readings.length,
        from: first.Timestamp,
        to: last.Timestamp,
        pvYieldKwh: round2(pvYieldKwh),
        importKwh: round2(importKwh),
        exportKwh: round2(exportKwh),
        importCost: round2(importCost),
        exportCredit: round2(credit),
        netCost: round2(importCost - credit),
        currency: tariff.currency,
        ...batterySummary(first, last)
    };
}

function batterySummary(first, last) {
    if (typeof first.totalDeviceCharge !== 'number' || typeof last.totalDeviceCharge !== 'number') {
        return {};
    }

    return {
        batteryChargeKwh: round2(last.totalDeviceCharge - first.totalDeviceCharge),
        batteryDischargeKwh: round2(last.totalDeviceDischarge - first.totalDeviceDischarge),
        currentBatterySOC: last.batterySOC
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function response(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}

module.exports.aggregateReadings = aggregateReadings;
