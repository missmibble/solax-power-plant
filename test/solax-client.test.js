'use strict';

function jsonResponse(body) {
    return { json: async () => body };
}

describe('solax-client', () => {
    const baseUrl = 'https://openapi-eu.solaxcloud.com';
    let BUSINESS_TYPE, DEVICE_TYPE, getAccessToken, getDeviceRealtimeData, getAlarmInfo, setInverterSelfUseMode;

    beforeEach(() => {
        global.fetch = jest.fn();
        // fresh module instance per test — getAccessToken caches the token at module scope,
        // and each test should start from an empty cache.
        jest.resetModules();
        ({
            BUSINESS_TYPE, DEVICE_TYPE, getAccessToken, getDeviceRealtimeData, getAlarmInfo, setInverterSelfUseMode
        } = require('../lambda/Utilities/solax-client'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('getAccessToken', () => {
        test('exchanges client credentials for a bearer token via form-encoded POST', async () => {
            global.fetch.mockResolvedValue(jsonResponse({
                code: 0,
                result: { access_token: 'token-abc', expires_in: 2591999 }
            }));

            const token = await getAccessToken({ baseUrl, clientId: 'id', clientSecret: 'secret' });

            expect(token).toBe('token-abc');
            const [url, options] = global.fetch.mock.calls[0];
            expect(url).toBe(`${baseUrl}/openapi/auth/oauth/token`);
            expect(options.method).toBe('POST');
            expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
            expect(options.body.toString()).toContain('client_id=id');
            expect(options.body.toString()).toContain('grant_type=client_credentials');
        });

        test('caches the token across calls until it nears expiry', async () => {
            global.fetch.mockResolvedValue(jsonResponse({
                code: 0,
                result: { access_token: 'token-abc', expires_in: 2591999 }
            }));

            await getAccessToken({ baseUrl, clientId: 'id', clientSecret: 'secret' });
            await getAccessToken({ baseUrl, clientId: 'id', clientSecret: 'secret' });

            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        test('throws when the auth endpoint returns a non-success code', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ code: 4001, message: 'invalid client' }));

            await expect(
                getAccessToken({ baseUrl, clientId: 'bad', clientSecret: 'bad' })
            ).rejects.toThrow(/invalid client/);
        });
    });

    describe('getDeviceRealtimeData', () => {
        test('calls the realtime_data endpoint with a bearer header and joined snList', async () => {
            global.fetch.mockResolvedValue(jsonResponse({
                code: 10000,
                result: [{ deviceSn: 'H34ABCDEFG5001', dailyYield: 12.3 }]
            }));

            const result = await getDeviceRealtimeData(baseUrl, 'my-token', {
                snList: ['H34ABCDEFG5001'],
                deviceType: DEVICE_TYPE.INVERTER,
                businessType: BUSINESS_TYPE.RESIDENTIAL
            });

            expect(result).toEqual([{ deviceSn: 'H34ABCDEFG5001', dailyYield: 12.3 }]);

            const [url, options] = global.fetch.mock.calls[0];
            expect(url.toString()).toContain('/openapi/v2/device/realtime_data');
            expect(url.toString()).toContain('snList=H34ABCDEFG5001');
            expect(url.toString()).toContain('deviceType=1');
            expect(url.toString()).toContain('businessType=1');
            expect(options.headers.Authorization).toBe('bearer my-token');
        });

        test('throws with the requestId when the API returns an error code', async () => {
            global.fetch.mockResolvedValue(jsonResponse({
                code: 4004,
                message: 'device not found',
                requestId: 'req-123'
            }));

            await expect(
                getDeviceRealtimeData(baseUrl, 'my-token', {
                    snList: 'unknown-sn',
                    deviceType: DEVICE_TYPE.INVERTER,
                    businessType: BUSINESS_TYPE.RESIDENTIAL
                })
            ).rejects.toThrow(/req-123/);
        });
    });

    describe('getAlarmInfo', () => {
        test('omits undefined query params rather than sending them as "undefined"', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ code: 10000, result: [] }));

            await getAlarmInfo(baseUrl, 'my-token', {
                plantId: 'plant-1',
                alarmState: 1,
                businessType: BUSINESS_TYPE.RESIDENTIAL
            });

            const [url] = global.fetch.mock.calls[0];
            expect(url.toString()).not.toContain('deviceSn=');
            expect(url.toString()).not.toContain('pageNo=');
            expect(url.toString()).toContain('plantId=plant-1');
        });
    });

    describe('setInverterSelfUseMode', () => {
        test('POSTs a full self-use-mode body (not a partial patch) to batch_set_spontaneity_self_use', async () => {
            global.fetch.mockResolvedValue(jsonResponse({
                code: 0,
                result: { 'H34ABCDEFG5001': { status: 0 } },
                requestId: 'req-456'
            }));

            const result = await setInverterSelfUseMode(baseUrl, 'my-token', {
                snList: 'H34ABCDEFG5001',
                businessType: BUSINESS_TYPE.RESIDENTIAL,
                minSoc: 10,
                chargeFromGridEnable: 1,
                chargeUpperSoc: 40,
                chargeStartTimePeriod1: '00:00',
                chargeEndTimePeriod1: '06:00',
                chargeStartTimePeriod2: '00:00',
                chargeEndTimePeriod2: '00:00',
                dischargeStartTimePeriod1: '00:00',
                dischargeEndTimePeriod1: '23:59',
                dischargeStartTimePeriod2: '00:00',
                dischargeEndTimePeriod2: '00:00',
                enableTimePeriod2: 0
            });

            expect(result).toEqual({ 'H34ABCDEFG5001': { status: 0 } });

            const [url, options] = global.fetch.mock.calls[0];
            expect(url.toString()).toContain('/openapi/v2/device/inverter_work_mode/batch_set_spontaneity_self_use');
            expect(options.method).toBe('POST');
            expect(options.headers.Authorization).toBe('bearer my-token');

            const body = JSON.parse(options.body);
            expect(body.snList).toEqual(['H34ABCDEFG5001']);
            expect(body.chargeUpperSoc).toBe(40);
            expect(body.minSoc).toBe(10);
            expect(body.chargeFromGridEnable).toBe(1);
            expect(body.chargeStartTimePeriod1).toBe('00:00');
            expect(body.chargeEndTimePeriod1).toBe('06:00');
            expect(body.dischargeStartTimePeriod1).toBe('00:00');
            expect(body.dischargeEndTimePeriod1).toBe('23:59');
            expect(body.enableTimePeriod2).toBe(0);
        });

        test('wraps a single snList string in an array for the JSON body', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ code: 0, result: {}, requestId: 'req-789' }));

            await setInverterSelfUseMode(baseUrl, 'my-token', {
                snList: 'H34ABCDEFG5001',
                businessType: BUSINESS_TYPE.RESIDENTIAL,
                minSoc: 10,
                chargeFromGridEnable: 1,
                chargeUpperSoc: 100
            });

            const [, options] = global.fetch.mock.calls[0];
            expect(JSON.parse(options.body).snList).toEqual(['H34ABCDEFG5001']);
        });
    });

});
