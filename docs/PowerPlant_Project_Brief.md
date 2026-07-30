# PowerPlant monitoring app — project brief

## Background

This home recently had a battery added to its existing solar system.

- Inverter: SolaX X1-VAST
- Inverter SN: `<INVERTER_SN>` (real value kept only in the gitignored local config — see README)
- Wi-Fi module / registration no.: `<WIFI_SN>` (the `wifiSn`/`registerNo` — used by the older `dataAccess/realtimeInfo` endpoint; the OpenAPI platform we actually use keys off `deviceSn` instead, see below)
- Monitoring platform: **SolaX Cloud**

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
- The client library (`lambda/Utilities/solax-client.js`) intentionally implements only the read/monitoring endpoints (Auth, Information Management, Monitoring Management) — the many control/write endpoints in `docs/solax-apis.md` (EMS work modes, inverter work mode control, VPP remote control, export/import limits, EV charger control, battery heating) are out of scope for now, since this app recommends battery configuration changes rather than applying them automatically.

## Proposed architecture

1. **Poller Lambda** — triggered by EventBridge every 5 minutes, calls SolaX Cloud, writes a row to DynamoDB keyed by timestamp.
2. **DynamoDB** — time-series store of energy data (PV yield, import, export, battery charge/discharge, SOC, fault status).
3. **Dashboard API Lambda** — aggregates DynamoDB into daily/weekly rollups, serves the dashboard.
4. **Web dashboard** — S3 + CloudFront (or similar), charts PV/battery/import/export like the manual reports we've reviewed.
5. **Alert Lambda** — watches for unusually high import outside the overnight charge window, and real Inverter fault codes (`deviceStatus` 103 recoverable / 104 permanent, per Appendix 6); sends notifications via SNS (email/SMS). Residential batteries have no fault codes to check (only Idle/Work).
6. **Report Lambda** — triggered nightly by EventBridge, assesses the full accumulated history in DynamoDB, and recommends battery configuration optimizations against the tariff structure; publishes the report via SNS.
7. **SSM Parameter Store** — holds the SolaX OAuth Client ID/Secret as SecureString parameters, provisioned by the CDK stack itself (via a custom resource, since CloudFormation can't create SecureString parameters natively) rather than committed to the repo.

## Build phases

1. **Ingest** — done, both Inverter and Battery devices.
2. **Dashboard** — `DashboardApiFunction` implemented (`GET /readings?range=day|week`, includes battery data); the actual S3+CloudFront web frontend isn't scaffolded yet.
3. **Cost tracking** — done — tariff structure known and wired into `DashboardApiFunction`/`ReportFunction`.
4. **Alerts** — done — real Inverter fault codes (103/104) and import anomalies.
5. **Nightly assessment & recommendations** — done — `ReportFunction` evaluates the last day's usage by tariff window, is SOC-aware when battery data is present, and recommends battery configuration changes, delivered as a report via SNS. Both SNS topics have a confirmed email subscription.

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

Kept in `config/dev-powerplant.json`'s `tariff` block (`importRates` + `feedInRate`, safe to publish — these are the retailer's public rates, not account-specific), used by `ReportFunction`/`DashboardApiFunction`/`AlertFunction` via the shared `lambda/Utilities/tariff.js`. That block also has a `timezone` field (defaults to `Australia/Sydney`, **an assumption, not confirmed**) — time-of-day windows are meaningless without converting each reading's UTC timestamp to local time first, so if the site is in a non-DST-observing state (e.g. Queensland), this needs correcting in the local config or readings near a DST transition will be priced against the wrong window.
