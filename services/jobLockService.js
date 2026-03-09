const crypto = require('crypto');
const db = require('../db');
const metricsService = require('./metricsService');

function buildAdvisoryLockIds(lockKey) {
    const normalizedLockKey = String(lockKey || '').trim() || 'default';
    const digest = crypto.createHash('sha256').update(normalizedLockKey).digest();
    return {
        key1: digest.readInt32BE(0),
        key2: digest.readInt32BE(4),
        normalizedLockKey,
    };
}

async function acquirePgAdvisoryLock(client, lockKey) {
    const lockIds = buildAdvisoryLockIds(lockKey);
    const result = await client.query(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [lockIds.key1, lockIds.key2]
    );

    return {
        acquired: Boolean(result.rows[0]?.acquired),
        lockIds,
    };
}

async function releasePgAdvisoryLock(client, lockKey) {
    const lockIds = buildAdvisoryLockIds(lockKey);
    await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        [lockIds.key1, lockIds.key2]
    );
    return lockIds;
}

async function withPgAdvisoryLock(lockKey, handler, options = {}) {
    const jobName = String(options.jobName || lockKey || 'job').trim();
    const client = options.client || await db.pool.connect();
    const shouldReleaseClient = !options.client;
    let acquired = false;
    let lockIds = null;

    try {
        const lockResult = await acquirePgAdvisoryLock(client, lockKey);
        acquired = lockResult.acquired;
        lockIds = lockResult.lockIds;

        if (!acquired) {
            metricsService.emitLog('warn', 'job.lock', {
                jobName,
                status: 'skipped',
                reason: 'lock_not_acquired',
                lockKey: lockIds.normalizedLockKey,
            });
            return {
                acquired: false,
                lockIds,
                result: null,
            };
        }

        metricsService.emitLog('info', 'job.lock', {
            jobName,
            status: 'acquired',
            lockKey: lockIds.normalizedLockKey,
        });

        const result = await handler({ client, lockIds });
        return {
            acquired: true,
            lockIds,
            result,
        };
    } finally {
        if (acquired && lockIds) {
            try {
                await releasePgAdvisoryLock(client, lockIds.normalizedLockKey);
                metricsService.emitLog('info', 'job.lock', {
                    jobName,
                    status: 'released',
                    lockKey: lockIds.normalizedLockKey,
                });
            } catch (error) {
                metricsService.emitLog('error', 'job.lock', {
                    jobName,
                    status: 'release_failed',
                    lockKey: lockIds.normalizedLockKey,
                    error: metricsService.safeErrorMessage(error),
                });
            }
        }

        if (shouldReleaseClient) {
            client.release();
        }
    }
}

module.exports = {
    buildAdvisoryLockIds,
    acquirePgAdvisoryLock,
    releasePgAdvisoryLock,
    withPgAdvisoryLock,
};
