const { getPromptTemplate, renderPromptTemplate } = require('./aiPromptService');
const { buildCustomerContext, CUSTOMER_CONTEXT_VERSION } = require('./aiContextService');

const CUSTOMER_ANALYSIS_PROMPT_KEY = 'customer_analysis_review';

const CUSTOMER_ANALYSIS_SYSTEM_GUARDRAILS = [
    '你是严格的客户分析 JSON 输出器。',
    '结构化上下文是最高优先级事实来源，聊天语料只能补充解释，不能推翻系统结果。',
    '所有数值、时间、排行、模型标签都由系统提供；你不得新增、修改、换算或重命名。',
    '如果引用模型结果，必须直接围绕模型评分、模型分层和系统说明写结论，不要直接抄英文键名。',
    '输出中不要出现 platform_lrfm、room_lrfm、abc_current_room、clv_current_room_30d、otherRoomGrowthFlag、currentRoomValueShare30d 这类英文键名。',
    '如果引用布尔信号，统一写成中文业务描述和“是/否”，不要输出 true/false。',
    '只能输出合法 JSON，不要输出 Markdown、代码块或额外说明。'
].join('\n');

const CUSTOMER_ANALYSIS_TEXT_REPLACEMENTS = [
    ['platform_lrfm', '平台LRFM'],
    ['room_lrfm', '本房LRFM'],
    ['clv_current_room_30d', '近30天本房客户价值'],
    ['abc_current_room', '本房ABC分层'],
    ['currentRoomValueShare30d', '近30天本房贡献占比'],
    ['otherRoomsValueShare30d', '近30天其他房间贡献占比'],
    ['giftTrend7dVsPrev7d', '近7天礼物趋势（较前7天）'],
    ['danmuTrend7dVsPrev7d', '近7天弹幕趋势（较前7天）'],
    ['otherRoomGrowthFlag', '其他房间增长信号'],
    ['currentRoomInactiveDays', '本房未活跃天数'],
    ['platformInactiveDays', '平台未活跃天数'],
    ['onlyWatchNoGiftFlag', '只看未送信号'],
    ['onlyGiftNoChatFlag', '只送不聊信号'],
    ['gift_value', '送礼值'],
    ['danmu_count', '弹幕条数'],
    ['signals', '信号'],
    ['models', '模型'],
    ['corpus', '语料'],
    ['tier', '分层']
];

function localizeCustomerAnalysisText(value) {
    let output = String(value || '').trim();
    if (!output) return '';

    for (const [source, target] of CUSTOMER_ANALYSIS_TEXT_REPLACEMENTS) {
        output = output.split(source).join(target);
    }

    output = output
        .replace(/=\s*true\b/gi, '=是')
        .replace(/=\s*false\b/gi, '=否')
        .replace(/:\s*true\b/gi, '：是')
        .replace(/:\s*false\b/gi, '：否')
        .replace(/\btrue\b/gi, '是')
        .replace(/\bfalse\b/gi, '否');

    return output;
}

function stripMarkdownCodeFence(text) {
    const normalized = String(text || '').trim();
    return normalized
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();
}

function extractJsonCandidate(text) {
    const normalized = stripMarkdownCodeFence(text);
    const firstBrace = normalized.indexOf('{');
    const lastBrace = normalized.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return normalized.slice(firstBrace, lastBrace + 1);
    }
    return normalized;
}

function normalizeStringArray(value, limit = 6) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => localizeCustomerAnalysisText(item))
        .filter(Boolean)
        .slice(0, limit);
}

function normalizeAnalysisPayload(payload = {}) {
    return {
        summary: localizeCustomerAnalysisText(payload.summary || ''),
        valueLevelCurrentRoom: localizeCustomerAnalysisText(payload.valueLevelCurrentRoom || ''),
        valueLevelGlobal: localizeCustomerAnalysisText(payload.valueLevelGlobal || ''),
        loyaltyAssessment: localizeCustomerAnalysisText(payload.loyaltyAssessment || ''),
        diversionRiskAssessment: localizeCustomerAnalysisText(payload.diversionRiskAssessment || ''),
        conversionStage: localizeCustomerAnalysisText(payload.conversionStage || ''),
        keySignals: normalizeStringArray(payload.keySignals, 6),
        recommendedActions: normalizeStringArray(payload.recommendedActions, 6),
        outreachScript: normalizeStringArray(payload.outreachScript, 4),
        forbiddenActions: normalizeStringArray(payload.forbiddenActions, 4),
        tags: normalizeStringArray(payload.tags, 8),
        evidence: normalizeStringArray(payload.evidence, 6)
    };
}

function parseCustomerAnalysisPayload(text) {
    const jsonCandidate = extractJsonCandidate(text);
    const parsed = JSON.parse(jsonCandidate);
    return {
        analysis: normalizeAnalysisPayload(parsed),
        jsonText: JSON.stringify(normalizeAnalysisPayload(parsed), null, 2)
    };
}

function formatCustomerAnalysisResult(analysis = {}) {
    const sections = [];

    if (analysis.summary) {
        sections.push(`客户总结\n${analysis.summary}`);
    }

    const overviewRows = [
        analysis.valueLevelCurrentRoom ? `本房价值：${analysis.valueLevelCurrentRoom}` : '',
        analysis.valueLevelGlobal ? `平台价值：${analysis.valueLevelGlobal}` : '',
        analysis.loyaltyAssessment ? `忠诚判断：${analysis.loyaltyAssessment}` : '',
        analysis.diversionRiskAssessment ? `分流风险：${analysis.diversionRiskAssessment}` : '',
        analysis.conversionStage ? `转化阶段：${analysis.conversionStage}` : ''
    ].filter(Boolean);
    if (overviewRows.length) {
        sections.push(`核心判断\n${overviewRows.join('\n')}`);
    }

    if (analysis.keySignals.length) {
        sections.push(`关键信号\n${analysis.keySignals.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.evidence.length) {
        sections.push(`数据证据\n${analysis.evidence.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.recommendedActions.length) {
        sections.push(`建议动作\n${analysis.recommendedActions.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.outreachScript.length) {
        sections.push(`建议话术\n${analysis.outreachScript.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.forbiddenActions.length) {
        sections.push(`不建议动作\n${analysis.forbiddenActions.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.tags.length) {
        sections.push(`标签\n${analysis.tags.join(' ')}`);
    }

    return sections.join('\n\n').trim() || '未生成有效的客户分析结果';
}

async function prepareCustomerAnalysis({ userId, roomId = null, roomFilter = null, now = new Date() } = {}) {
    const contextPayload = await buildCustomerContext({ userId, roomId, roomFilter, now });
    const template = await getPromptTemplate(CUSTOMER_ANALYSIS_PROMPT_KEY);
    if (!template) {
        throw new Error('客户分析提示词模板不存在');
    }

    const renderedPrompt = renderPromptTemplate(template.content, contextPayload.promptVariables);
    const promptUpdatedAt = template.updatedAt || null;

    return {
        ...contextPayload,
        promptTemplate: template,
        promptKey: CUSTOMER_ANALYSIS_PROMPT_KEY,
        promptUpdatedAt,
        renderedPrompt,
        cacheSignature: {
            promptKey: CUSTOMER_ANALYSIS_PROMPT_KEY,
            promptUpdatedAt,
            contextVersion: CUSTOMER_CONTEXT_VERSION,
            currentRoomId: contextPayload.currentRoomId || null,
            latestActivityAt: contextPayload.latestActivityAt || null
        }
    };
}

async function runCustomerAnalysis({ preparedInput, requestAiChatCompletion, trace = null } = {}) {
    if (!preparedInput) throw new Error('缺少客户分析上下文');
    if (typeof requestAiChatCompletion !== 'function') throw new Error('缺少 AI 调用函数');

    const { completion, modelName, latencyMs } = await requestAiChatCompletion({
        requestLabel: `customer analysis ${preparedInput.customerContext?.identity?.userId || ''}`,
        trace,
        messages: [
            {
                role: 'system',
                content: CUSTOMER_ANALYSIS_SYSTEM_GUARDRAILS
            },
            {
                role: 'user',
                content: preparedInput.renderedPrompt
            }
        ]
    });

    const rawContent = completion?.choices?.[0]?.message?.content?.trim() || '';
    if (!rawContent) {
        throw new Error('AI 响应内容为空');
    }

    const { analysis, jsonText } = parseCustomerAnalysisPayload(rawContent);

    return {
        result: formatCustomerAnalysisResult(analysis),
        analysis,
        resultJsonText: jsonText,
        rawContent,
        modelName,
        modelVersion: modelName || 'unknown',
        latencyMs
    };
}

module.exports = {
    CUSTOMER_ANALYSIS_PROMPT_KEY,
    CUSTOMER_CONTEXT_VERSION,
    prepareCustomerAnalysis,
    runCustomerAnalysis,
    formatCustomerAnalysisResult,
    parseCustomerAnalysisPayload
};
