'use strict';

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const {
    logInfo,
    logError,
    BUSINESS_TYPE,
    getAccessToken,
    setInverterSelfUseMode,
    localDateString
} = require('powerplant-shared');

const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const snsClient = new SNSClient({ region: process.env.AWS_REGION });

let cachedCredentials = null; // reused across warm invocations, same pattern as PollerFunction
let cachedWeatherApiKey = null;

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

async function loadWeatherApiKey() {
    if (cachedWeatherApiKey) return cachedWeatherApiKey;

    const result = await ssmClient.send(new GetParameterCommand({
        Name: process.env.WEATHER_API_KEY_PARAM,
        WithDecryption: true
    }));

    cachedWeatherApiKey = result.Parameter.Value;
    return cachedWeatherApiKey;
}

// OpenWeatherMap's free 5-day/3-hour forecast endpoint (no One Call subscription
// needed) — filtered down to the 3-hour slots that fall on tomorrow's local date.
async function fetchTomorrowForecastSlots(lat, lon, apiKey, timezone) {
    const url = new URL('https://api.openweathermap.org/data/2.5/forecast');
    url.searchParams.set('lat', lat);
    url.searchParams.set('lon', lon);
    url.searchParams.set('appid', apiKey);
    url.searchParams.set('units', 'metric');

    const response = await fetch(url);
    const payload = await response.json();
    if (String(payload.cod) !== '200') {
        throw new Error(`OpenWeatherMap error: cod=${payload.cod} message=${payload.message}`);
    }

    const tomorrow = localDateString(Math.floor(Date.now() / 1000) + 24 * 60 * 60, timezone);
    return (payload.list || []).filter(slot => localDateString(slot.dt, timezone) === tomorrow);
}

// Classifies tomorrow's forecast slots into a charge target. Ambiguous signal
// (partly cloudy, borderline rain chance) deliberately falls back to "overcast"
// — the safe failure mode here is a fuller-than-necessary battery, not one that
// runs out before solar catches up.
function classifyForecast(slots) {
    if (!slots.length) {
        return { classification: 'overcast', reasoning: 'No forecast data for tomorrow — defaulting to safe/conservative.' };
    }

    const maxPop = Math.max(...slots.map(s => s.pop || 0));
    const avgClouds = slots.reduce((sum, s) => sum + (s.clouds?.all || 0), 0) / slots.length;
    const hasRainCondition = slots.some(s => ['Rain', 'Thunderstorm', 'Drizzle', 'Snow'].includes(s.weather?.[0]?.main));

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
        classification: 'overcast',
        reasoning: `Ambiguous forecast (maxPop=${maxPop.toFixed(2)}, avgClouds=${Math.round(avgClouds)}%) — defaulting to safe/conservative.`
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
    return [
        `Forecast classification: ${classification}`,
        `Reasoning: ${reasoning}`,
        `${dryRun ? 'Would set' : 'Set'} chargeUpperSoc to ${requestBody.chargeUpperSoc}%`,
        '',
        `Full request body: ${JSON.stringify(requestBody)}`
    ].join('\n');
}

async function publish(topicArn, subject, message) {
    await snsClient.send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
}

exports.handler = async () => {
    try {
        const batteryControlConfig = JSON.parse(process.env.BATTERY_CONTROL_CONFIG);
        const tariff = JSON.parse(process.env.TARIFF_STRUCTURE);
        const dryRun = batteryControlConfig.dryRun !== false;

        const weatherApiKey = await loadWeatherApiKey();
        const slots = await fetchTomorrowForecastSlots(
            process.env.WEATHER_LAT, process.env.WEATHER_LON, weatherApiKey, tariff.timezone
        );
        const { classification, reasoning } = classifyForecast(slots);
        const chargeUpperSoc = classification === 'sunny'
            ? batteryControlConfig.chargeUpperSocSunny
            : batteryControlConfig.chargeUpperSocOvercast;

        const requestBody = buildSelfUseModeRequest(batteryControlConfig, chargeUpperSoc);

        if (dryRun) {
            logInfo('Battery control dry run', { classification, reasoning, requestBody });
            await publish(
                process.env.REPORTS_TOPIC_ARN,
                'PowerPlant battery control — DRY RUN (no change applied)',
                formatMessage(classification, reasoning, requestBody, true)
            );
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

        logInfo('Battery control applied', { classification, reasoning, requestBody });
        await publish(
            process.env.REPORTS_TOPIC_ARN,
            'PowerPlant battery control — applied',
            formatMessage(classification, reasoning, requestBody, false)
        );
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
