'use strict';

const fs = require('fs');
const path = require('path');
const {
    aggregateReadings,
    formatInsightsResponse,
    formatBatteryStatusResponse,
    formatBatterySettingsResponse,
    validateBatterySettings,
    formatSettingsOptimizationResponse,
    formatSettingsOptimizerSettingsResponse,
    validateSettingsOptimizerSettings
} = require('../lambda/DashboardApiFunction/DashboardApiFunction');

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

describe('DashboardApiFunction aggregateReadings', () => {
    const readings = [
        { Timestamp: utcSeconds(5, 0), totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5 },
        // +1.0 kWh import, priced at shoulder-morning (0.32384/kWh)
        { Timestamp: utcSeconds(6, 0), totalYield: 100.5, totalImportEnergy: 51, totalExportEnergy: 5 },
        // +2.0 kWh import (peak-evening, 0.41756/kWh), +1.0 kWh export
        { Timestamp: utcSeconds(18, 0), totalYield: 105, totalImportEnergy: 53, totalExportEnergy: 6 }
    ];

    test('computes PV yield, import, and export as deltas across the range', () => {
        const rollup = aggregateReadings(readings, config.tariff);

        expect(rollup.readingCount).toBe(3);
        expect(rollup.pvYieldKwh).toBe(5);
        expect(rollup.importKwh).toBe(3);
        expect(rollup.exportKwh).toBe(1);
    });

    test('prices each interval at the tariff rate in effect when it ended', () => {
        const rollup = aggregateReadings(readings, config.tariff);

        // 1.0 kWh @ 0.32384 + 2.0 kWh @ 0.41756 = 1.15896 -> rounded
        expect(rollup.importCost).toBeCloseTo(1.16, 2);
    });

    test('credits export at the flat feed-in rate', () => {
        const rollup = aggregateReadings(readings, config.tariff);
        expect(rollup.exportCredit).toBeCloseTo(0.02, 2);
    });

    test('nets import cost against export credit', () => {
        const rollup = aggregateReadings(readings, config.tariff);
        expect(rollup.netCost).toBeCloseTo(1.14, 2);
    });

    test('ignores negative deltas (counter resets) when pricing import', () => {
        const readingsWithReset = [
            readings[0],
            { ...readings[1], totalImportEnergy: 0 }, // device-side daily counter reset
            readings[2]
        ];

        const rollup = aggregateReadings(readingsWithReset, config.tariff);

        // Only the second interval (0 -> 53) should be priced; the reset interval contributes nothing.
        expect(rollup.importCost).toBeCloseTo(53 * 0.41756, 2);
    });

    test('omits battery fields entirely when no battery data was polled', () => {
        const rollup = aggregateReadings(readings, config.tariff);

        expect(rollup.batteryChargeKwh).toBeUndefined();
        expect(rollup.batteryDischargeKwh).toBeUndefined();
        expect(rollup.currentBatterySOC).toBeUndefined();
        expect(rollup.currentBatteryStatus).toBeUndefined();
        expect(rollup.currentBatteryPowerW).toBeUndefined();
        expect(rollup.batteryTemperatureC).toBeUndefined();
        expect(rollup.batteryCycleTimes).toBeUndefined();
        expect(rollup.batteryRemainingsKwh).toBeUndefined();
    });

    test('includes battery charge/discharge deltas and current SOC when battery data is present', () => {
        const readingsWithBattery = [
            { ...readings[0], totalDeviceCharge: 20, totalDeviceDischarge: 15, batterySOC: 40 },
            { ...readings[1], totalDeviceCharge: 21, totalDeviceDischarge: 15, batterySOC: 55 },
            { ...readings[2], totalDeviceCharge: 21, totalDeviceDischarge: 17.5, batterySOC: 30 }
        ];

        const rollup = aggregateReadings(readingsWithBattery, config.tariff);

        expect(rollup.batteryChargeKwh).toBeCloseTo(1, 5);
        expect(rollup.batteryDischargeKwh).toBeCloseTo(2.5, 5);
        expect(rollup.currentBatterySOC).toBe(30);
    });

    test('shows current SOC/status/health even when the oldest reading in range predates totalDeviceCharge data', () => {
        // e.g. the range's `first` reading is from before PollerFunction started
        // recording totalDeviceCharge (a real historical gap this app hit — see
        // PollerFunction.js), or from before a battery was ever configured. Only
        // batteryChargeKwh/batteryDischargeKwh genuinely need both first and last;
        // everything else describes the latest reading alone and shouldn't be
        // blocked by a gap earlier in the range.
        const readingsWithPartialBattery = [
            readings[0], // no battery fields at all — predates battery data
            { ...readings[1], batterySOC: 55 },
            {
                ...readings[2], batterySOC: 30, batteryDeviceStatus: 1, chargeDischargePower: 250,
                batteryTemperature: 24.5, batteryCycleTimes: 12, batteryRemainings: 8.2
            }
        ];

        const rollup = aggregateReadings(readingsWithPartialBattery, config.tariff);

        expect(rollup.currentBatterySOC).toBe(30);
        expect(rollup.currentBatteryStatus).toBe('charging');
        expect(rollup.currentBatteryPowerW).toBe(250);
        expect(rollup.batteryTemperatureC).toBe(24.5);
        expect(rollup.batteryCycleTimes).toBe(12);
        expect(rollup.batteryRemainingsKwh).toBe(8.2);
        expect(rollup.batteryChargeKwh).toBeUndefined();
        expect(rollup.batteryDischargeKwh).toBeUndefined();
    });

    test.each([
        [500, 'charging'],
        [-800, 'discharging'],
        [0, 'idle'],
        [undefined, 'idle']
    ])('classifies chargeDischargePower=%p as currentBatteryStatus=%p', (power, expectedStatus) => {
        const readingsWithBattery = [
            { ...readings[0], totalDeviceCharge: 20, totalDeviceDischarge: 15, batterySOC: 40 },
            { ...readings[1], totalDeviceCharge: 21, totalDeviceDischarge: 15, batterySOC: 55 },
            { ...readings[2], totalDeviceCharge: 21, totalDeviceDischarge: 17.5, batterySOC: 30, chargeDischargePower: power }
        ];

        const rollup = aggregateReadings(readingsWithBattery, config.tariff);
        expect(rollup.currentBatteryStatus).toBe(expectedStatus);
        expect(rollup.currentBatteryPowerW).toBe(typeof power === 'number' ? power : null);
    });

    test('trusts batteryDeviceStatus=0 (Idle) over a non-zero chargeDischargePower reading (sensor noise)', () => {
        const readingsWithBattery = [
            { ...readings[0], totalDeviceCharge: 20, totalDeviceDischarge: 15, batterySOC: 40 },
            { ...readings[1], totalDeviceCharge: 21, totalDeviceDischarge: 15, batterySOC: 55 },
            {
                ...readings[2], totalDeviceCharge: 21, totalDeviceDischarge: 17.5, batterySOC: 30,
                batteryDeviceStatus: 0, chargeDischargePower: 3 // a few watts of noise while genuinely idle
            }
        ];

        const rollup = aggregateReadings(readingsWithBattery, config.tariff);
        expect(rollup.currentBatteryStatus).toBe('idle');
    });

    test('includes battery temperature, cycle count, and remaining capacity from the latest reading', () => {
        const readingsWithBattery = [
            { ...readings[0], totalDeviceCharge: 20, totalDeviceDischarge: 15, batterySOC: 40 },
            { ...readings[1], totalDeviceCharge: 21, totalDeviceDischarge: 15, batterySOC: 55 },
            {
                ...readings[2], totalDeviceCharge: 21, totalDeviceDischarge: 17.5, batterySOC: 30,
                batteryTemperature: 23.1, batteryCycleTimes: 42, batteryRemainings: 6.4
            }
        ];

        const rollup = aggregateReadings(readingsWithBattery, config.tariff);
        expect(rollup.batteryTemperatureC).toBe(23.1);
        expect(rollup.batteryCycleTimes).toBe(42);
        expect(rollup.batteryRemainingsKwh).toBe(6.4);
    });
});

describe('DashboardApiFunction formatInsightsResponse', () => {
    test('reports unavailable when no report record exists yet', () => {
        expect(formatInsightsResponse(null)).toEqual({ available: false });
    });

    test('shapes a stored report record into the API response', () => {
        const item = {
            DeviceSn: 'REPORT#H34ABCDEFG5001',
            Timestamp: 1785400000,
            lookbackDays: 1,
            assessment: { pvYieldKwh: 5, netCost: 1.14 },
            recommendation: 'Recommendation: hold charge into peak.',
            aiInsights: { narrative: 'All normal.', anomalies: [] }
        };

        expect(formatInsightsResponse(item)).toEqual({
            available: true,
            generatedAt: 1785400000,
            lookbackDays: 1,
            assessment: { pvYieldKwh: 5, netCost: 1.14 },
            recommendation: 'Recommendation: hold charge into peak.',
            aiInsights: { narrative: 'All normal.', anomalies: [] }
        });
    });

    test('defaults aiInsights to null when the report has none', () => {
        const item = {
            Timestamp: 1785400000,
            lookbackDays: 1,
            assessment: {},
            recommendation: 'Recommendation: no significant peak-window import detected.'
        };

        expect(formatInsightsResponse(item).aiInsights).toBeNull();
    });
});

describe('DashboardApiFunction formatBatteryStatusResponse', () => {
    test('reports unavailable when no battery status record exists yet', () => {
        expect(formatBatteryStatusResponse(null)).toEqual({ available: false, currentWeather: null });
    });

    test('includes live current weather even when no battery status record exists yet', () => {
        const currentWeather = { tempC: 22, description: 'clear sky' };
        expect(formatBatteryStatusResponse(null, currentWeather)).toEqual({ available: false, currentWeather });
    });

    test('shapes a stored battery status record into the API response', () => {
        const item = {
            DeviceSn: 'BATTERY_CONTROL#H34ABCDEFG5001',
            Timestamp: 1785400000,
            classification: 'sunny',
            reasoning: 'maxPop=0.05, avgClouds=10%',
            chargeUpperSoc: 40,
            dryRun: true,
            applied: false,
            enabled: true,
            appliesToDate: '2026-08-01',
            previousAssessment: { accurate: true, assessment: 'Fine.', usageShouldInfluence: false, usageNote: '' }
        };
        const currentWeather = { tempC: 18, description: 'few clouds' };

        expect(formatBatteryStatusResponse(item, currentWeather)).toEqual({
            available: true,
            currentWeather,
            decidedAt: 1785400000,
            classification: 'sunny',
            reasoning: 'maxPop=0.05, avgClouds=10%',
            chargeUpperSoc: 40,
            dryRun: true,
            applied: false,
            enabled: true,
            appliesToDate: '2026-08-01',
            previousAssessment: { accurate: true, assessment: 'Fine.', usageShouldInfluence: false, usageNote: '' }
        });
    });

    test('defaults appliesToDate to null when the record predates that field', () => {
        const item = { Timestamp: 1785400000, classification: 'sunny', chargeUpperSoc: 40, dryRun: true, applied: false };
        expect(formatBatteryStatusResponse(item).appliesToDate).toBeNull();
    });

    test('defaults currentWeather to null when the current-weather lookup failed or is unconfigured', () => {
        const item = { Timestamp: 1785400000, classification: 'sunny', chargeUpperSoc: 40, dryRun: true, applied: false };
        expect(formatBatteryStatusResponse(item, null).currentWeather).toBeNull();
        expect(formatBatteryStatusResponse(item).currentWeather).toBeNull();
    });

    test('defaults enabled to true and previousAssessment to null when the record predates those fields', () => {
        const item = { Timestamp: 1785400000, classification: 'sunny', chargeUpperSoc: 40, dryRun: true, applied: false };
        const response = formatBatteryStatusResponse(item);
        expect(response.enabled).toBe(true);
        expect(response.previousAssessment).toBeNull();
    });
});

describe('DashboardApiFunction formatBatterySettingsResponse', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            BATTERY_CONTROL_DEFAULT_SUNNY: '40',
            BATTERY_CONTROL_DEFAULT_PARTLY_CLOUDY: '70',
            BATTERY_CONTROL_DEFAULT_OVERCAST: '100',
            BATTERY_CONTROL_DEFAULT_DISABLED: '100',
            BATTERY_CONTROL_DEFAULT_DRY_RUN: 'true'
        };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    const ALL_DEFAULT_SOURCES = {
        enabled: 'default', dryRun: 'default', chargeUpperSocSunny: 'default',
        chargeUpperSocPartlyCloudy: 'default', chargeUpperSocOvercast: 'default', disabledChargeUpperSoc: 'default'
    };

    test('falls back to the config defaults when no override has been saved', () => {
        expect(formatBatterySettingsResponse(undefined)).toEqual({
            enabled: true,
            dryRun: true,
            chargeUpperSocSunny: 40,
            chargeUpperSocPartlyCloudy: 70,
            chargeUpperSocOvercast: 100,
            disabledChargeUpperSoc: 100,
            usingDefaults: true,
            sources: ALL_DEFAULT_SOURCES
        });
    });

    test('uses the saved override values when present, with every field sourced from the saved sources map', () => {
        const item = {
            enabled: false, dryRun: false, chargeUpperSocSunny: 25, chargeUpperSocPartlyCloudy: 60,
            chargeUpperSocOvercast: 90, disabledChargeUpperSoc: 80,
            sources: {
                enabled: 'dashboard', dryRun: 'dashboard', chargeUpperSocSunny: 'settings-optimizer',
                chargeUpperSocPartlyCloudy: 'dashboard', chargeUpperSocOvercast: 'dashboard', disabledChargeUpperSoc: 'dashboard'
            }
        };
        expect(formatBatterySettingsResponse(item)).toEqual({
            enabled: false,
            dryRun: false,
            chargeUpperSocSunny: 25,
            chargeUpperSocPartlyCloudy: 60,
            chargeUpperSocOvercast: 90,
            disabledChargeUpperSoc: 80,
            usingDefaults: false,
            sources: {
                enabled: 'dashboard', dryRun: 'dashboard', chargeUpperSocSunny: 'settings-optimizer',
                chargeUpperSocPartlyCloudy: 'dashboard', chargeUpperSocOvercast: 'dashboard', disabledChargeUpperSoc: 'dashboard'
            }
        });
    });

    test('a row saved before source-tracking existed (no sources map) defaults every present field to "dashboard"', () => {
        const item = {
            enabled: true, dryRun: true, chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 70,
            chargeUpperSocOvercast: 100, disabledChargeUpperSoc: 100
        };
        expect(formatBatterySettingsResponse(item).sources).toEqual({
            enabled: 'dashboard', dryRun: 'dashboard', chargeUpperSocSunny: 'dashboard',
            chargeUpperSocPartlyCloudy: 'dashboard', chargeUpperSocOvercast: 'dashboard', disabledChargeUpperSoc: 'dashboard'
        });
    });

    test('falls back to a live default (dryRun: false) when BATTERY_CONTROL_DEFAULT_DRY_RUN is "false"', () => {
        process.env.BATTERY_CONTROL_DEFAULT_DRY_RUN = 'false';
        expect(formatBatterySettingsResponse(undefined).dryRun).toBe(false);
    });
});

describe('DashboardApiFunction validateBatterySettings', () => {
    test('accepts a valid payload', () => {
        expect(validateBatterySettings({
            enabled: true, dryRun: true, chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 70,
            chargeUpperSocOvercast: 100, disabledChargeUpperSoc: 100
        })).toBeNull();
    });

    test('rejects a non-boolean enabled field', () => {
        expect(validateBatterySettings({
            enabled: 'yes', dryRun: true, chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 70,
            chargeUpperSocOvercast: 100, disabledChargeUpperSoc: 100
        })).toMatch(/enabled/);
    });

    test('rejects a non-boolean dryRun field', () => {
        expect(validateBatterySettings({
            enabled: true, dryRun: 'no', chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 70,
            chargeUpperSocOvercast: 100, disabledChargeUpperSoc: 100
        })).toMatch(/dryRun/);
    });

    test('rejects a non-numeric chargeUpperSocPartlyCloudy field', () => {
        expect(validateBatterySettings({
            enabled: true, dryRun: true, chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 101,
            chargeUpperSocOvercast: 100, disabledChargeUpperSoc: 100
        })).toMatch(/chargeUpperSocPartlyCloudy/);
    });

    test.each([
        [-1, 100, 100], [101, 100, 100], [40, -1, 100], [40, 101, 100], ['40', 100, 100],
        [undefined, 100, 100], [40, 100, -1], [40, 100, 101], [40, 100, undefined]
    ])('rejects out-of-range or non-numeric percentages (%p, %p, %p)', (sunny, overcast, disabled) => {
        expect(validateBatterySettings({
            enabled: true, dryRun: true, chargeUpperSocSunny: sunny, chargeUpperSocPartlyCloudy: 70,
            chargeUpperSocOvercast: overcast, disabledChargeUpperSoc: disabled
        })).toEqual(expect.any(String));
    });

    test('accepts boundary values 0 and 100', () => {
        expect(validateBatterySettings({
            enabled: true, dryRun: true, chargeUpperSocSunny: 0, chargeUpperSocPartlyCloudy: 50,
            chargeUpperSocOvercast: 100, disabledChargeUpperSoc: 0
        })).toBeNull();
    });
});


describe('DashboardApiFunction formatSettingsOptimizationResponse', () => {
    test('returns available: false when no record exists yet', () => {
        expect(formatSettingsOptimizationResponse(null)).toEqual({ available: false });
    });

    test('surfaces the stored record when one exists', () => {
        const item = {
            Timestamp: 1785400000,
            recommendations: { chargeUpperSocSunny: { current: 40, recommended: 45, sampleSize: 3 } },
            confidence: 'medium',
            reasoning: 'Sunny nights ran flat twice.',
            applied: false,
            autoApply: false
        };
        expect(formatSettingsOptimizationResponse(item)).toEqual({
            available: true,
            assessedAt: 1785400000,
            recommendations: item.recommendations,
            confidence: 'medium',
            reasoning: 'Sunny nights ran flat twice.',
            applied: false,
            autoApply: false
        });
    });

    test('defaults recommendations/confidence/reasoning to null when missing from the record', () => {
        const item = { Timestamp: 1785400000, applied: false, autoApply: false };
        const result = formatSettingsOptimizationResponse(item);
        expect(result.recommendations).toBeNull();
        expect(result.confidence).toBeNull();
        expect(result.reasoning).toBeNull();
    });
});

describe('DashboardApiFunction formatSettingsOptimizerSettingsResponse', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, SETTINGS_OPTIMIZER_DEFAULT_AUTO_APPLY: 'false' };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    test('falls back to the config default (false) when no override has been saved', () => {
        expect(formatSettingsOptimizerSettingsResponse(undefined)).toEqual({
            autoApply: false,
            usingDefaults: true,
            sources: { autoApply: 'default' }
        });
    });

    test('uses the saved override value when present', () => {
        expect(formatSettingsOptimizerSettingsResponse({
            autoApply: true, sources: { autoApply: 'dashboard' }
        })).toEqual({
            autoApply: true,
            usingDefaults: false,
            sources: { autoApply: 'dashboard' }
        });
    });

    test('a row saved before source-tracking existed defaults to "dashboard"', () => {
        expect(formatSettingsOptimizerSettingsResponse({ autoApply: true }).sources).toEqual({ autoApply: 'dashboard' });
    });

    test('falls back to true when the env default says so', () => {
        process.env.SETTINGS_OPTIMIZER_DEFAULT_AUTO_APPLY = 'true';
        expect(formatSettingsOptimizerSettingsResponse(undefined).autoApply).toBe(true);
    });
});

describe('DashboardApiFunction validateSettingsOptimizerSettings', () => {
    test('accepts a valid payload', () => {
        expect(validateSettingsOptimizerSettings({ autoApply: true })).toBeNull();
    });

    test('rejects a non-boolean autoApply field', () => {
        expect(validateSettingsOptimizerSettings({ autoApply: 'yes' })).toMatch(/autoApply/);
    });
});
