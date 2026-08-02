# Electricity plan comparison — Energex network, South East QLD

A point-in-time comparison of retail electricity plans available to this site, run against the plan actually deployed (AGL Night Saver EV, `config.tariff`). Source data collected 2026-08-02 via a household-tailored Energy Made Easy comparison (47 plans). **Sanitized for the repo**: the exact postcode/suburb from the source comparison has been deliberately omitted — same sensitivity tier as `config.location.lat`/`lon` (see CLAUDE.md's SolaX section) — the network/state-level detail above is all that's needed to make the plan data meaningful. The full unsanitized source comparison (which does name the exact site location, including in its own filename) stays local-only — gitignored, not committed.

The full structured plan data (all 47 plans, same sanitization applied) is available as JSON: [electricity-plan-comparison.json](electricity-plan-comparison.json) — same source as the reference tables below, useful if you want to re-run or extend this comparison programmatically rather than re-reading the tables.

## Household usage profile (from the comparison tool)

| | |
|---|---|
| Average daily grid import | 25.11 kWh/day ("High use" tier) |
| Average daily solar export | 15.58 kWh/day |
| Meter type | Smart meter |
| Network tariff codes | 7500, 6900 (Energex) |

This is Energy Made Easy's own tailored figure for the site, based on historical billing data — a fuller-year picture than the ~2.6 days of live `PollerFunction` telemetry available at analysis time (see Methodology below for how the two were reconciled).

## The plan actually deployed: AGL Night Saver EV

Not itself listed in the 47-plan comparison (see "Known limitations" below) — these are the real rates from `config.tariff`, cross-checked against the retailer's published plan summary:

| Window | Hours | Rate |
|---|---|---|
| Night Saver EV charge | 00:00–06:00 | 8c/kWh |
| Shoulder (morning) | 06:00–09:00 | 32.384c/kWh |
| Off-peak | 09:00–16:00 | 20.141c/kWh |
| Peak | 16:00–21:00 | 41.756c/kWh |
| Shoulder (night) | 21:00–24:00 | 32.384c/kWh |
| Feed-in | all day | 2c/kWh flat |
| Supply charge | — | 168.927c/day |

**No EV on site** — the discounted overnight window is used purely for the battery's scheduled grid charge (`BatteryControlFunction`), not vehicle charging.

## Recommendation: OVO Energy — "The EV Plan"

The deciding factor for this site isn't the headline plan-comparison numbers (which assume a generic load shape) — it's that **over 95% of this site's grid import happens in one overnight window** (00:00–06:00, matching the battery's scheduled charge), with solar covering virtually everything else. That makes the overnight rate the only number that matters.

| | AGL Night Saver EV (current) | **OVO The EV Plan** |
|---|---|---|
| Overnight rate (00:00–06:00) | 8c/kWh | **4.5c/kWh** |
| Supply charge | 168.927c/day | 192.01c/day |
| Feed-in | 2c/kWh flat | 1c/kWh flat |

| Scenario | AGL (current) | OVO EV Plan | Saving |
|---|---|---|---|
| Observed telemetry (~20.3 kWh/night import, ~2.4 kWh/day export) | $1,192/yr | **$1,026/yr** | **−$166/yr** |
| Conservative (10 kWh/night import) | $891/yr | $856/yr | −$35/yr |
| Full household profile (25.11 kWh/day import, 15.58 kWh/day export) | $1,236/yr | **$1,056/yr** | **−$180/yr** |

OVO wins in every scenario tested. The breakeven point — where it stops being cheaper — is **7.3 kWh of nightly import**; the real system pulls roughly 2.8× that, so the result is robust to the usage uncertainty. Also branded for EV owners but works identically here, same as the current plan.

**Before switching**: confirm OVO's actual contract terms (the source listing notes "1 condition, 2 special offers" not detailed in the plan data) and that AGL Night Saver EV — which no longer appears in new-customer listings, see below — can't be re-joined later if that matters.

### Why the other 45 plans don't compete

- **Dodo Residential Standing (TOU)** has a good overnight rate (6.98c, wider 10pm–7am window) but a $222.61/day supply charge (+$196/yr vs AGL) erases the advantage — $129–159/yr *worse* than AGL, not better.
- **Every other time-of-use plan** in the comparison defines its cheapest window as mid-morning-to-afternoon (typically 9/11am–4pm) rather than overnight — exactly when this site needs the grid least, since solar already covers it. Their actual overnight rate (usually labeled "shoulder") runs 19–29c/kWh, 2.5–3.5× AGL's night rate.
- **Single-rate plans** can't compete structurally — a flat 13–32c/kWh rate always loses to 8c (or 4.5c) applied to >95% of usage. The one exception worth naming: **Amber Electric's variable-wholesale plan** (13.29c indicative usage rate, +6.93c average feed-in) — real-time wholesale pricing is often cheap overnight, but it's a genuinely variable rate rather than a fixed guarantee, so it wasn't scored numerically here.
- **Worth revisiting later, not now**: CovaU SolarMax offers 15c/kWh feed-in specifically for 6–9pm exports — the same window `GridDischargeFunction` targets. Not competitive today (16.5c overnight rate is double AGL's), but if that feature is ever validated and switched live with meaningful export volume, this is the one plan where the economics could shift.
- **AGL Night Saver EV itself doesn't appear in the 47-plan comparison** — only two unrelated AGL Seniors Saver plans do, suggesting it may be closed to new customers and the site is on a grandfathered rate.

## Full plan reference (sanitized)

All 47 plans from the source comparison, location details stripped. `Est. annual (tailored)` is Energy Made Easy's own household-tailored estimate (generic load shape assumption — see Methodology), not the overnight-window-aware figures used in the recommendation above.

### Time-of-use plans

| Provider | Plan | Supply (c/day) | Rates | Feed-in (c/kWh) | Est. annual (tailored) |
|---|---|---|---|---|---|
| GloBird Energy | GLOSAVE Residential (Flexible Energy)-Energex | 127.6 | peak: 33.66c (4:00pm-8:59pm); shoulder: 19.36c (9:00pm-8:59am); off_peak: 19.36c (9:00am-3:59pm) | +2 | ~~$2500~~ $2380 |
| OVO Energy | The EV Plan | 192.01 | peak: 27.97c (6:00am-11:59pm); off_peak: 4.5c (12:00am-5:59am) | +1 | $2450 |
| Red Energy | Standing Offer | 192.01 | peak: 45.1c (4:00pm-7:59pm weekdays); shoulder: 26.84c (7am-3:59pm & 8-9:59pm weekdays; 7am-9:59pm weekends); off_peak: 13.04c (10:00pm-6:59am all week) | +5 | $2520 |
| Dodo | Residential Standing | 222.61 | peak: 47.79c (4:00pm-7:59pm weekdays); shoulder: 25.3c (7am-3:59pm & 8-9:59pm weekdays; 7am-9:59pm weekends); off_peak: 6.98c (10:00pm-6:59am) | +1 | $2570 |
| Nectr | Nectr Power Perks Time of Use | 144.6 | peak: 36.99c (4:00pm-8:59pm); shoulder: 21.41c (9:00pm-10:59am); off_peak: 14.88c (11:00am-3:59pm) | +0 | ~~$2860~~ $2660 |
| EnergyAustralia | QLD Seniors Offer - 7 Day TOU | 177.85 | peak: 47.79c (4:00pm-8:59pm); shoulder: 25.3c (9:00pm-10:59am); off_peak: 6.98c (11:00am-3:59pm) | +4 | ~~$3210~~ $2800 |
| Kogan Energy | Kogan Energy for current FIRST members | 93.02 | peak: 44.86c (4:00pm-8:59pm); shoulder: 23.75c (9:00pm-10:59am); off_peak: 6.56c (11:00am-3:59pm) | +1 | $2900 |
| Powershop | Power House | 93.02 | peak: 44.86c (4:00pm-8:59pm); shoulder: 23.75c (9:00pm-10:59am); off_peak: 6.56c (11:00am-3:59pm) | +1 | $2900 |
| Alinta Energy | HomeDeal Smart - Time of Use | 156.51 | peak: 42.05c (4:00pm-8:59pm); shoulder: 22.26c (12:00am-10:59am, 9:00pm-11:59pm); off_peak: 6.15c (11:00am-3:59pm) | +2 | $2910 |
| CovaU | SolarMax QLD Energex Residential TOU | 152 | peak: 49.55c (3:00pm-8:59pm); shoulder: 16.5c (12:00am-5:59am); shoulder2: 11am-1:59pm: first 50kWh/day 0.00c, remaining 26.91c; off_peak: 26.91c (6-10:59am, 2-2:59pm, 9-11:59pm) | tiered: 15c (peak 6-9pm, 0-30kWh/day), 5c (peak 6-9pm, 30kWh+/day), 5c (off-peak 9pm-6pm) | $3000 |
| Sumo | Sumo Sunrise Plus Residential TOU | 120.78 | peak: 38.34c (4:00pm-8:59pm); shoulder: 25.52c (9:00pm-10:59am); off_peak: 25.08c (11:00am-3:59pm) | +0 | ~~$3110~~ $3010 |
| ENGIE | QLD_ENGIE Perks Elec | 177.85 | peak: 47.78c (4:00pm-8:59pm); shoulder: 25.29c (9:00pm-10:59am); off_peak: 6.97c (11:00am-3:59pm) | +1 | ~~$3380~~ $3040 |
| Origin Energy | Origin Affinity Variable ePlus Ongoing - One Big Switch | 168.94 | peak: 45.4c (4:00pm-8:59pm); shoulder: 24.04c (9:00pm-10:59am); off_peak: 6.63c (11:00am-3:59pm) | +3 | $3100 |
| AGL | Residential Seniors Saver - New To AGL | 167.18 | peak: 44.92c (4:00pm-8:59pm); shoulder: 23.78c (9:00pm-10:59am); off_peak: 6.57c (11:00am-3:59pm) | +2 | $3120 |
| Flow Power | Flow Home | 140.2 | flat: 30.19c | +2 | $3160 |
| Momentum Energy | Home Comfort Electricity | 174.24 | peak: 45.87c (4:00pm-8:59pm); shoulder: 24.31c (9:00pm-10:59am); off_peak: 6.71c (11:00am-3:59pm) | +2 | $3200 |
| Diamond Energy | Diamond Everyday - Time of Use | 168.69 | peak: 47.72c (4:00pm-8:59pm); shoulder: 25.12c (9:00pm-10:59am); off_peak: 6.98c (11:00am-3:59pm) | +3.1 | $3220 |
| Flipped Energy | Freedom Switched On 2.2! | 118.6 | peak: 53.46c (4:00pm-7:59pm); shoulder: 29.01c (8:00pm-7:59am); off_peak: 8.54c (8:00am-3:59pm) | tiered: 2c day, 7.21c evening, 4.34c overnight | ~~$3300~~ $3270 |
| Future X Power | Energex - RESI Time of Use FY27 | 177.85 | peak: 47.79c (4:00pm-8:59pm); shoulder: 25.3c (12:00am-10:59am, 9:00pm-11:59pm); off_peak: 6.98c (11:00am-3:59pm) | +3 | $3270 |
| Energy Locals Retail | Home Choice | 176.07 | peak: 47.3c (4:00pm-8:59pm); shoulder: 25.04c (12:00am-10:59am, 9:00pm-11:59pm); off_peak: 6.91c (11:00am-3:59pm) | tiered: 10c peak(4-9pm), 3.5c off-peak(9pm-10am), 1.5c shoulder(10am-4pm) | $3320 |
| 1st Energy | 1st Quartz - Time of Use | 174.24 | peak: 46.75c (4:00pm-8:59pm); shoulder: 24.75c (9:00pm-10:59am); off_peak: 6.82c (11:00am-3:59pm) | tiered: 1c first 5kWh/day, 0.1c thereafter | $3360 |
| Amber Electric | Standing Offer: TOU | 177.85 | peak: 47.79c (4:00pm-8:59pm); shoulder: 25.3c (9:00pm-10:59am); off_peak: 6.98c (11:00am-3:59pm) | +0 | $3440 |
| Tango Energy | Solar Sharer Offer | 177.85 | peak: 48.9c (4:00pm-8:59pm); shoulder: 26.41c (9:00pm-10:59am); shoulder2: 8.1c (2:00pm-3:59pm); off_peak: 11:00am-1:59pm: first 24kWh/day 0.00c, remaining 8.10c | +0 | $3110 (generic high-tier only) |

### Single-rate plans

| Provider | Plan | Supply (c/day) | Rate (c/kWh) | Feed-in (c/kWh) | Est. annual (tailored) |
|---|---|---|---|---|---|
| Amber Electric | Battery + Solar: Variable Wholesale Prices (estimate) | 122.83 | 13.29 | +6.93 (variable, wholesale pass-through, guaranteed minimum 0c/kWh over a financial year) | $1570 |
| GloBird Energy | BOOST Residential (Flat Rate)-Energex | 137.5 | block: 23.21c first 25kWh/day, 24.75c thereafter | +2 | ~~$2540~~ $2490 |
| EnergyAustralia | QLD Seniors Offer | 192.01 | 27.97 | +4 | ~~$3040~~ $2650 |
| Kogan Energy | Kogan Energy with free FIRST | 103.92 | 26.23 | +1 | $2730 |
| Powershop | Power House | 103.92 | 26.23 | +1 | $2730 |
| Nectr | Nectr Power Perks | 170.07 | 25.25 | +0 | ~~$2940~~ $2740 |
| Alinta Energy | HomeDeal Smart - Single Rate | 168.97 | 24.62 | +2 | $2760 |
| Flipped Energy | Anytime Switched On 2.2! | 118.6 | 27.32 | +2 | ~~$2820~~ $2790 |
| ENGIE | QLD _ ENGIE Perks Elec | 192.01 | block: 27.97c first 13kWh/day, 27.97c thereafter (identical tiers - effectively flat) | +1 | ~~$3210~~ $2880 |
| CovaU | Freedom Residential Single | 185.97 | 32.25 | +3 | ~~$3460~~ $2930 |
| Origin Energy | Origin Affinity Variable ePlus Ongoing - One Big Switch | 182.41 | 26.58 | +3 | $2930 |
| OVO Energy | The One Plan | 151.69 | 27.13 | +2 | $2930 |
| AGL | Residential Seniors Saver - New To AGL | 180.49 | block: 26.29c first 379kWh/year, 26.29c thereafter (identical tiers - effectively flat) | +2 | $2950 |
| Red Energy | Standing Offer | 192.01 | 27.97 | +5 | $2980 |
| Momentum Energy | Home Comfort Electricity | 188.1 | 26.84 | +2 | $3030 |
| Sumo | Sumo Sunrise Plus Residential Single Rate | 118 | 30 | +0 | ~~$3180~~ $3080 |
| Diamond Energy | Diamond Everyday - Single Rate | 192.02 | 27.97 | +3.1 | $3090 |
| Future X Power | Energex - RESI Anytime FY27 | 192.02 | 27.97 | +3 | $3090 |
| Next Business Energy | NBE Standing Offer | 192.01 | block: 27.97c first 27.4kWh/day, 27.97c thereafter (identical tiers - effectively flat) | +2 | $3150 |
| Flow Power | Flow Home | 140.2 | 30.19 | +2 | $3160 |
| Energy Locals Retail | Home Choice | 190.09 | 27.69 | tiered: 3c for 0-5kWh/day, 1c for 5kWh+/day | $3170 |
| 1st Energy | 1st Quartz - Single Rate | 188.1 | 27.39 | tiered: 1c first 5kWh/day, 0.1c thereafter | $3190 |
| Dodo | Residential Standing | 192.02 | 27.97 | +1 | $3210 |
| Energy Locals Urban | Standing Offer | 192.02 | 27.97 | +0 | $3260 |

### Known limitations of the source data

- Energy Made Easy showed "25 of 25" plans on the single-rate tab but only 24 distinct cards rendered.
- Flow Power's "Flow Home" is listed under both Time of Use and Single Rate tabs but charges an identical flat rate at all times either way — economically a single-rate plan.
- Several "block"/tiered-rate plans (ENGIE, Next Business Energy, AGL Seniors Saver) have identical rates across every tier, functioning as flat rates despite the tiered display.
- GloBird BOOST Residential has a genuine two-tier block rate: 23.21c for the first 25kWh/day, 24.75c thereafter.
- Two single-rate plans have tiered (volume-based) solar feed-in: Energy Locals Home Choice (3c for 0–5kWh/day, 1c for 5kWh+/day) and 1st Quartz Single Rate (1c first 5kWh/day, 0.1c thereafter).
- Tango Energy's household-tailored cost wasn't available; only the generic high-usage-tier detail-page estimate ($3,110/yr) is shown.

## Methodology

This site's import is concentrated almost entirely in one 6-hour overnight window because `BatteryControlFunction` deliberately schedules the battery's grid charge there. That makes Energy Made Easy's own tailored estimates (which apply a generic residential load shape to the 25.11 kWh/day average) a poor fit for ranking plans here — a plan's peak/shoulder/midday rates are close to irrelevant when almost nothing is imported during those windows.

Instead, each candidate plan's annual cost was recomputed directly: `supply charge + (nightly import kWh × that plan's overnight-window rate) − (daily export kWh × that plan's feed-in rate)`, using the plan's *own* stated time boundaries to confirm the 00:00–06:00 window falls fully within whichever off-peak/shoulder window it defines. Two import/export scenarios were used — the live `PollerFunction` telemetry available at analysis time (~2.6 days, a thin sample) and Energy Made Easy's own full-profile figures (25.11 kWh/day import, 15.58 kWh/day export, likely a fuller-year average including higher-solar months) — to confirm the ranking holds regardless of which is closer to reality. See [docs/automated-rules.md](automated-rules.md) for the live-deployed tariff configuration this was compared against.
