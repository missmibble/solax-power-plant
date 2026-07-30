#!/bin/bash
# deploy.sh — Deploy PowerPlant stacks to AWS
# Usage: bash scripts/deploy.sh [ENV]
#        bash scripts/deploy.sh --config <file>   (e.g. a gitignored local config)

set -e

ENV="dev"
CONFIG_FILE=""

while [ $# -gt 0 ]; do
    case "$1" in
        -c|--config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        *)
            ENV="$1"
            shift
            ;;
    esac
done

CONFIG_FILE="${CONFIG_FILE:-${ENV}-powerplant.json}"

echo "================================================"
echo "  Deploying PowerPlant  [config: $CONFIG_FILE]"
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
