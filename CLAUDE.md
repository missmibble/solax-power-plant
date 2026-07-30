# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

A skeleton AWS CDK app exists (JavaScript CDK v2): two stacks, resources and event wiring are defined. `PollerFunction` is a real implementation (calls the SolaX Cloud API via `powerplant-shared`'s `solax-client.js`, writes to DynamoDB); `DashboardApiFunction`, `AlertFunction`, and `ReportFunction` are still `TODO` stubs. See [README.md](README.md) for the file layout and commands.

## What this project is

An app that monitors a home solar + battery system by polling the SolaX Cloud API directly, storing the full usage history, and recommending optimised battery configuration options via a nightly assessment report — replacing the manual report exports currently used. Full context, including known site details, learnings from manual reports, and open questions, is in [PowerPlant_Project_Brief.md](PowerPlant_Project_Brief.md) — read it before starting implementation work.

## Commands

```bash
npm install && npm run install-all   # root deps + each lambda/*/'s own deps
npm test                              # jest — all specs in test/
npx jest test/solax-client.test.js    # single test file
npx cdk diff                          # preview changes against deployed stacks
npx cdk synth                         # synthesize CloudFormation templates (both stacks)
npm run deploy:dev                    # install + test + synth + deploy (scripts/deploy.sh)
```

CDK config (account, region, resource names, tags, SolaX device settings) lives in [config/dev-powerplant.json](config/dev-powerplant.json), loaded by [bin/powerplant.js](bin/powerplant.js) — override with `CDK_CONFIG=<file>.json`.

## Architecture

Two stacks, defined in [bin/powerplant.js](bin/powerplant.js):

1. **`PowerPlantInfrastructureStack`** ([lib/infrastructure-stack.js](lib/infrastructure-stack.js)) — stateful resources: a DynamoDB time-series table (`DeviceSn` partition key, `Timestamp` sort key, streams enabled), an S3 bucket for future dashboard static assets, an SNS alerts topic, an SNS reports topic, and the SolaX OAuth credentials as SSM `SecureString` parameters. Uses factory methods (`newDynamoDBTableFunction`, `newS3BucketFunction`, `newSNSTopicFunction`, `newSecureStringParameterFunction`) driven entirely by the config JSON — add a resource by adding a config block and a factory call, not by hand-writing CDK constructs inline.
2. **`PowerPlantLambdaFunctionsStack`** ([lib/lambda-functions-stack.js](lib/lambda-functions-stack.js)) — depends on stack 1, takes the table and topics as cross-stack references. Defines four Lambdas via the same `newLambdaFunction` factory pattern (versioned + aliased):
   - `PollerFunction` — EventBridge `rate(5 minutes)` → calls SolaX Cloud → writes to DynamoDB. Its role is granted `ssm:GetParameter`/`kms:Decrypt` on the SolaX SSM parameters via `grantSsmParameterRead` (by known ARN, not a live cross-stack reference — see below).
   - `DashboardApiFunction` — fronted by an API-key-protected API Gateway (`GET /readings`) → will read/aggregate from DynamoDB.
   - `AlertFunction` — DynamoDB Stream event source (`INSERT` only) → will evaluate fault/anomaly rules → publishes to the alerts SNS topic.
   - `ReportFunction` — EventBridge nightly cron → will assess the full stored history and recommend battery configuration optimizations → publishes to the reports SNS topic.

Our own polling+storage is deliberate even though SolaX does expose a history endpoint (see below) — it gives an always-available time series with no retention/query-span limits, which both the dashboard and `ReportFunction`'s nightly recommendations depend on.

### SolaX API client (`lambda/Utilities/solax-client.js`)

Shared by all Lambdas via the `powerplant-shared` local package (`lambda/Utilities`, `main: index.js` re-exports both `logger.js` and `solax-client.js`). Built from [solax-apis.md](solax-apis.md), the full portal API reference — **but that doc is truncated mid-§11 and never includes Appendices 1-8** (numeric codes for `deviceType` beyond Inverter=1/EMS=100, `deviceStatus`, `deviceModel`, alarm/flag codes). Concretely this means:
- `PollerFunction` only fetches the **Inverter** device (`DEVICE_TYPE.INVERTER`) — the Battery device's `deviceType` code is unconfirmed, so SOC/charge-discharge fields aren't captured yet. Getting that (and the battery's `deviceSn`) is the next real step toward the app's actual goal (battery configuration recommendations).
- `AlertFunction`'s fault-detection logic can't yet be written correctly — `deviceStatus`'s fault-code meanings (Appendix 6) are unknown. `getAlarmInfo` (structured, `alarmState`/`alarmLevel`/`errorCode`) is the better long-term fit once a `plantId` is on hand, but needs its own poll (it's not part of the DynamoDB Stream payload `AlertFunction` currently reacts to).

`solax-client.js` deliberately implements only the **read/monitoring** endpoints (`solax-apis.md` §1 Auth, §2 Information Management, §4 Monitoring Management) — it does not implement any of the control/write endpoints (§3, §6-11: EMS work modes, inverter work mode control, VPP remote control, export/import limits, EV charger control, battery heating, A1-Hybrid-G2 modes). Those exist in the doc and could be wired in later if the app should apply its own recommendations automatically, rather than just report them.

`getAccessToken` caches the Bearer token at module scope (reused across warm Lambda invocations); `PollerFunction` separately caches the Client ID/Secret it reads from SSM the same way.

### SolaX credentials via SSM (not Secrets Manager)

CloudFormation can't create `SecureString` SSM parameters natively, so `InfrastructureStack.newSecureStringParameterFunction` provisions them through an `AwsCustomResource` (`aws-cdk-lib/custom-resources`) calling `SSM PutParameter` directly. [bin/powerplant.js](bin/powerplant.js)'s `loadSolaxCredentials()` parses `solax-application-creds.txt` (gitignored, repo root) at synth time and passes the values in; if that file is absent (e.g. deleted after a successful seed), `InfrastructureStack` simply skips creating those two resources. The custom resources are `RemovalPolicy.RETAIN`, so removing them from a later synth (because the file's gone) does not delete the already-seeded parameter values — this is intentional, not a bug. `LambdaFunctionsStack` grants `PollerFunction` read access by reconstructing the parameter ARN from the config's `parameterName`, independent of whether `InfrastructureStack` actually (re-)created the resource this deploy.

Build phases per the project brief: (1) ingest — `PollerFunction` implemented for the Inverter device, Battery device still open, (2) dashboard — implement `DashboardApiFunction` + add an S3+CloudFront stack (not yet scaffolded), (3) cost tracking (needs peak/shoulder import rate and feed-in tariff rate, not yet known), (4) alerts — implement `AlertFunction`'s rules (blocked on the missing `deviceStatus` appendix), (5) nightly assessment & recommendations — implement `ReportFunction`'s usage-analysis and battery-configuration logic.

## SolaX Cloud API integration notes

- **Base URL**: `https://openapi-eu.solaxcloud.com` (this account's region). **Auth**: `POST /openapi/auth/oauth/token`, Client ID/Secret → Bearer `access_token`, ~30 day expiry, doesn't extend on use (re-call to refresh).
- **Real-time telemetry**: `GET /openapi/v2/device/realtime_data`, `snList` (device serials) + `deviceType` (`1` = Inverter, confirmed) + `businessType` (`1` = Residential). This resolved the earlier open question — real-time data lives on this same OpenAPI platform, not the older `tokenId`-based `dataAccess/realtimeInfo` endpoint the project brief originally assumed.
- **History endpoint does exist** (`GET /openapi/v2/device/history_data`, ≤1 year range, ≤12h query span, 5/10/15/30/60 min intervals) — another original assumption ("no historical query endpoint") was wrong. We still poll-and-store ourselves rather than rely on it (see Architecture above).
- Rate limit context: a 5-minute polling schedule is 288 calls/day — comfortably inside whatever quota applies to this endpoint family.
- Real credentials for the OAuth flow are in `solax-application-creds.txt` at the repo root (gitignored) — never commit it. Runtime credential storage is SSM Parameter Store (`SecureString`), not Secrets Manager — see above.
- `solax-apis.md` is the working reference; treat any field/endpoint not in it (or in the appendices it's missing) as unconfirmed rather than guessing a numeric code.
