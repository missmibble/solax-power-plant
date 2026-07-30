# PowerPlant

AWS CDK app that polls the SolaX Cloud API for a home solar + battery system, stores the full usage history, and recommends optimised battery configuration options via a nightly assessment report and a dashboard — replacing the manual report exports currently used. See [docs/PowerPlant_Project_Brief.md](docs/PowerPlant_Project_Brief.md) for full background, site details, and the phased build plan.

All five Lambdas are implemented and deployed: `PollerFunction` calls the real SolaX Cloud API (Inverter + auto-discovered Battery device) and writes to DynamoDB; `DashboardApiFunction` serves cost-aware daily/weekly rollups including battery charge/discharge/SOC, fronting a static dashboard (S3 + CloudFront); `AlertFunction` watches for import anomalies and real inverter fault codes; `ReportFunction` publishes a nightly usage + battery-configuration-recommendation report, SOC-aware when battery data is available, optionally enriched with a Bedrock-generated narrative and pattern-based anomaly flags; `BatteryControlFunction` checks tomorrow's weather forecast nightly and adjusts the inverter's grid-charge target accordingly — **dry-run by default, see [docs/battery-charge-logic.md](docs/battery-charge-logic.md) before ever enabling it live.** See [docs/solax-apis.md](docs/solax-apis.md) for the full API reference this was built against, including Appendices 1-8 (device type/model/status codes) which resolved the two gaps that used to limit this: the Battery device's `deviceType` (`2`) and the Inverter's fault `deviceStatus` codes (`103` recoverable, `104` permanent) are now both known and used.

Both SNS topics (`powerplant-alerts`, `powerplant-reports`) have a confirmed email subscription.

## Structure

```
PowerPlant/
├── bin/
│   └── powerplant.js              # App entry — creates 3 stacks in order, seeds SolaX creds
├── lib/
│   ├── infrastructure-stack.js    # DynamoDB, SNS, SSM + factory functions
│   ├── lambda-functions-stack.js  # Lambda functions, EventBridge, API Gateway, alarms
│   └── dashboard-stack.js         # S3 (dashboard bucket) + CloudFront
├── lambda/
│   ├── Utilities/                 # Shared logger + SolaX API client + tariff (powerplant-shared)
│   ├── PollerFunction/            # EventBridge (5 min) → SolaX Cloud → DynamoDB
│   ├── DashboardApiFunction/      # API Gateway → DynamoDB rollups
│   ├── AlertFunction/             # DynamoDB Stream → fault/anomaly checks → SNS
│   ├── ReportFunction/            # EventBridge (nightly) → usage assessment (+ Bedrock insights) → SNS report
│   └── BatteryControlFunction/    # EventBridge (nightly) → weather forecast → inverter chargeUpperSoc (dry-run by default)
├── dashboard/                     # Static SPA served by DashboardStack (index.html/app.js/styles.css)
├── config/
│   ├── dev-powerplant.json        # Public template — placeholder values only
│   └── dev-powerplant.local.json  # Your real values (gitignored, not tracked)
├── test/
│   ├── infrastructure-stack.test.js
│   ├── lambda-functions-stack.test.js
│   ├── dashboard-stack.test.js
│   ├── solax-client.test.js
│   ├── tariff.test.js
│   ├── dashboard-api-function.test.js
│   ├── alert-function.test.js
│   ├── poller-function.test.js
│   ├── report-function.test.js
│   └── battery-control-function.test.js
├── test-events/                   # Lambda test payloads
├── docs/
│   ├── PowerPlant_Project_Brief.md
│   ├── solax-apis.md              # SolaX Cloud OpenAPI reference (source for solax-client.js)
│   ├── battery-charge-logic.md    # Weather-driven charge control logic + worked examples — read before enabling live
│   └── README.md
├── scripts/
│   └── deploy.sh
├── cdk.json
└── package.json
```

## Stack architecture

```
InfrastructureStack   →   LambdaFunctionsStack       →   DashboardStack
  DynamoDB (readings)       PollerFunction                  S3 (dashboard bucket)
  SNS (alerts topic)        DashboardApiFunction             CloudFront distribution
  SNS (reports topic)       AlertFunction                      default behavior → S3 (dashboard assets)
  SSM (SolaX creds)         ReportFunction                     "readings" behavior → API Gateway (API key injected)
  SSM (weather API key)     BatteryControlFunction
                            API Gateway (readings)
```

`LambdaFunctionsStack` depends on `InfrastructureStack` and receives the DynamoDB table and SNS topics as cross-stack references. `DashboardStack` depends only on `LambdaFunctionsStack` (for the RestApi) and owns its own S3 bucket — it can't share `InfrastructureStack`'s, since a CloudFront/S3 Origin Access Control bucket policy and the distribution's API origin would otherwise reference each other across a stack pair in both directions, which CDK rejects as a dependency cycle (see CLAUDE.md for the full explanation). `DashboardStack` is skipped when `config.api.apiKeyValue` is still the public template's placeholder. `PollerFunction`'s IAM role is granted read access to the SSM parameters directly by ARN (built from the config parameter names), independent of whether `InfrastructureStack` created them on this particular deploy — see below.

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
# edit dev-powerplant.local.json: env.account, tags.Owner, s3.website.bucketName, solax.inverterSn,
# api.apiKeyValue (20-128 chars, e.g. `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`),
# bedrock.modelId (optional — leave as the TODO_ placeholder to skip AI insights entirely),
# location.lat/lon/timezone (your site's coordinates and IANA timezone), batteryControl.* (your inverter's current self-use-mode settings)
```

Deploy against it with `scripts/deploy.sh`'s `--config`/`-c` flag (see Deploy below) — no env var to remember, and nothing to add to `package.json` per config file. `bin/powerplant.js` itself still honors `CDK_CONFIG` directly too, for `cdk diff`/`synth` run outside the deploy script.

### SolaX credentials (SSM Parameter Store)

CloudFormation can't create `SecureString` SSM parameters natively, so `InfrastructureStack` provisions them via a custom resource (`newSecureStringParameterFunction`) instead. On `cdk deploy`/`synth`, [bin/powerplant.js](bin/powerplant.js) looks for `solax-application-creds.txt` at the repo root (gitignored) and, if present, parses the `Client ID:` / `Client secret:` lines and seeds `/powerplant/solax/client-id` and `/powerplant/solax/client-secret` as `SecureString` parameters. Those parameters are `RemovalPolicy.RETAIN`, so once you've deployed and confirmed the parameters exist (`aws ssm get-parameter --name /powerplant/solax/client-id --with-decryption`), delete `solax-application-creds.txt` — later deploys simply skip re-seeding and leave the existing values untouched. Never commit this file; it's gitignored by exact filename.

### SolaX device/API settings

The `solax` block holds the non-secret identifiers `PollerFunction` needs: `baseUrl` (`https://openapi-eu.solaxcloud.com`), `businessType` (`1` = Residential), `deviceType` (`1` = Inverter), `inverterSn` (your inverter's serial — fill this in on your local config copy), and `batterySn` (optional — leave as the `TODO_BATTERY_SN` placeholder and `PollerFunction` will auto-discover the battery device via `getDeviceInfo`; set it explicitly only if you want to pin a specific device or skip that extra API call). The energy readings table's partition key is `DeviceSn` — the identifier the confirmed OpenAPI platform actually uses, not the `wifiSn`/`registerNo` from the older `dataAccess/realtimeInfo` endpoint the project brief originally assumed.

### Dashboard (S3 + CloudFront)

`config.api.apiKeyValue` (a literal string, not CDK-generated) doubles as the API Gateway key *and* the value CloudFront injects as a static origin header — this is what lets the static dashboard call `GET /readings` without ever holding the key client-side. `DashboardStack` is skipped entirely while that value is still the `TODO_` placeholder, so the public template config only ever synthesizes the first two stacks. After a successful deploy against your local config, the dashboard's URL is in that stack's `DashboardUrl` output (`aws cloudformation describe-stacks --stack-name PowerPlantDashboardStack --query "Stacks[0].Outputs"`).

### AI insights (Bedrock)

Optional — set `config.bedrock.modelId` to enable; leave it as the `TODO_BEDROCK_MODEL_ID` placeholder to skip it (the nightly report just omits the section, same as when battery data isn't available). Enable model access for whatever model you pick in the [Bedrock console](https://console.aws.amazon.com/bedrock/) first — Bedrock requires opt-in per model per account/region, and some models (particularly outside `us-*` regions) require a cross-region inference profile ID rather than a base model ID. `config.bedrock.historyLookbackDays` (default 14) controls how many days of daily summaries get sent as context.

### Battery charge control (weather-driven, dry-run by default)

**Read [docs/battery-charge-logic.md](docs/battery-charge-logic.md) before touching `dryRun`.** `BatteryControlFunction` checks tomorrow's OpenWeatherMap forecast nightly and decides the inverter's `chargeUpperSoc` (40% on a sunny forecast, 100% on an overcast/rainy one, defaulting to 100% whenever the signal is ambiguous). It works like the SolaX credentials: sign up for a free [OpenWeatherMap](https://openweathermap.org/api) account, then create `weather-api-key.txt` at the repo root (gitignored) with one line:

```
API Key: <your key>
```

`config.location.lat`/`lon` need your site's real coordinates (public template defaults to `0`/`0` — obviously a placeholder, off the coast of West Africa) — this is the same `location` block that supplies `timezone` for the tariff windows above, since both describe the one physical site being monitored. `config.batteryControl` needs the household's *actual current* self-use-mode settings from the SolaX app (`minSoc`, `chargeFromGridEnable`, the charge/discharge time windows, `enableTimePeriod2`) — there's no API to read these back, so this app treats the config as the source of truth and resends it in full every time it runs, varying only `chargeUpperSoc`. Getting this baseline wrong risks overwriting your actual schedule, not just the charge target — see the doc for why.

`config.batteryControl.dryRun` defaults `true` in both configs: it logs and emails what it *would* do (to the reports topic) without ever calling the SolaX control endpoint. Leave it there and compare a couple of weeks of dry-run emails against actual weather before ever setting it to `false`.

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

- **Timezone**: `config.location.timezone` (used for both tariff windows and the weather forecast's calendar-day bucketing — see below) defaults to `Australia/Sydney` in the public template, a generic assumption — if your site is in a state that doesn't observe DST (e.g. Queensland), correct this in your local config, since it changes which tariff window a reading near a DST transition falls into. The real deployment already uses `Australia/Brisbane` for exactly this reason.
- `AlertFunction` only checks the Inverter's fault codes (`103`/`104`) — residential batteries only ever report Idle(0)/Work(1) (`docs/solax-apis.md` Appendix 6), so there's no battery fault state to check.
- `BatteryControlFunction`'s forecast classification (`classifyForecast`) is a first-pass heuristic, not location-tuned — see docs/battery-charge-logic.md's worked examples for the borderline cases most worth double-checking against your own judgement before trusting it live.
- Every other control/write endpoint (EMS work modes, VPP, export/import limits, EV charger control, battery heating — `docs/solax-apis.md` §3, §6, §8-11) is still unimplemented — this app only automates the one battery-charge decision described above, everything else it just recommends.
