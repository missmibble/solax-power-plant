'use strict';

const cdk = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const path = require('path');
const fs = require('fs');

const { InfrastructureStack } = require('../lib/infrastructure-stack');
const { LambdaFunctionsStack } = require('../lib/lambda-functions-stack');

const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'dev-powerplant.json'), 'utf8')
);

describe('LambdaFunctionsStack', () => {
    let template;

    beforeAll(() => {
        const app = new cdk.App();
        const env = { account: '123456789012', region: 'ap-southeast-2' };

        const infraStack = new InfrastructureStack(app, 'TestInfrastructureStack', { env, config });
        const lambdaStack = new LambdaFunctionsStack(app, 'TestLambdaFunctionsStack', {
            env,
            config,
            energyReadingsTable: infraStack.energyReadingsTable,
            alertsTopic: infraStack.alertsTopic,
            reportsTopic: infraStack.reportsTopic,
            userPool: infraStack.userPool
        });

        template = Template.fromStack(lambdaStack);
    });

    test('creates PollerFunction, DashboardApiFunction, AlertFunction, ReportFunction, BatteryControlFunction, GridDischargeFunction, and SettingsOptimizerFunction', () => {
        template.resourceCountIs('AWS::Lambda::Function', 7);
    });

    test('schedules PollerFunction every 5 minutes via EventBridge', () => {
        template.hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: config.lambda.pollerFunction.schedule
        });
    });

    test('schedules ReportFunction nightly via EventBridge', () => {
        template.hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: config.lambda.reportFunction.schedule
        });
    });

    test('AlertFunction has a DynamoDB Stream event source mapping', () => {
        template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    });

    test('creates a REST API for the dashboard', () => {
        template.hasResourceProperties('AWS::ApiGateway::RestApi', {
            Name: config.api.restApiName
        });
    });

    test('GET /readings requires an API key', () => {
        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'GET',
            ApiKeyRequired: true
        });
    });

    test('PollerFunction role can read the SolaX SSM parameters', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: Match.arrayWith(['ssm:GetParameter'])
                    })
                ])
            }
        });
    });

    test('DashboardApiFunction, AlertFunction, and ReportFunction get the tariff structure (with location timezone merged in) as an env var', () => {
        const tariffJson = JSON.stringify({ ...config.tariff, timezone: config.location.timezone });

        for (const fn of ['dashboardApiFunction', 'alertFunction', 'reportFunction']) {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: config.lambda[fn].functionName,
                Environment: { Variables: Match.objectLike({ TARIFF_STRUCTURE: tariffJson }) }
            });
        }
    });

    test('DashboardApiFunction gets battery-settings defaults (including dry-run) as env vars, sourced from config.batteryControl', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: config.lambda.dashboardApiFunction.functionName,
            Environment: {
                Variables: Match.objectLike({
                    BATTERY_CONTROL_DEFAULT_SUNNY: String(config.batteryControl.chargeUpperSocSunny),
                    BATTERY_CONTROL_DEFAULT_OVERCAST: String(config.batteryControl.chargeUpperSocOvercast),
                    BATTERY_CONTROL_DEFAULT_DISABLED: String(config.batteryControl.disabledChargeUpperSoc),
                    BATTERY_CONTROL_DEFAULT_DRY_RUN: String(config.batteryControl.dryRun !== false)
                })
            }
        });
    });

    test('AlertFunction role can query the energy readings table (not just stream permissions)', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyName: Match.stringLikeRegexp('AlertFunction'),
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: Match.arrayWith(['dynamodb:Query'])
                    })
                ])
            }
        });
    });

    test('PollerFunction gets the battery SN env var for auto-discovery fallback', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: config.lambda.pollerFunction.functionName,
            Environment: { Variables: Match.objectLike({ SOLAX_BATTERY_SN: config.solax.batterySn }) }
        });
    });

    test('schedules BatteryControlFunction nightly via EventBridge', () => {
        template.hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: config.lambda.batteryControlFunction.schedule
        });
    });

    test('BatteryControlFunction gets the weather and battery-control config as env vars', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: config.lambda.batteryControlFunction.functionName,
            Environment: {
                Variables: Match.objectLike({
                    WEATHER_LAT: String(config.location.lat),
                    WEATHER_LON: String(config.location.lon),
                    BATTERY_CONTROL_CONFIG: JSON.stringify(config.batteryControl)
                })
            }
        });
    });

    test('BatteryControlFunction role can read SSM parameters (SolaX creds + weather API key)', () => {
        const policies = template.findResources('AWS::IAM::Policy', {
            Properties: { PolicyName: Match.stringLikeRegexp('BatteryControlFunction') }
        });
        const [policy] = Object.values(policies);
        const ssmStatement = policy.Properties.PolicyDocument.Statement.find(
            s => s.Action?.includes?.('ssm:GetParameter')
        );

        expect(ssmStatement).toBeDefined();
        expect(ssmStatement.Resource).toHaveLength(3);
    });

    test('BatteryControlFunction role can publish to both SNS topics', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyName: Match.stringLikeRegexp('BatteryControlFunction'),
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({ Action: 'sns:Publish' })
                ])
            }
        });
    });

    test('ReportFunction role can write to the energy readings table (for its report record)', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyName: Match.stringLikeRegexp('ReportFunction'),
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: Match.arrayWith(['dynamodb:PutItem'])
                    })
                ])
            }
        });
    });

    test('creates /insights and /battery-status API resources alongside /readings', () => {
        template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'insights' });
        template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'battery-status' });
    });

    test('creates a Cognito app client with no client secret (public client for browser JS)', () => {
        template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
            GenerateSecret: false,
            ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH'])
        });
    });

    test('GET /readings, /insights, and /battery-status all require Cognito authorization', () => {
        const methods = template.findResources('AWS::ApiGateway::Method', {
            Properties: { HttpMethod: 'GET', AuthorizationType: 'COGNITO_USER_POOLS' }
        });
        expect(Object.keys(methods).length).toBeGreaterThanOrEqual(3);
    });

    test('creates a /battery-settings API resource with GET and PUT methods', () => {
        template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'battery-settings' });
        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'PUT',
            AuthorizationType: 'COGNITO_USER_POOLS'
        });
    });

    test('POST /insights (manual assessment trigger) requires Cognito authorization', () => {
        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'POST',
            AuthorizationType: 'COGNITO_USER_POOLS'
        });
    });

    test('BatteryControlFunction gets the readings table name as an env var', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: config.lambda.batteryControlFunction.functionName,
            Environment: { Variables: Match.objectLike({ ENERGY_READINGS_TABLE: Match.anyValue() }) }
        });
    });

    test('BatteryControlFunction role can read and write the energy readings table', () => {
        const policies = template.findResources('AWS::IAM::Policy', {
            Properties: { PolicyName: Match.stringLikeRegexp('BatteryControlFunction') }
        });
        const statements = Object.values(policies).flatMap(p => p.Properties.PolicyDocument.Statement);
        const dynamoStatement = statements.find(s => s.Action?.includes?.('dynamodb:PutItem'));

        expect(dynamoStatement).toBeDefined();
        expect(dynamoStatement.Action).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem']));
    });

    test('BatteryControlFunction role can invoke Bedrock when a model is configured', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyName: Match.stringLikeRegexp('BatteryControlFunction'),
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({ Action: 'bedrock:InvokeModel' })
                ])
            }
        });
    });

    describe('with a cross-region inference profile modelId', () => {
        // Cross-region profile IDs (e.g. "au.anthropic.claude-haiku-4-5-20251001-v1:0")
        // aren't invoked in this stack's own region for the underlying model call —
        // Bedrock routes within the profile's geography — so the IAM grant needs a
        // region-wildcarded foundation-model ARN (built from the ID with its geo
        // prefix stripped) alongside the profile ARN itself in this region. See
        // LambdaFunctionsStack.bedrockInvokeResources.
        let profileTemplate;
        const profileModelId = 'au.anthropic.claude-haiku-4-5-20251001-v1:0';

        beforeAll(() => {
            const profileConfig = { ...config, bedrock: { ...config.bedrock, modelId: profileModelId } };
            const app = new cdk.App();
            const env = { account: '123456789012', region: 'ap-southeast-2' };

            const infraStack = new InfrastructureStack(app, 'TestProfileInfrastructureStack', { env, config: profileConfig });
            const lambdaStack = new LambdaFunctionsStack(app, 'TestProfileLambdaFunctionsStack', {
                env,
                config: profileConfig,
                energyReadingsTable: infraStack.energyReadingsTable,
                alertsTopic: infraStack.alertsTopic,
                reportsTopic: infraStack.reportsTopic,
                userPool: infraStack.userPool
            });

            profileTemplate = Template.fromStack(lambdaStack);
        });

        test.each([
            ['BatteryControlFunction'],
            ['ReportFunction']
        ])('%s is granted both the wildcard-region foundation-model ARN and the same-region inference-profile ARN', (functionName) => {
            const policies = profileTemplate.findResources('AWS::IAM::Policy', {
                Properties: { PolicyName: Match.stringLikeRegexp(functionName) }
            });
            const statements = Object.values(policies).flatMap(p => p.Properties.PolicyDocument.Statement);
            const bedrockStatement = statements.find(s => s.Action === 'bedrock:InvokeModel');

            expect(bedrockStatement).toBeDefined();
            expect(bedrockStatement.Resource).toHaveLength(2);
            // Resource entries are Fn::Join intrinsics (this.partition is a CDK
            // token, not a literal), so assert on the literal ARN suffix each
            // one joins in rather than a fully-resolved string.
            expect(JSON.stringify(bedrockStatement.Resource[0])).toContain(
                ':bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0'
            );
            expect(JSON.stringify(bedrockStatement.Resource[1])).toContain(
                `:bedrock:ap-southeast-2:123456789012:inference-profile/${profileModelId}`
            );
        });
    });

    test('DashboardApiFunction role can write to the energy readings table (for settings saves)', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyName: Match.stringLikeRegexp('DashboardApiFunction'),
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: Match.arrayWith(['dynamodb:PutItem'])
                    })
                ])
            }
        });
    });

    test('DashboardApiFunction role can invoke ReportFunction (manual assessment trigger)', () => {
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyName: Match.stringLikeRegexp('DashboardApiFunction'),
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({ Action: 'lambda:InvokeFunction' })
                ])
            }
        });
    });

    test('schedules a 6x/day ReportFunction refresh (sendEmail: false) separate from the nightly rule', () => {
        template.hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: config.lambda.reportFunction.refreshSchedule,
            Targets: Match.arrayWith([
                Match.objectLike({
                    Input: JSON.stringify({ sendEmail: false })
                })
            ])
        });
    });

    test('GridDischargeFunction gets the readings table, SolaX, tariff, and merged grid-discharge config as env vars', () => {
        const gridDischargeConfigJson = JSON.stringify({ ...config.gridDischarge, minSoc: config.batteryControl.minSoc });

        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: config.lambda.gridDischargeFunction.functionName,
            Environment: {
                Variables: Match.objectLike({
                    ENERGY_READINGS_TABLE: Match.anyValue(),
                    SOLAX_INVERTER_SN: config.solax.inverterSn,
                    GRID_DISCHARGE_CONFIG: gridDischargeConfigJson
                })
            }
        });
    });

    test('schedules GridDischargeFunction start (5pm), check (7pm), and exit (9pm) as three separate EventBridge rules', () => {
        template.hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: config.lambda.gridDischargeFunction.startSchedule,
            Targets: Match.arrayWith([
                Match.objectLike({ Input: JSON.stringify({ phase: 'start' }) })
            ])
        });

        template.hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: config.lambda.gridDischargeFunction.checkSchedule,
            Targets: Match.arrayWith([
                Match.objectLike({ Input: JSON.stringify({ phase: 'check' }) })
            ])
        });

        template.hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: config.lambda.gridDischargeFunction.exitSchedule,
            Targets: Match.arrayWith([
                Match.objectLike({ Input: JSON.stringify({ phase: 'exit' }) })
            ])
        });
    });

    test('GridDischargeFunction role can read SolaX SSM parameters and read/write the energy readings table', () => {
        const policies = template.findResources('AWS::IAM::Policy', {
            Properties: { PolicyName: Match.stringLikeRegexp('GridDischargeFunction') }
        });
        const statements = Object.values(policies).flatMap(p => p.Properties.PolicyDocument.Statement);

        expect(statements.some(s => s.Action?.includes?.('ssm:GetParameter'))).toBe(true);
        const dynamoStatement = statements.find(s => s.Action?.includes?.('dynamodb:PutItem'));
        expect(dynamoStatement).toBeDefined();
        expect(dynamoStatement.Action).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem']));
    });

    test('GridDischargeFunction role can publish to both SNS topics', () => {
        const policies = template.findResources('AWS::IAM::Policy', {
            Properties: { PolicyName: Match.stringLikeRegexp('GridDischargeFunction') }
        });
        const statements = Object.values(policies).flatMap(p => p.Properties.PolicyDocument.Statement);
        const publishStatements = statements.filter(s => s.Action === 'sns:Publish');

        expect(publishStatements).toHaveLength(2);
    });

    test('creates a CloudWatch alarm for GridDischargeFunction errors', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            AlarmName: 'powerplant-GridDischarge-errors'
        });
    });

    test('creates a POST /grid-discharge API resource requiring Cognito authorization (manual terminate-early button)', () => {
        const resources = template.findResources('AWS::ApiGateway::Resource', {
            Properties: { PathPart: 'grid-discharge' }
        });
        expect(Object.keys(resources)).toHaveLength(1);

        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'POST',
            AuthorizationType: 'COGNITO_USER_POOLS',
            ResourceId: { Ref: Object.keys(resources)[0] }
        });
    });

    test('DashboardApiFunction gets the GridDischargeFunction name as an env var (manual terminate-early button)', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: config.lambda.dashboardApiFunction.functionName,
            Environment: {
                Variables: Match.objectLike({ GRID_DISCHARGE_FUNCTION_NAME: Match.anyValue() })
            }
        });
    });

    test('DashboardApiFunction role can invoke GridDischargeFunction (manual terminate-early button)', () => {
        const policies = template.findResources('AWS::IAM::Policy', {
            Properties: { PolicyName: Match.stringLikeRegexp('DashboardApiFunction') }
        });
        const statements = Object.values(policies).flatMap(p => p.Properties.PolicyDocument.Statement);
        const invokeStatements = statements.filter(s => s.Action === 'lambda:InvokeFunction');

        // One for ReportFunction (manual assessment trigger), one for GridDischargeFunction.
        expect(invokeStatements.length).toBeGreaterThanOrEqual(2);
    });

    test('SettingsOptimizerFunction gets the readings table, SolaX SN, Bedrock model, and merged optimizer config as env vars', () => {
        const settingsOptimizerConfigJson = JSON.stringify({
            ...config.settingsOptimizer,
            batteryControlDefaults: {
                chargeUpperSocSunny: config.batteryControl.chargeUpperSocSunny,
                chargeUpperSocOvercast: config.batteryControl.chargeUpperSocOvercast
            },
            gridDischargeDefaults: {
                fallbackReservePercent: config.gridDischarge.fallbackReservePercent,
                safetyMarginPercent: config.gridDischarge.safetyMarginPercent
            }
        });

        template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: config.lambda.settingsOptimizerFunction.functionName,
            Environment: {
                Variables: Match.objectLike({
                    ENERGY_READINGS_TABLE: Match.anyValue(),
                    BEDROCK_MODEL_ID: config.bedrock.modelId,
                    SETTINGS_OPTIMIZER_CONFIG: settingsOptimizerConfigJson
                })
            }
        });
    });

    test('schedules SettingsOptimizerFunction weekly via EventBridge', () => {
        template.hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: config.lambda.settingsOptimizerFunction.schedule,
            Targets: Match.arrayWith([
                Match.objectLike({ Arn: Match.anyValue() })
            ])
        });
    });

    test('SettingsOptimizerFunction role can read/write the energy readings table, publish to both topics, and invoke Bedrock', () => {
        const policies = template.findResources('AWS::IAM::Policy', {
            Properties: { PolicyName: Match.stringLikeRegexp('SettingsOptimizerFunction') }
        });
        const statements = Object.values(policies).flatMap(p => p.Properties.PolicyDocument.Statement);

        const dynamoStatement = statements.find(s => s.Action?.includes?.('dynamodb:PutItem'));
        expect(dynamoStatement).toBeDefined();
        expect(dynamoStatement.Action).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem']));

        expect(statements.filter(s => s.Action === 'sns:Publish')).toHaveLength(2);
        expect(statements.some(s => s.Action === 'bedrock:InvokeModel')).toBe(true);
    });

    test('creates a CloudWatch alarm for SettingsOptimizerFunction errors', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            AlarmName: 'powerplant-SettingsOptimizer-errors'
        });
    });
});
