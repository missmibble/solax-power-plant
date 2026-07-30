'use strict';

const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const path = require('path');
const fs = require('fs');

const { InfrastructureStack } = require('../lib/infrastructure-stack');

const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'dev-powerplant.json'), 'utf8')
);

describe('InfrastructureStack', () => {
    let template;

    beforeAll(() => {
        const app = new cdk.App();
        const stack = new InfrastructureStack(app, 'TestInfrastructureStack', {
            env: { account: '123456789012', region: 'ap-southeast-2' },
            config,
            solaxCredentials: { clientId: 'test-client-id', clientSecret: 'test-client-secret' }
        });
        template = Template.fromStack(stack);
    });

    // ─── DynamoDB ──────────────────────────────────────────────────────────────

    test('creates energy readings table with PAY_PER_REQUEST billing', () => {
        template.hasResourceProperties('AWS::DynamoDB::Table', {
            TableName: config.dynamodb.energyReadingsTable.tableName,
            BillingMode: 'PAY_PER_REQUEST'
        });
    });

    test('energy readings table has a DeviceSn + Timestamp key schema', () => {
        template.hasResourceProperties('AWS::DynamoDB::Table', {
            KeySchema: [
                { AttributeName: 'DeviceSn', KeyType: 'HASH' },
                { AttributeName: 'Timestamp', KeyType: 'RANGE' }
            ]
        });
    });

    test('energy readings table has DynamoDB Streams enabled', () => {
        template.hasResourceProperties('AWS::DynamoDB::Table', {
            StreamSpecification: { StreamViewType: 'NEW_IMAGE' }
        });
    });

    // ─── SNS ───────────────────────────────────────────────────────────────────

    test('creates alerts SNS topic', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
            TopicName: config.sns.alertsTopic.topicName
        });
    });

    test('creates reports SNS topic', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
            TopicName: config.sns.reportsTopic.topicName
        });
    });

    // ─── SSM ───────────────────────────────────────────────────────────────────

    test('creates SSM parameters for the SolaX credentials when a seed is provided', () => {
        template.resourceCountIs('Custom::AWS', 2);
    });

    test('skips SSM parameter creation when no credentials seed is provided', () => {
        const app = new cdk.App();
        const stack = new InfrastructureStack(app, 'TestInfrastructureStackNoCreds', {
            env: { account: '123456789012', region: 'ap-southeast-2' },
            config,
            solaxCredentials: null
        });
        Template.fromStack(stack).resourceCountIs('Custom::AWS', 0);
    });

    test('also creates the weather API key parameter when one is provided', () => {
        const app = new cdk.App();
        const stack = new InfrastructureStack(app, 'TestInfrastructureStackWeather', {
            env: { account: '123456789012', region: 'ap-southeast-2' },
            config,
            solaxCredentials: { clientId: 'test-client-id', clientSecret: 'test-client-secret' },
            weatherApiKey: 'test-weather-key'
        });
        Template.fromStack(stack).resourceCountIs('Custom::AWS', 3);
    });

    // ─── Outputs ───────────────────────────────────────────────────────────────

    test('exports EnergyReadingsTableName output', () => {
        template.hasOutput('EnergyReadingsTableName', {
            Export: { Name: 'PowerPlantEnergyReadingsTableName' }
        });
    });

    test('exports AlertsTopicArn output', () => {
        template.hasOutput('AlertsTopicArn', { Export: { Name: 'PowerPlantAlertsTopicArn' } });
    });

    test('exports ReportsTopicArn output', () => {
        template.hasOutput('ReportsTopicArn', { Export: { Name: 'PowerPlantReportsTopicArn' } });
    });
});
