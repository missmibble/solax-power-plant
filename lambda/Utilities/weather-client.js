'use strict';

/**
 * Weather data access for the app's two callers — BatteryControlFunction's
 * nightly forecast-driven charge decision, and DashboardApiFunction's live
 * "current conditions" widget. Both read a normalized shape from this file,
 * never the raw provider response, so a future provider swap only ever
 * touches this one file — callers (and classifyForecast's threshold logic
 * in BatteryControlFunction) never need to change.
 *
 * Forecast slot shape: { timestampSeconds, tempC, precipitationProbability
 * (0-1 fraction), cloudCoverPercent (0-100), isRainy (boolean) }.
 * Current conditions shape: { tempC, description }.
 *
 * Backed by Open-Meteo's free forecast API (https://open-meteo.com) — no API
 * key required, and its `timezone`/`start_date`/`end_date` params return
 * hours already bucketed to the requested local calendar day, unlike a
 * UTC-referenced 3-hour grid that has to be filtered client-side.
 */

const { localDateString } = require('./tariff');

// Standard WMO weather interpretation codes (Open-Meteo's `weather_code`
// field) — used only to turn the current-conditions numeric code into the
// short text description the dashboard widget shows.
const WMO_DESCRIPTIONS = {
    0: 'clear sky',
    1: 'mainly clear',
    2: 'partly cloudy',
    3: 'overcast',
    45: 'fog',
    48: 'depositing rime fog',
    51: 'light drizzle',
    53: 'moderate drizzle',
    55: 'dense drizzle',
    56: 'light freezing drizzle',
    57: 'dense freezing drizzle',
    61: 'slight rain',
    63: 'moderate rain',
    65: 'heavy rain',
    66: 'light freezing rain',
    67: 'heavy freezing rain',
    71: 'slight snow fall',
    73: 'moderate snow fall',
    75: 'heavy snow fall',
    77: 'snow grains',
    80: 'slight rain showers',
    81: 'moderate rain showers',
    82: 'violent rain showers',
    85: 'slight snow showers',
    86: 'heavy snow showers',
    95: 'thunderstorm',
    96: 'thunderstorm with slight hail',
    99: 'thunderstorm with heavy hail'
};

// What UTC instant does this Intl-formatted local wall-clock time (as of
// utcMs) correspond to? Comparing utcMs against its own local rendering
// yields the zone's offset at that instant — correct across DST transitions
// generically, though this app's real deployment (Australia/Brisbane) has
// none.
function timezoneOffsetSecondsAt(utcMs, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(utcMs));
    const get = type => Number(parts.find(p => p.type === type).value);
    const asIfUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asIfUtcMs - utcMs) / 1000);
}

// Open-Meteo returns hourly.time as naive local datetime strings (e.g.
// "2026-08-04T00:00", no UTC offset) when a timezone is requested — this
// converts one back to a real UTC epoch, since every other timestamp in this
// app is UTC epoch seconds.
function localNaiveDateTimeToEpochSeconds(localDateTimeString, timezone) {
    const [datePart, timePart] = localDateTimeString.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);

    const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute);
    const offsetSeconds = timezoneOffsetSecondsAt(guessUtcMs, timezone);
    return Math.floor(guessUtcMs / 1000) - offsetSeconds;
}

// timezone + start_date/end_date (both set to tomorrow's local date) means
// the API itself returns exactly tomorrow's 24 local hours, in order — no
// client-side date filtering needed, unlike a UTC-grid provider.
async function fetchTomorrowForecast(lat, lon, timezone) {
    const tomorrow = localDateString(Math.floor(Date.now() / 1000) + 24 * 60 * 60, timezone);

    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', lat);
    url.searchParams.set('longitude', lon);
    url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,precipitation,cloud_cover');
    url.searchParams.set('timezone', timezone);
    url.searchParams.set('start_date', tomorrow);
    url.searchParams.set('end_date', tomorrow);

    const response = await fetch(url);
    const payload = await response.json();
    if (payload.error) {
        throw new Error(`Open-Meteo error: ${payload.reason}`);
    }

    const hourly = payload.hourly || {};
    const times = hourly.time || [];

    return times.map((time, i) => ({
        timestampSeconds: localNaiveDateTimeToEpochSeconds(time, timezone),
        tempC: typeof hourly.temperature_2m?.[i] === 'number' ? Math.round(hourly.temperature_2m[i]) : null,
        // Open-Meteo gives precipitation_probability as a 0-100 percent;
        // scaled to a 0-1 fraction here so classifyForecast's thresholds
        // don't need to change if the provider changes again.
        precipitationProbability: (hourly.precipitation_probability?.[i] || 0) / 100,
        cloudCoverPercent: hourly.cloud_cover?.[i] || 0,
        // No categorical condition field requested — derived from forecast
        // precipitation amount (mm) instead, any measurable rain in that hour.
        isRainy: (hourly.precipitation?.[i] || 0) > 0
    }));
}

// A distinct request shape from the forecast one above — current instant-in-
// time conditions, used only for the dashboard's live weather widget
// (display only, never feeds a decision). Throws on failure like
// fetchTomorrowForecast; callers that want graceful degradation (e.g.
// DashboardApiFunction) catch it themselves, same pattern as the rest of the
// app's additive/best-effort features.
async function fetchCurrentConditions(lat, lon) {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', lat);
    url.searchParams.set('longitude', lon);
    url.searchParams.set('current', 'temperature_2m,weather_code');

    const response = await fetch(url);
    const payload = await response.json();
    if (payload.error) {
        throw new Error(`Open-Meteo error: ${payload.reason}`);
    }

    const current = payload.current || {};
    return {
        tempC: typeof current.temperature_2m === 'number' ? Math.round(current.temperature_2m) : null,
        description: WMO_DESCRIPTIONS[current.weather_code] || null
    };
}

module.exports = { fetchTomorrowForecast, fetchCurrentConditions };
