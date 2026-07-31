'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { logInfo, logError, importCostForWindow, exportCredit } = require('powerplant-shared');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const RANGE_SECONDS = {
    day: 24 * 60 * 60,
    week: 7 * 24 * 60 * 60
};

// Matches ReportFunction.REPORT_RECORD_PREFIX / BatteryControlFunction.
// BATTERY_STATUS_RECORD_PREFIX/BATTERY_SETTINGS_PREFIX/SETTINGS_TIMESTAMP —
// kept as literals here (rather than a shared import) since this Lambda
// otherwise has no dependency on either of those modules.
const REPORT_RECORD_PREFIX = 'REPORT#';
const BATTERY_STATUS_RECORD_PREFIX = 'BATTERY_CONTROL#';
const BATTERY_SETTINGS_PREFIX = 'BATTERY_CONTROL_SETTINGS#';
const SETTINGS_TIMESTAMP = 0;

// pvYieldKwh/importKwh/exportKwh are deltas of the Inverter device's cumulative
// totalYield/totalImportEnergy/totalExportEnergy counters. batteryChargeKwh/
// batteryDischargeKwh/currentBatterySOC are only present when PollerFunction
// successfully attached battery fields to every reading in range (it discovers
// the battery device automatically — see PollerFunction.js — but can still come
// up empty if none is configured/discoverable).

exports.handler = async (event) => {
    if (event.resource === '/insights' && event.httpMethod === 'POST') {
        return handleTriggerAssessment();
    }

    if (event.resource === '/insights') {
        return handleInsights();
    }

    if (event.resource === '/battery-status') {
        return handleBatteryStatus();
    }

    if (event.resource === '/battery-settings' && event.httpMethod === 'PUT') {
        return handlePutBatterySettings(event);
    }

    if (event.resource === '/battery-settings') {
        return handleGetBatterySettings();
    }

    return handleReadings(event);
};

async function handleReadings(event) {
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
}

// Latest nightly report — ReportFunction.buildReportRecord — stored under a
// sentinel DeviceSn in the same table, so this needs no separate data store.
async function handleInsights() {
    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const item = await queryLatestSentinelRecord(`${REPORT_RECORD_PREFIX}${deviceSn}`);
        return response(200, formatInsightsResponse(item));
    } catch (err) {
        logError('Insights query failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

// Last night's weather classification + chargeUpperSoc decision —
// BatteryControlFunction.buildBatteryStatusRecord, same sentinel-DeviceSn
// pattern as /insights, queried via the same helper below.
async function handleBatteryStatus() {
    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const item = await queryLatestSentinelRecord(`${BATTERY_STATUS_RECORD_PREFIX}${deviceSn}`);
        return response(200, formatBatteryStatusResponse(item));
    } catch (err) {
        logError('Battery status query failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

function formatBatteryStatusResponse(item) {
    if (!item) {
        return { available: false };
    }

    return {
        available: true,
        decidedAt: item.Timestamp,
        classification: item.classification,
        reasoning: item.reasoning,
        chargeUpperSoc: item.chargeUpperSoc,
        dryRun: item.dryRun,
        applied: item.applied,
        enabled: item.enabled ?? true,
        previousAssessment: item.previousAssessment || null
    };
}

// Asynchronously invokes ReportFunction to refresh /insights on demand,
// outside its own nightly schedule — Event (fire-and-forget) invocation since
// the Bedrock call inside can run longer than API Gateway's own 29s timeout.
// sendEmail:false means this run updates the stored insights record without
// also sending another nightly-style email — see ReportFunction.js.
async function handleTriggerAssessment() {
    try {
        await lambdaClient.send(new InvokeCommand({
            FunctionName: process.env.REPORT_FUNCTION_NAME,
            InvocationType: 'Event',
            Payload: JSON.stringify({ sendEmail: false })
        }));
        return response(202, { triggered: true, message: 'Assessment started — check back in a minute or two.' });
    } catch (err) {
        logError('Failed to trigger assessment', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

// Dashboard-editable overrides for BatteryControlFunction's nightly decision —
// same sentinel-key settings row it reads (BatteryControlFunction.loadSettingsOverride).
async function handleGetBatterySettings() {
    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const result = await docClient.send(new GetCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            Key: { DeviceSn: `${BATTERY_SETTINGS_PREFIX}${deviceSn}`, Timestamp: SETTINGS_TIMESTAMP }
        }));
        return response(200, formatBatterySettingsResponse(result.Item));
    } catch (err) {
        logError('Battery settings query failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

async function handlePutBatterySettings(event) {
    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return response(400, { message: 'Request body must be valid JSON' });
    }

    const validationError = validateBatterySettings(body);
    if (validationError) {
        return response(400, { message: validationError });
    }

    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const item = {
            DeviceSn: `${BATTERY_SETTINGS_PREFIX}${deviceSn}`,
            Timestamp: SETTINGS_TIMESTAMP,
            enabled: body.enabled,
            chargeUpperSocSunny: body.chargeUpperSocSunny,
            chargeUpperSocOvercast: body.chargeUpperSocOvercast,
            disabledChargeUpperSoc: body.disabledChargeUpperSoc
        };

        await docClient.send(new PutCommand({ TableName: process.env.ENERGY_READINGS_TABLE, Item: item }));
        logInfo('Battery control settings updated', item);
        return response(200, formatBatterySettingsResponse(item));
    } catch (err) {
        logError('Battery settings update failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

function validateBatterySettings(body) {
    if (typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
    if (!isValidPercent(body.chargeUpperSocSunny)) return 'chargeUpperSocSunny must be a number between 0 and 100';
    if (!isValidPercent(body.chargeUpperSocOvercast)) return 'chargeUpperSocOvercast must be a number between 0 and 100';
    if (!isValidPercent(body.disabledChargeUpperSoc)) return 'disabledChargeUpperSoc must be a number between 0 and 100';
    return null;
}

function isValidPercent(n) {
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
}

function formatBatterySettingsResponse(item) {
    return {
        enabled: item?.enabled ?? true,
        chargeUpperSocSunny: item?.chargeUpperSocSunny ?? Number(process.env.BATTERY_CONTROL_DEFAULT_SUNNY),
        chargeUpperSocOvercast: item?.chargeUpperSocOvercast ?? Number(process.env.BATTERY_CONTROL_DEFAULT_OVERCAST),
        disabledChargeUpperSoc: item?.disabledChargeUpperSoc ?? Number(process.env.BATTERY_CONTROL_DEFAULT_DISABLED),
        usingDefaults: !item
    };
}

async function queryLatestSentinelRecord(reportDeviceSn) {
    const result = await docClient.send(new QueryCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        KeyConditionExpression: 'DeviceSn = :sn',
        ExpressionAttributeValues: { ':sn': reportDeviceSn },
        ScanIndexForward: false,
        Limit: 1
    }));

    return result.Items?.[0] || null;
}

function formatInsightsResponse(item) {
    if (!item) {
        return { available: false };
    }

    return {
        available: true,
        generatedAt: item.Timestamp,
        lookbackDays: item.lookbackDays,
        assessment: item.assessment,
        recommendation: item.recommendation,
        aiInsights: item.aiInsights || null
    };
}

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
module.exports.formatInsightsResponse = formatInsightsResponse;
module.exports.formatBatteryStatusResponse = formatBatteryStatusResponse;
module.exports.formatBatterySettingsResponse = formatBatterySettingsResponse;
module.exports.validateBatterySettings = validateBatterySettings;
