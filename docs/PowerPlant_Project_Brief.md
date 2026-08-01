# PowerPlant monitoring app — project brief

## Background

This home recently had a battery added to its existing solar system.

- Inverter: SolaX X1-VAST
- Inverter SN: `<INVERTER_SN>` (real value kept only in the gitignored local config — see README)
- Wi-Fi module / registration no.: `<WIFI_SN>` (the `wifiSn`/`registerNo` — used by the older `dataAccess/realtimeInfo` endpoint; the OpenAPI platform we actually use keys off `deviceSn` instead, see below)
- Monitoring platform: **SolaX Cloud**
- Site location: real coordinates kept only in the gitignored local config (`config.location.lat`/`lon`/`timezone`), same as the inverter SN — the site is in a state that doesn't observe DST, which resolved a previously-open timezone question (see Tariff details below)

## What we've learned from manual report exports so far

**Monthly report (16–30 July 2026), 15 days:**

| Metric | Total | Daily avg |
|---|---|---|
| PV yield | 422 kWh | 28.1 kWh |
| Battery charged | 227 kWh | 15.1 kWh |
| Battery discharged | 205 kWh | 13.7 kWh |
| Exported to grid | 81 kWh | 5.4 kWh |
| Imported from grid | 375 kWh | 25.0 kWh |

**Daily 5-min interval report (29 July 2026)** showed *why* import looked high: nearly all grid import (28 of 28.1 kWh) happens between midnight and 6am, then flatlines for the rest of the day. This is deliberate — the household charges the battery (and sometimes the EV) overnight on an **8c/kWh off-peak rate**, then runs on solar + battery for the rest of the day, exporting surplus once the battery is full. The "high import" figure in the monthly view is cheap scheduled charging, not a shortfall.

**Resolved:** the full tariff structure (import rates + feed-in rate) is now known — see Tariff details below — and `ReportFunction`/`DashboardApiFunction` are implemented, so this cost/savings comparison is now computed automatically (nightly report + on-demand dashboard rollup).

## Goal

Build an app that pulls data directly from SolaX Cloud via API key, replacing manual report exports, and gives a running/meaningful view of the system. The core purpose is to extract and store all usage data, then use it to recommend optimised battery configuration options (charge window, capacity usage, discharge threshold) against the known tariff structure. A nightly assessment job evaluates the accumulated data and delivers a report with these recommendations. Phased build, hosted on AWS (Lambda/DynamoDB) to fit existing stack.

## SolaX Cloud API notes

The full API reference is in `docs/solax-apis.md` (not a secret, kept in the repo) — this section is just the parts relevant to our use.

- **Auth**: `POST /openapi/auth/oauth/token`, Client ID/Secret (from developer.solaxcloud.com) → Bearer `access_token`, ~30 day expiry. Base URL for our account: `https://openapi-eu.solaxcloud.com`. Credentials live in `solax-application-creds.txt` (gitignored) until seeded into SSM — see `CLAUDE.md`.
- **Real-time telemetry is on this same OpenAPI platform** — `GET /openapi/v2/device/realtime_data` (`deviceType` per Appendix 3, `businessType=1` = Residential), keyed by `snList`. This resolves the earlier open question: the poller does **not** need the older `tokenId`-based `dataAccess/realtimeInfo` endpoint.
- **Historical query endpoint does exist** on this platform (`GET /openapi/v2/device/history_data`, range ≤1 year, query span ≤12h) — contradicts our original assumption. We still poll-and-store ourselves every 5 minutes rather than relying on it, since we want our own always-available time series for the dashboard/report rather than depending on SolaX's retention and query-span limits.
- **Resolved**: `docs/solax-apis.md` was extended with the full Appendix section (1-8), closing the two gaps that used to limit this app. Appendix 3 confirms `deviceType`: Inverter=1, **Battery=2**, Meter=3, EV Charger=4, EMS=100 — `PollerFunction` now fetches the Battery device too (auto-discovered by `deviceType` if its `deviceSn` isn't pinned in config), so `DashboardApiFunction`/`ReportFunction` can reason about actual battery SOC/charge-discharge, not just grid import/export. Appendix 6 confirms `deviceStatus`: for the Inverter, `103` = recoverable fault, `104` = permanent fault (everything else is a normal operating/mode state) — `AlertFunction` now alerts specifically on those two codes rather than on any change. Residential batteries only ever report `0`=Idle/`1`=Work — no fault codes exist there.
- The client library (`lambda/Utilities/solax-client.js`) implements the read/monitoring endpoints (Auth, Information Management, Monitoring Management), plus three control/write endpoints: §7 Inverter Work Mode Control's Self Use mode (`batch_set_spontaneity_self_use`), used by `BatteryControlFunction` — see Automated battery control below; and §9 VPP Remote Control's SOC Target Control (`soc_target_control_mode`) and Exit VPP mode (`exit_vpp_mode`), used by `GridDischargeFunction` — see Grid discharge arbitrage below. Every other control/write endpoint in `docs/solax-apis.md` (EMS work modes, the rest of VPP remote control, export/import limits, EV charger control, battery heating) is still out of scope.

## Proposed architecture

1. **Poller Lambda** — triggered by EventBridge every 5 minutes, calls SolaX Cloud, writes a row to DynamoDB keyed by timestamp.
2. **DynamoDB** — time-series store of energy data (PV yield, import, export, battery charge/discharge, SOC, fault status).
3. **Dashboard API Lambda** — aggregates DynamoDB into daily/weekly rollups, serves the dashboard; also serves the latest nightly report (recommendation + AI narrative) and the latest weather/charge decision, both persisted by the Report and Battery Control Lambdas under sentinel `DeviceSn` prefixes in the same table. Two write actions too: a manual "run assessment now" trigger (invokes the Report Lambda on demand) and dashboard-editable battery-control settings (charge %, on/off toggle) — the app's first writes from the dashboard, gated by the Cognito login.
4. **Web dashboard** — S3 + CloudFront, static SPA (`dashboard/`) charting PV/battery/import/export like the manual reports we've reviewed, plus a recommendation/AI-insights panel and a weather/charge-decision widget pair, in its own stack (`DashboardStack`) so its S3 origin and the API Gateway origin can share one CloudFront distribution without a cross-stack dependency cycle. Gated behind a Cognito login (single admin-created user, no self-service sign-up) — the API key alone only proves a request came through CloudFront, not that the person on the other end is authorized.
5. **Alert Lambda** — watches for unusually high import outside the overnight charge window, and real Inverter fault codes (`deviceStatus` 103 recoverable / 104 permanent, per Appendix 6); sends notifications via SNS (email/SMS). Residential batteries have no fault codes to check (only Idle/Work).
6. **Report Lambda** — triggered nightly by EventBridge, assesses the full accumulated history in DynamoDB, and recommends battery configuration optimizations against the tariff structure; publishes the report via SNS. Optionally calls Bedrock for an AI narrative and pattern-based anomaly detection on top of that heuristic.
7. **Battery Control Lambda** — triggered nightly by EventBridge, before the overnight grid-charge window. Checks tomorrow's weather forecast and adjusts the inverter's grid-charge target (`chargeUpperSoc`) accordingly — the app's first control/write call to SolaX Cloud, dry-run by default. The charge percentages and a real on/off kill switch are dashboard-editable, overriding the static config. Before each decision it also has Bedrock judge the previous night's decision against what actually happened (usage, not just weather) — see `docs/battery-charge-logic.md`.
8. **SSM Parameter Store** — holds the SolaX OAuth Client ID/Secret and the OpenWeatherMap API key as SecureString parameters, provisioned by the CDK stack itself (via a custom resource, since CloudFormation can't create SecureString parameters natively) rather than committed to the repo.

## Build phases

1. **Ingest** — done, both Inverter and Battery devices.
2. **Dashboard** — done — `DashboardApiFunction` (`GET /readings?range=day|week`, includes battery data, plus `/insights` and `/battery-status` for the nightly recommendation/AI narrative and the weather/charge decision) plus a static S3+CloudFront frontend (`dashboard/`, `DashboardStack`) that calls it same-origin, with CloudFront injecting the API key so it never reaches the browser, and a Cognito login gating the data itself.
3. **Cost tracking** — done — tariff structure known and wired into `DashboardApiFunction`/`ReportFunction`.
4. **Alerts** — done — real Inverter fault codes (103/104) and import anomalies.
5. **Nightly assessment & recommendations** — done — `ReportFunction` evaluates the last day's usage by tariff window, is SOC-aware when battery data is present, and recommends battery configuration changes, delivered as a report via SNS. Both SNS topics have a confirmed email subscription. Optionally enriched with a Bedrock-generated narrative and pattern-based anomaly flags (`config.bedrock.modelId`) on top of the deterministic heuristic.
6. **Automated battery control** — implemented, dry-run by default: `BatteryControlFunction` checks tomorrow's OpenWeatherMap forecast nightly and adjusts the Inverter's grid-charge target (`chargeUpperSoc`, via `batch_set_spontaneity_self_use` — a control/write endpoint, the first this app calls) — sunny forecast → 40% (enough to cover morning usage until solar recharges it); overcast/rainy or ambiguous forecast → 100% (safe default). `config.batteryControl.dryRun` defaults `true` — logs and emails what it *would* do without ever calling the control endpoint. Full decision logic, thresholds, and worked examples for review before enabling live: `docs/battery-charge-logic.md`.
7. **Grid discharge arbitrage** — implemented, dry-run by default: the retailer offers a premium 27c/kWh feed-in rate 5-9pm (vs. a flat 2c/kWh the rest of the day) — `GridDischargeFunction` calculates how much battery capacity is genuinely surplus to the evening's load (from historical shoulder-night usage, never more than that — self-consumption still avoids more than exporting earns) and discharges just that surplus to the grid via VPP SOC Target Control (`soc_target_control_mode`), then calls Exit VPP mode at 9pm to hand control back to `BatteryControlFunction`'s normal schedule. `config.gridDischarge.dryRun` defaults `true`. Full calculation and a worked example from real data: `docs/grid-discharge-logic.md`.
8. **Settings optimizer** — implemented, recommendation-only by default: the four tuning defaults above (`chargeUpperSocSunny`/`chargeUpperSocOvercast`/`gridDischarge.fallbackReservePercent`/`gridDischarge.safetyMarginPercent`) were each set once and never revisited — `SettingsOptimizerFunction` runs weekly, aggregates a week of `BatteryControlFunction`'s/`GridDischargeFunction`'s own decision-accuracy history, and asks Bedrock whether any should change, bounded by a minimum sample size and a maximum per-week adjustment regardless of what the model recommends. `config.settingsOptimizer.autoApply` defaults `false` — emails a recommendation without changing anything until enabled. Full logic and known risks: `docs/settings-optimizer-logic.md`.

## Tariff details known so far

Import rates (AUD/kWh) by time-of-day window:

| Window | Label | Rate ($/kWh) |
|---|---|---|
| 00:00–06:00 | Night / EV charge | 0.08 |
| 06:00–09:00 | Shoulder | 0.32384 |
| 09:00–16:00 | Off-peak | 0.20141 |
| 16:00–21:00 | Peak | 0.41756 |
| 21:00–24:00 | Shoulder | 0.32384 |

**Feed-in tariff: 0.02 $/kWh** (flat, all export).

This confirms the earlier open question: the household's overnight charging (0.08) is indeed far cheaper than any daytime rate, including the 09:00–16:00 solar-hours window (0.20141) — so running the battery down before that window and refilling from solar makes sense. And with feed-in this low (0.02) against a 0.41756 peak import rate, holding battery charge through 16:00–21:00 rather than exporting surplus earlier is clearly the highest-value target for battery configuration — exporting during that window instead of self-consuming would cost roughly 20x the feed-in credit in avoided-import terms.

Kept in `config/dev-powerplant.json`'s `tariff` block (`importRates` + `feedInRate`, safe to publish — these are the retailer's public rates, not account-specific), used by `ReportFunction`/`DashboardApiFunction`/`AlertFunction`/`BatteryControlFunction` via the shared `lambda/Utilities/tariff.js`. Time-of-day windows are meaningless without converting each reading's UTC timestamp to local time first, so the timezone that drives this comes from `config.location.timezone` — kept with `lat`/`lon` rather than inside `tariff` itself, since a timezone describes the site being monitored, not the tariff structure (and `BatteryControlFunction`'s weather lookup needs that same location). The public template defaults `config.location.timezone` to `Australia/Sydney`, still just a generic assumption for anyone else reusing this template — but for this real deployment, it's now resolved: the site is in a state that doesn't observe DST, so the local config uses `Australia/Brisbane` (fixed UTC+10) instead. This was a real bug (readings near a DST transition would have priced against the wrong tariff window under `Australia/Sydney`), caught only once the site's actual coordinates were known for the weather integration.
