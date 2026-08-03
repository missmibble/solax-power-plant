'use strict';

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const {
    logInfo,
    logError,
    BUSINESS_TYPE,
    getAccessToken,
    setInverterSelfUseMode,
    localDateString,
    findImportRateWindow,
    fetchTomorrowForecast
} = require('powerplant-shared');

const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

// Shares the readings table with sentinel DeviceSn prefixes (same pattern as
// ReportFunction.REPORT_RECORD_PREFIX) — DashboardApiFunction's /battery-status
// and /battery-settings routes read/write these same prefixes.
const BATTERY_STATUS_RECORD_PREFIX = 'BATTERY_CONTROL#';
const BATTERY_SETTINGS_PREFIX = 'BATTERY_CONTROL_SETTINGS#';
const SETTINGS_TIMESTAMP = 0; // fixed sort key — one settings row per inverter, not time-series

const ACCURACY_SYSTEM_PROMPT = `You are reviewing a home battery charge-control decision made yesterday \
evening for a solar + battery system. You are given yesterday's decision (forecast classification, the \
reasoning, and the chargeUpperSoc percent that was set) and a summary of today's actual usage: PV yield, \
grid import/export broken down by tariff window (byWindow — so you can see *when* import/export happened, \
e.g. the overnight night-ev-charge window vs. daytime vs. the evening peak-evening window, not just a single \
whole-day total), and battery SOC range if available. Respond with ONLY a JSON object of the form \
{"accurate": boolean, "assessment": string, "usageShouldInfluence": boolean, "usageNote": string} — no text \
outside the JSON.

"accurate": whether the chargeUpperSoc looks right in hindsight given what actually happened.
"assessment": 1-2 plain-English sentences explaining the accuracy judgement — e.g. did the battery run flat \
before solar caught up (target was too low), or stay needlessly full all day (target was too high)? Ground \
any claim about *when* something happened in byWindow, not the daily total alone — e.g. import concentrated \
in night-ev-charge is expected overnight grid-charging, not daytime household load exceeding a full battery, \
and only cite the latter if byWindow actually shows import during offpeak-midday/peak-evening/shoulder-morning.
"usageShouldInfluence": whether today's usage pattern (not just weather) suggests the charge target should \
account for household load, independent of tomorrow's forecast.
"usageNote": 1 sentence on what about today's usage drove that judgement, citing the specific window (e.g. \
"import during shoulder-morning suggests the battery ran flat before solar ramped up") — empty string if \
usageShouldInfluence is false.`;

let cachedCredentials = null; // reused across warm invocations, same pattern as PollerFunction

async function loadSolaxCredentials() {
    if (cachedCredentials) return cachedCredentials;

    const [clientIdResult, clientSecretResult] = await Promise.all([
        ssmClient.send(new GetParameterCommand({
            Name: process.env.SOLAX_CLIENT_ID_PARAM,
            WithDecryption: true
        })),
        ssmClient.send(new GetParameterCommand({
            Name: process.env.SOLAX_CLIENT_SECRET_PARAM,
            WithDecryption: true
        }))
    ]);

    cachedCredentials = {
        clientId: clientIdResult.Parameter.Value,
        clientSecret: clientSecretResult.Parameter.Value
    };

    return cachedCredentials;
}

// Classifies tomorrow's forecast slots into a charge target. Three tiers:
// clearly good (sunny), clearly bad (overcast — rain condition, high rain
// chance, or heavy cloud), and everything in between (partly-cloudy). The
// ambiguous middle used to fall back to "overcast" outright — the safe
// failure mode being a fuller-than-necessary battery — but that meant every
// forecast that wasn't clearly sunny paid for a full grid charge even on
// nights that turned out fine (see docs/battery-charge-logic.md's
// "Previous-decision accuracy assessment" for a worked example of exactly
// this: a night classified this way needed far less grid import than a
// 100% target assumed, because next-day solar covered most of it anyway).
// partly-cloudy's target sits between the other two rather than defaulting
// to the conservative extreme. No forecast data at all still defaults to
// overcast — that's a true blind spot, not just an uncertain-but-present
// signal, so the safe-failure-mode reasoning still applies there.
// slots are the normalized shape from powerplant-shared's fetchTomorrowForecast
// (weather-client.js) — {timestampSeconds, precipitationProbability, cloudCoverPercent,
// isRainy} — never the raw provider response, so this logic doesn't change
// if the weather provider ever does.
function classifyForecast(slots) {
    if (!slots.length) {
        return { classification: 'overcast', reasoning: 'No forecast data for tomorrow — defaulting to safe/conservative.' };
    }

    const maxPop = Math.max(...slots.map(s => s.precipitationProbability || 0));
    const avgClouds = slots.reduce((sum, s) => sum + (s.cloudCoverPercent || 0), 0) / slots.length;
    const hasRainCondition = slots.some(s => s.isRainy);

    if (hasRainCondition || maxPop >= 0.4 || avgClouds >= 70) {
        return {
            classification: 'overcast',
            reasoning: `hasRainCondition=${hasRainCondition}, maxPop=${maxPop.toFixed(2)}, avgClouds=${Math.round(avgClouds)}%`
        };
    }

    if (avgClouds <= 30 && maxPop < 0.2) {
        return {
            classification: 'sunny',
            reasoning: `maxPop=${maxPop.toFixed(2)}, avgClouds=${Math.round(avgClouds)}%`
        };
    }

    return {
        classification: 'partly-cloudy',
        reasoning: `Ambiguous forecast (maxPop=${maxPop.toFixed(2)}, avgClouds=${Math.round(avgClouds)}%) — moderate charge target rather than defaulting to full.`
    };
}

// batch_set_spontaneity_self_use has no read-back counterpart and is a
// full-replace write, so config.batteryControl's non-varying fields (captured
// once from the real SolaX app settings) are this app's source of truth for
// the inverter's schedule — resent unchanged every call alongside whichever
// chargeUpperSoc tonight's forecast decided on.
function buildSelfUseModeRequest(batteryControlConfig, chargeUpperSoc) {
    const {
        minSoc, chargeFromGridEnable,
        chargeStartTimePeriod1, chargeEndTimePeriod1,
        chargeStartTimePeriod2, chargeEndTimePeriod2,
        dischargeStartTimePeriod1, dischargeEndTimePeriod1,
        dischargeStartTimePeriod2, dischargeEndTimePeriod2,
        enableTimePeriod2
    } = batteryControlConfig;

    return {
        minSoc,
        chargeFromGridEnable,
        chargeUpperSoc,
        chargeStartTimePeriod1,
        chargeEndTimePeriod1,
        chargeStartTimePeriod2,
        chargeEndTimePeriod2,
        dischargeStartTimePeriod1,
        dischargeEndTimePeriod1,
        dischargeStartTimePeriod2,
        dischargeEndTimePeriod2,
        enableTimePeriod2
    };
}

function formatMessage(classification, reasoning, requestBody, dryRun) {
    const classificationLabel = classification === 'disabled' ? 'Automation disabled' : `Tomorrow's forecast: ${classification}`;
    return [
        classificationLabel,
        reasoning,
        '',
        `${dryRun ? 'Would set' : 'Set'} tonight's battery charge target to ${requestBody.chargeUpperSoc}%.`
    ].join('\n');
}

async function publish(topicArn, subject, message) {
    await snsClient.send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
}

function buildBatteryStatusRecord(deviceSn, timestampSeconds, fields) {
    return {
        DeviceSn: `${BATTERY_STATUS_RECORD_PREFIX}${deviceSn}`,
        Timestamp: timestampSeconds,
        classification: fields.classification,
        reasoning: fields.reasoning,
        chargeUpperSoc: fields.chargeUpperSoc,
        dryRun: fields.dryRun,
        applied: fields.applied,
        enabled: fields.enabled,
        appliesToDate: fields.appliesToDate,
        previousAssessment: fields.previousAssessment || null
    };
}

// Best-effort, same as ReportFunction's report record write — the dashboard
// widget just shows the last successfully stored decision if this fails, so
// it never turns a successful dry-run/apply into a Lambda error.
async function storeBatteryStatusRecord(record) {
    try {
        await docClient.send(new PutCommand({ TableName: process.env.ENERGY_READINGS_TABLE, Item: record }));
    } catch (err) {
        logError('Failed to store battery status record for the dashboard', { error: err.message });
    }
}

// Dashboard-editable overrides for chargeUpperSocSunny/Overcast and the on/off
// switch — a single fixed-key row (SETTINGS_TIMESTAMP), not time-series, so a
// dashboard save always upserts the same item. Falls back to config.batteryControl's
// static values when nothing's been saved yet — never fails the run either way.
async function loadSettingsOverride(deviceSn) {
    try {
        const result = await docClient.send(new GetCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            Key: { DeviceSn: `${BATTERY_SETTINGS_PREFIX}${deviceSn}`, Timestamp: SETTINGS_TIMESTAMP }
        }));
        return result.Item || null;
    } catch (err) {
        logError('Failed to load battery control settings override', { error: err.message });
        return null;
    }
}

function resolveEffectiveSettings(batteryControlConfig, override) {
    return {
        enabled: override?.enabled ?? true,
        dryRun: override?.dryRun ?? (batteryControlConfig.dryRun !== false),
        chargeUpperSocSunny: override?.chargeUpperSocSunny ?? batteryControlConfig.chargeUpperSocSunny,
        chargeUpperSocPartlyCloudy: override?.chargeUpperSocPartlyCloudy ?? batteryControlConfig.chargeUpperSocPartlyCloudy,
        chargeUpperSocOvercast: override?.chargeUpperSocOvercast ?? batteryControlConfig.chargeUpperSocOvercast,
        disabledChargeUpperSoc: override?.disabledChargeUpperSoc ?? batteryControlConfig.disabledChargeUpperSoc
    };
}

// classification -> which effective.* charge target applies. 'overcast' is
// also the fallback for any unrecognized classification (there isn't one
// today, but a bad classification should still converge on the safe extreme,
// not silently produce chargeUpperSoc: undefined).
function chargeTargetForClassification(classification, effective) {
    if (classification === 'sunny') return effective.chargeUpperSocSunny;
    if (classification === 'partly-cloudy') return effective.chargeUpperSocPartlyCloudy;
    return effective.chargeUpperSocOvercast;
}

// Reads the last stored decision (before this run's) plus the readings since
// then, and asks Bedrock whether that decision looks right in hindsight, and
// whether usage (not just weather) should have factored in. Additive, same
// graceful-degradation pattern as ReportFunction.getAiInsights — no model
// configured, a Bedrock error, an unparsable response, or simply not enough
// history yet all just mean tonight's record has no previousAssessment field,
// never a failed run.
async function assessPreviousDecision(deviceSn, tariff, beforeTimestamp) {
    const modelId = process.env.BEDROCK_MODEL_ID;
    if (!modelId) return null;

    try {
        const previous = await queryPreviousStatusRecord(deviceSn, beforeTimestamp);
        if (!previous || !previous.classification) return null; // nothing to assess yet

        const readings = await queryReadingsSince(deviceSn, previous.Timestamp, beforeTimestamp);
        if (readings.length < 2) return null;

        const usageSummary = summarizeUsage(readings, tariff);

        const prompt = JSON.stringify({
            yesterdaysDecision: {
                classification: previous.classification,
                reasoning: previous.reasoning,
                chargeUpperSoc: previous.chargeUpperSoc,
                applied: previous.applied
            },
            todaysUsage: usageSummary,
            currency: tariff.currency
        });

        const response = await bedrockClient.send(new InvokeModelCommand({
            modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 400,
                system: ACCURACY_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: prompt }]
            })
        }));

        const payload = JSON.parse(new TextDecoder().decode(response.body));
        return parseAccuracyAssessment(payload.content?.[0]?.text || '');
    } catch (err) {
        logError('Previous-decision assessment failed', { error: err.message });
        return null;
    }
}

async function queryPreviousStatusRecord(deviceSn, beforeTimestamp) {
    const result = await docClient.send(new QueryCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        KeyConditionExpression: 'DeviceSn = :sn AND #ts < :before',
        ExpressionAttributeNames: { '#ts': 'Timestamp' },
        ExpressionAttributeValues: { ':sn': `${BATTERY_STATUS_RECORD_PREFIX}${deviceSn}`, ':before': beforeTimestamp },
        ScanIndexForward: false,
        Limit: 1
    }));
    return result.Items?.[0] || null;
}

async function queryReadingsSince(deviceSn, startSeconds, endSeconds) {
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

// tariff is optional (callers that only need the whole-window totals can omit
// it, same as before this was added) — byWindow is only populated when a
// tariff with importRates is passed in. Bucketing mirrors ReportFunction.assessUsage:
// each consecutive-reading delta is tagged with the tariff window the *later*
// reading falls in, same as the cost-assessment code path, so the two stay
// consistent with each other.
function summarizeUsage(readings, tariff) {
    const first = readings[0];
    const last = readings[readings.length - 1];

    const summary = {
        pvYieldKwh: round2(last.totalYield - first.totalYield),
        importKwh: round2(last.totalImportEnergy - first.totalImportEnergy),
        exportKwh: round2(last.totalExportEnergy - first.totalExportEnergy)
    };

    if (tariff?.importRates?.length) {
        const byWindow = {};
        for (const w of tariff.importRates) {
            byWindow[w.label] = { importKwh: 0, exportKwh: 0 };
        }

        for (let i = 1; i < readings.length; i++) {
            const deltaImport = readings[i].totalImportEnergy - readings[i - 1].totalImportEnergy;
            const deltaExport = readings[i].totalExportEnergy - readings[i - 1].totalExportEnergy;
            const window = findImportRateWindow(tariff, readings[i].Timestamp)?.label;
            if (!window || !byWindow[window]) continue;

            if (deltaImport > 0) byWindow[window].importKwh += deltaImport;
            if (deltaExport > 0) byWindow[window].exportKwh += deltaExport;
        }

        for (const label of Object.keys(byWindow)) {
            byWindow[label].importKwh = round2(byWindow[label].importKwh);
            byWindow[label].exportKwh = round2(byWindow[label].exportKwh);
        }

        summary.byWindow = byWindow;
    }

    const socs = readings.map(r => r.batterySOC).filter(v => typeof v === 'number');
    if (socs.length) {
        summary.minBatterySOC = Math.min(...socs);
        summary.maxBatterySOC = Math.max(...socs);
    }

    return summary;
}

function parseAccuracyAssessment(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (typeof parsed.accurate !== 'boolean' || typeof parsed.assessment !== 'string') return null;

    return {
        accurate: parsed.accurate,
        assessment: parsed.assessment,
        usageShouldInfluence: Boolean(parsed.usageShouldInfluence),
        usageNote: typeof parsed.usageNote === 'string' ? parsed.usageNote : ''
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

exports.handler = async () => {
    try {
        const batteryControlConfig = JSON.parse(process.env.BATTERY_CONTROL_CONFIG);
        const tariff = JSON.parse(process.env.TARIFF_STRUCTURE);
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const nowSeconds = Math.floor(Date.now() / 1000);
        // Runs at ~21:30 local (after GridDischargeFunction's 9pm exit phase —
        // see docs/grid-discharge-logic.md), before the 00:00-06:00 overnight
        // charge window — whatever chargeUpperSoc is decided tonight takes
        // effect starting that window, i.e. it applies to the calendar day
        // that starts right after.
        const appliesToDate = localDateString(nowSeconds + 24 * 60 * 60, tariff.timezone);

        const settingsOverride = await loadSettingsOverride(deviceSn);
        const effective = resolveEffectiveSettings(batteryControlConfig, settingsOverride);
        const dryRun = effective.dryRun;
        const previousAssessment = await assessPreviousDecision(deviceSn, tariff, nowSeconds);

        let classification;
        let reasoning;
        let chargeUpperSoc;

        if (!effective.enabled) {
            // The toggle turns off nightly *forecasting*, not the battery itself —
            // it still holds chargeUpperSoc at a known-safe default (100% unless
            // overridden) rather than leaving whatever the last automated run
            // happened to decide. No weather call either way.
            classification = 'disabled';
            reasoning = `Automation disabled via dashboard settings — holding chargeUpperSoc at the configured default (${effective.disabledChargeUpperSoc}%) instead of leaving the last automated decision in place.`;
            chargeUpperSoc = effective.disabledChargeUpperSoc;
        } else {
            const slots = await fetchTomorrowForecast(
                process.env.WEATHER_LAT, process.env.WEATHER_LON, tariff.timezone
            );
            ({ classification, reasoning } = classifyForecast(slots));
            chargeUpperSoc = chargeTargetForClassification(classification, effective);
        }

        const requestBody = buildSelfUseModeRequest(batteryControlConfig, chargeUpperSoc);

        if (dryRun) {
            logInfo('Battery control dry run', { classification, reasoning, requestBody, enabled: effective.enabled });
            await publish(
                process.env.REPORTS_TOPIC_ARN,
                'PowerPlant battery control — DRY RUN (no change applied)',
                formatMessage(classification, reasoning, requestBody, true)
            );
            await storeBatteryStatusRecord(buildBatteryStatusRecord(deviceSn, nowSeconds, {
                classification, reasoning, chargeUpperSoc, dryRun: true, applied: false, enabled: effective.enabled,
                appliesToDate, previousAssessment
            }));
            return { statusCode: 200 };
        }

        const { clientId, clientSecret } = await loadSolaxCredentials();
        const baseUrl = process.env.SOLAX_BASE_URL;
        const businessType = Number(process.env.SOLAX_BUSINESS_TYPE) || BUSINESS_TYPE.RESIDENTIAL;
        const accessToken = await getAccessToken({ baseUrl, clientId, clientSecret });

        await setInverterSelfUseMode(baseUrl, accessToken, {
            snList: process.env.SOLAX_INVERTER_SN,
            businessType,
            ...requestBody
        });

        logInfo('Battery control applied', { classification, reasoning, requestBody, enabled: effective.enabled });
        await publish(
            process.env.REPORTS_TOPIC_ARN,
            'PowerPlant battery control — applied',
            formatMessage(classification, reasoning, requestBody, false)
        );
        await storeBatteryStatusRecord(buildBatteryStatusRecord(deviceSn, nowSeconds, {
            classification, reasoning, chargeUpperSoc, dryRun: false, applied: true, enabled: effective.enabled,
            appliesToDate, previousAssessment
        }));
        return { statusCode: 200 };
    } catch (err) {
        logError('Battery control failed', { error: err.message });
        try {
            await publish(
                process.env.ALERTS_TOPIC_ARN,
                'PowerPlant battery control — FAILED',
                `Battery control run failed and made no change: ${err.message}`
            );
        } catch (publishErr) {
            logError('Failed to publish battery control failure alert', { error: publishErr.message });
        }
        throw err;
    }
};

module.exports.classifyForecast = classifyForecast;
module.exports.buildSelfUseModeRequest = buildSelfUseModeRequest;
module.exports.buildBatteryStatusRecord = buildBatteryStatusRecord;
module.exports.resolveEffectiveSettings = resolveEffectiveSettings;
module.exports.chargeTargetForClassification = chargeTargetForClassification;
module.exports.summarizeUsage = summarizeUsage;
module.exports.parseAccuracyAssessment = parseAccuracyAssessment;
module.exports.BATTERY_STATUS_RECORD_PREFIX = BATTERY_STATUS_RECORD_PREFIX;
module.exports.BATTERY_SETTINGS_PREFIX = BATTERY_SETTINGS_PREFIX;
module.exports.SETTINGS_TIMESTAMP = SETTINGS_TIMESTAMP;
