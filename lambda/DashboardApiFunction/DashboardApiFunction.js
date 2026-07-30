'use strict';

const { logInfo, logError } = require('powerplant-shared');

// TODO: query ENERGY_READINGS_TABLE (DeviceSn + Timestamp range) and aggregate
// into daily/weekly rollups (PV yield, import/export, battery charge/discharge, SOC).

exports.handler = async (event) => {
    logInfo('DashboardApiFunction invoked', { path: event.path });

    try {
        // TODO: read from DynamoDB, aggregate, return rollup
        return response(200, { message: 'Not yet implemented' });
    } catch (err) {
        logError('Dashboard query failed', { error: err.message });
        return response(500, { message: 'Internal server error' });
    }
};

function response(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}
