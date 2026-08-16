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
    setInverterSocTargetMode,
    exitVppMode,
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
evening for a solar + battery system. The household also owns an electric vehicle that is often plugged in \
to charge overnight, in the same 00:00-06:00 night-ev-charge window the battery itself grid-charges in — EV \
charging draws from the grid independently of the battery's chargeUpperSoc decision, and can continue (or \
spike) even after the battery has already stopped grid-charging for the night, so night-ev-charge import \
volume reflects both the battery and the EV together, not the battery's charge target alone.

You are given yesterday's decision (forecast classification, the \
reasoning, and the chargeUpperSoc percent that was set), a summary of today's actual usage: PV yield, \
grid import/export broken down by tariff window (byWindow — so you can see *when* import/export happened, \
e.g. the overnight night-ev-charge window vs. daytime vs. the evening peak-evening window, not just a single \
whole-day total), and battery SOC range if available — plus the site's actual rates (feedInRate, and each \
tariff window's import rate) so you can weigh this in dollars, not just kWh. Respond with ONLY a JSON object \
of the form {"accurate": boolean, "assessment": string, "usageShouldInfluence": boolean, "usageNote": string} \
— no text outside the JSON.

"accurate": whether the chargeUpperSoc looks right in hindsight given what actually happened.
"assessment": 1-2 plain-English sentences explaining the accuracy judgement — e.g. did the battery run flat \
before solar caught up (target was too low), or stay needlessly full all day (target was too high)? Ground \
any claim about *when* something happened in byWindow, not the daily total alone — e.g. import concentrated \
in night-ev-charge is expected overnight grid-charging, not daytime household load exceeding a full battery, \
and only cite the latter if byWindow actually shows import during offpeak-midday/peak-evening/shoulder-morning. \
Don't attribute all night-ev-charge import to the battery's target alone — some of it is likely the EV, \
independent of whether chargeUpperSoc was right that night. A battery that stayed full all day is only \
actually a *bad* outcome in dollar terms if that grid charge wasn't repaid — weigh what the overnight charge \
cost (chargeUpperSoc% worth of capacity at the night-ev-charge rate) against what it saved (peak-evening \
import avoided by discharging then) and what it foregone in feed-in credit (feedInRate is typically far \
below the peak rate, so a full battery avoiding peak import is usually still the right call even though it \
exported less that day) — don't call a high target inaccurate just because it left the battery full and \
export lower, only when the dollar comparison actually favors a lower target.
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

    const maxRainChance = Math.max(...slots.map(s => s.precipitationProbability || 0));
    const avgClouds = slots.reduce((sum, s) => sum + (s.cloudCoverPercent || 0), 0) / slots.length;
    const hasRainCondition = slots.some(s => s.isRainy);

    if (hasRainCondition || maxRainChance >= 0.4 || avgClouds >= 70) {
        return {
            classification: 'overcast',
            reasoning: `hasRainCondition=${hasRainCondition}, maxRainChance=${maxRainChance.toFixed(2)}, avgClouds=${Math.round(avgClouds)}%`
        };
    }

    if (avgClouds <= 30 && maxRainChance < 0.2) {
        return {
            classification: 'sunny',
            reasoning: `maxRainChance=${maxRainChance.toFixed(2)}, avgClouds=${Math.round(avgClouds)}%`
        };
    }

    return {
        classification: 'partly-cloudy',
        reasoning: `Ambiguous forecast (maxRainChance=${maxRainChance.toFixed(2)}, avgClouds=${Math.round(avgClouds)}%) — moderate charge target rather than defaulting to full.`
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
        previousAssessment: fields.previousAssessment || null,
        // Surplus-discharge fields (see buildSurplusDischargePlan) — dischargeApplied
        // is what handleExitDischarge checks to know whether it has anything to
        // do at ~23:55; dischargeExitApplied is merged onto this same record by
        // that phase once it exits VPP mode and sets the deferred self-use mode.
        dischargeApplied: fields.dischargeApplied ?? false,
        dischargeSurplusPercent: fields.dischargeSurplusPercent ?? null,
        dischargeExitApplied: fields.dischargeExitApplied ?? null
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
            rates: {
                feedInRate: tariff.feedInRate,
                importRates: (tariff.importRates || []).map(w => ({ label: w.label, rate: w.rate }))
            },
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

async function queryLatestReading(deviceSn) {
    const result = await docClient.send(new QueryCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        KeyConditionExpression: 'DeviceSn = :sn',
        ExpressionAttributeValues: { ':sn': deviceSn },
        ScanIndexForward: false,
        Limit: 1
    }));
    return result.Items?.[0] || null;
}

// If current SOC already exceeds tonight's just-decided charge target,
// chargeUpperSoc (a ceiling, not a floor) means the overnight charge window
// won't touch that surplus either way — it'll just sit unused unless normal
// household load happens to consume it. Exporting it before midnight
// captures some value from otherwise-idle capacity instead. No premium feed-in
// window needed for this to be worth doing, unlike the arbitrage this app's
// now-removed GridDischargeFunction depended on — see docs/battery-charge-logic.md.
// minSurplusPercent avoids cycling the battery to export a negligible amount.
function buildSurplusDischargePlan({ currentSoc, targetSoc, minSurplusPercent, maxDischargePowerW }) {
    const surplusPercent = round2(Math.max(0, currentSoc - targetSoc));

    if (surplusPercent < minSurplusPercent) {
        return { shouldDischarge: false, currentSoc, targetSoc, surplusPercent };
    }

    return { shouldDischarge: true, currentSoc, targetSoc, surplusPercent, dischargePowerW: maxDischargePowerW };
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

// The nightly decision — forecast classification, tonight's chargeUpperSoc,
// and (new) the surplus-discharge check. When a discharge is triggered, Self
// Use mode is deliberately NOT set this run — see the comment above the
// discharge branch below — handleExitDischarge sets it later instead.
async function handleDecide(deviceSn, nowSeconds) {
    const batteryControlConfig = JSON.parse(process.env.BATTERY_CONTROL_CONFIG);
    const tariff = JSON.parse(process.env.TARIFF_STRUCTURE);
    // Runs at ~21:00 local, before the 00:00-06:00 overnight charge window —
    // whatever chargeUpperSoc is decided tonight takes effect starting that
    // window, i.e. it applies to the calendar day that starts right after.
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

    // Same "enabled" toggle gates this — when nightly control is off, this
    // stays fully hands-off the inverter, not just skipping the forecast call.
    let dischargePlan = null;
    if (effective.enabled) {
        const latestReading = await queryLatestReading(deviceSn);
        if (latestReading && typeof latestReading.batterySOC === 'number') {
            dischargePlan = buildSurplusDischargePlan({
                currentSoc: latestReading.batterySOC,
                targetSoc: chargeUpperSoc,
                minSurplusPercent: batteryControlConfig.minSurplusPercent ?? 5,
                maxDischargePowerW: batteryControlConfig.maxDischargePowerW ?? 3000
            });
        }
    }

    if (dischargePlan?.shouldDischarge) {
        // VPP SOC Target Control holds the inverter in override indefinitely
        // once set (see solax-client.js) — calling setInverterSelfUseMode in
        // this same run would immediately cancel the discharge we're about to
        // start. handleExitDischarge (~23:55) exits VPP mode and sets tonight's
        // chargeUpperSoc via Self Use mode instead, once the discharge is done.
        if (!dryRun) {
            const { clientId, clientSecret } = await loadSolaxCredentials();
            const baseUrl = process.env.SOLAX_BASE_URL;
            const businessType = Number(process.env.SOLAX_BUSINESS_TYPE) || BUSINESS_TYPE.RESIDENTIAL;
            const accessToken = await getAccessToken({ baseUrl, clientId, clientSecret });

            await setInverterSocTargetMode(baseUrl, accessToken, {
                snList: deviceSn,
                businessType,
                targetSoc: dischargePlan.targetSoc,
                chargeDischargPower: -dischargePlan.dischargePowerW // negative = discharge
            });
        }

        logInfo(`Battery control ${dryRun ? 'dry run' : 'applied'} (surplus discharge)`, {
            classification, reasoning, dischargePlan, enabled: effective.enabled
        });
        await storeBatteryStatusRecord(buildBatteryStatusRecord(deviceSn, nowSeconds, {
            classification, reasoning, chargeUpperSoc, dryRun, applied: !dryRun, enabled: effective.enabled,
            appliesToDate, previousAssessment,
            dischargeApplied: true, dischargeSurplusPercent: dischargePlan.surplusPercent
        }));
        return { statusCode: 200 };
    }

    // No surplus to shed (or the discharge check found no usable SOC reading)
    // — set the overnight self-use mode now, exactly as before this rule existed.
    if (dryRun) {
        logInfo('Battery control dry run', { classification, reasoning, requestBody, enabled: effective.enabled });
        await storeBatteryStatusRecord(buildBatteryStatusRecord(deviceSn, nowSeconds, {
            classification, reasoning, chargeUpperSoc, dryRun: true, applied: false, enabled: effective.enabled,
            appliesToDate, previousAssessment, dischargeApplied: false
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
    await storeBatteryStatusRecord(buildBatteryStatusRecord(deviceSn, nowSeconds, {
        classification, reasoning, chargeUpperSoc, dryRun: false, applied: true, enabled: effective.enabled,
        appliesToDate, previousAssessment, dischargeApplied: false
    }));
    return { statusCode: 200 };
}

// Runs ~23:55, before the 00:00 overnight charge window opens. A no-op unless
// tonight's decide phase actually engaged VPP SOC Target Control
// (dischargeApplied: true on tonight's stored record, checked with a
// freshness bound so a failed/missing tonight run never acts on a stale
// prior night's record) — in that case this exits VPP mode and only then
// sets the overnight self-use mode with tonight's chargeUpperSoc, which
// decide deferred. See handleDecide's discharge branch.
async function handleExitDischarge(deviceSn, nowSeconds) {
    const MAX_RECORD_AGE_SECONDS = 4 * 60 * 60; // decide (~21:00) to exit (~23:55) is ~2h55m — generous margin, still excludes a prior night's record

    const record = await queryPreviousStatusRecord(deviceSn, nowSeconds);
    if (!record || !record.dischargeApplied || (nowSeconds - record.Timestamp) > MAX_RECORD_AGE_SECONDS) {
        logInfo('Battery control exitDischarge: no discharge to exit tonight — nothing to do');
        return { statusCode: 200 };
    }

    const batteryControlConfig = JSON.parse(process.env.BATTERY_CONTROL_CONFIG);
    const requestBody = buildSelfUseModeRequest(batteryControlConfig, record.chargeUpperSoc);

    if (!record.dryRun) {
        const { clientId, clientSecret } = await loadSolaxCredentials();
        const baseUrl = process.env.SOLAX_BASE_URL;
        const businessType = Number(process.env.SOLAX_BUSINESS_TYPE) || BUSINESS_TYPE.RESIDENTIAL;
        const accessToken = await getAccessToken({ baseUrl, clientId, clientSecret });

        await exitVppMode(baseUrl, accessToken, { snList: deviceSn, businessType });
        await setInverterSelfUseMode(baseUrl, accessToken, { snList: deviceSn, businessType, ...requestBody });
    }

    logInfo(`Battery control exitDischarge ${record.dryRun ? 'dry run' : 'applied'}`, { requestBody });

    await docClient.send(new PutCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        Item: { ...record, dischargeExitApplied: !record.dryRun }
    }));

    return { statusCode: 200 };
}

exports.handler = async (event) => {
    const phase = event?.phase === 'exitDischarge' ? 'exitDischarge' : 'decide';

    try {
        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const nowSeconds = Math.floor(Date.now() / 1000);

        return phase === 'exitDischarge'
            ? await handleExitDischarge(deviceSn, nowSeconds)
            : await handleDecide(deviceSn, nowSeconds);
    } catch (err) {
        logError('Battery control failed', { phase, error: err.message });
        try {
            await publish(
                process.env.ALERTS_TOPIC_ARN,
                'PowerPlant battery control — FAILED',
                `Battery control ${phase} phase failed and made no change: ${err.message}`
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
module.exports.buildSurplusDischargePlan = buildSurplusDischargePlan;
module.exports.BATTERY_STATUS_RECORD_PREFIX = BATTERY_STATUS_RECORD_PREFIX;
module.exports.BATTERY_SETTINGS_PREFIX = BATTERY_SETTINGS_PREFIX;
module.exports.SETTINGS_TIMESTAMP = SETTINGS_TIMESTAMP;
