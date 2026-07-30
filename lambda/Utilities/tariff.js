'use strict';

/**
 * Tariff window matching + cost calculation — shared by DashboardApiFunction,
 * AlertFunction, and ReportFunction. Expects the config.tariff shape (see
 * docs/PowerPlant_Project_Brief.md / TARIFF_STRUCTURE env var):
 *   { currency, timezone, importRates: [{ label, startTime, endTime, rate }], feedInRate }
 *
 * `timezone` must be an IANA zone (e.g. "Australia/Sydney") — time-of-day
 * windows are meaningless without converting the UTC reading timestamp to
 * local time first.
 */

function minutesSinceMidnight(hhmm) {
    const [hours, minutes] = hhmm.split(':').map(Number);
    return hours * 60 + minutes;
}

function localMinutesSinceMidnight(timestampSeconds, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date(timestampSeconds * 1000));

    const hour = Number(parts.find(p => p.type === 'hour').value);
    const minute = Number(parts.find(p => p.type === 'minute').value);
    return hour * 60 + minute;
}

// Windows are [startTime, endTime) in local time — the end boundary belongs to
// the next window, so back-to-back windows never double-count a reading.
function findImportRateWindow(tariff, timestampSeconds) {
    const minutes = localMinutesSinceMidnight(timestampSeconds, tariff.timezone);

    return tariff.importRates.find(window => {
        const start = minutesSinceMidnight(window.startTime);
        const end = minutesSinceMidnight(window.endTime);
        return minutes >= start && minutes < end;
    });
}

function importCostForWindow(tariff, timestampSeconds, kwh) {
    const window = findImportRateWindow(tariff, timestampSeconds);
    if (!window) return { cost: 0, window: null, rate: null };
    return { cost: kwh * window.rate, window: window.label, rate: window.rate };
}

function exportCredit(tariff, kwh) {
    return kwh * (tariff.feedInRate || 0);
}

// Sortable YYYY-MM-DD in local time — used to bucket readings into calendar
// days (e.g. ReportFunction's multi-day history summary for AI insights).
function localDateString(timestampSeconds, timezone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date(timestampSeconds * 1000));
}

module.exports = { findImportRateWindow, importCostForWindow, exportCredit, localDateString };
