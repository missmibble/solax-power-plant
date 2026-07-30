'use strict';

const fs = require('fs');
const path = require('path');
const { findImportRateWindow, importCostForWindow, exportCredit, localDateString } = require('../lambda/Utilities/tariff');

const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'dev-powerplant.json'), 'utf8')
);
// Timezone lives with the site location (config.location), not duplicated in
// config.tariff — see lib/lambda-functions-stack.js's tariffStructure.
config.tariff.timezone = config.location.timezone;

// 2026-07-30 is Australian winter — no DST — so Australia/Sydney is a fixed
// UTC+10 for every timestamp below, making local-time arithmetic predictable.
function utcSeconds(hour, minute) {
    return Math.floor(Date.UTC(2026, 6, 30, hour - 10, minute) / 1000);
}

describe('tariff', () => {
    const tariff = config.tariff;

    describe('findImportRateWindow', () => {
        test.each([
            ['00:00', 'night-ev-charge'],
            ['05:59', 'night-ev-charge'],
            ['06:00', 'shoulder-morning'],
            ['08:59', 'shoulder-morning'],
            ['09:00', 'offpeak-midday'],
            ['15:59', 'offpeak-midday'],
            ['16:00', 'peak-evening'],
            ['20:59', 'peak-evening'],
            ['21:00', 'shoulder-night'],
            ['23:59', 'shoulder-night']
        ])('%s local time falls in the %s window', (localTime, expectedLabel) => {
            const [hour, minute] = localTime.split(':').map(Number);
            const window = findImportRateWindow(tariff, utcSeconds(hour, minute));
            expect(window.label).toBe(expectedLabel);
        });
    });

    describe('importCostForWindow', () => {
        test('prices import at the night-ev-charge rate overnight', () => {
            const { cost, window, rate } = importCostForWindow(tariff, utcSeconds(2, 0), 10);
            expect(window).toBe('night-ev-charge');
            expect(rate).toBe(0.08);
            expect(cost).toBeCloseTo(0.8);
        });

        test('prices import at the peak rate in the evening', () => {
            const { cost, window, rate } = importCostForWindow(tariff, utcSeconds(18, 0), 2);
            expect(window).toBe('peak-evening');
            expect(rate).toBe(0.41756);
            expect(cost).toBeCloseTo(0.83512);
        });
    });

    describe('exportCredit', () => {
        test('applies the flat feed-in rate regardless of time', () => {
            expect(exportCredit(tariff, 5)).toBeCloseTo(5 * 0.02);
        });

        test('returns 0 when feedInRate is missing', () => {
            expect(exportCredit({ importRates: [] }, 5)).toBe(0);
        });
    });

    describe('localDateString', () => {
        test('renders a sortable YYYY-MM-DD in the tariff timezone', () => {
            expect(localDateString(utcSeconds(23, 30), tariff.timezone)).toBe('2026-07-30');
        });

        test('rolls over to the next local day just after midnight', () => {
            // utcSeconds(24, 5) is 00:05 local on 2026-07-31
            expect(localDateString(utcSeconds(24, 5), tariff.timezone)).toBe('2026-07-31');
        });
    });
});
