'use strict';

const mockSnsSend = jest.fn().mockResolvedValue({});

// These packages only live in lambda/AlertFunction/node_modules (per-function
// deps), not the root node_modules test/ resolves from — virtual: true skips
// module resolution instead of erroring.
jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: jest.fn().mockImplementation(() => ({ send: mockSnsSend })),
    PublishCommand: jest.fn().mockImplementation(input => input)
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({}))
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn().mockImplementation(() => ({ send: jest.fn() })) },
    QueryCommand: jest.fn().mockImplementation(input => input)
}), { virtual: true });

jest.mock('@aws-sdk/util-dynamodb', () => ({
    unmarshall: jest.fn(image => image)
}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { checkImportAnomaly, checkInverterFault } = require('../lambda/AlertFunction/AlertFunction');

const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'dev-powerplant.json'), 'utf8')
);
// Timezone lives with the site location (config.location), not duplicated in
// config.tariff — see lib/lambda-functions-stack.js's tariffStructure.
config.tariff.timezone = config.location.timezone;

// 2026-07-30 is Australian winter — no DST — so Australia/Sydney is a fixed
// UTC+10 for every timestamp below.
function utcSeconds(hour, minute) {
    return Math.floor(Date.UTC(2026, 6, 30, hour - 10, minute) / 1000);
}

describe('AlertFunction', () => {
    beforeEach(() => {
        mockSnsSend.mockClear();
    });

    describe('checkImportAnomaly', () => {
        test('publishes when import spikes outside the overnight charge window', async () => {
            const previous = { totalImportEnergy: 50, Timestamp: utcSeconds(18, 0) };
            const reading = { DeviceSn: 'TEST-SN', totalImportEnergy: 51, Timestamp: utcSeconds(18, 5) };

            const message = await checkImportAnomaly(reading, previous, config.tariff);

            expect(message).toContain('Grid import spiked');
            expect(message).toContain('peak evening');
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
        });

        test('does not alert for the same size spike overnight (expected charging)', async () => {
            const previous = { totalImportEnergy: 50, Timestamp: utcSeconds(2, 0) };
            const reading = { DeviceSn: 'TEST-SN', totalImportEnergy: 51, Timestamp: utcSeconds(2, 5) };

            const message = await checkImportAnomaly(reading, previous, config.tariff);

            expect(message).toBeNull();
            expect(mockSnsSend).not.toHaveBeenCalled();
        });

        test('does not alert when the delta is below the threshold', async () => {
            const previous = { totalImportEnergy: 50, Timestamp: utcSeconds(18, 0) };
            const reading = { DeviceSn: 'TEST-SN', totalImportEnergy: 50.1, Timestamp: utcSeconds(18, 5) };

            const message = await checkImportAnomaly(reading, previous, config.tariff);

            expect(message).toBeNull();
            expect(mockSnsSend).not.toHaveBeenCalled();
        });

        test('does nothing without a previous reading', async () => {
            const reading = { DeviceSn: 'TEST-SN', totalImportEnergy: 51, Timestamp: utcSeconds(18, 5) };

            const message = await checkImportAnomaly(reading, undefined, config.tariff);

            expect(message).toBeNull();
            expect(mockSnsSend).not.toHaveBeenCalled();
        });
    });

    describe('checkInverterFault', () => {
        test('publishes when the inverter enters a recoverable fault (103)', async () => {
            const previous = { deviceStatus: 102 }; // NORMAL
            const reading = { DeviceSn: 'TEST-SN', deviceStatus: 103 }; // FAULT_RECOVERABLE

            const message = await checkInverterFault(reading, previous);

            expect(message).toContain('recoverable');
            expect(message).toContain('Reference code: 103');
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
        });

        test('publishes with permanent severity for a permanent fault (104)', async () => {
            const reading = { DeviceSn: 'TEST-SN', deviceStatus: 104 }; // FAULT_PERMANENT

            const message = await checkInverterFault(reading, undefined);

            expect(message).toContain('permanent');
            expect(message).toContain('needs attention');
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
        });

        test('does not alert for normal operating states', async () => {
            const previous = { deviceStatus: 100 }; // WAITING
            const reading = { DeviceSn: 'TEST-SN', deviceStatus: 102 }; // NORMAL

            const message = await checkInverterFault(reading, previous);

            expect(message).toBeNull();
            expect(mockSnsSend).not.toHaveBeenCalled();
        });

        test('does not re-alert every interval while the same fault persists', async () => {
            const previous = { deviceStatus: 103 };
            const reading = { DeviceSn: 'TEST-SN', deviceStatus: 103 };

            const message = await checkInverterFault(reading, previous);

            expect(message).toBeNull();
            expect(mockSnsSend).not.toHaveBeenCalled();
        });

        test('alerts on a fault even with no previous reading at all', async () => {
            const reading = { DeviceSn: 'TEST-SN', deviceStatus: 103 };

            const message = await checkInverterFault(reading, undefined);

            expect(message).toContain('recoverable');
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
        });
    });
});
