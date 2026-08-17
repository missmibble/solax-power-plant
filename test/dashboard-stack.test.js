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
            reportsTopic: infraStack.reportsTopic,
            userPool: infraStack.userPool
        });

        const dashboardStack = new DashboardStack(app, 'TestDashboardStack', {
            env,
            config,
            api: lambdaStack.api,
            userPoolClient: lambdaStack.userPoolClient
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

    test('routes the "readings", "insights", "battery-status", "battery-settings", "settings-optimization", "settings-optimizer-settings", and "household-settings" path patterns to the API origin', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({
                CacheBehaviors: Match.arrayWith([
                    Match.objectLike({ PathPattern: 'readings' }),
                    Match.objectLike({ PathPattern: 'insights' }),
                    Match.objectLike({ PathPattern: 'battery-status' }),
                    Match.objectLike({ PathPattern: 'battery-settings' }),
                    Match.objectLike({ PathPattern: 'settings-optimization' }),
                    Match.objectLike({ PathPattern: 'settings-optimizer-settings' }),
                    Match.objectLike({ PathPattern: 'household-settings' })
                ])
            })
        });
    });

    test.each([
        ['readings', Match.exact(['GET', 'HEAD'])],
        ['battery-status', Match.exact(['GET', 'HEAD'])],
        ['insights', Match.arrayWith(['GET', 'HEAD', 'PUT', 'POST'])],
        ['battery-settings', Match.arrayWith(['GET', 'HEAD', 'PUT', 'POST'])],
        ['settings-optimization', Match.exact(['GET', 'HEAD'])],
        ['settings-optimizer-settings', Match.arrayWith(['GET', 'HEAD', 'PUT', 'POST'])],
        ['household-settings', Match.arrayWith(['GET', 'HEAD', 'PUT', 'POST'])]
    ])('CloudFront behavior for "%s" allows the expected methods', (pathPattern, allowedMethodsMatcher) => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({
                CacheBehaviors: Match.arrayWith([
                    Match.objectLike({ PathPattern: pathPattern, AllowedMethods: allowedMethodsMatcher })
                ])
            })
        });
    });

    test('exports a DashboardUrl output', () => {
        template.hasOutput('DashboardUrl', { Export: { Name: 'PowerPlantDashboardUrl' } });
    });

    test('does not attach an alternate domain when config.dashboard is left at its TODO_ placeholders', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({ Aliases: Match.absent() })
        });
    });
});

describe('DashboardStack with a custom domain configured', () => {
    let template;

    beforeAll(() => {
        const customDomainConfig = {
            ...config,
            dashboard: {
                domainName: 'power.stillbroken.tech',
                certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id'
            }
        };

        const app = new cdk.App();
        const env = { account: '123456789012', region: 'ap-southeast-2' };

        const infraStack = new InfrastructureStack(app, 'TestCustomDomainInfrastructureStack', { env, config: customDomainConfig });
        const lambdaStack = new LambdaFunctionsStack(app, 'TestCustomDomainLambdaFunctionsStack', {
            env,
            config: customDomainConfig,
            energyReadingsTable: infraStack.energyReadingsTable,
            alertsTopic: infraStack.alertsTopic,
            reportsTopic: infraStack.reportsTopic,
            userPool: infraStack.userPool
        });

        const dashboardStack = new DashboardStack(app, 'TestCustomDomainDashboardStack', {
            env,
            config: customDomainConfig,
            api: lambdaStack.api,
            userPoolClient: lambdaStack.userPoolClient
        });
        dashboardStack.addStackDependency(lambdaStack);

        template = Template.fromStack(dashboardStack);
    });

    test('retains the alternate domain and its ACM certificate on the CloudFront distribution', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({
                Aliases: ['power.stillbroken.tech'],
                ViewerCertificate: Match.objectLike({
                    AcmCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id'
                })
            })
        });
    });
});
