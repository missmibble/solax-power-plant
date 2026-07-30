Here is the complete API reference for the SolaX Developer Portal, restructured into a single consumption-friendly reference document. I've organized every endpoint from the portal by functional category, using consistent field tables and compact JSON examples so it's easy to parse programmatically or paste into a project/context file.

---

# SolaX Cloud OpenAPI Reference

**Base URLs:** China IDC → `https://openapi-cn.solaxcloud.com` · Global IDC → `https://openapi-eu.solaxcloud.com` (account-specific URL shown under "My Account")

**Auth header (all endpoints except token issuance):** `Authorization: bearer {access_token}` (lowercase "bearer", one space, then the token)

**Standard response envelope:** `{ "code": <int>, "message": <string>, "result": <object|array>, "requestId": <string>, "traceId": <string> }` — `code=10000` (or `0` for auth endpoints) means success. `requestId` lets you poll command execution status via the Request Result Query endpoint. `traceId` is for support/troubleshooting.

`businessType` appears on almost every call: `1` = Residential, `4` = Commercial & Industrial (C&I).

---

## 1. Authentication

### 1.1 Obtain Access Token (Client Credentials)
`POST /openapi/auth/oauth/token`
Issues an app-level token valid ~30 days (calling other APIs does not extend it; re-call this to refresh).
- Body (`x-www-form-urlencoded`): `client_id` (req), `client_secret` (req), `grant_type=client_credentials` (req)
- Returns: `access_token`, `token_type`, `expires_in`, `scope`, `grant_type`, `auth_station` (plant scope; `all` under this grant type)

### 1.2 OAuth 2.0 Authorization Code Flow (Third-Party Login)
Lets an end user authorize a third-party app to access their SolaXCloud data.
- **Step A — get authorization code:** browser redirect to
  `{URL Domain}/openapi/auth/oauth/authorize?response_type=code&client_id={id}&redirect_uri={url}&scope={scope}&state={state}&lang={lang}`
  → SolaX redirects back to `{redirect_uri}?code={code}&state={state}`. Code is valid 10 minutes, single-use.
- **Step B — exchange code for token:** `POST /openapi/auth/oauth/token`
  Body: `client_id`, `client_secret`, `grant_type=authorization_code`, `code`, `redirect_uri`
  Returns: `access_token`, `refresh_token`, `token_type`, `expires_in` (86399s ≈ 24h), `scope`, `auth_station` (space-separated plant IDs the user authorized)

### 1.3 Refresh Access Token
`POST /openapi/auth/oauth/token`
- Header: `Authorization: basic {base64(client_id:client_secret)}`
- Body: `grant_type=refresh_token`, `refresh_token`
- Returns: same shape as 1.2's token response

---

## 2. Information Management

### 2.1 Query Plant Information
`GET /openapi/v2/plant/page_plant_info`
- Params: `plantId` (opt), `plantName` (opt), `pageNo` (opt, default 1), `businessType` (req)
- Returns (paginated `result`): `plantId`, `plantName`, `loginName`, `batteryCapacity` (kWh), `pvCapacity` (kWp), `createTime` (ISO8601 UTC), `plantTimeZone` (IANA), `plantState` (see Appendix 2), `plantAddress`, `longitude`, `latitude`, `electricityPriceUnit`

### 2.2 Query Device Information
`GET /openapi/v2/device/page_device_info`
- Params: `plantId` (opt), `deviceType` (req, Appendix 3), `deviceSn` (opt), `pageNo` (opt), `businessType` (req)
- Returns (paginated, shape depends on device type):
  - **Inverter:** `registerNo`, `deviceSn`, `deviceModel` (Appendix 4), `plantId`, `armVersion`, `dspVersion`, `ratedPower` (kW), `onlineStatus` (0/1), `flag` (Appendix 5)
  - **Battery:** `registerNo`, `deviceSn`, `deviceModel`, `plantId`, `softwareVersion`, `hardwareVersion`, `ratedCapacity` (Wh residential / kWh C&I), `onlineStatus`
  - **Meter:** `registerNo`, `deviceSn`, `deviceModel`, `plantId`, `onlineStatus`
  - **EV Charger:** `registerNo`, `deviceSn`, `deviceModel`, `plantId`, `armVersion`, `singleThreePhase` (0/1), `ratedPower`, `onlineStatus`

### 2.3 Query Master Device
`POST /openapi/v2/device/get_master_control_device`
For C&I systems — finds the top-level control device (typically EMS) for a given device; used before calling export/import control endpoints.
- Body: `{ deviceSn, deviceType, businessType }`
- Returns: `deviceSn`, `controlDeviceSn`, `controlDeviceType` (Appendix 3)

### 2.4 Obtain EMS System Attribute Info
`POST /openapi/v2/device/ems_system/attribute_info`
C&I only — retrieves the top EMS SN and system-level ratings.
- Body: `{ registerNo, plantId, deviceType: 100, businessType: 4 }`
- Returns (paginated `records`): `stationId`, `registerNo`, `deviceModel`, `deviceName`, `sysACRatedPower` (kW), `sysBatteryCapacity` (kWh), `sysPVRatedPower`, `sysPVRatedPowerSolaXPart`, `sysPVRatedPowerThirdPart` (kW)

---

## 3. EMS System Functions
*(Applies to all EMS systems except EMS1000 + X3-AELIO's AELIO-B100/B200 models)*

### 3.1 Query EMS System Real-Time Data
`POST /openapi/v2/device/ems_system/summary_data`
- Body: `{ deviceType: 100, businessType: 4, registerNoList: [1–10 SNs] }`
- Returns per SN: `registerNo`, `utcTime`, `plantLocalTime`, `sysDailyPVYield`/`sysTotalPVYield`, `sysDailyBatteryCharge`/`sysTotalBatteryCharge`, `sysDailyBatteryDischarge`/`sysTotalBatteryDischarge`, `sysDailyLoadConsumption`/`sysTotalLoadConsumption`, `sysDailyImportEnergy`/`sysTotalImportEnergy`, `sysDailyExportEnergy`/`sysTotalExportEnergy` (all kWh), `sysGridPower`/`sysPVPower`/`sysLoadPower`/`sysBatteryPower` (kW), `sysBatterySOC`/`sysBatterySOH` (%), `sysBatteryRemainings`/`sysBatteryCapacity` (kWh)

### 3.2 EMS System Incremental Data Query
`POST /openapi/v2/device/ems_system/increase_data`
- Body: `{ deviceType: 100, businessType: 4, registerNoList: [1–10], startTime, endTime (unix sec), timeInterval: 15|30|60 }`
- Returns per SN, an array of time slices: `timeSliceStart`, `pvYieldIncrease`, `batteryChargeYieldIncrease`, `batteryDischargeYieldIncrease`, `loadConsumptionYieldIncrease`, `gridImportYieldIncrease`, `gridExportYieldIncrease`, `gridPower`/`pvPower`/`loadPower`/`batteryPower` (period averages), `soc`, `soh`

### 3.3 EMS Work Mode Controls
All share body shape `{ deviceType: 100, businessType: 4, paramList: [{ registerNo, ...mode params }] }` and response shape `{ result: { [registerNo]: { status } } }` (status = Appendix 8).

| Mode | Endpoint | Extra params |
|---|---|---|
| Self Use | `POST /openapi/v2/device/ems_system/control/work_mode/self_use` | `dischargeCutOffSoc` [5-100], `chargeCutOffSoc` [10-100] |
| Manual | `POST /openapi/v2/device/ems_system/control/work_mode/manual` | `manualMode` (0=stop,1=force charge,2=force discharge), `power` (kW, req if 1/2), `targetSoc` [5-100] (req if 1/2) |
| Feed-in Priority | `POST /openapi/v2/device/ems_system/control/work_mode/feed_in` | `dischargeCutOffSoc` [10-100], `chargeCutOffSoc` [10-100] |
| Back Up | `POST /openapi/v2/device/ems_system/control/work_mode/back_up` | `dischargeCutOffSoc` [10-100], `chargeCutOffSoc` [10-100], `backupSoc` [5-100] |

*(Self Use / Feed-in / Back Up currently require special EMS 1000 / EMS 1000 PRO firmware.)*

### 3.4 EMS Power & Limit Controls
Same body/response pattern as 3.3.

| Function | Endpoint | Params |
|---|---|---|
| AC port power | `POST /openapi/v2/device/ems_system/control/power_control/ac` | `acPower` (kW; +discharge/−charge/0=idle) |
| PV & battery port power | `POST /openapi/v2/device/ems_system/control/power_control/pv_battery` | `pvPower` (kW, ≥0), `batteryPower` (kW; +discharge/−charge, optional) |
| Export limit | `POST /openapi/v2/device/ems_system/control/limit_control/export` | `isEnable` (0/1), `limitValue` (kW; must be 0 if offset used), `controlMode` (0=total,1=split-phase), `exportOffsetEnable`, `exportOffsetValue`, `exportOffsetMode` (1=range,2=target) |
| Import limit | `POST /openapi/v2/device/ems_system/control/limit_control/import` | `isEnable` (0/1), `limitValue` (kW), `controlMode` (0=reduce charge until standby,1=reduce charge + discharge if needed) |

---

## 4. Monitoring Management

### 4.1 Query Plant Real-Time Data
`GET /openapi/v2/plant/realtime_data` — Params: `plantId` (req), `businessType` (req)
Returns: `plantLocalTime`, `dailyYield`/`totalYield`, `dailyCharged`/`totalCharged`, `dailyDischarged`/`totalDischarged`, `dailyImported`/`totalImported`, `dailyExported`/`totalExported` (kWh), `dailyEarnings`/`totalEarnings` (plant currency)

### 4.2 Query Alarm Information
`GET /openapi/v2/alarm/page_alarm_info` — Params: `plantId` (req), `deviceSn` (opt), `alarmState` (req: 0=closed,1=ongoing), `pageNo` (opt), `businessType` (req)
Returns (paginated): `alarmStartTime`, `alarmEndTime`, `alarmName`, `errorCode`, `alarmType`, `alarmLevel`, `alarmState`, `deviceSn`, `registerNo`, `deviceType` (Appendix 3), `deviceModel` (Appendix 4)

### 4.3 Query Plant Statistics
`POST /openapi/v2/plant/energy/get_stat_data` — Body: `{ plantId, dateType: 1|2 (annual|monthly), date ("2025" or "2025-09"), businessType }`
Returns `plantEnergyStatDataList[]`: `date`, `pvGeneration`, `inverterACOutputEnergy`, `exportEnergy`, `importEnergy`, `loadConsumption`, `batteryCharged`, `batteryDischarged` (kWh), `earnings`; plus top-level `currencyCode`

### 4.4 Query Device Real-Time Data
`GET /openapi/v2/device/realtime_data` — Params: `snList` (1–10, comma-sep, req), `deviceType` (req), `requestSnType` (opt, battery-only disambiguation: 1=by inverter SN, 2=by battery SN), `businessType` (req)
Returns array, shape depends on device type:
- **Inverter:** `deviceSn`, `dataTime`, `plantLocalTime`, `registerNo`, `deviceStatus` (Appendix 6), `acVoltage1-3`, `acCurrent1-3`, `acFrequency1-3`, `acPower1-3`, `gridFrequency`, `totalActivePower` (+discharge/−charge), `totalReactivePower`, `totalPowerFactor`, `inverterTemperature`, `dailyYield`/`totalYield`, `dailyACOutput`/`totalACOutput`, `MPPTTotalInputPower`, `mpptMap` (per-MPPT voltage/current/power), `pvMap` (per-PV-string voltage/current/power), `gridPower`/`todayImportEnergy`/`totalImportEnergy`/`todayExportEnergy`/`totalExportEnergy` (meter 1, same set with `M2` suffix for meter 2), `EPSL1-3Voltage/Current/ActivePower/ApparentPower`, `l1l2Voltage`/`l2l3Voltage`/`l1l3Voltage`
- **Battery:** `deviceSn`, `dataTime`, `plantLocalTime`, `registerNo`, `deviceStatus`, `batterySOC`, `batteryRemainings` (kWh), `batterySOH`, `chargeDischargePower` (+charge/−discharge, W), `batteryVoltage`, `batteryCurrent`, `batteryTemperature`, `batteryCycleTimes`, `totalDevicCharge`/`totalDeviceDischarge` (kWh)
- **Meter:** `deviceSn`, `dataTime`, `plantLocalTime`, `registerNo`, `importEnergy`/`exportEnergy` (kWh), `totalActivePower` (+export/−import), `totalReactivePower`, `totalApparentPower`, `powerFactor`, `gridFrequency`, `l1-3ActivePower`, `l1-3ReactivePower`, `l1-3Voltage`, `l1-3Current`
- **EV Charger:** `deviceSn`, `dataTime`, `plantLocalTime`, `registerNo`, `deviceStatus` (Appendix 6), `deviceWorkingMode` (Appendix 7), `singlePhaseCurrent`, `l1-3Current`, `chargingPower`, `rfidnumber`, `chargingEnergyThisSession`, `totalChargeEnergy` (kWh), `chargingTimeThisSession` (s)

### 4.5 Query Device History Data
`GET /openapi/v2/device/history_data` — Params: `snList` (1–10, req), `deviceType` (req), `requestSnType` (opt, battery disambiguation as above), `startTime`/`endTime` (13-digit ms Unix timestamps; range ≤1 year, query span ≤12h), `timeInterval` (5|10|15|30|60 min, req), `businessType` (req)
Returns: same per-device-type field structures as 4.4, as a time-series array.

---

## 5. Inverter Control Inquiry

### 5.1 Request Result Query
`POST /openapi/apiRequestLog/listByCondition` — Body: `{ requestId }` (from any control command response)
Returns: `result[]` of `{ sn, status }` (status = Appendix 8) — use this to poll whether an async control command actually executed on the device.

---

## 6. Export Limit and Import Limit Setting
*(Inverter/system-level, distinct from the EMS-level versions in §3.4. Currently supported: NEO and EMS1000+AELIO only.)*

### 6.1 Export Limit Setting
`POST /openapi/v2/device/device_control/strategy/set_export_control`
- Body: `{ snList: [1–10], deviceType, isEnable (0/1), controlMode (1=overall, required if businessType=4), limitValue (kW, 2dp), businessType }`
- Returns: `{ [sn]: { status } }` (Appendix 8), `requestId`

### 6.2 Import Limit Setting
`POST /openapi/v2/device/device_control/strategy/set_import_control` — C&I EMS1000+AELIO only
- Body: `{ snList: [1–10], deviceType, isEnable (0/1), limitValue (kW), businessType }`
- Returns: same pattern as 6.1

---

## 7. Inverter Work Mode Control
*(All inverters except A1-Hybrid-G2, which has its own section §9. All share `{ snList: [1–10], businessType, ...mode fields }` → `{ [sn]: { status } }`, `requestId`.)*

| Mode | Endpoint | Key params |
|---|---|---|
| Self Use | `POST /openapi/v2/device/inverter_work_mode/batch_set_spontaneity_self_use` | `minSoc`, `chargeFromGridEnable` (0/1), `chargeUpperSoc`, `chargeStartTimePeriod1/2`, `chargeEndTimePeriod1/2`, `dischargeStartTimePeriod1/2`, `dischargeEndTimePeriod1/2` (hh:mm), `enableTimePeriod2` (0/1) |
| Feed-in Priority | `POST /openapi/v2/device/inverter_work_mode/batch_set_on_grid_first` | same charge/discharge time-window fields as Self Use, minus `chargeFromGridEnable` |
| Back Up | `POST /openapi/v2/device/inverter_work_mode/batch_set_peace_mode` | `minSoc`, `chargeFromGridEnable`, `chargeUpperSoc`, time windows, `enableTimePeriod2` |
| Manual | `POST /openapi/v2/device/inverter_work_mode/batch_set_manual_mode` | `manualMode` (0=stop,1=force charge,2=force discharge) — debugging use |

---

## 8. Inverter Function Settings

### 8.1 Battery Heating Settings
`POST /openapi/v2/device/config/battery/set_battery_heating`
- Body: `{ snList: [1–10], businessType, heatingEnable (0/1), heatingLevel (0/1/2 — activation temp/target temp/current thresholds, required if enabled), heatingPeriod1StartTime/EndTime (req if enabled), heatingPeriod2StartTime/EndTime (optional second window) }`
- Returns: `{ [sn]: { status } }`, `requestId`, `traceId`

---

## 9. Inverter Remote Control Mode (VPP)
*(All inverters except TRENE. Shared response pattern `{ [sn]: { status } }`, `requestId`.)*

| Mode | Endpoint | Params |
|---|---|---|
| Exit remote control | `POST /openapi/v2/device/inverter_vpp_mode/exit_vpp_mode` | `snList`, `businessType` only |
| Power Control | `POST /openapi/v2/device/inverter_vpp_mode/power_control_mode` | `activePowerTarget` (W), `wReactivePowerTarget` (Var), `timeOfDuration` (s) |
| Electric Quantity Target Control | `POST /openapi/v2/device/inverter_vpp_mode/electric_quantity_target_control_mode` | `targetEngergy` (Wh), `chargeDischargPower` (W, +charge/−discharge) |
| SOC Target Control | `POST /openapi/v2/device/inverter_vpp_mode/soc_target_control_mode` | `targetSoc`, `chargeDischargPower` (W, +charge/−discharge) |
| Push Power – Positive/Negative | `POST /openapi/v2/device/inverter_vpp_mode/push_power/positive_or_negative_mode` | `batteryPower` (W, +discharge/−charge), `timeOfDuration` (s), `nextMotion` (160=exit VPP,161=return to Self-Consume) |
| Push Power – Zero | `POST /openapi/v2/device/inverter_vpp_mode/push_power/zero_mode` | `timeOfDuration`, `nextMotion` |
| Self-Consume Charge/Discharge | `POST /openapi/v2/device/inverter_vpp_mode/self_consume/charge_or_discharge_mode` | `timeOfDuration`, `nextMotion` (default-like mode: PV-only charge, discharge per load) |
| Self-Consume Charge Only | `POST /openapi/v2/device/inverter_vpp_mode/self_consume/charge_only_mode` | `timeOfDuration`, `nextMotion` (no discharge allowed) |
| PV & BAT Individual – Duration | `POST /openapi/v2/device/inverter_vpp_mode/pv_and_bat/individual_setting_duration_mode` | `batteryPower` (W), `pvPowerLimit` (W, can be 0), `timeOfDuration`, `nextMotion` |
| PV & BAT Individual – Target SOC | `POST /openapi/v2/device/inverter_vpp_mode/pv_and_bat/individual_setting_target_soc_mode` | `batteryPower`, `pvPowerLimit`, `targetSoc` [1-100], `timeOfDuration`, `nextMotion` |

---

## 10. EV Charger Control
*(All share `{ snList: [1–10], businessType, ...params }` → `{ [sn]: { status } }`, `requestId`.)*

| Function | Endpoint | Params |
|---|---|---|
| Charging Scene | `POST /openapi/v2/device/evc_control/set_charge_scene` | `chargerScene` (0=HOME,1=OCPP,2=standard/solar), `ocppUrl` (≤128B, if OCPP), `ocppChargerId` (≤25B, if OCPP) |
| QR Code | `POST /openapi/v2/device/evc_control/set_evc_qr_code` | `qrCode` (≤255B string) |
| Work Mode | `POST /openapi/v2/device/evc_control/set_evc_work_mode` | `workMode` (0=STOP,1=FAST,2=ECO,3=GREEN), `currentGear`/`current` (GREEN: 3 or 6; ECO: 6/10/16/20/25; n/a for STOP/FAST) |
| Start Mode | `POST /openapi/v2/device/evc_control/set_evc_start_mode` | `startMode` (0=plug&charge,1=swipe card,2=app) |
| Charge/Discharge Command | `POST /openapi/v2/device/evc_control/set_evc_charge_command` | `workCmd` (0=lock,1=available,2=start,3=stop; lock only effective when unplugged) |
| Schedule Charging | `POST /openapi/v2/device/evc_control/set_evc_reserve_charge` | `chargeStartTime`, `chargeEndTime` (hh:mm), `chargeCurrent` (range depends on model: 7/22kW→[6,32], 11kW→[6,16], 6kW→[6,30]). Only works in solar/standard scene with APP start mode; start>end times are treated as cross-day, one-time execution |
| Current Limit | `POST /openapi/v2/device/evc_control/set_evc_current_limit` | `currentLimit` (model-dependent range: 4.6kW [6-20], 6kW [6-30], 7/7.6/22kW [6,32], 9.6kW [6-40], 11kW [6-16]) |

---

Here's the complete Attachment (Appendix) section from the SolaX Developer Portal, which contains all the code/enum reference tables used throughout the API responses.

## Appendix 1: Response Code Definitions
Global `code` field returned by most endpoints:

| Code | Meaning |
|---|---|
| 10000 | Operation successful |
| 10001 | Operation failed |
| 11500 | System busy, try again later |
| 10200 | Operation abnormal — see message field for details |
| 10400 | Request not authenticated |
| 10401 | Incorrect username/password |
| 10402 | access_token validation failed |
| 10403 | No access rights to this interface |
| 10404 | Callback function not configured |
| 10405 | API call quota exhausted |
| 10406 | API call rate limit reached, try again later |
| 10500 | User has no device data permission |
| 10505 | Device unauthorized |
| 10506 | Plant unauthorized |

## Appendix 2: plantState Field
Meaning depends on businessType:

Residential (businessType=1): 0 = Connecting, 1 = Offline, >1 = Online
Commercial & Industrial (businessType=4): 0 = Offline, 1 = Normal, 2 = Failure (emergency alarm), 3 = Warning (general alarm), 4 = Connecting

## Appendix 3: deviceType Field
1 = Inverter, 2 = Battery, 3 = Meter, 4 = EV Charger, 100 = EMS System

## Appendix 4: deviceModel Field
This is a large lookup table mapping numeric `deviceModel` values to specific hardware model names, split by businessType.

**Residential (businessType=1):**
Inverters (deviceType=1) span values 1–109, covering families such as X1-LX, X-Hybrid, X1/X3-Hybrid generations (G1–G4), X1-Boost/Air/Mini, X3-20K/30K, X3-MIC/PRO (and G2/G3), X1-Smart (and G2), X1-AC, the A1 series (A1-Hybrid, A1-FIT, A1, A1-HYB-G2/G3, A1-AC-G2, A1-SMT-G2, A1-Micro), J1-ESS (and HB-2), X3-AELIO (incl. LA variant), X1-SPT, X3-IES/X1-IES/C3-IES/X3-IES-A/X1-IES-A/X3-IES-P, X3-ULT (and GLV), X1-VAST, J3-ULT variants, X1-Micro/X-MS 2700, OG, LVE, AEGIS, and newer X3-FTH/MGA-G2/GRAND-HV/FORTH-PLUS and X1-Hybrid-LV/Lite-LV models.
Meters (deviceType=3): 50 = Meter X, 176 = M1-40, 178 = M3-40, 179 = M3-40-Dual, 181 = M3-40-Wide.
EV Chargers (deviceType=4): 1 = X1/X3-EVC, 2 = X1/X3-EVC G1.1, 3 = X1/X3-HAC, 4 = J1-EVC, 5 = A1-HAC, 6 = C1/C3-HAC.

**Commercial & Industrial (businessType=4):**
Inverters (deviceType=1): 1/31/42 = X3-AELIO, 2 = X3-TRENE-100KI, 3 = X3-TRENE-100K, 4 = X3-TRENE, 16 = X3-PRO G2, 100 = X3-FORTH, 101 = X3-MEGA G2, 104 = X3-GRAND, 105 = X3-FORTH PLUS.
Batteries (deviceType=2): 1 = TB-HR140, 2 = TB-HR522, 145 = TSYS-HS51, 163 = TR-HR140.
Meters (deviceType=3): 0–3 = DTSU666-CT, 4–5 = Wi-BR DTSU666-CT, 6 = CT, 7 = DTSU666-CT, 8 = UMG 103-CBM, 9 = M3-40-Dual, 10 = M3-40, 11 = PRISMA-310A.
EV Chargers (deviceType=4): same mapping as residential (1–6 above).

## Appendix 5: flag Field (Parallel/Master-Slave Status)
Residential: 0 = Not in parallel, 1 = Master, 2–4 = Slave 1–3
C&I: null = Not in parallel, 0 = Master, 1 = Slave

## Appendix 6: deviceStatus Field
**Inverter (deviceType=1)** — a large state list including: 100 Waiting, 101 Self-check, 102 Normal, 103 Fault (recoverable), 104 Permanent Fault, 105 Update Mode, 106 EPS Check Mode, 107 EPS Mode, 108 Self Test, 109 Idle Mode, 110 Standby, 111 Pv Wake Up Bat Mode, 112 Gen Check Mode, 113 Gen Run Mode, 114 RSD Standby; 130 VPP Mode, 131–135 TOU sub-states (Self use/Charging/Discharging/Battery off/Peak Shaving), 136–139 Gen/battery-expansion/heating normal modes, 140 Start Mode, 141–147 Normal Mode (R-1 to R-7); 150 Self Use, 151 Force Time Use, 152 Back Up Mode, 153 Feed-in Priority, 154 Demand Mode, 155 ConstPower Mode, 160 OpenAdr Mode, 170 Stop Mode, 171 Debug Mode, 174–177 Smart self-use/feed-in/no-discharge/WLV-0% normal states; 1301–1309 correspond directly to the VPP remote-control modes (Power Control, Electric Quantity Target, SOC Target, Push Power Positive/Negative, Push Power Zero, Self-Consume Charge/Discharge, Self-Consume Charge Only, PV&BAT Duration, PV&BAT Target SOC).

**Battery (deviceType=2)** — Residential: 0 = Idle, 1 = Work. C&I: 0 = Idle (discharge self-check), 1 = Standby, 2 = Discharge Pre-Charge, 3 = Charge-to-discharge pre-charge, 4 = Discharging, 5 = Discharging Fault, 6 = Charge switching current limit, 7 = Charge Self-Test, 8 = Charge Pre-Charge, 9 = Charging, 10 = Charging Fault, 11 = Power Off Status.

**EV Charger (deviceType=4)** — 0 Available, 1 Preparing, 2 Charging, 3 Finish, 4 Faulted, 5 Unavailable, 6 Reserved, 7 SuspendedEV, 8 SuspendedEVSE, 9 Update, 10 CardActivation, 11 StartDelay, 12 ChargPause, 13 Stopping.

## Appendix 7: deviceWorkingMode Field (EV Charger)
0 = STOP, 1 = FAST, 2 = ECO, 3 = GREEN

## Appendix 8: Command Delivery status Field
Used in every control-command response to indicate execution state:
1 = Device Offline, 2 = Command issuance failed, 3 = Command issuance succeeded, 4 = Device received and started execution, 5 = Device execution failed, 6 = Execution timed out

---