'use strict';

/**
 * SolaX Cloud OpenAPI client — covers Authentication, Information Management,
 * and Monitoring Management only (solax-apis.md §1, §2, §4).
 *
 * Deliberately excludes every control/write endpoint (EMS work mode & power
 * controls, export/import limits, inverter work mode control, battery heating,
 * VPP remote control, EV charger control, A1-Hybrid-G2 work mode) — this app
 * only monitors and recommends, it doesn't change device behaviour. Add those
 * later, from solax-apis.md §3 and §6-11, if the app needs to apply its own
 * recommendations automatically.
 *
 * solax-apis.md is truncated mid-§11 and never includes Appendices 1-8 (device
 * type/model codes, flag/status/alarm codes), so DEVICE_TYPE below only
 * contains the values confirmable from the doc's own worked examples —
 * anything else must be confirmed against the full portal reference first.
 */

const BASE_URLS = {
    cn: 'https://openapi-cn.solaxcloud.com',
    eu: 'https://openapi-eu.solaxcloud.com'
};

const BUSINESS_TYPE = {
    RESIDENTIAL: 1,
    COMMERCIAL_INDUSTRIAL: 4
};

const DEVICE_TYPE = {
    INVERTER: 1, // confirmed via solax-application-creds.txt's worked page_device_info example
    EMS: 100 // stated directly in solax-apis.md's EMS System Functions request bodies
    // BATTERY / METER / EV_CHARGER codes are in Appendix 3, not present in solax-apis.md.
};

let cachedToken = null; // { accessToken, expiresAt } — reused across warm Lambda invocations

async function getAccessToken({ baseUrl, clientId, clientSecret }) {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
        return cachedToken.accessToken;
    }

    const response = await fetch(`${baseUrl}/openapi/auth/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'client_credentials'
        })
    });

    const payload = await response.json();
    if (payload.code !== 0 && payload.code !== 10000) {
        throw new Error(`SolaX auth failed: code=${payload.code} message=${payload.message}`);
    }

    cachedToken = {
        accessToken: payload.result.access_token,
        expiresAt: Date.now() + payload.result.expires_in * 1000
    };

    return cachedToken.accessToken;
}

async function callApi(baseUrl, accessToken, method, path, { query, body } = {}) {
    const url = new URL(path, baseUrl);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, value);
        }
    }

    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });

    const payload = await response.json();
    if (payload.code !== 0 && payload.code !== 10000) {
        throw new Error(
            `SolaX API error: path=${path} code=${payload.code} message=${payload.message} requestId=${payload.requestId}`
        );
    }

    return payload.result;
}

// ─── 2. Information Management ─────────────────────────────────────────────

function getPlantInfo(baseUrl, accessToken, { plantId, plantName, pageNo, businessType } = {}) {
    return callApi(baseUrl, accessToken, 'GET', '/openapi/v2/plant/page_plant_info', {
        query: { plantId, plantName, pageNo, businessType }
    });
}

function getDeviceInfo(baseUrl, accessToken, { plantId, deviceType, deviceSn, pageNo, businessType }) {
    return callApi(baseUrl, accessToken, 'GET', '/openapi/v2/device/page_device_info', {
        query: { plantId, deviceType, deviceSn, pageNo, businessType }
    });
}

// ─── 4. Monitoring Management ──────────────────────────────────────────────

function getPlantRealtimeData(baseUrl, accessToken, { plantId, businessType }) {
    return callApi(baseUrl, accessToken, 'GET', '/openapi/v2/plant/realtime_data', {
        query: { plantId, businessType }
    });
}

function getAlarmInfo(baseUrl, accessToken, { plantId, deviceSn, alarmState, pageNo, businessType }) {
    return callApi(baseUrl, accessToken, 'GET', '/openapi/v2/alarm/page_alarm_info', {
        query: { plantId, deviceSn, alarmState, pageNo, businessType }
    });
}

function getPlantStatistics(baseUrl, accessToken, { plantId, dateType, date, businessType }) {
    return callApi(baseUrl, accessToken, 'POST', '/openapi/v2/plant/energy/get_stat_data', {
        body: { plantId, dateType, date, businessType }
    });
}

function getDeviceRealtimeData(baseUrl, accessToken, { snList, deviceType, requestSnType, businessType }) {
    return callApi(baseUrl, accessToken, 'GET', '/openapi/v2/device/realtime_data', {
        query: {
            snList: Array.isArray(snList) ? snList.join(',') : snList,
            deviceType,
            requestSnType,
            businessType
        }
    });
}

function getDeviceHistoryData(
    baseUrl,
    accessToken,
    { snList, deviceType, requestSnType, startTime, endTime, timeInterval, businessType }
) {
    return callApi(baseUrl, accessToken, 'GET', '/openapi/v2/device/history_data', {
        query: {
            snList: Array.isArray(snList) ? snList.join(',') : snList,
            deviceType,
            requestSnType,
            startTime,
            endTime,
            timeInterval,
            businessType
        }
    });
}

module.exports = {
    BASE_URLS,
    BUSINESS_TYPE,
    DEVICE_TYPE,
    getAccessToken,
    getPlantInfo,
    getDeviceInfo,
    getPlantRealtimeData,
    getAlarmInfo,
    getPlantStatistics,
    getDeviceRealtimeData,
    getDeviceHistoryData
};
