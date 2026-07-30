# PowerPlant

AWS CDK app that polls the SolaX Cloud API for a home solar + battery system, stores the full usage history, and recommends optimised battery configuration options via a nightly assessment report — replacing the manual report exports currently used. See [PowerPlant_Project_Brief.md](PowerPlant_Project_Brief.md) for full background, site details, and the phased build plan.

`PollerFunction` calls the real SolaX Cloud API (auth + device realtime data) and writes to DynamoDB; `DashboardApiFunction`, `AlertFunction`, and `ReportFunction` are still `TODO` stubs. See [solax-apis.md](solax-apis.md) for the full API reference (auth, monitoring, and control endpoints) this was built against — note it's truncated mid-document and never includes the portal's Appendices 1-8 (device type/model/status codes), so some fields (e.g. the Battery device's `deviceType`, `deviceStatus` fault-code meanings) are still unconfirmed.

## Structure

```
PowerPlant/
├── bin/
│   └── powerplant.js              # App entry — creates 2 stacks in order, seeds SolaX creds
├── lib/
│   ├── infrastructure-stack.js    # DynamoDB, S3, SNS, SSM + factory functions
│   └── lambda-functions-stack.js  # Lambda functions, EventBridge, API Gateway, alarms
├── lambda/
│   ├── Utilities/                 # Shared logger + SolaX API client (powerplant-shared)
│   ├── PollerFunction/            # EventBridge (5 min) → SolaX Cloud → DynamoDB
│   ├── DashboardApiFunction/      # API Gateway → DynamoDB rollups
│   ├── AlertFunction/             # DynamoDB Stream → fault/anomaly checks → SNS
│   └── ReportFunction/            # EventBridge (nightly) → usage assessment → SNS report
├── config/
│   ├── dev-powerplant.json        # Public template — placeholder values only
│   └── dev-powerplant.local.json  # Your real values (gitignored, not tracked)
├── test/
│   ├── infrastructure-stack.test.js
│   ├── lambda-functions-stack.test.js
│   └── solax-client.test.js
├── test-events/                   # Lambda test payloads
├── docs/
├── scripts/
│   └── deploy.sh
├── solax-apis.md                  # SolaX Cloud OpenAPI reference (source for solax-client.js)
├── cdk.json
└── package.json
```

## Stack architecture

```
InfrastructureStack        →  LambdaFunctionsStack
  DynamoDB (readings)          PollerFunction       (EventBridge, rate(5 minutes))
  S3 (dashboard assets)        DashboardApiFunction  (API Gateway, GET /readings)
  SNS (alerts topic)           AlertFunction         (DynamoDB Stream on INSERT)
  SNS (reports topic)          ReportFunction        (EventBridge, nightly cron)
  SSM (SolaX Client ID/Secret)
```

`LambdaFunctionsStack` depends on `InfrastructureStack` and receives the DynamoDB table and SNS topics as cross-stack references. `PollerFunction`'s IAM role is granted read access to the SSM parameters directly by ARN (built from the config parameter names), independent of whether `InfrastructureStack` created them on this particular deploy — see below.

## Prerequisites

- Node.js and npm
- AWS CLI configured with credentials for your target account/region
- AWS CDK CLI (`npm install -g aws-cdk`, or use the local `npx cdk`)

## Install

```bash
npm install
npm run install-all   # installs each lambda/*/'s own dependencies
```

## Configure

[config/dev-powerplant.json](config/dev-powerplant.json) is the tracked template — it holds only placeholder values (`TODO_AWS_ACCOUNT_ID`, `TODO_OWNER`, `TODO_INVERTER_SN`, a zero-account-ID bucket name) and is safe to keep public. For your own deploy:

```bash
cp config/dev-powerplant.json config/dev-powerplant.local.json   # gitignored (config/*.local.json)
# edit dev-powerplant.local.json: env.account, tags.Owner, s3.website.bucketName, solax.inverterSn
export CDK_CONFIG=dev-powerplant.local.json                      # picked up by bin/powerplant.js
```

Everything below assumes `CDK_CONFIG` is set this way when you're deploying against real infrastructure.

### SolaX credentials (SSM Parameter Store)

CloudFormation can't create `SecureString` SSM parameters natively, so `InfrastructureStack` provisions them via a custom resource (`newSecureStringParameterFunction`) instead. On `cdk deploy`/`synth`, [bin/powerplant.js](bin/powerplant.js) looks for `solax-application-creds.txt` at the repo root (gitignored) and, if present, parses the `Client ID:` / `Client secret:` lines and seeds `/powerplant/solax/client-id` and `/powerplant/solax/client-secret` as `SecureString` parameters. Those parameters are `RemovalPolicy.RETAIN`, so once you've deployed and confirmed the parameters exist (`aws ssm get-parameter --name /powerplant/solax/client-id --with-decryption`), delete `solax-application-creds.txt` — later deploys simply skip re-seeding and leave the existing values untouched. Never commit this file; it's gitignored by exact filename.

### SolaX device/API settings

The `solax` block holds the non-secret identifiers `PollerFunction` needs: `baseUrl` (`https://openapi-eu.solaxcloud.com`), `businessType` (`1` = Residential), `deviceType` (`1` = Inverter), and `inverterSn` (your inverter's serial — fill this in on your local config copy). The energy readings table's partition key is `DeviceSn` — the identifier the confirmed OpenAPI platform actually uses, not the `wifiSn`/`registerNo` from the older `dataAccess/realtimeInfo` endpoint the project brief originally assumed.

## Test

```bash
npm test
```

## Deploy

```bash
# First time only, per account/region
npx cdk bootstrap aws://<your-account-id>/<your-region>

npm run deploy:dev
# or individually:
npx cdk diff
npx cdk deploy --all
```

## Next steps

`PollerFunction` only fetches the Inverter device — the Battery device's `deviceType` code isn't in `solax-apis.md` (missing appendices), so SOC/charge-discharge fields aren't captured yet. Confirming that (e.g. via `getDeviceInfo` with a `deviceType` sweep, or the missing Appendix 3) and adding a second `getDeviceRealtimeData` call is the next concrete step. After that, per the project brief's build phases: implement `DashboardApiFunction` (dashboard), then cost tracking (needs the peak/shoulder import rate and feed-in tariff, not yet known), then flesh out `AlertFunction`'s fault/anomaly rules (blocked on the same missing `deviceStatus` appendix), then `ReportFunction`'s usage assessment and battery-configuration recommendation logic. The S3 + CloudFront web dashboard distribution itself hasn't been scaffolded yet — add it as its own stack once the dashboard API is working.
