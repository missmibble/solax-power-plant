'use strict';

const mockGetDeviceInfo = jest.fn();
const mockGetDeviceRealtimeData = jest.fn();

// These only live in lambda/PollerFunction/node_modules (per-function deps),
// not the root node_modules test/ resolves from — virtual: true skips module
// resolution instead of erroring.
jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
    GetParameterCommand: jest.fn()
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({}))
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn().mockImplementation(() => ({ send: jest.fn() })) },
    PutCommand: jest.fn()
}), { virtual: true });

jest.mock('powerplant-shared', () => ({
    logInfo: jest.fn(),
    logError: jest.fn(),
    BUSINESS_TYPE: { RESIDENTIAL: 1 },
    DEVICE_TYPE: { INVERTER: 1, BATTERY: 2 },
    getAccessToken: jest.fn(),
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
