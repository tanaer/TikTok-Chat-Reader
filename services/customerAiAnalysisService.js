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
    '结果要适合前台“客户价值深度挖掘”展示：优先给直接结论、重点结论、下一步动作、主播承接话术、注意事项，少写长篇依据说明。',
    '如需引用依据，只保留最关键的 1-2 条事实，并且必须说人话，不要把 LRFM、ABC、贡献占比逐项铺成长报告。',
    '涉及 currentRoomValueShare30d / otherRoomsValueShare30d 时，必须明确写成“该客户近30天总贡献里，投向本房/其他房间的占比”，避免歧义。',
    '只能输出合法 JSON，不要输出 Markdown、代码块或额外说明。'
].join('\n');

const CUSTOMER_ANALYSIS_TEXT_REPLACEMENTS = [
    ['platform_lrfm', '平台LRFM'],
    ['room_lrfm', '本房LRFM'],
    ['clv_current_room_30d', '近30天本房客户价值'],
    ['abc_current_room', '本房ABC分层'],
    ['currentRoomValueShare30d', '近30天该客户总贡献里投向本房的占比'],
    ['otherRoomsValueShare30d', '近30天该客户总贡献里投向其他房间的占比'],
    ['giftTrend7dVsPrev7d', '近7天礼物趋势（较前7天）'],
    ['watchTrend7dVsPrev7d', '近7天观看趋势（较前7天）'],
    ['danmuTrend7dVsPrev7d', '近7天弹幕趋势（较前7天）'],
    ['platformGiftTopPercent30d', '平台近30天送礼排名'],
    ['platformGiftTopPercentLabel30d', '平台近30天送礼排名'],
    ['currentRoomGiftTopPercent30d', '本房近30天送礼排名'],
    ['currentRoomGiftTopPercentLabel30d', '本房近30天送礼排名'],
    ['otherRoomGrowthFlag', '其他房间增长信号'],
    ['currentRoomInactiveDays', '本房未活跃天数'],
    ['platformInactiveDays', '平台未活跃天数'],
    ['onlyWatchNoGiftFlag', '只看未送信号'],
    ['onlyGiftNoChatFlag', '只送不聊信号'],
    ['gift_value', '送礼值'],
    ['danmu_count', '弹幕条数'],
    ['watch_minutes', '观看时长'],
    ['signals', '信号'],
    ['models', '模型'],
    ['corpus', '语料'],
    ['tier', '分层']
];

const EVIDENCE_BUCKETS = [
    {
        key: 'modelEvidence',
        keywords: ['LRFM', 'ABC', '分层', '评分', '核心价值', '高价值', '潜力', '价值定位']
    },
    {
        key: 'contributionEvidence',
        keywords: ['贡献占比', '送礼排名', '前', '本房近30天', '平台近30天', '送礼值', '客户价值']
    },
    {
        key: 'riskEvidence',
        keywords: ['分流', '增长信号', '趋势', '未活跃', '流失', '摇摆', '召回', '其他房间']
    },
    {
        key: 'interactionEvidence',
        keywords: ['弹幕', '聊天', '语料', '互动', '观看', '只看未送', '只送不聊', '情绪', '偏好']
    }
];

function stripTrailingZeros(value) {
    return String(value || '')
        .replace(/\.0+$/, '')
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, '');
}

function formatPercentNumber(value, digits = 2) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return `${stripTrailingZeros((numeric * 100).toFixed(digits))}%`;
}

function formatTopPercentNumber(value, digits = 1) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    return `前${stripTrailingZeros(numeric.toFixed(digits))}%`;
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceLabelNumber(text, label, formatter) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[=:：]\\s*(-?[0-9][0-9,.]*)`, 'g');
    return String(text || '').replace(pattern, (_match, rawValue) => {
        const numeric = Number(String(rawValue || '').replace(/,/g, ''));
        const formatted = formatter(numeric);
        return formatted || _match;
    });
}

function replaceValueDisplay(text) {
    let output = String(text || '').trim();
    if (!output) return '';

    output = replaceLabelNumber(output, '近30天本房贡献占比', numeric => `近30天该客户总贡献里投向本房的占比约${formatPercentNumber(numeric)}`);
    output = replaceLabelNumber(output, '近30天该客户总贡献里投向本房的占比', numeric => `近30天该客户总贡献里投向本房的占比约${formatPercentNumber(numeric)}`);
    output = replaceLabelNumber(output, '近30天其他房间贡献占比', numeric => `近30天该客户总贡献里投向其他房间的占比约${formatPercentNumber(numeric)}`);
    output = replaceLabelNumber(output, '近30天该客户总贡献里投向其他房间的占比', numeric => `近30天该客户总贡献里投向其他房间的占比约${formatPercentNumber(numeric)}`);

    output = replaceLabelNumber(output, '近7天礼物趋势（较前7天）', numeric => {
        if (Math.abs(numeric) < 0.005) return '近7天礼物趋势（较前7天）基本持平';
        return `近7天礼物趋势（较前7天）${numeric > 0 ? '增长约' : '下降约'}${formatPercentNumber(Math.abs(numeric))}`;
    });
    output = replaceLabelNumber(output, '近7天观看趋势（较前7天）', numeric => {
        if (Math.abs(numeric) < 0.005) return '近7天观看趋势（较前7天）基本持平';
        return `近7天观看趋势（较前7天）${numeric > 0 ? '增长约' : '下降约'}${formatPercentNumber(Math.abs(numeric))}`;
    });
    output = replaceLabelNumber(output, '近7天弹幕趋势（较前7天）', numeric => {
        if (Math.abs(numeric) < 0.005) return '近7天弹幕趋势（较前7天）基本持平';
        return `近7天弹幕趋势（较前7天）${numeric > 0 ? '增长约' : '下降约'}${formatPercentNumber(Math.abs(numeric))}`;
    });

    output = replaceLabelNumber(output, '平台近30天送礼排名', numeric => `平台近30天送礼排名${formatTopPercentNumber(numeric) ? `位于${formatTopPercentNumber(numeric)}` : ''}`);
    output = replaceLabelNumber(output, '本房近30天送礼排名', numeric => `本房近30天送礼排名${formatTopPercentNumber(numeric) ? `位于${formatTopPercentNumber(numeric)}` : ''}`);

    return output
        .replace(/位于前/g, '位于前')
        .replace(/排名位于前/g, '排名位于前')
        .trim();
}

function convertRankFractionToTopPercent(text) {
    return String(text || '').replace(/排名\s*([0-9][0-9,]*)\s*\/\s*([0-9][0-9,]*)/g, (_match, rankText, totalText) => {
        const rank = Number(String(rankText || '').replace(/,/g, ''));
        const total = Number(String(totalText || '').replace(/,/g, ''));
        if (!rank || !total || total <= 0) return _match;
        const topPercent = Math.max(1, Math.min(100, Math.ceil((rank / total) * 100)));
        return `位于前${topPercent}%`;
    });
}

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

    output = convertRankFractionToTopPercent(output);
    output = replaceValueDisplay(output);

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

function dedupeStringArray(items = [], limit = 6) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const normalized = String(item || '').trim();
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
        if (result.length >= limit) break;
    }
    return result;
}

function readEvidenceArray(payload = {}, key = '', limit = 4) {
    return normalizeStringArray(payload?.[key], limit);
}

function classifyEvidenceItems(items = []) {
    const buckets = {
        modelEvidence: [],
        contributionEvidence: [],
        riskEvidence: [],
        interactionEvidence: [],
        remainingEvidence: []
    };

    for (const item of items) {
        const normalized = String(item || '').trim();
        if (!normalized) continue;
        const matchedBucket = EVIDENCE_BUCKETS.find(bucket => bucket.keywords.some(keyword => normalized.includes(keyword)));
        if (matchedBucket) {
            buckets[matchedBucket.key].push(normalized);
        } else {
            buckets.remainingEvidence.push(normalized);
        }
    }

    return {
        modelEvidence: dedupeStringArray(buckets.modelEvidence, 4),
        contributionEvidence: dedupeStringArray(buckets.contributionEvidence, 4),
        riskEvidence: dedupeStringArray(buckets.riskEvidence, 4),
        interactionEvidence: dedupeStringArray(buckets.interactionEvidence, 4),
        remainingEvidence: dedupeStringArray(buckets.remainingEvidence, 4)
    };
}

function normalizeAnalysisPayload(payload = {}) {
    const legacyEvidence = normalizeStringArray(payload.evidence, 8);
    const fallbackBuckets = classifyEvidenceItems(legacyEvidence);

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
        modelEvidence: dedupeStringArray([
            ...readEvidenceArray(payload, 'modelEvidence', 4),
            ...fallbackBuckets.modelEvidence
        ], 4),
        contributionEvidence: dedupeStringArray([
            ...readEvidenceArray(payload, 'contributionEvidence', 4),
            ...fallbackBuckets.contributionEvidence
        ], 4),
        riskEvidence: dedupeStringArray([
            ...readEvidenceArray(payload, 'riskEvidence', 4),
            ...fallbackBuckets.riskEvidence
        ], 4),
        interactionEvidence: dedupeStringArray([
            ...readEvidenceArray(payload, 'interactionEvidence', 4),
            ...fallbackBuckets.interactionEvidence
        ], 4),
        evidence: dedupeStringArray([
            ...readEvidenceArray(payload, 'generalEvidence', 4),
            ...fallbackBuckets.remainingEvidence
        ], 4)
    };
}

function parseCustomerAnalysisPayload(text) {
    const jsonCandidate = extractJsonCandidate(text);
    const parsed = JSON.parse(jsonCandidate);
    const normalizedAnalysis = normalizeAnalysisPayload(parsed);
    return {
        analysis: normalizedAnalysis,
        jsonText: JSON.stringify(normalizedAnalysis, null, 2)
    };
}

function formatCustomerAnalysisResult(analysis = {}) {
    const sections = [];

    if (analysis.summary) {
        sections.push(`直接结论\n${analysis.summary}`);
    }

    const overviewRows = [
        analysis.valueLevelCurrentRoom ? `本房价值定位：${analysis.valueLevelCurrentRoom}` : '',
        analysis.valueLevelGlobal ? `平台价值定位：${analysis.valueLevelGlobal}` : '',
        analysis.loyaltyAssessment ? `忠诚稳定性：${analysis.loyaltyAssessment}` : '',
        analysis.diversionRiskAssessment ? `跨房分流风险：${analysis.diversionRiskAssessment}` : '',
        analysis.conversionStage ? `转化阶段：${analysis.conversionStage}` : ''
    ].filter(Boolean);
    if (overviewRows.length) {
        sections.push(`核心判断\n${overviewRows.join('\n')}`);
    }

    if (analysis.keySignals?.length) {
        sections.push(`重点结论\n${analysis.keySignals.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.recommendedActions?.length) {
        sections.push(`下一步动作\n${analysis.recommendedActions.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.outreachScript?.length) {
        sections.push(`主播承接话术\n${analysis.outreachScript.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.forbiddenActions?.length) {
        sections.push(`注意事项\n${analysis.forbiddenActions.map(item => `- ${item}`).join('\n')}`);
    }
    if (analysis.tags?.length) {
        sections.push(`客户标签\n${analysis.tags.join(' ')}`);
    }

    return sections.join('\n\n').trim() || '未生成有效的客户价值深度挖掘结果';
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
    parseCustomerAnalysisPayload,
    normalizeAnalysisPayload,
    localizeCustomerAnalysisText
};
