'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const {
    logInfo,
    logError,
    findImportRateWindow,
    importCostForWindow,
    exportCredit,
    supplyChargeForPeriod,
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

// Read-only here — the sentinel prefixes BatteryControlFunction/
// SettingsOptimizerFunction already write their own per-run records under.
// This function is now the one place that emails a nightly summary, so it
// folds the latest of each into the same email rather than each of those
// functions sending its own (see CLAUDE.md's "Battery charge control"/
// "Settings optimizer" sections).
const BATTERY_STATUS_RECORD_PREFIX = 'BATTERY_CONTROL#';
const SETTINGS_OPTIMIZATION_RECORD_PREFIX = 'SETTINGS_OPTIMIZATION#';

// Dashboard-editable, single fixed-key row (same pattern as
// BATTERY_CONTROL_SETTINGS#) — a household-size change to fold into the AI
// history context (see householdContext below). No row saved yet is fully
// inert: dailySummaries/getAiInsights behave exactly as before this existed.
const HOUSEHOLD_SETTINGS_PREFIX = 'HOUSEHOLD_SETTINGS#';
const HOUSEHOLD_SETTINGS_TIMESTAMP = 0; // fixed sort key — one row per inverter, not time-series

// The nightly sequence this digest is folding together runs decide (~21:00)
// -> SettingsOptimizer (~22:00) -> exitDischarge (~23:55, conditional) ->
// this report (~02:00 next day) — roughly a 5h gap from the first decision
// to here. 10h comfortably covers that plus cron jitter, while still
// excluding a genuinely missing/failed prior night's record from being
// reported as if it were tonight's.
const DIGEST_RECORD_MAX_AGE_SECONDS = 10 * 60 * 60;

// Mirrors SettingsOptimizerFunction.SETTING_LABELS — duplicated rather than
// shared since each Lambda is an independent deployment package (see
// CLAUDE.md's per-Lambda structure) and this is the only other place that
// needs human-facing labels for these keys.
const SETTINGS_OPTIMIZER_LABELS = {
    chargeUpperSocSunny: 'Overnight charge target (sunny forecast)',
    chargeUpperSocPartlyCloudy: 'Overnight charge target (partly cloudy forecast)',
    chargeUpperSocOvercast: 'Overnight charge target (overcast forecast)'
};

const AI_SYSTEM_PROMPT = `You are an energy analyst for a home solar + battery system. The household also \
owns an electric vehicle that is often plugged in to charge overnight (00:00-06:00, the night-ev-charge \
tariff window) — its charging draws from the grid independently of the battery, varies night to night (not \
every night has a full charging session), and can produce import spikes in that window, or after the battery \
itself has stopped charging, that aren't related to the battery's own behaviour. You are given \
today's usage assessment (import broken down by tariff window, PV yield, export, and battery charge/ \
discharge/SOC if available) plus a day-by-day summary of the recent history for context. Respond with \
ONLY a JSON object of the form {"narrative": string, "anomalies": string[]} — no text outside the JSON.

"narrative": 2-4 plain-English sentences assessing today against the recent pattern, and whether the \
existing recommendation still makes sense in that context.
"anomalies": notable deviations from the recent pattern (empty array if none) — e.g. an unusual drop in \
PV yield, an import spike outside the normal pattern, or battery behaviour that differs from recent days. \
Do not restate ordinary day-to-day variation as an anomaly, including normal night-to-night differences in \
EV charging.

If a "household" field is present, the occupant count changed on "changedOn" from "priorSize" to \
"currentSize" people, and each entry in recentDays is tagged with the size in effect that day — use this to \
explicitly compare average usage before vs. after that date and state whether usage actually decreased and \
by roughly how much. Do not assume usage scales proportionally with headcount; report what the data shows, \
including if it shows little or no change.`;

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
        const household = await loadHouseholdSettings(deviceSn);
        const aiInsights = await getAiInsights(assessment, tariff, deviceSn, endSeconds, household);
        const recommendationText = recommendation(assessment, tariff);

        const [batteryControlRecord, settingsOptimizationRecord] = await Promise.all([
            queryLatestSentinelRecord(`${BATTERY_STATUS_RECORD_PREFIX}${deviceSn}`),
            queryLatestSentinelRecord(`${SETTINGS_OPTIMIZATION_RECORD_PREFIX}${deviceSn}`)
        ]);

        const report = formatReport(
            assessment, tariff, LOOKBACK_DAYS, aiInsights,
            freshOrNull(batteryControlRecord, endSeconds),
            freshOrNull(settingsOptimizationRecord, endSeconds)
        );

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

// Same sentinel-record lookup DashboardApiFunction already does for the
// dashboard — duplicated locally rather than shared for the same
// independent-deployment-package reason as SETTINGS_OPTIMIZER_LABELS above.
async function queryLatestSentinelRecord(sentinelDeviceSn) {
    const result = await docClient.send(new QueryCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        KeyConditionExpression: 'DeviceSn = :sn',
        ExpressionAttributeValues: { ':sn': sentinelDeviceSn },
        ScanIndexForward: false,
        Limit: 1
    }));
    return result.Items?.[0] || null;
}

// Same fixed-key-row lookup as BatteryControlFunction's loadSettingsOverride
// — never fails the report, a missing row just means dailySummaries/
// getAiInsights run exactly as they did before this setting existed.
async function loadHouseholdSettings(deviceSn) {
    try {
        const result = await docClient.send(new GetCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            Key: { DeviceSn: `${HOUSEHOLD_SETTINGS_PREFIX}${deviceSn}`, Timestamp: HOUSEHOLD_SETTINGS_TIMESTAMP }
        }));
        return result.Item || null;
    } catch (err) {
        logError('Failed to load household settings', { error: err.message });
        return null;
    }
}

// A missing or stale record degrades the digest section gracefully (see
// formatBatteryControlSummary/formatSettingsOptimizerSummary) rather than
// reporting a genuinely old decision as if it were tonight's.
function freshOrNull(record, nowSeconds) {
    if (!record || (nowSeconds - record.Timestamp) > DIGEST_RECORD_MAX_AGE_SECONDS) return null;
    return record;
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
    const supplyCharge = supplyChargeForPeriod(tariff, readings[0].Timestamp, readings[readings.length - 1].Timestamp);
    const peakImportKwh = byWindow[PEAK_WINDOW_LABEL]?.importKwh || 0;

    return {
        pvYieldKwh: round2(pvYieldKwh),
        exportKwh: round2(exportKwh),
        byWindow,
        totalImportCost: round2(totalImportCost),
        totalExportCredit: round2(totalExportCredit),
        supplyCharge: round2(supplyCharge),
        netCost: round2(totalImportCost + supplyCharge - totalExportCredit),
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

// Returns null when no household-size change has been saved (fully inert —
// dailySummaries/getAiInsights behave exactly as before this existed). Both
// counts are carried, not just the current one, so the AI can compare actual
// before/after usage instead of assuming it scales with headcount.
function householdContext(household, tariff) {
    if (!household || household.effectiveSince == null) return null;
    return {
        currentSize: household.householdSize,
        priorSize: household.priorHouseholdSize,
        changedOn: localDateString(household.effectiveSince, tariff.timezone)
    };
}

// Groups readings into calendar-day PV yield/import/export deltas (local time,
// per tariff.timezone) as compact context for the AI insights prompt — sending
// day totals instead of the raw 5-minute time series keeps the prompt small.
// household is optional — a soft blend, not a hard clip: days before and after
// a household-size change both stay in the window, each tagged with the size
// in effect that day, so the AI can compare the two rather than one being cut.
function dailySummaries(readings, tariff, household) {
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

    const context = householdContext(household, tariff);

    return [...byDate.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(d => {
            const day = {
                date: d.date,
                pvYieldKwh: round2(d.pvYieldKwh),
                importKwh: round2(d.importKwh),
                exportKwh: round2(d.exportKwh)
            };
            if (context) day.householdSize = d.date >= context.changedOn ? context.currentSize : context.priorSize;
            return day;
        });
}

// AI narrative + pattern-based anomaly flags, layered on top of (not replacing)
// the deterministic recommendation() heuristic above. Never fails the report:
// a missing model config, a Bedrock error, or an unparsable response all just
// mean the report goes out without this section.
async function getAiInsights(assessment, tariff, deviceSn, endSeconds, household) {
    const modelId = process.env.BEDROCK_MODEL_ID;
    if (!modelId) return null;

    try {
        const historyStart = endSeconds - AI_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60;
        const historyReadings = await queryReadings(deviceSn, historyStart, endSeconds);
        const recentDays = dailySummaries(historyReadings, tariff, household);
        const context = householdContext(household, tariff);

        const prompt = JSON.stringify({
            today: assessment,
            recentDays,
            feedInRate: tariff.feedInRate,
            currency: tariff.currency,
            ...(context ? { household: context } : {})
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

// batteryControlRecord/settingsOptimizationRecord are the pre-staleness-
// checked (see freshOrNull) latest BATTERY_CONTROL#/SETTINGS_OPTIMIZATION#
// records — this is now the one nightly email for all three functions
// (BatteryControlFunction/SettingsOptimizerFunction no longer send their
// own), so their sections fold in here rather than arriving as separate
// emails. Both are optional/nullable — a missing or stale record just means
// that section reports "no recent decision" instead of failing the report.
function formatBatteryControlSummary(record) {
    if (!record) return ['No recent battery-control decision recorded.'];

    const lines = [];
    if (record.classification === 'disabled') {
        lines.push(`Automation disabled — holding chargeUpperSoc at ${record.chargeUpperSoc}%.`);
    } else {
        lines.push(
            `Forecast: ${record.classification} → chargeUpperSoc ${record.chargeUpperSoc}% ` +
            `(${record.dryRun ? 'dry-run' : 'applied'})`
        );
    }

    if (record.dischargeApplied) {
        const status = record.dischargeExitApplied
            ? 'discharged and exited'
            : (record.dryRun ? 'would discharge' : 'discharge pending exit');
        lines.push(`Surplus discharge: ${record.dischargeSurplusPercent}% above target — ${status}.`);
    }

    if (record.previousAssessment?.accurate === false) {
        lines.push(`Last night's target looked off in hindsight: ${record.previousAssessment.assessment}`);
    }

    return lines;
}

function formatSettingsOptimizerSummary(record) {
    if (!record) return ['No recent settings-optimizer recommendation recorded.'];

    const changed = Object.entries(record.recommendations || {})
        .filter(([, r]) => r.recommended !== null && r.recommended !== r.current);

    if (changed.length === 0) {
        return ['No change recommended.'];
    }

    const lines = changed.map(([key, r]) =>
        `${SETTINGS_OPTIMIZER_LABELS[key] || key}: ${r.current}% -> ${r.recommended}%${r.clamped ? ' (capped)' : ''} — ` +
        `${record.applied ? 'applied' : 'recommended, not yet applied'}`
    );

    if (record.reasoning) {
        lines.push(`Reasoning (confidence: ${record.confidence}): ${record.reasoning}`);
    }

    return lines;
}

// Dot-point email body — deliberately terser than the data actually available
// (e.g. zero-import windows are skipped, the cost breakdown is one line not
// three). recommendation()/aiInsights text itself is embedded verbatim, never
// reworded here, since DashboardApiFunction serves those exact same strings
// to the website via buildReportRecord — only this wrapper's formatting
// differs between the two surfaces.
function formatReport(assessment, tariff, lookbackDays, aiInsights, batteryControlRecord, settingsOptimizationRecord) {
    const lines = [
        `PowerPlant usage report — last ${lookbackDays} day(s)`,
        '',
        `• PV yield: ${assessment.pvYieldKwh} kWh`,
        `• Grid export: ${assessment.exportKwh} kWh (credit: ${assessment.totalExportCredit} ${tariff.currency})`
    ];

    if (typeof assessment.batteryChargeKwh === 'number') {
        lines.push(
            `• Battery: charged ${assessment.batteryChargeKwh} kWh, discharged ${assessment.batteryDischargeKwh} kWh, ` +
            `currently at ${assessment.currentBatterySOC}% SOC`
        );
    }

    for (const [label, w] of Object.entries(assessment.byWindow)) {
        if (w.importKwh <= 0) continue;
        lines.push(`• Import — ${label}: ${round2(w.importKwh)} kWh @ ${w.rate}/kWh = ${round2(w.cost)} ${tariff.currency}`);
    }

    lines.push(
        `• Net cost: ${assessment.netCost} ${tariff.currency} ` +
        `(import ${assessment.totalImportCost} + supply ${assessment.supplyCharge} − export credit ${assessment.totalExportCredit})`
    );

    lines.push('', recommendation(assessment, tariff));

    lines.push('', 'Battery control (tonight):');
    for (const line of formatBatteryControlSummary(batteryControlRecord)) lines.push(`• ${line}`);

    lines.push('', 'Settings optimizer:');
    for (const line of formatSettingsOptimizerSummary(settingsOptimizationRecord)) lines.push(`• ${line}`);

    if (aiInsights) {
        lines.push('', 'AI insights:', `• ${aiInsights.narrative}`);
        lines.push(aiInsights.anomalies.length ? 'Anomalies flagged:' : 'Anomalies flagged: none');
        for (const anomaly of aiInsights.anomalies) {
            lines.push(`• ${anomaly}`);
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
module.exports.formatBatteryControlSummary = formatBatteryControlSummary;
module.exports.formatSettingsOptimizerSummary = formatSettingsOptimizerSummary;
module.exports.dailySummaries = dailySummaries;
module.exports.householdContext = householdContext;
module.exports.parseAiResponse = parseAiResponse;
module.exports.getAiInsights = getAiInsights;
module.exports.recommendation = recommendation;
module.exports.buildReportRecord = buildReportRecord;
module.exports.freshOrNull = freshOrNull;
module.exports.REPORT_RECORD_PREFIX = REPORT_RECORD_PREFIX;
module.exports.BATTERY_STATUS_RECORD_PREFIX = BATTERY_STATUS_RECORD_PREFIX;
module.exports.SETTINGS_OPTIMIZATION_RECORD_PREFIX = SETTINGS_OPTIMIZATION_RECORD_PREFIX;
module.exports.DIGEST_RECORD_MAX_AGE_SECONDS = DIGEST_RECORD_MAX_AGE_SECONDS;
module.exports.HOUSEHOLD_SETTINGS_PREFIX = HOUSEHOLD_SETTINGS_PREFIX;
