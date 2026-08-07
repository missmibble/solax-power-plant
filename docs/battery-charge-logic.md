# Battery charge control — rules

`BatteryControlFunction` (`lambda/BatteryControlFunction/BatteryControlFunction.js`). `dryRun: true` is the default — no SolaX call is made unless `dryRun` resolves to `false` (config or dashboard override).

## Schedule

One Lambda, two EventBridge rules, dispatched on `event.phase`:

| Phase | Trigger | Time |
|---|---|---|
| `decide` (default — no `phase`, or anything but `'exitDischarge'`) | `cron(0 11 * * ? *)` | 21:00 Brisbane |
| `exitDischarge` | `cron(55 13 * * ? *)` | 23:55 Brisbane |

`appliesToDate` (stored on the record) = tomorrow's local calendar date (`Australia/Brisbane`) at the moment `decide` runs.

## Order of assessment — `decide` (~21:00)

1. **Resolve effective settings**: dashboard override row (`BATTERY_CONTROL_SETTINGS#<inverterSn>`, `Timestamp = 0`) merged over `config.batteryControl`. An unset field in the override falls back to the config value.
2. **Assess previous decision** (see "Previous-decision accuracy assessment" below) — result is informational only, attached to this run's record.
3. **Decide tonight's `chargeUpperSoc`**:
   - `enabled: false` → `classification = 'disabled'`, `chargeUpperSoc = disabledChargeUpperSoc`. No weather call.
   - `enabled: true` → fetch tomorrow's forecast, classify it (see below), map to `chargeUpperSoc{Sunny|PartlyCloudy|Overcast}`.
4. **Surplus discharge check** (only when `enabled: true`) — compare the latest battery SOC reading against the `chargeUpperSoc` decided in step 3:
   - `surplus = currentSoc - chargeUpperSoc`
   - `surplus < minSurplusPercent` (default 5 points), or no SOC reading available → no discharge.
   - `surplus ≥ minSurplusPercent` → discharge triggered.
5. **Apply**, gated by `dryRun`:
   - Discharge triggered → call SOC Target Control (see below). Self Use mode is **not** set this run.
   - No discharge → call Self Use mode immediately with tonight's `chargeUpperSoc`.
6. **Persist** the decision (`BATTERY_CONTROL#<inverterSn>`): classification, `chargeUpperSoc`, `dryRun`, `applied`, `enabled`, `appliesToDate`, `previousAssessment`, `dischargeApplied`, `dischargeSurplusPercent`.

## Order of assessment — `exitDischarge` (~23:55)

7. Read tonight's decision record. No-op unless `dischargeApplied: true` and the record is < 4 hours old.
8. Exit VPP mode, then call Self Use mode with the `chargeUpperSoc` step 3 decided. Merge `dischargeExitApplied` onto the same record.

## Forecast classification

Inputs, computed across tomorrow's Open-Meteo hourly slots (local calendar day):

- `hasRainCondition` — any slot's `isRainy` true
- `maxRainChance` — max `precipitationProbability` across all slots
- `avgClouds` — average `cloudCoverPercent` across all slots

```
no forecast data at all           → overcast
hasRainCondition OR maxRainChance ≥ 0.4 OR avgClouds ≥ 70%  → overcast
avgClouds ≤ 30% AND maxRainChance < 0.2  → sunny
else                               → partly-cloudy
```

| Classification | `chargeUpperSoc` | Default |
|---|---|---|
| `sunny` | `chargeUpperSocSunny` | 40% |
| `partly-cloudy` | `chargeUpperSocPartlyCloudy` | 70% |
| `overcast` | `chargeUpperSocOvercast` | 100% |
| `disabled` | `disabledChargeUpperSoc` | 100% |

## Self Use mode request (`batch_set_spontaneity_self_use`)

Full-replace write — sent in full every time, only `chargeUpperSoc` varies:

```
{ minSoc, chargeFromGridEnable, chargeUpperSoc,
  chargeStartTimePeriod1, chargeEndTimePeriod1, chargeStartTimePeriod2, chargeEndTimePeriod2,
  dischargeStartTimePeriod1, dischargeEndTimePeriod1, dischargeStartTimePeriod2, dischargeEndTimePeriod2,
  enableTimePeriod2 }
```

Fixed values (`config.batteryControl`, not dashboard-editable):

| Field | Value |
|---|---|
| `minSoc` | 10% |
| `chargeFromGridEnable` | 1 (on) |
| `chargeStartTimePeriod1` / `chargeEndTimePeriod1` | 00:00 / 06:00 |
| `chargeStartTimePeriod2` / `chargeEndTimePeriod2` | unused (00:00 / 00:00) |
| `dischargeStartTimePeriod1` / `dischargeEndTimePeriod1` | 00:00 / 23:59 |
| `dischargeStartTimePeriod2` / `dischargeEndTimePeriod2` | unused (00:00 / 00:00) |
| `enableTimePeriod2` | 0 (off) |
| `chargeUpperSoc` | decided nightly — see classification table above |

## Surplus discharge (~21:00–23:55 window)

Trigger: current battery SOC exceeds tonight's `chargeUpperSoc` by ≥ `minSurplusPercent`.

**Discharge call**, at `decide`, SOC Target Control (`soc_target_control_mode`):

```
{ snList, businessType, targetSoc: chargeUpperSoc, chargeDischargPower: -maxDischargePowerW }
```

`chargeDischargPower` is negative for discharge. Holds the inverter in VPP override indefinitely — no automatic exit.

**Exit call**, at `exitDischarge`, only if a discharge was engaged that evening:

1. `exit_vpp_mode`: `{ snList, businessType }`
2. Self Use mode request (above), with the same `chargeUpperSoc` `decide` computed, so the 00:00–06:00 window starts from the normal schedule.

| Setting | Value | Dashboard-editable |
|---|---|---|
| `minSurplusPercent` | 5 points | No |
| `maxDischargePowerW` | 3000 W | No |

## Previous-decision accuracy assessment

Each `decide` run, before deciding tonight's target: looks up the last stored decision and the readings since, and asks Bedrock (`config.bedrock.modelId`, skipped if unset) to judge it — `{accurate, assessment, usageShouldInfluence, usageNote}`. Stored as `previousAssessment` on this run's record; never feeds back into tonight's own decision. Usage summary includes `byWindow` (import/export per tariff window) and battery SOC range when available.

## Dry run vs. live

- `dryRun: true` (default): computes forecast/classification/discharge-check, logs, emails "DRY RUN" — never calls SolaX, in either phase or either branch.
- `dryRun: false`: calls SolaX for real at each applicable step, emails "applied".
- Any failure → publishes to the alerts SNS topic and the Lambda errors (`BatteryControlFunctionErrorAlarm`).

## Dashboard-editable settings

Row: `BATTERY_CONTROL_SETTINGS#<inverterSn>`, `Timestamp = 0` (single upserted row, not time-series).

| Editable | Not editable (config-only) |
|---|---|
| `chargeUpperSocSunny` | `minSoc` |
| `chargeUpperSocPartlyCloudy` | `chargeFromGridEnable` |
| `chargeUpperSocOvercast` | charge/discharge time windows |
| `disabledChargeUpperSoc` | `minSurplusPercent` |
| `enabled` | `maxDischargePowerW` |
| `dryRun` | |

## Weather data

Open-Meteo, no API key:

```
GET https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}
    &hourly=temperature_2m,precipitation_probability,precipitation,cloud_cover
    &timezone={tz}&start_date={tomorrow}&end_date={tomorrow}
```

Normalized to `{timestampSeconds, tempC, precipitationProbability, cloudCoverPercent, isRainy}` per slot by `powerplant-shared`'s `fetchTomorrowForecast`.
