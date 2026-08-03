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
    batteryControlDefaults: { chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 70, chargeUpperSocOvercast: 100 }
};

function bedrockTextResponse(text) {
    return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text }] })) };
}

function validAiResponseText(overrides = {}) {
    return JSON.stringify({
        chargeUpperSocSunny: null,
        chargeUpperSocPartlyCloudy: null,
        chargeUpperSocOvercast: null,
        reasoning: 'Not enough evidence yet to recommend a change.',
        confidence: 'low',
        ...overrides
    });
}

describe('SettingsOptimizerFunction', () => {
    let summarizeBatteryControlHistory, parseOptimizationRecommendation,
        buildRecommendations, buildOptimizationRecord, STATUS_RECORD_PREFIX, BATTERY_SETTINGS_PREFIX,
        SETTINGS_OPTIMIZER_SETTINGS_PREFIX, handler;

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
            summarizeBatteryControlHistory, parseOptimizationRecommendation,
            buildRecommendations, buildOptimizationRecord, STATUS_RECORD_PREFIX, BATTERY_SETTINGS_PREFIX,
            SETTINGS_OPTIMIZER_SETTINGS_PREFIX, handler
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

        test('groups partly-cloudy records too, not just sunny/overcast', () => {
            const summary = summarizeBatteryControlHistory([
                { classification: 'partly-cloudy', previousAssessment: { accurate: false, usageShouldInfluence: false } },
                { classification: 'partly-cloudy', previousAssessment: { accurate: true, usageShouldInfluence: false } }
            ]);

            expect(summary['partly-cloudy'].nights).toBe(2);
            expect(summary['partly-cloudy'].accurate).toBe(1);
            expect(summary['partly-cloudy'].inaccurate).toBe(1);
        });

        test('ignores disabled-classification records', () => {
            const summary = summarizeBatteryControlHistory([{ classification: 'disabled' }]);
            expect(summary.disabled).toBeUndefined();
            expect(Object.keys(summary)).toHaveLength(0);
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
        const currentValues = { chargeUpperSocSunny: 40, chargeUpperSocPartlyCloudy: 70, chargeUpperSocOvercast: 100 };
        const batterySummary = { sunny: { nights: 5 }, 'partly-cloudy': { nights: 4 }, overcast: { nights: 1 } };

        test('holds the current value when the AI recommends null', () => {
            const aiRecommendation = { chargeUpperSocSunny: null, chargeUpperSocPartlyCloudy: null, chargeUpperSocOvercast: null };
            const result = buildRecommendations({
                currentValues, batterySummary, aiRecommendation, minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocSunny.recommended).toBeNull();
            expect(result.chargeUpperSocPartlyCloudy.recommended).toBeNull();
        });

        test('applies a chargeUpperSocPartlyCloudy recommendation, sample-sized from the partly-cloudy classification count', () => {
            const aiRecommendation = { chargeUpperSocSunny: null, chargeUpperSocPartlyCloudy: 65, chargeUpperSocOvercast: null };
            const result = buildRecommendations({
                currentValues, batterySummary, aiRecommendation, minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocPartlyCloudy.recommended).toBe(65);
            expect(result.chargeUpperSocPartlyCloudy.sampleSize).toBe(4);
        });

        test('holds chargeUpperSocPartlyCloudy when its sample size is below minSampleSize', () => {
            const thinBatterySummary = { ...batterySummary, 'partly-cloudy': { nights: 2 } };
            const aiRecommendation = { chargeUpperSocSunny: null, chargeUpperSocPartlyCloudy: 65, chargeUpperSocOvercast: null };
            const result = buildRecommendations({
                currentValues, batterySummary: thinBatterySummary, aiRecommendation,
                minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocPartlyCloudy.recommended).toBeNull();
            expect(result.chargeUpperSocPartlyCloudy.reason).toBe('insufficient sample size');
        });

        test('holds the current value when sample size is below minSampleSize, even with an AI recommendation', () => {
            // overcast has only 1 sample night < minSampleSize(3)
            const aiRecommendationOvercast = { chargeUpperSocSunny: null, chargeUpperSocPartlyCloudy: null, chargeUpperSocOvercast: 90 };
            const result = buildRecommendations({
                currentValues, batterySummary, aiRecommendation: aiRecommendationOvercast,
                minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocOvercast.recommended).toBeNull();
            expect(result.chargeUpperSocOvercast.reason).toBe('insufficient sample size');
        });

        test('applies a recommendation within the max-adjustment bound as-is', () => {
            const aiRecommendation = { chargeUpperSocSunny: 50, chargeUpperSocPartlyCloudy: null, chargeUpperSocOvercast: null };
            const result = buildRecommendations({
                currentValues, batterySummary, aiRecommendation, minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocSunny.recommended).toBe(50);
            expect(result.chargeUpperSocSunny.clamped).toBe(false);
        });

        test('clamps a recommendation that exceeds maxAdjustmentPercent from the current value', () => {
            // 90 is 50 points above current(40), way past a 15-point bound
            const aiRecommendation = { chargeUpperSocSunny: 90, chargeUpperSocPartlyCloudy: null, chargeUpperSocOvercast: null };
            const result = buildRecommendations({
                currentValues, batterySummary, aiRecommendation, minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocSunny.recommended).toBe(55); // 40 + 15
            expect(result.chargeUpperSocSunny.clamped).toBe(true);
        });

        test('never recommends outside the 0-100 range', () => {
            const aiRecommendation = { chargeUpperSocSunny: -10, chargeUpperSocPartlyCloudy: null, chargeUpperSocOvercast: null };
            const lowCurrentValues = { ...currentValues, chargeUpperSocSunny: 5 };
            const result = buildRecommendations({
                currentValues: lowCurrentValues, batterySummary, aiRecommendation,
                minSampleSize: 3, maxAdjustmentPercent: 15
            });
            expect(result.chargeUpperSocSunny.recommended).toBe(0);
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
            expect(publishCall.input.Message).toContain('recommended, not yet applied');
            expect(publishCall.input.Message).toContain('Overnight charge target (sunny forecast): 40% -> 45%');

            const statusPut = findPutCalls().find(c => c.input.Item.DeviceSn.startsWith(STATUS_RECORD_PREFIX));
            expect(statusPut.input.Item.applied).toBe(false);
        });

        test('a dashboard-saved autoApply: true override applies the recommendation even though config.autoApply is false', async () => {
            // BASE_CONFIG.autoApply is false — this proves the dashboard override,
            // not the config default, is what's actually driving the apply here.
            mockBedrockSend.mockResolvedValue(bedrockTextResponse(validAiResponseText({
                chargeUpperSocSunny: 45, confidence: 'high', reasoning: 'Consistently ran flat on sunny nights.'
            })));
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get' && command.input.Key.DeviceSn === `${SETTINGS_OPTIMIZER_SETTINGS_PREFIX}H34ABCDEFG5001`) {
                    return Promise.resolve({ Item: { autoApply: true } });
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

            const result = await handler();

            expect(result.statusCode).toBe(200);
            const batteryPut = findPutCalls().find(c => c.input.Item.DeviceSn === `${BATTERY_SETTINGS_PREFIX}H34ABCDEFG5001`);
            expect(batteryPut).toBeDefined();
            expect(batteryPut.input.Item.chargeUpperSocSunny).toBe(45);

            const statusPut = findPutCalls().find(c => c.input.Item.DeviceSn.startsWith(STATUS_RECORD_PREFIX));
            expect(statusPut.input.Item.applied).toBe(true);
            expect(statusPut.input.Item.autoApply).toBe(true);
        });

        test('a dashboard-saved autoApply: false override holds back application even when config.autoApply is true', async () => {
            process.env.SETTINGS_OPTIMIZER_CONFIG = JSON.stringify({ ...BASE_CONFIG, autoApply: true });
            mockBedrockSend.mockResolvedValue(bedrockTextResponse(validAiResponseText({
                chargeUpperSocSunny: 45, confidence: 'high', reasoning: 'Consistently ran flat on sunny nights.'
            })));
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get' && command.input.Key.DeviceSn === `${SETTINGS_OPTIMIZER_SETTINGS_PREFIX}H34ABCDEFG5001`) {
                    return Promise.resolve({ Item: { autoApply: false } });
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
            expect(findPutCalls().filter(c => c.input.Item.DeviceSn.includes('SETTINGS#'))).toHaveLength(0);

            const statusPut = findPutCalls().find(c => c.input.Item.DeviceSn.startsWith(STATUS_RECORD_PREFIX));
            expect(statusPut.input.Item.applied).toBe(false);
            expect(statusPut.input.Item.autoApply).toBe(false);
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
            expect(batteryPut.input.Item.sources.chargeUpperSocSunny).toBe('settings-optimizer');

            const publishCall = mockSnsSend.mock.calls[0][0];
            expect(publishCall.input.Subject).toContain('applied');
        });

        test('autoApply run: preserves an existing sources entry for a field it did not touch this run', async () => {
            process.env.SETTINGS_OPTIMIZER_CONFIG = JSON.stringify({ ...BASE_CONFIG, autoApply: true });
            mockBedrockSend.mockResolvedValue(bedrockTextResponse(validAiResponseText({
                chargeUpperSocSunny: 45, confidence: 'high', reasoning: 'Consistently ran flat on sunny nights.'
            })));
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get' && command.input.Key.DeviceSn === `${BATTERY_SETTINGS_PREFIX}H34ABCDEFG5001`) {
                    // chargeUpperSocOvercast was previously human-set via the dashboard —
                    // this run only recommends a change to chargeUpperSocSunny.
                    return Promise.resolve({
                        Item: { enabled: true, chargeUpperSocOvercast: 100, sources: { chargeUpperSocOvercast: 'dashboard' } }
                    });
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

            await handler();

            const batteryPut = findPutCalls().find(c => c.input.Item.DeviceSn === `${BATTERY_SETTINGS_PREFIX}H34ABCDEFG5001`);
            expect(batteryPut.input.Item.sources.chargeUpperSocSunny).toBe('settings-optimizer');
            expect(batteryPut.input.Item.sources.chargeUpperSocOvercast).toBe('dashboard'); // untouched this run, preserved
        });

        test('autoApply run: also writes a recommended chargeUpperSocPartlyCloudy value, sample-sized from partly-cloudy nights', async () => {
            process.env.SETTINGS_OPTIMIZER_CONFIG = JSON.stringify({ ...BASE_CONFIG, autoApply: true });
            mockBedrockSend.mockResolvedValue(bedrockTextResponse(validAiResponseText({
                chargeUpperSocPartlyCloudy: 60, confidence: 'high', reasoning: 'Partly-cloudy nights consistently needed less than the full target.'
            })));
            mockDynamoSend.mockImplementation(command => {
                if (command.__type === 'Get') return Promise.resolve({});
                if (command.__type !== 'Query') return Promise.resolve({});
                if (command.input.ExpressionAttributeValues[':sn'].startsWith('BATTERY_CONTROL#')) {
                    return Promise.resolve({
                        Items: [
                            { classification: 'partly-cloudy', previousAssessment: { accurate: false } },
                            { classification: 'partly-cloudy', previousAssessment: { accurate: false } },
                            { classification: 'partly-cloudy', previousAssessment: { accurate: true } }
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
            expect(batteryPut.input.Item.chargeUpperSocPartlyCloudy).toBe(60);
            expect(batteryPut.input.Item.sources.chargeUpperSocPartlyCloudy).toBe('settings-optimizer');
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
