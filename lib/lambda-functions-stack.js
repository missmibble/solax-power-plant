'use strict';

const path = require('path');
const { Stack, Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const { Alias } = require('aws-cdk-lib/aws-lambda');
const { DynamoEventSource } = require('aws-cdk-lib/aws-lambda-event-sources');
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const cloudwatch = require('aws-cdk-lib/aws-cloudwatch');
const cognito = require('aws-cdk-lib/aws-cognito');
const iam = require('aws-cdk-lib/aws-iam');

class LambdaFunctionsStack extends Stack {
    constructor(scope, id, props) {
        super(scope, id, props);

        const { config, energyReadingsTable, alertsTopic, reportsTopic, userPool } = props;
        const deploymentConfig = config.deployment;

        // The tariff's time-of-day windows are meaningless without a timezone,
        // and that timezone is a property of the site being monitored — not an
        // independent setting — so it comes from config.location (the same
        // place BatteryControlFunction's weather lookup gets its coordinates),
        // never duplicated separately in config.tariff itself.
        const tariffStructure = JSON.stringify({ ...config.tariff, timezone: config.location.timezone });

        // ─── Poller Lambda ──────────────────────────────────────────────────────
        // Polls SolaX Cloud every 5 minutes and writes a reading to DynamoDB.

        this.pollerFunctionAlias = this.newLambdaFunction(
            config.lambda.pollerFunction,
            deploymentConfig,
            {
                ENERGY_READINGS_TABLE: energyReadingsTable.tableName,
                SOLAX_CLIENT_ID_PARAM: config.ssm.solaxClientId.parameterName,
                SOLAX_CLIENT_SECRET_PARAM: config.ssm.solaxClientSecret.parameterName,
                SOLAX_BASE_URL: config.solax.baseUrl,
                SOLAX_BUSINESS_TYPE: String(config.solax.businessType),
                SOLAX_DEVICE_TYPE: String(config.solax.deviceType),
                SOLAX_INVERTER_SN: config.solax.inverterSn,
                SOLAX_BATTERY_SN: config.solax.batterySn,
                LOG_LEVEL: 'INFO'
            }
        );

        energyReadingsTable.grantWriteData(this.pollerFunctionAlias);
        this.grantSsmParameterRead(this.pollerFunctionAlias, [
            config.ssm.solaxClientId.parameterName,
            config.ssm.solaxClientSecret.parameterName
        ]);

        new events.Rule(this, 'PollerScheduleRule', {
            ruleName: 'powerplant-poller-schedule',
            schedule: events.Schedule.expression(config.lambda.pollerFunction.schedule || 'rate(5 minutes)'),
            targets: [new targets.LambdaFunction(this.pollerFunctionAlias)]
        });

        // ─── Dashboard API Lambda ───────────────────────────────────────────────
        // Aggregates DynamoDB readings into daily/weekly rollups for the dashboard.

        // Built by convention (functionName:alias), not a live construct
        // reference — ReportFunction is defined later in this same constructor,
        // same reasoning as grantSsmParameterRead's ARN-by-convention below.
        const reportFunctionArn =
            `arn:${this.partition}:lambda:${this.region}:${this.account}:function:` +
            `${config.lambda.reportFunction.functionName}:${deploymentConfig?.lambdaAlias || 'dev'}`;

        this.dashboardApiFunctionAlias = this.newLambdaFunction(
            config.lambda.dashboardApiFunction,
            deploymentConfig,
            {
                ENERGY_READINGS_TABLE: energyReadingsTable.tableName,
                SOLAX_INVERTER_SN: config.solax.inverterSn,
                TARIFF_STRUCTURE: tariffStructure,
                // Defaults shown by GET /battery-settings until a dashboard
                // save creates the first override record.
                BATTERY_CONTROL_DEFAULT_SUNNY: String(config.batteryControl?.chargeUpperSocSunny ?? ''),
                BATTERY_CONTROL_DEFAULT_OVERCAST: String(config.batteryControl?.chargeUpperSocOvercast ?? ''),
                BATTERY_CONTROL_DEFAULT_DISABLED: String(config.batteryControl?.disabledChargeUpperSoc ?? ''),
                // For the manual "run assessment now" trigger (POST /insights).
                REPORT_FUNCTION_NAME: reportFunctionArn,
                LOG_LEVEL: 'INFO',
                // Current weather for the dashboard's always-on weather widget —
                // same OpenWeatherMap credential/location BatteryControlFunction
                // uses for tomorrow's forecast, but called live on every
                // /battery-status request rather than once nightly, since "now"
                // needs to stay current through the day. Additive: omitted
                // entirely (fetchCurrentWeather then no-ops) if weather isn't
                // configured, same guard BatteryControlFunction itself uses.
                ...(config.ssm.weatherApiKey && config.location ? {
                    WEATHER_API_KEY_PARAM: config.ssm.weatherApiKey.parameterName,
                    WEATHER_LAT: String(config.location.lat),
                    WEATHER_LON: String(config.location.lon)
                } : {})
            }
        );

        // grantReadWriteData (not just Read) — POST /insights/PUT /battery-settings
        // are this app's first dashboard-initiated writes to the table (settings
        // overrides); see the API Gateway section below.
        energyReadingsTable.grantReadWriteData(this.dashboardApiFunctionAlias);

        if (config.ssm.weatherApiKey && config.location) {
            this.grantSsmParameterRead(this.dashboardApiFunctionAlias, [config.ssm.weatherApiKey.parameterName]);
        }

        // ─── Alert Lambda ───────────────────────────────────────────────────────
        // Reacts to new readings via DynamoDB Streams — inverter/battery faults,
        // unusually high daytime import — and publishes to SNS.

        this.alertFunctionAlias = this.newLambdaFunction(
            config.lambda.alertFunction,
            deploymentConfig,
            {
                ENERGY_READINGS_TABLE: energyReadingsTable.tableName,
                ALERTS_TOPIC_ARN: alertsTopic.topicArn,
                TARIFF_STRUCTURE: tariffStructure,
                LOG_LEVEL: 'INFO'
            }
        );

        // Reads the previous reading (to compute deltas) in addition to reacting
        // to the stream — stream permissions alone don't grant table Query access.
        energyReadingsTable.grantReadData(this.alertFunctionAlias);
        alertsTopic.grantPublish(this.alertFunctionAlias);

        this.alertFunctionAlias.addEventSource(
            new DynamoEventSource(energyReadingsTable, {
                startingPosition: lambda.StartingPosition.LATEST,
                batchSize: 1,
                retryAttempts: 2
            })
        );

        // ─── Report Lambda ──────────────────────────────────────────────────────
        // Nightly EventBridge schedule. Assesses stored usage data and recommends
        // battery configuration optimizations, then publishes the report to SNS.

        this.reportFunctionAlias = this.newLambdaFunction(
            config.lambda.reportFunction,
            deploymentConfig,
            {
                ENERGY_READINGS_TABLE: energyReadingsTable.tableName,
                SOLAX_INVERTER_SN: config.solax.inverterSn,
                REPORTS_TOPIC_ARN: reportsTopic.topicArn,
                TARIFF_STRUCTURE: tariffStructure,
                BEDROCK_MODEL_ID: config.bedrock?.modelId || '',
                AI_HISTORY_LOOKBACK_DAYS: String(config.bedrock?.historyLookbackDays || 14),
                LOG_LEVEL: 'INFO'
            }
        );

        energyReadingsTable.grantReadData(this.reportFunctionAlias);
        // Also writes its own record (buildReportRecord, under a sentinel
        // DeviceSn) so DashboardApiFunction's /insights route can surface the
        // latest recommendation + AI narrative on the dashboard.
        energyReadingsTable.grantWriteData(this.reportFunctionAlias);
        reportsTopic.grantPublish(this.reportFunctionAlias);
        // DashboardApiFunction's POST /insights (manual "run assessment now")
        // invokes this alias directly with { sendEmail: false } — see
        // ReportFunction.js and the API Gateway section below.
        this.reportFunctionAlias.grantInvoke(this.dashboardApiFunctionAlias);

        // AI insights are additive (see ReportFunction.getAiInsights) — grant is
        // scoped to just this one model so a config typo can't invoke anything else.
        if (config.bedrock?.modelId) {
            this.reportFunctionAlias.role.addToPrincipalPolicy(new iam.PolicyStatement({
                actions: ['bedrock:InvokeModel'],
                resources: this.bedrockInvokeResources(config.bedrock.modelId)
            }));
        }

        new events.Rule(this, 'ReportScheduleRule', {
            ruleName: 'powerplant-report-schedule',
            schedule: events.Schedule.expression(config.lambda.reportFunction.schedule),
            targets: [new targets.LambdaFunction(this.reportFunctionAlias)]
        });

        // Refreshes the dashboard's /insights data more often than the once-
        // nightly email — same Lambda, { sendEmail: false } skips the SNS
        // publish so this doesn't turn into 6 emails/day. Optional — only
        // wired up when config.lambda.reportFunction.refreshSchedule is set.
        if (config.lambda.reportFunction.refreshSchedule) {
            new events.Rule(this, 'ReportRefreshScheduleRule', {
                ruleName: 'powerplant-report-refresh-schedule',
                schedule: events.Schedule.expression(config.lambda.reportFunction.refreshSchedule),
                targets: [new targets.LambdaFunction(this.reportFunctionAlias, {
                    event: events.RuleTargetInput.fromObject({ sendEmail: false })
                })]
            });
        }

        // ─── Battery Control Lambda ─────────────────────────────────────────────
        // Nightly EventBridge schedule, timed to run before the overnight grid-
        // charge window starts. Checks tomorrow's forecast and adjusts the
        // inverter's chargeUpperSoc accordingly. dryRun defaults true — see
        // BatteryControlFunction.js. Skipped when config.ssm.weatherApiKey isn't
        // configured, since there'd be no credential for it to read.
        if (config.ssm.weatherApiKey && config.location && config.batteryControl) {
            this.batteryControlFunctionAlias = this.newLambdaFunction(
                config.lambda.batteryControlFunction,
                deploymentConfig,
                {
                    ENERGY_READINGS_TABLE: energyReadingsTable.tableName,
                    SOLAX_CLIENT_ID_PARAM: config.ssm.solaxClientId.parameterName,
                    SOLAX_CLIENT_SECRET_PARAM: config.ssm.solaxClientSecret.parameterName,
                    WEATHER_API_KEY_PARAM: config.ssm.weatherApiKey.parameterName,
                    SOLAX_BASE_URL: config.solax.baseUrl,
                    SOLAX_BUSINESS_TYPE: String(config.solax.businessType),
                    SOLAX_INVERTER_SN: config.solax.inverterSn,
                    WEATHER_LAT: String(config.location.lat),
                    WEATHER_LON: String(config.location.lon),
                    TARIFF_STRUCTURE: tariffStructure,
                    BATTERY_CONTROL_CONFIG: JSON.stringify(config.batteryControl),
                    BEDROCK_MODEL_ID: config.bedrock?.modelId || '',
                    REPORTS_TOPIC_ARN: reportsTopic.topicArn,
                    ALERTS_TOPIC_ARN: alertsTopic.topicArn,
                    LOG_LEVEL: 'INFO'
                }
            );

            this.grantSsmParameterRead(this.batteryControlFunctionAlias, [
                config.ssm.solaxClientId.parameterName,
                config.ssm.solaxClientSecret.parameterName,
                config.ssm.weatherApiKey.parameterName
            ]);
            // Reads/writes its own status record (buildBatteryStatusRecord) and
            // reads the dashboard-editable settings override (loadSettingsOverride)
            // and the previous run's record (for the accuracy assessment) — all
            // under sentinel DeviceSn prefixes in the same table.
            energyReadingsTable.grantReadWriteData(this.batteryControlFunctionAlias);
            reportsTopic.grantPublish(this.batteryControlFunctionAlias);
            alertsTopic.grantPublish(this.batteryControlFunctionAlias);

            // Previous-decision accuracy assessment is additive (see
            // BatteryControlFunction.assessPreviousDecision) — same scoped grant
            // pattern as ReportFunction's AI insights.
            if (config.bedrock?.modelId) {
                this.batteryControlFunctionAlias.role.addToPrincipalPolicy(new iam.PolicyStatement({
                    actions: ['bedrock:InvokeModel'],
                    resources: this.bedrockInvokeResources(config.bedrock.modelId)
                }));
            }

            new events.Rule(this, 'BatteryControlScheduleRule', {
                ruleName: 'powerplant-battery-control-schedule',
                schedule: events.Schedule.expression(config.lambda.batteryControlFunction.schedule),
                targets: [new targets.LambdaFunction(this.batteryControlFunctionAlias)]
            });

            new cloudwatch.Alarm(this, 'BatteryControlFunctionErrorAlarm', {
                alarmName: 'powerplant-BatteryControl-errors',
                alarmDescription: 'Lambda errors for BatteryControlFunction',
                metric: this.batteryControlFunctionAlias.metricErrors({ period: Duration.hours(24) }),
                threshold: 1,
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
            });
        }

        // ─── API Gateway ────────────────────────────────────────────────────────
        // Fronts the Dashboard API Lambda. Two independent layers: an API key
        // (CloudFront injects it as a static origin header — protects the API
        // from traffic that bypasses CloudFront entirely) and a Cognito
        // authorizer (protects the data itself — only someone who's actually
        // logged in via the dashboard's login form gets a response).

        this.api = this.newApiGatewayFunction(config.api);

        // Explicitly scoped to `this` (not userPool.addClient(), which parents
        // the construct under the User Pool's own stack regardless of which
        // stack's code calls it — the client would end up in InfrastructureStack
        // instead of here, an easy-to-miss surprise).
        this.userPoolClient = new cognito.UserPoolClient(this, 'PowerPlantDashboardClient', {
            userPool,
            authFlows: { userPassword: true },
            generateSecret: false, // public client — used directly from browser JS, can't hold a secret
            accessTokenValidity: Duration.hours(1),
            idTokenValidity: Duration.hours(1)
        });

        const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'DashboardAuthorizer', {
            cognitoUserPools: [userPool]
        });

        const protectedMethodOptions = {
            apiKeyRequired: config.api.apiKeyRequired !== false,
            authorizer,
            authorizationType: apigateway.AuthorizationType.COGNITO
        };

        const readingsResource = this.api.root.addResource('readings');
        readingsResource.addMethod(
            'GET',
            new apigateway.LambdaIntegration(this.dashboardApiFunctionAlias),
            protectedMethodOptions
        );

        // Latest nightly report (recommendation + AI narrative) — same Lambda,
        // routed internally on event.resource. See DashboardApiFunction.handleInsights.
        const insightsResource = this.api.root.addResource('insights');
        insightsResource.addMethod(
            'GET',
            new apigateway.LambdaIntegration(this.dashboardApiFunctionAlias),
            protectedMethodOptions
        );
        // Manually re-run the assessment on demand — DashboardApiFunction.handleTriggerAssessment.
        insightsResource.addMethod(
            'POST',
            new apigateway.LambdaIntegration(this.dashboardApiFunctionAlias),
            protectedMethodOptions
        );

        // Last night's weather classification + charge decision — same Lambda
        // again. See DashboardApiFunction.handleBatteryStatus.
        const batteryStatusResource = this.api.root.addResource('battery-status');
        batteryStatusResource.addMethod(
            'GET',
            new apigateway.LambdaIntegration(this.dashboardApiFunctionAlias),
            protectedMethodOptions
        );

        // Dashboard-editable charge % + on/off toggle — the app's first write
        // path from the dashboard, which is exactly what the Cognito login above
        // is for. See DashboardApiFunction.handleGetBatterySettings/handlePutBatterySettings.
        const batterySettingsResource = this.api.root.addResource('battery-settings');
        batterySettingsResource.addMethod(
            'GET',
            new apigateway.LambdaIntegration(this.dashboardApiFunctionAlias),
            protectedMethodOptions
        );
        batterySettingsResource.addMethod(
            'PUT',
            new apigateway.LambdaIntegration(this.dashboardApiFunctionAlias),
            protectedMethodOptions
        );

        if (config.api.apiKeyRequired !== false) {
            // A literal (not CDK-generated) value so the CloudFront distribution
            // below can inject it as a static origin header — see the dashboard
            // section. API Gateway requires 20-128 characters.
            const apiKey = this.api.addApiKey('PowerPlantApiKey', { value: config.api.apiKeyValue });
            const usagePlan = this.api.addUsagePlan('PowerPlantUsagePlan', {
                name: 'powerplant-usage-plan',
                throttle: { rateLimit: 10, burstLimit: 20 }
            });
            usagePlan.addApiStage({ stage: this.api.deploymentStage });
            usagePlan.addApiKey(apiKey);
        }

        // ─── CloudWatch Alarms ────────────────────────────────────────────────

        new cloudwatch.Alarm(this, 'PollerFunctionErrorAlarm', {
            alarmName: 'powerplant-Poller-errors',
            alarmDescription: 'Lambda errors for PollerFunction',
            metric: this.pollerFunctionAlias.metricErrors({ period: Duration.minutes(5) }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
        });

        new cloudwatch.Alarm(this, 'ReportFunctionErrorAlarm', {
            alarmName: 'powerplant-Report-errors',
            alarmDescription: 'Lambda errors for ReportFunction — a silent failure here means no nightly report',
            metric: this.reportFunctionAlias.metricErrors({ period: Duration.hours(24) }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
        });

        // ─── Outputs ──────────────────────────────────────────────────────────

        new CfnOutput(this, 'ApiUrl', {
            value: this.api.url,
            exportName: 'PowerPlantApiUrl'
        });
    }

    // ─── Factory: Lambda Function with Versioning + Alias ────────────────────

    newLambdaFunction(config, deploymentConfig, envVariables) {
        const { functionName, cfResource, description, assetPath, timer } = config;
        const aliasName = deploymentConfig?.lambdaAlias || 'dev';

        const fn = new lambda.Function(this, cfResource, {
            functionName,
            description,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: `${functionName}.handler`,
            code: lambda.Code.fromAsset(path.join(__dirname, '..', assetPath)),
            timeout: Duration.seconds(timer || 30),
            memorySize: 256,
            environment: envVariables || {},
            currentVersionOptions: {
                removalPolicy: RemovalPolicy.RETAIN,
                description: `Version for ${functionName}`
            }
        });

        const alias = new Alias(this, `${functionName}Alias`, {
            aliasName,
            version: fn.currentVersion,
            description: `${aliasName} alias for ${functionName}`
        });

        return alias;
    }

    // ─── Grant: read + decrypt SSM SecureString parameters ───────────────────
    // The parameters are provisioned outside this stack (InfrastructureStack's
    // custom resource), so grant by known ARN rather than a live construct reference.

    grantSsmParameterRead(alias, parameterNames) {
        const parameterArns = parameterNames.map(
            name => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`
        );

        alias.role.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: parameterArns
        }));

        // SecureString values are encrypted with the default AWS-managed SSM key.
        alias.role.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: [`arn:${this.partition}:kms:${this.region}:${this.account}:alias/aws/ssm`]
        }));
    }

    // ─── Grant: invoke a specific Bedrock model or cross-region inference profile ─
    // config.bedrock.modelId can be either a plain foundation-model ID (invoked
    // directly, same region) or a cross-region inference profile ID like
    // "au.anthropic.claude-haiku-4-5-20251001-v1:0" (the "au."/"global."/"apac."
    // prefix identifies the profile's geography). Invoking a profile requires
    // bedrock:InvokeModel on BOTH the profile ARN itself AND the underlying
    // foundation-model ARN — Bedrock ultimately routes the request to whichever
    // region within that geography serves it, which isn't necessarily this
    // stack's own region, so the foundation-model grant uses a region wildcard
    // rather than `this.region`. Granting the foundation-model ARN unconditionally
    // (whether or not modelId turns out to be a profile) is harmless: it's an
    // extra grant on a resource that either matches the real underlying model or
    // doesn't correspond to anything Bedrock resolves.
    bedrockInvokeResources(modelId) {
        const baseModelId = modelId.replace(/^[a-z]+\./, '');

        return [
            `arn:${this.partition}:bedrock:*::foundation-model/${baseModelId}`,
            `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${modelId}`
        ];
    }

    // ─── Factory: API Gateway ─────────────────────────────────────────────────

    newApiGatewayFunction(config) {
        const { restApiName, cfResource, description, stageName, corsAllowOrigins } = config;

        return new apigateway.RestApi(this, cfResource, {
            restApiName,
            description,
            endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
            deployOptions: {
                stageName: stageName || 'dev',
                throttlingRateLimit: 10,
                throttlingBurstLimit: 20,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                dataTraceEnabled: false,
                metricsEnabled: true
            },
            defaultCorsPreflightOptions: {
                allowOrigins: corsAllowOrigins || apigateway.Cors.ALL_ORIGINS,
                // GET (readings/insights/battery-status/battery-settings), POST
                // (manual assessment trigger), PUT (battery-settings save). Not
                // load-bearing for the dashboard itself — its calls are same-origin
                // through CloudFront, so no browser preflight applies — but keeps
                // this accurate for any direct API Gateway access.
                allowMethods: ['GET', 'POST', 'PUT'],
                allowHeaders: ['Content-Type', 'X-Api-Key', 'Authorization']
            }
        });
    }
}

module.exports = { LambdaFunctionsStack };
