'use strict';

const cdk = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const path = require('path');
const fs = require('fs');

const { InfrastructureStack } = require('../lib/infrastructure-stack');
const { LambdaFunctionsStack } = require('../lib/lambda-functions-stack');
const { DashboardStack } = require('../lib/dashboard-stack');

const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'dev-powerplant.json'), 'utf8')
);
// The public template's apiKeyValue is a TODO placeholder shorter than API
// Gateway's 20-character minimum — swap in a real-shaped value for this test.
config.api.apiKeyValue = 'test-api-key-value-1234567890';

describe('DashboardStack', () => {
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

        const dashboardStack = new DashboardStack(app, 'TestDashboardStack', {
            env,
            config,
            api: lambdaStack.api
        });
        dashboardStack.addStackDependency(lambdaStack);

        template = Template.fromStack(dashboardStack);
    });

    test('creates the dashboard S3 bucket blocking all public access', () => {
        template.hasResourceProperties('AWS::S3::Bucket', {
            PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                BlockPublicPolicy: true,
                IgnorePublicAcls: true,
                RestrictPublicBuckets: true
            }
        });
    });

    test('creates a CloudFront distribution with index.html as the default root object', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({ DefaultRootObject: 'index.html' })
        });
    });

    test('routes the "readings" path pattern to the API origin', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({
                CacheBehaviors: Match.arrayWith([
                    Match.objectLike({ PathPattern: 'readings' })
                ])
            })
        });
    });

    test('exports a DashboardUrl output', () => {
        template.hasOutput('DashboardUrl', { Export: { Name: 'PowerPlantDashboardUrl' } });
    });
});
