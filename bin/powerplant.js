#!/usr/bin/env node

'use strict';

const cdk = require('aws-cdk-lib');
const path = require('path');
const fs = require('fs');
const { Tags } = require('aws-cdk-lib');

const { InfrastructureStack } = require('../lib/infrastructure-stack');
const { LambdaFunctionsStack } = require('../lib/lambda-functions-stack');
const { DashboardStack } = require('../lib/dashboard-stack');

// ─── Load config ─────────────────────────────────────────────────────────────
// dev-powerplant.json (tracked, public) holds only placeholder values — it's
// the template. Real deploys should use a gitignored config/*.local.json (e.g.
// dev-powerplant.local.json, copy the template and fill in your account ID,
// owner tag, bucket name, and inverter SN) via CDK_CONFIG=dev-powerplant.local.json.

const configFile = process.env.CDK_CONFIG || 'dev-powerplant.json';
const configPath = path.join(__dirname, '..', 'config', configFile);

if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// ─── Load SolaX credentials (one-time SSM seed) ───────────────────────────────
// solax-application-creds.txt is gitignored. Present → its values seed the SSM
// SecureString parameters on this deploy. Absent (already deleted after a prior
// successful seed) → InfrastructureStack skips re-creating them and the existing
// Parameter Store values are left untouched (see RemovalPolicy.RETAIN there).

function loadSolaxCredentials() {
    const credsPath = path.join(__dirname, '..', 'solax-application-creds.txt');
    if (!fs.existsSync(credsPath)) {
        return null;
    }

    const content = fs.readFileSync(credsPath, 'utf8');
    const clientId = content.match(/^Client ID:\s*(.+)$/m)?.[1]?.trim();
    const clientSecret = content.match(/^Client secret:\s*(.+)$/m)?.[1]?.trim();

    return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const solaxCredentials = loadSolaxCredentials();

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new cdk.App();

const env = {
    account: config.env.account,
    region: config.env.region
};

// ─── Stack 1: Infrastructure ──────────────────────────────────────────────────
// Core stateful resources: DynamoDB time-series table, SNS topics, and the
// SolaX OAuth credential SSM parameters.

const infraStack = new InfrastructureStack(app, 'PowerPlantInfrastructureStack', {
    env,
    config,
    solaxCredentials,
    description: 'powerplant: Core infrastructure — DynamoDB, S3, SNS, SSM'
});

// ─── Stack 2: Lambda Functions + API ──────────────────────────────────────────
// Poller (EventBridge-triggered), Dashboard API (API Gateway-fronted), Alert
// (DynamoDB Stream-triggered), Report (nightly EventBridge-triggered). Receives
// cross-stack resource references from infraStack.

const lambdaStack = new LambdaFunctionsStack(app, 'PowerPlantLambdaFunctionsStack', {
    env,
    config,
    energyReadingsTable: infraStack.energyReadingsTable,
    alertsTopic: infraStack.alertsTopic,
    reportsTopic: infraStack.reportsTopic,
    userPool: infraStack.userPool,
    description: 'powerplant: Poller, Dashboard API, Alert, and Report Lambdas + EventBridge + API Gateway'
});

lambdaStack.addStackDependency(infraStack);

// ─── Stack 3: Dashboard (S3 + CloudFront) ─────────────────────────────────────
// Owns its own S3 bucket (not stack 1's) and depends only on stack 2, for the
// RestApi — see lib/dashboard-stack.js for why the bucket can't live in
// InfrastructureStack instead. Skipped entirely against the public template
// config, since its placeholder apiKeyValue can't satisfy API Gateway's
// key-value requirements meaningfully.

const stacks = [infraStack, lambdaStack];

if (config.api.apiKeyValue && !config.api.apiKeyValue.startsWith('TODO_')) {
    const dashboardStack = new DashboardStack(app, 'PowerPlantDashboardStack', {
        env,
        config,
        api: lambdaStack.api,
        userPoolClient: lambdaStack.userPoolClient,
        description: 'powerplant: S3 + CloudFront dashboard in front of the DashboardApiFunction'
    });

    dashboardStack.addStackDependency(lambdaStack);
    stacks.push(dashboardStack);
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

const tags = config.tags || {};
stacks.forEach(stack => {
    Object.entries(tags).forEach(([key, value]) => Tags.of(stack).add(key, value));
});
