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
    getDeviceInfo,
    getDeviceRealtimeData
} = require('powerplant-shared');

const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

let cachedCredentials = null; // reused across warm invocations in the same execution context
let cachedBatterySn = null; // discovered once per execution context if not configured

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

// The battery's deviceSn isn't necessarily known up front — if SOLAX_BATTERY_SN
// isn't configured (or still the config template's placeholder), discover it via
// getDeviceInfo (deviceType=BATTERY) instead of requiring the user to find it manually.
async function resolveBatterySn(baseUrl, accessToken, businessType) {
    const configured = process.env.SOLAX_BATTERY_SN;
    if (configured && !configured.startsWith('TODO_')) return configured;
    if (cachedBatterySn) return cachedBatterySn;

    const devices = await getDeviceInfo(baseUrl, accessToken, {
        deviceType: DEVICE_TYPE.BATTERY,
        businessType
    });

    const battery = (devices?.records || devices || [])[0];
    if (!battery?.deviceSn) {
        logError('No battery device discovered — this reading will have no battery fields');
        return null;
    }

    cachedBatterySn = battery.deviceSn;
    logInfo('Discovered battery device', { deviceSn: cachedBatterySn });
    return cachedBatterySn;
}

// Battery data is a bonus on top of the required inverter reading — a failure
// here (no battery configured/discoverable, transient API error) never fails
// the whole poll, it just means this interval's reading has no battery fields.
async function fetchBatteryReading(baseUrl, accessToken, businessType) {
    try {
        const batterySn = await resolveBatterySn(baseUrl, accessToken, businessType);
        if (!batterySn) return null;

        const [reading] = await getDeviceRealtimeData(baseUrl, accessToken, {
            snList: batterySn,
            deviceType: DEVICE_TYPE.BATTERY,
            requestSnType: 2, // querying by the battery's own SN, not the inverter's
            businessType
        });

        return reading || null;
    } catch (err) {
        logError('Battery reading failed', { error: err.message });
        return null;
    }
}

exports.handler = async () => {
    try {
        const { clientId, clientSecret } = await loadSolaxCredentials();
        const baseUrl = process.env.SOLAX_BASE_URL;
        const businessType = Number(process.env.SOLAX_BUSINESS_TYPE) || BUSINESS_TYPE.RESIDENTIAL;

        const accessToken = await getAccessToken({ baseUrl, clientId, clientSecret });

        const [inverterReading] = await getDeviceRealtimeData(baseUrl, accessToken, {
            snList: process.env.SOLAX_INVERTER_SN,
            deviceType: Number(process.env.SOLAX_DEVICE_TYPE) || DEVICE_TYPE.INVERTER,
            businessType
        });

        if (!inverterReading) {
            logError('No reading returned for inverter', { sn: process.env.SOLAX_INVERTER_SN });
            return { statusCode: 502 };
        }

        const batteryReading = await fetchBatteryReading(baseUrl, accessToken, businessType);

        await docClient.send(new PutCommand({
            TableName: process.env.ENERGY_READINGS_TABLE,
            Item: {
                DeviceSn: inverterReading.deviceSn,
                Timestamp: Math.floor(Date.now() / 1000),
                dataTime: inverterReading.dataTime,
                deviceStatus: inverterReading.deviceStatus,
                dailyYield: inverterReading.dailyYield,
                totalYield: inverterReading.totalYield,
                dailyACOutput: inverterReading.dailyACOutput,
                totalACOutput: inverterReading.totalACOutput,
                gridPower: inverterReading.gridPower,
                todayImportEnergy: inverterReading.todayImportEnergy,
                totalImportEnergy: inverterReading.totalImportEnergy,
                todayExportEnergy: inverterReading.todayExportEnergy,
                totalExportEnergy: inverterReading.totalExportEnergy,
                totalActivePower: inverterReading.totalActivePower,
                ...(batteryReading && {
                    batteryDeviceSn: batteryReading.deviceSn,
                    batteryDeviceStatus: batteryReading.deviceStatus,
                    batterySOC: batteryReading.batterySOC,
                    batterySOH: batteryReading.batterySOH,
                    batteryRemainings: batteryReading.batteryRemainings,
                    chargeDischargePower: batteryReading.chargeDischargePower,
                    batteryCycleTimes: batteryReading.batteryCycleTimes,
                    // docs/solax-apis.md previously documented this source field as
                    // "totalDevicCharge" (missing "e") — verified against a live API
                    // call that the real field is correctly spelled "totalDeviceCharge";
                    // the old mapping read a key that never existed, so this field was
                    // silently undefined on every stored reading since the app went live.
                    totalDeviceCharge: batteryReading.totalDeviceCharge,
                    totalDeviceDischarge: batteryReading.totalDeviceDischarge
                })
            }
        }));

        logInfo('Reading stored', {
            deviceSn: inverterReading.deviceSn,
            dataTime: inverterReading.dataTime,
            batteryIncluded: Boolean(batteryReading)
        });
        return { statusCode: 200 };
    } catch (err) {
        logError('Poll failed', { error: err.message });
        throw err;
    }
};

module.exports.resolveBatterySn = resolveBatterySn;
module.exports.fetchBatteryReading = fetchBatteryReading;
