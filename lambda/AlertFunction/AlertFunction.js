'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { logInfo, logError, findImportRateWindow, DEVICE_STATUS } = require('powerplant-shared');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const snsClient = new SNSClient({ region: process.env.AWS_REGION });

const NIGHT_CHARGE_WINDOW_LABEL = 'night-ev-charge';
const IMPORT_THRESHOLD_KWH = Number(process.env.IMPORT_THRESHOLD_KWH) || 0.5;

// Residential batteries only ever report Idle(0)/Work(1) (docs/solax-apis.md
// Appendix 6) — no fault states exist to check there, so this only watches the
// Inverter's deviceStatus.

exports.handler = async (event) => {
    const tariff = JSON.parse(process.env.TARIFF_STRUCTURE);

    for (const record of event.Records || []) {
        if (record.eventName !== 'INSERT') continue;

        const reading = unmarshall(record.dynamodb.NewImage);
        logInfo('AlertFunction evaluating reading', { deviceSn: reading.DeviceSn, timestamp: reading.Timestamp });

        try {
            const previous = await getPreviousReading(reading.DeviceSn, reading.Timestamp);
            await checkImportAnomaly(reading, previous, tariff);
            await checkInverterFault(reading, previous);
        } catch (err) {
            logError('Alert evaluation failed', { error: err.message, deviceSn: reading.DeviceSn });
        }
    }

    return { statusCode: 200 };
};

async function getPreviousReading(deviceSn, beforeTimestamp) {
    const result = await docClient.send(new QueryCommand({
        TableName: process.env.ENERGY_READINGS_TABLE,
        KeyConditionExpression: 'DeviceSn = :sn AND #ts < :ts',
        ExpressionAttributeNames: { '#ts': 'Timestamp' },
        ExpressionAttributeValues: { ':sn': deviceSn, ':ts': beforeTimestamp },
        ScanIndexForward: false,
        Limit: 1
    }));

    return result.Items?.[0];
}

async function checkImportAnomaly(reading, previous, tariff) {
    if (!previous || typeof previous.totalImportEnergy !== 'number') return null;

    const deltaImportKwh = reading.totalImportEnergy - previous.totalImportEnergy;
    if (deltaImportKwh <= IMPORT_THRESHOLD_KWH) return null;

    const window = findImportRateWindow(tariff, reading.Timestamp);
    if (window?.label === NIGHT_CHARGE_WINDOW_LABEL) return null; // expected overnight charging

    const message =
        `Grid import spiked: ${deltaImportKwh.toFixed(2)} kWh in a single 5-minute interval` +
        (window ? ` during the ${window.label.replace(/-/g, ' ')} period (normal rate: ${window.rate}/kWh)` : '') +
        '.';

    await publishAlert(message);
    return message;
}

async function checkInverterFault(reading, previous) {
    const status = reading.deviceStatus;
    const isFault =
        status === DEVICE_STATUS.INVERTER.FAULT_RECOVERABLE || status === DEVICE_STATUS.INVERTER.FAULT_PERMANENT;
    if (!isFault) return null;

    // Already alerted for this exact fault on the previous reading — don't
    // re-alert every 5 minutes for as long as it persists.
    if (previous && previous.deviceStatus === status) return null;

    const isPermanent = status === DEVICE_STATUS.INVERTER.FAULT_PERMANENT;
    const severity = isPermanent ? 'permanent' : 'recoverable';
    const guidance = isPermanent ? 'needs attention' : 'typically clears on its own';
    const message = `Inverter fault detected (${severity}) — ${guidance}. Reference code: ${status}.`;

    await publishAlert(message);
    return message;
}

async function publishAlert(message) {
    logInfo('Publishing alert', { message });
    await snsClient.send(new PublishCommand({
        TopicArn: process.env.ALERTS_TOPIC_ARN,
        Subject: 'PowerPlant Alert',
        Message: message
    }));
}

module.exports.checkImportAnomaly = checkImportAnomaly;
module.exports.checkInverterFault = checkInverterFault;
