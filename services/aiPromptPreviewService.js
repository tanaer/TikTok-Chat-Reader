const {
    getPromptTemplate,
    getPromptTemplateDefinition,
    renderPromptTemplate
} = require('./aiPromptService');
const { buildCustomerContext } = require('./aiContextService');
const {
    listAiStructuredDataSources,
    resolveAiStructuredDataSource,
    injectMissingStructuredDataTokens
} = require('./aiStructuredDataSourceService');

const PROMPT_TEMPLATE_PREVIEW_PRESETS = Object.freeze({
    session_recap_comment_filter: {
        input: {},
        variables: {
            topCommentCandidatesJson: [
                { text: '这个多少钱', count: 18, roomId: 'demo_room' },
                { text: '主播今天状态很好', count: 9, roomId: 'demo_room' },
                { text: '福袋中中中', count: 28, roomId: 'demo_room' }
            ]
        }
    },
    session_recap_review: {
        input: {
            roomId: '',
            sessionId: 'live'
        },
        variables: {
            sessionDataJson: {
                roomId: 'demo_room',
                sessionId: 'live',
                metrics: {
                    durationSeconds: 21600,
                    totalGiftValue: 58200,
                    totalComments: 468,
                    totalLikes: 12340,
                    participantCount: 186,
                    payingUsers: 14
                },
                valuableComments: [
                    { text: '这个价位还能再讲一下吗', count: 12, reason: '集中反映价格异议', insight: '成交门槛还没打透' }
                ],
                coreCustomers: [
                    { nickname: 'Demo A', uniqueId: 'demo_a', totalGiftValue: 8800, giftCount: 6, historicalValue: 35200 }
                ],
                potentialCustomers: [
                    { nickname: 'Demo B', uniqueId: 'demo_b', totalGiftValue: 0, giftCount: 0, historicalValue: 9200, chatCount: 32 }
                ],
                riskCustomers: [
                    { nickname: 'Demo C', uniqueId: 'demo_c', totalGiftValue: 0, giftCount: 0, historicalValue: 40600, chatCount: 3 }
                ]
            },
            sessionRecapScoreBenchmarkJson: {
                durationHours: 6,
                totalGiftValue: 58200,
                giftPassLineValue: 64000,
                completionRatio: 0.9094,
                passStatus: '接近及格',
                benchmarkRule: '按 6 小时收礼 64,000 钻作为单场及格线，并按本场时长等比例折算。'
            },
            sessionRecapNewAttentionCustomersJson: {
                count: 1,
                ruleText: '若用户在本场送出 Heart Me，且开播前历史上从未送过 Heart Me，则记为本场新增关注信号。',
                customers: [
                    { nickname: 'Demo New', uniqueId: 'demo_new', giftCount: 1, giftValue: 199 }
                ]
            }
        }
    },
    customer_analysis_review: {
        input: {
            userId: '',
            roomId: ''
        },
        variables: {
            customerContextJson: {
                identity: {
                    userId: 'demo_user',
                    nickname: 'Demo客户',
                    uniqueId: 'demo_customer'
                },
                scope: {
                    currentRoom: {
                        roomId: 'demo_room',
                        roomName: 'Demo房间'
                    }
                },
                models: {
                    room_lrfm: { scoreLabel: 'L3R5F5M4', tier: '高价值' },
                    platform_lrfm: { scoreLabel: 'L4R5F5M5', tier: '核心价值' },
                    clv_current_room_30d: { value: 12888 },
                    abc_current_room: { tier: 'A' }
                },
                signals: {
                    currentRoomValueShare30d: 0.61,
                    otherRoomGrowthFlag: true,
                    giftTrend7dVsPrev7d: 0.28,
                    watchTrend7dVsPrev7d: -0.12
                },
                corpus: {
                    recentChatMessages: ['今天状态不错', '这个我挺喜欢', '晚点我再回来']
                }
            },
            chatCorpusText: '今天状态不错\n这个我挺喜欢\n晚点我再回来'
        }
    },
    user_personality_analysis: {
        input: {},
        variables: {
            chatCorpusText: '今天状态不错\n这个价位可以再讲讲吗\n我比较喜欢轻松一点的聊天节奏'
        }
    }
});

function safeTrimString(value, maxLength = 500) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizePlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
}

function formatPromptVariableValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function normalizeVariablesMap(value) {
    const source = normalizePlainObject(value);
    return Object.entries(source).reduce((acc, [key, rawValue]) => {
        const normalizedKey = safeTrimString(key, 120);
        if (!normalizedKey) return acc;
        acc[normalizedKey] = formatPromptVariableValue(rawValue);
        return acc;
    }, {});
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function hasRequiredPreviewInput(definition = {}, input = {}) {
    const requiredKeys = Array.isArray(definition?.inputSchema?.required) ? definition.inputSchema.required : [];
    return requiredKeys.every((key) => {
        const value = input?.[key];
        if (typeof value === 'string') return safeTrimString(value).length > 0;
        return value != null;
    });
}

function extractPromptTokens(content = '') {
    const matches = String(content || '').match(/{{\s*([a-zA-Z0-9_]+)\s*}}/g) || [];
    return [...new Set(matches
        .map(item => item.replace(/[{}]/g, '').trim())
        .filter(Boolean))];
}

function detectAutoAppendedTokens(originalContent = '', effectiveContent = '') {
    const before = new Set(extractPromptTokens(originalContent));
    return extractPromptTokens(effectiveContent).filter(token => !before.has(token));
}

async function buildDerivedPreviewVariables(templateKey, input = {}, manualVariables = {}) {
    const normalizedInput = normalizePlainObject(input);
    const derivedContext = { ...normalizedInput };
    const derivedVariables = {};

    if (templateKey === 'customer_analysis_review' && safeTrimString(normalizedInput.userId, 120)) {
        const customerContextPayload = await buildCustomerContext({
            userId: safeTrimString(normalizedInput.userId, 120),
            roomId: safeTrimString(normalizedInput.roomId, 120) || null,
            roomFilter: null,
            now: new Date()
        });
        derivedContext.customerContextPayload = customerContextPayload;
        if (!hasOwn(manualVariables, 'chatCorpusText')) {
            derivedVariables.chatCorpusText = formatPromptVariableValue(customerContextPayload.chatCorpusText || '');
        }
    }

    if (templateKey === 'user_personality_analysis' && !hasOwn(manualVariables, 'chatCorpusText')) {
        const chatCorpusText = safeTrimString(normalizedInput.chatCorpusText, 30000);
        if (chatCorpusText) {
            derivedVariables.chatCorpusText = chatCorpusText;
        }
    }

    return { derivedContext, derivedVariables };
}

async function resolveStructuredPreviewVariables(scene, context = {}, manualVariables = {}) {
    const resolvedVariables = {};
    const resolvedSources = [];
    const skippedSources = [];
    const runtime = {};
    const definitions = listAiStructuredDataSources({ scene });

    for (const definition of definitions) {
        if (hasOwn(manualVariables, definition.token)) {
            skippedSources.push({
                key: definition.key,
                token: definition.token,
                reason: '已使用手动变量覆盖'
            });
            continue;
        }

        if (!hasRequiredPreviewInput(definition, context)) {
            skippedSources.push({
                key: definition.key,
                token: definition.token,
                reason: `缺少必填输入：${(definition.inputSchema?.required || []).join('、') || '无'}`
            });
            continue;
        }

        const result = await resolveAiStructuredDataSource(definition.key, { context, runtime });
        resolvedVariables[definition.token] = result.renderedValue;
        resolvedSources.push({
            key: definition.key,
            token: definition.token,
            title: definition.title || definition.key
        });
    }

    return {
        resolvedVariables,
        resolvedSources,
        skippedSources
    };
}

function getPromptTemplatePreviewPreset(templateKey) {
    return PROMPT_TEMPLATE_PREVIEW_PRESETS[templateKey] || {
        input: {},
        variables: {}
    };
}

async function renderAdminPromptPreview({ templateKey, content = '', input = {}, variables = {} } = {}) {
    const definition = getPromptTemplateDefinition(templateKey);
    if (!definition) {
        throw new Error('提示词不存在');
    }

    const template = await getPromptTemplate(templateKey);
    const rawContent = typeof content === 'string' && content.trim()
        ? content
        : (template?.content || definition.defaultContent || '');
    const normalizedInput = normalizePlainObject(input);
    const manualVariables = normalizeVariablesMap(variables);
    const { derivedContext, derivedVariables } = await buildDerivedPreviewVariables(templateKey, normalizedInput, manualVariables);
    const effectiveContent = injectMissingStructuredDataTokens({
        scene: templateKey,
        templateContent: rawContent
    });
    const { resolvedVariables, resolvedSources, skippedSources } = await resolveStructuredPreviewVariables(
        templateKey,
        derivedContext,
        manualVariables
    );

    const finalVariables = {
        ...derivedVariables,
        ...resolvedVariables,
        ...manualVariables
    };
    const renderedPrompt = renderPromptTemplate(effectiveContent, finalVariables);
    const unresolvedTokens = extractPromptTokens(effectiveContent).filter(token => !hasOwn(finalVariables, token));

    return {
        templateKey,
        rawContent,
        effectiveContent,
        renderedPrompt,
        variables: finalVariables,
        resolvedSources,
        skippedSources,
        unresolvedTokens,
        autoAppendedTokens: detectAutoAppendedTokens(rawContent, effectiveContent),
        promptLength: renderedPrompt.length,
        renderedAt: new Date().toISOString()
    };
}

module.exports = {
    getPromptTemplatePreviewPreset,
    renderAdminPromptPreview
};
