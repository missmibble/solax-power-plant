'use strict';

const mockSsmSend = jest.fn();
const mockSnsSend = jest.fn();
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

describe('BatteryControlFunction', () => {
    let classifyForecast, buildSelfUseModeRequest, handler;

    beforeEach(() => {
        jest.resetModules();
        mockSsmSend.mockReset();
        mockSnsSend.mockReset();
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
        process.env.REPORTS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:reports';
        process.env.ALERTS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:alerts';
        process.env.TARIFF_STRUCTURE = JSON.stringify({ timezone: 'UTC' });
        process.env.BATTERY_CONTROL_CONFIG = JSON.stringify({ ...BASELINE_CONFIG, dryRun: true });

        ({ classifyForecast, buildSelfUseModeRequest, handler } = require('../lambda/BatteryControlFunction/BatteryControlFunction'));
    });

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

    describe('handler (dry run)', () => {
        test('publishes a DRY RUN message and never calls the control endpoint', async () => {
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
        });
    });
});
