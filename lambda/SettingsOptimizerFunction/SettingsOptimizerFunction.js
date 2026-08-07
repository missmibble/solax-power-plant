'use strict';

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { logInfo, logError } = require('powerplant-shared');

const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

// Read-only: the sentinel prefix BatteryControlFunction already writes its
// per-run decision records under.
const BATTERY_STATUS_PREFIX = 'BATTERY_CONTROL#';
// Write target when autoApply is on — the same dashboard-editable-settings
// sentinel row BatteryControlFunction already reads.
const BATTERY_SETTINGS_PREFIX = 'BATTERY_CONTROL_SETTINGS#';
// This function's own dashboard-editable setting — just autoApply itself
// ("Full automation" on the dashboard's AI card). Same fixed-key-row pattern
// as BATTERY_SETTINGS_PREFIX above, read the same way via loadOverride.
const SETTINGS_OPTIMIZER_SETTINGS_PREFIX = 'SETTINGS_OPTIMIZER_SETTINGS#';
const SETTINGS_TIMESTAMP = 0;
// This function's own nightly recommendation record.
const STATUS_RECORD_PREFIX = 'SETTINGS_OPTIMIZATION#';

const SYSTEM_PROMPT = `You are reviewing a week of operational history for a home solar + battery system, \
to recommend whether three control-tuning defaults should be adjusted:

chargeUpperSocSunny / chargeUpperSocPartlyCloudy / chargeUpperSocOvercast — how full the battery charges \
overnight based on tomorrow's weather forecast (a lower sunny target relies on solar catching up during the \
day; partly-cloudy is the ambiguous-forecast middle ground between sunny and overcast).

You are given the current effective value of each setting, the number of sample nights behind each one, the \
minSampleSize threshold below which a change can never actually be applied regardless of what you recommend, \
and a summary of recent history: per-classification accuracy judgements already made by another automated \
nightly assessment (was the target right in hindsight, and did household usage suggest it should change).

Respond with ONLY a JSON object of this exact form — no text outside the JSON:
{"chargeUpperSocSunny": number|null, "chargeUpperSocPartlyCloudy": number|null, "chargeUpperSocOvercast": number|null, \
"reasoning": string, "confidence": "low"|"medium"|"high"}

Use null for any value you don't have enough evidence to recommend changing — the current value stays in \
effect. Never recommend a value that would leave less safety margin than the household's single worst night \
in the sample actually needed: the cost of erring toward holding more charge is a small amount of missed \
export revenue or a slightly fuller morning battery; the cost of erring toward too little is a forced grid \
import at the most expensive rate of the day.

Critical: for any setting whose sample size is below minSampleSize, you MUST return null for it — a lower \
sample size means the change can never actually be applied no matter what number you return, so a non-null \
value there is simply discarded. Your reasoning text must match what you actually return: do not describe or \
suggest a specific new percentage for a setting you returned null for, since that number will never take \
effect and only misleads whoever reads the reasoning. For those settings, explain that you're holding at the \
current value for lack of data instead.`;

async function queryRecentRecords(prefix, deviceSn, sinceSeconds) {
    const items = [];
    let exclusiveStartKey;

    do {
        const result = await docClient.send(new QueryCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            KeyConditionExpression: 'DeviceSn = :sn AND #ts >= :since',
            ExpressionAttributeNames: { '#ts': 'Timestamp' },
            ExpressionAttributeValues: { ':sn': `${prefix}${deviceSn}`, ':since': sinceSeconds },
            ExclusiveStartKey: exclusiveStartKey
        }));

        items.push(...(result.Items || []));
        exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return items;
}

async function loadOverride(prefix, deviceSn) {
    const result = await docClient.send(new GetCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        Key: { DeviceSn: `${prefix}${deviceSn}`, Timestamp: SETTINGS_TIMESTAMP }
    }));
    return result.Item || null;
}

// Groups BatteryControlFunction's own nightly records by forecast classification
// and tallies the previousAssessment judgements already made about each one —
// this function doesn't re-derive accuracy itself, it aggregates a week of
// judgements another Bedrock call already made, one per night.
function summarizeBatteryControlHistory(records) {
    const byClassification = {};

    for (const r of records) {
        if (!['sunny', 'partly-cloudy', 'overcast'].includes(r.classification)) continue;
        const bucket = byClassification[r.classification]
            || (byClassification[r.classification] = { nights: 0, accurate: 0, inaccurate: 0, usageNotes: [] });
        bucket.nights += 1;

        const pa = r.previousAssessment;
        if (pa) {
            if (pa.accurate) bucket.accurate += 1; else bucket.inaccurate += 1;
            if (pa.usageShouldInfluence && pa.usageNote) bucket.usageNotes.push(pa.usageNote);
        }
    }

    return byClassification;
}

function parseOptimizationRecommendation(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (typeof parsed.reasoning !== 'string' || !['low', 'medium', 'high'].includes(parsed.confidence)) return null;

    const numOrNull = v => typeof v === 'number' ? v : null;
    return {
        chargeUpperSocSunny: numOrNull(parsed.chargeUpperSocSunny),
        chargeUpperSocPartlyCloudy: numOrNull(parsed.chargeUpperSocPartlyCloudy),
        chargeUpperSocOvercast: numOrNull(parsed.chargeUpperSocOvercast),
        reasoning: parsed.reasoning,
        confidence: parsed.confidence
    };
}

async function getRecommendation(modelId, currentValues, batterySummary, minSampleSize) {
    const prompt = JSON.stringify({ currentValues, batteryControlHistory: batterySummary, minSampleSize });

    const response = await bedrockClient.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 500,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }]
        })
    }));

    const payload = JSON.parse(new TextDecoder().decode(response.body));
    return parseOptimizationRecommendation(payload.content?.[0]?.text || '');
}

// The core decision: for each of the 3 tunable values, only ever acts when
// there's both an AI recommendation AND enough sample nights to trust it —
// missing either means "recommended: null", i.e. hold the current value.
// Whatever does get recommended is clamped to at most maxAdjustmentPercent
// (percentage points, not a relative %) away from the current value and to
// [0, 100] — a single Bedrock response, however confident, can't swing a
// control-relevant setting further than that in one run.
function buildRecommendations({ currentValues, batterySummary, aiRecommendation, minSampleSize, maxAdjustmentPercent }) {
    function evaluate(key, currentValue, sampleSize) {
        const recommended = aiRecommendation ? aiRecommendation[key] : null;

        if (recommended === null || recommended === undefined || sampleSize < minSampleSize) {
            return {
                current: currentValue,
                recommended: null,
                sampleSize,
                reason: sampleSize < minSampleSize ? 'insufficient sample size' : 'no change recommended'
            };
        }

        const bounded = Math.min(
            100, Math.max(0, Math.min(currentValue + maxAdjustmentPercent, Math.max(currentValue - maxAdjustmentPercent, recommended)))
        );
        const roundedBounded = Math.round(bounded);

        return {
            current: currentValue,
            recommended: roundedBounded,
            clamped: roundedBounded !== Math.round(recommended),
            sampleSize
        };
    }

    return {
        chargeUpperSocSunny: evaluate('chargeUpperSocSunny', currentValues.chargeUpperSocSunny, batterySummary.sunny?.nights || 0),
        chargeUpperSocPartlyCloudy: evaluate(
            'chargeUpperSocPartlyCloudy', currentValues.chargeUpperSocPartlyCloudy, batterySummary['partly-cloudy']?.nights || 0
        ),
        chargeUpperSocOvercast: evaluate('chargeUpperSocOvercast', currentValues.chargeUpperSocOvercast, batterySummary.overcast?.nights || 0)
    };
}

// Plain-English labels for the emailed summary — the recommendations object
// itself stays keyed by these config field names (other code reads it by
// key), only the human-facing text needs translating.
const SETTING_LABELS = {
    chargeUpperSocSunny: 'Overnight charge target (sunny forecast)',
    chargeUpperSocPartlyCloudy: 'Overnight charge target (partly cloudy forecast)',
    chargeUpperSocOvercast: 'Overnight charge target (overcast forecast)'
};

function formatMessage(recommendations, aiRecommendation, autoApply) {
    const lines = [];
    const changed = Object.entries(recommendations).filter(([, r]) => r.recommended !== null && r.recommended !== r.current);

    if (changed.length === 0) {
        lines.push('No changes recommended this week — either not enough sample nights yet, or current values look right.');
    } else {
        for (const [key, r] of changed) {
            lines.push(
                `${SETTING_LABELS[key] || key}: ${r.current}% -> ${r.recommended}%${r.clamped ? ' (capped)' : ''} ` +
                `(${r.sampleSize} sample night${r.sampleSize === 1 ? '' : 's'})`
                + `${autoApply ? ' — applied' : ' — recommended, not yet applied'}`
            );
        }
    }

    if (aiRecommendation?.reasoning) {
        lines.push('', `Reasoning (confidence: ${aiRecommendation.confidence}): ${aiRecommendation.reasoning}`);
    }

    return lines.join('\n');
}

function buildOptimizationRecord(deviceSn, timestampSeconds, fields) {
    return {
        DeviceSn: `${STATUS_RECORD_PREFIX}${deviceSn}`,
        Timestamp: timestampSeconds,
        recommendations: fields.recommendations,
        confidence: fields.aiRecommendation?.confidence || null,
        reasoning: fields.reasoning,
        applied: fields.applied,
        autoApply: fields.autoApply
    };
}

async function storeStatusRecord(record) {
    try {
        await docClient.send(new PutCommand({ TableName: process.env.ENERGY_READINGS_TABLE, Item: record }));
    } catch (err) {
        logError('Failed to store settings optimization record', { error: err.message });
    }
}

async function publish(topicArn, subject, message) {
    await snsClient.send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
}

// 'sources' is a per-field companion map on each settings row (dashboard |
// settings-optimizer) so the dashboard can show whether a value is the
// config default, something a human typed in, or something this function
// auto-applied — without it, every write into these rows looks identical.
// Only the keys actually being written this run get re-tagged; every other
// field's existing source is preserved via the spread.
const SOURCE = 'settings-optimizer';

function mergedSources(existingSources, updatedKeys) {
    const sources = { ...existingSources };
    for (const key of updatedKeys) sources[key] = SOURCE;
    return sources;
}

// Merges (not replaces) the settings row so a human-set enabled/on-off toggle
// or a not-recommended-this-week field already saved there isn't clobbered.
async function applyRecommendations(deviceSn, recommendations, existingBatteryOverride) {
    const batteryUpdate = {};
    for (const [key, r] of Object.entries(recommendations)) {
        if (r.recommended !== null && r.recommended !== r.current) {
            batteryUpdate[key] = r.recommended;
        }
    }
    if (Object.keys(batteryUpdate).length === 0) return false;

    await docClient.send(new PutCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        Item: {
            DeviceSn: `${BATTERY_SETTINGS_PREFIX}${deviceSn}`, Timestamp: SETTINGS_TIMESTAMP,
            ...existingBatteryOverride, ...batteryUpdate,
            sources: mergedSources(existingBatteryOverride?.sources, Object.keys(batteryUpdate))
        }
    }));
    return true;
}

exports.handler = async () => {
    try {
        const modelId = process.env.BEDROCK_MODEL_ID;
        if (!modelId) {
            logInfo('Settings optimizer skipped — no Bedrock model configured');
            return { statusCode: 200 };
        }

        const config = JSON.parse(process.env.SETTINGS_OPTIMIZER_CONFIG);
        if (!config.enabled) {
            logInfo('Settings optimizer disabled via config — skipping');
            return { statusCode: 200 };
        }

        const deviceSn = process.env.SOLAX_INVERTER_SN;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const sinceSeconds = nowSeconds - config.lookbackDays * 24 * 60 * 60;

        const [batteryOverride, optimizerSettingsOverride, batteryRecords] = await Promise.all([
            loadOverride(BATTERY_SETTINGS_PREFIX, deviceSn),
            loadOverride(SETTINGS_OPTIMIZER_SETTINGS_PREFIX, deviceSn),
            queryRecentRecords(BATTERY_STATUS_PREFIX, deviceSn, sinceSeconds)
        ]);

        // The dashboard's "Full automation" toggle overrides config.autoApply the
        // same way every other dashboard-editable setting in this app does — an
        // unset override, or none saved at all, falls back to the static config value.
        const effectiveAutoApply = optimizerSettingsOverride?.autoApply ?? config.autoApply;

        const currentValues = {
            chargeUpperSocSunny: batteryOverride?.chargeUpperSocSunny ?? config.batteryControlDefaults.chargeUpperSocSunny,
            chargeUpperSocPartlyCloudy: batteryOverride?.chargeUpperSocPartlyCloudy ?? config.batteryControlDefaults.chargeUpperSocPartlyCloudy,
            chargeUpperSocOvercast: batteryOverride?.chargeUpperSocOvercast ?? config.batteryControlDefaults.chargeUpperSocOvercast
        };

        const batterySummary = summarizeBatteryControlHistory(batteryRecords);

        // A Bedrock call failure here is a real failure, not graceful
        // degradation — unlike ReportFunction/BatteryControlFunction's AI
        // narrative/accuracy checks (additive on top of a deterministic base),
        // this function's entire purpose is the AI assessment. An unparsable
        // (but successfully returned) response still degrades gracefully to
        // "no recommendation" via parseOptimizationRecommendation, same as
        // parseAiResponse/parseAccuracyAssessment elsewhere.
        const aiRecommendation = await getRecommendation(modelId, currentValues, batterySummary, config.minSampleSize);

        const recommendations = buildRecommendations({
            currentValues, batterySummary, aiRecommendation,
            minSampleSize: config.minSampleSize, maxAdjustmentPercent: config.maxAdjustmentPercent
        });

        let applied = false;
        if (effectiveAutoApply) {
            applied = await applyRecommendations(deviceSn, recommendations, batteryOverride);
        }

        const message = formatMessage(recommendations, aiRecommendation, effectiveAutoApply);
        logInfo('Settings optimization recommendation', { recommendations, applied, autoApply: effectiveAutoApply });

        await publish(process.env.REPORTS_TOPIC_ARN, `PowerPlant settings optimizer${applied ? ' — applied' : ''}`, message);
        await storeStatusRecord(buildOptimizationRecord(deviceSn, nowSeconds, {
            recommendations, aiRecommendation, applied, autoApply: effectiveAutoApply,
            reasoning: aiRecommendation?.reasoning || 'No parsable recommendation returned.'
        }));

        return { statusCode: 200 };
    } catch (err) {
        logError('Settings optimizer failed', { error: err.message });
        try {
            await publish(
                process.env.ALERTS_TOPIC_ARN,
                'PowerPlant settings optimizer — FAILED',
                `Settings optimizer failed: ${err.message}`
            );
        } catch (publishErr) {
            logError('Failed to publish settings optimizer failure alert', { error: publishErr.message });
        }
        throw err;
    }
};

module.exports.summarizeBatteryControlHistory = summarizeBatteryControlHistory;
module.exports.parseOptimizationRecommendation = parseOptimizationRecommendation;
module.exports.buildRecommendations = buildRecommendations;
module.exports.buildOptimizationRecord = buildOptimizationRecord;
module.exports.STATUS_RECORD_PREFIX = STATUS_RECORD_PREFIX;
module.exports.BATTERY_SETTINGS_PREFIX = BATTERY_SETTINGS_PREFIX;
module.exports.SETTINGS_OPTIMIZER_SETTINGS_PREFIX = SETTINGS_OPTIMIZER_SETTINGS_PREFIX;
