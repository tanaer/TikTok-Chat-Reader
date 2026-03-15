const { get, query } = require('../db');
const { manager } = require('../manager');
const { buildCustomerContext } = require('./aiContextService');

const AI_STRUCTURED_DATA_SOURCE_VERSION = 'ai-structured-data-source.v1';
const SESSION_RECAP_COMMENT_FILTER_SCENE = 'session_recap_comment_filter';
const SESSION_RECAP_PROMPT_SCENE = 'session_recap_review';
const USER_PERSONALITY_ANALYSIS_SCENE = 'user_personality_analysis';
const CUSTOMER_ANALYSIS_PROMPT_SCENE = 'customer_analysis_review';
const SESSION_RECAP_BENCHMARK_BASELINE_HOURS = 6;
const SESSION_RECAP_BENCHMARK_BASELINE_GIFT_VALUE = 64000;
const SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD = 10;

const SCENE_LABELS = Object.freeze({
    [SESSION_RECAP_COMMENT_FILTER_SCENE]: 'AI直播复盘 · 高频弹幕筛选',
    [SESSION_RECAP_PROMPT_SCENE]: 'AI直播复盘 · 主分析流程',
    [USER_PERSONALITY_ANALYSIS_SCENE]: 'AI用户分析 · 性格分析流程',
    [CUSTOMER_ANALYSIS_PROMPT_SCENE]: 'AI客户分析 · 主分析流程'
});

function safeTrimString(value, maxLength = 300) {
    return String(value || '').trim().slice(0, maxLength);
}

function roundNumber(value, digits = 4) {
    if (!Number.isFinite(Number(value))) return 0;
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function toIsoString(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatSessionOffsetPoint(value, sessionStartAt = null) {
    if (!value) return '';
    const normalized = safeTrimString(value, 60);
    if (!normalized) return '';
    if (normalized.startsWith('开播后')) return normalized;
    const sessionStartMs = sessionStartAt ? new Date(sessionStartAt).getTime() : NaN;
    if (!Number.isFinite(sessionStartMs)) return normalized;

    const valueDate = new Date(normalized);
    if (Number.isFinite(valueDate.getTime())) {
        const diffSeconds = Math.max(0, Math.floor((valueDate.getTime() - sessionStartMs) / 1000));
        const hours = Math.floor(diffSeconds / 3600);
        const minutes = Math.floor((diffSeconds % 3600) / 60);
        const seconds = diffSeconds % 60;
        return `开播后${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    const hhmmMatch = /^(\d{2}):(\d{2})$/.exec(normalized);
    const hhmmssMatch = /^(\d{2}):(\d{2}):(\d{2})$/.exec(normalized);
    if (!hhmmMatch && !hhmmssMatch) return normalized;
    const point = new Date(sessionStartMs);
    const hoursPart = Number((hhmmssMatch || hhmmMatch)[1]);
    const minutesPart = Number((hhmmssMatch || hhmmMatch)[2]);
    const secondsPart = hhmmssMatch ? Number(hhmmssMatch[3]) : 0;
    point.setHours(hoursPart, minutesPart, secondsPart, 0);
    if (point.getTime() < sessionStartMs) point.setDate(point.getDate() + 1);
    const diffSeconds = Math.max(0, Math.floor((point.getTime() - sessionStartMs) / 1000));
    const hours = Math.floor(diffSeconds / 3600);
    const minutes = Math.floor((diffSeconds % 3600) / 60);
    const seconds = diffSeconds % 60;
    return `开播后${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildSessionOffsetRange(sessionStartAt = null, durationSeconds = 0) {
    const safeDurationSeconds = Math.max(0, Math.floor(Number(durationSeconds || 0)));
    const endHours = Math.floor(safeDurationSeconds / 3600);
    const endMinutes = Math.floor((safeDurationSeconds % 3600) / 60);
    const endSeconds = safeDurationSeconds % 60;
    const hasStart = Boolean(sessionStartAt);
    if (!hasStart && !safeDurationSeconds) return '';
    return `开播后00:00:00-开播后${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}:${String(endSeconds).padStart(2, '0')}`;
}

function safeDivide(numerator, denominator) {
    const left = Number(numerator || 0);
    const right = Number(denominator || 0);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return 0;
    return left / right;
}

function normalizeSessionId(value) {
    const normalized = safeTrimString(value || 'live', 120);
    return normalized || 'live';
}

function isLiveSessionId(sessionId) {
    const normalized = normalizeSessionId(sessionId).toLowerCase();
    return !normalized || normalized === 'live' || normalized === 'current';
}

function buildSessionScopeClause({ roomId, sessionId, alias = 'e' } = {}) {
    const normalizedRoomId = safeTrimString(roomId, 120);
    if (!normalizedRoomId) {
        throw new Error('roomId 不能为空');
    }

    const normalizedSessionId = normalizeSessionId(sessionId);
    const params = [normalizedRoomId];
    let clause = `${alias}.room_id = ?`;
    if (isLiveSessionId(normalizedSessionId)) {
        clause += ` AND ${alias}.session_id IS NULL`;
    } else {
        clause += ` AND ${alias}.session_id = ?`;
        params.push(normalizedSessionId);
    }

    return {
        clause,
        params,
        roomId: normalizedRoomId,
        sessionId: normalizedSessionId
    };
}

function buildHeartMeGiftSql(eventAlias = 'e', giftAlias = 'g') {
    return `REPLACE(REPLACE(LOWER(COALESCE(NULLIF(${eventAlias}.gift_name, ''), NULLIF(${giftAlias}.name_en, ''), NULLIF(${giftAlias}.name_cn, ''), '')), ' ', ''), '-', '') = 'heartme'`;
}

function normalizeStringList(value, limit = 8, maxLength = 200) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => safeTrimString(item, maxLength))
        .filter(Boolean)
        .slice(0, limit);
}

function normalizeValuableComments(value, limit = 12) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => {
            if (!item) return null;
            const text = safeTrimString(item.text || item.comment || item.keyword || item, 120);
            if (!text) return null;
            return {
                text,
                count: Math.max(0, Number(item.count || 0)),
                reason: safeTrimString(item.reason || item.category || '', 160),
                insight: safeTrimString(item.insight || item.suggestion || '', 160)
            };
        })
        .filter(Boolean)
        .slice(0, limit);
}

function normalizeCommentFilterCandidates(commentCandidates = [], limit = 50) {
    const source = Array.isArray(commentCandidates) ? commentCandidates : [];
    return source
        .map(item => ({
            text: safeTrimString(item?.text || item?.comment || '', 80),
            count: Math.max(0, Number(item?.count || 0))
        }))
        .filter(item => item.text && item.count > 0)
        .slice(0, Math.max(1, Number(limit || 50)));
}

function buildSessionRecapCommentFilterCandidates(recap = {}) {
    const normalizedCandidates = normalizeCommentFilterCandidates(recap?.commentSignals?.topComments || [], 100);
    return normalizedCandidates
        .filter(item => item.count <= SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD)
        .slice(0, 50);
}

function formatUserChatCorpusText(history = []) {
    const normalizedHistory = Array.isArray(history) ? history : [];
    return normalizedHistory
        .map(item => String(item?.comment || '').trim())
        .filter(Boolean)
        .join('\n');
}

function serializeValueCustomer(item = {}) {
    const sessionGiftValue = Number(item.sessionGiftValue ?? item.totalGiftValue ?? 0);
    return {
        nickname: safeTrimString(item.nickname || '匿名', 80) || '匿名',
        uniqueId: safeTrimString(item.uniqueId || '', 120),
        totalGiftValue: sessionGiftValue,
        sessionGiftValue,
        giftCount: Math.max(0, Number(item.giftCount || 0)),
        historicalValue: Math.max(0, Number(item.historicalValue || 0)),
        chatCount: Math.max(0, Number(item.chatCount || 0)),
        likeCount: Math.max(0, Number(item.likeCount || 0)),
        enterCount: Math.max(0, Number(item.enterCount || 0)),
        firstEnterAt: item.firstEnterAt || null,
        lastActiveAt: item.lastActiveAt || null,
        reason: safeTrimString(item.reason || '', 200),
        action: safeTrimString(item.action || '', 200)
    };
}

function serializeSessionPromptValueCustomer(item = {}, sessionStartAt = null) {
    const base = serializeValueCustomer(item);
    return {
        nickname: base.nickname,
        uniqueId: base.uniqueId,
        totalGiftValue: base.totalGiftValue,
        sessionGiftValue: base.sessionGiftValue,
        giftCount: base.giftCount,
        historicalValue: base.historicalValue,
        chatCount: base.chatCount,
        likeCount: base.likeCount,
        enterCount: base.enterCount,
        enterTime: formatSessionOffsetPoint(base.firstEnterAt, sessionStartAt),
        leaveTime: formatSessionOffsetPoint(base.lastActiveAt, sessionStartAt),
        reason: base.reason,
        action: base.action
    };
}

function buildSessionRecapPromptPayload(roomId, sessionId, recap, valuableComments = []) {
    const sessionStartAt = toIsoString(recap?.overview?.startTime);
    const filteredHighFrequencyComments = buildSessionRecapCommentFilterCandidates(recap);
    return {
        roomId,
        sessionId,
        metrics: {
            sessionTimeRange: buildSessionOffsetRange(sessionStartAt, recap?.overview?.duration || 0),
            durationSeconds: Number(recap?.overview?.duration || 0),
            totalVisits: Number(recap?.overview?.totalVisits || 0),
            peakOnline: Number(recap?.traffic?.peakOnline || 0),
            avgOnline: Number(recap?.traffic?.avgOnline || 0),
            totalGiftValue: Number(recap?.overview?.totalGiftValue || 0),
            totalComments: Number(recap?.overview?.totalComments || 0),
            totalLikes: Number(recap?.overview?.totalLikes || 0),
            participantCount: Number(recap?.overview?.participantCount || 0),
            payingUsers: Number(recap?.overview?.payingUsers || 0),
            chattingUsers: Number(recap?.overview?.chattingUsers || 0),
            topGiftShare: Number(recap?.overview?.topGiftShare || 0),
            score: Number(recap?.overview?.score || 0),
            gradeLabel: recap?.overview?.gradeLabel || '',
            tags: Array.isArray(recap?.overview?.tags) ? recap.overview.tags : []
        },
        traffic: {
            biggestDrop: recap?.traffic?.biggestDrop || null,
            trend: Array.isArray(recap?.timeline)
                ? recap.timeline.slice(0, 24).map(item => ({
                    timeRange: item.time_range,
                    income: Number(item.income || 0),
                    comments: Number(item.comments || 0),
                    maxOnline: Number(item.max_online || 0)
                }))
                : []
        },
        keyMoments: Array.isArray(recap?.keyMoments) ? recap.keyMoments.slice(0, 5) : [],
        highlights: normalizeStringList(recap?.insights?.highlights, 5, 240),
        issues: normalizeStringList(recap?.insights?.issues, 5, 240),
        actions: normalizeStringList(recap?.insights?.actions, 5, 240),
        highFrequencyComments: filteredHighFrequencyComments,
        valuableComments: normalizeValuableComments(valuableComments, 15),
        coreCustomers: Array.isArray(recap?.valueCustomers?.core) ? recap.valueCustomers.core.slice(0, 8).map(item => serializeSessionPromptValueCustomer(item, sessionStartAt)) : [],
        potentialCustomers: Array.isArray(recap?.valueCustomers?.potential) ? recap.valueCustomers.potential.slice(0, 8).map(item => serializeSessionPromptValueCustomer(item, sessionStartAt)) : [],
        riskCustomers: Array.isArray(recap?.valueCustomers?.risk) ? recap.valueCustomers.risk.slice(0, 8).map(item => serializeSessionPromptValueCustomer(item, sessionStartAt)) : [],
        topGifters: Array.isArray(recap?.giftSignals?.topGifters) ? recap.giftSignals.topGifters.slice(0, 20) : [],
        topGiftDetails: Array.isArray(recap?.giftSignals?.topGiftDetails) ? recap.giftSignals.topGiftDetails.slice(0, 20) : [],
        dataNotes: [
            '如果输入没有 GMV、留存率、分享率、关注增长，请不要编造。',
            '客户结论优先结合礼物、弹幕、点赞、进房、历史价值等现有数据判断。',
            '凡是形如“开播后HH:MM:SS”或“开播后HH:MM:SS-开播后HH:MM:SS”的时间，都是相对开播时长，不是北京时间、凌晨时间或自然时段描述。'
        ]
    };
}

function buildSessionRecapScoreBenchmark(recap = {}) {
    const durationSeconds = Math.max(0, Number(recap?.overview?.duration || 0));
    const rawDurationHours = durationSeconds > 0
        ? durationSeconds / 3600
        : SESSION_RECAP_BENCHMARK_BASELINE_HOURS;
    const durationHours = roundNumber(rawDurationHours, 2);
    const giftPassLineValue = Math.max(
        1,
        Math.round((Math.max(rawDurationHours, 0.5) / SESSION_RECAP_BENCHMARK_BASELINE_HOURS) * SESSION_RECAP_BENCHMARK_BASELINE_GIFT_VALUE)
    );
    const totalGiftValue = Math.max(0, Number(recap?.overview?.totalGiftValue || 0));
    const completionRatio = roundNumber(safeDivide(totalGiftValue, giftPassLineValue), 4);

    let passStatus = '未达标';
    if (completionRatio >= 1) passStatus = '达标';
    else if (completionRatio >= 0.8) passStatus = '接近及格';

    return {
        version: 'session-recap-score-benchmark.v1',
        baselineHours: SESSION_RECAP_BENCHMARK_BASELINE_HOURS,
        baselineGiftValue: SESSION_RECAP_BENCHMARK_BASELINE_GIFT_VALUE,
        durationHours,
        totalGiftValue,
        giftPassLineValue,
        completionRatio,
        passStatus,
        isPassed: completionRatio >= 1,
        gapToPassValue: Math.max(0, giftPassLineValue - totalGiftValue),
        overPassValue: Math.max(0, totalGiftValue - giftPassLineValue),
        benchmarkRule: '按 6 小时收礼 64,000 钻作为单场及格线，并按本场时长等比例折算。'
    };
}

async function loadSessionStartAt({ roomId, sessionId } = {}) {
    const scope = buildSessionScopeClause({ roomId, sessionId, alias: 'e' });
    const row = await get(`SELECT MIN(e.timestamp) as start_at FROM event e WHERE ${scope.clause}`, scope.params);
    return toIsoString(row?.startAt || row?.start_at);
}

async function buildSessionRecapNewAttentionCustomers({ roomId, sessionId, sessionStartAt = null } = {}) {
    const scope = buildSessionScopeClause({ roomId, sessionId, alias: 'e' });
    const normalizedSessionStartAt = sessionStartAt || await loadSessionStartAt({ roomId: scope.roomId, sessionId: scope.sessionId });

    if (!normalizedSessionStartAt) {
        return {
            version: 'session-recap-new-attention.v1',
            count: 0,
            customers: [],
            sessionStartAt: null,
            ruleText: '若用户在本场送出 Heart Me，且开播前历史上从未送过 Heart Me，则记为本场新增关注信号。'
        };
    }

    const heartMeSql = buildHeartMeGiftSql('e', 'g');
    const previousHeartMeSql = buildHeartMeGiftSql('prev', 'pg');
    const rows = await query(`
        SELECT
            e.user_id,
            COALESCE(MAX(NULLIF(e.nickname, '')), MAX(NULLIF(u.nickname, '')), '匿名') as nickname,
            COALESCE(MAX(NULLIF(e.unique_id, '')), MAX(NULLIF(u.unique_id, '')), '') as unique_id,
            MIN(e.timestamp) as first_gift_at,
            COALESCE(SUM(COALESCE(e.repeat_count, 1)), 0) as gift_count,
            COALESCE(SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)), 0) as gift_value
        FROM event e
        LEFT JOIN gift g ON e.gift_id::TEXT = g.gift_id
        LEFT JOIN "user" u ON u.user_id = e.user_id
        WHERE ${scope.clause}
          AND e.type = 'gift'
          AND e.user_id IS NOT NULL
          AND ${heartMeSql}
          AND NOT EXISTS (
              SELECT 1
              FROM event prev
              LEFT JOIN gift pg ON prev.gift_id::TEXT = pg.gift_id
              WHERE prev.user_id = e.user_id
                AND prev.type = 'gift'
                AND prev.timestamp < ?
                AND ${previousHeartMeSql}
          )
        GROUP BY e.user_id
        ORDER BY MIN(e.timestamp) ASC, COALESCE(SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)), 0) DESC
        LIMIT 50
    `, [...scope.params, normalizedSessionStartAt]);

    const customers = rows.map(row => ({
        userId: safeTrimString(row.userId, 120),
        nickname: safeTrimString(row.nickname || '匿名', 80) || '匿名',
        uniqueId: safeTrimString(row.uniqueId || '', 120),
        firstGiftAt: toIsoString(row.firstGiftAt || row.first_gift_at),
        giftCount: Math.max(0, Number(row.giftCount || row.gift_count || 0)),
        giftValue: Math.max(0, Number(row.giftValue || row.gift_value || 0))
    }));

    return {
        version: 'session-recap-new-attention.v1',
        count: customers.length,
        sessionStartAt: normalizedSessionStartAt,
        ruleText: '若用户在本场送出 Heart Me，且开播前历史上从未送过 Heart Me，则记为本场新增关注信号。',
        customers
    };
}

function ensureRuntimeCache(runtime = {}) {
    if (!runtime.__structuredDataCache || typeof runtime.__structuredDataCache !== 'object') {
        runtime.__structuredDataCache = {};
    }
    return runtime.__structuredDataCache;
}

async function loadSessionRecapBundle(context = {}, runtime = {}) {
    const scope = buildSessionScopeClause({
        roomId: context.roomId,
        sessionId: context.sessionId,
        alias: 'e'
    });
    const cache = ensureRuntimeCache(runtime);
    const cacheKey = `${scope.roomId}::${scope.sessionId}`;
    if (cache.sessionRecapBundles?.[cacheKey]) {
        return cache.sessionRecapBundles[cacheKey];
    }

    const recap = context.recap || await manager.getSessionRecap(scope.roomId, scope.sessionId, context.roomFilter || null);
    const valuableComments = Array.isArray(context.valuableComments)
        ? context.valuableComments
        : (Array.isArray(recap?.commentSignals?.valuableComments) ? recap.commentSignals.valuableComments : []);
    const promptPayload = buildSessionRecapPromptPayload(scope.roomId, scope.sessionId, recap, valuableComments);
    const sessionStartAt = toIsoString(recap?.overview?.startTime) || await loadSessionStartAt({ roomId: scope.roomId, sessionId: scope.sessionId });
    const scoreBenchmark = buildSessionRecapScoreBenchmark(recap);
    const newAttentionCustomers = await buildSessionRecapNewAttentionCustomers({
        roomId: scope.roomId,
        sessionId: scope.sessionId,
        sessionStartAt
    });

    const bundle = {
        roomId: scope.roomId,
        sessionId: scope.sessionId,
        recap,
        promptPayload,
        sessionStartAt,
        scoreBenchmark,
        newAttentionCustomers
    };

    cache.sessionRecapBundles = cache.sessionRecapBundles || {};
    cache.sessionRecapBundles[cacheKey] = bundle;
    return bundle;
}

async function loadCustomerContextBundle(context = {}, runtime = {}) {
    const normalizedUserId = safeTrimString(context.userId, 120);
    if (!normalizedUserId) {
        throw new Error('userId 不能为空');
    }

    const normalizedRoomId = safeTrimString(context.roomId, 120);
    const cache = ensureRuntimeCache(runtime);
    const cacheKey = `${normalizedUserId}::${normalizedRoomId || 'auto'}`;
    if (cache.customerContextBundles?.[cacheKey]) {
        return cache.customerContextBundles[cacheKey];
    }

    const payload = context.customerContextPayload || await buildCustomerContext({
        userId: normalizedUserId,
        roomId: normalizedRoomId || null,
        roomFilter: context.roomFilter || null,
        now: context.now || new Date()
    });

    const bundle = {
        userId: normalizedUserId,
        roomId: payload.currentRoomId || normalizedRoomId || null,
        payload
    };

    cache.customerContextBundles = cache.customerContextBundles || {};
    cache.customerContextBundles[cacheKey] = bundle;
    return bundle;
}

async function loadUserPersonalityChatCorpusBundle(context = {}, runtime = {}) {
    const normalizedUserId = safeTrimString(context.userId, 120);
    if (!normalizedUserId) {
        throw new Error('userId 不能为空');
    }

    const cache = ensureRuntimeCache(runtime);
    const cacheKey = normalizedUserId;
    if (cache.userPersonalityBundles?.[cacheKey]) {
        return cache.userPersonalityBundles[cacheKey];
    }

    const chatCorpusText = safeTrimString(context.chatCorpusText, 60000);
    const roomFilter = context.roomFilter || null;
    const history = chatCorpusText
        ? []
        : await manager.getUserChatHistory(normalizedUserId, 200, roomFilter);
    const resolvedChatCorpusText = chatCorpusText || formatUserChatCorpusText(history);

    const bundle = {
        userId: normalizedUserId,
        chatCorpusText: resolvedChatCorpusText,
        chatCount: chatCorpusText
            ? resolvedChatCorpusText.split('\n').filter(Boolean).length
            : (Array.isArray(history) ? history.length : 0)
    };

    cache.userPersonalityBundles = cache.userPersonalityBundles || {};
    cache.userPersonalityBundles[cacheKey] = bundle;
    return bundle;
}

const AI_STRUCTURED_DATA_SOURCES = Object.freeze([
    {
        key: 'session_recap.comment_filter_candidates_json',
        token: 'topCommentCandidatesJson',
        scene: SESSION_RECAP_COMMENT_FILTER_SCENE,
        sceneLabel: SCENE_LABELS[SESSION_RECAP_COMMENT_FILTER_SCENE],
        category: '直播复盘',
        title: '高频弹幕候选语料',
        description: 'AI直播复盘·高频弹幕筛选 实际使用的候选弹幕语料。已自动剔除重复超过 10 次的高频自动弹幕，只保留待交给 AI 再筛选的 Top50 候选。',
        inputSchema: {
            type: 'object',
            required: ['roomId'],
            properties: {
                roomId: { type: 'string', label: '房间ID' },
                sessionId: { type: 'string', label: '场次ID', description: '留空或传 live 表示当前直播场次' }
            }
        },
        defaultTestInput: {
            roomId: '',
            sessionId: 'live'
        },
        autoAppendWhenMissing: false,
        resolver: async (input = {}, runtime = {}) => {
            if (Array.isArray(input?.commentCandidates)) {
                return normalizeCommentFilterCandidates(input.commentCandidates, 100)
                    .filter(item => item.count <= SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD)
                    .slice(0, 50);
            }
            const bundle = await loadSessionRecapBundle(input, runtime);
            return buildSessionRecapCommentFilterCandidates(bundle.recap);
        }
    },
    {
        key: 'session_recap.prompt_payload_json',
        token: 'sessionDataJson',
        scene: SESSION_RECAP_PROMPT_SCENE,
        sceneLabel: SCENE_LABELS[SESSION_RECAP_PROMPT_SCENE],
        category: '直播复盘',
        title: '直播复盘主输入',
        description: 'AI直播复盘主分析流程当前实际使用的结构化主输入，包含流量、礼物、客户结构与高价值弹幕摘要。',
        inputSchema: {
            type: 'object',
            required: ['roomId'],
            properties: {
                roomId: { type: 'string', label: '房间ID' },
                sessionId: { type: 'string', label: '场次ID', description: '留空或传 live 表示当前直播场次' }
            }
        },
        defaultTestInput: {
            roomId: '',
            sessionId: 'live'
        },
        autoAppendWhenMissing: true,
        resolver: async (input = {}, runtime = {}) => {
            const bundle = await loadSessionRecapBundle(input, runtime);
            return bundle.promptPayload;
        }
    },
    {
        key: 'session_recap.score_benchmark_json',
        token: 'sessionRecapScoreBenchmarkJson',
        scene: SESSION_RECAP_PROMPT_SCENE,
        sceneLabel: SCENE_LABELS[SESSION_RECAP_PROMPT_SCENE],
        category: '直播复盘',
        title: '直播复盘及格线基准',
        description: '按“6小时 / 64,000钻”为单场及格线，并按实际时长等比例折算本场基准与完成度。',
        inputSchema: {
            type: 'object',
            required: ['roomId'],
            properties: {
                roomId: { type: 'string', label: '房间ID' },
                sessionId: { type: 'string', label: '场次ID', description: '留空或传 live 表示当前直播场次' }
            }
        },
        defaultTestInput: {
            roomId: '',
            sessionId: 'live'
        },
        autoAppendWhenMissing: true,
        resolver: async (input = {}, runtime = {}) => {
            const bundle = await loadSessionRecapBundle(input, runtime);
            return bundle.scoreBenchmark;
        }
    },
    {
        key: 'session_recap.new_attention_customers_json',
        token: 'sessionRecapNewAttentionCustomersJson',
        scene: SESSION_RECAP_PROMPT_SCENE,
        sceneLabel: SCENE_LABELS[SESSION_RECAP_PROMPT_SCENE],
        category: '直播复盘',
        title: '直播复盘新增关注信号',
        description: '识别本场送出 Heart Me 且历史从未送过 Heart Me 的用户，作为新增关注/关系推进信号。',
        inputSchema: {
            type: 'object',
            required: ['roomId'],
            properties: {
                roomId: { type: 'string', label: '房间ID' },
                sessionId: { type: 'string', label: '场次ID', description: '留空或传 live 表示当前直播场次' }
            }
        },
        defaultTestInput: {
            roomId: '',
            sessionId: 'live'
        },
        autoAppendWhenMissing: true,
        resolver: async (input = {}, runtime = {}) => {
            const bundle = await loadSessionRecapBundle(input, runtime);
            return bundle.newAttentionCustomers;
        }
    },
    {
        key: 'user_personality.chat_corpus_text',
        token: 'chatCorpusText',
        scene: USER_PERSONALITY_ANALYSIS_SCENE,
        sceneLabel: SCENE_LABELS[USER_PERSONALITY_ANALYSIS_SCENE],
        category: '用户分析',
        title: '用户历史弹幕语料',
        description: 'AI用户分析 · 性格分析流程使用的历史弹幕语料，默认聚合该用户近 200 条可用弹幕内容。',
        inputSchema: {
            type: 'object',
            required: ['userId'],
            properties: {
                userId: { type: 'string', label: '用户ID' }
            }
        },
        defaultTestInput: {
            userId: ''
        },
        autoAppendWhenMissing: false,
        resolver: async (input = {}, runtime = {}) => {
            const bundle = await loadUserPersonalityChatCorpusBundle(input, runtime);
            return bundle.chatCorpusText;
        }
    },
    {
        key: 'customer_analysis.context_json',
        token: 'customerContextJson',
        scene: CUSTOMER_ANALYSIS_PROMPT_SCENE,
        sceneLabel: SCENE_LABELS[CUSTOMER_ANALYSIS_PROMPT_SCENE],
        category: '客户分析',
        title: '客户分析结构化上下文',
        description: '客户价值深度挖掘当前主输入，包含 identity / scope / metricCube / models / signals / corpus 等系统事实。',
        inputSchema: {
            type: 'object',
            required: ['userId'],
            properties: {
                userId: { type: 'string', label: '用户ID' },
                roomId: { type: 'string', label: '房间ID', description: '为空时自动选择当前最相关房间' }
            }
        },
        defaultTestInput: {
            userId: '',
            roomId: ''
        },
        autoAppendWhenMissing: true,
        resolver: async (input = {}, runtime = {}) => {
            const bundle = await loadCustomerContextBundle(input, runtime);
            return bundle.payload.customerContext;
        }
    },
    {
        key: 'customer_analysis.chat_corpus_text',
        token: 'chatCorpusText',
        scene: CUSTOMER_ANALYSIS_PROMPT_SCENE,
        sceneLabel: SCENE_LABELS[CUSTOMER_ANALYSIS_PROMPT_SCENE],
        category: '客户分析',
        title: '客户最近弹幕语料',
        description: 'AI客户分析使用的最近弹幕语料，来自结构化客户上下文中的近期待分析聊天内容。',
        inputSchema: {
            type: 'object',
            required: ['userId'],
            properties: {
                userId: { type: 'string', label: '用户ID' },
                roomId: { type: 'string', label: '房间ID', description: '为空时自动选择当前最相关房间' }
            }
        },
        defaultTestInput: {
            userId: '',
            roomId: ''
        },
        autoAppendWhenMissing: false,
        resolver: async (input = {}, runtime = {}) => {
            const bundle = await loadCustomerContextBundle(input, runtime);
            return bundle.payload.chatCorpusText || '';
        }
    }
]);

function serializeAiStructuredDataSourceDefinition(definition = {}) {
    return {
        key: definition.key,
        token: definition.token,
        scene: definition.scene,
        sceneLabel: definition.sceneLabel || SCENE_LABELS[definition.scene] || definition.scene,
        category: definition.category || '',
        title: definition.title || definition.key,
        description: definition.description || '',
        inputSchema: definition.inputSchema || { type: 'object', properties: {} },
        defaultTestInput: definition.defaultTestInput || {},
        autoAppendWhenMissing: Boolean(definition.autoAppendWhenMissing)
    };
}

function listAiStructuredDataSourceDefinitions({ scene = '' } = {}) {
    const normalizedScene = safeTrimString(scene, 120);
    return AI_STRUCTURED_DATA_SOURCES.filter(item => !normalizedScene || item.scene === normalizedScene);
}

function listAiStructuredDataSources(options = {}) {
    return listAiStructuredDataSourceDefinitions(options).map(serializeAiStructuredDataSourceDefinition);
}

function getAiStructuredDataSourceDefinition(key) {
    const normalizedKey = safeTrimString(key, 200);
    return AI_STRUCTURED_DATA_SOURCES.find(item => item.key === normalizedKey) || null;
}

function formatStructuredDataSourceValue(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value ?? null, null, 2);
}

async function resolveAiStructuredDataSource(key, { context = {}, runtime = {} } = {}) {
    const definition = getAiStructuredDataSourceDefinition(key);
    if (!definition) {
        throw new Error('结构化数据源不存在');
    }

    const value = await definition.resolver(context, runtime);
    return {
        definition: serializeAiStructuredDataSourceDefinition(definition),
        token: definition.token,
        value,
        renderedValue: formatStructuredDataSourceValue(value)
    };
}

async function resolveAiStructuredDataVariables({ scene = '', context = {}, runtime = {} } = {}) {
    const variables = {};
    const definitions = listAiStructuredDataSourceDefinitions({ scene });
    for (const definition of definitions) {
        const result = await resolveAiStructuredDataSource(definition.key, { context, runtime });
        variables[definition.token] = result.renderedValue;
    }
    return variables;
}

function hasTemplateToken(templateContent = '', token = '') {
    const content = String(templateContent || '');
    return new RegExp(`{{\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*}}`, 'g').test(content);
}

function injectMissingStructuredDataTokens({ scene = '', templateContent = '' } = {}) {
    let content = String(templateContent || '');
    const definitions = listAiStructuredDataSourceDefinitions({ scene })
        .filter(item => item.autoAppendWhenMissing);

    for (const definition of definitions) {
        if (hasTemplateToken(content, definition.token)) continue;
        content += `\n\n系统补充结构化数据（${definition.title}）：\n{{${definition.token}}}`;
    }
    return content;
}

async function testAiStructuredDataSource(key, input = {}, runtime = {}) {
    const startedAt = Date.now();
    const result = await resolveAiStructuredDataSource(key, {
        context: input,
        runtime
    });

    return {
        source: result.definition,
        input,
        output: result.value,
        renderedValue: result.renderedValue,
        durationMs: Math.max(0, Date.now() - startedAt),
        version: AI_STRUCTURED_DATA_SOURCE_VERSION
    };
}

module.exports = {
    AI_STRUCTURED_DATA_SOURCE_VERSION,
    SESSION_RECAP_COMMENT_FILTER_SCENE,
    SESSION_RECAP_PROMPT_SCENE,
    USER_PERSONALITY_ANALYSIS_SCENE,
    CUSTOMER_ANALYSIS_PROMPT_SCENE,
    SCENE_LABELS,
    buildSessionRecapCommentFilterCandidates,
    listAiStructuredDataSources,
    getAiStructuredDataSourceDefinition,
    resolveAiStructuredDataSource,
    resolveAiStructuredDataVariables,
    injectMissingStructuredDataTokens,
    testAiStructuredDataSource
};
