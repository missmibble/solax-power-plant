# PowerPlant

AWS CDK app that polls the SolaX Cloud API for a home solar + battery system, stores the full usage history, and recommends optimised battery configuration options via a nightly assessment report and a dashboard — replacing the manual report exports currently used. See [docs/PowerPlant_Project_Brief.md](docs/PowerPlant_Project_Brief.md) for full background, site details, and the phased build plan.

All five Lambdas are implemented and deployed: `PollerFunction` calls the real SolaX Cloud API (Inverter + auto-discovered Battery device) and writes to DynamoDB; `DashboardApiFunction` serves cost-aware daily/weekly rollups including battery charge/discharge/SOC, plus the latest nightly recommendation/AI narrative and the latest weather/charge decision, fronting a static dashboard (S3 + CloudFront) behind a Cognito login; `AlertFunction` watches for import anomalies and real inverter fault codes; `ReportFunction` publishes a nightly usage + battery-configuration-recommendation report, SOC-aware when battery data is available, optionally enriched with a Bedrock-generated narrative and pattern-based anomaly flags, and stores the same for the dashboard; `BatteryControlFunction` checks tomorrow's weather forecast nightly and adjusts the inverter's grid-charge target accordingly — **dry-run by default, see [docs/battery-charge-logic.md](docs/battery-charge-logic.md) before ever enabling it live** — and stores its decision for the dashboard too. See [docs/solax-apis.md](docs/solax-apis.md) for the full API reference this was built against, including Appendices 1-8 (device type/model/status codes) which resolved the two gaps that used to limit this: the Battery device's `deviceType` (`2`) and the Inverter's fault `deviceStatus` codes (`103` recoverable, `104` permanent) are now both known and used.

Both SNS topics (`powerplant-alerts`, `powerplant-reports`) have a confirmed email subscription.

## Overview

Two things about your own site need to be known before configuring this for a new install:

**Solar + battery sizing.** The inverter's serial number (`config.solax.inverterSn`) comes from the SolaX portal; the battery's is optional — `PollerFunction` auto-discovers it if left as the placeholder. There's no config field for the inverter's rated power (read live from the SolaX API), but `config.batteryControl`'s charge-target percentages should be sized against your actual battery, not copied from another site.

**Electricity plan.** `config.tariff` needs your plan's complete time-of-use structure — every import rate window (start/end time + $/kWh) and the feed-in rate. Pull this straight from your retailer's plan summary or a recent bill — not every plan has a discounted overnight window, and whether `BatteryControlFunction`'s overnight charging is worth running at all depends entirely on what your specific plan actually offers. [docs/electricity-plan-comparison.md](docs/electricity-plan-comparison.md) works through a real example — comparing the deployed plan against 46 alternatives available to this site, and why the household's specific usage pattern (not the plan's headline numbers) is what actually decides the winner.

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
│   ├── electricity-plan-comparison.md    # Retail plan comparison vs. the deployed tariff — sanitized, no exact site location
│   ├── electricity-plan-comparison.json  # Same data, structured — sanitized companion to the .md above
│   └── README.md
├── scripts/
│   └── deploy.sh
├── cdk.json
└── package.json
```

## Stack architecture

```
InfrastructureStack   →   LambdaFunctionsStack           →   DashboardStack
  DynamoDB (readings)       PollerFunction                       S3 (dashboard bucket)
  SNS (alerts topic)        DashboardApiFunction                  CloudFront distribution
  SNS (reports topic)       AlertFunction                           default behavior → S3 (dashboard assets)
  SSM (SolaX creds)         ReportFunction                          readings/insights/battery-status → API Gateway
                            BatteryControlFunction                   (API key + Cognito token both required)
  Cognito User Pool         Cognito UserPoolClient + Authorizer     config.json (User Pool Client ID + region)
                            API Gateway (readings/insights/battery-status)
```

`LambdaFunctionsStack` depends on `InfrastructureStack` and receives the DynamoDB table, SNS topics, and Cognito User Pool as cross-stack references. `DashboardStack` depends only on `LambdaFunctionsStack` (for the RestApi and the User Pool Client) and owns its own S3 bucket — it can't share `InfrastructureStack`'s, since a CloudFront/S3 Origin Access Control bucket policy and the distribution's API origin would otherwise reference each other across a stack pair in both directions, which CDK rejects as a dependency cycle (see CLAUDE.md for the full explanation). `DashboardStack` is skipped when `config.api.apiKeyValue` is still the public template's placeholder. `PollerFunction`'s IAM role is granted read access to the SSM parameters directly by ARN (built from the config parameter names), independent of whether `InfrastructureStack` created them on this particular deploy — see below.

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

`config.api.apiKeyValue` (a literal string, not CDK-generated) doubles as the API Gateway key *and* the value CloudFront injects as a static origin header — this is what lets the static dashboard call `GET /readings`/`/insights`/`/battery-status` without ever holding the key client-side. `DashboardStack` is skipped entirely while that value is still the `TODO_` placeholder, so the public template config only ever synthesizes the first two stacks. After a successful deploy against your local config, the dashboard's URL is in that stack's `DashboardUrl` output (`aws cloudformation describe-stacks --stack-name PowerPlantDashboardStack --query "Stacks[0].Outputs"`).

### Dashboard login (Cognito)

The API key alone only proves a request came through CloudFront — it doesn't identify *you*. A Cognito User Pool (`InfrastructureStack`) plus a `CognitoUserPoolsAuthorizer` on the API methods (`LambdaFunctionsStack`) adds that second layer: every route (`/readings`, `/insights` GET+POST, `/battery-status`, `/battery-settings` GET+PUT) requires a valid Cognito ID token (`Authorization` header) in addition to the API key. There's no self-service sign-up — create your one account after deploying:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId from InfrastructureStack outputs> \
  --username <your-username> \
  --message-action SUPPRESS \
  --temporary-password '<a-temporary-password>'

aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username <your-username> \
  --password '<your-real-password>' \
  --permanent
```

The `--permanent` flag on the second command matters — the dashboard's login form doesn't implement Cognito's "new password required" challenge, so a temporary password alone would leave you unable to sign in. The dashboard's login is a plain `fetch` against Cognito's public API (no SDK); tokens live in `sessionStorage` (cleared on tab close) and last 1 hour with no refresh — once expired, it just drops you back to the login form. Note this protects the *data* (API responses), not the static page itself — the dashboard's empty HTML/JS shell is still fetchable by URL, just inert without a valid token. Fully hiding the shell too would need Lambda@Edge/CloudFront Functions doing JWT validation at the edge — a meaningfully bigger addition, judged not worth it for a single-user app; ask if you want that hardened further.

### AI insights (Bedrock)

Optional — set `config.bedrock.modelId` to enable; leave it as the `TODO_BEDROCK_MODEL_ID` placeholder to skip it (the nightly report just omits the section, same as when battery data isn't available). Enable model access for whatever model you pick in the [Bedrock console](https://console.aws.amazon.com/bedrock/) first — Bedrock requires opt-in per model per account/region, and some models (particularly outside `us-*` regions) require a cross-region inference profile ID rather than a base model ID. `config.bedrock.historyLookbackDays` (default 14) controls how many days of daily summaries get sent as context. The local config uses a Haiku-tier model deliberately — it's cheaper per call, which matters now that this can run several times a day (see below) rather than just once a night.

The assessment isn't only once/night: `config.lambda.reportFunction.refreshSchedule` (optional — omit to disable) adds a second cron that refreshes the dashboard's `/insights` data without sending another email each time (`{ sendEmail: false }`), and the dashboard itself has a **"Run assessment now"** button (`POST /insights`) for an on-demand refresh — same underlying `ReportFunction` code path either way, just without the email.

### Battery charge control (weather-driven, dry-run by default)

**Read [docs/battery-charge-logic.md](docs/battery-charge-logic.md) before touching `dryRun`.** `BatteryControlFunction` checks tomorrow's [Open-Meteo](https://open-meteo.com) forecast nightly and decides the inverter's `chargeUpperSoc` (40% on a sunny forecast, 100% on an overcast/rainy one, defaulting to 100% whenever the signal is ambiguous). Unlike the SolaX credentials, this needs no API key or SSM setup at all — Open-Meteo's forecast API is free and keyless — so the only thing to configure is location.

`config.location.lat`/`lon` need your site's real coordinates (public template defaults to `0`/`0` — obviously a placeholder, off the coast of West Africa) — this is the same `location` block that supplies `timezone` for the tariff windows above, since both describe the one physical site being monitored. `config.batteryControl` needs the household's *actual current* self-use-mode settings from the SolaX app (`minSoc`, `chargeFromGridEnable`, the charge/discharge time windows, `enableTimePeriod2`) — there's no API to read these back, so this app treats the config as the source of truth and resends it in full every time it runs, varying only `chargeUpperSoc`. Getting this baseline wrong risks overwriting your actual schedule, not just the charge target — see the doc for why.

`config.batteryControl.dryRun` defaults `true` in both configs: it logs and emails what it *would* do (to the reports topic) without ever calling the SolaX control endpoint. Leave it there and compare a couple of weeks of dry-run emails against actual weather before ever setting it to `false`.

The sunny/overcast **percentages, and a nightly on/off switch, are editable from the dashboard's "Battery Control Settings" panel** — no redeploy needed; it overrides `config.batteryControl`'s `chargeUpperSocSunny`/`chargeUpperSocOvercast` values, falling back to them until you've saved something. The on/off toggle is a real kill switch (skips the run outright), independent of `dryRun` — worth remembering it exists, since there's no reminder if you leave it off. `minSoc`/time windows/`chargeFromGridEnable` stay config-only, not dashboard-editable. There's also a "Last night's accuracy" widget — once `config.bedrock.modelId` is set, each run judges the *previous* decision against what actually happened that day (see docs/battery-charge-logic.md's "Previous-decision accuracy assessment").

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
- Cognito login has no refresh-token flow — sessions just expire after 1 hour and drop back to the login form. Also, only the dashboard's *data* is behind login; the static HTML/JS shell is still fetchable by URL (fully hiding it needs Lambda@Edge/CloudFront Functions — see Dashboard login above).
- The battery-control on/off toggle (dashboard) has no expiry or reminder — if you turn it off (travelling, debugging something else) it stays off indefinitely until someone turns it back on.
- `assessPreviousDecision`'s usage-vs-weather judgement is surfaced on the dashboard for you to read, not fed back automatically into `classifyForecast` — it's a hindsight signal, not a self-tuning loop.
