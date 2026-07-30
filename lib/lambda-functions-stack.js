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
const iam = require('aws-cdk-lib/aws-iam');

class LambdaFunctionsStack extends Stack {
    constructor(scope, id, props) {
        super(scope, id, props);

        const { config, energyReadingsTable, alertsTopic, reportsTopic } = props;
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

        this.dashboardApiFunctionAlias = this.newLambdaFunction(
            config.lambda.dashboardApiFunction,
            deploymentConfig,
            {
                ENERGY_READINGS_TABLE: energyReadingsTable.tableName,
                SOLAX_INVERTER_SN: config.solax.inverterSn,
                TARIFF_STRUCTURE: tariffStructure,
                LOG_LEVEL: 'INFO'
            }
        );

        energyReadingsTable.grantReadData(this.dashboardApiFunctionAlias);

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
        reportsTopic.grantPublish(this.reportFunctionAlias);

        // AI insights are additive (see ReportFunction.getAiInsights) — grant is
        // scoped to just this one model so a config typo can't invoke anything else.
        if (config.bedrock?.modelId) {
            this.reportFunctionAlias.role.addToPrincipalPolicy(new iam.PolicyStatement({
                actions: ['bedrock:InvokeModel'],
                resources: [
                    `arn:${this.partition}:bedrock:${this.region}::foundation-model/${config.bedrock.modelId}`,
                    `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${config.bedrock.modelId}`
                ]
            }));
        }

        new events.Rule(this, 'ReportScheduleRule', {
            ruleName: 'powerplant-report-schedule',
            schedule: events.Schedule.expression(config.lambda.reportFunction.schedule),
            targets: [new targets.LambdaFunction(this.reportFunctionAlias)]
        });

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
            reportsTopic.grantPublish(this.batteryControlFunctionAlias);
            alertsTopic.grantPublish(this.batteryControlFunctionAlias);

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
        // Fronts the Dashboard API Lambda. API-key protected — single-user personal
        // app for now; revisit (Cognito, etc.) if this grows multi-user.

        this.api = this.newApiGatewayFunction(config.api);

        const readingsResource = this.api.root.addResource('readings');
        readingsResource.addMethod(
            'GET',
            new apigateway.LambdaIntegration(this.dashboardApiFunctionAlias),
            { apiKeyRequired: config.api.apiKeyRequired !== false }
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
                allowMethods: ['GET'],
                allowHeaders: ['Content-Type', 'X-Api-Key']
            }
        });
    }
}

module.exports = { LambdaFunctionsStack };
