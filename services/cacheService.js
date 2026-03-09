const metricsService = require('./metricsService');
const { getSchemeAConfig } = require('./featureFlagService');
const { withRedisClient, isRedisConfigured } = require('./redisClient');

const CACHE_KEY_PREFIX = 'tiktok_monitor';

function buildCacheKey(...parts) {
    return [CACHE_KEY_PREFIX, ...parts]
        .flat()
        .map(part => String(part || '').trim())
        .filter(Boolean)
        .join(':');
}

function isRoomCacheEnabled() {
    const schemeAConfig = getSchemeAConfig();
    return Boolean(isRedisConfigured() && schemeAConfig.redis.enableRoomCache);
}

async function getJson(key) {
    const startTime = Date.now();
    const result = await withRedisClient(async (client) => {
        const raw = await client.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    });

    metricsService.recordTiming('redis.cache.get_json.duration_ms', Date.now() - startTime, {
        enabled: isRoomCacheEnabled() ? 'true' : 'false',
        hit: result ? 'true' : 'false',
    }, { log: false });

    return result;
}

async function setJson(key, value, options = {}) {
    const ttlMs = Math.max(0, Number(options.ttlMs || 0));
    const serialized = JSON.stringify(value);
    const startTime = Date.now();

    const result = await withRedisClient(async (client) => {
        if (ttlMs > 0) {
            await client.set(key, serialized, { PX: ttlMs });
        } else {
            await client.set(key, serialized);
        }
        return true;
    });

    metricsService.recordTiming('redis.cache.set_json.duration_ms', Date.now() - startTime, {
        enabled: isRoomCacheEnabled() ? 'true' : 'false',
    }, { log: false });

    return Boolean(result);
}

async function getNumber(key) {
    const result = await withRedisClient(async (client) => {
        const raw = await client.get(key);
        if (raw === null || raw === undefined || raw === '') return null;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : null;
    });
    return result === null ? null : result;
}

async function increment(key, by = 1) {
    const result = await withRedisClient(async (client) => client.incrBy(key, by));
    return Number.isFinite(Number(result)) ? Number(result) : null;
}

async function del(key) {
    const result = await withRedisClient(async (client) => client.del(key));
    return Number(result || 0);
}

module.exports = {
    buildCacheKey,
    isRoomCacheEnabled,
    getJson,
    setJson,
    getNumber,
    increment,
    del,
};
