# Grid discharge — logic reference

This describes exactly what `GridDischargeFunction` (`lambda/GridDischargeFunction/GridDischargeFunction.js`) decides and why, so it can be reviewed before dry-run mode is ever switched off — whether via `config.gridDischarge.dryRun: false` in config, or the dashboard's "Control mode" toggle (see "Dashboard-editable settings" below). Nothing in this document is applied automatically — while dry-run is in effect (the default, in both `config/dev-powerplant.json` and your local config, unless overridden from the dashboard), the function only ever logs and emails what it *would* do.

## What it's for

The electricity retailer offers a premium feed-in rate — **27c/kWh, 5pm–9pm** — well above the flat 2c/kWh feed-in rate that applies the rest of the day, and even above what self-consumption avoids paying on the cheapest import windows. The existing battery strategy (`BatteryControlFunction`) only ever *self-consumes* through the battery — it never deliberately exports, so any battery charge left over at the end of the evening peak just sits there until the next overnight recharge, earning nothing extra. This function looks at how much of that leftover charge is genuinely surplus to the evening's needs, and — if `dryRun: false` — discharges exactly that surplus to the grid during the 5pm–9pm window, capturing the premium rate on capacity that would otherwise have gone unused until being topped up again at 8c/kWh overnight anyway.

**The arbitrage only works one direction.** Self-consumption avoids the peak import rate (41.756c/kWh), which is still worth more than the 27c/kWh feed-in credit — so this never discharges further than the evening's load needs, and never causes an import that wouldn't otherwise have happened. The only thing this exports is charge that would have sat idle regardless.

## When it runs

Three EventBridge schedules drive one Lambda, dispatched on `event.phase` (same "one handler, distinguishing payload" pattern `ReportFunction` uses for `sendEmail`):

- **`start`** — 5:00pm Brisbane time (`cron(0 7 * * ? *)` — 07:00 UTC; fixed offset, no DST, same reasoning as `BatteryControlFunction`'s schedule). Calculates the target floor SOC and, if there's meaningful surplus above it, discharges toward that target via VPP SOC Target Control.
- **`check`** — 7:00pm Brisbane time (`cron(0 9 * * ? *)` — 09:00 UTC, `config.gridDischarge.checkTime`), roughly the midpoint of the window. The mid-window regulation mechanism — see "How discharge is regulated mid-window" below.
- **`exit`** — 9:00pm Brisbane time (`cron(0 11 * * ? *)` — 11:00 UTC). Calls Exit VPP mode to hand control back to the inverter's normal Self Use schedule (whatever `BatteryControlFunction` set that night).

The exit call is **always attempted** when `enabled` (dry-run or not) regardless of what the start (or check) phase decided — SOC Target Control has no built-in duration or auto-exit, so if a live discharge command was ever sent, this is the only thing that guarantees the inverter returns to normal operation by 9pm. Skipping it after a no-surplus or dry-run start is harmless; skipping it after a real applied discharge would leave the inverter stuck in VPP override overnight, potentially interfering with the 00:00–06:00 grid-charge window `BatteryControlFunction` depends on.

## The calculation

```
target_floor_soc = minSoc + shoulder_night_reserve + safety_margin
surplus = max(0, current_soc_at_5pm − target_floor_soc)
```

- **`minSoc`** — the same protected floor `BatteryControlFunction` uses (`config.batteryControl.minSoc`, currently 10%). Not duplicated in `config.gridDischarge` — merged in at deploy time (`LambdaFunctionsStack`, same pattern as `TARIFF_STRUCTURE` merging in `config.location.timezone`).
- **`shoulder_night_reserve`** — how much SOC the household typically uses between 9pm (when this window closes) and midnight (when the cheap overnight recharge starts) — the load the battery still has to cover *after* this function is done for the day. Computed from the **worst (maximum)** night across the last `historyLookbackDays` (default 14) local calendar days, not an average — a single high-load night is exactly the case this reserve exists to protect against. If fewer than `minHistoryDaysRequired` (default 3) nights have usable data, falls back to a configured static `fallbackReservePercent` (**26%**, updated from an initial 20% guess once a week of real SolaX plant-report data was available — see the worked example below) instead of trusting a thin sample.
- **`safety_margin`** — an additional static buffer (`safetyMarginPercent`, default 10%) on top of the historical reserve, for forecast/data-quality uncertainty.

**The safe failure mode is always under-exporting, never over-discharging** — every fallback in this calculation (no history, no recent reading, missing capacity data) resolves toward holding *more* charge, never less.

Surplus energy (kWh) is derived from the percentage surplus and the battery's usable capacity, which is itself derived from the latest reading's `batteryRemainings`/`batterySOC` pair (`~18.4 kWh` observed on this system) rather than a hardcoded constant — falls back to `config.gridDischarge.assumedUsableCapacityKwh` only if a reading is missing `batteryRemainings`.

Discharge power is the surplus energy amortized evenly across the window duration (`windowEndTime − windowStartTime`, 4 hours by default), clamped to `maxDischargePowerW` (default 3000W) so a large surplus doesn't get pushed out all at once.

## Worked example (real data)

Pulled directly from this deployment's stored readings, 2026-07-31 — the one complete evening in history at the time this was built:

| | Value |
|---|---|
| SOC at 5pm (self-use only, no deliberate export) | 95% → 57% by 9pm |
| Battery discharge, 5–9pm | 7.5 kWh, all to load (0 kWh exported, 0 kWh imported) |
| Shoulder-night (9pm–midnight) discharge that same night | 1.9 kWh (≈10 SOC points) |
| Usable capacity (derived) | ~18.4 kWh |

With only one night of *live PollerFunction* history at the time, `minHistoryDaysRequired` (3) wasn't met, so the calculation would have used the **fallback** reserve. That fallback was originally a 20% guess — since replaced with **26%**, derived from a full week of real SolaX plant-report data (2026-07-24 to 2026-07-31, `Daily consumed(kWh)` at 5-minute resolution): 9pm–midnight consumption ranged 0.9–4.7 kWh across 8 nights, and the worst night (4.70 kWh ÷ 18.43 kWh capacity) is ~25.5% — 26% gives a touch of margin above that. Recomputing the 2026-07-31 example with the updated fallback: `target_floor_soc = 10% (minSoc) + 26% (fallback) + 10% (safety margin) = 46%`. Against a self-use-only end state of 57%, that's `surplus ≈ 11%` ≈ 2.0 kWh ≈ **~$0.55** at 27c/kWh — lower than the original 20%-fallback estimate, because the fallback is now correctly sized to the household's actual worst night rather than an arbitrary round number. Once `minHistoryDaysRequired` nights of *live* shoulder-night data accumulate, the calculation switches to the real observed worst night instead of this fallback.

That same week of plant-report data also showed 5-9pm household consumption averaging 6.42 kWh (1.6 kW) and ranging up to 10.1 kWh — well above the discharge rates this function actually calculates (a few hundred watts, amortized over the window). That gap is the concrete reason the "unconfirmed load behavior" risk above is treated as a hard blocker, not a nice-to-resolve: if SOC Target Control turns out to be a literal fixed-rate command rather than load-preserving, a commanded rate that far below typical real load would force grid import on every run, not just as an edge case.

## What actually gets sent (when not a dry run)

**Start phase**, VPP SOC Target Control (`inverter_vpp_mode/soc_target_control_mode`):
```json
{ "snList": ["<inverterSn>"], "businessType": 1, "targetSoc": 40, "chargeDischargPower": -750 }
```
`chargeDischargPower` is **+charge/−discharge** (docs/solax-apis.md §9) — the *opposite* sign convention from the Push Power VPP modes' `batteryPower` field (+discharge/−charge). `GridDischargeFunction` always sends a negative value here; get this backwards and the call would try to *charge* toward the target instead.

**Exit phase**, Exit VPP mode (`inverter_vpp_mode/exit_vpp_mode`):
```json
{ "snList": ["<inverterSn>"], "businessType": 1 }
```

## Dry run vs. live

- **`dryRun: true`** (current default in both configs, and the safe fallback whenever nothing's been saved from the dashboard): computes the plan, logs it, emails a "DRY RUN" message to the reports topic for both phases. **Never calls either VPP endpoint.**
- **`dryRun: false`**: does all of the above, then actually calls the endpoints, and emails "applied" messages instead.
- Any failure (DynamoDB error, SolaX auth error, control-call error) publishes a "FAILED" message to the *alerts* topic and lets the Lambda error (so a `GridDischargeFunction` CloudWatch alarm fires) — no partial/silent failures.

## Dashboard-editable settings

The dashboard's "Grid Discharge Control" card has an **"Evening discharge enabled"** toggle and a **"Control mode"** (dry-run/live) toggle — the same on/off + control-mode pattern `BatteryControlFunction` already has, added to this function's settings row (`DeviceSn = GRID_DISCHARGE_SETTINGS#<inverterSn>`, `Timestamp = 0`, same fixed-key-row pattern as everywhere else in this app). Saving writes `enabled`/`dryRun` into that row; each phase (`start`/`check`/`exit`) now loads the row first (`GridDischargeFunction.loadSettingsOverride`/`resolveEffectiveSettings`) and resolves the effective value before deciding whether to run — an unset field, or no saved row at all, falls back to `config.gridDischarge.enabled`/`dryRun`.

**This row is shared with `SettingsOptimizerFunction`**, which can also write `fallbackReservePercent`/`safetyMarginPercent` into the same row when `autoApply: true` — the dashboard form only ever edits `enabled`/`dryRun`, so `DashboardApiFunction.handlePutGridDischargeSettings` reads the row first and merges its two fields on top rather than replacing the whole item, so an optimizer-set reserve/margin isn't silently dropped by a dashboard save. `fallbackReservePercent`/`safetyMarginPercent` themselves are still not directly dashboard-editable — only `SettingsOptimizerFunction` writes them.

**Dry-run/live is now a dashboard toggle here too, not just a config value** — same tradeoff as `BatteryControlFunction`'s equivalent (see docs/battery-charge-logic.md): what used to require a config edit + `cdk deploy` to disable is now one click behind a confirm dialog. Given the still-open "unconfirmed load behavior" risk below, this is arguably the more consequential of the two dashboard toggles in this app to leave live unattended — read that risk in full before ever switching this one on, from either the dashboard or config.

The existing "Terminate discharge early" button (`POST /grid-discharge`) is unrelated to this settings row — it's a one-off action (invoke the `exit` phase now), not a persisted setting, and still works exactly as before.

## Known risks to weigh before enabling live control

- **Unconfirmed: how `soc_target_control_mode` behaves under real load, not just at idle.** This is the single biggest open question, more fundamental than any of the risks below. `docs/solax-apis.md` documents the request shape but not the runtime behavior. Two materially different possibilities:
  - **Load-preserving** (hoped-for): the inverter still serves household load from the battery first, and only the genuine surplus beyond load is what actually leaves via `chargeDischargPower`/gets exported — load is never shorted, and `targetSoc` is a hard floor the discharge stops at regardless of demand.
  - **Literal fixed-rate** (unconfirmed, possible): the battery is commanded to discharge at exactly `chargeDischargPower` regardless of what load is doing at that moment, with any load beyond that rate drawn from the grid at whatever import rate applies. Since the calculated discharge rate (surplus amortized over 4 hours, often only a few hundred watts) is typically *well below* normal evening load (often 1-3kW+), this interpretation being correct would mean this feature forces peak-rate grid import on **every** run, not just when demand spikes — a materially worse outcome than doing nothing.

  There is no way to tell which of these is true from the documentation alone. This needs to be resolved — via SolaX support, fuller vendor documentation, or a single deliberately small, closely-watched live test — **before `dryRun` is ever set to `false`**, independent of how much shoulder-night history has accumulated. The mid-window check below reduces *exposure time* to this risk but does not resolve the underlying question.
- **Mid-window regulation is a single check, not continuous monitoring** — deliberately so (see "How discharge is regulated mid-window" below): the window is short (4 hours) and a small amount of over-discharge past the target is an accepted cost, so one check around the midpoint, biased toward the simplest unambiguous signal (any import at all), was judged proportionate rather than building continuous monitoring for a bounded-risk, time-limited window.
- **Thin live history**: `historicalShoulderNightReserves` (the primary path) still only has ~2 days of *live PollerFunction* data as of writing, so it's still exercising the fallback path in practice. The fallback-vs-history threshold (`minHistoryDaysRequired`) exists specifically to avoid trusting an unrepresentative sample. The fallback number itself (`fallbackReservePercent: 26`) is no longer an arbitrary guess — it's grounded in a full week of real plant-report data (see the worked example above) — but it's still a static config value, not something the running system re-derives on its own; revisit it again once enough live shoulder-night data accumulates to compare against.
- **No verification the change "took"**: same caveat as `BatteryControlFunction` — there's no read-back endpoint for VPP mode, so a successful API response doesn't strictly prove the inverter's behavior actually changed.
- **Stuck-in-VPP risk**: if the `exit` phase's Lambda invocation fails for any reason (and its own failure alert also fails to publish, or isn't seen in time), the inverter could remain in VPP override past 9pm, potentially into the overnight charge window. The CloudWatch alarm on `GridDischargeFunction` errors is the safety net here — treat any alert from this function especially seriously if `dryRun: false`.
- **Interaction with `BatteryControlFunction`**: this function reads `config.batteryControl.minSoc` but doesn't otherwise coordinate with `BatteryControlFunction`'s nightly decision — if `BatteryControlFunction`'s chosen `chargeUpperSoc` for tonight was itself unusually low (e.g. a "sunny" 40% call), there may be little or no surplus left to discharge by 5pm the next day regardless of what this calculation recommends. That's expected, not a bug — the surplus check (`surplusPercent < minSurplusPercent`) already handles it by simply not discharging. **Scheduling**: `BatteryControlFunction` originally ran at 20:00 Brisbane, which fell *inside* this feature's 17:00–21:00 window — a real conflict risk (its `batch_set_spontaneity_self_use` call could have collided with `GridDischargeFunction` still holding VPP override). Moved to **21:30**, after the 21:00 `exit` phase, specifically to avoid the two Lambdas contending for control of the same inverter. If either schedule is ever changed again, re-check that BatteryControlFunction still runs after GridDischargeFunction's exit.
- **Single feed-in window assumption**: the 27c/kWh rate and 5–9pm window are read from `config.gridDischarge`, not derived from `config.tariff.importRates`/`feedInRate` — `ReportFunction`'s own cost/credit assessment still values *all* export at the flat `config.tariff.feedInRate` (2c/kWh), so the nightly report currently understates the value of any export this function makes during the premium window. Extending `tariff.js`'s `exportCredit` to support a time-varying export rate (mirroring `importRates`) would fix that, but is out of scope for this feature — flagged here so it isn't forgotten.
- **The dashboard live toggle removes the redeploy speed bump**: same caveat as `BatteryControlFunction`'s equivalent toggle (see docs/battery-charge-logic.md) — going live used to force a deliberate config-edit-and-redeploy pause; it's now one dashboard click behind a confirm dialog. Combined with the still-unresolved "unconfirmed load behavior" risk above, that makes it easier than it should be to switch this on before that question is actually answered. It's also easy to forget is on afterward — no expiry, no reminder.

## Simulation: a full live-run day

Every Lambda involved and what triggers it, in chronological order, assuming `config.gridDischarge.dryRun: false` (live) and a household with typical evening load:

| Time (Brisbane) | Lambda | Trigger | What happens |
|---|---|---|---|
| Every 5 min, all day | `PollerFunction` | EventBridge `rate(5 minutes)` | Polls SolaX, writes one reading (SOC, `chargeDischargePower`, import/export counters, etc.) — the only source of truth every other Lambda in this table reads from. |
| 00:00–06:00 | *(inverter itself, no Lambda)* | Self Use time window, set by last night's 21:30 `BatteryControlFunction` run | Battery charges toward `chargeUpperSoc` at the cheap 8c/kWh night rate. |
| 17:00 | `GridDischargeFunction` (`phase: 'start'`) | EventBridge cron `0 7 * * ? *` | Reads latest SOC, computes the historical-reserve-based target floor, and — if there's meaningful surplus — calls `soc_target_control_mode` with a negative `chargeDischargPower`. The inverter leaves Self Use and enters VPP override. |
| 17:00–19:00 | *(inverter itself, no Lambda)* | VPP SOC Target Control, set by the run above | Battery (attempts to) discharge toward the target SOC at the commanded rate — see the "unconfirmed load behavior" risk above for what this actually does under real household demand. |
| 19:00 | `GridDischargeFunction` (`phase: 'check'`) | EventBridge cron `0 9 * * ? *` | Mid-window regulation check — see "How discharge is regulated mid-window" below. No-op unless `start` actually applied a live discharge today. |
| 19:00–21:00 | *(inverter itself, no Lambda)* | VPP SOC Target Control (unchanged) or Self Use (if `check` exited early) | Continues toward the target, or has already returned to normal operation if the check phase detected a problem. |
| 21:00 | `GridDischargeFunction` (`phase: 'exit'`) | EventBridge cron `0 11 * * ? *` | Calls `exit_vpp_mode` unconditionally (enabled + not dry-run) — hands the inverter back to Self Use. Idempotent if `check` already exited early. |
| 21:30 | `BatteryControlFunction` | EventBridge cron `30 11 * * ? *` | Decides *tonight's* `chargeUpperSoc` from tomorrow's forecast and resends the full Self Use baseline — deliberately scheduled 30 minutes after `GridDischargeFunction`'s `exit` phase (not the original 20:00) so the two Lambdas never contend for control of the inverter; see "Interaction with `BatteryControlFunction`" above. |
| 21:00–24:00 | *(inverter itself, no Lambda)* | Self Use (restored) | Battery covers shoulder-night load normally — this is the window the 17:00 calculation was specifically trying to protect. |
| Nightly, ~16:00 | `ReportFunction` | EventBridge cron `0 16 * * ? *` | Assesses the day's usage/cost. Currently does **not** know about the 27c/kWh premium window — see "Single feed-in window assumption" above. |
| Any DynamoDB write | `AlertFunction` | DynamoDB Streams (`INSERT`) | Checks each new reading for import anomalies / inverter fault codes — not grid-discharge-aware, but would still catch an anomalous import spike during the 17:00–21:00 window if one happened. |
| On demand | `DashboardApiFunction` | API Gateway (dashboard page loads, or the "Terminate discharge early" button) | Serves rollups/insights/battery-status. `POST /grid-discharge` (the dashboard button) invokes `GridDischargeFunction` with `{ phase: 'exit' }` on demand — see "Manual termination" below. Does **not** yet serve `GridDischargeFunction`'s status records as a GET/status widget. |

If `dryRun: true` (the actual current default), the 17:00/19:00/21:00 rows still run on schedule and still compute everything, they just log + email instead of calling `soc_target_control_mode`/`exit_vpp_mode` — the inverter never actually leaves its normal Self Use schedule.

## How discharge is regulated mid-window

This is the direct answer to "how does the system regulate discharge if demand is higher than normal." Two mechanisms, one built-in and one added:

1. **The target itself (built into SOC Target Control, always active).** `targetSoc` is the floor the whole calculation exists to protect (`minSoc` + worst historical shoulder-night reserve + safety margin) — assuming SOC Target Control behaves as a true floor (the "load-preserving" case above), the battery should never be driven below that floor regardless of how high demand runs, because reaching the target is what the command is bounded by.
2. **The `check` phase (19:00, roughly the window's midpoint).** Rather than inferring trouble from *how fast* SOC is falling — which would need an assumed consumption shape and conflates "demand is high" with "reached target early" (a fine outcome) — `shouldExitEarly` (exported, unit-tested) looks for the one unambiguous bad signal directly: **has any grid import happened since 17:00?** Any import at all during this window can only mean demand outpaced the commanded discharge rate (exactly the "literal fixed-rate" risk above, if it's real). The check also exits early if SOC has already reached or passed the target — there's nothing further to usefully export, so there's no reason to keep holding VPP override for the rest of the window. Either condition triggers the same corrective action: call `exit_vpp_mode` immediately (or log/email it in dry-run) rather than waiting for 21:00.

This is deliberately a **single check, not continuous monitoring** — the window is short (4 hours) and a modest amount of over-discharge past the target is an accepted cost (see the risk note above); the design biases toward catching the case that actually matters (forced peak-rate import) rather than fine-tuning the discharge rate in response to every fluctuation.

## Manual termination (dashboard button)

The dashboard's "Grid Discharge Control" section has a "Terminate discharge early" button (`POST /grid-discharge`, Cognito-protected like every other dashboard write) that asynchronously invokes `GridDischargeFunction` with `{ phase: 'exit' }` — the exact same exit-phase logic the 21:00 schedule and the `check` phase's early-exit both use, just triggered on demand. Safe to press at any time, including when nothing is currently running (calling `exit_vpp_mode` when the inverter isn't in VPP override is expected to be a harmless no-op). Use it before an expected demand spike (visitors, EV charging) that you don't want to wait for the `check` phase to detect.

## Dashboard visibility

Still **no read/status widget for the decision history** — dry-run visibility for the `start`/`check`/`exit` *decisions themselves* (target floor, surplus, revenue, etc.) is via the reports-topic email, CloudWatch Logs, and the stored status record (`DeviceSn = GRID_DISCHARGE#<inverterSn>` in the same readings table, one record per phase per day, following the same sentinel-prefix pattern as every other decision record in this app). `DashboardApiFunction` doesn't yet expose a GET route for *that* — only the manual-termination POST and the settings GET/PUT (enabled/dry-run only, see "Dashboard-editable settings" above) exist so far. Add a GET route/widget for the decision history the same way `/battery-status` was added, once this has run enough to be worth watching from the dashboard rather than email/logs.

## How to validate before flipping to live (dashboard toggle or `dryRun: false` in config)

Leave dry-run running for at least a couple of weeks, whichever way it's set (config default or a saved dashboard override) — long enough for `historyLookbackDays`/`minHistoryDaysRequired` to actually be driven by real shoulder-night data rather than the fallback. Each evening, compare the emailed "DRY RUN" message (target floor, surplus, estimated revenue) against what the household's actual load did that night, the same way `BatteryControlFunction`'s dry-run output was validated. Pay particular attention to whether the shoulder-night reserve (9pm–midnight) the calculation used actually held — if the household ever imports during that window on a night this function would have discharged further, the reserve/safety-margin numbers need widening before going live.

Also check the 19:00 `check` phase's dry-run emails specifically — on a normal evening it should report "on track" and do nothing; if it's frequently reporting import detected or an early SOC-floor hit even in dry-run's *simulated* terms (i.e., what the numbers say *would* have happened), that's a sign the 5pm discharge rate is too aggressive relative to real demand, independent of the still-unresolved load-behavior question above.
