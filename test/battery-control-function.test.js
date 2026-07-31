'use strict';

const mockSsmSend = jest.fn();
const mockSnsSend = jest.fn();
const mockDynamoSend = jest.fn();
const mockBedrockSend = jest.fn();
const mockGetAccessToken = jest.fn();
const mockSetInverterSelfUseMode = jest.fn();

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
    const { localDateString } = require('../lambda/Utilities/tariff');
    return {
        logInfo: jest.fn(),
        logError: jest.fn(),
        BUSINESS_TYPE: { RESIDENTIAL: 1 },
        getAccessToken: (...args) => mockGetAccessToken(...args),
        setInverterSelfUseMode: (...args) => mockSetInverterSelfUseMode(...args),
        localDateString
    };
}, { virtual: true });

const BASELINE_CONFIG = {
    minSoc: 10,
    chargeFromGridEnable: 1,
    chargeUpperSocSunny: 40,
    chargeUpperSocOvercast: 100,
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

function tomorrowSlot(overrides) {
    const tomorrowSeconds = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    return {
        dt: tomorrowSeconds,
        pop: 0,
        clouds: { all: 0 },
        weather: [{ main: 'Clear' }],
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

describe('BatteryControlFunction', () => {
    let classifyForecast, buildSelfUseModeRequest, buildBatteryStatusRecord, resolveEffectiveSettings,
        summarizeUsage, parseAccuracyAssessment, BATTERY_STATUS_RECORD_PREFIX, handler;

    beforeEach(() => {
        jest.resetModules();
        mockSsmSend.mockReset();
        mockSnsSend.mockReset().mockResolvedValue({});
        mockDynamoSend.mockReset().mockImplementation(defaultDynamoImpl);
        mockBedrockSend.mockReset();
        mockGetAccessToken.mockReset();
        mockSetInverterSelfUseMode.mockReset();
        global.fetch = jest.fn();

        process.env.WEATHER_LAT = '-33.0000';
        process.env.WEATHER_LON = '151.0000';
        process.env.WEATHER_API_KEY_PARAM = '/powerplant/weather/api-key';
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
            summarizeUsage, parseAccuracyAssessment, BATTERY_STATUS_RECORD_PREFIX, handler
        } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));
    });

    function findPutCall() {
        return mockDynamoSend.mock.calls.map(call => call[0]).find(cmd => cmd.__type === 'Put');
    }

    describe('classifyForecast', () => {
        test('classifies a clear, dry forecast as sunny', () => {
            const slots = [tomorrowSlot(), tomorrowSlot({ clouds: { all: 10 } })];
            expect(classifyForecast(slots).classification).toBe('sunny');
        });

        test('classifies a forecast with a rain condition as overcast', () => {
            const slots = [tomorrowSlot({ weather: [{ main: 'Rain' }] })];
            expect(classifyForecast(slots).classification).toBe('overcast');
        });

        test('classifies a high precipitation probability as overcast even without a rain condition yet', () => {
            const slots = [tomorrowSlot({ pop: 0.6 })];
            expect(classifyForecast(slots).classification).toBe('overcast');
        });

        test('classifies heavy average cloud cover as overcast', () => {
            const slots = [tomorrowSlot({ clouds: { all: 90 } }), tomorrowSlot({ clouds: { all: 85 } })];
            expect(classifyForecast(slots).classification).toBe('overcast');
        });

        test('defaults an ambiguous/partly-cloudy forecast to the safe overcast outcome', () => {
            const slots = [tomorrowSlot({ clouds: { all: 50 }, pop: 0.25 })];
            expect(classifyForecast(slots).classification).toBe('overcast');
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
                dryRun: true, applied: false, enabled: true, previousAssessment: null
            });

            expect(record.DeviceSn).toBe(`${BATTERY_STATUS_RECORD_PREFIX}H34ABCDEFG5001`);
            expect(record.Timestamp).toBe(1785400000);
            expect(record.classification).toBe('sunny');
            expect(record.reasoning).toBe('maxPop=0.05');
            expect(record.chargeUpperSoc).toBe(40);
            expect(record.dryRun).toBe(true);
            expect(record.applied).toBe(false);
            expect(record.enabled).toBe(true);
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
            expect(effective).toEqual({ enabled: true, chargeUpperSocSunny: 40, chargeUpperSocOvercast: 100 });
        });

        test('uses the override values when present', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, {
                enabled: false, chargeUpperSocSunny: 25, chargeUpperSocOvercast: 90
            });
            expect(effective).toEqual({ enabled: false, chargeUpperSocSunny: 25, chargeUpperSocOvercast: 90 });
        });

        test('merges a partial override with config defaults for the untouched fields', () => {
            const effective = resolveEffectiveSettings(BASELINE_CONFIG, { enabled: false });
            expect(effective).toEqual({ enabled: false, chargeUpperSocSunny: 40, chargeUpperSocOvercast: 100 });
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

    describe('handler (dry run)', () => {
        test('publishes a DRY RUN message, stores a status record, and never calls the control endpoint', async () => {
            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'weather-key' } });
            global.fetch.mockResolvedValue({
                json: async () => ({ cod: '200', list: [tomorrowSlot({ weather: [{ main: 'Rain' }] })] })
            });

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();
            expect(mockGetAccessToken).not.toHaveBeenCalled();

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.TopicArn).toBe(process.env.REPORTS_TOPIC_ARN);
            expect(publishCall.input.Subject).toContain('DRY RUN');
            expect(publishCall.input.Message).toContain('Would set chargeUpperSoc to 100');

            const putCall = findPutCall();
            expect(putCall.input.TableName).toBe(process.env.ENERGY_READINGS_TABLE);
            expect(putCall.input.Item.DeviceSn).toBe(`${BATTERY_STATUS_RECORD_PREFIX}${process.env.SOLAX_INVERTER_SN}`);
            expect(putCall.input.Item.classification).toBe('overcast');
            expect(putCall.input.Item.chargeUpperSoc).toBe(100);
            expect(putCall.input.Item.dryRun).toBe(true);
            expect(putCall.input.Item.applied).toBe(false);
            expect(putCall.input.Item.enabled).toBe(true);
        });
    });

    describe('handler (live)', () => {
        test('calls the control endpoint and publishes an "applied" message when dryRun is false', async () => {
            process.env.BATTERY_CONTROL_CONFIG = JSON.stringify({ ...BASELINE_CONFIG, dryRun: false });
            ({ handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));

            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            global.fetch.mockResolvedValue({
                json: async () => ({ cod: '200', list: [tomorrowSlot()] }) // clear -> sunny -> 40%
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
            expect(publishCall.input.Message).toContain('Set chargeUpperSoc to 40');

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

            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'weather-key' } });
            global.fetch.mockResolvedValue({
                json: async () => ({ cod: '200', list: [tomorrowSlot()] }) // clear -> sunny
            });

            await handler();

            const putCall = findPutCall();
            expect(putCall.input.Item.chargeUpperSoc).toBe(25); // overridden sunny target, not the config's 40
        });

        test('skips the whole run and stores a disabled record when the dashboard toggle is off', async () => {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') return Promise.resolve({ Item: { enabled: false } });
                if (command.__type === 'Query') return Promise.resolve({ Items: [] });
                return Promise.resolve({});
            });
            ({ handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(global.fetch).not.toHaveBeenCalled();
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();
            expect(mockSnsSend).not.toHaveBeenCalled();

            const putCall = findPutCall();
            expect(putCall.input.Item.enabled).toBe(false);
            expect(putCall.input.Item.classification).toBeNull();
            expect(putCall.input.Item.applied).toBe(false);
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

            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'weather-key' } });
            global.fetch.mockResolvedValue({ json: async () => ({ cod: '200', list: [tomorrowSlot()] }) });
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
            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'weather-key' } });
            global.fetch.mockResolvedValue({ json: async () => ({ cod: '200', list: [tomorrowSlot()] }) });

            await handler();

            expect(mockBedrockSend).not.toHaveBeenCalled();
            const putCall = findPutCall();
            expect(putCall.input.Item.previousAssessment).toBeNull();
        });
    });

    describe('handler (failure)', () => {
        test('publishes an alert and rethrows when the weather lookup fails', async () => {
            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'weather-key' } });
            global.fetch.mockResolvedValue({ json: async () => ({ cod: '401', message: 'invalid API key' }) });

            await expect(handler()).rejects.toThrow(/invalid API key/);

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.TopicArn).toBe(process.env.ALERTS_TOPIC_ARN);
            expect(publishCall.input.Subject).toContain('FAILED');
            expect(mockSetInverterSelfUseMode).not.toHaveBeenCalled();
            expect(findPutCall()).toBeUndefined();
        });
    });
});
