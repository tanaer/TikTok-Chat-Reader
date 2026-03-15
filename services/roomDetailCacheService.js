const cacheService = require('./cacheService');

function buildRoomSessionsCacheKey(roomId) {
    return cacheService.buildCacheKey('room_detail', 'sessions', roomId);
}

function buildArchivedStatsDetailCacheKey(roomId, sessionId) {
    return cacheService.buildCacheKey('room_detail', 'stats_detail', roomId, sessionId);
}

async function invalidateRoomDetailCaches(roomId, sessionIds = []) {
    if (!roomId || !cacheService.isRoomCacheEnabled()) return;

    await cacheService.del(buildRoomSessionsCacheKey(roomId));

    const normalizedSessionIds = Array.from(new Set(
        (Array.isArray(sessionIds) ? sessionIds : [sessionIds])
            .map((sessionId) => String(sessionId || '').trim())
            .filter(Boolean)
    ));

    for (const sessionId of normalizedSessionIds) {
        await cacheService.del(buildArchivedStatsDetailCacheKey(roomId, sessionId));
    }
}

module.exports = {
    buildRoomSessionsCacheKey,
    buildArchivedStatsDetailCacheKey,
    invalidateRoomDetailCaches,
};
