'use strict';

const mockSnsSend = jest.fn();
const mockDynamoSend = jest.fn();
const mockBedrockSend = jest.fn();

// These only live in lambda/SettingsOptimizerFunction/node_modules (per-function
// deps), not the root node_modules test/ resolves from — virtual: true skips
// module resolution instead of erroring.
jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: jest.fn().mockImplementation(() => ({ send: (...args) => mockSnsSend(...args) })),
    PublishCommand: jest.fn().mockImplementation(input => ({ input }))
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({}))
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn().mockImplementation(() => ({ send: (...args) => mockDynamoSend(...args) })) },
    PutCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Put' })),
    GetCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Get' })),
    QueryCommand: jest.fn().mockImplementation(input => ({ input, __type: 'Query' }))
}), { virtual: true });

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...args) => mockBedrockSend(...args) })),
    InvokeModelCommand: jest.fn().mockImplementation(input => ({ input }))
}), { virtual: true });

jest.mock('powerplant-shared', () => ({
    logInfo: jest.fn(),
    logError: jest.fn()
}), { virtual: true });

const BASE_CONFIG = {
    enabled: true,
    autoApply: false,
    lookbackDays: 7,
    minSampleSize: 3,
    maxAdjustmentPercent: 15,
    batteryControlDefaults: { chargeUpperSocSunny: 40, chargeUpperSocOvercast: 100 },
    gridDischargeDefaults: { fallbackReservePercent: 26, safetyMarginPercent: 10 }
};

function bedrockTextResponse(text) {
    return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text }] })) };
}

function validAiResponseText(overrides = {}) {
    return JSON.stringify({
        chargeUpperSocSunny: null,
        chargeUpperSocOvercast: null,
        gridDischargeFallbackReservePercent: null,
        gridDischargeSafetyMarginPercent: null,
        reasoning: 'Not enough evidence yet to recommend a change.',
        confidence: 'low',
        ...overrides
    });
}

describe('SettingsOptimizerFunction', () => {
    let summarizeBatteryControlHistory, summarizeGridDischargeHistory, parseOptimizationRecommendation,
        buildRecommendations, buildOptimizationRecord, STATUS_RECORD_PREFIX, BATTERY_SETTINGS_PREFIX,
        GRID_DISCHARGE_SETTINGS_PREFIX, handler;

    function findPutCalls() {
        return mockDynamoSend.mock.calls.map(call => call[0]).filter(cmd => cmd.__type === 'Put');
    }

    beforeEach(() => {
        jest.resetModules();
        mockSnsSend.mockReset().mockResolvedValue({});
        mockDynamoSend.mockReset().mockImplementation(command => {
            if (command.__type === 'Query') return Promise.resolve({ Items: [] });
            if (command.__type === 'Get') return Promise.resolve({});
            return Promise.resolve({});
        });
        mockBedrockSend.mockReset().mockResolvedValue(bedrockTextResponse(validAiResponseText()));

        process.env.ENERGY_READINGS_TABLE = 'POWERPLANT-ENERGY-READINGS';
        process.env.SOLAX_INVERTER_SN = 'H34ABCDEFG5001';
        process.env.REPORTS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:reports';
        process.env.ALERTS_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:123456789012:alerts';
        process.env.BEDROCK_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
        process.env.SETTINGS_OPTIMIZER_CONFIG = JSON.stringify(BASE_CONFIG);

        ({
            summarizeBatteryControlHistory, summarizeGridDischargeHistory, parseOptimizationRecommendation,
            buildRecommendations, buildOptimizationRecord, STATUS_RECORD_PREFIX, BATTERY_SETTINGS_PREFIX,
            GRID_DISCHARGE_SETTINGS_PREFIX, handler
        } = require('../lambda/SettingsOptimizerFunction/SettingsOptimizerFunction'));
    });

    describe('summarizeBatteryControlHistory', () => {
        test('groups records by classification and tallies previousAssessment accuracy', () => {
            const summary = summarizeBatteryControlHistory([
                { classification: 'sunny', previousAssessment: { accurate: true, usageShouldInfluence: false } },
                { classification: 'sunny', previousAssessment: { accurate: false, usageShouldInfluence: true, usageNote: 'ran flat overnight' } },
                { classification: 'sunny' }, // no previousAssessment yet (first-ever run)
                { classification: 'overcast', previousAssessment: { accurate: true, usageShouldInfluence: false } }
            ]);

            expect(summary.sunny.nights).toBe(3);
            expect(summary.sunny.accurate).toBe(1);
            expect(summary.sunny.inaccurate).toBe(1);
            expect(summary.sunny.usageNotes).toEqual(['ran flat overnight']);
            expect(summary.overcast.nights).toBe(1);
            expect(summary.overcast.accurate).toBe(1);
        });

        test('ignores disabled-classification records', () => {
            const summary = summarizeBatteryControlHistory([{ classification: 'disabled' }]);
            expect(summary.disabled).toBeUndefined();
            expect(Object.keys(summary)).toHaveLength(0);
        });
    });

    describe('summarizeGridDischargeHistory', () => {
        test('aggregates start-phase records and counts import-triggered early exits', () => {
            const summary = summarizeGridDischargeHistory([
                { phase: 'start', enabled: true, surplusPercent: 20, shoulderNightReservePercent: 12 },
                { phase: 'start', enabled: true, surplusPercent: 0, shoulderNightReservePercent: 8 },
                { phase: 'start', enabled: false, surplusPercent: 15, shoulderNightReservePercent: 30 }, // disabled run, excluded
                { phase: 'check', applied: true, dryRun: false, reasoning: 'Grid import detected (0.30 kWh) since the discharge window opened.' },
                { phase: 'exit', applied: true, dryRun: false, reasoning: 'Exited VPP mode — inverter returned to its normal Self Use schedule.' }
            ]);

            expect(summary.totalNights).toBe(2);
            expect(summary.nightsWithSurplus).toBe(1);
            expect(summary.shoulderNightReserves).toEqual([12, 8]);
            expect(summary.earlyExitDueToImportCount).toBe(1);
        });
    });

    describe('parseOptimizationRecommendation', () => {
        test('parses a well-formed response', () => {
            const parsed = parseOptimizationRecommendation(validAiResponseText({
                chargeUpperSocSunny: 45, confidence: 'medium', reasoning: 'Sunny nights ran flat twice.'
            }));
            expect(parsed.chargeUpperSocSunny).toBe(45);
            expect(parsed.chargeUpperSocOvercast).toBeNull();
            expect(parsed.confidence).toBe('medium');
        });

        test('returns null when the response has no JSON object', () => {
            expect(parseOptimizationRecommendation('sorry, I cannot help with that')).toBeNull();
        });

        test('returns null when confidence is missing or invalid', () => {
            expect(parseOptimizationRecommendation(JSON.stringify({ reasoning: 'x', confidence: 'very-high' }))).toBeNull();
        });
    });

    describe('buildRecommendations', () => {
        const currentValues = {
            chargeUpperSocSunny: 40, chargeUpperSocOvercast: 100,
            gridDischargeFallbackReservePercent: 26, gridDischargeSafetyMarginPercent: 10
        };
        const batterySummary = { sunny: { nights: 5 }, overcast: { nights: 1 } };
        const gridSummary = { shoulderNightReserves: [10, 12, 15, 9] }; // 4 sample nights

        test('holds the current value when the AI recommends null', () => {
            const aiRecommendation = {
                chargeUpperSocSunny: null, chargeUpperSocOvercast: null,
                gridDischargeFallbackReservePercent: null, gridDischargeSafetyMarginPercent: null
            };
            const result = buildRecommendations({
                currentValues, batterySummary, gridSummary, aiRecommendation, minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocSunny.recommended).toBeNull();
            expect(result.gridDischargeFallbackReservePercent.recommended).toBeNull();
        });

        test('holds the current value when sample size is below minSampleSize, even with an AI recommendation', () => {
            const aiRecommendation = {
                chargeUpperSocSunny: 50, chargeUpperSocOvercast: null,
                gridDischargeFallbackReservePercent: null, gridDischargeSafetyMarginPercent: null
            };
            // overcast has only 1 sample night < minSampleSize(3)
            const aiRecommendationOvercast = { ...aiRecommendation, chargeUpperSocOvercast: 90, chargeUpperSocSunny: null };
            const result = buildRecommendations({
                currentValues, batterySummary, gridSummary, aiRecommendation: aiRecommendationOvercast,
                minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocOvercast.recommended).toBeNull();
            expect(result.chargeUpperSocOvercast.reason).toBe('insufficient sample size');
        });

        test('applies a recommendation within the max-adjustment bound as-is', () => {
            const aiRecommendation = {
                chargeUpperSocSunny: 50, chargeUpperSocOvercast: null,
                gridDischargeFallbackReservePercent: null, gridDischargeSafetyMarginPercent: null
            };
            const result = buildRecommendations({
                currentValues, batterySummary, gridSummary, aiRecommendation, minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocSunny.recommended).toBe(50);
            expect(result.chargeUpperSocSunny.clamped).toBe(false);
        });

        test('clamps a recommendation that exceeds maxAdjustmentPercent from the current value', () => {
            const aiRecommendation = {
                chargeUpperSocSunny: 90, chargeUpperSocOvercast: null, // 90 is 50 points above current(40), way past a 15-point bound
                gridDischargeFallbackReservePercent: null, gridDischargeSafetyMarginPercent: null
            };
            const result = buildRecommendations({
                currentValues, batterySummary, gridSummary, aiRecommendation, minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocSunny.recommended).toBe(55); // 40 + 15
            expect(result.chargeUpperSocSunny.clamped).toBe(true);
        });

        test('never recommends outside the 0-100 range', () => {
            const aiRecommendation = {
                chargeUpperSocSunny: null, chargeUpperSocOvercast: null,
                gridDischargeFallbackReservePercent: -10, gridDischargeSafetyMarginPercent: null
            };
            const lowCurrentValues = { ...currentValues, gridDischargeFallbackReservePercent: 5 };
            const result = buildRecommendations({
                currentValues: lowCurrentValues, batterySummary, gridSummary, aiRecommendation,
                minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.gridDischargeFallbackReservePercent.recommended).toBe(0);
        });

        test('grid-discharge values use shoulderNightReserves.length as the sample size for both settings', () => {
            const aiRecommendation = {
                chargeUpperSocSunny: null, chargeUpperSocOvercast: null,
                gridDischargeFallbackReservePercent: 30, gridDischargeSafetyMarginPercent: 12
            };
            const result = buildRecommendations({
                currentValues, batterySummary, gridSummary, aiRecommendation, minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.gridDischargeFallbackReservePercent.sampleSize).toBe(4);
            expect(result.gridDischargeSafetyMarginPercent.sampleSize).toBe(4);
        });
    });

    describe('buildOptimizationRecord', () => {
        test('prefixes DeviceSn with STATUS_RECORD_PREFIX so it cannot collide with a real device serial', () => {
            const record = buildOptimizationRecord('H34ABCDEFG5001', 1785400000, {
                recommendations: { chargeUpperSocSunny: { current: 40, recommended: null } },
                aiRecommendation: { confidence: 'low' },
                applied: false, autoApply: false, reasoning: 'test'
            });
            expect(record.DeviceSn).toBe(`${STATUS_RECORD_PREFIX}H34ABCDEFG5001`);
            expect(record.Timestamp).toBe(1785400000);
            expect(record.confidence).toBe('low');
            expect(record.applied).toBe(false);
        });
    });

    describe('handler', () => {
        test('skips entirely when no Bedrock model is configured', async () => {
            delete process.env.BEDROCK_MODEL_ID;
            ({ handler } = require('../lambda/SettingsOptimizerFunction/SettingsOptimizerFunction'));

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockBedrockSend).not.toHaveBeenCalled();
            expect(mockDynamoSend).not.toHaveBeenCalled();
            expect(mockSnsSend).not.toHaveBeenCalled();
        });

        test('skips when config.enabled is false', async () => {
            process.env.SETTINGS_OPTIMIZER_CONFIG = JSON.stringify({ ...BASE_CONFIG, enabled: false });
            ({ handler } = require('../lambda/SettingsOptimizerFunction/SettingsOptimizerFunction'));

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(mockBedrockSend).not.toHaveBeenCalled();
        });

        test('recommendation-only run: computes and emails, but never writes settings-override rows', async () => {
            mockBedrockSend.mockResolvedValue(bedrockTextResponse(validAiResponseText({
                chargeUpperSocSunny: 45, confidence: 'medium', reasoning: 'Sunny nights ran flat.'
            })));
            // 3+ nights of sunny history so minSampleSize is met
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') return Promise.resolve({});
                if (command.__type !== 'Query') return Promise.resolve({});
                if (command.input.ExpressionAttributeValues[':sn'].startsWith('BATTERY_CONTROL#')) {
                    return Promise.resolve({
                        Items: [
                            { classification: 'sunny', previousAssessment: { accurate: false } },
                            { classification: 'sunny', previousAssessment: { accurate: false } },
                            { classification: 'sunny', previousAssessment: { accurate: true } }
                        ]
                    });
                }
                return Promise.resolve({ Items: [] });
            });

            const result = await handler();

            expect(result.statusCode).toBe(200);
            expect(findPutCalls().filter(c => c.input.Item.DeviceSn.includes('SETTINGS#'))).toHaveLength(0);

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Message).toContain('recommendation only, not applied');
            expect(publishCall.input.Message).toContain('chargeUpperSocSunny: 40 -> 45');

            const statusPut = findPutCalls().find(c => c.input.Item.DeviceSn.startsWith(STATUS_RECORD_PREFIX));
            expect(statusPut.input.Item.applied).toBe(false);
        });

        test('autoApply run: writes the recommended value into the battery settings override, preserving existing fields', async () => {
            process.env.SETTINGS_OPTIMIZER_CONFIG = JSON.stringify({ ...BASE_CONFIG, autoApply: true });
            mockBedrockSend.mockResolvedValue(bedrockTextResponse(validAiResponseText({
                chargeUpperSocSunny: 45, confidence: 'high', reasoning: 'Consistently ran flat on sunny nights.'
            })));
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get' && command.input.Key.DeviceSn === `${BATTERY_SETTINGS_PREFIX}H34ABCDEFG5001`) {
                    return Promise.resolve({ Item: { enabled: false, chargeUpperSocOvercast: 100 } }); // human-set toggle, must survive
                }
                if (command.__type === 'Get') return Promise.resolve({});
                if (command.__type !== 'Query') return Promise.resolve({});
                if (command.input.ExpressionAttributeValues[':sn'].startsWith('BATTERY_CONTROL#')) {
                    return Promise.resolve({
                        Items: [
                            { classification: 'sunny', previousAssessment: { accurate: false } },
                            { classification: 'sunny', previousAssessment: { accurate: false } },
                            { classification: 'sunny', previousAssessment: { accurate: false } }
                        ]
                    });
                }
                return Promise.resolve({ Items: [] });
            });
            ({ handler } = require('../lambda/SettingsOptimizerFunction/SettingsOptimizerFunction'));

            const result = await handler();

            expect(result.statusCode).toBe(200);
            const batteryPut = findPutCalls().find(c => c.input.Item.DeviceSn === `${BATTERY_SETTINGS_PREFIX}H34ABCDEFG5001`);
            expect(batteryPut).toBeDefined();
            expect(batteryPut.input.Item.chargeUpperSocSunny).toBe(45);
            expect(batteryPut.input.Item.enabled).toBe(false); // preserved from the existing override
            expect(batteryPut.input.Item.chargeUpperSocOvercast).toBe(100); // preserved

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('applied');
        });

        test('failure: a Bedrock error publishes to the alerts topic and rethrows', async () => {
            mockBedrockSend.mockRejectedValue(new Error('Bedrock unavailable'));

            await expect(handler()).rejects.toThrow('Bedrock unavailable');

            const alertCall = mockSnsSend.mock.calls.find(call => call[0].input.TopicArn === process.env.ALERTS_TOPIC_ARN);
            expect(alertCall).toBeDefined();
            expect(alertCall[0].input.Subject).toContain('FAILED');
        });
    });
});
