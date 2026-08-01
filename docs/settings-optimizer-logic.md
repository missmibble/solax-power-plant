# Settings optimizer — logic reference

This describes exactly what `SettingsOptimizerFunction` (`lambda/SettingsOptimizerFunction/SettingsOptimizerFunction.js`) does and why, so it can be reviewed before `config.settingsOptimizer.autoApply` is ever set to `true`. With the default `autoApply: false`, this function only ever recommends — it computes, emails, and stores a suggestion, and never writes to the settings that actually control the inverter.

## What it's for

Four numbers in this app were originally just reasoned guesses, captured once and never revisited: `chargeUpperSocSunny`/`chargeUpperSocOvercast` (`BatteryControlFunction`'s overnight charge targets) and `gridDischarge.fallbackReservePercent`/`safetyMarginPercent` (`GridDischargeFunction`'s safety margin for the 5-9pm export window). `fallbackReservePercent` itself was already revised once by hand, from a 20% guess to 26%, after a week of real SolaX plant-report data showed the actual worst night needed more reserve than assumed — see `docs/grid-discharge-logic.md`. This function turns that one-off manual exercise into a recurring, automated one: every week, it looks at what actually happened — the accuracy judgements `BatteryControlFunction` and `GridDischargeFunction` already make about their own decisions — and asks Bedrock whether the four defaults should move.

**This is not a new source of ground truth.** It doesn't re-derive anything from raw readings itself; it aggregates judgements *other* functions already made nightly (`BatteryControlFunction.assessPreviousDecision`'s `previousAssessment`, and `GridDischargeFunction`'s stored `shoulderNightReservePercent`/early-exit-due-to-import events) and asks whether a week of those judgements, taken together, suggests a change. If those nightly judgements are wrong, this function's recommendations will be too — it's a rollup, not an independent check.

## When it runs

Weekly, Sunday 22:00 Brisbane time (`cron(0 12 ? * SUN *)` — 12:00 UTC; fixed offset, no DST). Deliberately outside every other schedule's window — after `BatteryControlFunction`'s 21:30 nightly run and `GridDischargeFunction`'s 21:00 exit, so any settings it changes take effect starting the *next* day's decisions, never mid-flight. Skipped entirely — not even deployed — when `config.bedrock.modelId` isn't set, since unlike `ReportFunction`'s AI narrative or `BatteryControlFunction`'s accuracy check (both additive on top of a deterministic base), this function's entire purpose *is* the Bedrock assessment. There's no meaningful thing for it to do without a model configured, so it isn't wired up as a permanent no-op the way an additive feature would be.

## What it gathers

For the last `lookbackDays` (default 7) local calendar days:

- **`BATTERY_CONTROL#<inverterSn>` records** (`BatteryControlFunction`'s own nightly decisions), grouped by forecast classification (`sunny`/`overcast`; `disabled` nights are excluded — there's no forecast decision to assess on those). For each classification: how many nights, how many `previousAssessment.accurate: true` vs `false`, and any `usageNote` text where `usageShouldInfluence` was flagged.
- **`GRID_DISCHARGE#<inverterSn>` records** (`GridDischargeFunction`'s decisions across all three phases), filtered to `phase: 'start'` and `enabled: true` runs for `shoulderNightReservePercent` (the reserve the night actually needed, per-night) and `surplusPercent` (was there anything to export at all), plus a count of `check`/`exit` records whose `reasoning` matched "Grid import detected" (the mid-window early-exit signal — see `docs/grid-discharge-logic.md`'s "How discharge is regulated mid-window").
- **Current effective values** — not the static config defaults, but whatever's actually in effect right now: `BATTERY_CONTROL_SETTINGS#<inverterSn>` and `GRID_DISCHARGE_SETTINGS#<inverterSn>` overrides (if a human, or a previous week's `autoApply` run, already changed something), falling back to `config.batteryControl`/`config.gridDischarge` only when no override exists.

## The Bedrock call and its safety framing

One `InvokeModelCommand` per run, with the aggregated history above as the prompt and a system prompt that explicitly tells the model: *the cost of erring toward holding more charge is small; the cost of erring toward too little is a forced grid import at the peak rate* — the same asymmetric risk framing baked into `GridDischargeFunction`'s own calculation, restated for the model rather than left implicit. The model is asked to return `null` for any of the four values it doesn't have enough evidence to recommend changing, rather than a number every time.

A Bedrock **call failure** (network/auth error) is treated as a real failure for this run — logged, alerted, and left to error the Lambda (so `SettingsOptimizerFunctionErrorAlarm` fires) — unlike `getAiInsights`/`assessPreviousDecision`, which swallow Bedrock errors because they're additive to a deterministic base this function doesn't have. A **successfully-returned but unparsable** response degrades gracefully instead, exactly like `parseAiResponse`/`parseAccuracyAssessment` elsewhere: no crash, just no recommendation for that week.

## Two independent safety layers on top of the AI response

Neither of these trusts the model's own restraint — both are enforced in code, regardless of what Bedrock returns:

1. **Sample-size gate** (`minSampleSize`, default 3): even if Bedrock recommends a number, `buildRecommendations` discards it and holds the current value if fewer than `minSampleSize` nights of relevant history exist for that specific setting. A confident-sounding recommendation from two nights of data is exactly the kind of thin-sample overreach the rest of this app already guards against elsewhere (see `GridDischargeFunction`'s own `minHistoryDaysRequired`/fallback pattern).
2. **Bounded adjustment** (`maxAdjustmentPercent`, default 15 percentage points): any recommendation that survives the sample-size gate is clamped to at most `maxAdjustmentPercent` points away from the *current* effective value, and to `[0, 100]` overall. One Bedrock response, however confident, can't move a control-relevant setting further than that in a single week.

## Dry-run vs. `autoApply`

- **`autoApply: false`** (current default in both configs): computes recommendations, emails a summary to the reports topic, and stores a `SETTINGS_OPTIMIZATION#<inverterSn>` record — never writes to `BATTERY_CONTROL_SETTINGS#`/`GRID_DISCHARGE_SETTINGS#`. Functionally the same relationship to "would apply" as `dryRun: true` elsewhere in this app, just named `autoApply` instead, since there's no separate live/dry SolaX call to gate here — the only "live" action is the settings-override write itself.
- **`autoApply: true`**: same computation, but any non-null recommendation is written into the relevant settings-override row. Each write is a **merge**, not a replace — it reads the existing override first (via `GetCommand`) and only overwrites the specific field(s) being changed, so a human-set `enabled` toggle on the battery-control settings (or any other field this function doesn't touch) survives untouched.

## Worked example (hypothetical — no real week of history yet)

This deployment doesn't yet have a full week of `BATTERY_CONTROL#`/`GRID_DISCHARGE#` history for this function to act on, so there's no real worked example yet the way `docs/grid-discharge-logic.md`'s worked example used real plant-report data. Illustrative shape of what a run would produce once there is:

> `chargeUpperSocSunny`: 3 sunny nights this week, 2 judged `accurate: false` with `usageNote` mentioning the battery ran flat before solar caught up → Bedrock recommends 50 (up from 40) at `medium` confidence → sample size (3) meets `minSampleSize` → adjustment (+10) is within `maxAdjustmentPercent` (15) → applied as-is if `autoApply: true`, otherwise emailed as a recommendation.
>
> `gridDischargeFallbackReservePercent`: only 1 night with `shoulderNightReservePercent` data this week (the rest were `disabled`/dry-run-no-surplus nights) → below `minSampleSize` (3) → held at the current value regardless of what Bedrock returned.

## Known risks to weigh before enabling `autoApply: true`

- **It's a rollup of other functions' judgements, not an independent check** — see "What it's for" above. If `assessPreviousDecision`'s nightly accuracy calls are themselves miscalibrated, this function will confidently aggregate that miscalibration into a recommendation, not catch it.
- **Interacts with the still-open `GridDischargeFunction` risk**: `docs/grid-discharge-logic.md`'s "unconfirmed load behavior" question (whether VPP SOC Target Control is load-preserving or a literal fixed-rate command) is unresolved. This function's grid-discharge recommendations are only as trustworthy as the `shoulderNightReservePercent`/early-exit data they're built from, which itself depends on that open question. Resolve that first.
- **A week is still a fairly thin sample** for a household's actual variance (weekday vs. weekend routines, seasonal load changes) — `minSampleSize: 3` is a floor, not a claim that 3 nights is definitively enough. Watch the recommendation-only output for a few cycles before considering `autoApply: true`.
- **No verification the applied value "worked"** — this function doesn't check back on its own past recommendations the way `assessPreviousDecision` checks `BatteryControlFunction`'s decisions. If `autoApply` makes a change that turns out badly, the *next* week's run should catch it (assuming the downstream accuracy/reserve data reflects it), but there's a full week of exposure in between.

## How to validate before enabling `autoApply: true`

Leave `autoApply: false` for at least several weekly cycles once enough `BATTERY_CONTROL#`/`GRID_DISCHARGE#` history exists to clear `minSampleSize`. Each week, compare the emailed recommendation (and its reasoning/confidence) against your own read of how the week actually went — the same validation pattern used for `BatteryControlFunction`'s and `GridDischargeFunction`'s own dry-run periods. Only once the recommendations consistently look sound is `autoApply: true` worth considering, and even then it's worth revisiting `maxAdjustmentPercent`/`minSampleSize` based on how conservative or aggressive the weekly recommendations turn out to be in practice.
