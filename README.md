# PowerPlant

AWS CDK app that polls the SolaX Cloud API for a home solar + battery system, stores the full usage history, and recommends optimised battery configuration options via a nightly assessment report — replacing the manual report exports currently used. See [docs/PowerPlant_Project_Brief.md](docs/PowerPlant_Project_Brief.md) for full background, site details, and the phased build plan.

All four Lambdas are implemented and deployed: `PollerFunction` calls the real SolaX Cloud API (Inverter + auto-discovered Battery device) and writes to DynamoDB; `DashboardApiFunction` serves cost-aware daily/weekly rollups including battery charge/discharge/SOC; `AlertFunction` watches for import anomalies and real inverter fault codes; `ReportFunction` publishes a nightly usage + battery-configuration-recommendation report, SOC-aware when battery data is available. See [docs/solax-apis.md](docs/solax-apis.md) for the full API reference this was built against, including Appendices 1-8 (device type/model/status codes) which resolved the two gaps that used to limit this: the Battery device's `deviceType` (`2`) and the Inverter's fault `deviceStatus` codes (`103` recoverable, `104` permanent) are now both known and used.

Both SNS topics (`powerplant-alerts`, `powerplant-reports`) have a confirmed email subscription.

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
│   ├── solax-client.test.js
│   ├── tariff.test.js
│   ├── dashboard-api-function.test.js
│   ├── alert-function.test.js
│   └── report-function.test.js
├── test-events/                   # Lambda test payloads
├── docs/
│   ├── PowerPlant_Project_Brief.md
│   ├── solax-apis.md              # SolaX Cloud OpenAPI reference (source for solax-client.js)
│   └── README.md
├── scripts/
│   └── deploy.sh
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
```

Deploy against it with `scripts/deploy.sh`'s `--config`/`-c` flag (see Deploy below) — no env var to remember, and nothing to add to `package.json` per config file. `bin/powerplant.js` itself still honors `CDK_CONFIG` directly too, for `cdk diff`/`synth` run outside the deploy script.

### SolaX credentials (SSM Parameter Store)

CloudFormation can't create `SecureString` SSM parameters natively, so `InfrastructureStack` provisions them via a custom resource (`newSecureStringParameterFunction`) instead. On `cdk deploy`/`synth`, [bin/powerplant.js](bin/powerplant.js) looks for `solax-application-creds.txt` at the repo root (gitignored) and, if present, parses the `Client ID:` / `Client secret:` lines and seeds `/powerplant/solax/client-id` and `/powerplant/solax/client-secret` as `SecureString` parameters. Those parameters are `RemovalPolicy.RETAIN`, so once you've deployed and confirmed the parameters exist (`aws ssm get-parameter --name /powerplant/solax/client-id --with-decryption`), delete `solax-application-creds.txt` — later deploys simply skip re-seeding and leave the existing values untouched. Never commit this file; it's gitignored by exact filename.

### SolaX device/API settings

The `solax` block holds the non-secret identifiers `PollerFunction` needs: `baseUrl` (`https://openapi-eu.solaxcloud.com`), `businessType` (`1` = Residential), `deviceType` (`1` = Inverter), `inverterSn` (your inverter's serial — fill this in on your local config copy), and `batterySn` (optional — leave as the `TODO_BATTERY_SN` placeholder and `PollerFunction` will auto-discover the battery device via `getDeviceInfo`; set it explicitly only if you want to pin a specific device or skip that extra API call). The energy readings table's partition key is `DeviceSn` — the identifier the confirmed OpenAPI platform actually uses, not the `wifiSn`/`registerNo` from the older `dataAccess/realtimeInfo` endpoint the project brief originally assumed.

## Test

```bash
npm test
```

## Deploy

```bash
# First time only, per account/region
npx cdk bootstrap aws://<your-account-id>/<your-region>

npm run deploy:dev                              # config/dev-powerplant.json (placeholder values)
bash scripts/deploy.sh --config dev-powerplant.local.json   # your real config, gitignored
bash scripts/deploy.sh -c dev-powerplant.local.json         # -c is the short form

# or individually, e.g. against the local config:
CDK_CONFIG=dev-powerplant.local.json npx cdk diff
CDK_CONFIG=dev-powerplant.local.json npx cdk deploy --all
```

`scripts/deploy.sh` accepts either a bare env name (`dev`, `prod` → resolves to `config/<env>-powerplant.json`) or `--config`/`-c <file>` to point at any file in `config/` directly — including a gitignored one — without adding a matching `package.json` script for every config variant.

## Next steps

- **Timezone**: `config.tariff.timezone` defaults to `Australia/Sydney` (assumed) — if the site is in a state that doesn't observe DST (e.g. Queensland), correct this in your local config, since it changes which tariff window a reading near a DST transition falls into.
- The S3 + CloudFront web dashboard distribution itself hasn't been scaffolded yet — `DashboardApiFunction`'s `GET /readings` is implemented, but there's no frontend to call it from.
- `AlertFunction` only checks the Inverter's fault codes (`103`/`104`) — residential batteries only ever report Idle(0)/Work(1) (`docs/solax-apis.md` Appendix 6), so there's no battery fault state to check.
- Control/write endpoints (EMS work modes, inverter work mode control, VPP, export/import limits, EV charger control, battery heating — `docs/solax-apis.md` §3, §6-11) aren't implemented — this app recommends battery configuration changes, it doesn't apply them automatically. Wire those in if that changes.
