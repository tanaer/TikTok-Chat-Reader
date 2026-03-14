const cacheService = require('./cacheService');
const metricsService = require('./metricsService');
const { getSchemeAConfig } = require('./featureFlagService');
const { withRedisClient, isRedisConfigured } = require('./redisClient');

const LIVE_STATE_NAMESPACE = 'room_live';
const LIVE_STATE_SUMMARY_KEY = cacheService.buildCacheKey(LIVE_STATE_NAMESPACE, 'summary');
const LIVE_STATE_TTL_MS = 90000;
const LIVE_STATE_OFFLINE_TTL_MS = 30000;
const LIVE_STATE_FLUSH_INTERVAL_MS = 1000;

const localLiveStateCache = new Map();
const localLiveRoomIds = new Set();
const pendingFlushTimers = new Map();
const lastFlushAt = new Map();

function nowIso() {
    return new Date().toISOString();
}

function normalizeRoomId(roomId) {
    return String(roomId || '').trim();
}

function isLiveStateEnabled() {
    const schemeAConfig = getSchemeAConfig();
    return Boolean(isRedisConfigured() && schemeAConfig.redis.enableLiveState);
}

function buildRoomLiveKey(roomId) {
    return cacheService.buildCacheKey(LIVE_STATE_NAMESPACE, normalizeRoomId(roomId));
}

function getDefaultLiveState(roomId) {
    return {
        roomId: normalizeRoomId(roomId),
        isLive: false,
        lastEventAt: null,
        viewerCount: 0,
        giftValueLive: 0,
        chatCountLive: 0,
        currentSessionId: null,
        updatedAt: nowIso(),
    };
}

function toSafeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getStateUpdatedAtMs(payload) {
    if (!payload?.updatedAt) return 0;
    const updatedAtMs = new Date(payload.updatedAt).getTime();
    return Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
}

function pickLatestState(primaryState, secondaryState) {
    if (!primaryState) return secondaryState || null;
    if (!secondaryState) return primaryState;
    return getStateUpdatedAtMs(primaryState) >= getStateUpdatedAtMs(secondaryState) ? primaryState : secondaryState;
}

function readLocalLiveState(roomId) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) return null;

    const cached = localLiveStateCache.get(normalizedRoomId);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        localLiveStateCache.delete(normalizedRoomId);
        localLiveRoomIds.delete(normalizedRoomId);
        return null;
    }
    return cached.payload;
}

function writeLocalLiveState(roomId, payload, ttlMs) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId || !payload) return null;

    localLiveStateCache.set(normalizedRoomId, {
        payload,
        expiresAt: Date.now() + Math.max(1000, ttlMs || LIVE_STATE_TTL_MS),
    });

    if (payload.isLive) {
        localLiveRoomIds.add(normalizedRoomId);
    } else {
        localLiveRoomIds.delete(normalizedRoomId);
    }

    return payload;
}

function pruneStaleLocalLiveRooms(roomIds = []) {
    const staleRoomIds = [];
    const candidateRoomIds = roomIds.length > 0
        ? roomIds
        : Array.from(localLiveRoomIds);

    for (const roomId of candidateRoomIds) {
        const normalizedRoomId = normalizeRoomId(roomId);
        if (!normalizedRoomId) continue;

        const payload = readLocalLiveState(normalizedRoomId);
        if (isRoomLive(payload)) continue;

        localLiveRoomIds.delete(normalizedRoomId);
        if (payload && payload.isLive) {
            const nextState = {
                ...payload,
                isLive: false,
                updatedAt: nowIso(),
            };
            writeLocalLiveState(normalizedRoomId, nextState, LIVE_STATE_OFFLINE_TTL_MS);
        } else if (!payload) {
            localLiveStateCache.delete(normalizedRoomId);
        }
        staleRoomIds.push(normalizedRoomId);
    }

    return staleRoomIds;
}

function clearPendingFlush(roomId) {
    const normalizedRoomId = normalizeRoomId(roomId);
    const timer = pendingFlushTimers.get(normalizedRoomId);
    if (timer) {
        clearTimeout(timer);
        pendingFlushTimers.delete(normalizedRoomId);
    }
}

function mergeLiveState(previous, patch = {}) {
    const normalizedRoomId = normalizeRoomId(patch.roomId || previous?.roomId);
    if (!normalizedRoomId) return null;

    const baseState = patch.resetAggregates
        ? getDefaultLiveState(normalizedRoomId)
        : {
            ...getDefaultLiveState(normalizedRoomId),
            ...(previous || {}),
        };

    const nextState = {
        ...baseState,
        roomId: normalizedRoomId,
    };

    if (Object.prototype.hasOwnProperty.call(patch, 'isLive')) {
        nextState.isLive = Boolean(patch.isLive);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'viewerCount')) {
        nextState.viewerCount = Math.max(0, Math.round(toSafeNumber(patch.viewerCount, nextState.viewerCount)));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'giftValueLive')) {
        nextState.giftValueLive = Math.max(0, toSafeNumber(patch.giftValueLive, nextState.giftValueLive));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'giftValueDelta')) {
        nextState.giftValueLive = Math.max(0, toSafeNumber(nextState.giftValueLive, 0) + toSafeNumber(patch.giftValueDelta, 0));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'chatCountLive')) {
        nextState.chatCountLive = Math.max(0, Math.round(toSafeNumber(patch.chatCountLive, nextState.chatCountLive)));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'chatCountDelta')) {
        nextState.chatCountLive = Math.max(0, Math.round(toSafeNumber(nextState.chatCountLive, 0) + toSafeNumber(patch.chatCountDelta, 0)));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'currentSessionId')) {
        nextState.currentSessionId = patch.currentSessionId || null;
    }

    nextState.lastEventAt = patch.lastEventAt || nextState.lastEventAt || nowIso();
    nextState.updatedAt = nowIso();

    return nextState;
}

async function persistSummaryMembership(roomId, isLive) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId || !isLiveStateEnabled()) return false;

    const result = await withRedisClient(async (client) => {
        if (isLive) {
            await client.sAdd(LIVE_STATE_SUMMARY_KEY, normalizedRoomId);
        } else {
            await client.sRem(LIVE_STATE_SUMMARY_KEY, normalizedRoomId);
        }
        return true;
    });

    return Boolean(result);
}

async function flushRoomLiveState(roomId, ttlMs = LIVE_STATE_TTL_MS) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) return false;

    const payload = readLocalLiveState(normalizedRoomId);
    if (!payload) return false;
    if (!isLiveStateEnabled()) return false;

    const startTime = Date.now();
    const stored = await cacheService.setJson(buildRoomLiveKey(normalizedRoomId), payload, { ttlMs });
    if (!stored) {
        return false;
    }

    await persistSummaryMembership(normalizedRoomId, payload.isLive);
    lastFlushAt.set(normalizedRoomId, Date.now());
    metricsService.recordTiming('redis.live_state.flush.duration_ms', Date.now() - startTime, {
        isLive: payload.isLive ? 'true' : 'false',
    }, { log: false });
    return true;
}

function scheduleRoomLiveStateFlush(roomId, ttlMs = LIVE_STATE_TTL_MS) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId || !isLiveStateEnabled() || pendingFlushTimers.has(normalizedRoomId)) {
        return;
    }

    const elapsedMs = Date.now() - (lastFlushAt.get(normalizedRoomId) || 0);
    const delayMs = Math.max(0, LIVE_STATE_FLUSH_INTERVAL_MS - elapsedMs);
    const timer = setTimeout(() => {
        pendingFlushTimers.delete(normalizedRoomId);
        flushRoomLiveState(normalizedRoomId, ttlMs).catch((error) => {
            metricsService.emitLog('warn', 'redis.live_state.flush', {
                roomId: normalizedRoomId,
                error: metricsService.safeErrorMessage(error),
            });
        });
    }, delayMs);

    pendingFlushTimers.set(normalizedRoomId, timer);
}

function isRoomLive(liveState) {
    if (!liveState || liveState.isLive !== true) return false;
    if (!liveState.lastEventAt) return true;

    const lastEventAtMs = new Date(liveState.lastEventAt).getTime();
    if (!Number.isFinite(lastEventAtMs)) return true;
    return (Date.now() - lastEventAtMs) <= (LIVE_STATE_TTL_MS + LIVE_STATE_FLUSH_INTERVAL_MS * 2);
}

async function markRoomLive(roomId, patch = {}) {
    try {
        const normalizedRoomId = normalizeRoomId(roomId);
        if (!normalizedRoomId) return null;

        let baseState = readLocalLiveState(normalizedRoomId);
        if (!baseState && !patch.resetAggregates && isLiveStateEnabled()) {
            baseState = await cacheService.getJson(buildRoomLiveKey(normalizedRoomId));
        }

        const nextState = mergeLiveState(baseState, {
            ...patch,
            roomId: normalizedRoomId,
            isLive: true,
            lastEventAt: patch.lastEventAt || nowIso(),
        });

        writeLocalLiveState(normalizedRoomId, nextState, LIVE_STATE_TTL_MS);
        clearPendingFlush(normalizedRoomId);

        if (isLiveStateEnabled()) {
            await flushRoomLiveState(normalizedRoomId, LIVE_STATE_TTL_MS);
        }

        return nextState;
    } catch (error) {
        metricsService.emitLog('warn', 'redis.live_state.mark_live', {
            roomId: normalizeRoomId(roomId),
            error: metricsService.safeErrorMessage(error),
        });
        return null;
    }
}

async function touchRoomLive(roomId, patch = {}) {
    try {
        const normalizedRoomId = normalizeRoomId(roomId);
        if (!normalizedRoomId) return null;

        const nextState = mergeLiveState(readLocalLiveState(normalizedRoomId), {
            ...patch,
            roomId: normalizedRoomId,
            isLive: true,
            lastEventAt: patch.lastEventAt || nowIso(),
        });

        writeLocalLiveState(normalizedRoomId, nextState, LIVE_STATE_TTL_MS);
        scheduleRoomLiveStateFlush(normalizedRoomId, LIVE_STATE_TTL_MS);
        return nextState;
    } catch (error) {
        metricsService.emitLog('warn', 'redis.live_state.touch', {
            roomId: normalizeRoomId(roomId),
            error: metricsService.safeErrorMessage(error),
        });
        return null;
    }
}

async function markRoomOffline(roomId, patch = {}) {
    try {
        const normalizedRoomId = normalizeRoomId(roomId);
        if (!normalizedRoomId) return null;

        const localState = readLocalLiveState(normalizedRoomId);
        const baseState = localState || (isLiveStateEnabled() ? await cacheService.getJson(buildRoomLiveKey(normalizedRoomId)) : null);
        const nextState = mergeLiveState(baseState, {
            ...patch,
            roomId: normalizedRoomId,
            isLive: false,
            lastEventAt: patch.lastEventAt || localState?.lastEventAt || baseState?.lastEventAt || nowIso(),
        });

        clearPendingFlush(normalizedRoomId);
        writeLocalLiveState(normalizedRoomId, nextState, LIVE_STATE_OFFLINE_TTL_MS);

        if (isLiveStateEnabled()) {
            await flushRoomLiveState(normalizedRoomId, LIVE_STATE_OFFLINE_TTL_MS);
        }

        return nextState;
    } catch (error) {
        metricsService.emitLog('warn', 'redis.live_state.mark_offline', {
            roomId: normalizeRoomId(roomId),
            error: metricsService.safeErrorMessage(error),
        });
        return null;
    }
}

async function getLiveState(roomId) {
    try {
        const normalizedRoomId = normalizeRoomId(roomId);
        if (!normalizedRoomId) return null;

        const localState = readLocalLiveState(normalizedRoomId);
        const localUpdatedAtMs = getStateUpdatedAtMs(localState);
        if (!isLiveStateEnabled()) {
            return localState;
        }

        if (localState && (Date.now() - localUpdatedAtMs) <= (LIVE_STATE_FLUSH_INTERVAL_MS * 2)) {
            return localState;
        }

        const redisState = await cacheService.getJson(buildRoomLiveKey(normalizedRoomId));
        const nextState = pickLatestState(localState, redisState);
        if (nextState) {
            writeLocalLiveState(normalizedRoomId, nextState, nextState.isLive ? LIVE_STATE_TTL_MS : LIVE_STATE_OFFLINE_TTL_MS);
        }
        return nextState;
    } catch (error) {
        metricsService.emitLog('warn', 'redis.live_state.get', {
            roomId: normalizeRoomId(roomId),
            error: metricsService.safeErrorMessage(error),
        });
        return readLocalLiveState(roomId);
    }
}

async function getLiveStateMap(roomIds = []) {
    try {
        const normalizedRoomIds = Array.from(new Set((roomIds || []).map(normalizeRoomId).filter(Boolean)));
        if (normalizedRoomIds.length === 0) return {};

        const localStates = Object.fromEntries(
            normalizedRoomIds
                .map((roomId) => [roomId, readLocalLiveState(roomId)])
                .filter(([, payload]) => Boolean(payload))
        );

        if (!isLiveStateEnabled()) {
            return localStates;
        }

        const startTime = Date.now();
        const rawStates = await withRedisClient(async (client) => client.mGet(normalizedRoomIds.map(buildRoomLiveKey)));
        const liveStateMap = { ...localStates };

        if (Array.isArray(rawStates)) {
            rawStates.forEach((rawValue, index) => {
                if (!rawValue) return;
                try {
                    const payload = JSON.parse(rawValue);
                    const roomId = normalizedRoomIds[index];
                    const nextState = pickLatestState(liveStateMap[roomId], payload);
                    if (!nextState) return;
                    liveStateMap[roomId] = nextState;
                    writeLocalLiveState(roomId, nextState, nextState.isLive ? LIVE_STATE_TTL_MS : LIVE_STATE_OFFLINE_TTL_MS);
                } catch (error) {
                    metricsService.emitLog('warn', 'redis.live_state.parse', {
                        roomId: normalizedRoomIds[index],
                        error: metricsService.safeErrorMessage(error),
                    });
                }
            });
        }

        metricsService.recordTiming('redis.live_state.get_many.duration_ms', Date.now() - startTime, {
            roomCount: normalizedRoomIds.length,
        }, { log: false });

        return liveStateMap;
    } catch (error) {
        metricsService.emitLog('warn', 'redis.live_state.get_many', {
            roomCount: Array.isArray(roomIds) ? roomIds.length : 0,
            error: metricsService.safeErrorMessage(error),
        });
        return Object.fromEntries(
            (roomIds || [])
                .map((roomId) => [normalizeRoomId(roomId), readLocalLiveState(roomId)])
                .filter(([roomId, payload]) => Boolean(roomId && payload))
        );
    }
}

async function listLiveRoomIds() {
    try {
        const staleLocalRoomIds = pruneStaleLocalLiveRooms();
        if (!isLiveStateEnabled()) {
            return Array.from(localLiveRoomIds);
        }

        const startTime = Date.now();
        const summaryMembers = await withRedisClient(async (client) => client.sMembers(LIVE_STATE_SUMMARY_KEY));
        const normalizedRoomIds = Array.from(new Set((summaryMembers || []).map(normalizeRoomId).filter(Boolean)));

        if (normalizedRoomIds.length === 0) {
            return Array.from(localLiveRoomIds);
        }

        const liveStateMap = await getLiveStateMap(normalizedRoomIds);
        const liveRoomIds = [];
        const staleRoomIds = [];

        for (const roomId of normalizedRoomIds) {
            if (isRoomLive(liveStateMap[roomId])) {
                liveRoomIds.push(roomId);
            } else {
                staleRoomIds.push(roomId);
            }
        }

        if (staleRoomIds.length > 0) {
            await withRedisClient(async (client) => {
                await client.sRem(LIVE_STATE_SUMMARY_KEY, staleRoomIds);
                return true;
            });
        }

        metricsService.recordTiming('redis.live_state.list_live_ids.duration_ms', Date.now() - startTime, {
            roomCount: normalizedRoomIds.length,
            liveCount: liveRoomIds.length,
        }, { log: false });

        const mergedLiveRoomIds = Array.from(new Set([...liveRoomIds, ...Array.from(localLiveRoomIds)]));
        if (staleLocalRoomIds.length > 0) {
            return mergedLiveRoomIds.filter((roomId) => !staleLocalRoomIds.includes(roomId));
        }
        return mergedLiveRoomIds;
    } catch (error) {
        metricsService.emitLog('warn', 'redis.live_state.list_live_ids', {
            error: metricsService.safeErrorMessage(error),
        });
        pruneStaleLocalLiveRooms();
        return Array.from(localLiveRoomIds);
    }
}

function shutdownLiveStateService() {
    for (const timer of pendingFlushTimers.values()) {
        clearTimeout(timer);
    }
    pendingFlushTimers.clear();
    lastFlushAt.clear();
}

module.exports = {
    LIVE_STATE_TTL_MS,
    LIVE_STATE_OFFLINE_TTL_MS,
    isLiveStateEnabled,
    buildRoomLiveKey,
    isRoomLive,
    markRoomLive,
    touchRoomLive,
    markRoomOffline,
    getLiveState,
    getLiveStateMap,
    listLiveRoomIds,
    shutdownLiveStateService,
};
