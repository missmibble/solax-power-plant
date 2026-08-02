'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { logInfo, logError, importCostForWindow, exportCredit, startOfLocalDay } = require('powerplant-shared');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

let cachedWeatherApiKey = null; // reused across warm invocations, same pattern as BatteryControlFunction

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
// Matches GridDischargeFunction.SETTINGS_PREFIX — also written by
// SettingsOptimizerFunction (fallbackReservePercent/safetyMarginPercent, when
// autoApply: true), so the PUT handler below merges rather than replaces —
// unlike battery-settings, this dashboard form doesn't own every field in
// the row and must not clobber ones it doesn't know about.
const GRID_DISCHARGE_SETTINGS_PREFIX = 'GRID_DISCHARGE_SETTINGS#';
// Matches SettingsOptimizerFunction.STATUS_RECORD_PREFIX — its weekly
// recommendation record, read-only here (this Lambda never writes it).
const SETTINGS_OPTIMIZATION_PREFIX = 'SETTINGS_OPTIMIZATION#';
const SETTINGS_TIMESTAMP = 0;

// Per-field provenance for a dashboard-editable settings row: 'default' when
// the row (or that specific field within it) doesn't exist yet and the
// response fell back to the config/env default; otherwise whatever
// SOURCE_LABEL the writer tagged it with, defaulting to 'dashboard' for rows
// written before source-tracking existed (dashboard saves were the only
// writer for a long time, so that's the correct historical assumption).
function fieldSource(item, field) {
    if (!item || item[field] === undefined) return 'default';
    return item.sources?.[field] || 'dashboard';
}

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

    if (event.resource === '/grid-discharge' && event.httpMethod === 'POST') {
        return handleTriggerGridDischargeExit();
    }

    if (event.resource === '/grid-discharge-settings' && event.httpMethod === 'PUT') {
        return handlePutGridDischargeSettings(event);
    }

    if (event.resource === '/grid-discharge-settings') {
        return handleGetGridDischargeSettings();
    }

    if (event.resource === '/settings-optimization') {
        return handleSettingsOptimization();
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
        // "Today" means the local calendar day (midnight to now), not a rolling
        // 24h window — a rolling window still shows most of yesterday's PV yield
        // if viewed early in the morning, which reads as wrong even though the
        // arithmetic is correct. "This week" is still a rolling 7 days.
        const startSeconds = range === 'day'
            ? startOfLocalDay(endSeconds, tariff.timezone)
            : endSeconds - RANGE_SECONDS[range];

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

// SettingsOptimizerFunction's latest weekly recommendation — read-only, same
// sentinel-DeviceSn pattern as /insights. Lets the dashboard show what the AI
// last recommended/applied without the reader needing to check CloudWatch
// Logs or the weekly email.
async function handleSettingsOptimization() {
    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const item = await queryLatestSentinelRecord(`${SETTINGS_OPTIMIZATION_PREFIX}${deviceSn}`);
        return response(200, formatSettingsOptimizationResponse(item));
    } catch (err) {
        logError('Settings optimization query failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

function formatSettingsOptimizationResponse(item) {
    if (!item) {
        return { available: false };
    }

    return {
        available: true,
        assessedAt: item.Timestamp,
        recommendations: item.recommendations || null,
        confidence: item.confidence || null,
        reasoning: item.reasoning || null,
        applied: item.applied,
        autoApply: item.autoApply
    };
}

// Last night's weather classification + chargeUpperSoc decision —
// BatteryControlFunction.buildBatteryStatusRecord, same sentinel-DeviceSn
// pattern as /insights, queried via the same helper below — plus a live
// current-conditions call so the dashboard's weather widget always has
// something current to show, independent of whether last night's decision
// exists yet.
async function handleBatteryStatus() {
    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const [item, currentWeather] = await Promise.all([
            queryLatestSentinelRecord(`${BATTERY_STATUS_RECORD_PREFIX}${deviceSn}`),
            fetchCurrentWeather()
        ]);
        return response(200, formatBatteryStatusResponse(item, currentWeather));
    } catch (err) {
        logError('Battery status query failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

async function loadWeatherApiKey() {
    if (cachedWeatherApiKey) return cachedWeatherApiKey;

    const result = await ssmClient.send(new GetParameterCommand({
        Name: process.env.WEATHER_API_KEY_PARAM,
        WithDecryption: true
    }));

    cachedWeatherApiKey = result.Parameter.Value;
    return cachedWeatherApiKey;
}

// OpenWeatherMap's current-conditions endpoint (distinct from the 5-day/3-hour
// forecast BatteryControlFunction uses for tomorrow) — called live on every
// request rather than cached, since "now" is only useful if it's actually now.
// Same graceful-degradation pattern as everything else additive in this app:
// not configured, an API error, or an unparsable response all just mean the
// widget shows the forecast decision without a current-conditions line, never
// a failed request.
async function fetchCurrentWeather() {
    if (!process.env.WEATHER_API_KEY_PARAM || !process.env.WEATHER_LAT || !process.env.WEATHER_LON) return null;

    try {
        const apiKey = await loadWeatherApiKey();
        const url = new URL('https://api.openweathermap.org/data/2.5/weather');
        url.searchParams.set('lat', process.env.WEATHER_LAT);
        url.searchParams.set('lon', process.env.WEATHER_LON);
        url.searchParams.set('appid', apiKey);
        url.searchParams.set('units', 'metric');

        const res = await fetch(url);
        const payload = await res.json();
        if (String(payload.cod) !== '200') return null;

        return {
            tempC: Math.round(payload.main?.temp),
            description: payload.weather?.[0]?.description || null
        };
    } catch (err) {
        logError('Current weather fetch failed', { error: err.message });
        return null;
    }
}

function formatBatteryStatusResponse(item, currentWeather) {
    if (!item) {
        return { available: false, currentWeather: currentWeather || null };
    }

    return {
        available: true,
        currentWeather: currentWeather || null,
        decidedAt: item.Timestamp,
        classification: item.classification,
        reasoning: item.reasoning,
        chargeUpperSoc: item.chargeUpperSoc,
        dryRun: item.dryRun,
        applied: item.applied,
        enabled: item.enabled ?? true,
        appliesToDate: item.appliesToDate || null,
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

// Manual "terminate discharge early" button — invokes GridDischargeFunction's
// exit phase on demand, same InvocationType: 'Event' fire-and-forget pattern
// as handleTriggerAssessment. Reuses the existing exit phase unchanged (it
// already unconditionally calls exit_vpp_mode and hands control back to Self
// Use), so this is just an on-demand trigger, not new discharge-control logic
// — safe to press even if nothing is currently running.
async function handleTriggerGridDischargeExit() {
    try {
        await lambdaClient.send(new InvokeCommand({
            FunctionName: process.env.GRID_DISCHARGE_FUNCTION_NAME,
            InvocationType: 'Event',
            Payload: JSON.stringify({ phase: 'exit' })
        }));
        return response(202, { triggered: true, message: 'Exit requested — the inverter should return to its normal schedule shortly.' });
    } catch (err) {
        logError('Failed to trigger grid discharge exit', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

// Dashboard-editable enabled/dryRun for GridDischargeFunction — same
// sentinel-key settings row it reads (GridDischargeFunction.loadSettingsOverride),
// which SettingsOptimizerFunction can also write to (fallbackReservePercent/
// safetyMarginPercent, autoApply only). This dashboard form only ever edits
// enabled/dryRun, so unlike battery-settings the PUT handler merges over the
// existing row instead of replacing it outright.
async function handleGetGridDischargeSettings() {
    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const result = await docClient.send(new GetCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            Key: { DeviceSn: `${GRID_DISCHARGE_SETTINGS_PREFIX}${deviceSn}`, Timestamp: SETTINGS_TIMESTAMP }
        }));
        return response(200, formatGridDischargeSettingsResponse(result.Item));
    } catch (err) {
        logError('Grid discharge settings query failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

async function handlePutGridDischargeSettings(event) {
    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return response(400, { message: 'Request body must be valid JSON' });
    }

    const validationError = validateGridDischargeSettings(body);
    if (validationError) {
        return response(400, { message: validationError });
    }

    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const key = { DeviceSn: `${GRID_DISCHARGE_SETTINGS_PREFIX}${deviceSn}`, Timestamp: SETTINGS_TIMESTAMP };

        const existing = await docClient.send(new GetCommand({ TableName: process.env.ENERGY_READINGS_TABLE, Key: key }));
        const item = {
            ...existing.Item,
            ...key,
            enabled: body.enabled,
            dryRun: body.dryRun,
            sources: { ...existing.Item?.sources, enabled: 'dashboard', dryRun: 'dashboard' }
        };

        await docClient.send(new PutCommand({ TableName: process.env.ENERGY_READINGS_TABLE, Item: item }));
        logInfo('Grid discharge settings updated', item);
        return response(200, formatGridDischargeSettingsResponse(item));
    } catch (err) {
        logError('Grid discharge settings update failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
}

function validateGridDischargeSettings(body) {
    if (typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
    if (typeof body.dryRun !== 'boolean') return 'dryRun must be a boolean';
    return null;
}

function formatGridDischargeSettingsResponse(item) {
    return {
        enabled: item?.enabled ?? (process.env.GRID_DISCHARGE_DEFAULT_ENABLED !== 'false'),
        dryRun: item?.dryRun ?? (process.env.GRID_DISCHARGE_DEFAULT_DRY_RUN !== 'false'),
        usingDefaults: !item,
        sources: {
            enabled: fieldSource(item, 'enabled'),
            dryRun: fieldSource(item, 'dryRun')
        }
    };
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
            dryRun: body.dryRun,
            chargeUpperSocSunny: body.chargeUpperSocSunny,
            chargeUpperSocPartlyCloudy: body.chargeUpperSocPartlyCloudy,
            chargeUpperSocOvercast: body.chargeUpperSocOvercast,
            disabledChargeUpperSoc: body.disabledChargeUpperSoc,
            // The dashboard form always submits every field together (a full
            // replace, not a merge — see the module-level comment on
            // GRID_DISCHARGE_SETTINGS_PREFIX for how that differs from the grid
            // discharge form), so every field's source becomes 'dashboard' on
            // every save, even for a value that happened not to change.
            sources: {
                enabled: 'dashboard', dryRun: 'dashboard', chargeUpperSocSunny: 'dashboard',
                chargeUpperSocPartlyCloudy: 'dashboard', chargeUpperSocOvercast: 'dashboard',
                disabledChargeUpperSoc: 'dashboard'
            }
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
    if (typeof body.dryRun !== 'boolean') return 'dryRun must be a boolean';
    if (!isValidPercent(body.chargeUpperSocSunny)) return 'chargeUpperSocSunny must be a number between 0 and 100';
    if (!isValidPercent(body.chargeUpperSocPartlyCloudy)) return 'chargeUpperSocPartlyCloudy must be a number between 0 and 100';
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
        dryRun: item?.dryRun ?? (process.env.BATTERY_CONTROL_DEFAULT_DRY_RUN !== 'false'),
        chargeUpperSocSunny: item?.chargeUpperSocSunny ?? Number(process.env.BATTERY_CONTROL_DEFAULT_SUNNY),
        chargeUpperSocPartlyCloudy: item?.chargeUpperSocPartlyCloudy ?? Number(process.env.BATTERY_CONTROL_DEFAULT_PARTLY_CLOUDY),
        chargeUpperSocOvercast: item?.chargeUpperSocOvercast ?? Number(process.env.BATTERY_CONTROL_DEFAULT_OVERCAST),
        disabledChargeUpperSoc: item?.disabledChargeUpperSoc ?? Number(process.env.BATTERY_CONTROL_DEFAULT_DISABLED),
        usingDefaults: !item,
        sources: {
            enabled: fieldSource(item, 'enabled'),
            dryRun: fieldSource(item, 'dryRun'),
            chargeUpperSocSunny: fieldSource(item, 'chargeUpperSocSunny'),
            chargeUpperSocPartlyCloudy: fieldSource(item, 'chargeUpperSocPartlyCloudy'),
            chargeUpperSocOvercast: fieldSource(item, 'chargeUpperSocOvercast'),
            disabledChargeUpperSoc: fieldSource(item, 'disabledChargeUpperSoc')
        }
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

// last is the most recent reading in the queried range, which always ends at
// "now" regardless of whether range=day or range=week — so the instantaneous
// fields below (SOC, power, temperature, cycles, remaining capacity) are always
// the true latest poll, not something that changes with the day/week toggle.
// They only need `last` to have battery data at all — batteryChargeKwh/
// batteryDischargeKwh are the only fields that genuinely need both `first` and
// `last` (they're deltas across the range), so a `first` reading that predates
// battery polling (or predates some other gap) shouldn't block everything else
// from showing.
//
// batterySOH (state of health) used to be surfaced here instead of temperature,
// but the SolaX API has consistently returned null for it on this account's
// battery (verified against a live API call and 20+ consecutive polls) — swapped
// for batteryTemperature, which the API does report.
function batterySummary(first, last) {
    if (typeof last.batterySOC !== 'number') {
        return {};
    }

    const summary = {
        currentBatterySOC: last.batterySOC,
        currentBatteryStatus: classifyBatteryStatus(last.batteryDeviceStatus, last.chargeDischargePower),
        currentBatteryPowerW: typeof last.chargeDischargePower === 'number' ? last.chargeDischargePower : null,
        batteryTemperatureC: typeof last.batteryTemperature === 'number' ? last.batteryTemperature : null,
        batteryCycleTimes: typeof last.batteryCycleTimes === 'number' ? last.batteryCycleTimes : null,
        batteryRemainingsKwh: typeof last.batteryRemainings === 'number' ? last.batteryRemainings : null
    };

    if (typeof first.totalDeviceCharge === 'number' && typeof last.totalDeviceCharge === 'number') {
        summary.batteryChargeKwh = round2(last.totalDeviceCharge - first.totalDeviceCharge);
        summary.batteryDischargeKwh = round2(last.totalDeviceDischarge - first.totalDeviceDischarge);
    }

    return summary;
}

// deviceStatus is the battery's own state machine (docs/solax-apis.md Appendix
// 6 — residential batteries only ever report 0=Idle/1=Work); chargeDischargePower
// is +charge/-discharge in watts (§4.4 Battery fields). deviceStatus=0 is
// authoritative for "idle" — trusting the power sign alone would misreport as
// charging/discharging on sensor noise (a reading of a few watts) while the
// device itself is genuinely idle. deviceStatus=1 ("Work") doesn't distinguish
// charging from discharging by itself, so the power sign still decides which.
function classifyBatteryStatus(deviceStatus, chargeDischargePower) {
    if (deviceStatus === 0) return 'idle';
    if (typeof chargeDischargePower !== 'number' || chargeDischargePower === 0) return 'idle';
    return chargeDischargePower > 0 ? 'charging' : 'discharging';
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
module.exports.formatGridDischargeSettingsResponse = formatGridDischargeSettingsResponse;
module.exports.validateGridDischargeSettings = validateGridDischargeSettings;
module.exports.formatSettingsOptimizationResponse = formatSettingsOptimizationResponse;
