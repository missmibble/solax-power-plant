#!/bin/bash
# deploy.sh — Deploy PowerPlant stacks to AWS
# Usage: bash scripts/deploy.sh [ENV]

set -e

ENV=${1:-dev}
CONFIG_FILE="${ENV}-powerplant.json"

echo "================================================"
echo "  Deploying PowerPlant  [env: $ENV]"
echo "================================================"

if [ ! -f "config/$CONFIG_FILE" ]; then
    echo "ERROR: Config file not found: config/$CONFIG_FILE"
    exit 1
fi

echo ""
echo "▶ Installing root dependencies..."
npm install

echo ""
echo "▶ Installing Lambda dependencies..."
npm run install-all

echo ""
echo "▶ Running tests..."
npm test

echo ""
echo "▶ Synthesizing CDK stacks..."
CDK_CONFIG="$CONFIG_FILE" npx cdk synth

echo ""
echo "▶ Deploying all stacks..."
CDK_CONFIG="$CONFIG_FILE" npx cdk deploy --all --require-approval never

echo ""
echo "================================================"
echo "  Deployment complete!"
echo "================================================"
