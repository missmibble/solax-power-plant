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

`sunny` → `chargeUpperSoc = 40`. `overcast` → `chargeUpperSoc = 100`.

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

## Known risks to weigh before enabling live control

- **Stale baseline**: if you change `minSoc`, the time windows, or `chargeFromGridEnable` in the SolaX app directly after this goes live, this function will silently overwrite that change back to whatever's in `config.batteryControl` the next time it runs — because it always resends the full baseline. Any manual change to those settings needs a matching config update + redeploy, or it won't stick.
- **Endpoint choice unconfirmed**: this targets the plain Inverter endpoint (`batch_set_spontaneity_self_use`) based on your confirmation that there's no EMS1000/EMS1000 PRO device on this system. If that's ever wrong, this endpoint won't be the one actually controlling the inverter's behavior.
- **Single forecast source, single point**: one lat/lon, one provider, no fallback — a forecast that's simply wrong for that day (weather forecasting is inherently imperfect) will drive a wrong decision with no cross-check.
- **No verification the change "took"**: there's no read-back endpoint (see above), so a successful API response doesn't strictly prove the inverter's behavior actually changed — only that SolaX Cloud accepted the request.

## How to validate before flipping `dryRun: false`

Leave `dryRun: true` running for at least a couple of weeks. Each morning, compare the emailed "DRY RUN" message (classification + reasoning + the `chargeUpperSoc` it would have set) against what the weather actually did that day. If the classification and reasoning consistently match your own judgement, it's reasonable to flip `dryRun` to `false` in your local config and redeploy. If example-4-style borderline days keep coming up wrong, tighten the `maxPop`/`avgClouds` thresholds in `classifyForecast` first.
