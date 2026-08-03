# Automated rules — configuration at a glance

Every automated decision this app makes, and the exact current setting driving it, in one place. Each function also has its own logic reference with full reasoning and worked examples — this doc is the quick-reference companion, not a replacement:

- [docs/battery-charge-logic.md](battery-charge-logic.md) — `BatteryControlFunction`
- [docs/grid-discharge-logic.md](grid-discharge-logic.md) — `GridDischargeFunction`
- [docs/settings-optimizer-logic.md](settings-optimizer-logic.md) — `SettingsOptimizerFunction`

Values below are the real deployed defaults (`config/dev-powerplant.local.json`), noted wherever the public template (`config/dev-powerplant.json`) differs. Dashboard-editable fields (via `/battery-settings`, `/grid-discharge-settings`, or `/settings-optimizer-settings`) are marked **[editable]** — those can currently be at a different, human- or `SettingsOptimizerFunction`-set value without a redeploy; the config value is only the fallback when no override row exists. The Battery Control Settings panel now badges each value with where it actually came from (blank for a human-set value, "default" for an untouched config fallback, "AI recommended" for something `SettingsOptimizerFunction` auto-applied) — see docs/settings-optimizer-logic.md's `sources` mechanics. All AI-driven output — the nightly narrative, the battery-decision accuracy check, and this function's own recommendation (`GET /settings-optimization`, updated nightly now, not weekly) — plus the "Full automation" toggle live together on one consolidated AI card, rather than scattered across separate widgets.

## Tariff (`config.tariff`, `config.location.timezone`)

All times local (`Australia/Brisbane`, fixed UTC+10, no DST).

| Window | Hours | Import rate | Label |
|---|---|---|---|
| Overnight grid-charge | 00:00–06:00 | $0.08/kWh | `night-ev-charge` |
| Shoulder morning | 06:00–09:00 | $0.32384/kWh | `shoulder-morning` |
| Off-peak midday | 09:00–16:00 | $0.20141/kWh | `offpeak-midday` |
| **Peak evening** | 16:00–21:00 | **$0.41756/kWh** | `peak-evening` |
| Shoulder night | 21:00–24:00 | $0.32384/kWh | `shoulder-night` |

Feed-in: flat **$0.02/kWh** all day, except a retailer premium **$0.27/kWh from 17:00–21:00** (`gridDischarge.peakFeedInRate`) — the arbitrage `GridDischargeFunction` exploits. `ReportFunction`'s cost assessment does not yet apply the premium rate to exports it values (known gap, see grid-discharge-logic.md).

## AlertFunction — anomaly rules

| Rule | Value | Behavior |
|---|---|---|
| Import-delta threshold | **0.5 kWh** between consecutive 5-min readings (`IMPORT_THRESHOLD_KWH`, code default, not config-driven) | Publishes an alert, *except* during the `night-ev-charge` window (00:00–06:00) where a jump is expected |
| Inverter fault codes | `deviceStatus` **103** (recoverable) or **104** (permanent) | Publishes an alert on entry/change into either state |

Runs on every DynamoDB Stream `INSERT` (i.e. every 5-minute poll).

## ReportFunction — nightly recommendation heuristic

| Rule | Value |
|---|---|
| Peak-window import threshold | **> 0.5 kWh** imported during `peak-evening` (16:00–21:00) triggers a "hold charge for peak" recommendation instead of exporting earlier |
| Lookback window | Last **1 day** of readings (`REPORT_LOOKBACK_DAYS`, code default) |
| AI narrative history | Last **14 days**, bucketed by local calendar day (`bedrock.historyLookbackDays`) |
| Nightly schedule | **cron(0 16 \* \* ? \*)** = 02:00 Brisbane (sends email) |
| Refresh schedule | **cron(0 0,4,8,12,16,20 \* \* ? \*)** = every 4h (no email, dashboard-only) |

When SOC data is available for the peak window, further distinguishes "already depleted before peak started" (→ raise charge target) from "ran flat during peak" (→ raise discharge cutoff/capacity).

## BatteryControlFunction — overnight charge target

| Rule | Value |
|---|---|
| Forecast classification | Tomorrow's Open-Meteo hourly slots → `sunny`, `partly-cloudy`, or `overcast` |
| Charge target if sunny **[editable]** | `chargeUpperSocSunny` = **40%** |
| Charge target if partly cloudy **[editable]** | `chargeUpperSocPartlyCloudy` = **70%** — the ambiguous-forecast middle ground, added so an uncertain-but-not-bad forecast doesn't default to a full grid charge it usually doesn't need |
| Charge target if overcast **[editable]** | `chargeUpperSocOvercast` = **100%** |
| Charge target if disabled **[editable]** | `disabledChargeUpperSoc` = **100%** |
| Minimum SOC floor | `minSoc` = **10%** (not dashboard-editable) |
| Charge-from-grid | Enabled, window **00:00–06:00** (not dashboard-editable) |
| Enabled toggle **[editable]** | `enabled` = **true** — `false` skips forecasting and holds `disabledChargeUpperSoc` every night |
| Control mode **[editable]** | `dryRun` = **true** — logs/emails only, never calls SolaX. Dashboard toggle (red pill, confirm-gated) flips this with no redeploy |
| Schedule | **cron(30 11 \* \* ? \*)** = 21:30 Brisbane |

## GridDischargeFunction — evening export target

| Rule | Value |
|---|---|
| Discharge window | **17:00–21:00** (`windowStartTime`/`windowEndTime`) |
| Mid-window check | **19:00** (`checkTime`) |
| Target basis | Worst shoulder-night (21:00–24:00) SOC drop over the last **14 days** (`historyLookbackDays`), else fallback |
| Minimum nights required for live calc | **3** (`minHistoryDaysRequired`) |
| Fallback reserve **[editable, `SettingsOptimizerFunction`-only — see below]** | `fallbackReservePercent` = **26%** (data-grounded from a real week of plant reports) |
| Safety margin on top **[editable, `SettingsOptimizerFunction`-only]** | `safetyMarginPercent` = **10%** |
| Floor shared with battery control | `minSoc` = **10%** (from `config.batteryControl`) |
| Minimum surplus to bother discharging | `minSurplusPercent` = **5%** |
| Max discharge power | **3000 W** |
| Assumed usable capacity | **18.4 kWh** (public template default: 10 kWh — placeholder) |
| Mid-window early-exit trigger | Any grid import since window opened, OR SOC already at/past target |
| Enabled toggle **[editable]** | `enabled` = **true** — `false` skips all three phases (start/check/exit) for the day |
| Control mode **[editable]** | `dryRun` = **true** — logs/emails only, never calls SolaX. Dashboard toggle (red pill, confirm-gated) flips this with no redeploy |
| Schedules | `start` **cron(0 7 \* \* ? \*)** = 17:00, `check` **cron(0 9 \* \* ? \*)** = 19:00, `exit` **cron(0 11 \* \* ? \*)** = 21:00, all Brisbane |

## SettingsOptimizerFunction — self-tuning bounds

Reviews the five **[editable]** values above (`chargeUpperSocSunny`, `chargeUpperSocPartlyCloudy`, `chargeUpperSocOvercast`, `gridDischarge.fallbackReservePercent`, `gridDischarge.safetyMarginPercent`) nightly (was weekly — see docs/settings-optimizer-logic.md) and proposes changes, gated by two rules enforced in code regardless of what the AI recommends:

| Rule | Value |
|---|---|
| Minimum sample size to consider a change | **3** nights of relevant history (`minSampleSize`) |
| Maximum adjustment per run | **±15 percentage points** from the current effective value, and clamped to `[0, 100]` overall (`maxAdjustmentPercent`) |
| Lookback window | **7 days**, refreshed nightly rather than once a week (`lookbackDays`) |
| Full automation **[editable]** | `autoApply` = **false** — recommends and emails only; writes to the settings-override rows only when effectively `true`. Dashboard toggle on the AI card ("Full automation"), confirm-gated — the one toggle that governs whether the AI can rewrite the other editable settings above without a human applying them first |
| Schedule | **cron(0 12 \* \* ? \*)** = 22:00 Brisbane, every night (was **cron(0 12 ? \* SUN \*)** = Sunday only) |
| Bedrock model | `au.anthropic.claude-haiku-4-5-20251001-v1:0` (cross-region inference profile; public template unset) |

## Safety posture summary

Every control-relevant function (writes to the inverter, or writes settings that influence what another function writes) defaults to a non-destructive mode:

| Function | Flag | Current value | Dashboard-editable? |
|---|---|---|---|
| `BatteryControlFunction` | `dryRun` | `true` | Yes — "Control mode" toggle on `/battery-settings`, confirm-gated, no redeploy needed |
| `GridDischargeFunction` | `dryRun` | `true` | Yes — "Control mode" toggle on `/grid-discharge-settings`, confirm-gated, no redeploy needed |
| `SettingsOptimizerFunction` | `autoApply` | `false` | Yes — "Full automation" toggle on the AI card (`/settings-optimizer-settings`), confirm-gated, no redeploy needed |

None of the above have been flipped live yet. Each has an explicit "known risks" / "how to validate before enabling" section in its own logic doc — read those before changing any of the three flags above. All three are now a single dashboard click rather than a config edit + redeploy — see the "Dashboard-editable settings" section of each function's logic doc for what that removes in terms of built-in friction. `SettingsOptimizerFunction`'s is arguably the most consequential of the three despite never calling SolaX directly, since turning it on lets the AI rewrite the other two functions' own settings unattended; `GridDischargeFunction`'s is the most consequential of the two that do call SolaX directly, given the still-open "unconfirmed load behavior" risk in docs/grid-discharge-logic.md.
