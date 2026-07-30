# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

An AWS CDK app (JavaScript CDK v2), deployed and live: two stacks, all four Lambdas implemented (not stubs). `PollerFunction` polls the real SolaX Cloud API (Inverter device, plus an auto-discovered Battery device) and writes to DynamoDB; `DashboardApiFunction` serves cost-aware rollups including battery charge/discharge/SOC when available; `AlertFunction` reacts to the DynamoDB Stream and checks for import anomalies and real inverter fault codes; `ReportFunction` runs nightly and publishes a usage + battery-recommendation report, SOC-aware when battery data is present. Both SNS topics (`powerplant-alerts`, `powerplant-reports`) have a confirmed email subscription. See [README.md](README.md) for the file layout and commands.

## What this project is

An app that monitors a home solar + battery system by polling the SolaX Cloud API directly, storing the full usage history, and recommending optimised battery configuration options via a nightly assessment report — replacing the manual report exports currently used. Full context, including known site details, learnings from manual reports, and open questions, is in [docs/PowerPlant_Project_Brief.md](docs/PowerPlant_Project_Brief.md) — read it before starting implementation work.

## Commands

```bash
npm install && npm run install-all   # root deps + each lambda/*/'s own deps
npm test                              # jest — all specs in test/
npx jest test/tariff.test.js          # single test file (also: dashboard-api-function, alert-function, report-function, solax-client)
npx cdk diff                          # preview changes against deployed stacks
npx cdk synth                         # synthesize CloudFormation templates (both stacks)
npm run deploy:dev                    # install + test + synth + deploy (scripts/deploy.sh, dev-powerplant.json)
bash scripts/deploy.sh --config dev-powerplant.local.json   # same, against the real/local config
```

CDK config (account, region, resource names, tags, SolaX device settings, tariff) lives in [config/dev-powerplant.json](config/dev-powerplant.json) (public template, placeholders only) — real values go in the gitignored `config/dev-powerplant.local.json`, loaded via `CDK_CONFIG=dev-powerplant.local.json` or `scripts/deploy.sh`'s `--config`/`-c` flag.

## Architecture

Two stacks, defined in [bin/powerplant.js](bin/powerplant.js):

1. **`PowerPlantInfrastructureStack`** ([lib/infrastructure-stack.js](lib/infrastructure-stack.js)) — stateful resources: a DynamoDB time-series table (`DeviceSn` partition key, `Timestamp` sort key, streams enabled), an S3 bucket for future dashboard static assets, an SNS alerts topic, an SNS reports topic, and the SolaX OAuth credentials as SSM `SecureString` parameters. Uses factory methods (`newDynamoDBTableFunction`, `newS3BucketFunction`, `newSNSTopicFunction`, `newSecureStringParameterFunction`) driven entirely by the config JSON — add a resource by adding a config block and a factory call, not by hand-writing CDK constructs inline.
2. **`PowerPlantLambdaFunctionsStack`** ([lib/lambda-functions-stack.js](lib/lambda-functions-stack.js)) — depends on stack 1, takes the table and topics as cross-stack references. Defines four Lambdas via the same `newLambdaFunction` factory pattern (versioned + aliased):
   - `PollerFunction` — EventBridge `rate(5 minutes)` → calls SolaX Cloud for the Inverter device, plus the Battery device (auto-discovered via `getDeviceInfo` if `SOLAX_BATTERY_SN` isn't pinned in config) → writes one combined DynamoDB item per interval. Its role is granted `ssm:GetParameter`/`kms:Decrypt` on the SolaX SSM parameters via `grantSsmParameterRead` (by known ARN, not a live cross-stack reference — see below).
   - `DashboardApiFunction` — fronted by an API-key-protected API Gateway (`GET /readings?range=day|week`) — queries the table by `DeviceSn`+`Timestamp` range, aggregates PV yield/import/export as deltas of the cumulative counters, prices import per-interval against `TARIFF_STRUCTURE`, and includes `batteryChargeKwh`/`batteryDischargeKwh`/`currentBatterySOC` when the readings in range have battery fields (`aggregateReadings`, exported for testing).
   - `AlertFunction` — DynamoDB Stream event source (`INSERT` only). For each new reading it queries the immediately preceding reading (`grantReadData`, not just stream permissions) and runs two checks (`checkImportAnomaly`, `checkInverterFault`, both exported): an import-delta threshold outside the overnight `night-ev-charge` window, and the Inverter entering/changing a real fault state (`deviceStatus` 103 recoverable or 104 permanent — see `DEVICE_STATUS.INVERTER`). Publishes to the alerts SNS topic.
   - `ReportFunction` — EventBridge nightly cron. Queries the last `REPORT_LOOKBACK_DAYS` (default 1) of readings, breaks import down by tariff window (`assessUsage`), and formats a plain-text report (`formatReport`) with a recommendation heuristic (both exported): if peak-window (`peak-evening`) import exceeds 0.5 kWh, recommends holding battery charge into that window rather than exporting earlier (feed-in 0.02 is far below the peak rate) — and when battery SOC data is available for the peak window specifically, differentiates "already depleted before peak started" (raise the charge target) from "ran flat during peak" (raise the discharge cutoff / capacity). Publishes to the reports SNS topic.

Our own polling+storage is deliberate even though SolaX does expose a history endpoint (see below) — it gives an always-available time series with no retention/query-span limits, which both the dashboard and `ReportFunction`'s nightly recommendations depend on.

### SolaX API client (`lambda/Utilities/solax-client.js`)

Shared by all Lambdas via the `powerplant-shared` local package (`lambda/Utilities`, `main: index.js` re-exports `logger.js`, `solax-client.js`, and `tariff.js`). Built from [docs/solax-apis.md](docs/solax-apis.md), the full portal API reference including all 8 appendices (device type/model/status codes). `DEVICE_TYPE` (Appendix 3: Inverter=1, Battery=2, Meter=3, EV Charger=4, EMS=100) and `DEVICE_STATUS` (Appendix 6, the fault-relevant/common subset) are both exported and used directly by `PollerFunction`/`AlertFunction` — no more guessing at unconfirmed codes.

`solax-client.js` deliberately implements only the **read/monitoring** endpoints (`docs/solax-apis.md` §1 Auth, §2 Information Management, §4 Monitoring Management) — it does not implement any of the control/write endpoints (§3, §6-11: EMS work modes, inverter work mode control, VPP remote control, export/import limits, EV charger control, battery heating, A1-Hybrid-G2 modes). Those exist in the doc and could be wired in later if the app should apply its own recommendations automatically, rather than just report them.

`getAccessToken` caches the Bearer token at module scope (reused across warm Lambda invocations); `PollerFunction` separately caches the Client ID/Secret it reads from SSM, and the discovered battery `deviceSn`, the same way.

### Battery device discovery (`PollerFunction.resolveBatterySn`)

The Battery device's `deviceSn` isn't a fixed, known-ahead-of-time value like the inverter's — `config.solax.batterySn` defaults to the placeholder `TODO_BATTERY_SN`. Whenever that env var is unset/still the placeholder, `PollerFunction` calls `getDeviceInfo({ deviceType: DEVICE_TYPE.BATTERY })` (no `plantId` needed — the account only has the one site) and caches the first result's `deviceSn` at module scope. Battery data is strictly a bonus on top of the required Inverter reading: `fetchBatteryReading` swallows its own errors and returns `null` rather than ever failing the whole poll, so a missing/undiscoverable battery just means that interval's DynamoDB item has no battery fields — every downstream consumer (`aggregateReadings`, `assessUsage`) checks for that and degrades gracefully.

### Tariff calculation (`lambda/Utilities/tariff.js`)

Pure functions shared by `DashboardApiFunction`, `AlertFunction`, and `ReportFunction`: `findImportRateWindow(tariff, timestampSeconds)` converts a UTC reading timestamp to local time via `Intl.DateTimeFormat` (no date library dependency) against `tariff.timezone` and matches it to a `[startTime, endTime)` window in `tariff.importRates`; `importCostForWindow` and `exportCredit` build on that. All three Lambdas receive the same `TARIFF_STRUCTURE` env var (`JSON.stringify(config.tariff)`) so there's one source of truth. `config.tariff.timezone` defaults to `Australia/Sydney` — **this is an assumption**, not confirmed; wrong for any AU state that doesn't observe DST (e.g. Queensland), since that would shift which window a reading near a DST transition falls into.

### SolaX credentials via SSM (not Secrets Manager)

CloudFormation can't create `SecureString` SSM parameters natively, so `InfrastructureStack.newSecureStringParameterFunction` provisions them through an `AwsCustomResource` (`aws-cdk-lib/custom-resources`) calling `SSM PutParameter` directly. [bin/powerplant.js](bin/powerplant.js)'s `loadSolaxCredentials()` parses `solax-application-creds.txt` (gitignored, repo root) at synth time and passes the values in; if that file is absent (e.g. deleted after a successful seed), `InfrastructureStack` simply skips creating those two resources. The custom resources are `RemovalPolicy.RETAIN`, so removing them from a later synth (because the file's gone) does not delete the already-seeded parameter values — this is intentional, not a bug. `LambdaFunctionsStack` grants `PollerFunction` read access by reconstructing the parameter ARN from the config's `parameterName`, independent of whether `InfrastructureStack` actually (re-)created the resource this deploy.

Build phases per the project brief: (1) ingest — done, both Inverter and Battery devices, (2) dashboard — `DashboardApiFunction` implemented including battery data, but the S3+CloudFront frontend stack itself isn't scaffolded, (3) cost tracking — done, (4) alerts — done, real fault codes, (5) nightly assessment & recommendations — done, SOC-aware when battery data is present.

## SolaX Cloud API integration notes

- **Base URL**: `https://openapi-eu.solaxcloud.com` (this account's region). **Auth**: `POST /openapi/auth/oauth/token`, Client ID/Secret → Bearer `access_token`, ~30 day expiry, doesn't extend on use (re-call to refresh).
- **Real-time telemetry**: `GET /openapi/v2/device/realtime_data`, `snList` (device serials) + `deviceType` + `businessType` (`1` = Residential). This resolved the earlier open question — real-time data lives on this same OpenAPI platform, not the older `tokenId`-based `dataAccess/realtimeInfo` endpoint the project brief originally assumed.
- **History endpoint does exist** (`GET /openapi/v2/device/history_data`, ≤1 year range, ≤12h query span, 5/10/15/30/60 min intervals) — another original assumption ("no historical query endpoint") was wrong. We still poll-and-store ourselves rather than rely on it (see Architecture above).
- **`deviceType` (Appendix 3, all confirmed)**: `1` Inverter, `2` Battery, `3` Meter, `4` EV Charger, `100` EMS.
- **`deviceStatus` (Appendix 6, confirmed for Inverter/Battery/EV Charger)**: Inverter fault states are `103` (recoverable) and `104` (permanent) — everything else in the (large) enum is a normal operating/mode state, not a fault, so `AlertFunction` only checks for those two. Residential batteries only ever report `0` (Idle) / `1` (Work) — no fault states exist there.
- Rate limit context: a 5-minute polling schedule is 288 calls/day, plus an occasional battery-discovery call — comfortably inside whatever quota applies to this endpoint family.
- Real credentials for the OAuth flow are in `solax-application-creds.txt` at the repo root (gitignored) — never commit it. Runtime credential storage is SSM Parameter Store (`SecureString`), not Secrets Manager — see above.
- `docs/solax-apis.md` is the working reference — it's now complete (all appendices included), so any field/endpoint not in it genuinely isn't part of this API rather than just undocumented.
