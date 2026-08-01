'use strict';

const { startOfLocalDay } = require('../lambda/Utilities/tariff');

const mockSsmSend = jest.fn();
const mockSnsSend = jest.fn();
const mockDynamoSend = jest.fn();
const mockGetAccessToken = jest.fn();
const mockSetInverterSocTargetMode = jest.fn();
const mockExitVppMode = jest.fn();

// These only live in lambda/GridDischargeFunction/node_modules (per-function
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

jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn().mockImplementation(() => ({ send: (...args) => mockDynamoSend(...args) })) },
    PutCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Put' })),
    GetCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Get' })),
    QueryCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Query' }))
}), { virtual: true });

jest.mock('powerplant-shared', () => {
    const { startOfLocalDay: realStartOfLocalDay } = require('../lambda/Utilities/tariff');
    return {
        logInfo: jest.fn(),
        logError: jest.fn(),
        BUSINESS_TYPE: { RESIDENTIAL: 1 },
        getAccessToken: (...args) => mockGetAccessToken(...args),
        setInverterSocTargetMode: (...args) => mockSetInverterSocTargetMode(...args),
        exitVppMode: (...args) => mockExitVppMode(...args),
        startOfLocalDay: realStartOfLocalDay
    };
}, { virtual: true });

const BASE_CONFIG = {
    dryRun: true,
    enabled: true,
    windowStartTime: '17:00',
    windowEndTime: '21:00',
    peakFeedInRate: 0.27,
    safetyMarginPercent: 10,
    maxDischargePowerW: 3000,
    minSurplusPercent: 5,
    historyLookbackDays: 14,
    minHistoryDaysRequired: 3,
    fallbackReservePercent: 20,
    assumedUsableCapacityKwh: 10,
    minSoc: 10
};

function defaultDynamoImpl(command) {
    if (command.__type === 'Query') return Promise.resolve({ Items: [] });
    return Promise.resolve({});
}

describe('GridDischargeFunction', () => {
    let parseTimeToHours, historicalShoulderNightReserves, estimateUsableCapacityKwh,
        computeDischargePlan, shouldExitEarly, resolveEffectiveSettings, buildStatusRecord,
        STATUS_RECORD_PREFIX, SETTINGS_PREFIX, handler;

    function findPutCall() {
        return mockDynamoSend.mock.calls.map(call => call[0]).find(cmd => cmd.__type === 'Put');
    }

    beforeEach(() => {
        jest.resetModules();
        mockSsmSend.mockReset();
        mockSnsSend.mockReset().mockResolvedValue({});
        mockDynamoSend.mockReset().mockImplementation(defaultDynamoImpl);
        mockGetAccessToken.mockReset();
        mockSetInverterSocTargetMode.mockReset();
        mockExitVppMode.mockReset();

        process.env.SOLAX_CLIENT_ID_PARAM = '/powerplant/solax/client-id';
        process.env.SOLAX_CLIENT_SECRET_PARAM = '/powerplant/solax/client-secret';
        process.env.SOLAX_BASE_URL = 'https://openapi-eu.solaxcloud.com';
        process.env.SOLAX_BUSINESS_TYPE = '1';
        process.env.SOLAX_INVERTER_SN = 'H34ABCDEFG5001';
        process.env.ENERGY_READINGS_TABLE = 'POWERPLANT-ENERGY-READINGS';
        process.env.REPORTS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:reports';
        process.env.ALERTS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:alerts';
        process.env.TARIFF_STRUCTURE = JSON.stringify({ timezone: 'UTC' });
        process.env.GRID_DISCHARGE_CONFIG = JSON.stringify(BASE_CONFIG);

        ({
            parseTimeToHours, historicalShoulderNightReserves, estimateUsableCapacityKwh,
            computeDischargePlan, shouldExitEarly, resolveEffectiveSettings, buildStatusRecord,
            STATUS_RECORD_PREFIX, SETTINGS_PREFIX, handler
        } = require('../lambda/GridDischargeFunction/GridDischargeFunction'));
    });

    describe('parseTimeToHours', () => {
        test.each([
            ['17:00', 17],
            ['21:00', 21],
            ['09:30', 9.5],
            ['00:00', 0]
        ])('parses %s as %p hours', (hhmm, expected) => {
            expect(parseTimeToHours(hhmm)).toBe(expected);
        });
    });

    describe('estimateUsableCapacityKwh', () => {
        test('derives usable capacity from a real batteryRemainings/batterySOC pair', () => {
            const kwh = estimateUsableCapacityKwh({ batteryRemainings: 18.2, batterySOC: 99 }, 10);
            expect(kwh).toBeCloseTo(18.38, 1);
        });

        test('falls back to the configured constant when batteryRemainings is missing', () => {
            expect(estimateUsableCapacityKwh({ batterySOC: 50 }, 12)).toBe(12);
        });

        test('falls back when batterySOC is 0 (would divide by zero)', () => {
            expect(estimateUsableCapacityKwh({ batteryRemainings: 0, batterySOC: 0 }, 12)).toBe(12);
        });
    });

    describe('computeDischargePlan', () => {
        const baseArgs = {
            currentSocPercent: 57, minSocPercent: 10, safetyMarginPercent: 10,
            minHistoryDaysRequired: 3, fallbackReservePercent: 20,
            usableCapacityKwh: 18.4, windowDurationHours: 4, maxDischargePowerW: 3000, minSurplusPercent: 5
        };

        test('uses the worst (max) historical shoulder-night reserve when enough history exists', () => {
            const plan = computeDischargePlan({ ...baseArgs, shoulderNightReserves: [10, 15, 8] });
            expect(plan.usingFallback).toBe(false);
            expect(plan.shoulderNightReservePercent).toBe(15);
            expect(plan.targetFloorSocPercent).toBe(10 + 15 + 10); // minSoc + reserve + safety margin = 35
            expect(plan.shouldDischarge).toBe(true);
        });

        test('falls back to the configured reserve when fewer than minHistoryDaysRequired days are available', () => {
            const plan = computeDischargePlan({ ...baseArgs, shoulderNightReserves: [10] });
            expect(plan.usingFallback).toBe(true);
            expect(plan.shoulderNightReservePercent).toBe(20); // fallbackReservePercent
            expect(plan.targetFloorSocPercent).toBe(10 + 20 + 10); // 40
        });

        test('recommends no discharge when surplus is below minSurplusPercent', () => {
            const plan = computeDischargePlan({
                ...baseArgs, currentSocPercent: 42, shoulderNightReserves: [10, 15, 8] // floor=35, surplus=7... still discharges
            });
            expect(plan.shouldDischarge).toBe(true);

            const noSurplusPlan = computeDischargePlan({
                ...baseArgs, currentSocPercent: 38, shoulderNightReserves: [10, 15, 8] // floor=35, surplus=3 < minSurplusPercent(5)
            });
            expect(noSurplusPlan.shouldDischarge).toBe(false);
            expect(noSurplusPlan.dischargePowerW).toBe(0);
        });

        test('never recommends discharging below the target floor even when SOC is already under it', () => {
            const plan = computeDischargePlan({ ...baseArgs, currentSocPercent: 20, shoulderNightReserves: [10, 15, 8] });
            expect(plan.surplusPercent).toBe(0);
            expect(plan.shouldDischarge).toBe(false);
        });

        test('clamps discharge power to maxDischargePowerW', () => {
            const plan = computeDischargePlan({
                ...baseArgs, currentSocPercent: 100, shoulderNightReserves: [0],
                minHistoryDaysRequired: 1, maxDischargePowerW: 500, windowDurationHours: 1
            });
            expect(plan.dischargePowerW).toBe(500);
        });

        test('caps the target floor at 100%', () => {
            const plan = computeDischargePlan({
                ...baseArgs, minSocPercent: 60, safetyMarginPercent: 30, shoulderNightReserves: [50, 60],
                minHistoryDaysRequired: 1
            });
            expect(plan.targetFloorSocPercent).toBe(100);
        });
    });

    describe('buildStatusRecord', () => {
        test('prefixes DeviceSn with STATUS_RECORD_PREFIX so it cannot collide with a real device serial', () => {
            const record = buildStatusRecord('H34ABCDEFG5001', 1785400000, {
                phase: 'start', enabled: true, dryRun: true, applied: false,
                targetSocPercent: 35, currentSocPercent: 57, surplusPercent: 22, surplusKwh: 4.0,
                dischargePowerW: 1000, usingFallback: false, reasoning: 'test'
            });

            expect(record.DeviceSn).toBe(`${STATUS_RECORD_PREFIX}H34ABCDEFG5001`);
            expect(record.Timestamp).toBe(1785400000);
            expect(record.phase).toBe('start');
            expect(record.targetSocPercent).toBe(35);
        });

        test('defaults optional numeric fields to null when omitted', () => {
            const record = buildStatusRecord('sn', 1, { phase: 'exit', enabled: true, dryRun: true, applied: false, reasoning: 'x' });
            expect(record.targetSocPercent).toBeNull();
            expect(record.currentSocPercent).toBeNull();
            expect(record.usingFallback).toBeNull();
        });
    });

    describe('shouldExitEarly', () => {
        test('recommends exiting early when any import has occurred since the window opened', () => {
            const decision = shouldExitEarly({ importSinceStartKwh: 0.3, currentSocPercent: 50, targetSocPercent: 35 });
            expect(decision.exitEarly).toBe(true);
            expect(decision.reason).toMatch(/Grid import detected/);
        });

        test('recommends exiting early when SOC has already reached the target', () => {
            const decision = shouldExitEarly({ importSinceStartKwh: 0, currentSocPercent: 35, targetSocPercent: 35 });
            expect(decision.exitEarly).toBe(true);
            expect(decision.reason).toMatch(/already reached the target/);
        });

        test('recommends exiting early when SOC has overshot below the target', () => {
            const decision = shouldExitEarly({ importSinceStartKwh: 0, currentSocPercent: 30, targetSocPercent: 35 });
            expect(decision.exitEarly).toBe(true);
        });

        test('does not recommend exiting when on track — no import, SOC still above target', () => {
            const decision = shouldExitEarly({ importSinceStartKwh: 0, currentSocPercent: 50, targetSocPercent: 35 });
            expect(decision.exitEarly).toBe(false);
            expect(decision.reason).toBeNull();
        });

        test('a small over-discharge below target without import is still treated the same as reaching it (accepted per design)', () => {
            // Explicitly tolerates ending up somewhat below the target rather than
            // treating it as a distinct failure case — see docs/grid-discharge-logic.md.
            const decision = shouldExitEarly({ importSinceStartKwh: 0, currentSocPercent: 28, targetSocPercent: 35 });
            expect(decision.exitEarly).toBe(true);
            expect(decision.reason).toMatch(/already reached the target/);
        });
    });

    describe('resolveEffectiveSettings', () => {
        test('falls back to config defaults when there is no saved override', () => {
            const effective = resolveEffectiveSettings(BASE_CONFIG, null);
            expect(effective).toEqual({
                fallbackReservePercent: BASE_CONFIG.fallbackReservePercent,
                safetyMarginPercent: BASE_CONFIG.safetyMarginPercent
            });
        });

        test('uses the override values when present', () => {
            const effective = resolveEffectiveSettings(BASE_CONFIG, { fallbackReservePercent: 30, safetyMarginPercent: 15 });
            expect(effective).toEqual({ fallbackReservePercent: 30, safetyMarginPercent: 15 });
        });

        test('merges a partial override with config defaults for the untouched field', () => {
            const effective = resolveEffectiveSettings(BASE_CONFIG, { fallbackReservePercent: 30 });
            expect(effective).toEqual({
                fallbackReservePercent: 30,
                safetyMarginPercent: BASE_CONFIG.safetyMarginPercent
            });
        });
    });

    describe('historicalShoulderNightReserves', () => {
        test('queries each night\'s shoulder-window and returns the SOC drop per available night', async () => {
            // "now" = 2026-07-31 12:00 UTC. daysAgo=1 -> shoulder window 2026-07-30 21:00-24:00.
            // daysAgo=2 -> shoulder window 2026-07-29 21:00-24:00.
            const nowSeconds = Math.floor(Date.UTC(2026, 6, 31, 12, 0, 0) / 1000);
            const day1Start = Math.floor(Date.UTC(2026, 6, 30, 21, 0, 0) / 1000);
            const day2Start = Math.floor(Date.UTC(2026, 6, 29, 21, 0, 0) / 1000);

            mockDynamoSend.mockImplementation(command => {
                const start = command.input.ExpressionAttributeValues[':start'];
                if (start === day1Start) return Promise.resolve({ Items: [{ batterySOC: 60 }, { batterySOC: 50 }] });
                if (start === day2Start) return Promise.resolve({ Items: [{ batterySOC: 55 }, { batterySOC: 40 }] });
                return Promise.resolve({ Items: [] });
            });

            const reserves = await historicalShoulderNightReserves('H34ABCDEFG5001', 'UTC', '21:00', 2, nowSeconds);

            expect(reserves).toEqual([10, 15]);
        });

        test('skips nights with fewer than 2 readings or missing batterySOC', async () => {
            const nowSeconds = Math.floor(Date.UTC(2026, 6, 31, 12, 0, 0) / 1000);
            mockDynamoSend.mockResolvedValue({ Items: [{ batterySOC: 50 }] }); // only 1 reading every night

            const reserves = await historicalShoulderNightReserves('H34ABCDEFG5001', 'UTC', '21:00', 3, nowSeconds);

            expect(reserves).toEqual([]);
        });

        test('clamps a SOC increase during the window (charging, not discharging) to 0 rather than negative', async () => {
            const nowSeconds = Math.floor(Date.UTC(2026, 6, 31, 12, 0, 0) / 1000);
            mockDynamoSend.mockResolvedValue({ Items: [{ batterySOC: 40 }, { batterySOC: 45 }] });

            const reserves = await historicalShoulderNightReserves('H34ABCDEFG5001', 'UTC', '21:00', 1, nowSeconds);

            expect(reserves).toEqual([0]);
        });
    });

    describe('handler — start phase', () => {
        test('skips entirely and stores a disabled record when config.enabled is false', async () => {
            process.env.GRID_DISCHARGE_CONFIG = JSON.stringify({ ...BASE_CONFIG, enabled: false });
            ({ handler } = require('../lambda/GridDischargeFunction/GridDischargeFunction'));

            const result = await handler({ phase: 'start' });

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSocTargetMode).not.toHaveBeenCalled();
            expect(mockSnsSend).not.toHaveBeenCalled();

            const putCall = findPutCall();
            expect(putCall.input.Item.enabled).toBe(false);
            expect(putCall.input.Item.phase).toBe('start');
        });

        test('skips when no recent battery SOC reading is available', async () => {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Query') return Promise.resolve({ Items: [] });
                return Promise.resolve({});
            });

            const result = await handler({ phase: 'start' });

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSocTargetMode).not.toHaveBeenCalled();
            const putCall = findPutCall();
            expect(putCall.input.Item.reasoning).toMatch(/No recent battery SOC reading/);
        });

        test('publishes "no surplus" and skips SolaX when current SOC is at or below the target floor', async () => {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type !== 'Query') return Promise.resolve({});
                // recent-reading query (last 15 min) vs shoulder-night history queries —
                // distinguish by requested range width.
                const { ':start': start, ':end': end } = command.input.ExpressionAttributeValues;
                if (end - start <= 900) return Promise.resolve({ Items: [{ batterySOC: 30 }] });
                return Promise.resolve({ Items: [] }); // no shoulder-night history -> fallback reserve (20%)
            });

            const result = await handler({ phase: 'start' });

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSocTargetMode).not.toHaveBeenCalled();
            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('no surplus');
        });

        test('dry run: computes a plan, emails, stores a record, and never calls SolaX', async () => {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type !== 'Query') return Promise.resolve({});
                const { ':start': start, ':end': end } = command.input.ExpressionAttributeValues;
                if (end - start <= 900) return Promise.resolve({ Items: [{ batterySOC: 80, batteryRemainings: 14.7 }] });
                return Promise.resolve({ Items: [] }); // fallback reserve used
            });

            const result = await handler({ phase: 'start' });

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSocTargetMode).not.toHaveBeenCalled();

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('DRY RUN');

            const putCall = findPutCall();
            expect(putCall.input.Item.dryRun).toBe(true);
            expect(putCall.input.Item.applied).toBe(false);
            expect(putCall.input.Item.currentSocPercent).toBe(80);
            expect(putCall.input.Item.usingFallback).toBe(true);
        });

        test('live: calls setInverterSocTargetMode with a negative (discharge) power and the computed target', async () => {
            process.env.GRID_DISCHARGE_CONFIG = JSON.stringify({ ...BASE_CONFIG, dryRun: false });
            mockDynamoSend.mockImplementation(command => {
                if (command.__type !== 'Query') return Promise.resolve({});
                const { ':start': start, ':end': end } = command.input.ExpressionAttributeValues;
                if (end - start <= 900) return Promise.resolve({ Items: [{ batterySOC: 90, batteryRemainings: 16.5 }] });
                return Promise.resolve({ Items: [] });
            });
            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockSetInverterSocTargetMode.mockResolvedValue({ 'H34ABCDEFG5001': { status: 4 } });
            ({ handler } = require('../lambda/GridDischargeFunction/GridDischargeFunction'));

            const result = await handler({ phase: 'start' });

            expect(result.statusCode).toBe(200);
            expect(mockSetInverterSocTargetMode).toHaveBeenCalledTimes(1);
            const [, , request] = mockSetInverterSocTargetMode.mock.calls[0];
            expect(request.snList).toBe('H34ABCDEFG5001');
            expect(request.chargeDischargPower).toBeLessThan(0); // negative = discharge
            expect(request.targetSoc).toBe(40); // minSoc(10) + fallbackReserve(20) + safetyMargin(10)

            const putCall = findPutCall();
            expect(putCall.input.Item.applied).toBe(true);
            expect(putCall.input.Item.dryRun).toBe(false);
        });

        test('uses a saved settings override for fallbackReservePercent/safetyMarginPercent instead of the config default', async () => {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') {
                    return Promise.resolve({ Item: { fallbackReservePercent: 30, safetyMarginPercent: 15 } });
                }
                if (command.__type !== 'Query') return Promise.resolve({});
                const { ':start': start, ':end': end } = command.input.ExpressionAttributeValues;
                if (end - start <= 900) return Promise.resolve({ Items: [{ batterySOC: 90, batteryRemainings: 16.5 }] });
                return Promise.resolve({ Items: [] }); // no shoulder-night history -> fallback reserve used
            });

            await handler({ phase: 'start' });

            const putCall = findPutCall();
            expect(putCall.input.Item.targetSocPercent).toBe(55); // minSoc(10) + override fallback(30) + override safety margin(15)
        });
    });

    describe('handler — exit phase', () => {
        test('skips entirely when config.enabled is false', async () => {
            process.env.GRID_DISCHARGE_CONFIG = JSON.stringify({ ...BASE_CONFIG, enabled: false });
            ({ handler } = require('../lambda/GridDischargeFunction/GridDischargeFunction'));

            const result = await handler({ phase: 'exit' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
        });

        test('dry run: never calls exitVppMode', async () => {
            const result = await handler({ phase: 'exit' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
            const putCall = findPutCall();
            expect(putCall.input.Item.phase).toBe('exit');
            expect(putCall.input.Item.dryRun).toBe(true);
        });

        test('live: calls exitVppMode to hand control back to Self Use', async () => {
            process.env.GRID_DISCHARGE_CONFIG = JSON.stringify({ ...BASE_CONFIG, dryRun: false });
            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockExitVppMode.mockResolvedValue({ 'H34ABCDEFG5001': { status: 4 } });
            ({ handler } = require('../lambda/GridDischargeFunction/GridDischargeFunction'));

            const result = await handler({ phase: 'exit' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).toHaveBeenCalledWith(
                process.env.SOLAX_BASE_URL, 'access-token',
                { snList: 'H34ABCDEFG5001', businessType: 1 }
            );

            const putCall = findPutCall();
            expect(putCall.input.Item.applied).toBe(true);
        });
    });

    describe('handler — check phase', () => {
        const appliedStartRecord = {
            DeviceSn: 'GRID_DISCHARGE#H34ABCDEFG5001', Timestamp: 1785400000, phase: 'start',
            enabled: true, dryRun: true, applied: true, targetSocPercent: 35, currentSocPercent: 57,
            surplusPercent: 22, surplusKwh: 4.0, dischargePowerW: 1000, usingFallback: false, reasoning: 'x'
        };

        function mockStatusRecordAnd(windowReadings) {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type !== 'Query') return Promise.resolve({});
                if (command.input.KeyConditionExpression === 'DeviceSn = :sn') {
                    return Promise.resolve({ Items: [appliedStartRecord] });
                }
                return Promise.resolve({ Items: windowReadings });
            });
        }

        test('skips entirely when config.enabled is false', async () => {
            process.env.GRID_DISCHARGE_CONFIG = JSON.stringify({ ...BASE_CONFIG, enabled: false });
            ({ handler } = require('../lambda/GridDischargeFunction/GridDischargeFunction'));

            const result = await handler({ phase: 'check' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
            const putCall = findPutCall();
            expect(putCall.input.Item.phase).toBe('check');
            expect(putCall.input.Item.enabled).toBe(false);
        });

        test('skips when no discharge decision exists for today', async () => {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type !== 'Query') return Promise.resolve({});
                return Promise.resolve({ Items: [] });
            });

            const result = await handler({ phase: 'check' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
            const putCall = findPutCall();
            expect(putCall.input.Item.reasoning).toMatch(/No discharge decision found/);
        });

        test('skips when today\'s start phase was not applied (dry run or no surplus)', async () => {
            mockDynamoSend.mockImplementation(command => {
                if (command.__type !== 'Query') return Promise.resolve({});
                if (command.input.KeyConditionExpression === 'DeviceSn = :sn') {
                    return Promise.resolve({ Items: [{ ...appliedStartRecord, applied: false }] });
                }
                return Promise.resolve({ Items: [] });
            });

            const result = await handler({ phase: 'check' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
            const putCall = findPutCall();
            expect(putCall.input.Item.reasoning).toMatch(/not applied/);
        });

        test('does nothing when on track — no import, SOC still above target', async () => {
            mockStatusRecordAnd([
                { totalImportEnergy: 400, batterySOC: 55 },
                { totalImportEnergy: 400, batterySOC: 45 }
            ]);

            const result = await handler({ phase: 'check' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
            expect(mockSnsSend).not.toHaveBeenCalled();
            const putCall = findPutCall();
            expect(putCall.input.Item.reasoning).toMatch(/On track/);
        });

        test('dry run: detects import since window start and would exit early without calling SolaX', async () => {
            mockStatusRecordAnd([
                { totalImportEnergy: 400.0, batterySOC: 50 },
                { totalImportEnergy: 400.5, batterySOC: 45 }
            ]);

            const result = await handler({ phase: 'check' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).not.toHaveBeenCalled();
            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('DRY RUN early exit');
            const putCall = findPutCall();
            expect(putCall.input.Item.dryRun).toBe(true);
            expect(putCall.input.Item.applied).toBe(false);
        });

        test('live: detects import since window start and calls exitVppMode', async () => {
            process.env.GRID_DISCHARGE_CONFIG = JSON.stringify({ ...BASE_CONFIG, dryRun: false });
            mockStatusRecordAnd([
                { totalImportEnergy: 400.0, batterySOC: 50 },
                { totalImportEnergy: 400.5, batterySOC: 45 }
            ]);
            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockExitVppMode.mockResolvedValue({ 'H34ABCDEFG5001': { status: 4 } });
            ({ handler } = require('../lambda/GridDischargeFunction/GridDischargeFunction'));

            const result = await handler({ phase: 'check' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).toHaveBeenCalledTimes(1);
            const putCall = findPutCall();
            expect(putCall.input.Item.applied).toBe(true);
            expect(putCall.input.Item.reasoning).toMatch(/Grid import detected/);
        });

        test('live: exits early when SOC has already reached the target, even without import', async () => {
            process.env.GRID_DISCHARGE_CONFIG = JSON.stringify({ ...BASE_CONFIG, dryRun: false });
            mockStatusRecordAnd([
                { totalImportEnergy: 400, batterySOC: 50 },
                { totalImportEnergy: 400, batterySOC: 35 } // == targetSocPercent (35) on appliedStartRecord
            ]);
            mockSsmSend.mockResolvedValue({ Parameter: { Value: 'secret-value' } });
            mockGetAccessToken.mockResolvedValue('access-token');
            mockExitVppMode.mockResolvedValue({ 'H34ABCDEFG5001': { status: 4 } });
            ({ handler } = require('../lambda/GridDischargeFunction/GridDischargeFunction'));

            const result = await handler({ phase: 'check' });

            expect(result.statusCode).toBe(200);
            expect(mockExitVppMode).toHaveBeenCalledTimes(1);
            const putCall = findPutCall();
            expect(putCall.input.Item.reasoning).toMatch(/already reached the target/);
        });
    });

    describe('handler — failure', () => {
        test('publishes to the alerts topic and rethrows when the start phase fails', async () => {
            mockDynamoSend.mockImplementation(() => Promise.reject(new Error('DynamoDB unavailable')));

            await expect(handler({ phase: 'start' })).rejects.toThrow('DynamoDB unavailable');

            const alertCall = mockSnsSend.mock.calls.find(call => call[0].input.TopicArn === process.env.ALERTS_TOPIC_ARN);
            expect(alertCall).toBeDefined();
            expect(alertCall[0].input.Subject).toContain('FAILED');
        });
    });
});
