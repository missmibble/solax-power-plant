'use strict';

const { localDateString } = require('../lambda/Utilities/tariff');

const mockSsmSend = jest.fn();
const mockSnsSend = jest.fn();
const mockDynamoSend = jest.fn();
const mockBedrockSend = jest.fn();
const mockGetAccessToken = jest.fn();
const mockSetInverterSelfUseMode = jest.fn();
const mockSetInverterSocTargetMode = jest.fn();
const mockExitVppMode = jest.fn();

// These only live in lambda/BatteryControlFunction/node_modules (per-function
// deps), not the root node_modules test/ resolves from — virtual: true skips
// module resolution instead of erroring.
jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: jest.fn().mockImplementation(() => ({ send: (...args) => mockSsmSend(...args) })),
    GetParameterCommand: jest.fn().mockImplementation(input => ({ input }))
}), { virtual: true });

jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: jest.fn().mockImplementation(() => ({ send: (...args) => mockSnsSend(...args) })),
    PublishCommand: jest.fn().mockImplementation(input => ({ input }))
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({}))
}), { virtual: true });

// Tags each command with __type so the mock send() implementation (configured
// per-test below) can return different canned responses for Get/Put/Query.
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn().mockImplementation(() => ({ send: (...args) => mockDynamoSend(...args) })) },
    PutCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Put' })),
    GetCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Get' })),
    QueryCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Query' }))
}), { virtual: true });

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...args) => mockBedrockSend(...args) })),
    InvokeModelCommand: jest.fn().mockImplementation(input => ({ input }))
}), { virtual: true });

jest.mock('powerplant-shared', () => {
    const { localDateString, findImportRateWindow } = require('../lambda/Utilities/tariff');
    const { fetchTomorrowForecast } = require('../lambda/Utilities/weather-client');
    return {
        logInfo: jest.fn(),
        logError: jest.fn(),
        BUSINESS_TYPE: { RESIDENTIAL: 1 },
        getAccessToken: (...args) => mockGetAccessToken(...args),
        setInverterSelfUseMode: (...args) => mockSetInverterSelfUseMode(...args),
        setInverterSocTargetMode: (...args) => mockSetInverterSocTargetMode(...args),
        exitVppMode: (...args) => mockExitVppMode(...args),
        localDateString,
        findImportRateWindow,
        fetchTomorrowForecast
    };
}, { virtual: true });

const BASELINE_CONFIG = {
    minSoc: 10,
    chargeFromGridEnable: 1,
    chargeUpperSocSunny: 40,
    chargeUpperSocPartlyCloudy: 70,
    chargeUpperSocOvercast: 100,
    disabledChargeUpperSoc: 100,
    chargeStartTimePeriod1: '00:00',
    chargeEndTimePeriod1: '06:00',
    chargeStartTimePeriod2: '00:00',
    chargeEndTimePeriod2: '00:00',
    dischargeStartTimePeriod1: '00:00',
    dischargeEndTimePeriod1: '23:59',
    dischargeStartTimePeriod2: '00:00',
    dischargeEndTimePeriod2: '00:00',
    enableTimePeriod2: 0
};

// Raw Open-Meteo hourly-forecast response shape, for global.fetch mocks — a
// single hour is enough for classifyForecast's max/avg-across-slots logic
// with n=1. powerplant-shared's real fetchTomorrowForecast (weather-client.js)
// parses/normalizes this.
function openMeteoHourlyResponse(overrides) {
    return {
        hourly: {
            time: ['2026-01-01T12:00'],
            temperature_2m: [20],
            precipitation_probability: [0],
            precipitation: [0],
            cloud_cover: [0],
            ...overrides
        }
    };
}

// The normalized shape fetchTomorrowForecast returns — what classifyForecast
// actually consumes, so its own unit tests exercise that boundary rather than
// the raw provider shape.
function normalizedSlot(overrides) {
    return {
        timestampSeconds: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        precipitationProbability: 0,
        cloudCoverPercent: 0,
        isRainy: false,
        ...overrides
    };
}

// Default DynamoDB mock: no settings override, no previous status record —
// matches a fresh deployment with no history yet. Individual tests override
// specific call types (Get for settings, Query for previous-decision lookup)
// as needed via mockImplementation.
function defaultDynamoImpl(command) {
    if (command.__type === 'Get') return Promise.resolve({});
    if (command.__type === 'Query') return Promise.resolve({ Items: [] });
    return Promise.resolve({});
}

function bedrockTextResponse(text) {
    return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text }] })) };
}

// Routes the "latest reading" Query (queryLatestReading, keyed by the plain
// device SN) to a controlled batterySOC, while leaving the settings-override
// Get and the previous-status-record Query (BATTERY_CONTROL# prefix) at
// their defaults unless overridden.
function dynamoImplWithReading(batterySOC, { get, statusRecord } = {}) {
    return command => {
        if (command.__type === 'Get') return Promise.resolve(get || {});
        if (command.__type === 'Query') {
            const sn = command.input.ExpressionAttributeValues[':sn'];
            if (sn === process.env.SOLAX_INVERTER_SN) return Promise.resolve({ Items: [{ batterySOC }] });
            if (sn.startsWith('BATTERY_CONTROL#')) return Promise.resolve(statusRecord || { Items: [] });
            return Promise.resolve({ Items: [] });
        }
        return Promise.resolve({});
    };
}

// Routes the exitDischarge phase's "latest status record" Query (BATTERY_CONTROL#
// prefix) to a controlled record.
function dynamoImplWithStatusRecord(record) {
    return command => {
        if (command.__type === 'Query') {
            const sn = command.input.ExpressionAttributeValues[':sn'];
            if (sn.startsWith('BATTERY_CONTROL#')) return Promise.resolve({ Items: record ? [record] : [] });
            return Promise.resolve({ Items: [] });
        }
        return Promise.resolve({});
    };
}

describe('BatteryControlFunction', () => {
    let classifyForecast, buildSelfUseModeRequest, buildBatteryStatusRecord, resolveEffectiveSettings,
        chargeTargetForClassification, summarizeUsage, parseAccuracyAssessment, buildSurplusDischargePlan,
        BATTERY_STATUS_RECORD_PREFIX, handler;

    beforeEach(() => {
        jest.resetModules();
        mockSsmSend.mockReset();
        mockSnsSend.mockReset().mockResolvedValue({});
        mockDynamoSend.mockReset().mockImplementation(defaultDynamoImpl);
        mockBedrockSend.mockReset();
        mockGetAccessToken.mockReset();
        mockSetInverterSelfUseMode.mockReset();
        mockSetInverterSocTargetMode.mockReset();
        mockExitVppMode.mockReset();
        global.fetch = jest.fn();

        process.env.WEATHER_LAT = '-33.0000';
        process.env.WEATHER_LON = '151.0000';
        process.env.SOLAX_CLIENT_ID_PARAM = '/powerplant/solax/client-id';
        process.env.SOLAX_CLIENT_SECRET_PARAM = '/powerplant/solax/client-secret';
        process.env.SOLAX_BASE_URL = 'https://openapi-eu.solaxcloud.com';
        process.env.SOLAX_BUSINESS_TYPE = '1';
        process.env.SOLAX_INVERTER_SN = 'H34ABCDEFG5001';
        process.env.ENERGY_READINGS_TABLE = 'POWERPLANT-ENERGY-READINGS';
        process.env.REPORTS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:reports';
        process.env.ALERTS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:alerts';
        process.env.TARIFF_STRUCTURE = JSON.stringify({ timezone: 'UTC' });
        process.env.BATTERY_CONTROL_CONFIG = JSON.stringify({ ...BASELINE_CONFIG, dryRun: true });
        delete process.env.BEDROCK_MODEL_ID;

        ({
            classifyForecast, buildSelfUseModeRequest, buildBatteryStatusRecord, resolveEffectiveSettings,
            chargeTargetForClassification, summarizeUsage, parseAccuracyAssessment, buildSurplusDischargePlan,
            BATTERY_STATUS_RECORD_PREFIX, handler
        } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));
    });

    function findPutCall() {
        return mockDynamoSend.mock.calls.map(call => call[0]).find(cmd => cmd.__type === 'Put');
    }

    describe('classifyForecast', () => {
        test('classifies a clear, dry forecast as sunny', () => {
            const slots = [normalizedSlot(), normalizedSlot({ cloudCoverPercent: 10 })];
            expect(classifyForecast(slots).classification).toBe('sunny');
        });

        test('classifies a forecast with a rain condition as overcast', () => {
            const slots = [normalizedSlot({ isRainy: true })];
            expect(classifyForecast(slots).classification).toBe('overcast');
        });

        test('classifies a high precipitation probability as overcast even without a rain condition yet', () => {
            const slots = [normalizedSlot({ precipitationProbability: 0.6 })];
            expect(classifyForecast(slots).classification).toBe('overcast');
        });

        test('classifies heavy average cloud cover as overcast', () => {
            const slots = [normalizedSlot({ cloudCoverPercent: 90 }), normalizedSlot({ cloudCoverPercent: 85 })];
            expect(classifyForecast(slots).classification).toBe('overcast');
        });

        test('classifies an ambiguous/partly-cloudy forecast as its own tier rather than defaulting to overcast', () => {
            const slots = [normalizedSlot({ cloudCoverPercent: 50, precipitationProbability: 0.25 })];
            expect(classifyForecast(slots).classification).toBe('partly-cloudy');
        });

        test('defaults to overcast when there is no forecast data at all', () => {
            expect(classifyForecast([]).classification).toBe('overcast');
        });
    });

    describe('buildSelfUseModeRequest', () => {
        test('resends every baseline field, overriding only chargeUpperSoc', () => {
            const request = buildSelfUseModeRequest(BASELINE_CONFIG, 40);

            expect(request.chargeUpperSoc).toBe(40);
            expect(request.minSoc).toBe(10);
            expect(request.chargeFromGridEnable).toBe(1);
            expect(request.chargeStartTimePeriod1).toBe('00:00');
            expect(request.chargeEndTimePeriod1).toBe('06:00');
            expect(request.dischargeStartTimePeriod1).toBe('00:00');
            expect(request.dischargeEndTimePeriod1).toBe('23:59');
            expect(request.enableTimePeriod2).toBe(0);
        });
    });

    describe('buildBatteryStatusRecord', () => {
        test('prefixes DeviceSn with BATTERY_STATUS_RECORD_PREFIX so it cannot collide with a real device serial', () => {
            const record = buildBatteryStatusRecord('H34ABCDEFG5001', 1785400000, {
                classification: 'sunny', reasoning: 'maxPop=0.05', chargeUpperSoc: 40,
                dryRun: true, applied: false, enabled: true, appliesToDate: '2026-08-01', previousAssessment: null
            });

            expect(record.DeviceSn).toBe(`${BATTERY_STATUS_RECORD_PREFIX}H34ABCDEFG5001`);
            expect(record.Timestamp).toBe(1785400000);
            expect(record.classification).toBe('sunny');
            expect(record.reasoning).toBe('maxPop=0.05');
            expect(record.chargeUpperSoc).toBe(40);
            expect(record.dryRun).toBe(true);
            expect(record.applied).toBe(false);
            expect(record.enabled).toBe(true);
            expect(record.appliesToDate).toBe('2026-08-01');
            expect(record.previousAssessment).toBeNull();
        });

        test('defaults previousAssessment to null when omitted from fields', () => {
            const record = buildBatteryStatusRecord('sn', 1, { applied: true, enabled: true });
            expect(record.previousAssessment).toBeNull();
        });
    });

    describe('resolveEffectiveSettings', () => {
        test('falls back to config defaults when there is no saved override', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, null);
            expect(effective).toEqual({
                enabled: true, dryRun: true,
                chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 70, chargeUpperSocOvercast: 100, disabledChargeUpperSoc: 100
            });
        });

        test('uses the override values when present', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, {
                enabled: false, dryRun: false, chargeUpperSocSunny: 25, chargeUpperSocPartlyCloudy: 55,
                chargeUpperSocOvercast: 90, disabledChargeUpperSoc: 80
            });
            expect(effective).toEqual({
                enabled: false, dryRun: false,
                chargeUpperSocSunny: 25, chargeUpperSocPartlyCloudy: 55, chargeUpperSocOvercast: 90, disabledChargeUpperSoc: 80
            });
        });

        test('merges a partial override with config defaults for the untouched fields', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, { enabled: false });
            expect(effective).toEqual({
                enabled: false, dryRun: true,
                chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 70, chargeUpperSocOvercast: 100, disabledChargeUpperSoc: 100
            });
        });

        test('a dryRun: false override takes effect even when config.batteryControl.dryRun is true', () => {
            const effective = resolveEffectiveSettings({ ...BASELINE_CONFIG, dryRun: true }, { dryRun: false });
            expect(effective.dryRun).toBe(false);
        });

        test('falls back to config.batteryControl.dryRun when the override omits it', () => {
            const effective = resolveEffectiveSettings({ ...BASELINE_CONFIG, dryRun: false }, { enabled: false });
            expect(effective.dryRun).toBe(false);
        });
    });

    describe('chargeTargetForClassification', () => {
        test('sunny -> chargeUpperSocSunny', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, null);
            expect(chargeTargetForClassification('sunny', effective)).toBe(40);
        });

        test('partly-cloudy -> chargeUpperSocPartlyCloudy', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, null);
            expect(chargeTargetForClassification('partly-cloudy', effective)).toBe(70);
        });

        test('overcast -> chargeUpperSocOvercast', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, null);
            expect(chargeTargetForClassification('overcast', effective)).toBe(100);
        });

        test('an unrecognized classification falls back to the overcast (safe) target', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, null);
            expect(chargeTargetForClassification('unknown', effective)).toBe(100);
        });
    });

    describe('summarizeUsage', () => {
        test('computes PV/import/export deltas from first to last reading', () => {
            const readings = [
                { totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5 },
                { totalYield: 108, totalImportEnergy: 53, totalExportEnergy: 6.5 }
            ];
            expect(summarizeUsage(readings)).toEqual({ pvYieldKwh: 8, importKwh: 3, exportKwh: 1.5 });
        });

        test('includes battery SOC range when present', () => {
            const readings = [
                { totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5, batterySOC: 80 },
                { totalYield: 105, totalImportEnergy: 51, totalExportEnergy: 5, batterySOC: 20 },
                { totalYield: 108, totalImportEnergy: 53, totalExportEnergy: 6, batterySOC: 60 }
            ];
            const summary = summarizeUsage(readings);
            expect(summary.minBatterySOC).toBe(20);
            expect(summary.maxBatterySOC).toBe(80);
        });

        test('omits SOC fields when no reading has battery data', () => {
            const readings = [
                { totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5 },
                { totalYield: 105, totalImportEnergy: 51, totalExportEnergy: 5 }
            ];
            expect(summarizeUsage(readings).minBatterySOC).toBeUndefined();
        });

        test('omits byWindow when no tariff is passed', () => {
            const readings = [
                { totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5 },
                { totalYield: 108, totalImportEnergy: 53, totalExportEnergy: 6.5 }
            ];
            expect(summarizeUsage(readings).byWindow).toBeUndefined();
        });

        // Regression coverage for the "daytime load" mischaracterization found
        // in production: a whole-day import total (3.2 kWh) looked like it
        // could be daytime household load exceeding a full battery, but was
        // actually almost entirely expected overnight grid-charging. byWindow
        // is what lets that distinction be made instead of guessed at.
        test('breaks import/export down by tariff window rather than one whole-window total', () => {
            const tariff = {
                timezone: 'UTC',
                importRates: [
                    { label: 'night-ev-charge', startTime: '00:00', endTime: '06:00', rate: 0.08 },
                    { label: 'offpeak-midday', startTime: '09:00', endTime: '16:00', rate: 0.20141 }
                ]
            };
            const readings = [
                { Timestamp: Date.UTC(2026, 0, 1, 0, 30) / 1000, totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5 },
                { Timestamp: Date.UTC(2026, 0, 1, 1, 30) / 1000, totalYield: 102, totalImportEnergy: 53, totalExportEnergy: 5 },
                { Timestamp: Date.UTC(2026, 0, 1, 12, 0) / 1000, totalYield: 110, totalImportEnergy: 53.2, totalExportEnergy: 6 }
            ];

            const summary = summarizeUsage(readings, tariff);

            expect(summary.importKwh).toBe(3.2);
            expect(summary.byWindow['night-ev-charge']).toEqual({ importKwh: 3, exportKwh: 0 });
            expect(summary.byWindow['offpeak-midday']).toEqual({ importKwh: 0.2, exportKwh: 1 });
        });
    });

    describe('parseAccuracyAssessment', () => {
        test('parses a well-formed JSON response', () => {
            const result = parseAccuracyAssessment(
                '{"accurate": false, "assessment": "Ran flat before solar.", "usageShouldInfluence": true, "usageNote": "High overnight load."}'
            );
            expect(result).toEqual({
                accurate: false,
                assessment: 'Ran flat before solar.',
                usageShouldInfluence: true,
                usageNote: 'High overnight load.'
            });
        });

        test('extracts JSON even with surrounding text', () => {
            const result = parseAccuracyAssessment('Sure:\n{"accurate": true, "assessment": "Fine."}\nDone.');
            expect(result).toEqual({ accurate: true, assessment: 'Fine.', usageShouldInfluence: false, usageNote: '' });
        });

        test('returns null when accurate or assessment fields are missing', () => {
            expect(parseAccuracyAssessment('{"assessment": "Fine."}')).toBeNull();
            expect(parseAccuracyAssessment('{"accurate": true}')).toBeNull();
        });

        test('returns null when the text has no JSON object at all', () => {
            expect(parseAccuracyAssessment('not json')).toBeNull();
        });
    });

    describe('buildSurplusDischargePlan', () => {
        test('recommends discharging down to the target when surplus exceeds the minimum threshold', () => {
            const plan = buildSurplusDischargePlan({ currentSoc: 80, targetSoc: 40, minSurplusPercent: 5, maxDischargePowerW: 3000 });
            expect(plan).toEqual({ shouldDischarge: true, currentSoc: 80, targetSoc: 40, surplusPercent: 40, dischargePowerW: 3000 });
        });

        test('holds when surplus is below the minimum threshold', () => {
            const plan = buildSurplusDischargePlan({ currentSoc: 43, targetSoc: 40, minSurplusPercent: 5, maxDischargePowerW: 3000 });
            expect(plan).toEqual({ shouldDischarge: false, currentSoc: 43, targetSoc: 40, surplusPercent: 3 });
        });

        test('surplus exactly at the minimum threshold counts as dischargeable', () => {
            const plan = buildSurplusDischargePlan({ currentSoc: 45, targetSoc: 40, minSurplusPercent: 5, maxDischargePowerW: 3000 });
            expect(plan.shouldDischarge).toBe(true);
            expect(plan.surplusPercent).toBe(5);
        });

        test('holds when current SOC is already at the target', () => {
            const plan = buildSurplusDischargePlan({ currentSoc: 40, targetSoc: 40, minSurplusPercent: 5, maxDischargePowerW: 3000 });
            expect(plan.shouldDischarge).toBe(false);
            expect(plan.surplusPercent).toBe(0);
        });

        test('never reports a negative surplus when current SOC is below target', () => {
            const plan = buildSurplusDischargePlan({ currentSoc: 20, targetSoc: 40, minSurplusPercent: 5, maxDischargePowerW: 3000 });
            expect(plan.shouldDischarge).toBe(false);
            expect(plan.surplusPercent).toBe(0);
        });
    });

    describe('handler (dry run)', () => {
        test('publishes a DRY RUN message, stores a status record, and never calls the control endpoint', async () => {
            global.fetch.mockResolvedValue({
                json: async () => openMeteoHourlyResponse({ precipitation: [1] })
            });

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();
            expect(mockGetAccessToken).not.toHaveBeenCalled();

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.TopicArn).toBe(process.env.REPORTS_TOPIC_ARN);
            expect(publishCall.input.Subject).toContain('DRY RUN');
            expect(publishCall.input.Message).toContain("Would set tonight's battery charge target to 100%");

            const putCall = findPutCall();
            expect(putCall.input.TableName).toBe(process.env.ENERGY_READINGS_TABLE);
            expect(putCall.input.Item.DeviceSn).toBe(`${BATTERY_STATUS_RECORD_PREFIX}${process.env.SOLAX_INVERTER_SN}`);
            expect(putCall.input.Item.classification).toBe('overcast');
            expect(putCall.input.Item.chargeUpperSoc).toBe(100);
            expect(putCall.input.Item.dryRun).toBe(true);
            expect(putCall.input.Item.applied).toBe(false);
            expect(putCall.input.Item.enabled).toBe(true);
            expect(putCall.input.Item.appliesToDate).toBe(
                localDateString(Math.floor(Date.now() / 1000) + 24 * 60 * 60, 'UTC')
            );
        });

        test('uses the partly-cloudy charge target for an ambiguous forecast, rather than defaulting to the overcast one', async () => {
            global.fetch.mockResolvedValue({
                json: async () => openMeteoHourlyResponse({ cloud_cover: [50], precipitation_probability: [25] })
            });

            await handler();

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Message).toContain("Would set tonight's battery charge target to 70%");

            const putCall = findPutCall();
            expect(putCall.input.Item.classification).toBe('partly-cloudy');
            expect(putCall.input.Item.chargeUpperSoc).toBe(70);
        });
    });

    describe('handler (live)', () => {
        test('calls the control endpoint and publishes an "applied" message when dryRun is false', async () => {
            process.env.BATTERY_CONTROL_CONFIG = JSON.stringify({ ...BASELINE_CONFIG, dryRun: false });
            ({ handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));

            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            global.fetch.mockResolvedValue({
                json: async () => openMeteoHourlyResponse({}) // clear -> sunny -> 40%
            });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockSetInverterSelfUseMode.mockResolvedValue({ [process.env.SOLAX_INVERTER_SN]: { status: 0 } });

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSelfUseMode).toHaveBeenCalledTimes(1);
            const [, , request] = mockSetInverterSelfUseMode.mock.calls[0];
            expect(request.chargeUpperSoc).toBe(40);
            expect(request.snList).toBe(process.env.SOLAX_INVERTER_SN);

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('applied');
            expect(publishCall.input.Message).toContain("Set tonight's battery charge target to 40%");

            const putCall = findPutCall();
            expect(putCall.input.Item.classification).toBe('sunny');
            expect(putCall.input.Item.chargeUpperSoc).toBe(40);
            expect(putCall.input.Item.dryRun).toBe(false);
            expect(putCall.input.Item.applied).toBe(true);
        });

        test('uses the dashboard-saved chargeUpperSoc override instead of the config default', async () => {
            process.env.BATTERY_CONTROL_CONFIG = JSON.stringify({ ...BASELINE_CONFIG, dryRun: true });
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') {
                    return Promise.resolve({ Item: { enabled: true, chargeUpperSocSunny: 25, chargeUpperSocOvercast: 90 } });
                }
                if (command.__type === 'Query') return Promise.resolve({ Items: [] });
                return Promise.resolve({});
            });
            ({ handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));

            global.fetch.mockResolvedValue({
                json: async () => openMeteoHourlyResponse({}) // clear -> sunny
            });

            await handler();

            const putCall = findPutCall();
            expect(putCall.input.Item.chargeUpperSoc).toBe(25); // overridden sunny target, not the config's 40
        });

        test('uses a dashboard-saved dryRun: false override to go live even though config.batteryControl.dryRun is true', async () => {
            process.env.BATTERY_CONTROL_CONFIG = JSON.stringify({ ...BASELINE_CONFIG, dryRun: true });
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') return Promise.resolve({ Item: { enabled: true, dryRun: false } });
                if (command.__type === 'Query') return Promise.resolve({ Items: [] });
                return Promise.resolve({});
            });
            ({ handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));

            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            global.fetch.mockResolvedValue({
                json: async () => openMeteoHourlyResponse({}) // clear -> sunny -> 40%
            });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockSetInverterSelfUseMode.mockResolvedValue({ [process.env.SOLAX_INVERTER_SN]: { status: 0 } });

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSelfUseMode).toHaveBeenCalledTimes(1);

            const putCall = findPutCall();
            expect(putCall.input.Item.dryRun).toBe(false);
            expect(putCall.input.Item.applied).toBe(true);
        });

        test('skips the weather/forecast lookup but still dry-run-decides the disabled default when the dashboard toggle is off', async () => {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') return Promise.resolve({ Item: { enabled: false } });
                if (command.__type === 'Query') return Promise.resolve({ Items: [] });
                return Promise.resolve({});
            });
            ({ handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(global.fetch).not.toHaveBeenCalled(); // no forecast call needed when disabled
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled(); // dryRun: true by default

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('DRY RUN');

            const putCall = findPutCall();
            expect(putCall.input.Item.enabled).toBe(false);
            expect(putCall.input.Item.classification).toBe('disabled');
            expect(putCall.input.Item.chargeUpperSoc).toBe(100); // BASELINE_CONFIG.disabledChargeUpperSoc
            expect(putCall.input.Item.dryRun).toBe(true);
            expect(putCall.input.Item.applied).toBe(false);
            expect(putCall.input.Item.appliesToDate).toBe(
                localDateString(Math.floor(Date.now() / 1000) + 24 * 60 * 60, 'UTC')
            );
        });

        test('applies the disabled default chargeUpperSoc to the inverter when disabled and not a dry run', async () => {
            process.env.BATTERY_CONTROL_CONFIG = JSON.stringify({ ...BASELINE_CONFIG, dryRun: false });
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') return Promise.resolve({ Item: { enabled: false } });
                if (command.__type === 'Query') return Promise.resolve({ Items: [] });
                return Promise.resolve({});
            });
            ({ handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));

            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockSetInverterSelfUseMode.mockResolvedValue({ [process.env.SOLAX_INVERTER_SN]: { status: 0 } });

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(global.fetch).not.toHaveBeenCalled();
            expect(mockSetInverterSelfUseMode).toHaveBeenCalledTimes(1);
            const [, , request] = mockSetInverterSelfUseMode.mock.calls[0];
            expect(request.chargeUpperSoc).toBe(100);

            const putCall = findPutCall();
            expect(putCall.input.Item.enabled).toBe(false);
            expect(putCall.input.Item.classification).toBe('disabled');
            expect(putCall.input.Item.chargeUpperSoc).toBe(100);
            expect(putCall.input.Item.dryRun).toBe(false);
            expect(putCall.input.Item.applied).toBe(true);
        });
    });

    describe('handler (surplus discharge)', () => {
        test('dry run: does not call any control endpoint, stores dischargeApplied, message mentions the discharge', async () => {
            mockDynamoSend.mockImplementation(dynamoImplWithReading(80));
            global.fetch.mockResolvedValue({ json: async () => openMeteoHourlyResponse({}) }); // clear -> sunny -> 40% target; 80% SOC is 40 points above

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();
            expect(mockSetInverterSocTargetMode).not.toHaveBeenCalled();
            expect(mockGetAccessToken).not.toHaveBeenCalled();

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('DRY RUN');
            expect(publishCall.input.Message).toContain('would discharge');

            const putCall = findPutCall();
            expect(putCall.input.Item.dischargeApplied).toBe(true);
            expect(putCall.input.Item.dischargeSurplusPercent).toBe(40);
            expect(putCall.input.Item.chargeUpperSoc).toBe(40);
            expect(putCall.input.Item.dryRun).toBe(true);
            expect(putCall.input.Item.applied).toBe(false);
        });

        test('live: calls setInverterSocTargetMode to discharge, and does not set self-use mode this run', async () => {
            process.env.BATTERY_CONTROL_CONFIG = JSON.stringify({ ...BASELINE_CONFIG, dryRun: false });
            mockDynamoSend.mockImplementation(dynamoImplWithReading(80));

            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            global.fetch.mockResolvedValue({ json: async () => openMeteoHourlyResponse({}) });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockSetInverterSocTargetMode.mockResolvedValue({ [process.env.SOLAX_INVERTER_SN]: { status: 4 } });

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();
            expect(mockSetInverterSocTargetMode).toHaveBeenCalledTimes(1);
            const [, , request] = mockSetInverterSocTargetMode.mock.calls[0];
            expect(request.targetSoc).toBe(40);
            expect(request.chargeDischargPower).toBe(-3000); // negative = discharge, default maxDischargePowerW

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('applied');
            expect(publishCall.input.Message).toContain('discharging');

            const putCall = findPutCall();
            expect(putCall.input.Item.dischargeApplied).toBe(true);
            expect(putCall.input.Item.dryRun).toBe(false);
            expect(putCall.input.Item.applied).toBe(true);
        });

        test('no discharge when surplus is below the minimum threshold — sets self-use mode as usual', async () => {
            mockDynamoSend.mockImplementation(dynamoImplWithReading(42)); // only 2 points above the 40% sunny target
            global.fetch.mockResolvedValue({ json: async () => openMeteoHourlyResponse({}) });

            await handler();

            expect(mockSetInverterSocTargetMode).not.toHaveBeenCalled();
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled(); // dryRun: true by default

            const putCall = findPutCall();
            expect(putCall.input.Item.dischargeApplied).toBe(false);
            expect(putCall.input.Item.chargeUpperSoc).toBe(40);
        });

        test('no discharge when nightly control is disabled, even with a large surplus reading', async () => {
            mockDynamoSend.mockImplementation(dynamoImplWithReading(95, { get: { Item: { enabled: false } } }));

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSocTargetMode).not.toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();

            const putCall = findPutCall();
            expect(putCall.input.Item.dischargeApplied).toBe(false);
            expect(putCall.input.Item.classification).toBe('disabled');
        });
    });

    describe('handler (exitDischarge phase)', () => {
        function freshRecord(overrides) {
            return {
                Timestamp: Math.floor(Date.now() / 1000) - 3600, // 1h old — within the freshness window
                classification: 'sunny',
                chargeUpperSoc: 40,
                dischargeApplied: true,
                dryRun: true,
                ...overrides
            };
        }

        test('no-op when no status record exists for tonight', async () => {
            mockDynamoSend.mockImplementation(dynamoImplWithStatusRecord(null));

            const result = await handler({ phase: 'exitDischarge' });

            expect(result.statusCode).toBe(200);
            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(mockExitVppMode).not.toHaveBeenCalled();
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();
        });

        test('no-op when tonight\'s record shows no discharge was applied', async () => {
            mockDynamoSend.mockImplementation(dynamoImplWithStatusRecord(freshRecord({ dischargeApplied: false })));

            const result = await handler({ phase: 'exitDischarge' });

            expect(result.statusCode).toBe(200);
            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(mockExitVppMode).not.toHaveBeenCalled();
        });

        test('no-op when the only discharge record found is stale (from a previous night)', async () => {
            mockDynamoSend.mockImplementation(dynamoImplWithStatusRecord(
                freshRecord({ Timestamp: Math.floor(Date.now() / 1000) - 5 * 3600 }) // 5h old
            ));

            const result = await handler({ phase: 'exitDischarge' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
        });

        test('dry run: publishes a DRY RUN exit message without calling the control endpoint', async () => {
            mockDynamoSend.mockImplementation(dynamoImplWithStatusRecord(freshRecord({ dryRun: true })));

            const result = await handler({ phase: 'exitDischarge' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('DRY RUN exit');

            const putCall = findPutCall();
            expect(putCall.input.Item.dischargeExitApplied).toBe(false);
        });

        test('live: exits VPP mode, then sets self-use mode with the stored chargeUpperSoc', async () => {
            mockDynamoSend.mockImplementation(dynamoImplWithStatusRecord(freshRecord({ dryRun: false, chargeUpperSoc: 55 })));
            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockExitVppMode.mockResolvedValue({});
            mockSetInverterSelfUseMode.mockResolvedValue({});

            const result = await handler({ phase: 'exitDischarge' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).toHaveBeenCalledTimes(1);
            expect(mockSetInverterSelfUseMode).toHaveBeenCalledTimes(1);
            const [, , request] = mockSetInverterSelfUseMode.mock.calls[0];
            expect(request.chargeUpperSoc).toBe(55);

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('exit applied');

            const putCall = findPutCall();
            expect(putCall.input.Item.dischargeExitApplied).toBe(true);
        });
    });

    describe('handler (previous-decision accuracy assessment)', () => {
        test('includes a previousAssessment on the new record when a model is configured and history exists', async () => {
            process.env.BEDROCK_MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') return Promise.resolve({});
                if (command.__type === 'Query') {
                    // First query: previous status record. Second query: readings since then.
                    if (command.input.ExpressionAttributeValues[':sn'].startsWith('BATTERY_CONTROL#')) {
                        return Promise.resolve({
                            Items: [{ Timestamp: 1000, classification: 'sunny', reasoning: 'clear', chargeUpperSoc: 40, applied: true }]
                        });
                    }
                    return Promise.resolve({
                        Items: [
                            { totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5, batterySOC: 80 },
                            { totalYield: 108, totalImportEnergy: 55, totalExportEnergy: 6, batterySOC: 15 }
                        ]
                    });
                }
                return Promise.resolve({});
            });
            ({ handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));

            global.fetch.mockResolvedValue({ json: async () => openMeteoHourlyResponse({}) });
            mockBedrockSend.mockResolvedValue(bedrockTextResponse(
                '{"accurate": false, "assessment": "Ran flat before solar.", "usageShouldInfluence": true, "usageNote": "Low SOC overnight."}'
            ));

            await handler();

            const putCall = findPutCall();
            expect(putCall.input.Item.previousAssessment).toEqual({
                accurate: false,
                assessment: 'Ran flat before solar.',
                usageShouldInfluence: true,
                usageNote: 'Low SOC overnight.'
            });
        });

        test('omits previousAssessment when no model is configured', async () => {
            global.fetch.mockResolvedValue({ json: async () => openMeteoHourlyResponse({}) });

            await handler();

            expect(mockBedrockSend).not.toHaveBeenCalled();
            const putCall = findPutCall();
            expect(putCall.input.Item.previousAssessment).toBeNull();
        });
    });

    describe('handler (failure)', () => {
        test('publishes an alert and rethrows when the weather lookup fails', async () => {
            global.fetch.mockResolvedValue({ json: async () => ({ error: true, reason: 'Internal Server Error' }) });

            await expect(handler()).rejects.toThrow(/Internal Server Error/);

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.TopicArn).toBe(process.env.ALERTS_TOPIC_ARN);
            expect(publishCall.input.Subject).toContain('FAILED');
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();
            expect(findPutCall()).toBeUndefined();
        });
    });
});
