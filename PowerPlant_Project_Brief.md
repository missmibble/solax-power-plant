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

**Open question:** compare the cost of overnight charging vs. the value of avoided daytime import (need peak/shoulder import rate and feed-in tariff rate to calculate this properly).

## Goal

Build an app that pulls data directly from SolaX Cloud via API key, replacing manual report exports, and gives a running/meaningful view of the system. The core purpose is to extract and store all usage data, then use it to recommend optimised battery configuration options (charge window, capacity usage, discharge threshold) against the known tariff structure. A nightly assessment job evaluates the accumulated data and delivers a report with these recommendations. Phased build, hosted on AWS (Lambda/DynamoDB) to fit existing stack.

## SolaX Cloud API notes

The full API reference is in `solax-apis.md` (not a secret, kept in the repo) — this section is just the parts relevant to our use.

- **Auth**: `POST /openapi/auth/oauth/token`, Client ID/Secret (from developer.solaxcloud.com) → Bearer `access_token`, ~30 day expiry. Base URL for our account: `https://openapi-eu.solaxcloud.com`. Credentials live in `solax-application-creds.txt` (gitignored) until seeded into SSM — see `CLAUDE.md`.
- **Real-time telemetry is on this same OpenAPI platform** — `GET /openapi/v2/device/realtime_data` (`deviceType=1` confirmed = Inverter, `businessType=1` = Residential), keyed by `snList` (our inverter SN — see the gitignored local config). This resolves the earlier open question: the poller does **not** need the older `tokenId`-based `dataAccess/realtimeInfo` endpoint.
- **Historical query endpoint does exist** on this platform (`GET /openapi/v2/device/history_data`, range ≤1 year, query span ≤12h) — contradicts our original assumption. We still poll-and-store ourselves every 5 minutes rather than relying on it, since we want our own always-available time series for the dashboard/report rather than depending on SolaX's retention and query-span limits.
- **Gap**: `solax-apis.md` (the doc the user extracted from the portal) cuts off mid-sentence in §11 and never includes Appendices 1-8 — the numeric codes for `deviceType` (Battery/Meter/EV Charger — only Inverter=1 and EMS=100 are confirmed), `deviceStatus`, `deviceModel`, alarm/flag codes. Battery SOC/charge-discharge fields come from a separate Battery device (its own `deviceSn`, unconfirmed `deviceType`) — the poller currently only fetches the Inverter device. Confirming the Battery device type/SN would let the poller capture SOC and charge/discharge directly instead of only inverter-side fields.
- The client library (`lambda/Utilities/solax-client.js`) intentionally implements only the read/monitoring endpoints (Auth, Information Management, Monitoring Management) — the many control/write endpoints in `solax-apis.md` (EMS work modes, inverter work mode control, VPP remote control, export/import limits, EV charger control, battery heating) are out of scope for now, since this app recommends battery configuration changes rather than applying them automatically.

## Proposed architecture

1. **Poller Lambda** — triggered by EventBridge every 5 minutes, calls SolaX Cloud, writes a row to DynamoDB keyed by timestamp.
2. **DynamoDB** — time-series store of energy data (PV yield, import, export, battery charge/discharge, SOC, fault status).
3. **Dashboard API Lambda** — aggregates DynamoDB into daily/weekly rollups, serves the dashboard.
4. **Web dashboard** — S3 + CloudFront (or similar), charts PV/battery/import/export like the manual reports we've reviewed.
5. **Alert Lambda** — watches for inverter fault codes (103 recoverable, 104 permanent), battery fault/disconnect (`batStatus` 1/2), or unusually high daytime import; sends notifications via SNS (email/SMS).
6. **Report Lambda** — triggered nightly by EventBridge, assesses the full accumulated history in DynamoDB, and recommends battery configuration optimizations against the tariff structure; publishes the report via SNS.
7. **SSM Parameter Store** — holds the SolaX OAuth Client ID/Secret as SecureString parameters, provisioned by the CDK stack itself (via a custom resource, since CloudFormation can't create SecureString parameters natively) rather than committed to the repo.

## Build phases

1. **Ingest** — poller Lambda + DynamoDB, replicate the 5-minute granularity we've been seeing manually.
2. **Dashboard** — daily/weekly charts of PV, battery, import/export.
3. **Cost tracking** — feed in tariff structure (8c off-peak midnight–6am, peak/shoulder rate, feed-in rate) to compute daily cost and estimated savings from the battery.
4. **Alerts** — faults and anomalies via SNS.
5. **Nightly assessment & recommendations** — report Lambda evaluates the accumulated usage data and recommends battery configuration optimizations, delivered as a nightly report.

## Tariff details known so far

- Off-peak import: 8c/kWh, midnight–6am
- Peak/shoulder import rate: not yet provided
- Feed-in tariff: not yet provided
