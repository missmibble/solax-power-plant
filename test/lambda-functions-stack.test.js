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
            reportsTopic: infraStack.reportsTopic
        });

        template = Template.fromStack(lambdaStack);
    });

    test('creates PollerFunction, DashboardApiFunction, AlertFunction, ReportFunction, and BatteryControlFunction', () => {
        template.resourceCountIs('AWS::Lambda::Function', 5);
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
});
