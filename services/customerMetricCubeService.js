const { query } = require('../db');

const TIME_DIMENSIONS = Object.freeze(['current_session', 'today', '3d', '7d', '30d', 'all_time']);
const SPACE_DIMENSIONS = Object.freeze(['current_room', 'other_rooms', 'all_rooms']);
const CUSTOMER_METRIC_CUBE_VERSION = 'customer-metric-cube.v1';

function toValidDate(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoString(value) {
    const parsed = toValidDate(value);
    return parsed ? parsed.toISOString() : null;
}

function toDateKey(value) {
    const parsed = toValidDate(value);
    if (!parsed) return null;
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function addDays(base, deltaDays) {
    const next = new Date(base);
    next.setDate(next.getDate() + deltaDays);
    return next;
}

function startOfToday(base = new Date()) {
    const next = new Date(base);
    next.setHours(0, 0, 0, 0);
    return next;
}

function roundNumber(value, digits = 2) {
    if (!Number.isFinite(Number(value))) return 0;
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function createEmptyMetrics() {
    return {
        gift_value: 0,
        gift_count: 0,
        entry_count: 0,
        watch_minutes: 0,
        avg_watch_minutes_per_entry: 0,
        median_watch_minutes_per_entry: 0,
        danmu_count: 0,
        like_count: 0,
        share_count: 0,
        follow_count: 0,
        active_days: 0,
        active_sessions: 0,
        last_active_at: null,
        first_active_at: null
    };
}

function createEmptyMetricCube() {
    return {
        current_room: {
            current_session: createEmptyMetrics(),
            today: createEmptyMetrics(),
            '3d': createEmptyMetrics(),
            '7d': createEmptyMetrics(),
            '30d': createEmptyMetrics(),
            all_time: createEmptyMetrics()
        },
        other_rooms: {
            today: createEmptyMetrics(),
            '3d': createEmptyMetrics(),
            '7d': createEmptyMetrics(),
            '30d': createEmptyMetrics(),
            all_time: createEmptyMetrics()
        },
        all_rooms: {
            today: createEmptyMetrics(),
            '3d': createEmptyMetrics(),
            '7d': createEmptyMetrics(),
            '30d': createEmptyMetrics(),
            all_time: createEmptyMetrics()
        }
    };
}

function normalizeEvent(row = {}) {
    const timestamp = toValidDate(row.timestamp);
    const diamondCount = Number(row.diamondCount || 0);
    const repeatCount = Number(row.repeatCount || 1);
    const likeCount = Number(row.likeCount || 0);

    return {
        roomId: row.roomId || null,
        sessionId: row.sessionId || null,
        type: String(row.type || ''),
        timestamp,
        comment: row.comment || '',
        giftId: row.giftId || null,
        diamondCount,
        repeatCount,
        likeCount,
        giftValue: diamondCount * repeatCount
    };
}

function buildSessionKey(event) {
    if (event.sessionId) return event.sessionId;
    return `${event.roomId || 'unknown'}::${toDateKey(event.timestamp) || 'unknown'}`;
}

function median(numbers = []) {
    if (!numbers.length) return 0;
    const sorted = [...numbers].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return roundNumber((sorted[middle - 1] + sorted[middle]) / 2, 2);
    }
    return roundNumber(sorted[middle], 2);
}

function buildMetrics(events = []) {
    if (!Array.isArray(events) || events.length === 0) return createEmptyMetrics();

    let giftValue = 0;
    let giftCount = 0;
    let entryCount = 0;
    let danmuCount = 0;
    let likeCount = 0;
    let firstActiveAt = null;
    let lastActiveAt = null;
    const activeDays = new Set();
    const sessionSpans = new Map();

    for (const event of events) {
        const timestamp = toValidDate(event.timestamp);
        if (!timestamp) continue;

        const isoTimestamp = timestamp.toISOString();
        if (!firstActiveAt || isoTimestamp < firstActiveAt) firstActiveAt = isoTimestamp;
        if (!lastActiveAt || isoTimestamp > lastActiveAt) lastActiveAt = isoTimestamp;

        const dayKey = toDateKey(timestamp);
        if (dayKey) activeDays.add(dayKey);

        if (event.type === 'gift') {
            giftValue += Number(event.giftValue || 0);
            giftCount += Number(event.repeatCount || 0);
        }
        if (event.type === 'member') entryCount += 1;
        if (event.type === 'chat') danmuCount += 1;
        if (event.type === 'like') likeCount += Number(event.likeCount || 0);

        const sessionKey = buildSessionKey(event);
        const span = sessionSpans.get(sessionKey) || { start: timestamp, end: timestamp };
        if (timestamp < span.start) span.start = timestamp;
        if (timestamp > span.end) span.end = timestamp;
        sessionSpans.set(sessionKey, span);
    }

    const sessionMinutes = Array.from(sessionSpans.values()).map(span => {
        const durationMinutes = Math.ceil((span.end.getTime() - span.start.getTime()) / 60000);
        return Math.max(durationMinutes, 1);
    });
    const watchMinutes = sessionMinutes.reduce((sum, value) => sum + value, 0);
    const avgWatchMinutesPerEntry = entryCount > 0
        ? roundNumber(watchMinutes / entryCount, 2)
        : (sessionMinutes.length > 0 ? roundNumber(watchMinutes / sessionMinutes.length, 2) : 0);

    return {
        gift_value: giftValue,
        gift_count: giftCount,
        entry_count: entryCount,
        watch_minutes: watchMinutes,
        avg_watch_minutes_per_entry: avgWatchMinutesPerEntry,
        median_watch_minutes_per_entry: median(sessionMinutes),
        danmu_count: danmuCount,
        like_count: likeCount,
        share_count: 0,
        follow_count: 0,
        active_days: activeDays.size,
        active_sessions: sessionMinutes.length,
        last_active_at: lastActiveAt,
        first_active_at: firstActiveAt
    };
}

function filterByRoom(events = [], roomIds = []) {
    if (!Array.isArray(roomIds) || roomIds.length === 0) return [];
    const allowed = new Set(roomIds.filter(Boolean));
    return events.filter(event => event.roomId && allowed.has(event.roomId));
}

function filterByTime(events = [], timeKey, timeWindow = {}) {
    if (timeKey === 'all_time') return events;
    if (timeKey === 'current_session') {
        if (!timeWindow.sessionId) return [];
        return events.filter(event => event.sessionId && event.sessionId === timeWindow.sessionId);
    }
    if (!timeWindow.startAt) return [];
    return events.filter(event => event.timestamp && event.timestamp >= timeWindow.startAt);
}

function resolveCurrentRoomId(events = [], preferredRoomId = null, roomFilter = null) {
    const allowedRoomIds = Array.isArray(roomFilter) ? roomFilter.filter(Boolean) : null;
    const visibleEvents = allowedRoomIds
        ? events.filter(event => event.roomId && allowedRoomIds.includes(event.roomId))
        : events;
    const eventRoomIds = [...new Set(visibleEvents.map(event => event.roomId).filter(Boolean))];

    if (preferredRoomId && (!allowedRoomIds || allowedRoomIds.includes(preferredRoomId))) {
        return { roomId: preferredRoomId, resolvedBy: 'requested_room', eventRoomIds };
    }

    if (visibleEvents.length > 0) {
        const roomStats = new Map();
        for (const event of visibleEvents) {
            if (!event.roomId) continue;
            const stats = roomStats.get(event.roomId) || {
                roomId: event.roomId,
                giftValue: 0,
                lastActiveAt: null,
                eventCount: 0
            };
            stats.giftValue += Number(event.giftValue || 0);
            stats.eventCount += 1;
            const isoTimestamp = toIsoString(event.timestamp);
            if (isoTimestamp && (!stats.lastActiveAt || isoTimestamp > stats.lastActiveAt)) {
                stats.lastActiveAt = isoTimestamp;
            }
            roomStats.set(event.roomId, stats);
        }

        const bestByGift = [...roomStats.values()].sort((left, right) => {
            if (right.giftValue !== left.giftValue) return right.giftValue - left.giftValue;
            if ((right.lastActiveAt || '') !== (left.lastActiveAt || '')) return (right.lastActiveAt || '').localeCompare(left.lastActiveAt || '');
            return right.eventCount - left.eventCount;
        })[0];

        if (bestByGift?.roomId) {
            const resolvedBy = bestByGift.giftValue > 0 ? 'top_gift_room' : 'latest_active_room';
            return { roomId: bestByGift.roomId, resolvedBy, eventRoomIds };
        }
    }

    if (allowedRoomIds && allowedRoomIds.length > 0) {
        return { roomId: allowedRoomIds[0], resolvedBy: 'accessible_scope_default', eventRoomIds };
    }

    return { roomId: null, resolvedBy: 'no_room_data', eventRoomIds };
}

function resolveCurrentSessionId(events = [], currentRoomId = null) {
    if (!currentRoomId) return null;
    const roomEvents = events
        .filter(event => event.roomId === currentRoomId && event.sessionId)
        .sort((left, right) => (right.timestamp?.getTime() || 0) - (left.timestamp?.getTime() || 0));
    return roomEvents[0]?.sessionId || null;
}

function buildTimeWindows(currentSessionId = null, now = new Date()) {
    return {
        current_session: { sessionId: currentSessionId },
        today: { startAt: startOfToday(now) },
        '3d': { startAt: addDays(now, -3) },
        '7d': { startAt: addDays(now, -7) },
        '30d': { startAt: addDays(now, -30) },
        all_time: null
    };
}

async function loadRoomNameMap(roomIds = []) {
    const uniqueRoomIds = [...new Set((roomIds || []).filter(Boolean))];
    if (!uniqueRoomIds.length) return {};
    const placeholders = uniqueRoomIds.map(() => '?').join(',');
    const rows = await query(`SELECT room_id, name FROM room WHERE room_id IN (${placeholders})`, uniqueRoomIds);
    return Object.fromEntries(rows.map(row => [row.roomId, row.name || row.roomId]));
}

async function loadCustomerActivityEvents({ userId, roomFilter = null }) {
    if (!userId) return [];

    let roomFilterClause = '';
    const params = [userId];
    if (Array.isArray(roomFilter)) {
        if (roomFilter.length === 0) return [];
        const placeholders = roomFilter.map(() => '?').join(',');
        roomFilterClause = ` AND room_id IN (${placeholders})`;
        params.push(...roomFilter);
    }

    const rows = await query(`
        SELECT room_id, session_id, type, timestamp, comment, gift_id, diamond_count, repeat_count, like_count
        FROM event
        WHERE user_id = ? AND type IN ('gift', 'chat', 'like', 'member')${roomFilterClause}
        ORDER BY timestamp ASC
    `, params);

    return rows
        .map(normalizeEvent)
        .filter(event => event.timestamp);
}

async function buildCustomerMetricCube({
    userId,
    roomId = null,
    roomFilter = null,
    now = new Date(),
    events = null
} = {}) {
    const rawEvents = Array.isArray(events) ? events : await loadCustomerActivityEvents({ userId, roomFilter });
    const resolution = resolveCurrentRoomId(rawEvents, roomId, roomFilter);
    const currentRoomId = resolution.roomId;
    const currentSessionId = resolveCurrentSessionId(rawEvents, currentRoomId);
    const timeWindows = buildTimeWindows(currentSessionId, now);
    const metricCube = createEmptyMetricCube();
    const allRoomIds = [...new Set(rawEvents.map(event => event.roomId).filter(Boolean))];
    const roomNameMap = await loadRoomNameMap(currentRoomId ? [...allRoomIds, currentRoomId] : allRoomIds);
    const currentRoomEvents = filterByRoom(rawEvents, currentRoomId ? [currentRoomId] : []);
    const otherRoomEvents = filterByRoom(rawEvents, allRoomIds.filter(candidate => candidate !== currentRoomId));
    const allRoomEvents = filterByRoom(rawEvents, allRoomIds);

    const scopeEvents = {
        current_room: currentRoomEvents,
        other_rooms: otherRoomEvents,
        all_rooms: allRoomEvents
    };

    for (const spaceKey of SPACE_DIMENSIONS) {
        const sourceEvents = scopeEvents[spaceKey] || [];
        for (const timeKey of TIME_DIMENSIONS) {
            if (spaceKey !== 'current_room' && timeKey === 'current_session') continue;
            const filteredEvents = filterByTime(sourceEvents, timeKey, timeWindows[timeKey] || {});
            metricCube[spaceKey][timeKey] = buildMetrics(filteredEvents);
        }
    }

    return {
        version: CUSTOMER_METRIC_CUBE_VERSION,
        metricCube,
        currentRoom: {
            roomId: currentRoomId,
            roomName: currentRoomId ? (roomNameMap[currentRoomId] || currentRoomId) : null,
            resolvedBy: resolution.resolvedBy,
            availableRoomCount: Array.isArray(roomFilter) ? roomFilter.length : allRoomIds.length
        },
        currentSession: {
            sessionId: currentSessionId,
            lastActiveAt: metricCube.current_room.current_session.last_active_at || null
        },
        roomNameMap,
        rawEvents
    };
}

module.exports = {
    TIME_DIMENSIONS,
    SPACE_DIMENSIONS,
    CUSTOMER_METRIC_CUBE_VERSION,
    createEmptyMetrics,
    createEmptyMetricCube,
    loadCustomerActivityEvents,
    buildCustomerMetricCube
};
