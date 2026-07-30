'use strict';

const { logInfo, logError } = require('powerplant-shared');

// TODO: query ENERGY_READINGS_TABLE for the full retained history, assess usage
// patterns (PV yield, import/export timing, battery charge/discharge, SOC), and
// recommend battery configuration optimizations (e.g. charge window, capacity,
// discharge threshold) against the known tariff structure — see
// PowerPlant_Project_Brief.md. TARIFF_STRUCTURE env var holds the full tariff
// as JSON ({ currency, importRates: [{ label, startTime, endTime, rate }],
// feedInRate }) — both import rates and feedInRate (0.02) are now known, so
// cost/savings can be computed directly. Publish the resulting report to
// REPORTS_TOPIC_ARN.

exports.handler = async (event) => {
    logInfo('ReportFunction invoked', { event });

    try {
        // TODO: read from DynamoDB, assess, build recommendation, publish to SNS
        return { statusCode: 200 };
    } catch (err) {
        logError('Nightly report failed', { error: err.message });
        throw err;
    }
};
