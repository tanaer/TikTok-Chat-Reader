const db = require('../db');

const AI_WORK_JOB_TYPE_SESSION_RECAP = 'session_recap';
const AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS = 'customer_analysis';
const AI_WORK_ACTIVE_STATUSES = ['queued', 'processing'];
const AI_WORK_FINAL_STATUSES = ['completed', 'failed', 'canceled'];

function normalizeAiWorkStatus(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (['queued', 'processing', 'completed', 'failed', 'canceled'].includes(raw)) return raw;
    return 'queued';
}

function normalizeAiWorkJobType(value) {
    const raw = String(value || '').trim().toLowerCase();
    if ([AI_WORK_JOB_TYPE_SESSION_RECAP, AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS].includes(raw)) return raw;
    return AI_WORK_JOB_TYPE_SESSION_RECAP;
}

function safeJsonParse(rawValue, fallback = null) {
    if (rawValue === null || rawValue === undefined || rawValue === '') return fallback;
    if (typeof rawValue !== 'string') return rawValue;
    try {
        return JSON.parse(rawValue);
    } catch {
        return fallback;
    }
}

function safeJsonStringify(value) {
    if (value === undefined) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({ error: 'json_stringify_failed' });
    }
}

function buildAiWorkTitle(jobType, { roomId = '', sessionId = '', targetUserId = '', targetNickname = '' } = {}) {
    const normalizedJobType = normalizeAiWorkJobType(jobType);
    if (normalizedJobType === AI_WORK_JOB_TYPE_SESSION_RECAP) {
        return `AI直播复盘 · 房间 ${roomId || '-'} · 场次 ${sessionId || '-'}`;
    }
    if (normalizedJobType === AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS) {
        const userLabel = targetNickname
            ? `${targetNickname} (${targetUserId || '-'})`
            : (targetUserId || '-');
        return `客户价值深度挖掘 · 用户 ${userLabel}${roomId ? ` · 房间 ${roomId}` : ''}`;
    }
    return `AI工作 · ${roomId || '-'} · ${sessionId || '-'}`;
}

function buildCustomerAnalysisActionUrl(requestPayload = {}) {
    const analysisScene = String(requestPayload?.analysisScene || '').trim().toLowerCase();
    const targetUserId = String(requestPayload?.targetUserId || '').trim();
    const targetNickname = String(requestPayload?.targetNickname || '').trim();
    const targetUniqueId = String(requestPayload?.targetUniqueId || '').trim();
    const roomName = String(requestPayload?.roomName || requestPayload?.currentRoomName || '').trim();

    if (analysisScene === 'personality' || !String(requestPayload?.currentRoomId || requestPayload?.requestedRoomId || '').trim()) {
        if (!targetUserId) return '/monitor.html?section=userAnalysis';
        const params = new URLSearchParams({
            section: 'userAnalysis',
            analysisUserId: targetUserId
        });
        if (targetNickname) params.set('analysisNickname', targetNickname);
        if (targetUniqueId) params.set('analysisUniqueId', targetUniqueId);
        return `/monitor.html?${params.toString()}`;
    }

    const roomId = String(requestPayload?.currentRoomId || requestPayload?.requestedRoomId || '').trim();
    if (!roomId || !targetUserId) return '/monitor.html?section=roomDetail';

    const params = new URLSearchParams({
        roomId,
        detailTab: 'timeStats',
        customerAnalysisUserId: targetUserId
    });
    if (roomName) params.set('roomName', roomName);
    if (targetNickname) params.set('customerAnalysisNickname', targetNickname);
    if (targetUniqueId) params.set('customerAnalysisUniqueId', targetUniqueId);
    return `/monitor.html?${params.toString()}`;
}

function buildAiWorkActionUrl(jobType, { roomId = '', sessionId = '', roomName = '', requestPayload = null } = {}) {
    const normalizedJobType = normalizeAiWorkJobType(jobType);
    if (normalizedJobType === AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS) {
        return buildCustomerAnalysisActionUrl(requestPayload || {});
    }
    const params = new URLSearchParams({
        roomId: String(roomId || ''),
        sessionId: String(sessionId || ''),
        detailTab: 'timeStats'
    });
    if (roomName) params.set('roomName', String(roomName || ''));
    return `/monitor.html?${params.toString()}`;
}

function getAiWorkJobTypeLabel(jobType) {
    const normalizedJobType = normalizeAiWorkJobType(jobType);
    if (normalizedJobType === AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS) return '用户';
    if (normalizedJobType === AI_WORK_JOB_TYPE_SESSION_RECAP) return '房间';
    return '其他';
}

function extractAiWorkSummary(jobType, resultPayload = {}) {
    const normalizedJobType = normalizeAiWorkJobType(jobType);
    if (normalizedJobType === AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS) {
        const analysisScene = String(resultPayload?.analysisScene || '').trim().toLowerCase();
        if (analysisScene === 'personality') {
            return String(resultPayload?.summary || resultPayload?.result || '').trim();
        }
        return String(resultPayload?.analysis?.summary || resultPayload?.summary || resultPayload?.result || '').trim();
    }
    const review = resultPayload?.review || resultPayload?.aiReview || resultPayload?.result || null;
    return String(review?.bossSummary || review?.summary || '').trim();
}

function hasAiWorkResult(jobType, resultPayload = {}) {
    const normalizedJobType = normalizeAiWorkJobType(jobType);
    if (normalizedJobType === AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS) {
        const analysisScene = String(resultPayload?.analysisScene || '').trim().toLowerCase();
        if (analysisScene === 'personality') {
            return Boolean(resultPayload?.result || resultPayload?.summary);
        }
        return Boolean(resultPayload?.analysis || resultPayload?.result || resultPayload?.summary);
    }
    return Boolean(resultPayload?.review || resultPayload?.aiReview || resultPayload?.result);
}

function serializeAiWorkLog(row = {}) {
    const item = db.toCamelCase(row || {});
    return {
        id: Number(item.id || 0),
        jobId: Number(item.jobId || 0),
        phase: String(item.phase || ''),
        level: String(item.level || 'info'),
        message: String(item.message || ''),
        payload: safeJsonParse(item.payloadJson, null),
        createdAt: item.createdAt || ''
    };
}

function serializeUserAiWorkJob(row = {}) {
    const item = db.toCamelCase(row || {});
    const normalizedJobType = normalizeAiWorkJobType(item.jobType);
    const requestPayload = safeJsonParse(item.requestPayloadJson, {}) || {};
    const resultPayload = safeJsonParse(item.resultJson, {}) || {};
    const targetUserId = String(requestPayload?.targetUserId || '').trim();
    const targetNickname = String(requestPayload?.targetNickname || '').trim();
    const targetUniqueId = String(requestPayload?.targetUniqueId || '').trim();
    const summary = extractAiWorkSummary(normalizedJobType, resultPayload);
    const hasResult = hasAiWorkResult(normalizedJobType, resultPayload);
    return {
        id: Number(item.id || 0),
        jobType: normalizedJobType,
        jobTypeLabel: getAiWorkJobTypeLabel(normalizedJobType),
        title: String(item.title || ''),
        roomId: String(item.roomId || ''),
        sessionId: String(item.sessionId || ''),
        targetUserId,
        targetNickname,
        targetUniqueId,
        actionUrl: buildAiWorkActionUrl(normalizedJobType, {
            roomId: item.roomId,
            sessionId: item.sessionId,
            roomName: requestPayload?.roomName || '',
            requestPayload
        }),
        status: normalizeAiWorkStatus(item.status),
        currentStep: String(item.currentStep || ''),
        progressPercent: Number(item.progressPercent || 0),
        pointCost: Number(item.pointCost || 0),
        chargedPoints: Number(item.chargedPoints || 0),
        forceRegenerate: Boolean(item.forceRegenerate),
        modelName: String(item.modelName || ''),
        summary,
        hasResult,
        resultReady: hasResult,
        errorMessage: item.status === 'failed' ? String(item.errorMessage || '处理失败，请稍后重试') : '',
        notificationSent: Boolean(item.notificationSent),
        queuedAt: item.queuedAt || item.createdAt || '',
        startedAt: item.startedAt || '',
        finishedAt: item.finishedAt || '',
        createdAt: item.createdAt || '',
        updatedAt: item.updatedAt || ''
    };
}

function serializeAdminAiWorkJob(row = {}) {
    const item = db.toCamelCase(row || {});
    return {
        ...serializeUserAiWorkJob(item),
        userId: Number(item.userId || 0),
        username: String(item.username || ''),
        nickname: String(item.nickname || ''),
        isAdmin: Boolean(item.isAdmin),
        attemptCount: Number(item.attemptCount || 0),
        requestPayload: safeJsonParse(item.requestPayloadJson, null),
        resultPayload: safeJsonParse(item.resultJson, null),
        latestLogAt: item.latestLogAt || ''
    };
}

async function createAiWorkJob({
    userId,
    jobType = AI_WORK_JOB_TYPE_SESSION_RECAP,
    roomId = '',
    sessionId = '',
    title = '',
    pointCost = 0,
    forceRegenerate = false,
    isAdmin = false,
    requestPayload = null,
    client = null
}) {
    const safeJobType = normalizeAiWorkJobType(jobType);
    const safeTitle = String(title || '').trim() || buildAiWorkTitle(safeJobType, { roomId, sessionId });
    const executor = client || db.pool;
    const result = await executor.query(
        `INSERT INTO ai_work_job (
            user_id, job_type, room_id, session_id, title, status, current_step,
            progress_percent, point_cost, charged_points, force_regenerate, is_admin,
            request_payload_json, notification_sent, queued_at, created_at, updated_at
        )
         VALUES ($1, $2, $3, $4, $5, 'queued', '等待调度', 5, $6, 0, $7, $8, $9, FALSE, NOW(), NOW(), NOW())
         RETURNING *`,
        [
            userId,
            safeJobType,
            String(roomId || ''),
            String(sessionId || ''),
            safeTitle,
            Number(pointCost || 0),
            Boolean(forceRegenerate),
            Boolean(isAdmin),
            safeJsonStringify(requestPayload)
        ]
    );
    return serializeAdminAiWorkJob(result.rows[0]);
}

async function appendAiWorkJobLog(jobId, { phase = '', level = 'info', message = '', payload = null } = {}) {
    const safeJobId = Number(jobId || 0);
    if (!safeJobId) return null;
    const safeMessage = String(message || '').trim();
    if (!safeMessage) return null;

    const result = await db.pool.query(
        `INSERT INTO ai_work_job_log (job_id, phase, level, message, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [
            safeJobId,
            String(phase || '').trim(),
            String(level || 'info').trim().toLowerCase(),
            safeMessage,
            safeJsonStringify(payload)
        ]
    );
    return serializeAiWorkLog(result.rows[0]);
}

async function updateAiWorkJob(jobId, updates = {}) {
    const safeJobId = Number(jobId || 0);
    if (!safeJobId) return null;

    const mapping = {
        status: value => ['status = $VALUE', normalizeAiWorkStatus(value)],
        currentStep: value => ['current_step = $VALUE', String(value || '').trim()],
        progressPercent: value => ['progress_percent = $VALUE', Math.max(0, Math.min(100, Number(value || 0)))],
        chargedPoints: value => ['charged_points = $VALUE', Number(value || 0)],
        modelName: value => ['model_name = $VALUE', String(value || '').trim()],
        requestPayload: value => ['request_payload_json = $VALUE', safeJsonStringify(value)],
        resultPayload: value => ['result_json = $VALUE', safeJsonStringify(value)],
        errorMessage: value => ['error_message = $VALUE', String(value || '').trim()],
        notificationSent: value => ['notification_sent = $VALUE', Boolean(value)],
        startedAt: value => ['started_at = $VALUE', value],
        finishedAt: value => ['finished_at = $VALUE', value],
        queuedAt: value => ['queued_at = $VALUE', value],
        forceRegenerate: value => ['force_regenerate = $VALUE', Boolean(value)],
        attemptCount: value => ['attempt_count = $VALUE', Number(value || 0)]
    };

    const sets = [];
    const params = [];
    let idx = 0;

    for (const [key, rawValue] of Object.entries(updates || {})) {
        const builder = mapping[key];
        if (!builder) continue;
        const [template, value] = builder(rawValue);
        idx += 1;
        sets.push(template.replace('$VALUE', `$${idx}`));
        params.push(value);
    }

    if (!sets.length) return getAiWorkJobById(safeJobId);

    idx += 1;
    params.push(safeJobId);
    const result = await db.pool.query(
        `UPDATE ai_work_job SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        params
    );
    return result.rows[0] ? serializeAdminAiWorkJob(result.rows[0]) : null;
}

async function markAiWorkJobStarted(jobId, currentStep = '任务已启动') {
    return updateAiWorkJob(jobId, {
        status: 'processing',
        currentStep,
        progressPercent: 10,
        startedAt: new Date().toISOString()
    });
}

async function markAiWorkJobCompleted(jobId, { resultPayload = null, chargedPoints = 0, modelName = '', currentStep = '处理完成' } = {}) {
    return updateAiWorkJob(jobId, {
        status: 'completed',
        currentStep,
        progressPercent: 100,
        chargedPoints,
        modelName,
        resultPayload,
        errorMessage: '',
        finishedAt: new Date().toISOString()
    });
}

async function markAiWorkJobFailed(jobId, { errorMessage = '', resultPayload = null, currentStep = '处理失败', modelName = '' } = {}) {
    return updateAiWorkJob(jobId, {
        status: 'failed',
        currentStep,
        progressPercent: 100,
        errorMessage,
        resultPayload,
        modelName,
        finishedAt: new Date().toISOString()
    });
}

async function getAiWorkJobById(jobId) {
    const result = await db.pool.query(
        `SELECT job.*, u.username, u.nickname
         FROM ai_work_job job
         LEFT JOIN users u ON u.id = job.user_id
         WHERE job.id = $1
         LIMIT 1`,
        [jobId]
    );
    return result.rows[0] ? serializeAdminAiWorkJob(result.rows[0]) : null;
}

async function getUserAiWorkJobById(userId, jobId) {
    const result = await db.pool.query(
        `SELECT *
         FROM ai_work_job
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [jobId, userId]
    );
    return result.rows[0] ? serializeUserAiWorkJob(result.rows[0]) : null;
}

async function findReusableAiWorkJob({ userId, jobType = AI_WORK_JOB_TYPE_SESSION_RECAP, roomId = '', sessionId = '' }) {
    const result = await db.pool.query(
        `SELECT *
         FROM ai_work_job
         WHERE user_id = $1 AND job_type = $2 AND room_id = $3 AND session_id = $4 AND status = ANY($5::text[])
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [userId, normalizeAiWorkJobType(jobType), String(roomId || ''), String(sessionId || ''), AI_WORK_ACTIVE_STATUSES]
    );
    return result.rows[0] ? serializeAdminAiWorkJob(result.rows[0]) : null;
}

async function findReusableCustomerAnalysisAiWorkJob({ userId, targetUserId = '', roomId = '' }) {
    const result = await db.pool.query(
        `SELECT *
         FROM ai_work_job
         WHERE user_id = $1
           AND job_type = $2
           AND room_id = $3
           AND COALESCE(request_payload_json::jsonb ->> 'targetUserId', '') = $4
           AND status = ANY($5::text[])
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [
            userId,
            AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS,
            String(roomId || ''),
            String(targetUserId || ''),
            AI_WORK_ACTIVE_STATUSES
        ]
    );
    return result.rows[0] ? serializeAdminAiWorkJob(result.rows[0]) : null;
}

async function getLatestCustomerAnalysisAiWorkJobForUser(userId, targetUserId, roomId = '') {
    const safeRoomId = String(roomId || '').trim();
    const params = [userId, AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS, String(targetUserId || '')];
    let roomClause = '';
    if (safeRoomId) {
        params.push(safeRoomId);
        roomClause = ` AND room_id = $${params.length}`;
    }

    const result = await db.pool.query(
        `SELECT *
         FROM ai_work_job
         WHERE user_id = $1
           AND job_type = $2
           AND COALESCE(request_payload_json::jsonb ->> 'targetUserId', '') = $3${roomClause}
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        params
    );
    return result.rows[0] ? serializeUserAiWorkJob(result.rows[0]) : null;
}

async function getLatestPersonalityAiWorkJobForUser(userId, targetUserId) {
    const result = await db.pool.query(
        `SELECT *
         FROM ai_work_job
         WHERE user_id = $1
           AND job_type = $2
           AND room_id = ''
           AND COALESCE(request_payload_json::jsonb ->> 'targetUserId', '') = $3
           AND COALESCE(request_payload_json::jsonb ->> 'analysisScene', '') = 'personality'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [userId, AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS, String(targetUserId || '')]
    );
    return result.rows[0] ? serializeUserAiWorkJob(result.rows[0]) : null;
}

async function getLatestSessionAiWorkJobForUser(userId, roomId, sessionId) {
    const result = await db.pool.query(
        `SELECT *
         FROM ai_work_job
         WHERE user_id = $1 AND job_type = $2 AND room_id = $3 AND session_id = $4
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [userId, AI_WORK_JOB_TYPE_SESSION_RECAP, String(roomId || ''), String(sessionId || '')]
    );
    return result.rows[0] ? serializeUserAiWorkJob(result.rows[0]) : null;
}

async function listAiWorkJobLogs(jobId) {
    const result = await db.pool.query(
        `SELECT id, job_id, phase, level, message, payload_json, created_at
         FROM ai_work_job_log
         WHERE job_id = $1
         ORDER BY created_at ASC, id ASC`,
        [jobId]
    );
    return result.rows.map(serializeAiWorkLog);
}

function buildAiWorkListWhere({ status = '', jobType = '', userId = null, search = '' } = {}) {
    const conditions = [];
    const params = [];

    if (status) {
        params.push(normalizeAiWorkStatus(status));
        conditions.push(`job.status = $${params.length}`);
    }
    if (jobType) {
        params.push(normalizeAiWorkJobType(jobType));
        conditions.push(`job.job_type = $${params.length}`);
    }
    if (userId) {
        params.push(Number(userId));
        conditions.push(`job.user_id = $${params.length}`);
    }
    if (search) {
        params.push(`%${String(search).trim()}%`);
        conditions.push(`(
            job.room_id ILIKE $${params.length}
            OR job.session_id ILIKE $${params.length}
            OR job.title ILIKE $${params.length}
            OR COALESCE(u.username, '') ILIKE $${params.length}
            OR COALESCE(u.nickname, '') ILIKE $${params.length}
            OR COALESCE(job.request_payload_json::jsonb ->> 'targetUserId', '') ILIKE $${params.length}
            OR COALESCE(job.request_payload_json::jsonb ->> 'targetNickname', '') ILIKE $${params.length}
            OR COALESCE(job.request_payload_json::jsonb ->> 'targetUniqueId', '') ILIKE $${params.length}
        )`);
    }

    return {
        whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params
    };
}

async function listUserAiWorkJobs(userId, { page = 1, limit = 20, status = '', jobType = '' } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (safePage - 1) * safeLimit;
    const safeStatus = status ? normalizeAiWorkStatus(status) : '';
    const safeJobType = jobType ? normalizeAiWorkJobType(jobType) : '';
    const conditions = ['user_id = $1'];
    const params = [userId];
    if (safeStatus) {
        params.push(safeStatus);
        conditions.push(`status = $${params.length}`);
    }
    if (safeJobType) {
        params.push(safeJobType);
        conditions.push(`job_type = $${params.length}`);
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const listParams = [...params, safeLimit, offset];
    const [rowsResult, countResult, queuedResult, processingResult, completedResult, failedResult] = await Promise.all([
        db.pool.query(
            `SELECT * FROM ai_work_job ${whereClause} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            listParams
        ),
        db.pool.query(`SELECT COUNT(*) AS total FROM ai_work_job ${whereClause}`, params),
        db.pool.query(`SELECT COUNT(*) AS total FROM ai_work_job WHERE user_id = $1 AND status = 'queued'`, [userId]),
        db.pool.query(`SELECT COUNT(*) AS total FROM ai_work_job WHERE user_id = $1 AND status = 'processing'`, [userId]),
        db.pool.query(`SELECT COUNT(*) AS total FROM ai_work_job WHERE user_id = $1 AND status = 'completed'`, [userId]),
        db.pool.query(`SELECT COUNT(*) AS total FROM ai_work_job WHERE user_id = $1 AND status = 'failed'`, [userId])
    ]);

    return {
        jobs: rowsResult.rows.map(serializeUserAiWorkJob),
        counts: {
            queued: Number(queuedResult.rows[0]?.total || 0),
            processing: Number(processingResult.rows[0]?.total || 0),
            completed: Number(completedResult.rows[0]?.total || 0),
            failed: Number(failedResult.rows[0]?.total || 0)
        },
        pagination: {
            page: safePage,
            limit: safeLimit,
            total: Number(countResult.rows[0]?.total || 0)
        }
    };
}

async function listAdminAiWorkJobs({ page = 1, limit = 20, status = '', jobType = '', userId = null, search = '' } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (safePage - 1) * safeLimit;
    const { whereClause, params } = buildAiWorkListWhere({ status, jobType, userId, search });
    const baseSql = `
        FROM ai_work_job job
        LEFT JOIN users u ON u.id = job.user_id
        LEFT JOIN LATERAL (
            SELECT created_at AS latest_log_at
            FROM ai_work_job_log log
            WHERE log.job_id = job.id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        ) latest ON TRUE
        ${whereClause}
    `;
    const listParams = [...params, safeLimit, offset];

    const [rowsResult, countResult] = await Promise.all([
        db.pool.query(
            `SELECT job.*, u.username, u.nickname, latest.latest_log_at ${baseSql} ORDER BY job.created_at DESC, job.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            listParams
        ),
        db.pool.query(`SELECT COUNT(*) AS total ${baseSql}`, params)
    ]);

    return {
        jobs: rowsResult.rows.map(serializeAdminAiWorkJob),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total: Number(countResult.rows[0]?.total || 0)
        }
    };
}

async function getAdminAiWorkJobDetail(jobId) {
    const job = await getAiWorkJobById(jobId);
    if (!job) return null;
    const logs = await listAiWorkJobLogs(jobId);
    return { job, logs };
}

async function claimNextAiWorkJobs(limit = 1, staleMinutes = 20) {
    const safeLimit = Math.min(5, Math.max(1, Number(limit || 1)));
    const safeStaleMinutes = Math.max(5, Number(staleMinutes || 20));
    const result = await db.pool.query(
        `WITH candidates AS (
            SELECT id
            FROM ai_work_job
            WHERE status = 'queued'
               OR (status = 'processing' AND started_at IS NOT NULL AND started_at < NOW() - ($1 * INTERVAL '1 minute'))
            ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, created_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
        )
        UPDATE ai_work_job job
        SET status = 'processing',
            current_step = CASE WHEN COALESCE(job.current_step, '') = '' THEN '任务启动中' ELSE job.current_step END,
            progress_percent = GREATEST(COALESCE(job.progress_percent, 0), 10),
            started_at = COALESCE(job.started_at, NOW()),
            attempt_count = COALESCE(job.attempt_count, 0) + 1,
            updated_at = NOW()
        FROM candidates
        WHERE job.id = candidates.id
        RETURNING job.*`,
        [safeStaleMinutes, safeLimit]
    );
    return result.rows.map(serializeAdminAiWorkJob);
}

module.exports = {
    AI_WORK_JOB_TYPE_SESSION_RECAP,
    AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS,
    AI_WORK_ACTIVE_STATUSES,
    AI_WORK_FINAL_STATUSES,
    normalizeAiWorkStatus,
    normalizeAiWorkJobType,
    serializeUserAiWorkJob,
    serializeAdminAiWorkJob,
    serializeAiWorkLog,
    createAiWorkJob,
    appendAiWorkJobLog,
    updateAiWorkJob,
    markAiWorkJobStarted,
    markAiWorkJobCompleted,
    markAiWorkJobFailed,
    getAiWorkJobById,
    getUserAiWorkJobById,
    findReusableAiWorkJob,
    findReusableCustomerAnalysisAiWorkJob,
    getLatestCustomerAnalysisAiWorkJobForUser,
    getLatestPersonalityAiWorkJobForUser,
    getLatestSessionAiWorkJobForUser,
    listAiWorkJobLogs,
    listUserAiWorkJobs,
    listAdminAiWorkJobs,
    getAdminAiWorkJobDetail,
    claimNextAiWorkJobs,
    safeJsonParse,
    safeJsonStringify,
    buildAiWorkTitle,
    buildAiWorkActionUrl,
    getAiWorkJobTypeLabel
};
