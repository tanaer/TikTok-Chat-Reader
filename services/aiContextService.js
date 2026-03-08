const { get, query } = require('../db');
const {
    CUSTOMER_METRIC_CUBE_VERSION,
    buildCustomerMetricCube
} = require('./customerMetricCubeService');
const {
    CUSTOMER_FEATURE_VERSION,
    buildCustomerFeatures
} = require('./customerFeatureService');

const CUSTOMER_CONTEXT_VERSION = 'customer-context.v1';
const MAX_CHAT_CORPUS_COUNT = 200;
const CHAT_PREVIEW_COUNT = 120;

const KEYWORD_STOP_WORDS = new Set([
    '哈哈', '哈哈哈', '哈哈哈哈', 'hello', 'hi', 'yes', 'yeah', 'ok', 'okay',
    '主播', '直播', '这个', '那个', '就是', '真的', '一下', '可以', '还是',
    '谢谢', '好的', '了吧', '了吗', '怎么', '什么', '因为', '然后', '但是',
    '一个', '我们', '你们', '他们'
]);

function toValidDate(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoString(value) {
    const parsed = toValidDate(value);
    return parsed ? parsed.toISOString() : null;
}

function addDays(base, deltaDays) {
    const next = new Date(base);
    next.setDate(next.getDate() + deltaDays);
    return next;
}

function safeDivide(numerator, denominator) {
    const left = Number(numerator || 0);
    const right = Number(denominator || 0);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return 0;
    return left / right;
}

function roundNumber(value, digits = 4) {
    if (!Number.isFinite(Number(value))) return 0;
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function daysBetween(startValue, endValue = new Date()) {
    const start = toValidDate(startValue);
    const end = toValidDate(endValue);
    if (!start || !end) return 0;
    return Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1);
}

function daysSince(value, now = new Date()) {
    const parsed = toValidDate(value);
    if (!parsed) return null;
    return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 86400000));
}

function normalizeLanguageList(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
    }
    return [...new Set(String(value)
        .split(/[\n,，、/|]+/)
        .map(item => item.trim())
        .filter(Boolean))];
}

function formatChatTimestamp(value) {
    const parsed = toValidDate(value);
    if (!parsed) return '';
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    const hour = String(parsed.getHours()).padStart(2, '0');
    const minute = String(parsed.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
}

function buildSessionSpanMinutes(rawEvents = []) {
    const sessionSpans = new Map();
    for (const event of rawEvents) {
        const timestamp = toValidDate(event.timestamp);
        if (!timestamp) continue;
        const sessionKey = event.sessionId || `${event.roomId || 'unknown'}::${formatChatTimestamp(timestamp).slice(0, 10)}`;
        const current = sessionSpans.get(sessionKey) || { roomId: event.roomId, start: timestamp, end: timestamp };
        if (timestamp < current.start) current.start = timestamp;
        if (timestamp > current.end) current.end = timestamp;
        sessionSpans.set(sessionKey, current);
    }

    const roomWatchMinutes = new Map();
    for (const span of sessionSpans.values()) {
        const durationMinutes = Math.max(1, Math.ceil((span.end.getTime() - span.start.getTime()) / 60000));
        roomWatchMinutes.set(span.roomId, (roomWatchMinutes.get(span.roomId) || 0) + durationMinutes);
    }
    return roomWatchMinutes;
}

function collectChatCorpus(rawEvents = [], roomNameMap = {}) {
    const recentChatMessages = rawEvents
        .filter(event => event.type === 'chat' && String(event.comment || '').trim())
        .sort((left, right) => (right.timestamp?.getTime() || 0) - (left.timestamp?.getTime() || 0))
        .slice(0, MAX_CHAT_CORPUS_COUNT)
        .map(event => ({
            roomId: event.roomId || null,
            roomName: event.roomId ? (roomNameMap[event.roomId] || event.roomId) : null,
            timestamp: toIsoString(event.timestamp),
            comment: String(event.comment || '').trim().slice(0, 120)
        }));

    const previewMessages = recentChatMessages.slice(0, CHAT_PREVIEW_COUNT);
    const chatCorpusText = previewMessages
        .map(item => `[${formatChatTimestamp(item.timestamp)}][${item.roomName || item.roomId || '未知房间'}] ${item.comment}`)
        .join('\n');

    return {
        recentChatMessages,
        chatCorpusText,
        chatCount: recentChatMessages.length,
        lastChatAt: recentChatMessages[0]?.timestamp || null
    };
}

function extractKeywordCandidates(text) {
    const normalized = String(text || '').toLowerCase();
    const matched = normalized.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{2,}/g) || [];
    return matched.filter(token => token.length <= 16 && !KEYWORD_STOP_WORDS.has(token));
}

function buildKeywordStats(chatMessages = [], limit = 8) {
    const counts = new Map();
    for (const item of chatMessages) {
        for (const token of extractKeywordCandidates(item.comment)) {
            counts.set(token, (counts.get(token) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([keyword, count]) => ({ keyword, count }))
        .sort((left, right) => right.count - left.count || left.keyword.localeCompare(right.keyword))
        .slice(0, limit);
}

async function loadGiftNameMap(giftIds = []) {
    const uniqueGiftIds = [...new Set((giftIds || []).filter(Boolean))];
    if (!uniqueGiftIds.length) return {};
    const placeholders = uniqueGiftIds.map(() => '?').join(',');
    const rows = await query(`
        SELECT gift_id, COALESCE(NULLIF(name_cn, ''), NULLIF(name_en, ''), gift_id) as gift_name
        FROM gift
        WHERE gift_id IN (${placeholders})
    `, uniqueGiftIds);
    return Object.fromEntries(rows.map(row => [String(row.giftId), row.giftName || String(row.giftId)]));
}

async function buildPreferenceSection(rawEvents = [], roomNameMap = {}) {
    const giftEvents = rawEvents.filter(event => event.type === 'gift' && event.giftId);
    const giftNameMap = await loadGiftNameMap(giftEvents.map(event => String(event.giftId)));
    const giftStats = new Map();
    const roomGiftStats = new Map();
    const roomWatchMinutes = buildSessionSpanMinutes(rawEvents);
    const hourCounts = new Map();
    const weekdayCounts = new Map();

    for (const event of rawEvents) {
        const timestamp = toValidDate(event.timestamp);
        if (!timestamp) continue;

        const hourKey = String(timestamp.getHours()).padStart(2, '0');
        hourCounts.set(hourKey, (hourCounts.get(hourKey) || 0) + 1);
        const weekdayKey = String(timestamp.getDay());
        weekdayCounts.set(weekdayKey, (weekdayCounts.get(weekdayKey) || 0) + 1);

        if (event.roomId) {
            const roomItem = roomGiftStats.get(event.roomId) || {
                roomId: event.roomId,
                roomName: roomNameMap[event.roomId] || event.roomId,
                giftValue: 0,
                giftCount: 0
            };
            if (event.type === 'gift') {
                roomItem.giftValue += Number(event.giftValue || 0);
                roomItem.giftCount += Number(event.repeatCount || 0);
            }
            roomGiftStats.set(event.roomId, roomItem);
        }

        if (event.type === 'gift' && event.giftId) {
            const giftKey = String(event.giftId);
            const current = giftStats.get(giftKey) || {
                giftId: giftKey,
                giftName: giftNameMap[giftKey] || giftKey,
                giftValue: 0,
                giftCount: 0
            };
            current.giftValue += Number(event.giftValue || 0);
            current.giftCount += Number(event.repeatCount || 0);
            giftStats.set(giftKey, current);
        }
    }

    const activeHoursTop3 = [...hourCounts.entries()]
        .map(([hour, count]) => ({ hour, count }))
        .sort((left, right) => right.count - left.count || left.hour.localeCompare(right.hour))
        .slice(0, 3);

    const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const activeWeekdaysTop3 = [...weekdayCounts.entries()]
        .map(([weekday, count]) => ({ weekday: Number(weekday), label: weekdayNames[Number(weekday)] || weekday, count }))
        .sort((left, right) => right.count - left.count || left.weekday - right.weekday)
        .slice(0, 3);

    const topRoomsByGift = [...roomGiftStats.values()]
        .sort((left, right) => right.giftValue - left.giftValue || right.giftCount - left.giftCount)
        .slice(0, 5)
        .map(item => ({
            roomId: item.roomId,
            roomName: item.roomName,
            giftValue: item.giftValue,
            giftCount: item.giftCount
        }));

    const topRoomsByWatch = [...roomWatchMinutes.entries()]
        .map(([roomId, watchMinutes]) => ({
            roomId,
            roomName: roomNameMap[roomId] || roomId,
            watchMinutes
        }))
        .sort((left, right) => right.watchMinutes - left.watchMinutes)
        .slice(0, 5);

    const chatCorpus = collectChatCorpus(rawEvents, roomNameMap);
    const danmuKeywordsTop = buildKeywordStats(chatCorpus.recentChatMessages, 8);

    return {
        preference: {
            topGifts: [...giftStats.values()]
                .sort((left, right) => right.giftValue - left.giftValue || right.giftCount - left.giftCount)
                .slice(0, 5),
            topRoomsByGift,
            topRoomsByWatch,
            activeHoursTop3,
            activeWeekdaysTop3,
            danmuKeywordsTop,
            topicInterestTags: danmuKeywordsTop.slice(0, 5).map(item => item.keyword)
        },
        chatCorpus
    };
}

function calculateActivitySnapshot(events = []) {
    let giftValue = 0;
    let danmuCount = 0;
    let likeCount = 0;
    const sessionSpans = buildSessionSpanMinutes(events);

    for (const event of events) {
        if (event.type === 'gift') giftValue += Number(event.giftValue || 0);
        if (event.type === 'chat') danmuCount += 1;
        if (event.type === 'like') likeCount += Number(event.likeCount || 0);
    }

    const watchMinutes = [...sessionSpans.values()].reduce((sum, value) => sum + value, 0);
    return { giftValue, danmuCount, likeCount, watchMinutes };
}

function buildSignalSection({ rawEvents = [], metricCube = {}, currentRoomId = null, now = new Date() }) {
    const currentRoom30d = metricCube?.current_room?.['30d'] || {};
    const otherRooms30d = metricCube?.other_rooms?.['30d'] || {};
    const allRooms30d = metricCube?.all_rooms?.['30d'] || {};
    const allRooms7d = metricCube?.all_rooms?.['7d'] || {};
    const currentRoom7d = metricCube?.current_room?.['7d'] || {};
    const otherRooms7d = metricCube?.other_rooms?.['7d'] || {};
    const currentRoomAllTime = metricCube?.current_room?.all_time || {};
    const allRoomsAllTime = metricCube?.all_rooms?.all_time || {};
    const recent7dStart = addDays(now, -7);
    const previous7dStart = addDays(now, -14);

    const previous7dEvents = rawEvents.filter(event => event.timestamp && event.timestamp >= previous7dStart && event.timestamp < recent7dStart);
    const previous7dSnapshot = calculateActivitySnapshot(previous7dEvents);

    return {
        currentRoomValueShare30d: roundNumber(safeDivide(currentRoom30d.gift_value, allRooms30d.gift_value), 4),
        otherRoomsValueShare30d: roundNumber(safeDivide(otherRooms30d.gift_value, allRooms30d.gift_value), 4),
        giftTrend7dVsPrev7d: roundNumber(safeDivide((Number(allRooms7d.gift_value || 0) - previous7dSnapshot.giftValue), Math.max(previous7dSnapshot.giftValue, 1)), 4),
        watchTrend7dVsPrev7d: roundNumber(safeDivide((Number(allRooms7d.watch_minutes || 0) - previous7dSnapshot.watchMinutes), Math.max(previous7dSnapshot.watchMinutes, 1)), 4),
        danmuTrend7dVsPrev7d: roundNumber(safeDivide((Number(allRooms7d.danmu_count || 0) - previous7dSnapshot.danmuCount), Math.max(previous7dSnapshot.danmuCount, 1)), 4),
        currentRoomInactiveDays: daysSince(currentRoomAllTime.last_active_at, now),
        platformInactiveDays: daysSince(allRoomsAllTime.last_active_at, now),
        otherRoomGrowthFlag: Number(otherRooms7d.gift_value || 0) > Number(currentRoom7d.gift_value || 0),
        silentAfterGiftingFlag: Number(currentRoom30d.gift_value || 0) > 0 && Number(currentRoom30d.danmu_count || 0) === 0,
        onlyWatchNoGiftFlag: Number(currentRoom30d.gift_value || 0) === 0 && (Number(currentRoom30d.entry_count || 0) > 0 || Number(currentRoom30d.watch_minutes || 0) > 0),
        onlyGiftNoChatFlag: Number(currentRoom30d.gift_value || 0) > 0 && Number(currentRoom30d.danmu_count || 0) === 0,
        currentRoomId,
        currentRoomSessionCount30d: Number(currentRoom30d.active_sessions || 0)
    };
}

async function loadUserIdentity(userId) {
    if (!userId) return null;
    return await get(`
        SELECT user_id, nickname, unique_id, region, common_language, mastered_languages
        FROM "user"
        WHERE user_id = ?
        LIMIT 1
    `, [userId]);
}

async function buildCustomerContext({ userId, roomId = null, roomFilter = null, now = new Date() } = {}) {
    const metricResult = await buildCustomerMetricCube({ userId, roomId, roomFilter, now });
    const rawEvents = metricResult.rawEvents || [];
    const identityRow = await loadUserIdentity(userId);
    const { preference, chatCorpus } = await buildPreferenceSection(rawEvents, metricResult.roomNameMap || {});
    const featureResult = await buildCustomerFeatures({
        userId,
        currentRoomId: metricResult.currentRoom.roomId,
        roomFilter,
        metricCube: metricResult.metricCube,
        now
    });

    const firstSeenAt = metricResult.metricCube?.all_rooms?.all_time?.first_active_at || null;
    const lastActiveAt = metricResult.metricCube?.all_rooms?.all_time?.last_active_at || null;
    const customerContext = {
        contextVersion: CUSTOMER_CONTEXT_VERSION,
        metricCubeVersion: CUSTOMER_METRIC_CUBE_VERSION,
        featureVersion: CUSTOMER_FEATURE_VERSION,
        identity: {
            userId,
            nickname: identityRow?.nickname || '',
            uniqueId: identityRow?.uniqueId || '',
            region: identityRow?.region || '',
            commonLanguage: identityRow?.commonLanguage || '',
            masteredLanguages: normalizeLanguageList(identityRow?.masteredLanguages),
            firstSeenAt,
            lastActiveAt,
            relationshipDays: daysBetween(firstSeenAt, now)
        },
        scope: {
            currentRoom: {
                roomId: metricResult.currentRoom.roomId,
                roomName: metricResult.currentRoom.roomName,
                resolvedBy: metricResult.currentRoom.resolvedBy
            },
            currentSession: {
                sessionId: metricResult.currentSession.sessionId,
                lastActiveAt: metricResult.currentSession.lastActiveAt
            },
            accessibleRoomCount: metricResult.currentRoom.availableRoomCount
        },
        metricCube: metricResult.metricCube,
        preference,
        rankings: featureResult.rankings,
        models: featureResult.models,
        signals: buildSignalSection({
            rawEvents,
            metricCube: metricResult.metricCube,
            currentRoomId: metricResult.currentRoom.roomId,
            now
        }),
        corpus: {
            recentChatCount: chatCorpus.chatCount,
            lastChatAt: chatCorpus.lastChatAt,
            recentChatMessages: chatCorpus.recentChatMessages.slice(0, 20)
        }
    };

    return {
        customerContext,
        customerContextJson: JSON.stringify(customerContext, null, 2),
        chatCorpusText: chatCorpus.chatCorpusText,
        chatCount: chatCorpus.chatCount,
        latestActivityAt: lastActiveAt,
        currentRoomId: metricResult.currentRoom.roomId,
        currentRoomName: metricResult.currentRoom.roomName,
        currentSessionId: metricResult.currentSession.sessionId,
        promptVariables: {
            customerContextJson: JSON.stringify(customerContext, null, 2),
            chatCorpusText: chatCorpus.chatCorpusText
        }
    };
}

module.exports = {
    CUSTOMER_CONTEXT_VERSION,
    MAX_CHAT_CORPUS_COUNT,
    buildCustomerContext
};
