# Settings optimizer — logic reference

This describes exactly what `SettingsOptimizerFunction` (`lambda/SettingsOptimizerFunction/SettingsOptimizerFunction.js`) does and why, so it can be reviewed before `autoApply` is ever switched on — whether via `config.settingsOptimizer.autoApply: true` in config, or the dashboard AI card's "Full automation" toggle (see "Dashboard-editable settings" below). With the default off, this function only ever recommends — it computes, emails, and stores a suggestion, and never writes to the settings that actually control the inverter.

## What it's for

Three numbers in this app were originally just reasoned guesses, captured once and never revisited: `chargeUpperSocSunny`/`chargeUpperSocPartlyCloudy`/`chargeUpperSocOvercast` (`BatteryControlFunction`'s overnight charge targets, one per forecast tier). This function turns manual, occasional review of those numbers into a recurring, automated one: every night, it looks at what actually happened — the accuracy judgements `BatteryControlFunction` already makes about its own decisions — and asks Bedrock whether the three defaults should move.

**This is not a new source of ground truth.** It doesn't re-derive anything from raw readings itself; it aggregates judgements `BatteryControlFunction` already made nightly (`BatteryControlFunction.assessPreviousDecision`'s `previousAssessment`) and asks whether a rolling window of those judgements, taken together, suggests a change. If those nightly judgements are wrong, this function's recommendations will be too — it's a rollup, not an independent check.

A `GridDischargeFunction` (grid-export arbitrage) originally shared this same review — reviewing `fallbackReservePercent`/`safetyMarginPercent` alongside the three battery-charge values above — but that function, and this one's review of its settings, was fully removed once the premium feed-in window it depended on was confirmed unavailable from this site's retailer.

## When it runs

Nightly, 22:00 Brisbane time (`cron(0 12 * * ? *)` — 12:00 UTC every day; fixed offset, no DST) — **was weekly** (Sunday only) until this was changed to run every night instead, so the dashboard's "Last AI recommendation" reflects at most a day old, not up to a week stale. Deliberately outside every other schedule's window — after `BatteryControlFunction`'s 21:30 nightly run, so any settings it changes take effect starting the *next* day's decisions, never mid-flight. Still looks back over `lookbackDays` (default 7) local calendar days each run — a nightly *rolling* window, not a once-a-week batch, so a given night's data factors into roughly `lookbackDays` consecutive runs rather than just one. Skipped entirely — not even deployed — when `config.bedrock.modelId` isn't set, since unlike `ReportFunction`'s AI narrative or `BatteryControlFunction`'s accuracy check (both additive on top of a deterministic base), this function's entire purpose *is* the Bedrock assessment. There's no meaningful thing for it to do without a model configured, so it isn't wired up as a permanent no-op the way an additive feature would be. Running nightly instead of weekly means up to 7x more Bedrock calls/month — still the cheap Haiku-tier model `ReportFunction`'s own multiple-times-a-day narrative already uses, so the cost delta is small, but worth knowing.

## What it gathers

For the last `lookbackDays` (default 7) local calendar days:

- **`BATTERY_CONTROL#<inverterSn>` records** (`BatteryControlFunction`'s own nightly decisions), grouped by forecast classification (`sunny`/`partly-cloudy`/`overcast`; `disabled` nights are excluded — there's no forecast decision to assess on those). For each classification: how many nights, how many `previousAssessment.accurate: true` vs `false`, and any `usageNote` text where `usageShouldInfluence` was flagged.
- **Current effective values** — not the static config defaults, but whatever's actually in effect right now: the `BATTERY_CONTROL_SETTINGS#<inverterSn>` override (if a human, or a previous night's `autoApply` run, already changed something), falling back to `config.batteryControl` only when no override exists.

## The Bedrock call and its safety framing

One `InvokeModelCommand` per run, with the aggregated history above as the prompt and a system prompt that explicitly tells the model: *the cost of erring toward holding more charge is small; the cost of erring toward too little is a forced grid import at the peak rate*. The model is asked to return `null` for any of the three values it doesn't have enough evidence to recommend changing, rather than a number every time.

A Bedrock **call failure** (network/auth error) is treated as a real failure for this run — logged, alerted, and left to error the Lambda (so `SettingsOptimizerFunctionErrorAlarm` fires) — unlike `getAiInsights`/`assessPreviousDecision`, which swallow Bedrock errors because they're additive to a deterministic base this function doesn't have. A **successfully-returned but unparsable** response degrades gracefully instead, exactly like `parseAiResponse`/`parseAccuracyAssessment` elsewhere: no crash, just no recommendation for that week.

## Two independent safety layers on top of the AI response

Neither of these trusts the model's own restraint — both are enforced in code, regardless of what Bedrock returns:

1. **Sample-size gate** (`minSampleSize`, default 3): even if Bedrock recommends a number, `buildRecommendations` discards it and holds the current value if fewer than `minSampleSize` nights of relevant history exist for that specific setting. A confident-sounding recommendation from two nights of data is exactly the kind of thin-sample overreach this guards against.
2. **Bounded adjustment** (`maxAdjustmentPercent`, default 15 percentage points): any recommendation that survives the sample-size gate is clamped to at most `maxAdjustmentPercent` points away from the *current* effective value, and to `[0, 100]` overall. One Bedrock response, however confident, can't move a control-relevant setting further than that in a single week.

## Dry-run vs. `autoApply`

- **`autoApply: false`** (current default in both configs, and the safe fallback whenever nothing's been saved from the dashboard): computes recommendations, emails a summary to the reports topic, and stores a `SETTINGS_OPTIMIZATION#<inverterSn>` record — never writes to `BATTERY_CONTROL_SETTINGS#`. Functionally the same relationship to "would apply" as `dryRun: true` elsewhere in this app, just named `autoApply` instead, since there's no separate live/dry SolaX call to gate here — the only "live" action is the settings-override write itself.
- **`autoApply: true`**: same computation, but any non-null recommendation is written into the relevant settings-override row. Each write is a **merge**, not a replace — it reads the existing override first (via `GetCommand`) and only overwrites the specific field(s) being changed, so a human-set `enabled` toggle on the battery-control settings (or any other field this function doesn't touch) survives untouched.

Every field written this way is also tagged in a companion `sources` map on the same row (`{ chargeUpperSocSunny: 'settings-optimizer', ... }`, merged the same way as the values themselves) — this is how the dashboard's Battery Control Settings panel can show an "AI recommended" badge next to a value instead of it looking identical to something a human typed in or a config default. See CLAUDE.md's "Dashboard insights + battery-status persistence" section for the full `sources` mechanics. Separately, the dashboard's `GET /settings-optimization` route surfaces this function's latest full record (recommendations, confidence, reasoning, applied) directly as a "Last AI recommendation" widget, independent of the per-field badges.

## Dashboard-editable settings — "Full automation"

`autoApply` itself is dashboard-editable — the AI card's "Full automation" toggle (`GET`/`PUT /settings-optimizer-settings`, `SETTINGS_OPTIMIZER_SETTINGS#<inverterSn>`, same fixed-key-row/`resolveOverride`-via-`loadOverride` pattern as every other dashboard-editable setting in this app). A saved override takes precedence over `config.settingsOptimizer.autoApply`; unset, it falls back to the config value. This is the one dashboard toggle in the app that changes *what another toggle's settings are* rather than a device behavior directly — turning it on doesn't call SolaX itself, but it does mean the AI can rewrite `chargeUpperSocSunny`/`chargeUpperSocPartlyCloudy`/`chargeUpperSocOvercast` (the values `BatteryControlFunction` actually acts on) without a human reviewing each change first. The dashboard renders it as the same red toggle-pill + `confirm()` pattern as `BatteryControlFunction`'s live-mode toggle, with wording that says so explicitly. Same caveat as that one: going live used to require a config edit + redeploy, forcing a deliberate pause; this is now one click.

## Worked example

> `chargeUpperSocSunny`: 3 sunny nights in the lookback window, 2 judged `accurate: false` with `usageNote` mentioning the battery ran flat before solar caught up → Bedrock recommends 50 (up from 40) at `medium` confidence → sample size (3) meets `minSampleSize` → adjustment (+10) is within `maxAdjustmentPercent` (15) → applied as-is if `autoApply: true`, otherwise emailed as a recommendation.
>
> `chargeUpperSocPartlyCloudy`: 4 partly-cloudy nights in the lookback window, 3 judged `accurate: false` with `usageNote` mentioning the battery reached 100% well before solar ramped up, on a day that then generated far more solar than the grid import actually needed — the exact pattern that motivated adding this tier in the first place → Bedrock recommends 60 (down from 70) at `medium` confidence → sample size (4) meets `minSampleSize` → adjustment (−10) is within `maxAdjustmentPercent` (15) → applied as-is if `autoApply: true`, otherwise emailed as a recommendation.

This deployment has since seen a real version of the `chargeUpperSocOvercast` case play out much like the `chargeUpperSocSunny` example above — see the household's own history for the specifics, not reproduced here since it'll go stale the moment another night's run changes it.

## Known risks to weigh before enabling `autoApply: true`

- **It's a rollup of another function's judgements, not an independent check** — see "What it's for" above. If `assessPreviousDecision`'s nightly accuracy calls are themselves miscalibrated, this function will confidently aggregate that miscalibration into a recommendation, not catch it.
- **The rolling lookback window is still a fairly thin sample** for a household's actual variance (weekday vs. weekend routines, seasonal load changes) — `minSampleSize: 3` is a floor, not a claim that 3 nights is definitively enough. Watch the recommendation-only output for a few nights before considering `autoApply: true`.
- **No verification the applied value "worked"** — this function doesn't check back on its own past recommendations the way `assessPreviousDecision` checks `BatteryControlFunction`'s decisions. If `autoApply` makes a change that turns out badly, the *next night's* run should catch it (assuming the downstream accuracy data reflects it) — running nightly instead of weekly shrinks this exposure window from up to 7 days down to about 1, which is a real safety improvement of the schedule change, but it's still not zero.
- **The dashboard toggle removes the redeploy speed bump** — same caveat as `BatteryControlFunction`'s live-mode toggle: what used to force a deliberate config-edit-and-redeploy pause is now one click behind a confirm dialog. This one is arguably more consequential, since it governs whether the AI can change *that* function's settings too.

## How to validate before enabling `autoApply: true`

Leave `autoApply` off for at least several nightly cycles once enough `BATTERY_CONTROL#` history exists to clear `minSampleSize`. Each night, compare the emailed recommendation (and its reasoning/confidence) against your own read of how the last day or two actually went — the same validation pattern used for `BatteryControlFunction`'s own dry-run period. Only once the recommendations consistently look sound is `autoApply: true` worth considering, and even then it's worth revisiting `maxAdjustmentPercent`/`minSampleSize` based on how conservative or aggressive the nightly recommendations turn out to be in practice.
