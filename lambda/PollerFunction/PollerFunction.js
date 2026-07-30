'use strict';

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const {
    logInfo,
    logError,
    BUSINESS_TYPE,
    DEVICE_TYPE,
    getAccessToken,
    getDeviceRealtimeData
} = require('powerplant-shared');

const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

let cachedCredentials = null; // reused across warm invocations in the same execution context

async function loadSolaxCredentials() {
    if (cachedCredentials) return cachedCredentials;

    const [clientIdResult, clientSecretResult] = await Promise.all([
        ssmClient.send(new GetParameterCommand({
            Name: process.env.SOLAX_CLIENT_ID_PARAM,
            WithDecryption: true
        })),
        ssmClient.send(new GetParameterCommand({
            Name: process.env.SOLAX_CLIENT_SECRET_PARAM,
            WithDecryption: true
        }))
    ]);

    cachedCredentials = {
        clientId: clientIdResult.Parameter.Value,
        clientSecret: clientSecretResult.Parameter.Value
    };

    return cachedCredentials;
}

// TODO: this only covers the Inverter device (DEVICE_TYPE.INVERTER / snList = SOLAX_INVERTER_SN),
// which per solax-apis.md §4.4 doesn't include battery SOC/charge-discharge fields — those come
// from a separate Battery device with its own deviceSn and deviceType. solax-apis.md never
// includes Appendix 3, so the Battery deviceType code is unconfirmed; add a second
// getDeviceRealtimeData call once that's known and the battery's deviceSn is on hand
// (solax.getDeviceInfo with deviceType filtered can discover it).
exports.handler = async () => {
    try {
        const { clientId, clientSecret } = await loadSolaxCredentials();
        const baseUrl = process.env.SOLAX_BASE_URL;

        const accessToken = await getAccessToken({ baseUrl, clientId, clientSecret });

        const [reading] = await getDeviceRealtimeData(baseUrl, accessToken, {
            snList: process.env.SOLAX_INVERTER_SN,
            deviceType: Number(process.env.SOLAX_DEVICE_TYPE) || DEVICE_TYPE.INVERTER,
            businessType: Number(process.env.SOLAX_BUSINESS_TYPE) || BUSINESS_TYPE.RESIDENTIAL
        });

        if (!reading) {
            logError('No reading returned for inverter', { sn: process.env.SOLAX_INVERTER_SN });
            return { statusCode: 502 };
        }

        await docClient.send(new PutCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            Item: {
                DeviceSn: reading.deviceSn,
                Timestamp: Math.floor(Date.now() / 1000),
                dataTime: reading.dataTime,
                deviceStatus: reading.deviceStatus,
                dailyYield: reading.dailyYield,
                totalYield: reading.totalYield,
                dailyACOutput: reading.dailyACOutput,
                totalACOutput: reading.totalACOutput,
                gridPower: reading.gridPower,
                todayImportEnergy: reading.todayImportEnergy,
                totalImportEnergy: reading.totalImportEnergy,
                todayExportEnergy: reading.todayExportEnergy,
                totalExportEnergy: reading.totalExportEnergy,
                totalActivePower: reading.totalActivePower
            }
        }));

        logInfo('Reading stored', { deviceSn: reading.deviceSn, dataTime: reading.dataTime });
        return { statusCode: 200 };
    } catch (err) {
        logError('Poll failed', { error: err.message });
        throw err;
    }
};
