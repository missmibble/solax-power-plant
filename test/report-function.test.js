'use strict';

const fs = require('fs');
const path = require('path');
const {
    assessUsage,
    formatReport,
    dailySummaries,
    parseAiResponse,
    recommendation,
    buildReportRecord,
    REPORT_RECORD_PREFIX
} = require('../lambda/ReportFunction/ReportFunction');

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

const readings = [
    { Timestamp: utcSeconds(5, 0), totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5 },
    // +1.0 kWh import (shoulder-morning)
    { Timestamp: utcSeconds(6, 0), totalYield: 100.5, totalImportEnergy: 51, totalExportEnergy: 5 },
    // +2.0 kWh import (peak-evening), +1.0 kWh export
    { Timestamp: utcSeconds(18, 0), totalYield: 105, totalImportEnergy: 53, totalExportEnergy: 6 }
];

describe('ReportFunction assessUsage', () => {
    test('breaks import down by tariff window', () => {
        const assessment = assessUsage(readings, config.tariff);

        expect(assessment.byWindow['shoulder-morning'].importKwh).toBeCloseTo(1.0, 5);
        expect(assessment.byWindow['peak-evening'].importKwh).toBeCloseTo(2.0, 5);
        expect(assessment.byWindow['night-ev-charge'].importKwh).toBe(0);
        expect(assessment.byWindow['offpeak-midday'].importKwh).toBe(0);
        expect(assessment.byWindow['shoulder-night'].importKwh).toBe(0);
    });

    test('totals PV yield, export, and net cost', () => {
        const assessment = assessUsage(readings, config.tariff);

        expect(assessment.pvYieldKwh).toBe(5);
        expect(assessment.exportKwh).toBe(1);
        expect(assessment.totalExportCredit).toBeCloseTo(0.02, 2);
        expect(assessment.totalImportCost).toBeCloseTo(1.16, 2);
        // all readings fall within a single local calendar day, so the daily
        // supply charge is applied exactly once
        expect(assessment.supplyCharge).toBeCloseTo(1.45805, 2);
        expect(assessment.netCost).toBeCloseTo(2.60, 2);
    });

    test('surfaces peak-window import for the recommendation heuristic', () => {
        const assessment = assessUsage(readings, config.tariff);
        expect(assessment.peakImportKwh).toBe(2);
    });

    test('omits battery fields when no battery data was polled', () => {
        const assessment = assessUsage(readings, config.tariff);

        expect(assessment.batteryChargeKwh).toBeUndefined();
        expect(assessment.peakWindowStartSOC).toBeUndefined();
    });

    test('computes battery charge/discharge and peak-window SOC bounds when present', () => {
        const batteryReadings = [
            { ...readings[0], totalDeviceCharge: 20, totalDeviceDischarge: 15, batterySOC: 80 },
            { ...readings[1], totalDeviceCharge: 21, totalDeviceDischarge: 15, batterySOC: 85 },
            { ...readings[2], totalDeviceCharge: 21, totalDeviceDischarge: 16, batterySOC: 60 }, // 18:00, peak-evening
            {
                Timestamp: utcSeconds(19, 30), // still peak-evening (16:00-21:00)
                totalYield: 106, totalImportEnergy: 54, totalExportEnergy: 6,
                totalDeviceCharge: 21, totalDeviceDischarge: 18, batterySOC: 20
            }
        ];

        const assessment = assessUsage(batteryReadings, config.tariff);

        expect(assessment.batteryChargeKwh).toBeCloseTo(1, 5);
        expect(assessment.batteryDischargeKwh).toBeCloseTo(3, 5);
        expect(assessment.currentBatterySOC).toBe(20);
        expect(assessment.peakWindowStartSOC).toBe(60);
        expect(assessment.peakWindowEndSOC).toBe(20);
    });
});

describe('ReportFunction formatReport', () => {
    test('recommends holding charge into peak when peak import is significant', () => {
        const assessment = assessUsage(readings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1);

        expect(report).toContain('Recommendation:');
        expect(report).toContain('2 kWh was imported during the peak window');
        expect(report).toContain('holding more battery charge');
    });

    test('reports no significant peak import when there is none', () => {
        const lowPeakReadings = [
            readings[0],
            readings[1],
            { ...readings[2], totalImportEnergy: 51.1 } // only 0.1 kWh in the peak window
        ];
        const assessment = assessUsage(lowPeakReadings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1);

        expect(report).toContain('no significant peak-window import detected');
    });

    test('includes the window-by-window breakdown and currency, skipping windows with no import', () => {
        const assessment = assessUsage(readings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1);

        expect(report).toContain('shoulder-morning: 1 kWh @ 0.32384/kWh');
        expect(report).toContain('AUD');
        expect(report).not.toContain('night-ev-charge: 0 kWh');
    });

    test('omits the battery line when no battery data is present', () => {
        const assessment = assessUsage(readings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1);

        expect(report).not.toContain('Battery:');
    });

    test('flags an already-depleted battery before peak started', () => {
        const lowStartReadings = [
            { ...readings[0], totalDeviceCharge: 20, totalDeviceDischarge: 15, batterySOC: 50 },
            { ...readings[1], totalDeviceCharge: 21, totalDeviceDischarge: 15, batterySOC: 40 },
            { ...readings[2], totalDeviceCharge: 21, totalDeviceDischarge: 16, batterySOC: 15 } // peak-evening, already low
        ];

        const assessment = assessUsage(lowStartReadings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1);

        expect(report).toContain('Battery: charged 1 kWh, discharged 1 kWh, currently at 15% SOC');
        expect(report).toContain('already only 15%');
        expect(report).toContain('overnight/solar charge target');
    });

    test('flags a battery that ran flat during the peak window', () => {
        const drainedDuringPeakReadings = [
            { ...readings[0], totalDeviceCharge: 20, totalDeviceDischarge: 15, batterySOC: 80 },
            { ...readings[1], totalDeviceCharge: 21, totalDeviceDischarge: 15, batterySOC: 85 },
            { ...readings[2], totalDeviceCharge: 21, totalDeviceDischarge: 16, batterySOC: 60 },
            {
                Timestamp: utcSeconds(19, 30),
                totalYield: 106, totalImportEnergy: 54, totalExportEnergy: 6,
                totalDeviceCharge: 21, totalDeviceDischarge: 18, batterySOC: 20
            }
        ];

        const assessment = assessUsage(drainedDuringPeakReadings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1);

        expect(report).toContain('went from 60% to 20% across');
        expect(report).toContain('discharge cutoff SOC or larger capacity');
    });

    test('includes the AI narrative and anomalies when insights are provided', () => {
        const assessment = assessUsage(readings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1, {
            narrative: 'Today tracked close to the recent pattern.',
            anomalies: ['PV yield was 15% below the past week\'s average.']
        });

        expect(report).toContain('AI insights:');
        expect(report).toContain('Today tracked close to the recent pattern.');
        expect(report).toContain('Anomalies flagged:');
        expect(report).toContain("PV yield was 15% below the past week's average.");
    });

    test('reports "none" when the AI found no anomalies', () => {
        const assessment = assessUsage(readings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1, {
            narrative: 'Nothing unusual today.',
            anomalies: []
        });

        expect(report).toContain('Anomalies flagged: none');
    });

    test('omits the AI insights section entirely when none was generated', () => {
        const assessment = assessUsage(readings, config.tariff);
        const report = formatReport(assessment, config.tariff, 1, null);

        expect(report).not.toContain('AI insights:');
    });
});

describe('ReportFunction dailySummaries', () => {
    test('buckets deltas by local calendar day', () => {
        const twoDayReadings = [
            { Timestamp: utcSeconds(5, 0), totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5 },
            { Timestamp: utcSeconds(18, 0), totalYield: 105, totalImportEnergy: 53, totalExportEnergy: 6 },
            // next local day (2026-07-31)
            { Timestamp: utcSeconds(24 + 5, 0), totalYield: 108, totalImportEnergy: 55, totalExportEnergy: 6.5 }
        ];

        const summaries = dailySummaries(twoDayReadings, config.tariff);

        expect(summaries).toEqual([
            { date: '2026-07-30', pvYieldKwh: 5, importKwh: 3, exportKwh: 1 },
            { date: '2026-07-31', pvYieldKwh: 3, importKwh: 2, exportKwh: 0.5 }
        ]);
    });

    test('skips a delta across a counter reset', () => {
        const resetReadings = [
            { Timestamp: utcSeconds(5, 0), totalYield: 100, totalImportEnergy: 50, totalExportEnergy: 5 },
            // counter reset — totalYield dropped
            { Timestamp: utcSeconds(6, 0), totalYield: 2, totalImportEnergy: 51, totalExportEnergy: 5 }
        ];

        const summaries = dailySummaries(resetReadings, config.tariff);

        expect(summaries).toEqual([{ date: '2026-07-30', pvYieldKwh: 0, importKwh: 1, exportKwh: 0 }]);
    });
});

describe('ReportFunction parseAiResponse', () => {
    test('parses a well-formed JSON response', () => {
        const result = parseAiResponse('{"narrative": "All normal.", "anomalies": ["one thing"]}');
        expect(result).toEqual({ narrative: 'All normal.', anomalies: ['one thing'] });
    });

    test('extracts JSON even with surrounding text', () => {
        const result = parseAiResponse('Sure, here it is:\n{"narrative": "Fine.", "anomalies": []}\nHope that helps!');
        expect(result).toEqual({ narrative: 'Fine.', anomalies: [] });
    });

    test('defaults anomalies to an empty array when omitted', () => {
        const result = parseAiResponse('{"narrative": "Fine."}');
        expect(result).toEqual({ narrative: 'Fine.', anomalies: [] });
    });

    test('returns null when there is no narrative field', () => {
        expect(parseAiResponse('{"anomalies": []}')).toBeNull();
    });

    test('returns null when the text has no JSON object at all', () => {
        expect(parseAiResponse('not json')).toBeNull();
    });
});

describe('ReportFunction buildReportRecord', () => {
    test('prefixes DeviceSn with REPORT_RECORD_PREFIX so it cannot collide with a real device serial', () => {
        const assessment = assessUsage(readings, config.tariff);
        const record = buildReportRecord('H34ABCDEFG5001', 1785400000, 1, assessment, 'Recommendation: text.', null);

        expect(record.DeviceSn).toBe(`${REPORT_RECORD_PREFIX}H34ABCDEFG5001`);
        expect(record.Timestamp).toBe(1785400000);
        expect(record.lookbackDays).toBe(1);
        expect(record.assessment).toBe(assessment);
        expect(record.recommendation).toBe('Recommendation: text.');
    });

    test('stores null (not undefined) for aiInsights when none was generated', () => {
        const assessment = assessUsage(readings, config.tariff);
        const record = buildReportRecord('H34ABCDEFG5001', 1785400000, 1, assessment, 'Recommendation: text.', null);

        expect(record.aiInsights).toBeNull();
    });

    test('stores the AI insights object when present', () => {
        const assessment = assessUsage(readings, config.tariff);
        const aiInsights = { narrative: 'All normal.', anomalies: [] };
        const record = buildReportRecord('H34ABCDEFG5001', 1785400000, 1, assessment, 'Recommendation: text.', aiInsights);

        expect(record.aiInsights).toEqual(aiInsights);
    });
});

describe('ReportFunction recommendation (exported directly)', () => {
    test('is the same text formatReport embeds', () => {
        const assessment = assessUsage(readings, config.tariff);
        const text = recommendation(assessment, config.tariff);
        const report = formatReport(assessment, config.tariff, 1);

        expect(report).toContain(text);
    });
});
