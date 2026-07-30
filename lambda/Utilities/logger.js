'use strict';

/**
 * Centralised Logger — shared across all Lambda functions.
 *
 * Usage:
 *   const { logInfo, logError, logDebug, logWarn } = require('powerplant-shared');
 *
 * Set LOG_LEVEL env var: ERROR | WARN | INFO | DEBUG  (default: INFO)
 */

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.INFO;

function redactToken(token) {
    if (!token || typeof token !== 'string') return '[NO_TOKEN]';
    return token.length <= 8 ? '***' : `${token.slice(0, 8)}***`;
}

function fmt(level, message, data) {
    return JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data });
}

function shouldLog(level) { return level <= CURRENT_LOG_LEVEL; }

function logError(message, data = {}) {
    if (!shouldLog(LOG_LEVELS.ERROR)) return;
    console.error(fmt('ERROR', message, data));
}

function logWarn(message, data = {}) {
    if (!shouldLog(LOG_LEVELS.WARN)) return;
    const s = { ...data };
    if (s.token) s.token = redactToken(s.token);
    console.warn(fmt('WARN', message, s));
}

function logInfo(message, data = {}) {
    if (!shouldLog(LOG_LEVELS.INFO)) return;
    const s = { ...data };
    if (s.token) s.token = redactToken(s.token);
    console.log(fmt('INFO', message, s));
}

function logDebug(message, data = {}) {
    if (!shouldLog(LOG_LEVELS.DEBUG)) return;
    const s = { ...data };
    if (s.token) s.token = redactToken(s.token);
    console.log(fmt('DEBUG', message, s));
}

module.exports = { logError, logWarn, logInfo, logDebug, redactToken };
