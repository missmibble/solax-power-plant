'use strict';

const { fetchTomorrowForecast, fetchCurrentConditions } = require('../lambda/Utilities/weather-client');
const { localDateString } = require('../lambda/Utilities/tariff');

function jsonResponse(body) {
    return { json: async () => body };
}

describe('weather-client', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('fetchTomorrowForecast', () => {
        test('requests latitude/longitude/hourly/timezone/start_date/end_date for tomorrow', async () => {
            global.fetch.mockResolvedValue(jsonResponse({
                hourly: { time: [], temperature_2m: [], precipitation_probability: [], precipitation: [], cloud_cover: [] }
            }));

            await fetchTomorrowForecast(-33, 151, 'UTC');

            const [url] = global.fetch.mock.calls[0];
            const parsed = new URL(url);
            const tomorrow = localDateString(Math.floor(Date.now() / 1000) + 24 * 60 * 60, 'UTC');

            expect(parsed.origin + parsed.pathname).toBe('https://api.open-meteo.com/v1/forecast');
            expect(parsed.searchParams.get('latitude')).toBe('-33');
            expect(parsed.searchParams.get('longitude')).toBe('151');
            expect(parsed.searchParams.get('hourly')).toBe('temperature_2m,precipitation_probability,precipitation,cloud_cover');
            expect(parsed.searchParams.get('timezone')).toBe('UTC');
            expect(parsed.searchParams.get('start_date')).toBe(tomorrow);
            expect(parsed.searchParams.get('end_date')).toBe(tomorrow);
        });

        test('normalizes the hourly parallel arrays, scaling precipitation_probability to a 0-1 fraction', async () => {
            global.fetch.mockResolvedValue(jsonResponse({
                hourly: {
                    time: ['2026-08-04T00:00', '2026-08-04T01:00'],
                    temperature_2m: [15.4, 14.8],
                    precipitation_probability: [40, 5],
                    precipitation: [0.2, 0],
                    cloud_cover: [80, 10]
                }
            }));

            const slots = await fetchTomorrowForecast(-33, 151, 'UTC');

            expect(slots).toEqual([
                {
                    timestampSeconds: Math.floor(Date.UTC(2026, 7, 4, 0, 0) / 1000),
                    tempC: 15, precipitationProbability: 0.4, cloudCoverPercent: 80, isRainy: true
                },
                {
                    timestampSeconds: Math.floor(Date.UTC(2026, 7, 4, 1, 0) / 1000),
                    tempC: 15, precipitationProbability: 0.05, cloudCoverPercent: 10, isRainy: false
                }
            ]);
        });

        test('converts naive local datetimes to UTC epoch using the requested timezone\'s offset', async () => {
            global.fetch.mockResolvedValue(jsonResponse({
                hourly: {
                    time: ['2026-08-04T00:00'],
                    temperature_2m: [20],
                    precipitation_probability: [0],
                    precipitation: [0],
                    cloud_cover: [0]
                }
            }));

            const slots = await fetchTomorrowForecast(-27.47, 153.03, 'Australia/Brisbane');

            // Brisbane is a fixed UTC+10 (no DST) — local 00:00 is UTC 14:00 the previous day.
            expect(slots[0].timestampSeconds).toBe(Math.floor(Date.UTC(2026, 7, 3, 14, 0) / 1000));
        });

        test('defaults missing fields rather than throwing', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ hourly: { time: ['2026-08-04T00:00'] } }));

            const slots = await fetchTomorrowForecast(-33, 151, 'UTC');

            expect(slots).toEqual([
                {
                    timestampSeconds: Math.floor(Date.UTC(2026, 7, 4, 0, 0) / 1000),
                    tempC: null, precipitationProbability: 0, cloudCoverPercent: 0, isRainy: false
                }
            ]);
        });

        test('throws when the API returns an error', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ error: true, reason: 'Latitude must be in range of -90 to 90°' }));

            await expect(fetchTomorrowForecast(999, 151, 'UTC')).rejects.toThrow(/Latitude must be in range/);
        });
    });

    describe('fetchCurrentConditions', () => {
        test('requests latitude/longitude/current query params, no API key', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ current: { temperature_2m: 20, weather_code: 0 } }));

            await fetchCurrentConditions(-33, 151);

            const [url] = global.fetch.mock.calls[0];
            const parsed = new URL(url);
            expect(parsed.origin + parsed.pathname).toBe('https://api.open-meteo.com/v1/forecast');
            expect(parsed.searchParams.get('latitude')).toBe('-33');
            expect(parsed.searchParams.get('longitude')).toBe('151');
            expect(parsed.searchParams.get('current')).toBe('temperature_2m,weather_code');
            expect(parsed.searchParams.has('appid')).toBe(false);
        });

        test('returns rounded temperature and the WMO description for the weather code', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ current: { temperature_2m: 21.6, weather_code: 61 } }));

            const result = await fetchCurrentConditions(-33, 151);

            expect(result).toEqual({ tempC: 22, description: 'slight rain' });
        });

        test('returns a null description for an unrecognized weather code', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ current: { temperature_2m: 20, weather_code: 9999 } }));

            const result = await fetchCurrentConditions(-33, 151);

            expect(result.description).toBeNull();
        });

        test('throws when the API returns an error', async () => {
            global.fetch.mockResolvedValue(jsonResponse({ error: true, reason: 'bad request' }));

            await expect(fetchCurrentConditions(999, 151)).rejects.toThrow(/bad request/);
        });
    });
});
