const { createClient } = require('redis');
const metricsService = require('./metricsService');
const { getSchemeAConfig } = require('./featureFlagService');

let redisClient = null;
let connectPromise = null;
let activeRedisUrl = '';
let listenersBound = false;
let redisRetryAfter = 0;
const REDIS_RETRY_COOLDOWN_MS = 5000;
const REDIS_CONNECT_TIMEOUT_MS = 1500;

function getRedisUrl() {
    return String(getSchemeAConfig().redis.url || '').trim();
}

function isRedisConfigured() {
    return Boolean(getRedisUrl());
}

function bindClientListeners(client) {
    if (!client || listenersBound) return;
    listenersBound = true;

    client.on('error', (error) => {
        metricsService.emitLog('warn', 'redis.client', {
            status: 'error',
            error: metricsService.safeErrorMessage(error),
        });
    });

    client.on('connect', () => {
        metricsService.emitLog('info', 'redis.client', {
            status: 'connect',
            urlConfigured: Boolean(activeRedisUrl),
        });
    });

    client.on('ready', () => {
        metricsService.emitLog('info', 'redis.client', {
            status: 'ready',
        });
    });

    client.on('end', () => {
        metricsService.emitLog('warn', 'redis.client', {
            status: 'end',
        });
    });
}

async function disconnectRedisClient() {
    if (!redisClient) return;

    const current = redisClient;
    redisClient = null;
    connectPromise = null;
    activeRedisUrl = '';
    listenersBound = false;
    redisRetryAfter = 0;

    try {
        if (current.isOpen) {
            await current.quit();
        }
    } catch (error) {
        try {
            current.disconnect();
        } catch (_) {
        }
        metricsService.emitLog('warn', 'redis.client', {
            status: 'disconnect_error',
            error: metricsService.safeErrorMessage(error),
        });
    }
}

function createRedisClient(url) {
    const client = createClient({
        url,
        socket: {
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            reconnectStrategy(retries) {
                return Math.min(2000, Math.max(100, retries * 200));
            },
        },
    });
    bindClientListeners(client);
    return client;
}

async function connectClientWithTimeout(client) {
    let timeoutId = null;

    try {
        return await Promise.race([
            client.connect().then(() => client),
            new Promise((resolve) => {
                timeoutId = setTimeout(() => resolve(null), REDIS_CONNECT_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

async function getRedisClient() {
    const redisUrl = getRedisUrl();
    if (!redisUrl) {
        return null;
    }

    if (activeRedisUrl && activeRedisUrl !== redisUrl) {
        await disconnectRedisClient();
    }

    if (redisRetryAfter > Date.now()) {
        return null;
    }

    if (!redisClient) {
        redisClient = createRedisClient(redisUrl);
        activeRedisUrl = redisUrl;
    }

    if (redisClient.isOpen) {
        redisRetryAfter = 0;
        return redisClient;
    }

    if (!connectPromise) {
        connectPromise = connectClientWithTimeout(redisClient)
            .then((client) => {
                if (client && client.isOpen) {
                    redisRetryAfter = 0;
                    return client;
                }

                try {
                    redisClient?.disconnect();
                } catch (_) {
                }
                redisRetryAfter = Date.now() + REDIS_RETRY_COOLDOWN_MS;
                metricsService.emitLog('warn', 'redis.client', {
                    status: 'connect_timeout',
                    retryAfterMs: REDIS_RETRY_COOLDOWN_MS,
                    connectTimeoutMs: REDIS_CONNECT_TIMEOUT_MS,
                });
                redisClient = null;
                activeRedisUrl = '';
                listenersBound = false;
                return null;
            })
            .catch(async (error) => {
                redisRetryAfter = Date.now() + REDIS_RETRY_COOLDOWN_MS;
                metricsService.emitLog('warn', 'redis.client', {
                    status: 'connect_failed',
                    retryAfterMs: REDIS_RETRY_COOLDOWN_MS,
                    connectTimeoutMs: REDIS_CONNECT_TIMEOUT_MS,
                    error: metricsService.safeErrorMessage(error),
                });
                try {
                    redisClient?.disconnect();
                } catch (_) {
                }
                redisClient = null;
                activeRedisUrl = '';
                listenersBound = false;
                return null;
            })
            .finally(() => {
                connectPromise = null;
            });
    }

    return connectPromise;
}

async function withRedisClient(fn) {
    const client = await getRedisClient();
    if (!client) return null;

    try {
        return await fn(client);
    } catch (error) {
        metricsService.emitLog('warn', 'redis.client', {
            status: 'operation_failed',
            error: metricsService.safeErrorMessage(error),
        });
        return null;
    }
}

async function testRedisConnection(rawUrl = '') {
    const redisUrl = String(rawUrl || getRedisUrl() || '').trim();
    if (!redisUrl) {
        return {
            success: false,
            error: 'Redis URL 不能为空',
            code: 'REDIS_URL_REQUIRED',
        };
    }

    const client = createClient({
        url: redisUrl,
        socket: {
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            reconnectStrategy: false,
        },
    });

    const startedAt = Date.now();
    try {
        await Promise.race([
            client.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Redis 连接超时')), REDIS_CONNECT_TIMEOUT_MS)),
        ]);
        const pong = await client.ping();
        return {
            success: true,
            latencyMs: Date.now() - startedAt,
            pong,
        };
    } catch (error) {
        return {
            success: false,
            latencyMs: Date.now() - startedAt,
            error: metricsService.safeErrorMessage(error),
            code: 'REDIS_TEST_FAILED',
        };
    } finally {
        try {
            if (client.isOpen) {
                await client.quit();
            } else {
                client.disconnect();
            }
        } catch (_) {
        }
    }
}

module.exports = {
    isRedisConfigured,
    getRedisClient,
    withRedisClient,
    disconnectRedisClient,
    testRedisConnection,
};
