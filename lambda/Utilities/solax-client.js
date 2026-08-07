'use strict';

/**
 * SolaX Cloud OpenAPI client — covers Authentication, Information Management,
 * and Monitoring Management (docs/solax-apis.md §1, §2, §4), plus two
 * control/write endpoints: §7 Inverter Work Mode Control's Self Use mode
 * (`batch_set_spontaneity_self_use`), used by BatteryControlFunction to adjust
 * the grid-charge target based on tomorrow's weather forecast; and §9 VPP
 * Remote Control's SOC Target Control mode (`soc_target_control_mode`) plus
 * Exit VPP mode (`exit_vpp_mode`), also used by BatteryControlFunction to
 * pre-emptively discharge surplus SOC (above tonight's charge target) to the
 * grid before the overnight charge window opens.
 *
 * Every other control/write endpoint (§3 EMS work modes, §6 export/import
 * limits, §8 battery heating, the rest of §9 VPP remote control, §10 EV
 * charger control, §11 A1-Hybrid-G2 work mode) is deliberately unimplemented —
 * this app only monitors/recommends beyond those two exceptions. §9 VPP
 * Remote Control was originally implemented here for GridDischargeFunction's
 * grid-export arbitrage (removed once the premium feed-in window it depended
 * on was confirmed unavailable from this site's retailer) — re-added for
 * BatteryControlFunction's simpler surplus-discharge rule, which needs no
 * premium rate to be worthwhile.
 */

const BASE_URLS = {
    cn: 'https://openapi-cn.solaxcloud.com',
    eu: 'https://openapi-eu.solaxcloud.com'
};

const BUSINESS_TYPE = {
    RESIDENTIAL: 1,
    COMMERCIAL_INDUSTRIAL: 4
};

// docs/solax-apis.md Appendix 3
const DEVICE_TYPE = {
    INVERTER: 1,
    BATTERY: 2,
    METER: 3,
    EV_CHARGER: 4,
    EMS: 100
};

// docs/solax-apis.md Appendix 6 — only the fault-relevant/common states are named
// here; the full list (TOU/VPP sub-states etc.) is in the doc if ever needed.
const DEVICE_STATUS = {
    INVERTER: {
        WAITING: 100,
        SELF_CHECK: 101,
        NORMAL: 102,
        FAULT_RECOVERABLE: 103,
        FAULT_PERMANENT: 104,
        UPDATE_MODE: 105,
        EPS_CHECK_MODE: 106,
        EPS_MODE: 107,
        SELF_TEST: 108,
        IDLE_MODE: 109,
        STANDBY: 110
    },
    // Residential batteries only report Idle/Work — the fuller Charging/
    // Discharging/Fault state machine in Appendix 6 is C&I-only.
    BATTERY_RESIDENTIAL: { IDLE: 0, WORK: 1 },
    EV_CHARGER: {
        AVAILABLE: 0,
        PREPARING: 1,
        CHARGING: 2,
        FINISH: 3,
        FAULTED: 4,
        UNAVAILABLE: 5,
        RESERVED: 6,
        SUSPENDED_EV: 7,
        SUSPENDED_EVSE: 8,
        UPDATE: 9,
        CARD_ACTIVATION: 10,
        START_DELAY: 11,
        CHARGE_PAUSE: 12,
        STOPPING: 13
    }
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

// ─── 7. Inverter Work Mode Control (Self Use only — see file header) ───────

// batch_set_spontaneity_self_use has no read-back counterpart, and this is a
// full-replace write: every field below is required on every call, not just
// the one being changed. Callers own supplying a complete, correct object —
// see BatteryControlFunction.buildSelfUseModeRequest.
function setInverterSelfUseMode(baseUrl, accessToken, {
    snList,
    businessType,
    minSoc,
    chargeFromGridEnable,
    chargeUpperSoc,
    chargeStartTimePeriod1,
    chargeEndTimePeriod1,
    chargeStartTimePeriod2,
    chargeEndTimePeriod2,
    dischargeStartTimePeriod1,
    dischargeEndTimePeriod1,
    dischargeStartTimePeriod2,
    dischargeEndTimePeriod2,
    enableTimePeriod2
}) {
    return callApi(baseUrl, accessToken, 'POST', '/openapi/v2/device/inverter_work_mode/batch_set_spontaneity_self_use', {
        body: {
            snList: Array.isArray(snList) ? snList : [snList],
            businessType,
            minSoc,
            chargeFromGridEnable,
            chargeUpperSoc,
            chargeStartTimePeriod1,
            chargeEndTimePeriod1,
            chargeStartTimePeriod2,
            chargeEndTimePeriod2,
            dischargeStartTimePeriod1,
            dischargeEndTimePeriod1,
            dischargeStartTimePeriod2,
            dischargeEndTimePeriod2,
            enableTimePeriod2
        }
    });
}

// ─── 9. Inverter Remote Control Mode (VPP) — SOC Target Control + Exit only ─
// (see file header — every other VPP sub-mode is still unimplemented)

// chargeDischargPower here is +charge/-discharge (docs/solax-apis.md §9) —
// the OPPOSITE sign convention from the Push Power VPP modes' batteryPower
// (+discharge/-charge). Easy to get backwards; BatteryControlFunction always
// passes a negative value to discharge toward targetSoc.
function setInverterSocTargetMode(baseUrl, accessToken, { snList, businessType, targetSoc, chargeDischargPower }) {
    return callApi(baseUrl, accessToken, 'POST', '/openapi/v2/device/inverter_vpp_mode/soc_target_control_mode', {
        body: {
            snList: Array.isArray(snList) ? snList : [snList],
            businessType,
            targetSoc,
            chargeDischargPower
        }
    });
}

// SOC Target Control has no built-in duration/exit — the inverter holds in
// VPP override until told otherwise, so this must always be called to hand
// control back to the inverter's normal Self Use schedule.
function exitVppMode(baseUrl, accessToken, { snList, businessType }) {
    return callApi(baseUrl, accessToken, 'POST', '/openapi/v2/device/inverter_vpp_mode/exit_vpp_mode', {
        body: {
            snList: Array.isArray(snList) ? snList : [snList],
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
    DEVICE_STATUS,
    getAccessToken,
    getPlantInfo,
    getDeviceInfo,
    getPlantRealtimeData,
    getAlarmInfo,
    getPlantStatistics,
    getDeviceRealtimeData,
    getDeviceHistoryData,
    setInverterSelfUseMode,
    setInverterSocTargetMode,
    exitVppMode
};
