# PV Status Panel — Design

## Purpose

The dashboard has a "Current Battery Status" panel showing live instantaneous
battery values (SOC, charging/discharging state + power, temperature,
remaining capacity). There's no equivalent for the PV side — the only solar
figures shown today are the accumulated PV Yield card (a range-dependent
delta) and the nightly weather/charge-decision widgets. This adds a "Current
PV Status" panel, mirroring the battery panel's structure and always
reflecting the latest poll regardless of the day/week range toggle.

## Data changes — `PollerFunction.js`

SolaX's `getDeviceRealtimeData` call for the Inverter device already returns
two fields this app doesn't currently persist:

- `MPPTTotalInputPower` — instantaneous PV DC input power (W). Stored under
  its literal SolaX API field name, matching this file's existing convention
  for passthrough fields (e.g. `totalDeviceCharge`).
- `inverterTemperature` — °C.

Both are added to the `PutCommand` item alongside the existing
`dailyYield`/`totalYield`/`deviceStatus`/etc. No new SolaX API call — these
fields are already in the response object PollerFunction has in hand, just
not written to DynamoDB yet.

Readings taken before this change ships won't have either field — downstream
handles that the same way it already handles a reading with no battery
fields (see below).

## `DashboardApiFunction.js` — `pvSummary`

New helper, called from `aggregateReadings` the same way `batterySummary(first,
last)` is today, spread into the `/readings` response:

```js
function pvSummary(last) {
  if (typeof last.MPPTTotalInputPower !== 'number') {
    return {};
  }

  return {
    currentPvPowerW: last.MPPTTotalInputPower,
    currentPvStatus: classifyPvStatus(last.deviceStatus, last.MPPTTotalInputPower),
    todayPvYieldKwh: last.dailyYield,
    inverterTemperatureC: typeof last.inverterTemperature === 'number' ? last.inverterTemperature : null
  };
}
```

Gated on `MPPTTotalInputPower` being a number — same backward-compat pattern
as `batterySummary`'s gate on `currentBatterySOC`, so a pre-deploy reading
(or any reading where the field is otherwise missing) just omits these keys
and the dashboard hides the panel rather than showing broken values.

`classifyPvStatus(deviceStatus, powerW)`:
- `'fault'` if `deviceStatus` is `103` (recoverable) or `104` (permanent) —
  the same two codes `AlertFunction.checkInverterFault` already treats as
  real faults. Nothing else in the inverter's large state list (Appendix 6)
  is a fault, it's operating-mode noise — consistent with how the rest of
  this app already treats that enum.
- else `'producing'` if `powerW > 0`
- else `'idle'`

## Dashboard (`dashboard/index.html` / `app.js` / `styles.css`)

New section, placed directly **above** the existing battery-status panel
(PV → battery mirrors the actual energy flow: generate, then store/discharge):

```html
<section class="pv-status-panel" id="pvStatusPanelSection" hidden>
  <h2>Current PV Status</h2>
  <div class="cards">
    <div class="card">
      <span class="card-label">PV Power</span>
      <span class="card-value" id="livePvPower">–</span>
    </div>
    <div class="card">
      <span class="card-label">Status</span>
      <span class="card-value" id="livePvStatus">–</span>
    </div>
    <div class="card">
      <span class="card-label">Today's Yield</span>
      <span class="card-value" id="livePvTodayYield">–</span>
    </div>
    <div class="card">
      <span class="card-label">Inverter Temp</span>
      <span class="card-value" id="liveInverterTemperature">–</span>
    </div>
  </div>
</section>
```

`.pv-status-panel` CSS mirrors `.battery-status-panel` exactly (margin-top +
h2 sizing) — reuses the existing `.cards`/`.card` grid, no new layout rules
needed.

`app.js`: a `renderLivePvStatus(data)` function, structured like
`renderLiveBatteryStatus`, called from `render(data)` right before (so it
renders above) the battery call. Hides the section when
`typeof data.currentPvPowerW !== 'number'`. Status label formatting mirrors
`formatBatteryStatusLabel`: Producing ☀️ / Idle ⏸️ / Fault ⚠️. Power shown as
`(currentPvPowerW / 1000).toFixed(2)` kW to match the battery panel's kW
formatting.

## Testing

- `test/poller-function.test.js`: assert `MPPTTotalInputPower` and
  `inverterTemperature` are stored on the reading item.
- `test/dashboard-api-function.test.js`: `pvSummary`/`classifyPvStatus` —
  producing (power > 0, normal deviceStatus), idle (power = 0, normal
  deviceStatus), fault (deviceStatus 103 and 104, regardless of power), and
  the backward-compat case where `MPPTTotalInputPower` is absent (function
  returns `{}`, panel fields undefined on the response).

## Out of scope

- No changes to `ReportFunction`/`BatteryControlFunction`/AI insights — this
  is a dashboard-only, read-path addition.
- No per-MPPT or per-PV-string breakdown (`mpptMap`/`pvMap`) — total power
  only, matching the battery panel's level of detail.
