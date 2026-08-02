'use strict';

const path = require('path');
const { Stack, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const iam = require('aws-cdk-lib/aws-iam');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const s3deploy = require('aws-cdk-lib/aws-s3-deployment');
const acm = require('aws-cdk-lib/aws-certificatemanager');

// A third stack, not folded into either of the other two. The dashboard bucket
// lives HERE rather than in InfrastructureStack: an Origin-Access-Control bucket
// policy embeds the distribution's own ARN, so the bucket and the distribution
// must be co-located in one stack (splitting them creates a same-pair circular
// cross-stack reference — bucket policy needs the distribution, origin needs
// the bucket — no matter which of the two owning stacks you pick). This stack
// only needs LambdaFunctionsStack, for the RestApi its other origin targets.
class DashboardStack extends Stack {
    constructor(scope, id, props) {
        super(scope, id, props);

        const { config, api, userPoolClient } = props;

        const dashboardBucket = this.newS3BucketFunction(config.s3.website);

        // Static site in front of the existing DashboardApiFunction/API Gateway.
        // The API key never reaches the browser: CloudFront attaches it as a
        // static origin header on requests it forwards to the API origin, so
        // the dashboard's own JS just calls same-origin "/readings" with no key.

        const apiOrigin = new origins.RestApiOrigin(api, {
            customHeaders: config.api.apiKeyRequired !== false
                ? { 'x-api-key': config.api.apiKeyValue }
                : undefined
        });
        const apiBehavior = {
            origin: apiOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER
        };
        // insights (POST /insights, the manual "run assessment now" trigger) and
        // battery-settings (PUT /battery-settings, saving dashboard-edited
        // control settings) need write methods through to the API origin —
        // ALLOW_GET_HEAD on the shared behavior above would block both at the
        // CloudFront layer regardless of what API Gateway/Cognito allow.
        const apiWriteBehavior = { ...apiBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL };

        // The alternate domain (power.stillbroken.tech) used to be added by hand
        // in the console after each deploy — CloudFormation doesn't know about
        // out-of-band console edits, so every redeploy silently reverted the
        // distribution back to its CDK-defined config and dropped it. Declaring
        // it here makes it durable across deploys. Skipped (default *.cloudfront.net
        // domain only) when either value is still a TODO_ placeholder, e.g. against
        // the public template config. certificateArn must be an ACM cert in
        // us-east-1 — CloudFront only accepts certificates from that region
        // regardless of which region the rest of the app is deployed in.
        const dashboardDomain = config.dashboard?.domainName;
        const dashboardCertArn = config.dashboard?.certificateArn;
        const hasCustomDomain = Boolean(dashboardDomain) && !dashboardDomain.startsWith('TODO_')
            && Boolean(dashboardCertArn) && !dashboardCertArn.startsWith('TODO_');

        const distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
            comment: 'PowerPlant dashboard',
            defaultRootObject: 'index.html',
            ...(hasCustomDomain ? {
                domainNames: [dashboardDomain],
                certificate: acm.Certificate.fromCertificateArn(this, 'DashboardCertificate', dashboardCertArn)
            } : {}),
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(dashboardBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED
            },
            additionalBehaviors: {
                readings: apiBehavior,
                insights: apiWriteBehavior,
                'battery-status': apiBehavior,
                'battery-settings': apiWriteBehavior,
                'grid-discharge': apiWriteBehavior,
                'grid-discharge-settings': apiWriteBehavior,
                'settings-optimization': apiBehavior,
                'settings-optimizer-settings': apiWriteBehavior
            }
        });

        // Not a secret — Cognito app clients are meant to be embedded in
        // client-side code (no client secret exists; generateSecret: false).
        // Injected at deploy time since the client ID isn't known until the
        // UserPoolClient resource is actually created.
        const authConfig = s3deploy.Source.jsonData('config.json', {
            userPoolClientId: userPoolClient.userPoolClientId,
            region: this.region
        });

        new s3deploy.BucketDeployment(this, 'DashboardAssetsDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'dashboard')), authConfig],
            destinationBucket: dashboardBucket,
            distribution,
            distributionPaths: ['/*']
        });

        new CfnOutput(this, 'DashboardUrl', {
            value: `https://${distribution.distributionDomainName}`,
            exportName: 'PowerPlantDashboardUrl'
        });

        new CfnOutput(this, 'DashboardBucketName', {
            value: dashboardBucket.bucketName,
            exportName: 'PowerPlantDashboardBucketName'
        });
    }

    // ─── Factory: S3 Bucket ───────────────────────────────────────────────────

    newS3BucketFunction(config) {
        const { bucketName, cfResource } = config;

        const bucket = new s3.Bucket(this, cfResource, {
            bucketName,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: true,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED
        });

        bucket.addToResourcePolicy(new iam.PolicyStatement({
            sid: 'DenyInsecureTransport',
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['s3:*'],
            resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
            conditions: { Bool: { 'aws:SecureTransport': 'false' } }
        }));

        return bucket;
    }
}

module.exports = { DashboardStack };
