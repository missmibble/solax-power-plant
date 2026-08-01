'use strict';

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const {
    logInfo,
    logError,
    BUSINESS_TYPE,
    getAccessToken,
    setInverterSocTargetMode,
    exitVppMode,
    startOfLocalDay
} = require('powerplant-shared');

const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

// Shares the readings table with sentinel DeviceSn prefixes (same pattern as
// ReportFunction/BatteryControlFunction) — not yet read by DashboardApiFunction;
// visibility into this feature's dry-run output is via CloudWatch Logs and the
// reports-topic email for now (see docs/grid-discharge-logic.md).
const STATUS_RECORD_PREFIX = 'GRID_DISCHARGE#';
// Dashboard-editable overrides for fallbackReservePercent/safetyMarginPercent —
// same fixed-key-row pattern as BatteryControlFunction.BATTERY_SETTINGS_PREFIX
// (DeviceSn = GRID_DISCHARGE_SETTINGS#<inverterSn>, Timestamp = 0, upserted not
// time-series). No dashboard form writes this yet — SettingsOptimizerFunction
// is the first writer (see docs/settings-optimizer-logic.md), when configured
// with autoApply: true.
const SETTINGS_PREFIX = 'GRID_DISCHARGE_SETTINGS#';
const SETTINGS_TIMESTAMP = 0;

let cachedCredentials = null; // reused across warm invocations, same pattern as BatteryControlFunction

async function loadSolaxCredentials() {
    if (cachedCredentials) return cachedCredentials;

    const [clientIdResult, clientSecretResult] = await Promise.all([
        ssmClient.send(new GetParameterCommand({ Name: process.env.SOLAX_CLIENT_ID_PARAM, WithDecryption: true })),
        ssmClient.send(new GetParameterCommand({ Name: process.env.SOLAX_CLIENT_SECRET_PARAM, WithDecryption: true }))
    ]);

    cachedCredentials = {
        clientId: clientIdResult.Parameter.Value,
        clientSecret: clientSecretResult.Parameter.Value
    };

    return cachedCredentials;
}

function parseTimeToHours(hhmm) {
    const [hours, minutes] = hhmm.split(':').map(Number);
    return hours + minutes / 60;
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

// Looks back over the last `lookbackDays` local calendar days at the
// shoulder-night window (windowEndTime local -> midnight, e.g. 21:00-24:00) —
// the load the battery has to cover *after* the grid-discharge window closes
// but *before* the cheap overnight recharge starts. Discharging past that
// need during the discharge window would just force an expensive shoulder-
// rate import a few hours later, which loses more than the feed-in premium
// earns. Returns the SOC-percentage-points consumed each night that had
// usable data (worst case, not averaged, is used by the caller — a household
// load spike on any one night is the case this reserve exists to protect).
async function historicalShoulderNightReserves(deviceSn, timezone, windowEndTime, lookbackDays, nowSeconds) {
    const windowEndHours = parseTimeToHours(windowEndTime);
    const reserves = [];

    for (let daysAgo = 1; daysAgo <= lookbackDays; daysAgo++) {
        const localDayStart = startOfLocalDay(nowSeconds - daysAgo * 24 * 60 * 60, timezone);
        const windowStart = localDayStart + Math.round(windowEndHours * 3600);
        const windowEnd = localDayStart + 24 * 3600;

        const readings = await queryReadings(deviceSn, windowStart, windowEnd);
        if (readings.length < 2) continue;

        const first = readings[0];
        const last = readings[readings.length - 1];
        if (typeof first.batterySOC !== 'number' || typeof last.batterySOC !== 'number') continue;

        reserves.push(Math.max(0, first.batterySOC - last.batterySOC));
    }

    return reserves;
}

// batteryRemainings/batterySOC on the same reading gives usable capacity
// empirically (~18.4 kWh observed on this system) without needing a config
// constant that could drift from reality — falls back to the config value
// only when a reading is missing batteryRemainings.
function estimateUsableCapacityKwh(latestReading, fallbackKwh) {
    if (typeof latestReading.batteryRemainings === 'number' && typeof latestReading.batterySOC === 'number'
        && latestReading.batterySOC > 0) {
        return latestReading.batteryRemainings / (latestReading.batterySOC / 100);
    }
    return fallbackKwh;
}

// The core calculation: how far below the current SOC can the battery safely
// discharge during the premium feed-in window without risking a forced
// shoulder-night import. Everything from here down only ever recommends
// holding MORE charge when uncertain (fewer history days than required) —
// the safe failure mode is under-exporting, not over-discharging.
function computeDischargePlan({ currentSocPercent, minSocPercent, safetyMarginPercent,
    shoulderNightReserves, minHistoryDaysRequired, fallbackReservePercent,
    usableCapacityKwh, windowDurationHours, maxDischargePowerW, minSurplusPercent }) {
    const usingFallback = shoulderNightReserves.length < minHistoryDaysRequired;
    const shoulderNightReservePercent = usingFallback
        ? fallbackReservePercent
        : Math.max(...shoulderNightReserves);

    const targetFloorSocPercent = Math.min(
        100,
        minSocPercent + shoulderNightReservePercent + safetyMarginPercent
    );

    const surplusPercent = Math.max(0, currentSocPercent - targetFloorSocPercent);
    const surplusKwh = round2(surplusPercent / 100 * usableCapacityKwh);

    if (surplusPercent < minSurplusPercent) {
        return {
            shouldDischarge: false, usingFallback, shoulderNightReservePercent, targetFloorSocPercent,
            surplusPercent: round2(surplusPercent), surplusKwh, dischargePowerW: 0
        };
    }

    const dischargePowerW = Math.min(
        maxDischargePowerW,
        Math.round(surplusKwh * 1000 / windowDurationHours)
    );

    return {
        shouldDischarge: true, usingFallback, shoulderNightReservePercent, targetFloorSocPercent,
        surplusPercent: round2(surplusPercent), surplusKwh, dischargePowerW
    };
}

function formatStartMessage(plan, config, dryRun) {
    const lines = [
        `Current SOC target floor: ${plan.targetFloorSocPercent}% ` +
        `(minSoc ${config.minSoc}% + shoulder-night reserve ${plan.shoulderNightReservePercent}%` +
        `${plan.usingFallback ? ' [fallback — insufficient history]' : ''} + safety margin ${config.safetyMarginPercent}%)`,
        `Surplus available to export: ${plan.surplusPercent}% (~${plan.surplusKwh} kWh)`
    ];

    if (plan.shouldDischarge) {
        lines.push(
            `${dryRun ? 'Would set' : 'Set'} targetSoc=${plan.targetFloorSocPercent}%, ` +
            `discharge power ${plan.dischargePowerW}W`,
            `Estimated feed-in revenue: ~$${round2(plan.surplusKwh * config.peakFeedInRate)} ` +
            `at ${(config.peakFeedInRate * 100).toFixed(0)}c/kWh`
        );
    } else {
        lines.push('No meaningful surplus — battery already at or below the target floor, nothing to discharge.');
    }

    return lines.join('\n');
}

// Falls back to config.gridDischarge's static values when nothing's been
// saved yet — never fails the run either way, same pattern as
// BatteryControlFunction.loadSettingsOverride.
async function loadSettingsOverride(deviceSn) {
    try {
        const result = await docClient.send(new GetCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            Key: { DeviceSn: `${SETTINGS_PREFIX}${deviceSn}`, Timestamp: SETTINGS_TIMESTAMP }
        }));
        return result.Item || null;
    } catch (err) {
        logError('Failed to load grid discharge settings override', { error: err.message });
        return null;
    }
}

function resolveEffectiveSettings(config, override) {
    return {
        fallbackReservePercent: override?.fallbackReservePercent ?? config.fallbackReservePercent,
        safetyMarginPercent: override?.safetyMarginPercent ?? config.safetyMarginPercent
    };
}

async function queryLatestStatusRecord(deviceSn) {
    const result = await docClient.send(new QueryCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        KeyConditionExpression: 'DeviceSn = :sn',
        ExpressionAttributeValues: { ':sn': `${STATUS_RECORD_PREFIX}${deviceSn}` },
        ScanIndexForward: false,
        Limit: 1
    }));
    return result.Items?.[0] || null;
}

// The regulation mechanism for "what if demand runs higher than the 5pm plan
// assumed": rather than inferring trouble from how fast SOC is falling (which
// conflates "high demand" with "reached target early" — both fine outcomes if
// SOC Target Control genuinely respects the floor), this checks for the one
// unambiguous bad signal directly — any grid import since the window opened,
// which can only mean demand outpaced the commanded discharge rate (or the
// literal-fixed-rate risk in docs/grid-discharge-logic.md materialized).
// Reaching (or passing) the target already is treated the same way: nothing
// further to usefully export, so there's no reason to keep holding VPP
// override for the rest of the window. A small overshoot past the target is
// accepted as the cost of one simple mid-window check rather than continuous
// monitoring.
function shouldExitEarly({ importSinceStartKwh, currentSocPercent, targetSocPercent }) {
    if (importSinceStartKwh > 0) {
        return {
            exitEarly: true,
            reason: `Grid import detected (${round2(importSinceStartKwh)} kWh) since the discharge window opened — ` +
                'demand outpaced the planned discharge rate.'
        };
    }
    if (currentSocPercent <= targetSocPercent) {
        return {
            exitEarly: true,
            reason: `SOC has already reached the target (${currentSocPercent}% <= ${targetSocPercent}%) — no more surplus to export.`
        };
    }
    return { exitEarly: false, reason: null };
}

async function publish(topicArn, subject, message) {
    await snsClient.send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
}

function buildStatusRecord(deviceSn, timestampSeconds, fields) {
    return {
        DeviceSn: `${STATUS_RECORD_PREFIX}${deviceSn}`,
        Timestamp: timestampSeconds,
        phase: fields.phase,
        enabled: fields.enabled,
        dryRun: fields.dryRun,
        applied: fields.applied,
        targetSocPercent: fields.targetSocPercent ?? null,
        currentSocPercent: fields.currentSocPercent ?? null,
        surplusPercent: fields.surplusPercent ?? null,
        surplusKwh: fields.surplusKwh ?? null,
        dischargePowerW: fields.dischargePowerW ?? null,
        usingFallback: fields.usingFallback ?? null,
        shoulderNightReservePercent: fields.shoulderNightReservePercent ?? null,
        reasoning: fields.reasoning
    };
}

// Best-effort, same as BatteryControlFunction's status record — never turns a
// successfully-sent dry-run/apply into a Lambda error.
async function storeStatusRecord(record) {
    try {
        await docClient.send(new PutCommand({ TableName: process.env.ENERGY_READINGS_TABLE, Item: record }));
    } catch (err) {
        logError('Failed to store grid discharge status record', { error: err.message });
    }
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

async function handleStart(config, deviceSn, timezone, nowSeconds) {
    if (!config.enabled) {
        logInfo('Grid discharge disabled via config — skipping start phase');
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'start', enabled: false, dryRun: null, applied: false,
            reasoning: 'Grid discharge disabled via config.'
        }));
        return { statusCode: 200 };
    }

    const recentReadings = await queryReadings(deviceSn, nowSeconds - 15 * 60, nowSeconds);
    const latest = recentReadings[recentReadings.length - 1];

    if (!latest || typeof latest.batterySOC !== 'number') {
        logError('No recent battery SOC reading available — skipping grid discharge start phase');
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'start', enabled: true, dryRun: config.dryRun, applied: false,
            reasoning: 'No recent battery SOC reading available — skipped.'
        }));
        return { statusCode: 200 };
    }

    const settingsOverride = await loadSettingsOverride(deviceSn);
    const effective = resolveEffectiveSettings(config, settingsOverride);

    const shoulderNightReserves = await historicalShoulderNightReserves(
        deviceSn, timezone, config.windowEndTime, config.historyLookbackDays, nowSeconds
    );

    const usableCapacityKwh = estimateUsableCapacityKwh(latest, config.assumedUsableCapacityKwh);
    const windowDurationHours = parseTimeToHours(config.windowEndTime) - parseTimeToHours(config.windowStartTime);

    const plan = computeDischargePlan({
        currentSocPercent: latest.batterySOC,
        minSocPercent: config.minSoc,
        safetyMarginPercent: effective.safetyMarginPercent,
        shoulderNightReserves,
        minHistoryDaysRequired: config.minHistoryDaysRequired,
        fallbackReservePercent: effective.fallbackReservePercent,
        usableCapacityKwh,
        windowDurationHours,
        maxDischargePowerW: config.maxDischargePowerW,
        minSurplusPercent: config.minSurplusPercent
    });

    const message = formatStartMessage(plan, config, config.dryRun);
    logInfo('Grid discharge start decision', { ...plan, dryRun: config.dryRun });

    if (!plan.shouldDischarge) {
        await publish(process.env.REPORTS_TOPIC_ARN, 'PowerPlant grid discharge — no surplus to export', message);
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'start', enabled: true, dryRun: config.dryRun, applied: false,
            targetSocPercent: plan.targetFloorSocPercent, currentSocPercent: latest.batterySOC,
            surplusPercent: plan.surplusPercent, surplusKwh: plan.surplusKwh, dischargePowerW: 0,
            usingFallback: plan.usingFallback, shoulderNightReservePercent: plan.shoulderNightReservePercent, reasoning: message
        }));
        return { statusCode: 200 };
    }

    if (config.dryRun) {
        await publish(process.env.REPORTS_TOPIC_ARN, 'PowerPlant grid discharge — DRY RUN (no change applied)', message);
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'start', enabled: true, dryRun: true, applied: false,
            targetSocPercent: plan.targetFloorSocPercent, currentSocPercent: latest.batterySOC,
            surplusPercent: plan.surplusPercent, surplusKwh: plan.surplusKwh, dischargePowerW: plan.dischargePowerW,
            usingFallback: plan.usingFallback, shoulderNightReservePercent: plan.shoulderNightReservePercent, reasoning: message
        }));
        return { statusCode: 200 };
    }

    const { clientId, clientSecret } = await loadSolaxCredentials();
    const baseUrl = process.env.SOLAX_BASE_URL;
    const businessType = Number(process.env.SOLAX_BUSINESS_TYPE) || BUSINESS_TYPE.RESIDENTIAL;
    const accessToken = await getAccessToken({ baseUrl, clientId, clientSecret });

    await setInverterSocTargetMode(baseUrl, accessToken, {
        snList: deviceSn,
        businessType,
        targetSoc: plan.targetFloorSocPercent,
        chargeDischargPower: -plan.dischargePowerW // negative = discharge (see solax-client.js)
    });

    await publish(process.env.REPORTS_TOPIC_ARN, 'PowerPlant grid discharge — applied', message);
    await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
        phase: 'start', enabled: true, dryRun: false, applied: true,
        targetSocPercent: plan.targetFloorSocPercent, currentSocPercent: latest.batterySOC,
        surplusPercent: plan.surplusPercent, surplusKwh: plan.surplusKwh, dischargePowerW: plan.dischargePowerW,
        usingFallback: plan.usingFallback, shoulderNightReservePercent: plan.shoulderNightReservePercent, reasoning: message
    }));
    return { statusCode: 200 };
}

// Mid-window regulation — see shouldExitEarly. Runs once, roughly halfway
// through the discharge window (config.gridDischarge.checkTime, default
// 19:00). A no-op (nothing stored beyond a status record) unless today's
// start phase actually applied a live discharge.
async function handleCheck(config, deviceSn, timezone, nowSeconds) {
    if (!config.enabled) {
        logInfo('Grid discharge disabled via config — skipping check phase');
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'check', enabled: false, dryRun: null, applied: false,
            reasoning: 'Grid discharge disabled via config.'
        }));
        return { statusCode: 200 };
    }

    const startRecord = await queryLatestStatusRecord(deviceSn);
    if (!startRecord || startRecord.phase !== 'start' || !startRecord.applied) {
        const reasoning = !startRecord || startRecord.phase !== 'start'
            ? 'No discharge decision found for today — nothing to check.'
            : "Today's discharge was not applied (dry run or no surplus) — nothing to check.";
        logInfo('Grid discharge check: nothing to regulate', { reasoning });
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'check', enabled: true, dryRun: config.dryRun, applied: false, reasoning
        }));
        return { statusCode: 200 };
    }

    const windowStartSeconds = startOfLocalDay(nowSeconds, timezone)
        + Math.round(parseTimeToHours(config.windowStartTime) * 3600);
    const windowReadings = await queryReadings(deviceSn, windowStartSeconds, nowSeconds);

    if (windowReadings.length < 2) {
        logInfo('Grid discharge check: not enough readings since the window opened to judge');
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'check', enabled: true, dryRun: config.dryRun, applied: false,
            reasoning: 'Not enough readings since the window opened to judge — skipped.'
        }));
        return { statusCode: 200 };
    }

    const first = windowReadings[0];
    const last = windowReadings[windowReadings.length - 1];
    const importSinceStartKwh = (typeof first.totalImportEnergy === 'number' && typeof last.totalImportEnergy === 'number')
        ? last.totalImportEnergy - first.totalImportEnergy
        : 0;
    const currentSocPercent = last.batterySOC;

    const decision = shouldExitEarly({
        importSinceStartKwh, currentSocPercent, targetSocPercent: startRecord.targetSocPercent
    });

    logInfo('Grid discharge check decision', {
        ...decision, importSinceStartKwh, currentSocPercent, dryRun: config.dryRun
    });

    if (!decision.exitEarly) {
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'check', enabled: true, dryRun: config.dryRun, applied: false,
            currentSocPercent, targetSocPercent: startRecord.targetSocPercent,
            reasoning: 'On track — no correction needed.'
        }));
        return { statusCode: 200 };
    }

    if (config.dryRun) {
        await publish(
            process.env.REPORTS_TOPIC_ARN,
            'PowerPlant grid discharge — DRY RUN early exit check',
            `${decision.reason} Would exit VPP mode early.`
        );
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'check', enabled: true, dryRun: true, applied: false,
            currentSocPercent, targetSocPercent: startRecord.targetSocPercent, reasoning: decision.reason
        }));
        return { statusCode: 200 };
    }

    const { clientId, clientSecret } = await loadSolaxCredentials();
    const baseUrl = process.env.SOLAX_BASE_URL;
    const businessType = Number(process.env.SOLAX_BUSINESS_TYPE) || BUSINESS_TYPE.RESIDENTIAL;
    const accessToken = await getAccessToken({ baseUrl, clientId, clientSecret });

    await exitVppMode(baseUrl, accessToken, { snList: deviceSn, businessType });

    await publish(
        process.env.REPORTS_TOPIC_ARN,
        'PowerPlant grid discharge — early exit applied',
        `${decision.reason} Exited VPP mode early.`
    );
    await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
        phase: 'check', enabled: true, dryRun: false, applied: true,
        currentSocPercent, targetSocPercent: startRecord.targetSocPercent, reasoning: decision.reason
    }));
    return { statusCode: 200 };
}

async function handleExit(config, deviceSn, nowSeconds) {
    // Always attempted when enabled, dry-run or not, regardless of what the
    // start phase decided — SOC Target Control has no built-in duration, so if
    // a live discharge command was ever sent, only this call hands control
    // back to the inverter's normal Self Use schedule. Skipping it on the
    // (dry-run and/or no-surplus) common case is harmless; skipping it after a
    // real applied discharge would leave the inverter stuck in VPP override.
    if (!config.enabled) {
        logInfo('Grid discharge disabled via config — skipping exit phase');
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'exit', enabled: false, dryRun: null, applied: false,
            reasoning: 'Grid discharge disabled via config.'
        }));
        return { statusCode: 200 };
    }

    if (config.dryRun) {
        const message = 'Would call exit_vpp_mode to return the inverter to its normal Self Use schedule.';
        logInfo('Grid discharge exit dry run', { message });
        await publish(process.env.REPORTS_TOPIC_ARN, 'PowerPlant grid discharge — DRY RUN exit (no change applied)', message);
        await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
            phase: 'exit', enabled: true, dryRun: true, applied: false, reasoning: message
        }));
        return { statusCode: 200 };
    }

    const { clientId, clientSecret } = await loadSolaxCredentials();
    const baseUrl = process.env.SOLAX_BASE_URL;
    const businessType = Number(process.env.SOLAX_BUSINESS_TYPE) || BUSINESS_TYPE.RESIDENTIAL;
    const accessToken = await getAccessToken({ baseUrl, clientId, clientSecret });

    await exitVppMode(baseUrl, accessToken, { snList: deviceSn, businessType });

    const message = 'Exited VPP mode — inverter returned to its normal Self Use schedule.';
    logInfo('Grid discharge exit applied', { message });
    await publish(process.env.REPORTS_TOPIC_ARN, 'PowerPlant grid discharge — exit applied', message);
    await storeStatusRecord(buildStatusRecord(deviceSn, nowSeconds, {
        phase: 'exit', enabled: true, dryRun: false, applied: true, reasoning: message
    }));
    return { statusCode: 200 };
}

exports.handler = async (event) => {
    const phase = event?.phase === 'exit' ? 'exit' : event?.phase === 'check' ? 'check' : 'start';

    try {
        const config = JSON.parse(process.env.GRID_DISCHARGE_CONFIG);
        const tariff = JSON.parse(process.env.TARIFF_STRUCTURE);
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const nowSeconds = Math.floor(Date.now() / 1000);

        if (phase === 'exit') return await handleExit(config, deviceSn, nowSeconds);
        if (phase === 'check') return await handleCheck(config, deviceSn, tariff.timezone, nowSeconds);
        return await handleStart(config, deviceSn, tariff.timezone, nowSeconds);
    } catch (err) {
        logError('Grid discharge failed', { phase, error: err.message });
        try {
            await publish(
                process.env.ALERTS_TOPIC_ARN,
                'PowerPlant grid discharge — FAILED',
                `Grid discharge ${phase} phase failed and made no change: ${err.message}`
            );
        } catch (publishErr) {
            logError('Failed to publish grid discharge failure alert', { error: publishErr.message });
        }
        throw err;
    }
};

module.exports.parseTimeToHours = parseTimeToHours;
module.exports.historicalShoulderNightReserves = historicalShoulderNightReserves;
module.exports.estimateUsableCapacityKwh = estimateUsableCapacityKwh;
module.exports.computeDischargePlan = computeDischargePlan;
module.exports.shouldExitEarly = shouldExitEarly;
module.exports.resolveEffectiveSettings = resolveEffectiveSettings;
module.exports.buildStatusRecord = buildStatusRecord;
module.exports.STATUS_RECORD_PREFIX = STATUS_RECORD_PREFIX;
module.exports.SETTINGS_PREFIX = SETTINGS_PREFIX;
module.exports.SETTINGS_TIMESTAMP = SETTINGS_TIMESTAMP;
