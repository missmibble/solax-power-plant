# Battery charge control — logic reference

This describes exactly what `BatteryControlFunction` (`lambda/BatteryControlFunction/BatteryControlFunction.js`) decides and why, so it can be reviewed before dry-run mode is ever switched off — whether via `config.batteryControl.dryRun: false` in config, or the dashboard's "Control mode" toggle (see "Dashboard-editable settings" below). Nothing in this document is applied automatically — while dry-run is in effect (the default, in both `config/dev-powerplant.json` and your local config, unless overridden from the dashboard), the function only ever logs and emails what it *would* do.

## What it's for

Today, the household manually sets the inverter's grid-charge target (`chargeUpperSoc`) to 100% year-round — the battery always charges fully overnight on the cheap 00:00–06:00 rate, regardless of how much solar is expected the next day. The idea: on a day with strong solar forecast, a fully-charged battery going into the morning is often unnecessary — a partial charge (enough to cover the morning before solar production ramps up) plus a day of solar generation refills it anyway, and a lower target theoretically leaves more headroom for solar self-consumption during the day. On a poor-solar day (heavy cloud, rain), there's no solar to rely on, so the full 100% charge should stay.

## When it runs

Nightly at **21:30 Brisbane time** (`cron(30 11 * * ? *)` — 11:30 UTC; Queensland doesn't observe DST, so this is a fixed offset year-round, no seasonal drift). This is deliberately *before* the 00:00–06:00 overnight charge window starts, so whatever `chargeUpperSoc` it decides on is in place before grid-charging begins that night.

"Tomorrow" is computed as the calendar date following the current one, in `Australia/Brisbane` local time, at the moment the function runs (~21:30) — i.e., the day that starts right after tonight's charge window ends. That same date is stored on the status record as `appliesToDate` (via `tariff.localDateString`, the same helper `fetchTomorrowForecast` uses to request that exact local date from Open-Meteo) and shown on the dashboard's "Charge decision" widget as "Applies from &lt;date&gt;" — computed identically regardless of whether the run was a real forecast decision or the disabled-toggle default, since both take effect at the same overnight window.

## Data sources

**Weather**: [Open-Meteo](https://open-meteo.com)'s free forecast API —
`https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,precipitation_probability,precipitation,cloud_cover&timezone={tz}&start_date={tomorrow}&end_date={tomorrow}`
(`lat`/`lon` are the site's real coordinates, from `config.location` — gitignored local config only, never the public template, same sensitivity tier as the inverter serial). No API key required. Unlike a UTC-referenced 3-hour grid, Open-Meteo's `timezone`/`start_date`/`end_date` params return the 24 hourly slots for tomorrow's *local* calendar day directly — no client-side date filtering needed. All of this is isolated behind `powerplant-shared`'s `fetchTomorrowForecast` (`lambda/Utilities/weather-client.js`), which returns a normalized `{timestampSeconds, tempC, precipitationProbability, cloudCoverPercent, isRainy}` shape rather than the raw provider response — `classifyForecast` below reads only that normalized shape, so a future provider swap only ever touches `weather-client.js`.

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

Three signals are computed across tomorrow's 24 hourly slots (formerly 8 3-hour slots under OpenWeatherMap — Open-Meteo's hourly resolution just means more, finer-grained slots feeding the same max/average logic):

- **`hasRainCondition`** — does any slot's `isRainy` flag come back true? (`isRainy` is derived in `weather-client.js` from Open-Meteo's forecast `precipitation` amount — any measurable rainfall (mm) in that hour — rather than a categorical condition string, since Open-Meteo doesn't provide one of those for the hourly forecast fields this app requests.)
- **`maxPop`** — the highest `precipitationProbability` (0–1 fraction) across all slots.
- **`avgClouds`** — the average `cloudCoverPercent` across all slots.

Decision, in order:

```
IF no forecast data at all for tomorrow:
    → overcast (true blind spot, not just an uncertain signal — stays conservative)

ELSE IF hasRainCondition, OR maxPop ≥ 0.4, OR avgClouds ≥ 70%:
    → overcast

ELSE IF avgClouds ≤ 30% AND maxPop < 0.2:
    → sunny

ELSE:
    → partly-cloudy   (ambiguous, but not a genuinely bad forecast — a moderate target, not the conservative extreme)
```

`sunny` → `chargeUpperSoc = chargeUpperSocSunny` (default 40). `partly-cloudy` → `chargeUpperSoc = chargeUpperSocPartlyCloudy` (default 70). `overcast` → `chargeUpperSoc = chargeUpperSocOvercast` (default 100). All three percentages — and a nightly on/off switch — are editable from the dashboard; see "Dashboard-editable settings" below for how that overrides these defaults.

**Why a third tier.** The ambiguous middle used to fall straight to `overcast` — the reasoning being that a fuller-than-necessary battery is a cheaper mistake than running flat with no solar to refill it (see "The asymmetry" below, which still holds for the *genuinely bad* forecasts). But in practice that meant every forecast that wasn't clearly sunny paid for a full grid charge, even on nights that turned out fine. `assessPreviousDecision`'s own hindsight review flagged exactly this pattern: a night with an ambiguous forecast generated 23.6 kWh of solar the next day and only needed 13.5 kWh of grid import to reach 100% — the target wasn't wrong in outcome (SOC did reach 100%), but a lower overnight grid-charge would have gotten there almost as well, with solar doing more of the work instead of the grid. `partly-cloudy` gives the classifier somewhere to put that middle ground instead of defaulting to the conservative extreme every time.

**The asymmetry is still deliberate for the two extremes.** "Sunny" requires *both* thresholds to clearly pass; a genuinely bad forecast (rain condition, high `maxPop`, heavy `avgClouds`) still goes straight to `overcast`, no middle tier involved — the cost of under-charging before a truly solar-poor day is a materially worse outcome (running flat) than the cost of over-charging, so that bias stays. The new tier only changes what happens to forecasts that are ambiguous *without* tripping any of the bad-weather thresholds.

## Worked examples

| # | Tomorrow's forecast (across the 8 slots) | `hasRainCondition` | `maxPop` | `avgClouds` | Classification | `chargeUpperSoc` |
|---|---|---|---|---|---|---|
| 1 | Clear all day, no cloud | false | 0.0 | 5% | **sunny** | **40%** |
| 2 | One slot tagged "Rain" at 2pm, 70% pop | true | 0.7 | 55% | **overcast** | **100%** |
| 3 | Clouds building in the afternoon, no rain tagged | false | 0.15 | 45% | **partly-cloudy** (ambiguous — `avgClouds` > 30%, but below the 70% overcast threshold) | **70%** |
| 4 | Mostly clear, but a 35% pop slot around 3pm, no "Rain" condition | false | 0.35 | 25% | **partly-cloudy** (ambiguous — `maxPop` 0.35 is < 0.4 but not < 0.2) | **70%** |
| 5 | Thick cloud cover all day, but no rain ever forecast | false | 0.1 | 85% | **overcast** (`avgClouds` ≥ 70%) | **100%** |
| 6 | Open-Meteo returns no hourly data for tomorrow (API hiccup, coverage gap) | — | — | — | **overcast** (no data — a true blind spot, not just ambiguous) | **100%** |
| 7 | A few scattered clouds, clearing by afternoon | false | 0.05 | 20% | **sunny** (both thresholds clearly pass) | **40%** |

Examples 3 and 4 previously defaulted to `overcast`/100% — they're the exact cases the `partly-cloudy` tier was added for. Example 4 is still the one most worth double-checking against your own judgement — a 35% chance of an isolated afternoon shower with otherwise clear skies is a genuinely borderline case. If 70% still feels too conservative (or not conservative enough) once you've watched a few weeks of dry-run output against example-4-style days, the fix is adjusting `chargeUpperSocPartlyCloudy` from the dashboard, not a threshold rewrite.

## What actually gets sent (when not a dry run)

`buildSelfUseModeRequest` takes the `config.batteryControl` baseline table above and swaps in whichever `chargeUpperSoc` the classification decided, then POSTs the *entire* object to `inverter_work_mode/batch_set_spontaneity_self_use` — every field, not just `chargeUpperSoc`. See CLAUDE.md for why: that endpoint has no way to read the inverter's current settings first, so this app treats its own config as the authoritative baseline and resends it in full every time.

## Dry run vs. live

- **`dryRun: true`** (current default in both configs, and the safe fallback whenever nothing's been saved from the dashboard): computes the forecast, classification, and full request body; logs it; emails a "DRY RUN (no change applied)" message to the reports topic. **Never calls the SolaX control endpoint.**
- **`dryRun: false`**: does all of the above, then actually calls `setInverterSelfUseMode`, and emails an "applied" message instead.
- Any failure (weather API error, SolaX auth error, control-call error) publishes a "FAILED" message to the *alerts* topic and lets the Lambda error (so the `BatteryControlFunctionErrorAlarm` CloudWatch alarm fires) — no partial/silent failures.

## Dashboard-editable settings

`chargeUpperSocSunny`/`chargeUpperSocPartlyCloudy`/`chargeUpperSocOvercast`/`disabledChargeUpperSoc`, a nightly on/off switch, and **dry-run/live mode itself** can all be changed from the dashboard's "Battery Control Settings" panel — no redeploy needed. Saving writes one row to the same readings table, under a fixed sentinel key (`DeviceSn = BATTERY_CONTROL_SETTINGS#<inverterSn>`, `Timestamp = 0` — a single upserted settings row, not time-series). Each run, `BatteryControlFunction.loadSettingsOverride` reads that row and `resolveEffectiveSettings` merges it over `config.batteryControl`'s static defaults — an unset field in the saved override (or no saved override at all yet) falls back to the config value, so this is purely additive to the existing config-driven baseline, never required.

**The on/off toggle turns off *forecasting*, not the battery.** When `enabled: false`, the function skips the weather call and `classifyForecast` entirely — no forecast signal drives the decision — but every run still resends the full `config.batteryControl` baseline with `chargeUpperSoc` set to `disabledChargeUpperSoc` (default 100%, dashboard-editable, same as the sunny/overcast targets), through the same dry-run/live path as a normal decision. The status record's `classification` is `'disabled'` in this case. This means disabling automation always converges the battery on a known-safe default (fully charged, by default) rather than leaving it wherever the last automated forecast-driven decision happened to set it — a stale "sunny → 40%" from before you flipped the switch off no longer lingers indefinitely. This is independent of `dryRun`: you can have automation enabled-but-dry-run (the safe validation state described above), or disabled outright regardless of `dryRun`.

**Dry-run/live is now a dashboard toggle, not just a config value.** The dashboard's "Control mode" pill writes `dryRun` into the same override row (`resolveEffectiveSettings` falls back to `config.batteryControl.dryRun` only when the override doesn't specify it) — meaning the safety net that used to require an explicit config edit + `cdk deploy` to disable can now be flipped from a browser session. The UI adds one deliberate speed bump (a confirm dialog before the toggle can be switched to live) but that's a UI-layer nicety, not a security boundary — anyone with dashboard login access can now put the inverter into live mode. Treat the Cognito credentials accordingly, and prefer validating with `dryRun: true` for as long as makes sense (see "How to validate" below) before ever flipping it, from either the dashboard or config.

This was the app's first *write* path from the dashboard (`PUT /battery-settings`), which is exactly what the Cognito login exists to protect — a write action needs real authentication, not just the API key CloudFront injects. `GET /battery-settings` returns the currently-effective values (falling back to `config.batteryControl`'s `chargeUpperSocSunny`/`chargeUpperSocPartlyCloudy`/`chargeUpperSocOvercast`/`disabledChargeUpperSoc`/`dryRun` — passed to `DashboardApiFunction` as `BATTERY_CONTROL_DEFAULT_SUNNY`/`_PARTLY_CLOUDY`/`_OVERCAST`/`_DISABLED`/`_DRY_RUN` env vars — when nothing's been saved yet) so the settings form always shows something sensible on first load.

**Caveat worth knowing**: this baseline-override mechanism only ever touches `chargeUpperSocSunny`/`chargeUpperSocPartlyCloudy`/`chargeUpperSocOvercast`/`disabledChargeUpperSoc`/`enabled`/`dryRun` — `minSoc`, `chargeFromGridEnable`, and the time windows are still config-only (see "Stale baseline" below); those aren't exposed on the dashboard.

## Previous-decision accuracy assessment

Each run, before deciding tonight's target, `BatteryControlFunction.assessPreviousDecision` looks back at the *last* stored decision (whatever `BatteryControlFunction` decided the previous time it ran with automation enabled) and the actual readings between then and now, and asks Bedrock to judge it in hindsight — same additive, never-fails-the-run pattern as `ReportFunction.getAiInsights`: no `config.bedrock.modelId` configured, a Bedrock error, an unparsable response, or simply not enough history yet (first-ever run, or the previous run was a disabled skip) all just mean this run's record has no `previousAssessment` field.

The assessment answers two things, stored as `previousAssessment` on the *new* record (not a retroactive edit of the old one):

1. **Was the % right, given what the weather actually did?** E.g. a 40% "sunny" call that then saw the battery run flat before solar caught up gets flagged `accurate: false`; a 100% "overcast" call on a day that turned out mild/sunny likewise, the other direction.
2. **Does household usage load — not just weather — belong in the decision?** `usageShouldInfluence: true` plus a `usageNote` when the actual PV yield/import/export/battery-SOC-range summary (`summarizeUsage`) suggests something about that day's consumption (not just the forecast) should have factored in — e.g. unusually high shoulder-morning import before solar ramped up. `classifyForecast` itself still only ever looks at weather; this is a separate hindsight signal surfaced to you, not fed back into tomorrow's decision automatically.

**`summarizeUsage` breaks import/export down by tariff window (`byWindow`), not just a single whole-day total.** A production run once had Bedrock describe an 11 kWh whole-day import figure as unexpected "daytime load" exceeding a full battery — the number was right, but the story wasn't: `byWindow` showed nearly all of it landed in `night-ev-charge`, i.e. normal overnight grid-charging. The original `summarizeUsage` only ever computed one first-vs-last delta across the whole ~24h lookback, so there was no way for Bedrock to know *when* an import happened, even though `ACCURACY_SYSTEM_PROMPT` explicitly invites timing-specific claims ("did the battery run flat before solar caught up… or stay needlessly full all day"). `byWindow` (keyed by the same tariff window labels `ReportFunction.assessUsage` uses — `night-ev-charge`/`shoulder-morning`/`offpeak-midday`/`peak-evening`/`shoulder-night`) gives the model the granularity its own prompt asks for, and the prompt now explicitly tells it to ground any timing claim in that breakdown rather than the daily total alone.

Shown on the dashboard as a small "Last night's accuracy" widget alongside the weather/charge-decision ones.

## Known risks to weigh before enabling live control

- **Stale baseline**: if you change `minSoc`, the time windows, or `chargeFromGridEnable` in the SolaX app directly after this goes live, this function will silently overwrite that change back to whatever's in `config.batteryControl` the next time it runs — because it always resends the full baseline. Any manual change to those settings needs a matching config update + redeploy, or it won't stick. (This does *not* apply to `chargeUpperSocSunny`/`chargeUpperSocPartlyCloudy`/`chargeUpperSocOvercast`/`enabled` — those are dashboard-editable, see above.)
- **Endpoint choice unconfirmed**: this targets the plain Inverter endpoint (`batch_set_spontaneity_self_use`) based on your confirmation that there's no EMS1000/EMS1000 PRO device on this system. If that's ever wrong, this endpoint won't be the one actually controlling the inverter's behavior.
- **Single forecast source, single point**: one lat/lon, one provider, no fallback — a forecast that's simply wrong for that day (weather forecasting is inherently imperfect) will drive a wrong decision with no cross-check.
- **No verification the change "took"**: there's no read-back endpoint (see above), so a successful API response doesn't strictly prove the inverter's behavior actually changed — only that SolaX Cloud accepted the request.
- **The dashboard on/off toggle is easy to forget about**: turning it off from the dashboard (e.g. while travelling, or debugging something else) silently holds `chargeUpperSoc` at `disabledChargeUpperSoc` indefinitely until someone turns it back on — there's no expiry or reminder. The default (100%) is a safe one to be stuck at, but if you've changed `disabledChargeUpperSoc` to something lower, forgetting the toggle is off matters more.
- **The dashboard live toggle removes the redeploy speed bump**: previously the only way to go live was a config edit + `cdk deploy`, which forced a deliberate pause to re-read this document. The dashboard toggle makes that a single click (behind one confirm dialog) — the safety comes entirely from your own judgement about when to flip it, not from any remaining friction in the system. It's also easy to forget is on: if you flip it live to test something and move on, it stays live indefinitely with no expiry, same as the on/off toggle above.

## How to validate before flipping to live (dashboard toggle or `dryRun: false` in config)

Leave dry-run running for at least a couple of weeks, whichever way it's set (config default or a saved dashboard override — the effective behavior is identical either way). Each morning, compare the emailed "DRY RUN" message (classification + reasoning + the `chargeUpperSoc` it would have set) against what the weather actually did that day — the dashboard's "Last night's accuracy" widget (see above) is doing a version of this same comparison automatically once a Bedrock model is configured, so it's worth cross-checking your own read against its `accurate` verdict too. If the classification and reasoning consistently match your own judgement, it's reasonable to switch to live — either via the dashboard's "Control mode" toggle (immediate, no redeploy) or by setting `dryRun: false` in your local config and redeploying (the more deliberate route). If example-4-style borderline days keep coming up wrong, tighten the `maxPop`/`avgClouds` thresholds in `classifyForecast` first.
