'use strict';

const { logInfo } = require('powerplant-shared');

// TODO: inspect each new reading's deviceStatus (solax-apis.md §4.4, Appendix 6 —
// not included in that doc, so the fault-code meanings are still unconfirmed) or
// unusually high daytime import, then publish a notification via SNS
// (ALERTS_TOPIC_ARN) using @aws-sdk/client-sns. getAlarmInfo (powerplant-shared)
// is a structured alternative once a plantId is on hand, but requires its own
// poll since it's not part of the per-reading DynamoDB Stream payload.

exports.handler = async (event) => {
    logInfo('AlertFunction invoked', { recordCount: event.Records?.length ?? 0 });

    for (const record of event.Records || []) {
        if (record.eventName !== 'INSERT') continue;
        // TODO: evaluate record.dynamodb.NewImage against fault/anomaly rules
    }

    return { statusCode: 200 };
};
