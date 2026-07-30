'use strict';

const { Stack, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const sns = require('aws-cdk-lib/aws-sns');
const cr = require('aws-cdk-lib/custom-resources');

class InfrastructureStack extends Stack {
    constructor(scope, id, props) {
        super(scope, id, props);

        const { config, solaxCredentials, weatherApiKey } = props;

        // ─── DynamoDB ─────────────────────────────────────────────────────────
        // Time-series store of SolaX Cloud readings. Streams enabled so
        // AlertFunction can react to new readings without its own polling schedule.

        this.energyReadingsTable = this.newDynamoDBTableFunction(config.dynamodb.energyReadingsTable);

        // ─── SNS ──────────────────────────────────────────────────────────────

        this.alertsTopic = this.newSNSTopicFunction(config.sns.alertsTopic);
        this.reportsTopic = this.newSNSTopicFunction(config.sns.reportsTopic);

        // ─── SSM (SolaX OAuth credentials) ─────────────────────────────────────
        // CloudFormation can't create SecureString parameters natively, so this
        // goes through a custom resource. Only provisioned when solax-application-
        // creds.txt is present — once seeded, delete the file; the parameters are
        // RemovalPolicy.RETAIN so a later deploy without that block won't touch them.

        if (solaxCredentials) {
            this.newSecureStringParameterFunction(config.ssm.solaxClientId, solaxCredentials.clientId);
            this.newSecureStringParameterFunction(config.ssm.solaxClientSecret, solaxCredentials.clientSecret);
        }

        // Same pattern, for BatteryControlFunction's OpenWeatherMap API key —
        // provisioned from weather-api-key.txt (gitignored), see bin/powerplant.js.
        if (weatherApiKey) {
            this.newSecureStringParameterFunction(config.ssm.weatherApiKey, weatherApiKey);
        }

        // ─── Outputs ──────────────────────────────────────────────────────────

        new CfnOutput(this, 'EnergyReadingsTableName', {
            value: this.energyReadingsTable.tableName,
            exportName: 'PowerPlantEnergyReadingsTableName'
        });

        new CfnOutput(this, 'AlertsTopicArn', {
            value: this.alertsTopic.topicArn,
            exportName: 'PowerPlantAlertsTopicArn'
        });

        new CfnOutput(this, 'ReportsTopicArn', {
            value: this.reportsTopic.topicArn,
            exportName: 'PowerPlantReportsTopicArn'
        });
    }

    // ─── Factory: DynamoDB Table ──────────────────────────────────────────────

    newDynamoDBTableFunction(config) {
        const {
            tableName, cfResource, partitionKey, sortKey,
            indexRequired, indexKey, indexName,
            streamEnabled, streamViewType
        } = config;

        const tableProps = {
            tableName,
            partitionKey: {
                name: partitionKey.name,
                type: dynamodb.AttributeType[partitionKey.type.toUpperCase()]
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: RemovalPolicy.DESTROY
        };

        if (sortKey) {
            tableProps.sortKey = {
                name: sortKey.name,
                type: dynamodb.AttributeType[sortKey.type.toUpperCase()]
            };
        }

        if (streamEnabled) {
            tableProps.stream =
                dynamodb.StreamViewType[streamViewType] ||
                dynamodb.StreamViewType.NEW_AND_OLD_IMAGES;
        }

        const table = new dynamodb.Table(this, cfResource, tableProps);

        if (indexRequired && indexKey && indexName) {
            table.addGlobalSecondaryIndex({
                indexName,
                partitionKey: {
                    name: indexKey.name,
                    type: dynamodb.AttributeType[indexKey.type.toUpperCase()]
                }
            });
        }

        return table;
    }

    // ─── Factory: SNS Topic ───────────────────────────────────────────────────

    newSNSTopicFunction(config) {
        const { topicName, cfResource, description } = config;

        return new sns.Topic(this, cfResource, {
            topicName,
            displayName: description
        });
    }

    // ─── Factory: SSM SecureString Parameter (via custom resource) ────────────

    newSecureStringParameterFunction(config, value) {
        const { parameterName, cfResource, description } = config;

        const putParameter = {
            service: 'SSM',
            action: 'putParameter',
            parameters: {
                Name: parameterName,
                Value: value,
                Type: 'SecureString',
                Description: description,
                Overwrite: true
            },
            physicalResourceId: cr.PhysicalResourceId.of(parameterName)
        };

        const resource = new cr.AwsCustomResource(this, cfResource, {
            onCreate: putParameter,
            onUpdate: putParameter,
            onDelete: {
                service: 'SSM',
                action: 'deleteParameter',
                parameters: { Name: parameterName },
                ignoreErrorCodesMatching: 'ParameterNotFound'
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
            }),
            removalPolicy: RemovalPolicy.RETAIN
        });

        return resource;
    }
}

module.exports = { InfrastructureStack };
