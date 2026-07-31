# Battery charge control — logic reference

This describes exactly what `BatteryControlFunction` (`lambda/BatteryControlFunction/BatteryControlFunction.js`) decides and why, so it can be reviewed before `config.batteryControl.dryRun` is ever set to `false`. Nothing in this document is applied automatically — while `dryRun: true` (the default, in both `config/dev-powerplant.json` and your local config), the function only ever logs and emails what it *would* do.

## What it's for

Today, the household manually sets the inverter's grid-charge target (`chargeUpperSoc`) to 100% year-round — the battery always charges fully overnight on the cheap 00:00–06:00 rate, regardless of how much solar is expected the next day. The idea: on a day with strong solar forecast, a fully-charged battery going into the morning is often unnecessary — a partial charge (enough to cover the morning before solar production ramps up) plus a day of solar generation refills it anyway, and a lower target theoretically leaves more headroom for solar self-consumption during the day. On a poor-solar day (heavy cloud, rain), there's no solar to rely on, so the full 100% charge should stay.

## When it runs

Nightly at **20:00 Brisbane time** (`cron(0 10 * * ? *)` — 10:00 UTC; Queensland doesn't observe DST, so this is a fixed offset year-round, no seasonal drift). This is deliberately *before* the 00:00–06:00 overnight charge window starts, so whatever `chargeUpperSoc` it decides on is in place before grid-charging begins that night.

"Tomorrow" is computed as the calendar date following the current one, in `Australia/Brisbane` local time, at the moment the function runs (~20:00) — i.e., the day that starts right after tonight's charge window ends.

## Data sources

**Weather**: OpenWeatherMap's free 5-day/3-hour forecast endpoint —
`https://api.openweathermap.org/data/2.5/forecast?lat={lat}&lon={lon}&appid=...&units=metric`
(`lat`/`lon` are the site's real coordinates, from `config.location` — gitignored local config only, never the public template, same sensitivity tier as the inverter serial). This returns 3-hour forecast slots; the function filters to just the 8 slots (00:00–24:00, 3-hourly) that fall on tomorrow's local date.

**Inverter baseline**: `config.batteryControl` — the *current* real settings from the SolaX app (see [CLAUDE.md](../CLAUDE.md) for why these can't be read back from the API and must be kept here instead):

| Field | Value |
|---|---|
| `minSoc` | 10% |
| `chargeFromGridEnable` | 1 (on) |
| `chargeStartTimePeriod1` / `chargeEndTimePeriod1` | 00:00 / 06:00 |
| `chargeStartTimePeriod2` / `chargeEndTimePeriod2` | unused (00:00/00:00) |
| `dischargeStartTimePeriod1` / `dischargeEndTimePeriod1` | 00:00 / 23:59 |
| `dischargeStartTimePeriod2` / `dischargeEndTimePeriod2` | unused (00:00/00:00) |
| `enableTimePeriod2` | 0 (off) |
| `chargeUpperSoc` | **not fixed — this is the one field the function decides nightly** |

## The classification (`classifyForecast`)

Three signals are computed across tomorrow's 8 forecast slots:

- **`hasRainCondition`** — does any slot report `weather.main` of `Rain`, `Thunderstorm`, `Drizzle`, or `Snow`?
- **`maxPop`** — the highest "probability of precipitation" (0–1) across all 8 slots.
- **`avgClouds`** — the average cloud-cover percentage across all 8 slots.

Decision, in order:

```
IF no forecast data at all for tomorrow:
    → overcast (no signal to act on)

ELSE IF hasRainCondition, OR maxPop ≥ 0.4, OR avgClouds ≥ 70%:
    → overcast

ELSE IF avgClouds ≤ 30% AND maxPop < 0.2:
    → sunny

ELSE:
    → overcast   (ambiguous / partly-cloudy — safe default)
```

`sunny` → `chargeUpperSoc = chargeUpperSocSunny` (default 40). `overcast` → `chargeUpperSoc = chargeUpperSocOvercast` (default 100). Both percentages — and a nightly on/off switch — are editable from the dashboard; see "Dashboard-editable settings" below for how that overrides these defaults.

**The asymmetry is deliberate.** "Sunny" requires *both* thresholds to clearly pass; anything ambiguous, or where the two signals disagree, falls to `overcast`. The cost of guessing "overcast" on an actually-sunny day is a slightly fuller battery than strictly necessary (mild inefficiency). The cost of guessing "sunny" on an actually-overcast day is potentially running the battery flat with no solar to refill it — a materially worse outcome. The thresholds are biased toward the cheaper mistake.

## Worked examples

| # | Tomorrow's forecast (across the 8 slots) | `hasRainCondition` | `maxPop` | `avgClouds` | Classification | `chargeUpperSoc` |
|---|---|---|---|---|---|---|
| 1 | Clear all day, no cloud | false | 0.0 | 5% | **sunny** | **40%** |
| 2 | One slot tagged "Rain" at 2pm, 70% pop | true | 0.7 | 55% | **overcast** | **100%** |
| 3 | Clouds building in the afternoon, no rain tagged | false | 0.15 | 45% | **overcast** (ambiguous — `avgClouds` > 30%) | **100%** |
| 4 | Mostly clear, but a 35% pop slot around 3pm, no "Rain" condition | false | 0.35 | 25% | **overcast** (ambiguous — `maxPop` 0.35 is < 0.4 but not < 0.2) | **100%** |
| 5 | Thick cloud cover all day, but no rain ever forecast | false | 0.1 | 85% | **overcast** (`avgClouds` ≥ 70%) | **100%** |
| 6 | OpenWeatherMap returns no slots for tomorrow (API hiccup, coverage gap) | — | — | — | **overcast** (no data) | **100%** |
| 7 | A few scattered clouds, clearing by afternoon | false | 0.05 | 20% | **sunny** (both thresholds clearly pass) | **40%** |

Example 4 is the one most worth double-checking against your own judgement — a 35% chance of an isolated afternoon shower with otherwise clear skies is a genuinely borderline case, and this logic currently treats it the same as example 5's thick overcast day. If that feels too conservative once you've watched a few weeks of dry-run output, the fix is a config/threshold tweak, not a rewrite.

## What actually gets sent (when not a dry run)

`buildSelfUseModeRequest` takes the `config.batteryControl` baseline table above and swaps in whichever `chargeUpperSoc` the classification decided, then POSTs the *entire* object to `inverter_work_mode/batch_set_spontaneity_self_use` — every field, not just `chargeUpperSoc`. See CLAUDE.md for why: that endpoint has no way to read the inverter's current settings first, so this app treats its own config as the authoritative baseline and resends it in full every time.

## Dry run vs. live

- **`dryRun: true`** (current default in both configs): computes the forecast, classification, and full request body; logs it; emails a "DRY RUN (no change applied)" message to the reports topic. **Never calls the SolaX control endpoint.**
- **`dryRun: false`**: does all of the above, then actually calls `setInverterSelfUseMode`, and emails an "applied" message instead.
- Any failure (weather API error, SolaX auth error, control-call error) publishes a "FAILED" message to the *alerts* topic and lets the Lambda error (so the `BatteryControlFunctionErrorAlarm` CloudWatch alarm fires) — no partial/silent failures.

## Dashboard-editable settings

`chargeUpperSocSunny`/`chargeUpperSocOvercast` and a nightly on/off switch can be changed from the dashboard's "Battery Control Settings" panel — no redeploy needed. Saving writes one row to the same readings table, under a fixed sentinel key (`DeviceSn = BATTERY_CONTROL_SETTINGS#<inverterSn>`, `Timestamp = 0` — a single upserted settings row, not time-series). Each run, `BatteryControlFunction.loadSettingsOverride` reads that row and `resolveEffectiveSettings` merges it over `config.batteryControl`'s static defaults — an unset field in the saved override (or no saved override at all yet) falls back to the config value, so this is purely additive to the existing config-driven baseline, never required.

**The on/off toggle is a real kill switch, not just another `dryRun`.** When `enabled: false`, the function skips the forecast/decision/apply logic entirely for that run — no weather call, no SolaX call — and just writes a status record noting automation is off, so the dashboard reflects it clearly. This is independent of `dryRun`: you can have automation enabled-but-dry-run (the safe validation state described above), or disabled outright regardless of `dryRun`.

This was the app's first *write* path from the dashboard (`PUT /battery-settings`), which is exactly what the Cognito login exists to protect — a write action needs real authentication, not just the API key CloudFront injects. `GET /battery-settings` returns the currently-effective values (falling back to `config.batteryControl`'s `chargeUpperSocSunny`/`chargeUpperSocOvercast` — passed to `DashboardApiFunction` as `BATTERY_CONTROL_DEFAULT_SUNNY`/`_OVERCAST` env vars — when nothing's been saved yet) so the settings form always shows something sensible on first load.

**Caveat worth knowing**: this baseline-override mechanism only ever touches `chargeUpperSocSunny`/`chargeUpperSocOvercast`/`enabled` — `minSoc`, `chargeFromGridEnable`, and the time windows are still config-only (see "Stale baseline" below); those aren't exposed on the dashboard.

## Previous-decision accuracy assessment

Each run, before deciding tonight's target, `BatteryControlFunction.assessPreviousDecision` looks back at the *last* stored decision (whatever `BatteryControlFunction` decided the previous time it ran with automation enabled) and the actual readings between then and now, and asks Bedrock to judge it in hindsight — same additive, never-fails-the-run pattern as `ReportFunction.getAiInsights`: no `config.bedrock.modelId` configured, a Bedrock error, an unparsable response, or simply not enough history yet (first-ever run, or the previous run was a disabled skip) all just mean this run's record has no `previousAssessment` field.

The assessment answers two things, stored as `previousAssessment` on the *new* record (not a retroactive edit of the old one):

1. **Was the % right, given what the weather actually did?** E.g. a 40% "sunny" call that then saw the battery run flat before solar caught up gets flagged `accurate: false`; a 100% "overcast" call on a day that turned out mild/sunny likewise, the other direction.
2. **Does household usage load — not just weather — belong in the decision?** `usageShouldInfluence: true` plus a `usageNote` when the actual PV yield/import/export/battery-SOC-range summary (`summarizeUsage`) suggests something about that day's consumption (not just the forecast) should have factored in — e.g. unusually high overnight load. `classifyForecast` itself still only ever looks at weather; this is a separate hindsight signal surfaced to you, not fed back into tomorrow's decision automatically.

Shown on the dashboard as a small "Last night's accuracy" widget alongside the weather/charge-decision ones.

## Known risks to weigh before enabling live control

- **Stale baseline**: if you change `minSoc`, the time windows, or `chargeFromGridEnable` in the SolaX app directly after this goes live, this function will silently overwrite that change back to whatever's in `config.batteryControl` the next time it runs — because it always resends the full baseline. Any manual change to those settings needs a matching config update + redeploy, or it won't stick. (This does *not* apply to `chargeUpperSocSunny`/`chargeUpperSocOvercast`/`enabled` — those are dashboard-editable, see above.)
- **Endpoint choice unconfirmed**: this targets the plain Inverter endpoint (`batch_set_spontaneity_self_use`) based on your confirmation that there's no EMS1000/EMS1000 PRO device on this system. If that's ever wrong, this endpoint won't be the one actually controlling the inverter's behavior.
- **Single forecast source, single point**: one lat/lon, one provider, no fallback — a forecast that's simply wrong for that day (weather forecasting is inherently imperfect) will drive a wrong decision with no cross-check.
- **No verification the change "took"**: there's no read-back endpoint (see above), so a successful API response doesn't strictly prove the inverter's behavior actually changed — only that SolaX Cloud accepted the request.
- **The dashboard on/off toggle is easy to forget about**: since it's a real kill switch independent of `dryRun`, turning it off from the dashboard (e.g. while travelling, or debugging something else) silently pauses automation indefinitely until someone turns it back on — there's no expiry or reminder.

## How to validate before flipping `dryRun: false`

Leave `dryRun: true` running for at least a couple of weeks. Each morning, compare the emailed "DRY RUN" message (classification + reasoning + the `chargeUpperSoc` it would have set) against what the weather actually did that day — the dashboard's "Last night's accuracy" widget (see above) is doing a version of this same comparison automatically once a Bedrock model is configured, so it's worth cross-checking your own read against its `accurate` verdict too. If the classification and reasoning consistently match your own judgement, it's reasonable to flip `dryRun` to `false` in your local config and redeploy. If example-4-style borderline days keep coming up wrong, tighten the `maxPop`/`avgClouds` thresholds in `classifyForecast` first.
