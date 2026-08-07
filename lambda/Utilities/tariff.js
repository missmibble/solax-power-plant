'use strict';

/**
 * Tariff window matching + cost calculation — shared by DashboardApiFunction,
 * AlertFunction, and ReportFunction. Expects the config.tariff shape (see
 * docs/PowerPlant_Project_Brief.md / TARIFF_STRUCTURE env var):
 *   { currency, timezone, importRates: [{ label, startTime, endTime, rate }], feedInRate, dailySupplyCharge }
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

// A fixed per-day charge applies regardless of usage — unlike importRates/
// feedInRate this isn't derived from consumption deltas at all, just the
// number of local calendar days the [fromTimestampSeconds, toTimestampSeconds]
// period actually spans (inclusive of both ends, so a same-day range still
// counts as 1 day, not 0). Callers pass the first/last reading's Timestamp,
// the same pair every other per-period cost figure is already derived from.
function supplyChargeForPeriod(tariff, fromTimestampSeconds, toTimestampSeconds) {
    if (!tariff.dailySupplyCharge) return 0;

    const fromDate = localDateString(fromTimestampSeconds, tariff.timezone);
    const toDate = localDateString(toTimestampSeconds, tariff.timezone);
    const diffDays = Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);

    return (diffDays + 1) * tariff.dailySupplyCharge;
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

// The UTC epoch seconds of local midnight on the calendar day containing
// timestampSeconds — used by DashboardApiFunction's range=day query so
// "Today" means the local calendar day (midnight to now), not a rolling
// 24-hour window that still spans most of yesterday if viewed early in the
// morning. Subtracting the local time-of-day from timestampSeconds works
// regardless of the timezone's UTC offset, since real-world offsets are
// always a whole number of minutes — the "seconds" component of local time
// always equals the "seconds" component of UTC time.
function startOfLocalDay(timestampSeconds, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date(timestampSeconds * 1000));

    const hour = Number(parts.find(p => p.type === 'hour').value);
    const minute = Number(parts.find(p => p.type === 'minute').value);
    const second = Number(parts.find(p => p.type === 'second').value);
    const secondsSinceMidnight = hour * 3600 + minute * 60 + second;

    return timestampSeconds - secondsSinceMidnight;
}

module.exports = {
    findImportRateWindow, importCostForWindow, exportCredit, supplyChargeForPeriod, localDateString, startOfLocalDay
};
