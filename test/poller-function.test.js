'use strict';

const mockGetDeviceInfo = jest.fn();
const mockGetDeviceRealtimeData = jest.fn();
const mockGetAccessToken = jest.fn();
const mockSsmSend = jest.fn();
const mockDynamoSend = jest.fn();

// These only live in lambda/PollerFunction/node_modules (per-function deps),
// not the root node_modules test/ resolves from — virtual: true skips module
// resolution instead of erroring.
jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: jest.fn().mockImplementation(() => ({ send: (...args) => mockSsmSend(...args) })),
    GetParameterCommand: jest.fn().mockImplementation(input => ({ input }))
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({}))
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn().mockImplementation(() => ({ send: (...args) => mockDynamoSend(...args) })) },
    PutCommand: jest.fn().mockImplementation(input => ({ input }))
}), { virtual: true });

jest.mock('powerplant-shared', () => ({
    logInfo: jest.fn(),
    logError: jest.fn(),
    BUSINESS_TYPE: { RESIDENTIAL: 1 },
    DEVICE_TYPE: { INVERTER: 1, BATTERY: 2 },
    getAccessToken: (...args) => mockGetAccessToken(...args),
    getDeviceInfo: (...args) => mockGetDeviceInfo(...args),
    getDeviceRealtimeData: (...args) => mockGetDeviceRealtimeData(...args)
}), { virtual: true });

describe('PollerFunction battery discovery', () => {
    let resolveBatterySn, fetchBatteryReading;

    beforeEach(() => {
        // fresh module instance per test — cachedBatterySn is module-scoped
        jest.resetModules();
        mockGetDeviceInfo.mockReset();
        mockGetDeviceRealtimeData.mockReset();
        delete process.env.SOLAX_BATTERY_SN;
        ({ resolveBatterySn, fetchBatteryReading } = require('../lambda/PollerFunction/PollerFunction'));
    });

    describe('resolveBatterySn', () => {
        test('uses the configured SN directly when it is not the placeholder', async () => {
            process.env.SOLAX_BATTERY_SN = 'REAL-BATTERY-SN';

            const sn = await resolveBatterySn('https://base', 'token', 1);

            expect(sn).toBe('REAL-BATTERY-SN');
            expect(mockGetDeviceInfo).not.toHaveBeenCalled();
        });

        test('auto-discovers via getDeviceInfo when unset', async () => {
            mockGetDeviceInfo.mockResolvedValue({ records: [{ deviceSn: 'DISCOVERED-SN' }] });

            const sn = await resolveBatterySn('https://base', 'token', 1);

            expect(sn).toBe('DISCOVERED-SN');
            expect(mockGetDeviceInfo).toHaveBeenCalledWith('https://base', 'token', {
                deviceType: 2,
                businessType: 1
            });
        });

        test('auto-discovers when the config still has the TODO placeholder', async () => {
            process.env.SOLAX_BATTERY_SN = 'TODO_BATTERY_SN';
            mockGetDeviceInfo.mockResolvedValue({ records: [{ deviceSn: 'DISCOVERED-SN' }] });

            const sn = await resolveBatterySn('https://base', 'token', 1);

            expect(sn).toBe('DISCOVERED-SN');
            expect(mockGetDeviceInfo).toHaveBeenCalledTimes(1);
        });

        test('caches the discovered SN across calls within the same execution context', async () => {
            mockGetDeviceInfo.mockResolvedValue({ records: [{ deviceSn: 'DISCOVERED-SN' }] });

            await resolveBatterySn('https://base', 'token', 1);
            await resolveBatterySn('https://base', 'token', 1);

            expect(mockGetDeviceInfo).toHaveBeenCalledTimes(1);
        });

        test('returns null when no battery device is discoverable', async () => {
            mockGetDeviceInfo.mockResolvedValue({ records: [] });

            const sn = await resolveBatterySn('https://base', 'token', 1);

            expect(sn).toBeNull();
        });
    });

    describe('fetchBatteryReading', () => {
        test('returns the battery reading using requestSnType=2 (by battery SN)', async () => {
            process.env.SOLAX_BATTERY_SN = 'REAL-BATTERY-SN';
            mockGetDeviceRealtimeData.mockResolvedValue([{ deviceSn: 'REAL-BATTERY-SN', batterySOC: 55 }]);

            const reading = await fetchBatteryReading('https://base', 'token', 1);

            expect(reading).toEqual({ deviceSn: 'REAL-BATTERY-SN', batterySOC: 55 });
            expect(mockGetDeviceRealtimeData).toHaveBeenCalledWith('https://base', 'token', {
                snList: 'REAL-BATTERY-SN',
                deviceType: 2,
                requestSnType: 2,
                businessType: 1
            });
        });

        test('returns null (not a thrown error) when the battery API call fails', async () => {
            process.env.SOLAX_BATTERY_SN = 'REAL-BATTERY-SN';
            mockGetDeviceRealtimeData.mockRejectedValue(new Error('SolaX API error'));

            const reading = await fetchBatteryReading('https://base', 'token', 1);

            expect(reading).toBeNull();
        });

        test('returns null without calling realtime data when no battery is discoverable', async () => {
            mockGetDeviceInfo.mockResolvedValue({ records: [] });

            const reading = await fetchBatteryReading('https://base', 'token', 1);

            expect(reading).toBeNull();
            expect(mockGetDeviceRealtimeData).not.toHaveBeenCalled();
        });
    });
});

describe('PollerFunction handler', () => {
    let handler;

    beforeEach(() => {
        jest.resetModules();
        mockGetDeviceInfo.mockReset();
        mockGetDeviceRealtimeData.mockReset();
        mockGetAccessToken.mockReset().mockResolvedValue('access-token');
        mockSsmSend.mockReset().mockResolvedValue({ Parameter: { Value: 'secret-value' } });
        mockDynamoSend.mockReset().mockResolvedValue({});

        process.env.SOLAX_CLIENT_ID_PARAM = '/powerplant/solax/client-id';
        process.env.SOLAX_CLIENT_SECRET_PARAM = '/powerplant/solax/client-secret';
        process.env.SOLAX_BASE_URL = 'https://openapi-eu.solaxcloud.com';
        process.env.SOLAX_BUSINESS_TYPE = '1';
        process.env.SOLAX_INVERTER_SN = 'H34ABCDEFG5001';
        process.env.SOLAX_BATTERY_SN = 'B34ABCDEFG5002';
        process.env.SOLAX_DEVICE_TYPE = '1';
        process.env.ENERGY_READINGS_TABLE = 'POWERPLANT-ENERGY-READINGS';

        ({ handler } = require('../lambda/PollerFunction/PollerFunction'));
    });

    function findPutCall() {
        return mockDynamoSend.mock.calls[0][0];
    }

    // Regression test for a real bug: docs/solax-apis.md previously (incorrectly)
    // documented this SolaX field as misspelled "totalDevicCharge" (missing "e"),
    // and PollerFunction's mapping matched that documented typo — but the live
    // API actually returns the correctly-spelled "totalDeviceCharge", so the old
    // mapping read a key that never existed and totalDeviceCharge was silently
    // undefined on every stored reading. That, in turn, meant the dashboard's
    // battery panels never had the data they needed. Verified against a live
    // SolaX API call before fixing.
    test('maps the battery reading\'s totalDeviceCharge field by its real (correctly-spelled) name', async () => {
        mockGetDeviceRealtimeData.mockImplementation((baseUrl, token, params) => {
            if (params.deviceType === 1) {
                return Promise.resolve([{
                    deviceSn: 'H34ABCDEFG5001', dataTime: '2026-07-31T04:45:00.000+00:00',
                    deviceStatus: 102, dailyYield: 22.7, totalYield: 444.9, dailyACOutput: 22.2,
                    totalACOutput: 520.6, gridPower: 0, todayImportEnergy: 28.8, totalImportEnergy: 403.94,
                    todayExportEnergy: 0.1, totalExportEnergy: 80.7, totalActivePower: null
                }]);
            }
            return Promise.resolve([{
                deviceSn: 'B34ABCDEFG5002', deviceStatus: 1, batterySOC: 98, batterySOH: null,
                chargeDischargePower: -352, batteryTemperature: 22.0, batteryCycleTimes: 13,
                batteryRemainings: 18.0, totalDeviceCharge: 246.2, totalDeviceDischarge: 222.2
            }]);
        });

        const result = await handler();

        expect(result.statusCode).toBe(200);
        const putCall = findPutCall();
        expect(putCall.input.Item.totalDeviceCharge).toBe(246.2);
        expect(putCall.input.Item.totalDeviceDischarge).toBe(222.2);
    });

    // batterySOH has consistently come back null from the live SolaX API for
    // this account's battery (verified against 20+ consecutive polls) — swapped
    // for batteryTemperature, which the API does report, on the dashboard's
    // Current Battery Status panel.
    test('maps the battery reading\'s batteryTemperature field, not the consistently-null batterySOH', async () => {
        mockGetDeviceRealtimeData.mockImplementation((baseUrl, token, params) => {
            if (params.deviceType === 1) {
                return Promise.resolve([{
                    deviceSn: 'H34ABCDEFG5001', dataTime: '2026-07-31T04:45:00.000+00:00',
                    deviceStatus: 102, dailyYield: 22.7, totalYield: 444.9, dailyACOutput: 22.2,
                    totalACOutput: 520.6, gridPower: 0, todayImportEnergy: 28.8, totalImportEnergy: 403.94,
                    todayExportEnergy: 0.1, totalExportEnergy: 80.7, totalActivePower: null
                }]);
            }
            return Promise.resolve([{
                deviceSn: 'B34ABCDEFG5002', deviceStatus: 1, batterySOC: 98, batterySOH: null,
                chargeDischargePower: -352, batteryTemperature: 22.0, batteryCycleTimes: 13,
                batteryRemainings: 18.0, totalDeviceCharge: 246.2, totalDeviceDischarge: 222.2
            }]);
        });

        await handler();

        const putCall = findPutCall();
        expect(putCall.input.Item.batteryTemperature).toBe(22.0);
        expect(putCall.input.Item.batterySOH).toBeUndefined();
    });

    // Feeds the dashboard's Current PV Status panel — live instantaneous power
    // and inverter temperature, distinct from the daily/total yield counters.
    test('maps the inverter reading\'s MPPTTotalInputPower and inverterTemperature fields', async () => {
        mockGetDeviceRealtimeData.mockImplementation((baseUrl, token, params) => {
            if (params.deviceType === 1) {
                return Promise.resolve([{
                    deviceSn: 'H34ABCDEFG5001', dataTime: '2026-07-31T04:45:00.000+00:00',
                    deviceStatus: 102, dailyYield: 22.7, totalYield: 444.9, dailyACOutput: 22.2,
                    totalACOutput: 520.6, gridPower: 0, todayImportEnergy: 28.8, totalImportEnergy: 403.94,
                    todayExportEnergy: 0.1, totalExportEnergy: 80.7, totalActivePower: null,
                    MPPTTotalInputPower: 2410, inverterTemperature: 38.5
                }]);
            }
            return Promise.resolve(null);
        });

        await handler();

        const putCall = findPutCall();
        expect(putCall.input.Item.MPPTTotalInputPower).toBe(2410);
        expect(putCall.input.Item.inverterTemperature).toBe(38.5);
    });
});
