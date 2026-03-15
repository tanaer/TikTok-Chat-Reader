const db = require('../db');
const { manager } = require('../manager');
const metricsService = require('./metricsService');
const { getSchemeAConfig } = require('./featureFlagService');
const cacheService = require('./cacheService');
const { runSessionMaintenanceTask } = require('./sessionMaintenanceService');
const {
    runRoomStatsRefreshJob,
    runUserStatsRefreshJob,
    runGlobalStatsRefreshJob,
} = require('./statsRefreshService');

const JOB_STATUS_QUEUED = 'queued';
const JOB_STATUS_PROCESSING = 'processing';
const JOB_STATUS_COMPLETED = 'completed';
const JOB_STATUS_FAILED = 'failed';
const ACTIVE_JOB_STATUSES = [JOB_STATUS_QUEUED, JOB_STATUS_PROCESSING];

const JOB_QUEUE_MAINTENANCE = 'maintenance';
const JOB_QUEUE_STATS = 'stats';

const JOB_TYPE_MIGRATE_EVENT_ROOM_IDS = 'maintenance.migrate_event_room_ids';
const JOB_TYPE_RENAME_ROOM = 'maintenance.rename_room';
const JOB_TYPE_REFRESH_ROOM_STATS = 'stats.refresh_room_stats';
const JOB_TYPE_REFRESH_USER_STATS = 'stats.refresh_user_stats';
const JOB_TYPE_REFRESH_GLOBAL_STATS = 'stats.refresh_global_stats';
const JOB_TYPE_SESSION_MAINTENANCE_PREFIX = 'session_maintenance.';
const ROOM_LIST_CACHE_VERSION_KEY = cacheService.buildCacheKey('room_list', 'version');
const ADMIN_ASYNC_JOB_HEARTBEAT_INTERVAL_MS = Math.max(5000, Number(process.env.ADMIN_ASYNC_JOB_HEARTBEAT_INTERVAL_MS || 15000));
const ADMIN_ASYNC_JOB_STALE_THRESHOLD_MS = Math.max(60000, Number(process.env.ADMIN_ASYNC_JOB_STALE_THRESHOLD_MS || 5 * 60 * 1000));

const SESSION_MAINTENANCE_TITLE_MAP = Object.freeze({
    cleanup_stale_live_events: '陈旧 LIVE 清理',
    archive_stale_live_events_room: '单房间陈旧 LIVE 归档',
    merge_continuity_sessions: '同日连续场次合并',
    consolidate_recent_sessions: '最近碎片场次扫描',
    fix_orphaned_events: '孤儿事件修复',
    delete_empty_sessions: '空场次清理',
    rebuild_missing_sessions: '缺失场次重建',
});

function safeJsonStringify(value) {
    if (value === undefined) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeJobRow(row) {
    const item = db.toCamelCase(row || {});
    return {
        id: Number(item.id || 0),
        queueName: String(item.queueName || ''),
        jobType: String(item.jobType || ''),
        title: String(item.title || ''),
        dedupeKey: String(item.dedupeKey || ''),
        createdByUserId: item.createdByUserId ? Number(item.createdByUserId) : null,
        status: String(item.status || JOB_STATUS_QUEUED),
        currentStep: String(item.currentStep || ''),
        progressPercent: Number(item.progressPercent || 0),
        attemptCount: Number(item.attemptCount || 0),
        requestPayload: item.requestPayload !== undefined
            ? safeJsonParse(item.requestPayload, item.requestPayload)
            : safeJsonParse(item.requestPayloadJson, {}),
        resultPayload: item.resultPayload !== undefined
            ? safeJsonParse(item.resultPayload, item.resultPayload)
            : safeJsonParse(item.resultJson, null),
        errorMessage: String(item.errorMessage || ''),
        source: String(item.source || ''),
        queuedAt: item.queuedAt || '',
        startedAt: item.startedAt || null,
        finishedAt: item.finishedAt || null,
        createdAt: item.createdAt || '',
        updatedAt: item.updatedAt || '',
    };
}

function isCompletedStatus(status) {
    return String(status || '').toLowerCase() === JOB_STATUS_COMPLETED;
}

function serializeAdminAsyncJob(job) {
    const item = normalizeJobRow(job);
    return {
        id: item.id,
        queueName: item.queueName,
        jobType: item.jobType,
        title: item.title,
        status: item.status,
        currentStep: item.currentStep,
        progressPercent: item.progressPercent,
        attemptCount: item.attemptCount,
        errorMessage: item.errorMessage,
        queuedAt: item.queuedAt,
        startedAt: item.startedAt,
        finishedAt: item.finishedAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
    };
}

function serializeAdminAsyncJobDetail(job) {
    const item = normalizeJobRow(job);
    return {
        ...serializeAdminAsyncJob(item),
        dedupeKey: item.dedupeKey,
        requestPayload: item.requestPayload || {},
        resultPayload: item.resultPayload,
        createdByUserId: item.createdByUserId,
        source: item.source,
    };
}

function sanitizeRoomRenameRequestPayload(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    return {
        oldRoomId: String(source.oldRoomId || '').trim(),
        newRoomId: String(source.newRoomId || '').trim(),
        mergeExisting: Boolean(source.mergeExisting),
    };
}

function sanitizeRoomRenameResultPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;

    const source = payload;
    const sanitized = {
        success: Boolean(source.success),
        oldRoomId: String(source.oldRoomId || '').trim(),
        newRoomId: String(source.newRoomId || '').trim(),
        mode: source.mode === 'merged' ? 'merged' : 'migrated',
        targetRoomExisted: Boolean(source.targetRoomExisted),
        deletedOldRoom: Boolean(source.deletedOldRoom),
    };

    if (source.room && typeof source.room === 'object') {
        sanitized.room = {
            roomId: String(source.room.roomId || '').trim(),
            name: String(source.room.name || '').trim(),
        };
    }

    const moved = source.moved && typeof source.moved === 'object' ? source.moved : null;
    if (moved) {
        sanitized.moved = {
            events: Number(moved.events || 0),
            sessions: Number(moved.sessions || 0),
        };
    }

    const associations = source.associations && typeof source.associations === 'object' ? source.associations : null;
    if (associations) {
        sanitized.associations = {
            mergedUsers: Number(associations.mergedUsers || 0),
        };
    }

    return sanitized;
}

function serializeRoomRenameJob(job, options = {}) {
    const item = normalizeJobRow(job);
    const serialized = {
        ...serializeAdminAsyncJob(item),
        requestPayload: sanitizeRoomRenameRequestPayload(item.requestPayload),
    };

    if (options.includeDetail) {
        serialized.resultPayload = sanitizeRoomRenameResultPayload(item.resultPayload);
    }

    return serialized;
}

function buildStablePayload(payload = {}) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const normalized = {};
    for (const key of Object.keys(source).sort()) {
        const value = source[key];
        if (value === undefined || value === null || value === '') continue;
        normalized[key] = value;
    }
    return normalized;
}

function buildSessionMaintenanceJobType(taskKey) {
    return `${JOB_TYPE_SESSION_MAINTENANCE_PREFIX}${String(taskKey || '').trim()}`;
}

function parseSessionMaintenanceTaskKey(jobType = '') {
    if (!String(jobType).startsWith(JOB_TYPE_SESSION_MAINTENANCE_PREFIX)) {
        return '';
    }
    return String(jobType).slice(JOB_TYPE_SESSION_MAINTENANCE_PREFIX.length);
}

function buildJobTitle(jobType, payload = {}) {
    switch (jobType) {
        case JOB_TYPE_RENAME_ROOM: {
            const oldRoomId = String(payload.oldRoomId || '').trim();
            const newRoomId = String(payload.newRoomId || '').trim();
            return payload.mergeExisting
                ? `合并房间 ${oldRoomId} -> ${newRoomId}`
                : `更新房间ID ${oldRoomId} -> ${newRoomId}`;
        }
        case JOB_TYPE_REFRESH_ROOM_STATS:
            return '刷新房间统计';
        case JOB_TYPE_REFRESH_USER_STATS:
            return '刷新用户统计';
        case JOB_TYPE_REFRESH_GLOBAL_STATS:
            return '刷新全局统计';
        case JOB_TYPE_MIGRATE_EVENT_ROOM_IDS:
            return '迁移事件房间标识';
        default: {
            const taskKey = parseSessionMaintenanceTaskKey(jobType);
            if (taskKey) {
                const baseTitle = SESSION_MAINTENANCE_TITLE_MAP[taskKey] || taskKey;
                if (taskKey === 'archive_stale_live_events_room' && payload.roomId) {
                    return `${baseTitle}（${payload.roomId}）`;
                }
                return baseTitle;
            }
            return jobType;
        }
    }
}

function resolveQueueName(jobType) {
    if (String(jobType).startsWith('stats.')) return JOB_QUEUE_STATS;
    return JOB_QUEUE_MAINTENANCE;
}

function buildDedupeKey(jobType, payload = {}) {
    const stablePayload = buildStablePayload(payload);
    return `${jobType}:${safeJsonStringify(stablePayload) || '{}'}`;
}

async function createAdminAsyncJob({
    jobType,
    requestPayload = {},
    createdByUserId = null,
    title = '',
    source = 'manual',
}) {
    const safeJobType = String(jobType || '').trim();
    if (!safeJobType) {
        throw new Error('jobType is required');
    }

    const payload = buildStablePayload(requestPayload);
    const queueName = resolveQueueName(safeJobType);
    const dedupeKey = buildDedupeKey(safeJobType, payload);
    const safeTitle = String(title || '').trim() || buildJobTitle(safeJobType, payload);

    const result = await db.pool.query(
        `INSERT INTO admin_async_job (
            queue_name, job_type, title, dedupe_key, created_by_user_id,
            status, current_step, progress_percent, attempt_count,
            request_payload_json, source, queued_at, created_at, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, NOW(), NOW(), NOW()
        )
        RETURNING *`,
        [
            queueName,
            safeJobType,
            safeTitle,
            dedupeKey,
            createdByUserId ? Number(createdByUserId) : null,
            JOB_STATUS_QUEUED,
            '等待后台执行',
            5,
            0,
            safeJsonStringify(payload),
            String(source || 'manual').trim() || 'manual',
        ]
    );

    return normalizeJobRow(result.rows[0]);
}

async function getReusableActiveAdminAsyncJob(jobType, requestPayload = {}) {
    const safeJobType = String(jobType || '').trim();
    if (!safeJobType) return null;
    const dedupeKey = buildDedupeKey(safeJobType, requestPayload);
    const result = await db.pool.query(
        `SELECT *
         FROM admin_async_job
         WHERE dedupe_key = $1
           AND status = ANY($2::text[])
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [dedupeKey, ACTIVE_JOB_STATUSES]
    );
    return result.rows[0] ? normalizeJobRow(result.rows[0]) : null;
}

async function getAdminAsyncJobById(jobId) {
    const safeJobId = Number(jobId || 0);
    if (!safeJobId) return null;
    const result = await db.pool.query(
        `SELECT * FROM admin_async_job WHERE id = $1 LIMIT 1`,
        [safeJobId]
    );
    return result.rows[0] ? normalizeJobRow(result.rows[0]) : null;
}

async function listAdminAsyncJobs(options = {}) {
    const limit = Math.max(1, Math.min(50, Number(options.limit || 10)));
    const status = String(options.status || '').trim();
    const queueName = String(options.queueName || '').trim();
    const createdByUserId = Number(options.createdByUserId || 0) || null;
    const jobTypes = Array.isArray(options.jobTypes)
        ? options.jobTypes.map((item) => String(item || '').trim()).filter(Boolean)
        : [];

    const whereClauses = [];
    const params = [];

    if (status) {
        params.push(status);
        whereClauses.push(`status = $${params.length}`);
    }
    if (queueName) {
        params.push(queueName);
        whereClauses.push(`queue_name = $${params.length}`);
    }
    if (createdByUserId) {
        params.push(createdByUserId);
        whereClauses.push(`created_by_user_id = $${params.length}`);
    }
    if (jobTypes.length > 0) {
        params.push(jobTypes);
        whereClauses.push(`job_type = ANY($${params.length}::text[])`);
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const listParams = [...params, limit];
    const result = await db.pool.query(
        `SELECT *
         FROM admin_async_job
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT $${listParams.length}`,
        listParams
    );

    const activeCountParams = [...params];
    activeCountParams.push(ACTIVE_JOB_STATUSES);
    const activeStatusClause = `status = ANY($${activeCountParams.length}::text[])`;
    const activeWhereSql = whereClauses.length
        ? `WHERE ${whereClauses.join(' AND ')} AND ${activeStatusClause}`
        : `WHERE ${activeStatusClause}`;
    const activeCountResult = await db.pool.query(
        `SELECT COUNT(*)::int AS count
         FROM admin_async_job
         ${activeWhereSql}`,
        activeCountParams
    );

    const jobs = result.rows.map((row) => serializeAdminAsyncJobDetail(row));
    const activeCount = Number(activeCountResult.rows[0]?.count || 0);
    return {
        jobs,
        activeCount,
    };
}

async function updateAdminAsyncJob(jobId, updates = {}) {
    const safeJobId = Number(jobId || 0);
    if (!safeJobId) return null;

    const mapping = {
        status: value => ['status = $VALUE', String(value || JOB_STATUS_QUEUED).trim()],
        currentStep: value => ['current_step = $VALUE', String(value || '').trim()],
        progressPercent: value => ['progress_percent = $VALUE', Math.max(0, Math.min(100, Number(value || 0)))],
        attemptCount: value => ['attempt_count = $VALUE', Math.max(0, Number(value || 0))],
        requestPayload: value => ['request_payload_json = $VALUE', safeJsonStringify(buildStablePayload(value || {}))],
        resultPayload: value => ['result_json = $VALUE', safeJsonStringify(value)],
        errorMessage: value => ['error_message = $VALUE', String(value || '').trim()],
        startedAt: value => ['started_at = $VALUE', value],
        finishedAt: value => ['finished_at = $VALUE', value],
        queuedAt: value => ['queued_at = $VALUE', value],
    };

    const sets = [];
    const params = [];
    let index = 0;

    for (const [key, rawValue] of Object.entries(updates || {})) {
        const builder = mapping[key];
        if (!builder) continue;
        const [template, value] = builder(rawValue);
        index += 1;
        sets.push(template.replace('$VALUE', `$${index}`));
        params.push(value);
    }

    if (!sets.length) {
        return getAdminAsyncJobById(safeJobId);
    }

    index += 1;
    params.push(safeJobId);
    const result = await db.pool.query(
        `UPDATE admin_async_job
         SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${index}
         RETURNING *`,
        params
    );
    return result.rows[0] ? normalizeJobRow(result.rows[0]) : null;
}

function startAdminAsyncJobHeartbeat(jobId, progressState = {}) {
    const safeJobId = Number(jobId || 0);
    if (!safeJobId) {
        return async () => {};
    }

    let stopped = false;
    let activeTick = Promise.resolve();
    const tick = async () => {
        if (stopped) return;
        const currentStep = String(progressState.currentStep || '后台正在执行').trim() || '后台正在执行';
        const progressPercent = Math.max(1, Math.min(99, Number(progressState.progressPercent || 0)));
        activeTick = updateAdminAsyncJob(safeJobId, {
            currentStep,
            progressPercent,
        }).catch((error) => {
            if (!stopped) {
                console.error(`[ADMIN_ASYNC_JOB] heartbeat failed for job ${safeJobId}:`, error.message);
            }
        });
        await activeTick;
    };

    const timer = setInterval(() => {
        tick().catch(() => {});
    }, ADMIN_ASYNC_JOB_HEARTBEAT_INTERVAL_MS);

    return async () => {
        stopped = true;
        clearInterval(timer);
        await activeTick.catch(() => {});
    };
}

async function recoverStaleAdminAsyncJobs(options = {}) {
    const queueName = String(options.queueName || '').trim();
    const limit = Math.max(1, Math.min(20, Number(options.limit || 5)));
    const whereClauses = [
        `status = $1`,
        `updated_at < (NOW() - ($2::double precision * INTERVAL '1 millisecond'))`,
    ];
    const params = [JOB_STATUS_PROCESSING, ADMIN_ASYNC_JOB_STALE_THRESHOLD_MS];

    if (queueName) {
        params.push(queueName);
        whereClauses.push(`queue_name = $${params.length}`);
    }

    params.push(limit);
    const result = await db.pool.query(
        `SELECT *
         FROM admin_async_job
         WHERE ${whereClauses.join(' AND ')}
         ORDER BY updated_at ASC, id ASC
         LIMIT $${params.length}`,
        params
    );

    if (!result.rows.length) {
        return { recoveredCount: 0, jobs: [] };
    }

    const recoveredJobs = [];
    for (const row of result.rows) {
        const job = normalizeJobRow(row);
        const recovered = await updateAdminAsyncJob(job.id, {
            status: JOB_STATUS_QUEUED,
            currentStep: '任务执行中断，正在重新排队',
            progressPercent: Math.max(5, Math.min(95, Number(job.progressPercent || 0))),
            errorMessage: '',
            queuedAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
        });
        recoveredJobs.push(recovered || job);
    }

    metricsService.emitLog('warn', 'admin.async_job.recovered', {
        queueName: queueName || 'all',
        recoveredCount: recoveredJobs.length,
        staleThresholdMs: ADMIN_ASYNC_JOB_STALE_THRESHOLD_MS,
        jobIds: recoveredJobs.map((job) => Number(job?.id || 0)).filter(Boolean),
    });

    return {
        recoveredCount: recoveredJobs.length,
        jobs: recoveredJobs,
    };
}

async function claimNextAdminAsyncJob(queueName) {
    const safeQueueName = String(queueName || '').trim();
    if (!safeQueueName) return null;

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const picked = await client.query(
            `SELECT *
             FROM admin_async_job
             WHERE queue_name = $1
               AND status = $2
             ORDER BY queued_at ASC, id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1`,
            [safeQueueName, JOB_STATUS_QUEUED]
        );

        if (!picked.rows[0]) {
            await client.query('COMMIT');
            return null;
        }

        const rawRow = db.toCamelCase(picked.rows[0]);
        const attemptCount = Number(rawRow.attemptCount || 0) + 1;
        const updated = await client.query(
            `UPDATE admin_async_job
             SET status = $2,
                 current_step = $3,
                 progress_percent = $4,
                 attempt_count = $5,
                 started_at = COALESCE(started_at, NOW()),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [
                rawRow.id,
                JOB_STATUS_PROCESSING,
                '后台正在执行',
                25,
                attemptCount,
            ]
        );

        await client.query('COMMIT');
        return normalizeJobRow(updated.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function markAdminAsyncJobCompleted(jobId, resultPayload = null, currentStep = '处理完成') {
    return updateAdminAsyncJob(jobId, {
        status: JOB_STATUS_COMPLETED,
        currentStep,
        progressPercent: 100,
        resultPayload,
        errorMessage: '',
        finishedAt: new Date().toISOString(),
    });
}

async function markAdminAsyncJobFailed(jobId, errorMessage = '', resultPayload = null, currentStep = '处理失败') {
    return updateAdminAsyncJob(jobId, {
        status: JOB_STATUS_FAILED,
        currentStep,
        progressPercent: 100,
        errorMessage,
        resultPayload,
        finishedAt: new Date().toISOString(),
    });
}

async function invalidateRoomListCacheVersion(reason = 'manual') {
    try {
        if (cacheService.isRoomCacheEnabled()) {
            await cacheService.increment(ROOM_LIST_CACHE_VERSION_KEY, 1);
        }
        metricsService.emitLog('info', 'admin.async_job.room_list_cache.invalidate', {
            reason,
            cacheBackend: cacheService.isRoomCacheEnabled() ? 'redis' : 'memory',
        });
    } catch (error) {
        console.error('[ADMIN_ASYNC_JOB] invalidate room list cache version failed:', error.message);
    }
}

function getQueueWorkerEnabled(queueName) {
    const config = getSchemeAConfig();
    if (queueName === JOB_QUEUE_STATS) {
        return Boolean(config.worker.enableStats);
    }
    return Boolean(config.worker.enableMaintenance);
}

async function executeAdminAsyncJob(job, options = {}) {
    const item = normalizeJobRow(job);
    const payload = buildStablePayload(item.requestPayload || {});
    const progressState = options.progressState && typeof options.progressState === 'object'
        ? options.progressState
        : null;
    const setStep = async (currentStep, progressPercent) => {
        const safeStep = String(currentStep || '后台正在执行');
        const safeProgressPercent = Math.max(1, Math.min(99, Number(progressPercent || 0)));
        if (progressState) {
            progressState.currentStep = safeStep;
            progressState.progressPercent = safeProgressPercent;
        }
        await updateAdminAsyncJob(item.id, {
            currentStep: safeStep,
            progressPercent: safeProgressPercent,
        });
    };

    switch (item.jobType) {
        case JOB_TYPE_RENAME_ROOM:
            return manager.migrateRoomId(payload.oldRoomId, payload.newRoomId, {
                mergeExisting: Boolean(payload.mergeExisting),
                onProgress: async (progress) => {
                    await setStep(progress?.step || '后台正在执行', progress?.progressPercent || 0);
                },
            });
        case JOB_TYPE_REFRESH_ROOM_STATS:
            return runRoomStatsRefreshJob(`admin-async-job:${item.id}`);
        case JOB_TYPE_REFRESH_USER_STATS:
            return runUserStatsRefreshJob(`admin-async-job:${item.id}`);
        case JOB_TYPE_REFRESH_GLOBAL_STATS:
            return runGlobalStatsRefreshJob(`admin-async-job:${item.id}`);
        case JOB_TYPE_MIGRATE_EVENT_ROOM_IDS:
            return manager.migrateEventRoomIds();
        default: {
            const taskKey = parseSessionMaintenanceTaskKey(item.jobType);
            if (!taskKey) {
                throw new Error(`未知后台任务类型: ${item.jobType}`);
            }
            await setStep('正在执行维护任务', 45);
            return runSessionMaintenanceTask(taskKey, {
                triggerSource: `admin-async-job:${item.id}`,
                roomId: payload.roomId,
                gapMinutes: payload.gapMinutes,
                lookbackHours: payload.lookbackHours,
            });
        }
    }
}

async function processOneAdminAsyncJob(queueName, options = {}) {
    const safeQueueName = String(queueName || '').trim();
    if (!safeQueueName) return null;

    const job = await claimNextAdminAsyncJob(safeQueueName);
    if (!job) return null;

    const runner = String(options.runner || 'worker').trim() || 'worker';
    metricsService.emitLog('info', 'admin.async_job', {
        jobId: job.id,
        queueName: job.queueName,
        jobType: job.jobType,
        runner,
        status: 'started',
    });
    const progressState = {
        currentStep: String(job.currentStep || '后台正在执行'),
        progressPercent: Math.max(1, Math.min(99, Number(job.progressPercent || 25))),
    };
    const stopHeartbeat = startAdminAsyncJobHeartbeat(job.id, progressState);

    try {
        const resultPayload = await executeAdminAsyncJob(job, { progressState });
        await stopHeartbeat();
        const completed = await markAdminAsyncJobCompleted(job.id, resultPayload);
        if (job.jobType === JOB_TYPE_RENAME_ROOM && isCompletedStatus(completed?.status)) {
            if (typeof options.invalidateRoomListCaches === 'function') {
                try {
                    await options.invalidateRoomListCaches('room rename async job');
                } catch (cacheError) {
                    console.error('[ADMIN_ASYNC_JOB] invalidate room list caches failed:', cacheError.message);
                }
            }
            await invalidateRoomListCacheVersion('room rename async job');
        }
        metricsService.emitLog('info', 'admin.async_job', {
            jobId: job.id,
            queueName: job.queueName,
            jobType: job.jobType,
            runner,
            status: 'completed',
        });
        return completed;
    } catch (error) {
        await stopHeartbeat();
        const safeErrorMessage = metricsService.safeErrorMessage(error);
        await markAdminAsyncJobFailed(job.id, safeErrorMessage);
        metricsService.emitLog('error', 'admin.async_job', {
            jobId: job.id,
            queueName: job.queueName,
            jobType: job.jobType,
            runner,
            status: 'failed',
            error: safeErrorMessage,
        });
        throw error;
    }
}

async function processAvailableAdminAsyncJobs(queueName, options = {}) {
    const maxJobs = Math.max(1, Number(options.maxJobs || 1));
    await recoverStaleAdminAsyncJobs({
        queueName,
        limit: options.recoverLimit || maxJobs,
    }).catch((error) => {
        console.error(`[ADMIN_ASYNC_JOB] failed to recover stale jobs for ${queueName}:`, error.message);
    });
    let processed = 0;

    while (processed < maxJobs) {
        const job = await processOneAdminAsyncJob(queueName, options).catch((error) => {
            console.error(`[ADMIN_ASYNC_JOB] ${queueName} job failed:`, error.message);
            return { failed: true };
        });
        if (!job) {
            break;
        }
        processed += 1;
    }

    return processed;
}

function kickAdminAsyncJobProcessorIfNeeded(queueName, reason = 'manual') {
    if (getQueueWorkerEnabled(queueName)) {
        return false;
    }

    setImmediate(() => {
        processAvailableAdminAsyncJobs(queueName, {
            maxJobs: 1,
            runner: `web-fallback:${reason}`,
        }).catch((error) => {
            console.error(`[ADMIN_ASYNC_JOB] fallback processor failed for ${queueName}:`, error.message);
        });
    });
    return true;
}

async function enqueueAdminAsyncJob({
    jobType,
    requestPayload = {},
    createdByUserId = null,
    source = 'manual',
}) {
    const existingJob = await getReusableActiveAdminAsyncJob(jobType, requestPayload);
    if (existingJob) {
        return {
            reused: true,
            queued: existingJob.status === JOB_STATUS_QUEUED,
            processing: existingJob.status === JOB_STATUS_PROCESSING,
            job: serializeAdminAsyncJob(existingJob),
        };
    }

    const job = await createAdminAsyncJob({
        jobType,
        requestPayload,
        createdByUserId,
        source,
    });

    kickAdminAsyncJobProcessorIfNeeded(job.queueName, source);

    return {
        reused: false,
        queued: true,
        processing: false,
        job: serializeAdminAsyncJob(job),
    };
}

async function enqueueSessionMaintenanceJob(taskKey, options = {}) {
    const safeTaskKey = String(taskKey || '').trim();
    if (!safeTaskKey) {
        throw new Error('taskKey is required');
    }
    return enqueueAdminAsyncJob({
        jobType: buildSessionMaintenanceJobType(safeTaskKey),
        requestPayload: {
            roomId: options.roomId,
            gapMinutes: options.gapMinutes,
            lookbackHours: options.lookbackHours,
        },
        createdByUserId: options.createdByUserId,
        source: options.source || 'manual',
    });
}

async function enqueueStatsRefreshJob(kind, options = {}) {
    const safeKind = String(kind || '').trim();
    const jobType = safeKind === 'room'
        ? JOB_TYPE_REFRESH_ROOM_STATS
        : safeKind === 'user'
            ? JOB_TYPE_REFRESH_USER_STATS
            : safeKind === 'global'
                ? JOB_TYPE_REFRESH_GLOBAL_STATS
                : '';
    if (!jobType) {
        throw new Error(`未知统计刷新类型: ${kind}`);
    }
    return enqueueAdminAsyncJob({
        jobType,
        requestPayload: {},
        createdByUserId: options.createdByUserId,
        source: options.source || 'manual',
    });
}

async function enqueueEventMigrationJob(options = {}) {
    return enqueueAdminAsyncJob({
        jobType: JOB_TYPE_MIGRATE_EVENT_ROOM_IDS,
        requestPayload: {},
        createdByUserId: options.createdByUserId,
        source: options.source || 'manual',
    });
}

async function enqueueRoomRenameJob(options = {}) {
    const oldRoomId = String(options.oldRoomId || '').trim();
    const newRoomId = String(options.newRoomId || '').trim();
    if (!oldRoomId || !newRoomId) {
        throw new Error('oldRoomId and newRoomId are required');
    }

    return enqueueAdminAsyncJob({
        jobType: JOB_TYPE_RENAME_ROOM,
        requestPayload: {
            oldRoomId,
            newRoomId,
            mergeExisting: Boolean(options.mergeExisting),
        },
        createdByUserId: options.createdByUserId,
        source: options.source || 'manual',
    });
}

module.exports = {
    JOB_QUEUE_MAINTENANCE,
    JOB_QUEUE_STATS,
    JOB_TYPE_MIGRATE_EVENT_ROOM_IDS,
    JOB_TYPE_RENAME_ROOM,
    JOB_TYPE_REFRESH_ROOM_STATS,
    JOB_TYPE_REFRESH_USER_STATS,
    JOB_TYPE_REFRESH_GLOBAL_STATS,
    JOB_TYPE_SESSION_MAINTENANCE_PREFIX,
    serializeAdminAsyncJob,
    serializeAdminAsyncJobDetail,
    serializeRoomRenameJob,
    getAdminAsyncJobById,
    listAdminAsyncJobs,
    getReusableActiveAdminAsyncJob,
    enqueueAdminAsyncJob,
    enqueueSessionMaintenanceJob,
    enqueueStatsRefreshJob,
    enqueueEventMigrationJob,
    enqueueRoomRenameJob,
    recoverStaleAdminAsyncJobs,
    processOneAdminAsyncJob,
    processAvailableAdminAsyncJobs,
};
