/**
 * TikTok Chat Reader - Node.js Server
 * Combined Socket.IO (TikTok events) + REST API (data management)
 */
require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { TikTokConnectionWrapper, getGlobalConnectionCount } = require('./connectionWrapper');
const { manager } = require('./manager');
const { AutoRecorder } = require('./auto_recorder');
const recordingManager = require('./recording_manager');
const ffmpegManager = require('./utils/ffmpeg_manager');
const { router: userManagementRouter, startPeriodicTasks } = require('./routes/index');
const { optionalAuth, authenticate, requireAdmin, requireAdminPermission, hasAdminPermission } = require('./middleware/auth');
const { checkRoomQuota, getUserQuota } = require('./middleware/quota');
const db = require('./db');
const {
    PROMPT_TEMPLATE_PREFIX,
    getPromptTemplate,
    renderPromptTemplate,
    repairCriticalPromptTemplates,
} = require('./services/aiPromptService');
const {
    AI_WORK_JOB_TYPE_SESSION_RECAP,
    AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS,
    createAiWorkJob,
    appendAiWorkJobLog,
    serializeAdminAiWorkJob,
    safeJsonStringify,
    updateAiWorkJob,
    markAiWorkJobStarted,
    markAiWorkJobCompleted,
    markAiWorkJobFailed,
    findReusableAiWorkJob,
    findReusableCustomerAnalysisAiWorkJob,
    getLatestCustomerAnalysisAiWorkJobForUser,
    getLatestPersonalityAiWorkJobForUser,
    getLatestSessionAiWorkJobForUser,
    claimNextAiWorkJobs,
    buildAiWorkTitle,
    buildAiWorkActionUrl,
} = require('./services/aiWorkService');
const {
    isSessionMaintenanceSettingKey,
} = require('./services/sessionMaintenanceService');
const notificationService = require('./services/notificationService');
const keyManager = require('./utils/keyManager');
const metricsService = require('./services/metricsService');
const { RecordingStorageService } = require('./services/recordingStorageService');
const {
    getSchemeAConfig,
    getRecordingAccessConfig,
    getSchemeAFeatureFlags,
    refreshRuntimeSettingsFromDb,
    isSensitiveRuntimeSettingKey,
} = require('./services/featureFlagService');
const { WorkerProcessManager } = require('./services/workerProcessManager');
const cacheService = require('./services/cacheService');
const { disconnectRedisClient } = require('./services/redisClient');
const liveStateService = require('./services/liveStateService');
const {
    prepareCustomerAnalysis,
    runCustomerAnalysis,
    normalizeAnalysisPayload,
    localizeCustomerAnalysisText,
} = require('./services/customerAiAnalysisService');
const {
    resolveAiStructuredDataVariables,
    injectMissingStructuredDataTokens,
    USER_PERSONALITY_ANALYSIS_SCENE,
} = require('./services/aiStructuredDataSourceService');
const {
    runRoomStatsRefreshJob,
    runDirtyRoomStatsRepairJob,
    runUserStatsRefreshJob,
    runGlobalStatsRefreshJob,
} = require('./services/statsRefreshService');
const {
    getAiPointCost,
    AI_POINT_SCENES,
} = require('./services/aiPricingService');
const { runExpiredRoomCleanupJob } = require('./services/maintenanceJobService');
const {
    JOB_QUEUE_MAINTENANCE,
    JOB_QUEUE_STATS,
    enqueueSessionMaintenanceJob,
    enqueueStatsRefreshJob,
    enqueueEventMigrationJob,
    enqueueRoomRenameJob,
    processAvailableAdminAsyncJobs,
} = require('./services/adminAsyncJobService');

let schemeAConfig = getSchemeAConfig();
let recordingStorageService = new RecordingStorageService({ schemeAConfig });
let recordingUploadWorkerProcess = null;
let statsWorkerProcess = null;
let maintenanceWorkerProcess = null;
const processFallbackRecordingAccessTokenSecret = crypto.randomBytes(32).toString('hex');
let hasWarnedMissingRecordingAccessSecret = false;
const ADMIN_ASYNC_JOB_WEB_FALLBACK_INTERVAL_MS = 5000;
const ADMIN_ASYNC_JOB_WEB_FALLBACK_STARTUP_DELAY_MS = 2000;
const ADMIN_ASYNC_JOB_WEB_FALLBACK_MAX_JOBS = 2;
const ADMIN_ASYNC_JOB_WEB_FALLBACK_RECOVER_LIMIT = 2;

function getEffectiveRecordingAccessConfig() {
    const accessConfig = getRecordingAccessConfig();
    if (!accessConfig.tokenSecret && !hasWarnedMissingRecordingAccessSecret) {
        console.warn('[Recording Access] RECORDING_ACCESS_TOKEN_SECRET/JWT_SECRET 未配置，已使用进程内临时密钥；服务重启后旧下载链接会失效。');
        hasWarnedMissingRecordingAccessSecret = true;
    }
    return {
        tokenSecret: accessConfig.tokenSecret || processFallbackRecordingAccessTokenSecret,
        ttlSecs: accessConfig.ttlSecs,
    };
}

function applySchemeARuntimeConfig(nextConfig) {
    schemeAConfig = nextConfig || getSchemeAConfig();
    recordingStorageService = new RecordingStorageService({ schemeAConfig });
}

async function refreshSchemeARuntimeConfig(reason = 'manual') {
    const nextConfig = await refreshRuntimeSettingsFromDb(db);
    applySchemeARuntimeConfig(nextConfig);

    metricsService.emitLog('info', 'scheme_a.runtime_refresh', {
        reason,
        featureFlags: getSchemeAFeatureFlags(),
        objectStorageConfigured: Boolean(schemeAConfig.objectStorage.endpoint && schemeAConfig.objectStorage.bucket),
        recordingUploadDaemonEnabled: schemeAConfig.worker.enableRecordingUploadDaemon,
    });

    if (recordingUploadWorkerProcess?.isRunning() || statsWorkerProcess?.isRunning() || maintenanceWorkerProcess?.isRunning()) {
        await stopManagedWorkers('SIGTERM');
    }
    ensureRecordingUploadWorkerDaemon();
    ensureStatsWorkerDaemon();
    ensureMaintenanceWorkerDaemon();
    return nextConfig;
}

function ensureRecordingUploadWorkerDaemon() {
    if (!schemeAConfig.worker.enableRecordingUploadDaemon) {
        return null;
    }

    if (!schemeAConfig.worker.enableRecordingUpload) {
        metricsService.emitLog('warn', 'worker.guardian', {
            workerName: 'recording_upload',
            status: 'autostart_blocked',
            reason: 'recording_upload_feature_flag_off',
        });
        return null;
    }

    if (!recordingStorageService.objectStorageService.isConfigured()) {
        metricsService.emitLog('error', 'worker.guardian', {
            workerName: 'recording_upload',
            status: 'autostart_blocked',
            reason: 'object_storage_not_configured',
        });
        return null;
    }

    if (!recordingUploadWorkerProcess) {
        recordingUploadWorkerProcess = new WorkerProcessManager({
            name: 'recording_upload',
            enabled: true,
            scriptPath: path.join(__dirname, 'bin/start_recording_upload_worker.js'),
            cwd: __dirname,
            env: {
                WORKER_ROLE: 'recording_upload',
            },
            restartDelayMs: schemeAConfig.worker.recordingUploadDaemonRestartDelayMs,
            maxRestarts: schemeAConfig.worker.recordingUploadDaemonMaxRestarts,
        });
    }

    recordingUploadWorkerProcess.start();
    return recordingUploadWorkerProcess;
}

function ensureStatsWorkerDaemon() {
    if (!schemeAConfig.worker.enableStats) {
        return null;
    }

    if (!statsWorkerProcess) {
        statsWorkerProcess = new WorkerProcessManager({
            name: 'stats',
            enabled: true,
            scriptPath: path.join(__dirname, 'bin/start_stats_worker.js'),
            cwd: __dirname,
            env: {
                WORKER_ROLE: 'stats',
            },
            restartDelayMs: 5000,
            maxRestarts: 0,
        });
    }

    statsWorkerProcess.start();
    return statsWorkerProcess;
}

function ensureMaintenanceWorkerDaemon() {
    if (!schemeAConfig.worker.enableMaintenance) {
        return null;
    }

    if (!maintenanceWorkerProcess) {
        maintenanceWorkerProcess = new WorkerProcessManager({
            name: 'maintenance',
            enabled: true,
            scriptPath: path.join(__dirname, 'bin/start_maintenance_worker.js'),
            cwd: __dirname,
            env: {
                WORKER_ROLE: 'maintenance',
            },
            restartDelayMs: 5000,
            maxRestarts: 0,
        });
    }

    maintenanceWorkerProcess.start();
    return maintenanceWorkerProcess;
}

function shouldRunAdminAsyncJobQueueInWebProcess(queueName) {
    const safeQueueName = String(queueName || '').trim();
    if (safeQueueName === JOB_QUEUE_STATS) {
        return !schemeAConfig.worker.enableStats;
    }
    if (safeQueueName === JOB_QUEUE_MAINTENANCE) {
        return !schemeAConfig.worker.enableMaintenance;
    }
    return false;
}

async function runAdminAsyncJobWebFallback(queueName, runner) {
    if (!shouldRunAdminAsyncJobQueueInWebProcess(queueName)) {
        return;
    }

    try {
        await processAvailableAdminAsyncJobs(queueName, {
            maxJobs: ADMIN_ASYNC_JOB_WEB_FALLBACK_MAX_JOBS,
            recoverLimit: ADMIN_ASYNC_JOB_WEB_FALLBACK_RECOVER_LIMIT,
            runner,
        });
    } catch (err) {
        console.error(`[CRON] Admin async job fallback error for ${queueName}:`, err.message);
    }
}

function scheduleAdminAsyncJobWebFallback() {
    const queueNames = [JOB_QUEUE_MAINTENANCE, JOB_QUEUE_STATS];

    setTimeout(() => {
        for (const queueName of queueNames) {
            runAdminAsyncJobWebFallback(queueName, 'web-fallback-startup').catch(() => {});
        }
    }, ADMIN_ASYNC_JOB_WEB_FALLBACK_STARTUP_DELAY_MS);

    setInterval(() => {
        for (const queueName of queueNames) {
            runAdminAsyncJobWebFallback(queueName, 'web-fallback-interval').catch(() => {});
        }
    }, ADMIN_ASYNC_JOB_WEB_FALLBACK_INTERVAL_MS);
}

async function stopManagedWorkers(signal = 'SIGTERM') {
    if (recordingUploadWorkerProcess) {
        await recordingUploadWorkerProcess.stop(signal);
    }
    if (statsWorkerProcess) {
        await statsWorkerProcess.stop(signal);
    }
    if (maintenanceWorkerProcess) {
        await maintenanceWorkerProcess.stop(signal);
    }
}

// Helper: get user's room access context in a single query per request
async function getUserRoomAccessContext(req) {
    if (req._userRoomAccessContext) return req._userRoomAccessContext;

    if (!req.user) {
        req._userRoomAccessContext = { roomFilter: [], userRoomData: {}, dataStartTimes: {} };
        return req._userRoomAccessContext;
    }
    if (req.user.role === 'admin') {
        req._userRoomAccessContext = { roomFilter: null, userRoomData: null, dataStartTimes: null };
        return req._userRoomAccessContext;
    }

    const rows = await db.all(
        'SELECT room_id, alias, first_added_at FROM user_room WHERE user_id = ? AND deleted_at IS NULL',
        [req.user.id]
    );

    const roomFilter = [];
    const userRoomData = {};
    const dataStartTimes = {};
    for (const row of rows) {
        roomFilter.push(row.roomId);
        userRoomData[row.roomId] = { alias: row.alias, firstAddedAt: row.firstAddedAt };
        if (row.firstAddedAt) dataStartTimes[row.roomId] = row.firstAddedAt;
    }

    req._userRoomAccessContext = { roomFilter, userRoomData, dataStartTimes };
    return req._userRoomAccessContext;
}

// Helper: get user's allowed room IDs (returns null for admin = no filter)
async function getUserRoomFilter(req) {
    const { roomFilter } = await getUserRoomAccessContext(req);
    return roomFilter;
}

// Helper: get user's room data map { roomId -> { alias, firstAddedAt } } for display name & time filter
async function getUserRoomDataMap(req) {
    const { userRoomData } = await getUserRoomAccessContext(req);
    return userRoomData;
}

// Helper: get data start time for a specific room (member's first_added_at, null for admin)
async function getDataStartTime(req, roomId) {
    const dataStartTimes = await getDataStartTimes(req);
    if (dataStartTimes === null) return null;
    return dataStartTimes[roomId] || null;
}

// Helper: get data start times map for all user's rooms { roomId: ISO string }
async function getDataStartTimes(req) {
    const { dataStartTimes } = await getUserRoomAccessContext(req);
    return dataStartTimes;
}

// Helper: Check if user can access a specific room
async function canAccessRoom(req, roomId) {
    if (!req.user) return { allowed: false, reason: 'Not logged in' };
    if (req.user.role === 'admin') return { allowed: true };
    const row = await db.get('SELECT room_id FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NULL', [req.user.id, roomId]);
    return { allowed: !!row };
}

function resolveRoomDisplayName({ roomId = '', alias = '', roomName = '' } = {}) {
    const safeRoomId = String(roomId || '').trim();
    const safeAlias = String(alias || '').trim();
    const safeRoomName = String(roomName || '').trim();

    if (safeAlias && safeAlias !== safeRoomId) return safeAlias;
    if (safeRoomName && safeRoomName !== safeRoomId) return safeRoomName;
    return safeAlias || safeRoomName || safeRoomId;
}

async function getRoomDisplayNameForRequest(req, roomId) {
    const safeRoomId = String(roomId || '').trim();
    if (!safeRoomId) return '';

    const userRoomData = await getUserRoomDataMap(req);
    const room = await db.get('SELECT name FROM room WHERE room_id = ? LIMIT 1', [safeRoomId]);
    return resolveRoomDisplayName({
        roomId: safeRoomId,
        alias: userRoomData?.[safeRoomId]?.alias || '',
        roomName: room?.name || ''
    });
}

async function getRoomDisplayNameForUser(userId, roomId) {
    const safeUserId = Number(userId || 0);
    const safeRoomId = String(roomId || '').trim();
    if (!safeUserId || !safeRoomId) return safeRoomId;

    const row = await db.get(
        `SELECT u.role, ur.alias, r.name
         FROM users u
         LEFT JOIN user_room ur
            ON ur.user_id = u.id
           AND ur.room_id = ?
           AND ur.deleted_at IS NULL
         LEFT JOIN room r
            ON r.room_id = ?
         WHERE u.id = ?
         LIMIT 1`,
        [safeRoomId, safeRoomId, safeUserId]
    );

    if (String(row?.role || '').trim() === 'admin') {
        return resolveRoomDisplayName({
            roomId: safeRoomId,
            roomName: row?.name || ''
        });
    }

    return resolveRoomDisplayName({
        roomId: safeRoomId,
        alias: row?.alias || '',
        roomName: row?.name || ''
    });
}

async function getRoomFilterForUserScope(userId, isAdmin = false) {
    if (!userId || isAdmin) return null;
    const rows = await db.all(
        'SELECT room_id FROM user_room WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC',
        [userId]
    );
    return rows.map(row => row.roomId).filter(Boolean);
}

function serializeSessionAiWorkJobForClient(job) {
    if (!job || typeof job !== 'object') return null;
    return {
        id: Number(job.id || 0),
        jobType: String(job.jobType || AI_WORK_JOB_TYPE_SESSION_RECAP),
        title: String(job.title || ''),
        roomId: String(job.roomId || ''),
        sessionId: String(job.sessionId || ''),
        status: String(job.status || 'queued'),
        currentStep: String(job.currentStep || ''),
        progressPercent: Number(job.progressPercent || 0),
        pointCost: Number(job.pointCost || 0),
        chargedPoints: Number(job.chargedPoints || 0),
        forceRegenerate: Boolean(job.forceRegenerate),
        modelName: String(job.modelName || ''),
        summary: String(job.summary || ''),
        hasResult: Boolean(job.hasResult),
        resultReady: Boolean(job.resultReady),
        errorMessage: String(job.errorMessage || ''),
        notificationSent: Boolean(job.notificationSent),
        queuedAt: job.queuedAt || '',
        startedAt: job.startedAt || '',
        finishedAt: job.finishedAt || '',
        createdAt: job.createdAt || '',
        updatedAt: job.updatedAt || ''
    };
}

function normalizePlanFeatureFlags(rawFlags) {
    if (!rawFlags) return {};
    if (typeof rawFlags === 'string') {
        try {
            return JSON.parse(rawFlags);
        } catch (err) {
            console.warn('[FeatureFlags] Parse error:', err.message);
            return {};
        }
    }
    return rawFlags;
}

async function ensureUserPlanFeature(req, featureKeys = [], errorMessage = '当前套餐暂无此权益', errorCode = 'FEATURE_NOT_ALLOWED') {
    if (!req.user) {
        return { allowed: false, status: 401, payload: { error: '请先登录' } };
    }
    if (req.user.role === 'admin') {
        return { allowed: true, flags: { admin: true } };
    }

    const quota = await getUserQuota(req.user.id);
    const flags = normalizePlanFeatureFlags(quota?.subscription?.planFeatureFlags || quota?.subscription?.featureFlags);
    const allowed = featureKeys.some(key => Boolean(flags?.[key]));

    if (allowed) {
        return { allowed: true, flags };
    }

    return {
        allowed: false,
        status: 403,
        payload: {
            error: errorMessage,
            code: errorCode
        }
    };
}
// Helper: check if user owns a specific room
async function checkRoomOwnership(req, roomId) {
    if (!req.user) return false; // not logged in
    if (req.user.role === 'admin') return true; // admin - owns all
    const row = await db.get('SELECT 1 FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NULL', [req.user.id, roomId]);
    return !!row;
}


const app = express();
app.locals.refreshSchemeARuntimeConfig = refreshSchemeARuntimeConfig;
const httpServer = createServer(app);

// Start Auto Recorder (Dynamic interval from DB)
const autoRecorder = new AutoRecorder();
autoRecorder.setRecordingManager(recordingManager);
recordingManager.startMonitoring(); // Start stall detection for recordings
app.locals.autoRecorder = autoRecorder;

// Enable CORS & request body parsing
const REQUEST_BODY_LIMIT = '20mb';
const ROOM_LIST_CACHE_TTL_MS = Math.max(0, parseInt(process.env.ROOM_LIST_CACHE_TTL_MS || '10000', 10) || 10000);
const ALLTIME_LEADERBOARDS_CACHE_TTL_MS = Math.max(0, parseInt(process.env.ALLTIME_LEADERBOARDS_CACHE_TTL_MS || '15000', 10) || 15000);
const ROOM_SESSIONS_CACHE_TTL_MS = Math.max(ROOM_LIST_CACHE_TTL_MS, 15000);
const ARCHIVED_STATS_DETAIL_CACHE_TTL_MS = Math.max(ROOM_LIST_CACHE_TTL_MS, 30000);
const ANALYSIS_CACHE_TTL_MS = Math.max(ROOM_LIST_CACHE_TTL_MS, 20000);
const SESSION_RECAP_CACHE_TTL_MS = Math.max(ARCHIVED_STATS_DETAIL_CACHE_TTL_MS, 30000);
const LANDING_METRICS_CACHE_TTL_MS = Math.max(30000, parseInt(process.env.LANDING_METRICS_CACHE_TTL_MS || '60000', 10) || 60000);
const ROOM_LIST_CACHE_MAX_ENTRIES = 200;
const roomListResponseCache = new Map();
let landingMetricsCache = null;
const ROOM_LIST_CACHE_NAMESPACE = 'room_list';
const ROOM_LIST_CACHE_VERSION_KEY = cacheService.buildCacheKey(ROOM_LIST_CACHE_NAMESPACE, 'version');
let roomListCacheVersion = 0;

function getRoomListActorCacheKey(req) {
    if (!req.user) return 'guest';
    return `${req.user.role}:${req.user.id || 0}`;
}

function buildRoomListCacheKey(endpoint, req, params = {}, cacheVersion = roomListCacheVersion) {
    return JSON.stringify([
        endpoint,
        cacheVersion,
        getRoomListActorCacheKey(req),
        Number(params.page || 1),
        Number(params.limit || 50),
        String(params.search || ''),
        String(params.sort || '')
    ]);
}

function buildRoomListRedisKey(cacheKey) {
    return cacheService.buildCacheKey(ROOM_LIST_CACHE_NAMESPACE, cacheKey);
}

function buildAllTimeLeaderboardsCacheKey(roomId) {
    return cacheService.buildCacheKey('room_detail', 'alltime_leaderboards', roomId);
}

function buildRoomSessionsCacheKey(roomId) {
    return cacheService.buildCacheKey('room_detail', 'sessions', roomId);
}

function buildArchivedStatsDetailCacheKey(roomId, sessionId) {
    return cacheService.buildCacheKey('room_detail', 'stats_detail', roomId, sessionId);
}

async function getCachedRoomSessions(roomId) {
    if (!roomId || !cacheService.isRoomCacheEnabled() || ROOM_SESSIONS_CACHE_TTL_MS <= 0) {
        return manager.getSessions(roomId);
    }

    const cacheKey = buildRoomSessionsCacheKey(roomId);
    const cached = await cacheService.getJson(cacheKey);
    if (cached) return cached;

    const sessions = await manager.getSessions(roomId);
    await cacheService.setJson(cacheKey, sessions, { ttlMs: ROOM_SESSIONS_CACHE_TTL_MS });
    return sessions;
}

async function getCachedArchivedStatsDetail(roomId, sessionId) {
    if (!roomId || !sessionId || sessionId === 'live' || !cacheService.isRoomCacheEnabled() || ARCHIVED_STATS_DETAIL_CACHE_TTL_MS <= 0) {
        return manager.getRoomDetailStats(roomId, sessionId);
    }

    const cacheKey = buildArchivedStatsDetailCacheKey(roomId, sessionId);
    const cached = await cacheService.getJson(cacheKey);
    if (cached) return cached;

    const data = await manager.getRoomDetailStats(roomId, sessionId);
    await cacheService.setJson(cacheKey, data, { ttlMs: ARCHIVED_STATS_DETAIL_CACHE_TTL_MS });
    return data;
}

async function invalidateRoomDetailCaches(roomId, sessionId = null) {
    if (!roomId || !cacheService.isRoomCacheEnabled()) return;

    await cacheService.del(buildRoomSessionsCacheKey(roomId));
    if (sessionId) {
        await cacheService.del(buildArchivedStatsDetailCacheKey(roomId, sessionId));
    }
}

function normalizeRoomFilterCacheKey(roomFilter) {
    if (roomFilter === null) return 'all';
    if (!Array.isArray(roomFilter) || roomFilter.length === 0) return 'none';
    return Array.from(new Set(roomFilter.map(item => String(item || '').trim()).filter(Boolean))).sort().join(',');
}

function buildAnalysisCacheKey(endpoint, req, roomFilter, params = {}) {
    return cacheService.buildCacheKey(
        'analysis',
        endpoint,
        getRoomListActorCacheKey(req),
        normalizeRoomFilterCacheKey(roomFilter),
        JSON.stringify(params || {})
    );
}

async function getCachedAnalysisPayload(cacheKey, loader) {
    if (!cacheService.isRoomCacheEnabled() || ANALYSIS_CACHE_TTL_MS <= 0) {
        return loader();
    }

    const cached = await cacheService.getJson(cacheKey);
    if (cached) return cached;

    const payload = await loader();
    await cacheService.setJson(cacheKey, payload, { ttlMs: ANALYSIS_CACHE_TTL_MS });
    return payload;
}

function readLandingMetricsCache() {
    if (!landingMetricsCache) return null;
    if (landingMetricsCache.expiresAt <= Date.now()) {
        landingMetricsCache = null;
        return null;
    }
    return landingMetricsCache.payload;
}

function writeLandingMetricsCache(payload) {
    landingMetricsCache = {
        payload,
        expiresAt: Date.now() + LANDING_METRICS_CACHE_TTL_MS,
    };
    return payload;
}

async function loadLandingMetricsPayload() {
    const cached = readLandingMetricsCache();
    if (cached) return cached;

    // MAX(id) is cheap on the primary key index and remains monotonic for the landing counter.
    const row = await db.get('SELECT COALESCE(MAX(id), 0) AS total FROM event');
    const payload = {
        eventCount: Number(row?.total || 0),
        updatedAt: new Date().toISOString(),
    };
    return writeLandingMetricsCache(payload);
}

function buildUserAnalysisDetailVersionKey(targetUserId) {
    return cacheService.buildCacheKey('analysis', 'user_detail_version', String(targetUserId || '').trim());
}

function buildUserAnalysisDetailCacheKey(req, roomFilter, targetUserId, cacheVersion = 0) {
    return buildAnalysisCacheKey('user_detail', req, roomFilter, {
        userId: String(targetUserId || '').trim(),
        version: Number(cacheVersion || 0)
    });
}

async function getUserAnalysisDetailCacheVersion(targetUserId) {
    const normalizedTargetUserId = String(targetUserId || '').trim();
    if (!normalizedTargetUserId || !cacheService.isRoomCacheEnabled()) {
        return 0;
    }

    const version = await cacheService.getNumber(buildUserAnalysisDetailVersionKey(normalizedTargetUserId));
    return Number.isFinite(version) && version > 0 ? version : 0;
}

async function invalidateUserAnalysisDetailCaches(targetUserId) {
    const normalizedTargetUserId = String(targetUserId || '').trim();
    if (!normalizedTargetUserId || !cacheService.isRoomCacheEnabled()) {
        return 0;
    }

    return cacheService.increment(buildUserAnalysisDetailVersionKey(normalizedTargetUserId), 1);
}

async function getCachedUserAnalysisBase(req, targetUserId, roomFilter) {
    const normalizedTargetUserId = String(targetUserId || '').trim();
    if (!normalizedTargetUserId) {
        return manager.getUserAnalysis(targetUserId, roomFilter);
    }

    const cacheVersion = await getUserAnalysisDetailCacheVersion(normalizedTargetUserId);
    const cacheKey = buildUserAnalysisDetailCacheKey(req, roomFilter, normalizedTargetUserId, cacheVersion);
    return getCachedAnalysisPayload(cacheKey, () => manager.getUserAnalysis(normalizedTargetUserId, roomFilter));
}

function buildSessionRecapCacheKey(roomId, sessionId, req, roomFilter) {
    return cacheService.buildCacheKey(
        'room_detail',
        'session_recap',
        roomId,
        sessionId,
        getRoomListActorCacheKey(req),
        normalizeRoomFilterCacheKey(roomFilter)
    );
}

async function getCachedSessionRecap(roomId, sessionId, req, roomFilter) {
    if (!roomId || !sessionId || sessionId === 'live' || !cacheService.isRoomCacheEnabled() || SESSION_RECAP_CACHE_TTL_MS <= 0) {
        return manager.getSessionRecap(roomId, sessionId, roomFilter);
    }

    const cacheKey = buildSessionRecapCacheKey(roomId, sessionId, req, roomFilter);
    const cached = await cacheService.getJson(cacheKey);
    if (cached) return cached;

    const recap = await manager.getSessionRecap(roomId, sessionId, roomFilter);
    await cacheService.setJson(cacheKey, recap, { ttlMs: SESSION_RECAP_CACHE_TTL_MS });
    return recap;
}

function readLocalRoomListCache(cacheKey) {
    if (ROOM_LIST_CACHE_TTL_MS <= 0) return null;
    const cached = roomListResponseCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        roomListResponseCache.delete(cacheKey);
        return null;
    }
    return cached.payload;
}

function writeLocalRoomListCache(cacheKey, payload) {
    if (ROOM_LIST_CACHE_TTL_MS <= 0) return payload;
    if (roomListResponseCache.size >= ROOM_LIST_CACHE_MAX_ENTRIES) {
        const oldestKey = roomListResponseCache.keys().next().value;
        if (oldestKey) roomListResponseCache.delete(oldestKey);
    }
    roomListResponseCache.set(cacheKey, {
        payload,
        expiresAt: Date.now() + ROOM_LIST_CACHE_TTL_MS,
    });
    return payload;
}

async function getRoomListCacheVersion() {
    if (!cacheService.isRoomCacheEnabled()) {
        return roomListCacheVersion;
    }

    const remoteVersion = await cacheService.getNumber(ROOM_LIST_CACHE_VERSION_KEY);
    if (Number.isFinite(remoteVersion)) {
        roomListCacheVersion = remoteVersion;
    }
    return roomListCacheVersion;
}

async function readRoomListCache(endpoint, req, params = {}) {
    const forceFresh = Boolean(req?.query?.forceFresh);
    const cacheVersion = await getRoomListCacheVersion();
    const cacheKey = buildRoomListCacheKey(endpoint, req, params, cacheVersion);

    if (forceFresh) {
        return { payload: null, cacheKey, cacheLayer: null, bypassed: true };
    }

    if (cacheService.isRoomCacheEnabled()) {
        const redisPayload = await cacheService.getJson(buildRoomListRedisKey(cacheKey));
        if (redisPayload) {
            writeLocalRoomListCache(cacheKey, redisPayload);
            return { payload: redisPayload, cacheKey, cacheLayer: 'redis' };
        }
    }

    const localPayload = readLocalRoomListCache(cacheKey);
    if (localPayload) {
        return { payload: localPayload, cacheKey, cacheLayer: 'memory' };
    }

    return { payload: null, cacheKey, cacheLayer: null };
}

async function writeRoomListCache(cacheKey, payload) {
    const cachedPayload = writeLocalRoomListCache(cacheKey, payload);
    if (cacheService.isRoomCacheEnabled()) {
        await cacheService.setJson(buildRoomListRedisKey(cacheKey), cachedPayload, { ttlMs: ROOM_LIST_CACHE_TTL_MS });
    }
    return cachedPayload;
}

async function invalidateRoomListCaches(reason = 'manual') {
    const clearedCount = roomListResponseCache.size;
    roomListCacheVersion += 1;
    roomListResponseCache.clear();

    if (cacheService.isRoomCacheEnabled()) {
        const remoteVersion = await cacheService.increment(ROOM_LIST_CACHE_VERSION_KEY, 1);
        if (Number.isFinite(remoteVersion)) {
            roomListCacheVersion = remoteVersion;
        }
    }

    console.log(`[CACHE] Room list cache invalidated: ${reason}`);
    metricsService.emitLog('info', 'api.room_list.cache.invalidate', {
        reason,
        cacheVersion: roomListCacheVersion,
        cacheBackend: cacheService.isRoomCacheEnabled() ? 'redis' : 'memory',
        clearedCount,
    });
}

async function getEffectiveLiveRoomIds() {
    const liveRoomIdSet = new Set(autoRecorder.getLiveRoomIds());

    if (liveStateService.isLiveStateEnabled()) {
        const redisLiveRoomIds = await liveStateService.listLiveRoomIds();
        for (const roomId of redisLiveRoomIds) {
            if (roomId) liveRoomIdSet.add(roomId);
        }
    }

    return Array.from(liveRoomIdSet);
}

function applyLiveStateToRoomPayload(payload, liveRoomIds = [], options = {}) {
    if (!payload || !Array.isArray(payload.data)) {
        return payload;
    }

    const liveRoomIdSet = new Set((liveRoomIds || []).map(roomId => String(roomId || '').trim()).filter(Boolean));
    const nextPayload = {
        ...payload,
        data: payload.data.map((room) => ({
            ...room,
            isLive: liveRoomIdSet.has(String(room.roomId || '').trim()),
        })),
    };

    if (options.sortLiveFirst) {
        nextPayload.data.sort((a, b) => {
            if (a.isLive && !b.isLive) return -1;
            if (!a.isLive && b.isLive) return 1;
            return 0;
        });
    }

    return nextPayload;
}

async function getEffectiveRoomLiveFlag(roomId) {
    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) return false;

    if (autoRecorder.getLiveRoomIds().includes(normalizedRoomId)) {
        return true;
    }

    if (!liveStateService.isLiveStateEnabled()) {
        return false;
    }

    const liveState = await liveStateService.getLiveState(normalizedRoomId);
    return liveStateService.isRoomLive(liveState);
}

function buildRoomListMetricContext(endpoint, req, params = {}) {
    return {
        endpoint,
        actorRole: req.user?.role || 'guest',
        authenticated: Boolean(req.user),
        page: Number(params.page || 1),
        limit: Number(params.limit || 50),
        sort: params.sort ? String(params.sort) : null,
        searchLength: String(params.search || '').length,
    };
}

function logRoomListRequestResult(endpoint, req, params, startTime, payload, cacheHit) {
    const durationMs = Date.now() - startTime;
    const metricContext = buildRoomListMetricContext(endpoint, req, params);
    const totalCount = payload?.pagination?.total ?? payload?.total ?? null;
    const resultCount = Array.isArray(payload?.data) ? payload.data.length : 0;

    metricsService.incrementCounter(
        cacheHit ? 'api.room_list.cache_hit' : 'api.room_list.cache_miss',
        1,
        { endpoint },
        { log: false }
    );
    metricsService.recordTiming(
        'api.room_list.duration_ms',
        durationMs,
        { endpoint, cache: cacheHit ? 'hit' : 'miss', status: 'success' },
        { log: false }
    );
    metricsService.emitLog('info', 'api.room_list.request', {
        ...metricContext,
        status: 'success',
        cacheHit,
        durationMs,
        resultCount,
        totalCount,
    });
}

function logRoomListRequestError(endpoint, req, params, startTime, error) {
    const durationMs = Date.now() - startTime;
    const metricContext = buildRoomListMetricContext(endpoint, req, params);

    metricsService.incrementCounter('api.room_list.error', 1, { endpoint }, { log: false });
    metricsService.recordTiming(
        'api.room_list.duration_ms',
        durationMs,
        { endpoint, cache: 'error', status: 'error' },
        { log: false }
    );
    metricsService.emitLog('error', 'api.room_list.request', {
        ...metricContext,
        status: 'error',
        cacheHit: false,
        durationMs,
        error: metricsService.safeErrorMessage(error),
    });
}

const SAFE_RECORDING_TASK_SELECT = `
    id,
    room_id,
    account_id,
    start_time,
    end_time,
    file_path,
    file_size,
    status,
    error_msg
`;

const INTERNAL_RECORDING_TASK_SELECT = `
    id,
    room_id,
    account_id,
    start_time,
    end_time,
    file_path,
    file_size,
    status,
    error_msg,
    storage_provider,
    storage_bucket,
    storage_object_key,
    storage_etag,
    storage_metadata_json,
    upload_status,
    upload_attempt_count,
    upload_started_at,
    upload_completed_at,
    upload_error_msg,
    cleanup_status,
    cleanup_attempt_count,
    cleanup_started_at,
    cleanup_completed_at,
    cleanup_error_msg,
    local_file_deleted_at
`;

const RECORDING_ACCESS_PERMISSION = 'session_maintenance.manage';

function serializeRecordingTask(task) {
    if (!task) return null;
    return {
        id: task.id,
        roomId: task.roomId,
        accountId: task.accountId,
        startTime: task.startTime,
        endTime: task.endTime,
        filePath: task.filePath,
        fileSize: task.fileSize,
        status: task.status,
        errorMsg: task.errorMsg,
    };
}

function buildRecordingAccessToken(task, user) {
    return jwt.sign({
        type: 'recording_access',
        taskId: Number(task.id || 0),
        roomId: String(task.roomId || ''),
        userId: user?.id || null,
        role: user?.role || 'user',
    }, getEffectiveRecordingAccessConfig().tokenSecret, { expiresIn: getEffectiveRecordingAccessConfig().ttlSecs });
}

function verifyRecordingAccessToken(rawToken, expectedTaskId) {
    if (!rawToken) return null;
    try {
        const decoded = jwt.verify(rawToken, getEffectiveRecordingAccessConfig().tokenSecret);
        if (decoded?.type !== 'recording_access') return null;
        if (Number(decoded?.taskId || 0) !== Number(expectedTaskId || 0)) return null;
        return decoded;
    } catch {
        return null;
    }
}

async function getRecordingTaskInternal(taskId) {
    return db.get(`SELECT ${INTERNAL_RECORDING_TASK_SELECT} FROM recording_task WHERE id = $1`, [taskId]);
}

async function ensureRecordingTaskAccess(req, task) {
    if (!task) {
        return { allowed: false, status: 404, payload: { error: 'Task not found' } };
    }
    if (!req.user) {
        return { allowed: false, status: 401, payload: { error: '请先登录' } };
    }
    if (req.user.role === 'admin') {
        if (hasAdminPermission(req.user, RECORDING_ACCESS_PERMISSION)) {
            return { allowed: true };
        }
        return {
            allowed: false,
            status: 403,
            payload: {
                error: '缺少后台权限',
                code: 'ADMIN_PERMISSION_DENIED',
                permission: RECORDING_ACCESS_PERMISSION,
            },
        };
    }
    const access = await canAccessRoom(req, task.roomId);
    if (!access.allowed) {
        return { allowed: false, status: 403, payload: { error: '无权访问此录播' } };
    }
    return { allowed: true };
}

function isRecordingStoredRemotely(task) {
    return String(task?.uploadStatus || '') === 'uploaded' && Boolean(task?.storageObjectKey);
}

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));
app.use(express.static('public')); // Serve static files first for performance

// Mount user management routes (auth, user center, subscription, admin)
app.use(userManagementRouter);

const io = new Server(httpServer, {
    cors: {
        origin: '*'
    },
    // Performance optimizations
    transports: ['websocket', 'polling'], // Prefer WebSocket, fallback to polling
    pingInterval: 10000,  // 10s instead of default 25s
    pingTimeout: 5000,    // 5s instead of default 20s
    upgradeTimeout: 10000 // Faster upgrade to WebSocket
});

// ========================
// Socket.IO - TikTok Events (USES AutoRecorder for persistent connections)
// ========================
io.on('connection', (socket) => {
    let subscribedRoomId = null;  // Room this socket is subscribed to
    let eventListeners = [];      // Track event listeners for cleanup

    console.info('New connection from origin', socket.handshake.headers['origin'] || socket.handshake.headers['referer']);

    socket.on('setUniqueId', async (uniqueId, options) => {
        // Clean up previous subscription
        if (subscribedRoomId && eventListeners.length > 0) {
            const prevWrapper = autoRecorder.getConnection(subscribedRoomId);
            if (prevWrapper) {
                eventListeners.forEach(({ event, handler }) => {
                    prevWrapper.connection.off(event, handler);
                });
            }
            eventListeners = [];
        }

        subscribedRoomId = uniqueId;

        // Check if AutoRecorder is already connected to this room
        if (autoRecorder.isConnected(uniqueId)) {
            console.log(`[Socket] Room ${uniqueId} already connected via AutoRecorder, subscribing to events`);
            const wrapper = autoRecorder.getConnection(uniqueId);
            subscribeToWrapper(socket, wrapper, uniqueId);
            socket.emit('tiktokConnected', { roomId: uniqueId, alreadyConnected: true });
            return;
        }

        // Start recording via AutoRecorder (runs independently of socket)
        try {
            socket.emit('tiktokConnecting', { roomId: uniqueId });
            const result = await autoRecorder.startRoom(uniqueId);

            // Subscribe to events
            const wrapper = autoRecorder.getConnection(uniqueId);
            if (wrapper) {
                subscribeToWrapper(socket, wrapper, uniqueId);
            }
            socket.emit('tiktokConnected', result.state);
        } catch (err) {
            // Clear subscriptions on failure to prevent receiving wrong room's events
            eventListeners = [];
            subscribedRoomId = null;
            socket.emit('tiktokDisconnected', err.toString());
        }
    });

    // Subscribe this socket to a wrapper's events (for UI display only)
    function subscribeToWrapper(socket, wrapper, roomId) {
        console.log(`[Socket] Subscribing to wrapper events for ${roomId}, wsConnected: ${wrapper?.connection?.isConnected}`);

        if (!wrapper?.connection) {
            console.error(`[Socket] ERROR: wrapper.connection is null for ${roomId}!`);
            return;
        }

        const handlers = {
            roomUser: msg => socket.emit('roomUser', msg),
            member: msg => {
                socket.emit('member', {
                    uniqueId: msg.user?.uniqueId || msg.uniqueId,
                    nickname: msg.user?.nickname || msg.nickname,
                    userId: msg.user?.userId || msg.userId
                });
            },
            chat: msg => {
                // Debug log for first few chat messages
                console.log(`[Socket] Forwarding chat from ${roomId}: ${msg.user?.uniqueId || msg.uniqueId}`);
                socket.emit('chat', {
                    uniqueId: msg.user?.uniqueId || msg.uniqueId,
                    nickname: msg.user?.nickname || msg.nickname,
                    comment: msg.comment,
                    userId: msg.user?.userId || msg.userId
                });
            },
            gift: msg => {
                const gift = msg.gift || {};
                const extendedGift = msg.extendedGiftInfo || {};
                let giftImage = '';
                if (gift.icon?.url_list?.[0]) giftImage = gift.icon.url_list[0];
                else if (extendedGift.image?.url_list?.[0]) giftImage = extendedGift.image.url_list[0];
                else if (extendedGift.icon?.url_list?.[0]) giftImage = extendedGift.icon.url_list[0];

                socket.emit('gift', {
                    uniqueId: msg.user?.uniqueId || msg.uniqueId,
                    nickname: msg.user?.nickname || msg.nickname,
                    giftId: msg.giftId || gift.id,
                    giftName: gift.giftName || extendedGift.name || 'Gift',
                    giftImage: giftImage,
                    diamondCount: gift.diamondCount || extendedGift.diamond_count || 0,
                    repeatCount: msg.repeatCount || 1,
                    repeatEnd: msg.repeatEnd
                });
            },
            like: msg => {
                socket.emit('like', {
                    uniqueId: msg.user?.uniqueId || msg.uniqueId,
                    nickname: msg.user?.nickname || msg.nickname,
                    likeCount: msg.likeCount,
                    totalLikeCount: msg.totalLikeCount
                });
            },
            streamEnd: () => socket.emit('streamEnd'),
            social: msg => socket.emit('social', msg),
            questionNew: msg => socket.emit('questionNew', msg),
            linkMicBattle: msg => socket.emit('linkMicBattle', msg),
            linkMicArmies: msg => socket.emit('linkMicArmies', msg),
            liveIntro: msg => socket.emit('liveIntro', msg),
            emote: msg => socket.emit('emote', msg),
            envelope: msg => socket.emit('envelope', msg),
            subscribe: msg => socket.emit('subscribe', msg)
        };

        // Add event listeners
        for (const [event, handler] of Object.entries(handlers)) {
            wrapper.connection.on(event, handler);
            eventListeners.push({ event, handler });
        }

        // Handle wrapper disconnect (notify UI)
        wrapper.once('disconnected', reason => {
            socket.emit('tiktokDisconnected', reason);
        });
    }

    // Unsubscribe from live events (used when switching to history view)
    // This DOES NOT stop recording - only cleans up UI event listeners
    socket.on('unsubscribe', () => {
        console.log(`[Socket] User unsubscribed from ${subscribedRoomId}. Recording continues in background.`);
        // Clean up UI listeners but do NOT call autoRecorder.disconnectRoom()
        if (subscribedRoomId && eventListeners.length > 0) {
            const wrapper = autoRecorder.getConnection(subscribedRoomId);
            if (wrapper) {
                eventListeners.forEach(({ event, handler }) => {
                    wrapper.connection.off(event, handler);
                });
            }
            eventListeners = [];
        }
        // Clear subscribed room so events don't get sent to this socket
        subscribedRoomId = null;
    });

    socket.on('requestDisconnect', async () => {
        // User manually requested stop - this DOES stop the AutoRecorder recording
        console.log('Client requested disconnect');
        try {
            if (subscribedRoomId && autoRecorder.isConnected(subscribedRoomId)) {
                await autoRecorder.disconnectRoom(subscribedRoomId);
                await invalidateRoomListCaches('socket request disconnect');
            }
            socket.emit('tiktokDisconnected', '用户手动断开');
        } catch (error) {
            console.error('[Socket] requestDisconnect failed:', error);
            socket.emit('error', '断开直播失败');
        }
    });

    socket.on('disconnect', () => {
        // Clean up event listeners but DON'T disconnect the AutoRecorder
        // Recording continues even when user leaves page!
        if (subscribedRoomId && eventListeners.length > 0) {
            const wrapper = autoRecorder.getConnection(subscribedRoomId);
            if (wrapper) {
                eventListeners.forEach(({ event, handler }) => {
                    wrapper.connection.off(event, handler);
                });
            }
            console.log(`[Socket] User left page, cleaned up listeners for ${subscribedRoomId}. Recording continues.`);
        }
    });
});

// Emit global connection statistics
setInterval(() => {
    io.emit('statistic', { globalConnectionCount: getGlobalConnectionCount() });
}, 5000);

// ========================
// REST API - Data Management
// ========================

// Sensitive setting keys that should NOT be exposed to non-admin users
const SENSITIVE_SETTING_KEYS = [
    'euler_keys', 'ai_api_key', 'ai_api_url', 'ai_model_name',
    'proxy_url', 'dynamic_tunnel_proxy', 'proxy_api_url',
    'session_id', 'port',
    'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass',
    'smtp_from', 'smtp_from_name', 'smtp_legacy_migrated', 'email_verification_enabled',
    'single_session_login_enabled',
    'session_recap_ai_points'
];

function filterSensitiveSettings(settings) {
    const filtered = {};
    for (const [key, value] of Object.entries(settings)) {
        if (!SENSITIVE_SETTING_KEYS.includes(key) && !isSensitiveRuntimeSettingKey(key) && !String(key || '').startsWith(PROMPT_TEMPLATE_PREFIX)) {
            filtered[key] = value;
        }
    }
    return filtered;
}

// Config API
app.get('/api/config', optionalAuth, async (req, res) => {
    try {
        const settings = await manager.getAllSettings();
        const canViewAllSettings = req.user && req.user.role === 'admin' && hasAdminPermission(req.user, 'settings.manage');
        res.json(canViewAllSettings ? settings : filterSensitiveSettings(settings));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Settings API - GET to load settings
app.get('/api/settings', optionalAuth, async (req, res) => {
    try {
        const settings = await manager.getAllSettings();
        const canViewAllSettings = req.user && req.user.role === 'admin' && hasAdminPermission(req.user, 'settings.manage');
        res.json(canViewAllSettings ? settings : filterSensitiveSettings(settings));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Settings API - POST to save settings (admin only)
app.post('/api/settings', authenticate, requireAdmin, requireAdminPermission('settings.manage'), async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
        }
        if (Object.keys(settings).some(k => k.startsWith('smtp_'))) {
            await manager.saveSetting('smtp_legacy_migrated', 'false');
        }
        // Refresh Euler API keys if they were updated
        if (settings.euler_keys !== undefined) {
            const dbSettings = await manager.getAllSettings();
            keyManager.refreshKeys(dbSettings);
        }
        // Reset email transporter if SMTP settings changed
        if (Object.keys(settings).some(k => k.startsWith('smtp_') || k === 'email_verification_enabled')) {
            try { require('./services/emailService').resetTransporter(); } catch (e) { }
        }
        if (Object.keys(settings).some(isSessionMaintenanceSettingKey)) {
            await autoRecorder.refreshSessionMaintenanceConfig('settings-api-save');
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Alias: POST /api/config also saves settings (admin only)
app.post('/api/config', authenticate, requireAdmin, requireAdminPermission('settings.manage'), async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
        }
        if (Object.keys(settings).some(k => k.startsWith('smtp_'))) {
            await manager.saveSetting('smtp_legacy_migrated', 'false');
        }
        // Refresh Euler API keys if they were updated
        if (settings.euler_keys !== undefined) {
            const dbSettings = await manager.getAllSettings();
            keyManager.refreshKeys(dbSettings);
        }
        // Reset email transporter if SMTP settings changed
        if (Object.keys(settings).some(k => k.startsWith('smtp_') || k === 'email_verification_enabled')) {
            try { require('./services/emailService').resetTransporter(); } catch (e) { }
        }
        if (Object.keys(settings).some(isSessionMaintenanceSettingKey)) {
            await autoRecorder.refreshSessionMaintenanceConfig('config-api-save');
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Gift Management API
app.get('/api/gifts', async (req, res) => {
    try {
        const gifts = await manager.getGifts();
        res.json(gifts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Gift display names API (for frontend batch lookup)
app.get('/api/gifts/display-names', async (req, res) => {
    try {
        const names = await manager.getGiftDisplayNames();
        res.json(names);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/gifts/:id', authenticate, requireAdmin, requireAdminPermission('gifts.manage'), async (req, res) => {
    try {
        const giftId = String(req.params.id || '').trim();
        if (!giftId) {
            return res.status(400).json({ error: '礼物ID不能为空' });
        }

        const nameCn = String(req.body?.nameCn || '').trim();
        await manager.updateGiftChineseName(giftId, nameCn);
        res.json({ success: true, giftId, nameCn });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Room Sessions API
app.get('/api/rooms/:id/sessions', optionalAuth, async (req, res) => {
    try {
        const access = await canAccessRoom(req, req.params.id);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });
        const sessions = await getCachedRoomSessions(req.params.id);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Archive Stale Live Events API (Fix for long sessions)
app.post('/api/rooms/:id/archive_stale', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        console.log(`[API] Archiving stale events for room ${req.params.id}`);
        const queuedJob = await enqueueSessionMaintenanceJob('archive_stale_live_events_room', {
            source: 'legacy-api',
            createdByUserId: req.user?.id,
            roomId: req.params.id,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            taskKey: 'archive_stale_live_events_room',
            message: buildAcceptedAdminJobMessage('单房间陈旧 LIVE 归档任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        console.error('Error archiving stale events:', err);
        res.status(500).json({ error: err.message });
    }
});

// Maintenance API: Rebuild missing session records from events
app.post('/api/maintenance/rebuild_sessions', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        console.log('[API] Rebuilding missing sessions...');
        const queuedJob = await enqueueSessionMaintenanceJob('rebuild_missing_sessions', {
            source: 'legacy-api',
            createdByUserId: req.user?.id,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            taskKey: 'rebuild_missing_sessions',
            message: buildAcceptedAdminJobMessage('缺失场次重建任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        console.error('Error rebuilding sessions:', err);
        res.status(500).json({ error: err.message });
    }
});

// Maintenance API: Merge Short Sessions
app.post('/api/maintenance/merge_sessions', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        console.log('[API] Merging short sessions...');
        const queuedJob = await enqueueSessionMaintenanceJob('merge_continuity_sessions', {
            source: 'legacy-api',
            createdByUserId: req.user?.id,
            gapMinutes: req.body?.gapMinutes,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            taskKey: 'merge_continuity_sessions',
            message: buildAcceptedAdminJobMessage('同日连续场次合并任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        console.error('Error merging sessions:', err);
        res.status(500).json({ error: err.message });
    }
});

// FFmpeg Maintenance APIs
app.get('/api/maintenance/ffmpeg', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const status = await ffmpegManager.checkFFmpegStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/maintenance/ffmpeg/install', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const force = req.body.force === true;

        // Start installation in background or wait?
        // Let's wait, but user might timeout. Installation is fast (70MB download).
        // Let's set a long timeout on client or return "started" and poll?
        // Simple first: await.
        const result = await ffmpegManager.installFFmpeg(force);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Price API
app.post('/api/price', (req, res) => {
    const { id, price } = req.body;
    manager.savePrice(id, parseFloat(price));
    res.json({ success: true });
});

// Room API
// Get user's room quota info (for add-room modal)
app.get('/api/rooms/quota', optionalAuth, async (req, res) => {
    try {
        if (!req.user) return res.json({ quota: null });
        if (req.user.role === 'admin') {
            return res.json({
                quota: {
                    isAdmin: true,
                    limit: -1,
                    totalLimit: -1,
                    used: 0,
                    remaining: -1,
                    isUnlimited: true,
                    dailyLimit: -1,
                    dailyUsed: 0,
                    dailyRemaining: -1,
                }
            });
        }
        const quota = await getUserQuota(req.user.id);
        res.json({ quota });
    } catch (err) {
        console.error('[API] Quota error:', err.message);
        res.status(500).json({ error: '获取配额失败' });
    }
});

app.get('/api/rooms/stats', optionalAuth, async (req, res) => {
    const startTime = Date.now();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const sort = req.query.sort || 'default';

    try {
        const roomStatsCache = await readRoomListCache('stats', req, { page, limit, search, sort });
        if (roomStatsCache.payload) {
            const liveRoomIds = await getEffectiveLiveRoomIds();
            const cachedPayload = applyLiveStateToRoomPayload(roomStatsCache.payload, liveRoomIds, {
                sortLiveFirst: sort === 'default' || sort === 'updated_at',
            });
            logRoomListRequestResult('/api/rooms/stats', req, { page, limit, search, sort }, startTime, cachedPayload, true);
            return res.json(cachedPayload);
        }

        const { roomFilter, userRoomData } = await getUserRoomAccessContext(req);
        const liveRoomIds = await getEffectiveLiveRoomIds();

        console.log(`[API] /api/rooms/stats - user: ${req.user?.username || 'anonymous'}, role: ${req.user?.role || 'none'}, roomFilter: ${roomFilter === null ? 'null(admin)' : roomFilter?.length + ' rooms'}`);

        const result = await manager.getRoomStats(liveRoomIds, { page, limit, search, sort, roomFilter });

        // For members: overlay displayName from user_room alias
        if (userRoomData && result.data) {
            result.data = result.data.map(room => {
                const copy = userRoomData[room.roomId];
                return {
                    ...room,
                    displayName: resolveRoomDisplayName({
                        roomId: room.roomId,
                        alias: copy?.alias || '',
                        roomName: room.name || ''
                    }),
                    firstAddedAt: copy ? copy.firstAddedAt : null,
                };
            });
        }

        const payload = await writeRoomListCache(roomStatsCache.cacheKey, result);
        logRoomListRequestResult('/api/rooms/stats', req, { page, limit, search, sort }, startTime, payload, false);
        res.json(payload);
    } catch (err) {
        logRoomListRequestError('/api/rooms/stats', req, { page, limit, search, sort }, startTime, err);
        res.status(500).json({ error: err.message });
    }
});

// Debug API for connection diagnostics
app.get('/api/debug/connections', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), (req, res) => {
    try {
        const stats = autoRecorder.getConnectionStats();
        res.json({
            activeCount: stats.length,
            connections: stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms', optionalAuth, async (req, res) => {
    const startTime = Date.now();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';

    try {
        const roomsCache = await readRoomListCache('rooms', req, { page, limit, search });
        if (roomsCache.payload) {
            const liveRoomIds = await getEffectiveLiveRoomIds();
            const cachedPayload = applyLiveStateToRoomPayload(roomsCache.payload, liveRoomIds);
            logRoomListRequestResult('/api/rooms', req, { page, limit, search }, startTime, cachedPayload, true);
            return res.json(cachedPayload);
        }

        const { roomFilter, userRoomData } = await getUserRoomAccessContext(req);
        const result = await manager.getRooms({ page, limit, search, roomFilter });

        const liveRoomIds = await getEffectiveLiveRoomIds();
        result.data = result.data.map(room => {
            const copy = userRoomData ? userRoomData[room.roomId] : null;
            return {
                ...room,
                isLive: liveRoomIds.includes(room.roomId),
                displayName: resolveRoomDisplayName({
                    roomId: room.roomId,
                    alias: copy?.alias || '',
                    roomName: room.name || ''
                }),
                firstAddedAt: copy ? copy.firstAddedAt : null,
            };
        });

        const payload = await writeRoomListCache(roomsCache.cacheKey, result);
        logRoomListRequestResult('/api/rooms', req, { page, limit, search }, startTime, payload, false);
        res.json(payload);
    } catch (err) {
        logRoomListRequestError('/api/rooms', req, { page, limit, search }, startTime, err);
        res.status(500).json({ error: err.message });
    }
});

// Room Management API


app.delete('/api/rooms/:id', authenticate, async (req, res) => {
    try {
        const roomId = req.params.id;
        const isAdmin = req.user.role === 'admin';

        if (isAdmin) {
            // Admin: hard delete system room + all data
            await manager.deleteRoom(roomId);
            await invalidateRoomListCaches('admin room delete');
            return res.json({ success: true });
        }

        // Member: soft-delete user_room copy only
        const copy = await db.get('SELECT id FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NULL', [req.user.id, roomId]);
        if (!copy) {
            return res.status(403).json({ error: '无权访问此房间' });
        }

        await db.run('UPDATE user_room SET deleted_at = NOW(), is_enabled = false, updated_at = NOW() WHERE id = ?', [copy.id]);
        console.log(`[API] User ${req.user.id} soft-deleted room copy: ${roomId}`);

        // Check if this was the last active copy - if so, disable monitoring to save resources
        const remainingCopies = await db.get(
            'SELECT COUNT(*) AS count FROM user_room WHERE room_id = ? AND deleted_at IS NULL',
            [roomId]
        );
        if (Number(remainingCopies?.count || 0) === 0) {
            console.log(`[API] Room ${roomId} has no active copies left, disabling monitoring`);
            await db.run('UPDATE room SET is_monitor_enabled = 0, updated_at = NOW() WHERE room_id = ?', [roomId]);
            await autoRecorder.disconnectRoom(roomId);
        }

        await invalidateRoomListCaches('member room delete');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:id/stats_detail', optionalAuth, async (req, res) => {
    try {
        const roomId = req.params.id;
        const access = await canAccessRoom(req, roomId);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });

        const sessionId = req.query.sessionId || null;

        // Get stats
        const data = await getCachedArchivedStatsDetail(roomId, sessionId);

        // Get isLive status
        const isLive = await getEffectiveRoomLiveFlag(roomId);

        // Get last session for fallback
        const sessions = await getCachedRoomSessions(roomId);
        const lastSession = sessions && sessions.length > 0 ? sessions[0] : null;
        const roomName = await getRoomDisplayNameForRequest(req, roomId);

        res.json({
            ...data,
            roomName,
            isLive,
            lastSession,
            currentSessionId: sessionId
        });
    } catch (err) {
        console.error('[API] stats_detail error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:id/session-recap', optionalAuth, async (req, res) => {
    try {
        const roomId = req.params.id;
        const access = await canAccessRoom(req, roomId);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });

        const featureAccess = await ensureUserPlanFeature(
            req,
            ['ai_live_recap', 'aiLiveRecap'],
            'AI直播复盘为指定套餐权益，请升级套餐后使用',
            'LIVE_RECAP_NOT_ALLOWED'
        );
        if (!featureAccess.allowed) return res.status(featureAccess.status).json(featureAccess.payload);

        const sessionId = req.query.sessionId || 'live';
        const sessionRecapPointCost = await getAiPointCost(AI_POINT_SCENES.SESSION_RECAP);
        const roomFilter = await getUserRoomFilter(req);
        const recap = await getCachedSessionRecap(roomId, sessionId, req, roomFilter);
        const cachedReview = req.user && sessionId !== 'live'
            ? await getCachedSessionAiReview(req.user.id, roomId, sessionId)
            : null;
        const latestAiJob = req.user && sessionId !== 'live'
            ? await getLatestSessionAiWorkJobForUser(req.user.id, roomId, sessionId)
            : null;

        res.json({
            sessionId,
            pointCost: sessionRecapPointCost,
            overview: {
                score: recap?.overview?.score || 0,
                grade: recap?.overview?.grade || '-',
                gradeLabel: recap?.overview?.gradeLabel || '暂无数据',
                dominantTag: recap?.overview?.dominantTag || '',
                tags: Array.isArray(recap?.overview?.tags) ? recap.overview.tags : [],
                totalGiftValue: Number(recap?.overview?.totalGiftValue || 0),
                totalComments: Number(recap?.overview?.totalComments || 0),
                totalLikes: Number(recap?.overview?.totalLikes || 0),
                totalVisits: Number(recap?.overview?.totalVisits || 0),
                duration: Number(recap?.overview?.duration || 0),
                startTime: recap?.overview?.startTime || null,
                participantCount: Number(recap?.overview?.participantCount || 0),
                payingUsers: Number(recap?.overview?.payingUsers || 0),
                chattingUsers: Number(recap?.overview?.chattingUsers || 0),
                topGiftShare: Number(recap?.overview?.topGiftShare || 0),
                sessionMode: recap?.overview?.sessionMode || 'live',
                trafficMetricLabel: recap?.overview?.trafficMetricLabel || '在线波动'
            },
            timeline: Array.isArray(recap?.timeline)
                ? recap.timeline.map(item => ({
                    timeRange: item.time_range,
                    income: Number(item.income || 0),
                    comments: Number(item.comments || 0),
                    maxOnline: Number(item.max_online || 0)
                }))
                : [],
            radar: Array.isArray(recap?.radar) ? recap.radar.map(item => ({ label: item.label, value: Number(item.value || 0) })) : [],
            keyMoments: Array.isArray(recap?.keyMoments) ? recap.keyMoments.map(item => ({
                type: item.type,
                title: item.title,
                timeRange: item.timeRange,
                metric: item.metric,
                description: item.description
            })) : [],
            insights: {
                highlights: normalizeAiReviewList(recap?.insights?.highlights),
                issues: normalizeAiReviewList(recap?.insights?.issues),
                actions: normalizeAiReviewList(recap?.insights?.actions)
            },
            valueCustomers: {
                core: Array.isArray(recap?.valueCustomers?.core) ? recap.valueCustomers.core.map(serializeValueCustomer) : [],
                potential: Array.isArray(recap?.valueCustomers?.potential) ? recap.valueCustomers.potential.map(serializeValueCustomer) : [],
                risk: Array.isArray(recap?.valueCustomers?.risk) ? recap.valueCustomers.risk.map(serializeValueCustomer) : []
            },
            aiReview: serializeSessionAiReview(cachedReview),
            aiJob: serializeSessionAiWorkJobForClient(latestAiJob)
        });
    } catch (err) {
        console.error('[API] session recap error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/rooms/:id/session-recap/ai', optionalAuth, async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: '请先登录' });

        const roomId = req.params.id;
        const access = await canAccessRoom(req, roomId);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });

        const featureAccess = await ensureUserPlanFeature(
            req,
            ['ai_live_recap', 'aiLiveRecap'],
            'AI直播复盘为指定套餐权益，请升级套餐后使用',
            'LIVE_RECAP_NOT_ALLOWED'
        );
        if (!featureAccess.allowed) return res.status(featureAccess.status).json(featureAccess.payload);

        const sessionId = String(req.body?.sessionId || '').trim();
        const sessionRecapPointCost = await getAiPointCost(AI_POINT_SCENES.SESSION_RECAP);
        const force = parseRequestBoolean(req.body?.force);
        if (!sessionId) return res.status(400).json({ error: '请选择场次' });
        if (sessionId === 'live') return res.status(400).json({ error: '请先切到已归档场次，再生成 AI 直播复盘' });

        const session = await manager.getSession(sessionId);
        if (!session) {
            console.warn(`[AI] session-recap submit missing session row: room=${roomId}, session=${sessionId}`);
        } else if (String(session.roomId || '') !== String(roomId)) {
            console.warn(`[AI] session-recap submit room mismatch: requestRoom=${roomId}, sessionRoom=${session.roomId}, session=${sessionId}`);
        }

        if (!force) {
            const cachedReview = await getCachedSessionAiReview(req.user.id, roomId, sessionId);
            if (cachedReview) {
                return res.json({
                    review: serializeSessionAiReview(cachedReview),
                    cached: true,
                    pointCost: sessionRecapPointCost,
                    chargedPoints: 0
                });
            }
        }

        const existingJob = await findReusableAiWorkJob({
            userId: req.user.id,
            jobType: AI_WORK_JOB_TYPE_SESSION_RECAP,
            roomId,
            sessionId
        });
        if (existingJob) {
            return res.status(202).json({
                accepted: true,
                queued: existingJob.status === 'queued',
                processing: existingJob.status === 'processing',
                reused: true,
                pointCost: sessionRecapPointCost,
                job: serializeSessionAiWorkJobForClient(existingJob),
                message: 'AI 已启动，正在后台工作中，无需一直等待，完成后会主动通知。'
            });
        }

        const isAdmin = req.user.role === 'admin';
        if (!isAdmin && !hasConfirmedAiConsumption(req)) {
            return res.status(409).json(
                buildAiConsumptionConfirmationPayload(force ? '重新生成 AI直播复盘' : '生成 AI直播复盘', sessionRecapPointCost)
            );
        }
        if (!isAdmin) {
            const credits = await db.get('SELECT ai_credits_remaining FROM users WHERE id = ?', [req.user.id]);
            const remaining = Number(credits?.aiCreditsRemaining || 0);
            if (remaining < sessionRecapPointCost) {
                return res.status(403).json({ error: 'AI 点数不足，请购买点数包或升级套餐', code: 'AI_CREDITS_EXHAUSTED' });
            }
        }

        const creationResult = await createAiWorkJobWithLock({
            lockScope: 'ai_work_job:session_recap',
            lockIdentity: `${req.user.id}:${roomId}:${sessionId}`,
            findExistingJob: () => findReusableAiWorkJob({
                userId: req.user.id,
                jobType: AI_WORK_JOB_TYPE_SESSION_RECAP,
                roomId,
                sessionId
            }),
            createJob: client => createAiWorkJob({
                userId: req.user.id,
                jobType: AI_WORK_JOB_TYPE_SESSION_RECAP,
                roomId,
                sessionId,
                pointCost: sessionRecapPointCost,
                forceRegenerate: force,
                isAdmin,
                requestPayload: {
                    trigger: 'user_submit',
                    roomId,
                    sessionId,
                    force,
                    pointCost: sessionRecapPointCost
                },
                client
            })
        });
        const job = creationResult.job;
        if (creationResult.reused) {
            return res.status(202).json({
                accepted: true,
                queued: job.status === 'queued',
                processing: job.status === 'processing',
                reused: true,
                pointCost: sessionRecapPointCost,
                job: serializeSessionAiWorkJobForClient(job),
                message: 'AI 已启动，正在后台工作中，无需一直等待，完成后会主动通知。'
            });
        }

        await appendAiWorkJobLog(job.id, {
            phase: 'queued',
            level: 'info',
            message: '任务已入队，等待后台调度',
            payload: { roomId, sessionId, force, pointCost: sessionRecapPointCost }
        });

        res.status(202).json({
            accepted: true,
            queued: true,
            cached: false,
            pointCost: sessionRecapPointCost,
            job: serializeSessionAiWorkJobForClient(job),
            message: 'AI 已启动，正在后台工作中，无需一直等待，完成后会主动通知。'
        });
    } catch (err) {
        console.error('[AI] Queue session recap error:', err);
        res.status(500).json({ error: '创建 AI直播复盘任务失败，请稍后重试' });
    }
});

// All-Time TOP30 Leaderboards API (for room detail sidebar)
app.get('/api/rooms/:id/alltime-leaderboards', optionalAuth, async (req, res) => {
    try {
        const roomId = req.params.id;
        const access = await canAccessRoom(req, roomId);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });

        const cacheKey = buildAllTimeLeaderboardsCacheKey(roomId);
        if (cacheService.isRoomCacheEnabled() && ALLTIME_LEADERBOARDS_CACHE_TTL_MS > 0) {
            const cached = await cacheService.getJson(cacheKey);
            if (cached) {
                return res.json(cached);
            }
        }

        const data = await manager.getAllTimeLeaderboards(roomId);

        if (cacheService.isRoomCacheEnabled() && ALLTIME_LEADERBOARDS_CACHE_TTL_MS > 0) {
            await cacheService.setJson(cacheKey, data, { ttlMs: ALLTIME_LEADERBOARDS_CACHE_TTL_MS });
        }

        res.json(data);
    } catch (err) {
        console.error('[API] alltime-leaderboards error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Session API
app.post('/api/sessions/end', async (req, res) => {
    try {
        const { roomId, snapshot, startTime } = req.body;

        // Create session first to get session_id
        const sessionId = await manager.createSession(roomId, snapshot);

        // Tag all untagged events for this room with the new session_id
        await manager.tagEventsWithSession(roomId, sessionId, startTime);

        await invalidateRoomDetailCaches(roomId, sessionId);

        console.log(`[SESSION] Ended session ${sessionId} for room ${roomId}, events tagged`);
        res.json({ success: true, sessionId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions', optionalAuth, async (req, res) => {
    try {
        const roomId = req.query.roomId;
        if (roomId) {
            const access = await canAccessRoom(req, roomId);
            if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });
        }
        const sessions = roomId ? await getCachedRoomSessions(roomId) : await manager.getSessions(roomId);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions/:id', optionalAuth, async (req, res) => {
    try {
        const data = await manager.getSession(req.params.id);
        if (data) {
            // Check room access via session's room_id
            const access = await canAccessRoom(req, data.roomId);
            if (!access.allowed) return res.status(403).json({ error: '无权访问' });
            res.json(data);
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// History API
app.get('/api/history', optionalAuth, async (req, res) => {
    try {
        const roomId = req.query.roomId;
        if (roomId) {
            const access = await canAccessRoom(req, roomId);
            if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });
        }
        const stats = await manager.getTimeStats(roomId, req.query.sessionId || null);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// User Analysis API
app.get('/api/analysis/users', optionalAuth, async (req, res) => {
    try {
        const personalityPointCost = await getAiPointCost(AI_POINT_SCENES.USER_PERSONALITY);
        const includeTopGifts = req.query.includeTopGifts === undefined
            ? true
            : parseRequestBoolean(req.query.includeTopGifts);
        const includeHistoryMeta = req.query.includeHistoryMeta === undefined
            ? true
            : parseRequestBoolean(req.query.includeHistoryMeta);
        const filters = {
            lang: req.query.lang || '',
            languageFilter: req.query.languageFilter || '',
            minRooms: parseInt(req.query.minRooms) || 1,
            activeHour: req.query.activeHour !== undefined ? req.query.activeHour : null,
            activeHourEnd: req.query.activeHourEnd !== undefined ? req.query.activeHourEnd : null,
            search: req.query.search || '',
            searchExact: req.query.searchExact === 'true',
            giftPreference: req.query.giftPreference || '',
            includeTopGifts,
            includeHistoryMeta
        };
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const roomFilter = await getUserRoomFilter(req);
        if (roomFilter) filters.roomFilter = roomFilter;
        console.log(`[API] /api/analysis/users - user: ${req.user?.username || 'anonymous'}, role: ${req.user?.role || 'none'}, roomFilter: ${roomFilter === null ? 'null(admin)' : JSON.stringify(roomFilter)}`);

        const cacheKey = buildAnalysisCacheKey('users', req, roomFilter, {
            page,
            pageSize,
            lang: filters.lang,
            languageFilter: filters.languageFilter,
            minRooms: filters.minRooms,
            activeHour: filters.activeHour,
            activeHourEnd: filters.activeHourEnd,
            search: filters.search,
            searchExact: filters.searchExact,
            giftPreference: filters.giftPreference,
            includeTopGifts,
            includeHistoryMeta
        });
        const result = await getCachedAnalysisPayload(cacheKey, () => manager.getTopGifters(page, pageSize, filters));
        result.pointCost = personalityPointCost;
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analysis/users/enrichment', optionalAuth, async (req, res) => {
    try {
        const rawUserIds = String(req.query.userIds || '');
        const userIds = rawUserIds
            .split(',')
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .slice(0, 200);
        if (userIds.length === 0) {
            return res.json({ users: [] });
        }

        const includeTopGifts = req.query.includeTopGifts !== 'false';
        const includeHistoryMeta = req.query.includeHistoryMeta !== 'false';
        const roomFilter = await getUserRoomFilter(req);
        const cacheKey = buildAnalysisCacheKey('users_enrichment', req, roomFilter, {
            userIds: [...userIds].sort(),
            includeTopGifts,
            includeHistoryMeta
        });
        const users = await getCachedAnalysisPayload(cacheKey, async () => {
            const rows = await manager.getUserListEnrichment(userIds, {
                roomFilter,
                includeTopGifts,
                includeHistoryMeta
            });
            return rows.map((row) => ({
                userId: String(row.userId || ''),
                topGifts: Array.isArray(row.topGifts)
                    ? row.topGifts.map((gift) => ({
                        name: String(gift?.name || ''),
                        icon: String(gift?.icon || ''),
                        unitPrice: Number(gift?.unitPrice || 0),
                        totalValue: Number(gift?.totalValue || 0),
                        count: Number(gift?.count || 0)
                    }))
                    : undefined,
                historyUniqueIds: Array.isArray(row.historyUniqueIds) ? row.historyUniqueIds.map((item) => String(item || '')) : undefined,
                historyNicknames: Array.isArray(row.historyNicknames) ? row.historyNicknames.map((item) => String(item || '')) : undefined,
                historyAliasCount: row.historyAliasCount === undefined ? undefined : Number(row.historyAliasCount || 0)
            }));
        });

        res.json({ users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analysis/user/:userId', optionalAuth, async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: '请先登录' });
        const personalityPointCost = await getAiPointCost(AI_POINT_SCENES.USER_PERSONALITY);
        const roomFilter = await getUserRoomFilter(req);
        const [data, memberAnalysis, latestAiJob] = await Promise.all([
            getCachedUserAnalysisBase(req, req.params.userId, roomFilter),
            getCachedLatestMemberPersonalityAnalysis(req.user.id, req.params.userId),
            getLatestPersonalityAiWorkJobForUser(req.user.id, req.params.userId)
        ]);

        const response = serializeUserAnalysisDetail(data);
        response.pointCost = personalityPointCost;
        response.aiAnalysis = memberAnalysis?.result || null;
        response.aiAnalysisJson = safeParseJsonObject(memberAnalysis?.resultJson);
        if (latestAiJob && ['queued', 'processing'].includes(String(latestAiJob.status || '').toLowerCase())) {
            response.aiJob = serializeSessionAiWorkJobForClient(latestAiJob);
        }

        res.json(response);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export API - fetch user list with full details for export
app.get('/api/analysis/users/export', optionalAuth, async (req, res) => {
    try {
        const exportAccess = await ensureUserPlanFeature(
            req,
            ['export', 'data_export'],
            '数据导出为付费功能，请升级套餐后使用',
            'EXPORT_NOT_ALLOWED'
        );
        if (!exportAccess.allowed) {
            return res.status(exportAccess.status).json(exportAccess.payload);
        }

        const filters = {
            lang: req.query.lang || '',
            languageFilter: req.query.languageFilter || '',
            minRooms: parseInt(req.query.minRooms) || 1,
            activeHour: req.query.activeHour !== undefined ? req.query.activeHour : null,
            activeHourEnd: req.query.activeHourEnd !== undefined ? req.query.activeHourEnd : null,
            search: req.query.search || '',
            giftPreference: req.query.giftPreference || '',
            includeTopGifts: true,
            includeHistoryMeta: false
        };
        const limit = parseInt(req.query.limit) || 1000;
        const roomFilter = await getUserRoomFilter(req);
        if (roomFilter) filters.roomFilter = roomFilter;

        const exportListCacheKey = buildAnalysisCacheKey('users_export_list', req, roomFilter, {
            limit,
            lang: filters.lang,
            languageFilter: filters.languageFilter,
            minRooms: filters.minRooms,
            activeHour: filters.activeHour,
            activeHourEnd: filters.activeHourEnd,
            search: filters.search,
            giftPreference: filters.giftPreference,
            includeTopGifts: true
        });
        const result = await getCachedAnalysisPayload(exportListCacheKey, () => manager.getTopGifters(1, limit, filters));
        const memberAnalysisMap = await getLatestMemberPersonalityAnalysisMap(req.user.id, result.users.map(user => user.userId));

        const usersWithDetails = await mapWithConcurrency(result.users, 8, async (user) => {
            const details = await getCachedUserAnalysisBase(req, user.userId, roomFilter);
            const aiAnalysis = memberAnalysisMap.get(user.userId)?.result || null;

            return {
                ...user,
                ...details,
                aiAnalysis,
                topGiftsText: (user.topGifts || []).map(g => `${g.giftName || g.giftId}(${g.totalValue})`).join(', '),
                roseValue: user.roseValue || 0,
                tiktokValue: user.tiktokValue || 0,
                giftRoomsText: (details.giftRooms || []).slice(0, 5).map(r => `${r.name || r.roomId}(${r.val})`).join(', '),
                visitRoomsText: (details.visitRooms || []).slice(0, 5).map(r => `${r.name || r.roomId}(${r.cnt}次)`).join(', '),
                peakHours: formatPeakHours(details.hourStats),
                peakDays: formatPeakDays(details.dayStats)
            };
        });

        res.json({ users: usersWithDetails, total: result.total });
    } catch (err) {
        console.error('[Export API Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper functions for export
function formatPeakHours(hourStats) {
    if (!hourStats || hourStats.length === 0) return '';
    const sorted = [...hourStats].sort((a, b) => (b.cnt || 0) - (a.cnt || 0));
    return sorted.slice(0, 3).map(h => `${h.hour}时`).join(', ');
}

function formatPeakDays(dayStats) {
    if (!dayStats || dayStats.length === 0) return '';
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const sorted = [...dayStats].sort((a, b) => (b.cnt || 0) - (a.cnt || 0));
    return sorted.slice(0, 3).map(d => dayNames[parseInt(d.day)] || '').join(', ');
}

async function mapWithConcurrency(items, concurrency, iterator) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const normalizedConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= items.length) {
                return;
            }
            results[currentIndex] = await iterator(items[currentIndex], currentIndex);
        }
    }

    await Promise.all(Array.from({ length: normalizedConcurrency }, () => worker()));
    return results;
}

function serializeUserAnalysisDetail(data = {}) {
    return {
        totalValue: data.totalValue || 0,
        activeDays: data.activeDays || 0,
        dailyAvg: data.dailyAvg || 0,
        giftRooms: Array.isArray(data.giftRooms) ? data.giftRooms : [],
        visitRooms: Array.isArray(data.visitRooms) ? data.visitRooms : [],
        hourStats: Array.isArray(data.hourStats) ? data.hourStats : [],
        dayStats: Array.isArray(data.dayStats) ? data.dayStats : [],
        isAdmin: data.isAdmin || 0,
        isSuperAdmin: data.isSuperAdmin || 0,
        isModerator: data.isModerator || 0,
        fanLevel: data.fanLevel || 0,
        fanClubName: data.fanClubName || '',
        commonLanguage: data.commonLanguage || '',
        masteredLanguages: data.masteredLanguages || '',
        region: data.region || '',
        aiAnalysis: data.aiAnalysis || null,
        aiAnalysisJson: safeParseJsonObject(data.aiAnalysisJson),
        aiJob: data.aiJob ? serializeSessionAiWorkJobForClient(data.aiJob) : null,
        moderatorRooms: Array.isArray(data.moderatorRooms) ? data.moderatorRooms : [],
        historyUniqueIds: Array.isArray(data.historyUniqueIds) ? data.historyUniqueIds : [],
        historyNicknames: Array.isArray(data.historyNicknames) ? data.historyNicknames : [],
        historyAliasCount: Number(data.historyAliasCount || 0)
    };
}

function safeParseJsonObject(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch (err) {
        return null;
    }
}

function buildMemberPersonalityAnalysisVersionKey(memberId, targetUserId) {
    return cacheService.buildCacheKey('analysis', 'member_personality_ai_version', memberId, targetUserId);
}

function buildMemberPersonalityAnalysisCacheKey(memberId, targetUserId, cacheVersion = 0) {
    return cacheService.buildCacheKey('analysis', 'member_personality_ai_latest', memberId, targetUserId, Number(cacheVersion || 0));
}

function buildMemberAnalysisVersionKey(memberId, targetUserId) {
    return buildMemberPersonalityAnalysisVersionKey(memberId, targetUserId);
}

function buildMemberAnalysisCacheKey(memberId, targetUserId, cacheVersion = 0) {
    return buildMemberPersonalityAnalysisCacheKey(memberId, targetUserId, cacheVersion);
}

async function getMemberPersonalityAnalysisCacheVersion(memberId, targetUserId) {
    if (!memberId || !targetUserId || !cacheService.isRoomCacheEnabled()) {
        return 0;
    }

    const version = await cacheService.getNumber(buildMemberPersonalityAnalysisVersionKey(memberId, targetUserId));
    return Number.isFinite(version) && version > 0 ? version : 0;
}

async function getMemberAnalysisCacheVersion(memberId, targetUserId) {
    return getMemberPersonalityAnalysisCacheVersion(memberId, targetUserId);
}

async function invalidateMemberPersonalityAnalysisCache(memberId, targetUserId) {
    if (!memberId || !targetUserId || !cacheService.isRoomCacheEnabled()) {
        return 0;
    }

    return cacheService.increment(buildMemberPersonalityAnalysisVersionKey(memberId, targetUserId), 1);
}

async function invalidateMemberAnalysisCache(memberId, targetUserId) {
    return invalidateMemberPersonalityAnalysisCache(memberId, targetUserId);
}

async function getCachedLatestMemberPersonalityAnalysis(memberId, targetUserId) {
    if (!memberId || !targetUserId || !cacheService.isRoomCacheEnabled() || ANALYSIS_CACHE_TTL_MS <= 0) {
        return getLatestMemberPersonalityAnalysis(memberId, targetUserId);
    }

    const cacheVersion = await getMemberPersonalityAnalysisCacheVersion(memberId, targetUserId);
    const cacheKey = buildMemberPersonalityAnalysisCacheKey(memberId, targetUserId, cacheVersion);
    const cached = await cacheService.getJson(cacheKey);
    if (cached) return cached;

    const latest = await getLatestMemberPersonalityAnalysis(memberId, targetUserId);
    if (latest) {
        await cacheService.setJson(cacheKey, latest, { ttlMs: ANALYSIS_CACHE_TTL_MS });
    }
    return latest;
}

async function getLatestMemberPersonalityAnalysis(memberId, targetUserId) {
    if (!memberId || !targetUserId) return null;

    return await db.get(
        `SELECT result, result_json, chat_count, created_at, model_name, model_version, prompt_key, prompt_updated_at, context_version, current_room_id, latency_ms, source
         FROM user_ai_analysis
         WHERE member_id = ?
           AND target_user_id = ?
           AND (prompt_key = ? OR prompt_key IS NULL OR prompt_key = '')
           AND COALESCE(current_room_id, '') = ''
         ORDER BY created_at DESC
         LIMIT 1`,
        [memberId, targetUserId, USER_PERSONALITY_ANALYSIS_PROMPT_KEY]
    );
}

async function getLatestMemberPersonalityAnalysisMap(memberId, targetUserIds = []) {
    if (!memberId || !Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return new Map();
    }

    const placeholders = targetUserIds.map(() => '?').join(',');
    const rows = await db.query(
        `SELECT DISTINCT ON (target_user_id) target_user_id, result, result_json, chat_count, created_at, model_name, model_version, prompt_key, prompt_updated_at, context_version, current_room_id, latency_ms, source
         FROM user_ai_analysis
         WHERE member_id = ?
           AND target_user_id IN (${placeholders})
           AND (prompt_key = ? OR prompt_key IS NULL OR prompt_key = '')
           AND COALESCE(current_room_id, '') = ''
         ORDER BY target_user_id, created_at DESC`,
        [memberId, ...targetUserIds, USER_PERSONALITY_ANALYSIS_PROMPT_KEY]
    );

    return new Map(rows.map(row => [row.targetUserId, row]));
}

async function getLatestMemberRoomCustomerAnalysis(memberId, targetUserId, roomId) {
    if (!memberId || !targetUserId || !roomId) return null;

    return await db.get(
        `SELECT result, result_json, chat_count, created_at, model_name, model_version, prompt_key, prompt_updated_at, context_version, current_room_id, latency_ms, source
         FROM user_ai_analysis
         WHERE member_id = ?
           AND target_user_id = ?
           AND prompt_key = ?
           AND COALESCE(current_room_id, '') = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [memberId, targetUserId, 'customer_analysis_review', String(roomId || '')]
    );
}

async function getCachedLatestMemberAnalysis(memberId, targetUserId) {
    return getCachedLatestMemberPersonalityAnalysis(memberId, targetUserId);
}

async function getLatestMemberAnalysis(memberId, targetUserId) {
    return getLatestMemberPersonalityAnalysis(memberId, targetUserId);
}

async function getLatestMemberAnalysisMap(memberId, targetUserIds = []) {
    return getLatestMemberPersonalityAnalysisMap(memberId, targetUserIds);
}

function normalizeCacheTimestamp(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function sameInstant(leftValue, rightValue) {
    const left = normalizeCacheTimestamp(leftValue);
    const right = normalizeCacheTimestamp(rightValue);
    if (left === null && right === null) return true;
    return left === right;
}

function isUserPersonalityAnalysisCacheReusable(cacheRecord, { promptKey = USER_PERSONALITY_ANALYSIS_PROMPT_KEY, promptUpdatedAt = null } = {}) {
    if (!cacheRecord) return false;

    const cachePromptKey = String(cacheRecord.promptKey || '').trim();
    if (cachePromptKey && cachePromptKey !== String(promptKey || '')) return false;
    if (cachePromptKey && !sameInstant(cacheRecord.promptUpdatedAt, promptUpdatedAt)) return false;
    if (String(cacheRecord.currentRoomId || '').trim()) return false;

    const cacheCreatedAt = normalizeCacheTimestamp(cacheRecord.updatedAt || cacheRecord.createdAt);
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
    return cacheCreatedAt !== null && cacheCreatedAt >= ninetyDaysAgo;
}

function isCustomerAnalysisCacheReusable(cacheRecord, cacheSignature) {
    if (!cacheRecord || !cacheSignature) return false;

    if (String(cacheRecord.promptKey || '') !== String(cacheSignature.promptKey || '')) return false;
    if (!sameInstant(cacheRecord.promptUpdatedAt, cacheSignature.promptUpdatedAt)) return false;
    if (String(cacheRecord.contextVersion || '') !== String(cacheSignature.contextVersion || '')) return false;
    if (String(cacheRecord.currentRoomId || '') !== String(cacheSignature.currentRoomId || '')) return false;

    const latestActivityAt = normalizeCacheTimestamp(cacheSignature.latestActivityAt);
    const cacheCreatedAt = normalizeCacheTimestamp(cacheRecord.updatedAt || cacheRecord.createdAt);
    if (latestActivityAt !== null && cacheCreatedAt !== null && cacheCreatedAt < latestActivityAt) return false;

    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
    if (cacheCreatedAt !== null && cacheCreatedAt < ninetyDaysAgo) return false;

    return true;
}

const USER_PERSONALITY_ANALYSIS_PROMPT_KEY = 'user_personality_analysis';
const USER_PERSONALITY_ANALYSIS_CONTEXT_VERSION = 'user-personality.v1';
const AI_CONSUMPTION_CONFIRM_REQUIRED = 'AI_CONSUMPTION_CONFIRM_REQUIRED';

function parseRequestBoolean(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function hasConfirmedAiConsumption(req) {
    return parseRequestBoolean(req?.body?.confirmConsumption);
}

function buildAiConsumptionConfirmationPayload(actionLabel, pointCost) {
    const safePointCost = Math.max(0, Number(pointCost || 0));
    return {
        error: `${actionLabel}将消耗 ${safePointCost} AI点，请二次确认后再继续`,
        code: AI_CONSUMPTION_CONFIRM_REQUIRED,
        requiresConfirmation: true,
        pointCost: safePointCost
    };
}

async function createAiWorkJobWithLock({
    lockScope,
    lockIdentity,
    findExistingJob,
    createJob
} = {}) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
            [String(lockScope || 'ai_work_job'), String(lockIdentity || 'default')]
        );

        const existingJob = typeof findExistingJob === 'function'
            ? await findExistingJob()
            : null;
        if (existingJob) {
            await client.query('COMMIT');
            return { job: existingJob, reused: true };
        }

        const job = await createJob(client);
        await client.query('COMMIT');
        return { job, reused: false };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

async function consumeCustomerAnalysisCredits(memberId, targetUserId, points = 0) {
    const safePoints = Math.max(0, Number(points || 0));
    if (safePoints <= 0) {
        return { success: true, chargedPoints: 0 };
    }

    const updated = await db.pool.query(
        `UPDATE users
         SET ai_credits_remaining = ai_credits_remaining - $2,
             ai_credits_used = ai_credits_used + $2
         WHERE id = $1 AND ai_credits_remaining >= $2
         RETURNING id`,
        [memberId, safePoints]
    );

    if (!updated.rows.length) {
        return { success: false, chargedPoints: 0 };
    }

    await db.run(
        'INSERT INTO ai_usage_log (user_id, usage_type, credits_used, target_id) VALUES (?, ?, ?, ?)',
        [memberId, 'analysis', safePoints, targetUserId]
    );

    return { success: true, chargedPoints: safePoints };
}

async function insertMemberAnalysisRecordTx(client, {
    memberId,
    targetUserId,
    result,
    resultJson = null,
    chatCount = 0,
    modelName = '',
    modelVersion = '',
    promptKey = null,
    promptUpdatedAt = null,
    contextVersion = null,
    currentRoomId = null,
    latencyMs = 0,
    source = 'api',
    sourceJobId = null
} = {}) {
    await client.query(
        `INSERT INTO user_ai_analysis (
            member_id, target_user_id, result, result_json, chat_count, model_name, model_version,
            prompt_key, prompt_updated_at, context_version, current_room_id, latency_ms, source, source_job_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
            memberId,
            targetUserId,
            result,
            resultJson || null,
            Number(chatCount || 0),
            modelName || '',
            modelVersion || '',
            promptKey,
            promptUpdatedAt,
            contextVersion,
            currentRoomId,
            Number(latencyMs || 0),
            source || 'api',
            sourceJobId ? Number(sourceJobId) : null
        ]
    );
}

async function finalizeMemberAnalysisJob({
    jobId,
    memberId,
    targetUserId,
    result,
    resultJson = null,
    chatCount = 0,
    modelName = '',
    modelVersion = '',
    promptKey = null,
    promptUpdatedAt = null,
    contextVersion = null,
    currentRoomId = null,
    latencyMs = 0,
    source = 'api',
    chargedPoints = 0,
    usageType = 'analysis',
    usageTargetId = null,
    resultPayload = null,
    currentStep = '处理完成'
} = {}) {
    const safeJobId = Number(jobId || 0);
    const safeChargedPoints = Math.max(0, Number(chargedPoints || 0));
    if (!safeJobId) {
        return { success: false, error: 'AI 工作任务不存在' };
    }

    const client = await db.pool.connect();
    let finalizedJob = null;
    let effectiveChargedPoints = 0;

    try {
        await client.query('BEGIN');

        const jobResult = await client.query(
            'SELECT * FROM ai_work_job WHERE id = $1 FOR UPDATE LIMIT 1',
            [safeJobId]
        );
        if (!jobResult.rows.length) {
            await client.query('ROLLBACK');
            return { success: false, error: 'AI 工作任务不存在' };
        }

        const lockedJob = serializeAdminAiWorkJob(jobResult.rows[0]);
        if (String(lockedJob.status || '').toLowerCase() === 'completed') {
            await client.query('COMMIT');
            return {
                success: true,
                alreadyCompleted: true,
                chargedPoints: Number(lockedJob.chargedPoints || 0),
                job: lockedJob
            };
        }

        effectiveChargedPoints = Math.max(0, Number(lockedJob.chargedPoints || 0));

        const existingAnalysisResult = await client.query(
            'SELECT id FROM user_ai_analysis WHERE source_job_id = $1 FOR UPDATE LIMIT 1',
            [safeJobId]
        );

        if (!existingAnalysisResult.rows.length) {
            if (safeChargedPoints > 0 && effectiveChargedPoints <= 0) {
                const balanceResult = await client.query(
                    `UPDATE users
                     SET ai_credits_remaining = ai_credits_remaining - $1,
                         ai_credits_used = ai_credits_used + $1,
                         updated_at = NOW()
                     WHERE id = $2 AND ai_credits_remaining >= $1
                     RETURNING ai_credits_remaining`,
                    [safeChargedPoints, memberId]
                );

                if (balanceResult.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return { success: false, insufficient: true };
                }

                await client.query(
                    `INSERT INTO ai_usage_log (user_id, usage_type, credits_used, target_id)
                     VALUES ($1, $2, $3, $4)`,
                    [memberId, usageType, safeChargedPoints, String(usageTargetId || targetUserId || '')]
                );
                effectiveChargedPoints = safeChargedPoints;
            }

            await insertMemberAnalysisRecordTx(client, {
                memberId,
                targetUserId,
                result,
                resultJson,
                chatCount,
                modelName,
                modelVersion,
                promptKey,
                promptUpdatedAt,
                contextVersion,
                currentRoomId,
                latencyMs,
                source,
                sourceJobId: safeJobId
            });
        }

        const updatedJobResult = await client.query(
            `UPDATE ai_work_job
             SET status = 'completed',
                 current_step = $2,
                 progress_percent = 100,
                 charged_points = $3,
                 model_name = $4,
                 result_json = $5,
                 error_message = '',
                 finished_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [
                safeJobId,
                String(currentStep || '处理完成'),
                effectiveChargedPoints,
                String(modelName || ''),
                safeJsonStringify(resultPayload)
            ]
        );

        finalizedJob = updatedJobResult.rows[0] ? serializeAdminAiWorkJob(updatedJobResult.rows[0]) : lockedJob;
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('[AI] Finalize member analysis job error:', err.message);
        return { success: false, error: err.message };
    } finally {
        client.release();
    }

    const normalizedPromptKey = String(promptKey || '').trim();
    const normalizedCurrentRoomId = String(currentRoomId || '').trim();
    if (!normalizedCurrentRoomId && normalizedPromptKey === USER_PERSONALITY_ANALYSIS_PROMPT_KEY) {
        try {
            await invalidateMemberPersonalityAnalysisCache(memberId, targetUserId);
        } catch (err) {
            console.error('[AI] Invalidate personality cache error:', err.message);
        }
    }

    return {
        success: true,
        chargedPoints: effectiveChargedPoints,
        job: finalizedJob
    };
}

function buildCustomerAnalysisJobTitle(targetUserId, preparedAnalysis = {}) {
    const identity = preparedAnalysis?.customerContext?.identity || {};
    return buildAiWorkTitle(AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS, {
        roomId: preparedAnalysis?.currentRoomId || '',
        targetUserId: String(targetUserId || '').trim(),
        targetNickname: String(identity?.nickname || identity?.uniqueId || '').trim()
    });
}

function clampNumber(value, min, max, fallback = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
}

function safeTrimString(value, maxLength = 300) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeAiReviewList(value, limit = 5) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => safeTrimString(item, 300))
        .filter(Boolean)
        .slice(0, limit);
}

function normalizeAiReviewTags(value, limit = 5) {
    if (!Array.isArray(value)) return [];
    return value
        .map(tag => safeTrimString(tag, 40))
        .filter(Boolean)
        .map(tag => tag.startsWith('#') ? tag : `#${tag}`)
        .slice(0, limit);
}

function findRadarValue(recap, label) {
    const item = Array.isArray(recap?.radar)
        ? recap.radar.find(entry => String(entry?.label || '').trim() === label)
        : null;
    return clampNumber(item?.value || 0, 0, 100, 0);
}

function scaleScoreParts(parts, targetTotal) {
    const rawTotal = parts.reduce((sum, item) => sum + item.value, 0);
    if (!rawTotal || !targetTotal) {
        return Object.fromEntries(parts.map(item => [item.key, 0]));
    }

    const scaled = {};
    let allocated = 0;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const remainingTarget = targetTotal - allocated;
        const remainingMax = parts.slice(index).reduce((sum, item) => sum + item.max, 0);
        let nextValue = index === parts.length - 1
            ? remainingTarget
            : Math.round((part.value / rawTotal) * targetTotal);

        nextValue = clampNumber(nextValue, 0, Math.min(part.max, remainingTarget), 0);
        if (remainingMax < remainingTarget) nextValue = part.max;

        scaled[part.key] = nextValue;
        allocated += nextValue;
    }

    const diff = targetTotal - allocated;
    if (diff !== 0) {
        const adjustKey = parts[parts.length - 1].key;
        scaled[adjustKey] = clampNumber((scaled[adjustKey] || 0) + diff, 0, parts[parts.length - 1].max, 0);
    }

    return scaled;
}

function buildFallbackScore(recap) {
    const total = clampNumber(recap?.overview?.score || 0, 0, 100, 0);
    const parts = [
        { key: 'contentAttraction', value: Math.round((findRadarValue(recap, '互动') + findRadarValue(recap, '节奏')) / 10), max: 20 },
        { key: 'userInteraction', value: Math.round(findRadarValue(recap, '互动') / 5), max: 20 },
        { key: 'giftConversion', value: Math.round(findRadarValue(recap, '变现') * 0.35), max: 35 },
        { key: 'retentionGrowth', value: Math.round(findRadarValue(recap, '客户') * 0.15), max: 15 },
        { key: 'overallRhythm', value: Math.round(findRadarValue(recap, '节奏') * 0.1), max: 10 }
    ];
    const scaled = scaleScoreParts(parts, total);

    return {
        total,
        contentAttraction: clampNumber(scaled.contentAttraction || 0, 0, 20, 0),
        userInteraction: clampNumber(scaled.userInteraction || 0, 0, 20, 0),
        giftConversion: clampNumber(scaled.giftConversion || 0, 0, 35, 0),
        retentionGrowth: clampNumber(scaled.retentionGrowth || 0, 0, 15, 0),
        overallRhythm: clampNumber(scaled.overallRhythm || 0, 0, 10, 0),
        reason: safeTrimString(recap?.overview?.gradeLabel || '当前评分基于本场互动、变现、客户结构与节奏稳定性综合判断。', 160)
    };
}

function normalizeAiReviewScore(value, fallbackRecap = null) {
    const fallback = fallbackRecap ? buildFallbackScore(fallbackRecap) : {
        total: 0,
        contentAttraction: 0,
        userInteraction: 0,
        giftConversion: 0,
        retentionGrowth: 0,
        overallRhythm: 0,
        reason: ''
    };
    if (!value || typeof value !== 'object') return fallback;

    const normalized = {
        total: clampNumber(value.total, 0, 100, fallback.total),
        contentAttraction: clampNumber(value.contentAttraction, 0, 20, fallback.contentAttraction),
        userInteraction: clampNumber(value.userInteraction, 0, 20, fallback.userInteraction),
        giftConversion: clampNumber(value.giftConversion, 0, 35, fallback.giftConversion),
        retentionGrowth: clampNumber(value.retentionGrowth, 0, 15, fallback.retentionGrowth),
        overallRhythm: clampNumber(value.overallRhythm, 0, 10, fallback.overallRhythm),
        reason: safeTrimString(value.reason, 160) || fallback.reason
    };

    const sum = normalized.contentAttraction
        + normalized.userInteraction
        + normalized.giftConversion
        + normalized.retentionGrowth
        + normalized.overallRhythm;
    if (sum !== normalized.total) {
        return fallbackRecap ? buildFallbackScore(fallbackRecap) : { ...fallback, total: sum };
    }
    return normalized;
}

function normalizeAiReviewValuableComments(value, limit = 10) {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        if (!item) return null;
        const text = safeTrimString(item.text || item.keyword || item.comment || item, 80);
        if (!text) return null;
        const count = clampNumber(item.count, 0, 999999, 0);
        if (count > SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD) return null;
        return {
            text,
            count,
            reason: safeTrimString(item.reason || item.category || '', 120),
            insight: safeTrimString(item.insight || item.suggestion || '', 120)
        };
    }).filter(Boolean).slice(0, limit);
}

function containsEcommerceConversionText(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) return false;
    return /下单|订单|拍下|链接|购买|付款|优惠券|客服|发货/.test(normalized);
}

function buildEntertainmentConversionScript(item = {}, index = 0) {
    const nickname = safeTrimString(item.nickname || '这位家人', 24) || '这位家人';
    const likeCount = clampNumber(item.likeCount, 0, 999999999, 0);
    const chatCount = clampNumber(item.chatCount, 0, 999999, 0);
    const sessionGiftValue = clampNumber(item.sessionGiftValue ?? item.totalGiftValue, 0, 999999999, 0);
    const variants = [];

    if (sessionGiftValue > 0) {
        variants.push(`${nickname}，你今天已经有参与感了，主播这边直接接住你，下一轮氛围起来时可以再一起把排面往上抬一点。`);
        variants.push(`${nickname}，刚刚你已经给到支持了，主播记住你了，待会儿节奏上来你再跟一手，会更有存在感。`);
        variants.push(`${nickname}，你今天已经出手了，后面如果这段你也喜欢，可以顺着气氛再补一下，主播这边会更容易把你接住。`);
    } else if (chatCount >= 30 || likeCount >= 300) {
        variants.push(`${nickname}，你今天互动这么足，主播其实已经注意到你了，待会儿氛围点起来时你轻轻支持一下，会更容易被点名接住。`);
        variants.push(`${nickname}，你现在互动感很强，主播这边先把你想听的接稳，等到情绪点起来你再给一点小支持就很自然。`);
        variants.push(`${nickname}，你已经把场子陪热了，后面如果主播这段戳中你，可以顺手给个小心意，把关系再往前推一步。`);
    } else {
        variants.push(`${nickname}，你可以先继续跟主播聊，等聊到你最有感觉的那一下，再顺着气氛给一点支持，会更自然。`);
        variants.push(`${nickname}，主播这边先把你想听的内容接住，后面情绪到位了你再轻轻表示一下，更容易形成记忆点。`);
        variants.push(`${nickname}，先把互动感保持住，等主播状态最好的那一段再跟一下支持，体验会更顺。`);
    }

    return variants[index % variants.length];
}

function normalizePotentialCustomerScripts(items = []) {
    if (!Array.isArray(items) || !items.length) return [];
    const seenScripts = new Set();

    return items.map((item, index) => {
        const next = { ...item };
        const rawScript = safeTrimString(next.conversionScript || '', 200);
        let normalizedScript = rawScript;

        if (!normalizedScript || containsEcommerceConversionText(normalizedScript) || seenScripts.has(normalizedScript)) {
            normalizedScript = buildEntertainmentConversionScript(next, index);
        }

        if (seenScripts.has(normalizedScript)) {
            normalizedScript = buildEntertainmentConversionScript(next, index + 1);
        }

        seenScripts.add(normalizedScript);
        next.conversionScript = normalizedScript;
        return next;
    });
}

function normalizeAiReviewCustomerArray(value, segment = 'core', limit = 8, fallbackItems = []) {
    const source = Array.isArray(value) && value.length ? value : fallbackItems;
    if (!Array.isArray(source)) return [];

    const normalizedItems = source.map(item => {
        if (!item) return null;
        return {
            nickname: safeTrimString(item.nickname || '匿名', 60) || '匿名',
            uniqueId: safeTrimString(item.uniqueId || '', 80),
            totalGiftValue: clampNumber(item.totalGiftValue ?? item.sessionGiftValue, 0, 999999999, 0),
            giftCount: clampNumber(item.giftCount, 0, 999999, 0),
            sessionGiftValue: clampNumber(item.sessionGiftValue ?? item.totalGiftValue, 0, 999999999, 0),
            historicalValue: clampNumber(item.historicalValue, 0, 999999999, 0),
            chatCount: clampNumber(item.chatCount, 0, 999999, 0),
            likeCount: clampNumber(item.likeCount, 0, 999999999, 0),
            enterCount: clampNumber(item.enterCount, 0, 999999, 0),
            enterTime: safeTrimString(item.enterTime || item.firstEnterAt || '', 40),
            leaveTime: safeTrimString(item.leaveTime || item.lastActiveAt || '', 40),
            keyBehavior: safeTrimString(item.keyBehavior || item.reason || '', 160),
            maintenanceSuggestion: safeTrimString(item.maintenanceSuggestion || item.action || '', 160),
            conversionScript: safeTrimString(item.conversionScript || '', 160),
            riskReason: safeTrimString(item.riskReason || item.reason || '', 160),
            recoveryStrategy: safeTrimString(item.recoveryStrategy || item.action || '', 160)
        };
    }).filter(Boolean).slice(0, limit).map(item => {
        if (segment === 'core') {
            return {
                ...item,
                keyBehavior: item.keyBehavior || '本场贡献突出，值得重点维护。',
                maintenanceSuggestion: item.maintenanceSuggestion || '建议下场继续重点点名和情绪反馈。'
            };
        }
        if (segment === 'potential') {
            return {
                ...item,
                keyBehavior: item.keyBehavior || '互动高但转化偏弱，具备承接空间。',
                maintenanceSuggestion: item.maintenanceSuggestion || '建议在互动高点顺势承接，优先把情绪和存在感再往上推一档。',
                conversionScript: item.conversionScript || ''
            };
        }
        return {
            ...item,
            keyBehavior: item.keyBehavior || '本场活跃后转弱，存在流失风险。',
            riskReason: item.riskReason || '本场承接不足，导致高价值客户参与感下降。',
            recoveryStrategy: item.recoveryStrategy || '建议下场提前预热并做定向召回。'
        };
    });

    return segment === 'potential'
        ? normalizePotentialCustomerScripts(normalizedItems)
        : normalizedItems;
}

function serializeValueCustomer(item = {}) {
    const sessionGiftValue = Number(item.sessionGiftValue ?? item.totalGiftValue ?? 0);
    return {
        nickname: item.nickname || '匿名',
        uniqueId: item.uniqueId || '',
        totalGiftValue: sessionGiftValue,
        sessionGiftValue,
        giftCount: Number(item.giftCount ?? 0),
        historicalValue: Number(item.historicalValue ?? 0),
        chatCount: Number(item.chatCount ?? 0),
        likeCount: Number(item.likeCount ?? 0),
        enterCount: Number(item.enterCount ?? 0),
        firstEnterAt: item.firstEnterAt || null,
        lastActiveAt: item.lastActiveAt || null,
        reason: item.reason || '',
        action: item.action || ''
    };
}

function serializeSessionAiReview(review) {
    if (!review) return null;
    const normalized = parseSessionAiReview(review);
    if (!normalized) return null;
    return {
        summary: normalized.summary,
        bossSummary: normalized.bossSummary,
        highlights: normalizeAiReviewList(normalized.highlights, 2),
        issues: normalizeAiReviewList(normalized.issues, 5),
        actions: normalizeAiReviewList(normalized.actions, 5),
        tags: normalizeAiReviewTags(normalized.tags, 5),
        score: normalizeAiReviewScore(normalized.score),
        valuableComments: normalizeAiReviewValuableComments(normalized.valuableComments, 10),
        customers: {
            core: normalizeAiReviewCustomerArray(normalized.customers?.core, 'core', 8),
            potential: normalizeAiReviewCustomerArray(normalized.customers?.potential, 'potential', 8),
            risk: normalizeAiReviewCustomerArray(normalized.customers?.risk, 'risk', 8)
        },
        generatedAt: review.generatedAt || null,
        creditsUsed: Number(review.creditsUsed || 0)
    };
}

function buildFallbackSessionAiReview(recap) {
    const overview = recap?.overview || {};
    const firstMoment = Array.isArray(recap?.keyMoments) ? recap.keyMoments[0] : null;
    const summary = overview.score
        ? `本场评分 ${overview.score}/100，当前判断为${overview.gradeLabel || '稳态场'}。${firstMoment ? `重点关注 ${firstMoment.timeRange} 的${firstMoment.title}。` : ''}`
        : '本场数据量有限，建议先积累更多单场内容后再生成 AI直播复盘。';

    return {
        summary,
        bossSummary: summary,
        highlights: normalizeAiReviewList(recap?.insights?.highlights, 2),
        issues: normalizeAiReviewList(recap?.insights?.issues, 5),
        actions: normalizeAiReviewList(recap?.insights?.actions, 5),
        tags: normalizeAiReviewTags(recap?.overview?.tags, 5),
        score: buildFallbackScore(recap),
        valuableComments: normalizeAiReviewValuableComments(recap?.commentSignals?.valuableComments || recap?.commentSignals?.topComments, 8),
        customers: {
            core: normalizeAiReviewCustomerArray(recap?.valueCustomers?.core, 'core', 8),
            potential: normalizeAiReviewCustomerArray(recap?.valueCustomers?.potential, 'potential', 8),
            risk: normalizeAiReviewCustomerArray(recap?.valueCustomers?.risk, 'risk', 8)
        }
    };
}

function extractFirstJsonObject(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return raw.slice(start, end + 1);
}

function parseSessionAiReview(rawReview, fallbackRecap = null) {
    if (!rawReview) return fallbackRecap ? buildFallbackSessionAiReview(fallbackRecap) : null;

    try {
        const parsed = typeof rawReview === 'string' ? JSON.parse(rawReview) : rawReview;
        const fallback = fallbackRecap ? buildFallbackSessionAiReview(fallbackRecap) : {
            summary: '',
            bossSummary: '',
            highlights: [],
            issues: [],
            actions: [],
            tags: [],
            score: normalizeAiReviewScore(null),
            valuableComments: [],
            customers: { core: [], potential: [], risk: [] }
        };
        const bossSummary = safeTrimString(parsed?.bossSummary || parsed?.summary || fallback.bossSummary || fallback.summary, 220);
        return {
            summary: bossSummary || fallback.summary,
            bossSummary: bossSummary || fallback.bossSummary,
            highlights: normalizeAiReviewList(parsed?.highlights || fallback.highlights, 2),
            issues: normalizeAiReviewList(parsed?.issues || fallback.issues, 5),
            actions: normalizeAiReviewList(parsed?.actions || fallback.actions, 5),
            tags: normalizeAiReviewTags(parsed?.tags || fallback.tags, 5),
            score: normalizeAiReviewScore(parsed?.score || fallback.score, fallbackRecap),
            valuableComments: normalizeAiReviewValuableComments(parsed?.valuableComments || fallback.valuableComments, 10),
            customers: {
                core: normalizeAiReviewCustomerArray(parsed?.coreCustomers || parsed?.customers?.core, 'core', 8, fallback.customers?.core),
                potential: normalizeAiReviewCustomerArray(parsed?.potentialCustomers || parsed?.customers?.potential, 'potential', 8, fallback.customers?.potential),
                risk: normalizeAiReviewCustomerArray(parsed?.riskCustomers || parsed?.customers?.risk, 'risk', 8, fallback.customers?.risk)
            }
        };
    } catch {
        return fallbackRecap ? buildFallbackSessionAiReview(fallbackRecap) : null;
    }
}

async function getCachedSessionAiReview(userId, roomId, sessionId) {
    if (!userId || !roomId || !sessionId || sessionId === 'live') return null;

    const row = await db.get(
        `SELECT review_json, credits_used, model_name, created_at, updated_at
         FROM session_ai_review
         WHERE user_id = ? AND room_id = ? AND session_id = ?`,
        [userId, roomId, sessionId]
    );

    if (!row) return null;
    const review = parseSessionAiReview(row.reviewJson);
    if (!review) return null;

    return {
        ...review,
        generatedAt: row.updatedAt || row.createdAt || null,
        creditsUsed: Number(row.creditsUsed || 0)
    };
}

async function saveSessionAiReviewRecord(jobId, userId, roomId, sessionId, review, modelName, creditsUsed = 0, resultPayload = null) {
    const safeJobId = Number(jobId || 0);
    const safeCreditsUsed = Math.max(0, Number(creditsUsed || 0));
    if (!safeJobId) {
        return { success: false, error: 'AI 工作任务不存在' };
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const jobResult = await client.query(
            'SELECT * FROM ai_work_job WHERE id = $1 FOR UPDATE LIMIT 1',
            [safeJobId]
        );
        if (!jobResult.rows.length) {
            await client.query('ROLLBACK');
            return { success: false, error: 'AI 工作任务不存在' };
        }

        const lockedJob = serializeAdminAiWorkJob(jobResult.rows[0]);
        if (String(lockedJob.status || '').toLowerCase() === 'completed') {
            await client.query('COMMIT');
            return {
                success: true,
                alreadyCompleted: true,
                chargedPoints: Number(lockedJob.chargedPoints || 0),
                job: lockedJob
            };
        }

        let effectiveChargedPoints = Math.max(0, Number(lockedJob.chargedPoints || 0));
        const existingReviewResult = await client.query(
            `SELECT credits_used
             FROM session_ai_review
             WHERE user_id = $1 AND room_id = $2 AND session_id = $3
             FOR UPDATE
             LIMIT 1`,
            [userId, roomId, sessionId]
        );
        if (existingReviewResult.rows.length) {
            effectiveChargedPoints = Math.max(
                effectiveChargedPoints,
                Number(existingReviewResult.rows[0]?.credits_used || 0)
            );
        }

        if (safeCreditsUsed > 0 && effectiveChargedPoints <= 0) {
            const balanceResult = await client.query(
                `UPDATE users
                 SET ai_credits_remaining = ai_credits_remaining - $1,
                     ai_credits_used = ai_credits_used + $1,
                     updated_at = NOW()
                 WHERE id = $2 AND ai_credits_remaining >= $1
                 RETURNING ai_credits_remaining`,
                [safeCreditsUsed, userId]
            );

            if (balanceResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return { success: false, insufficient: true };
            }

            await client.query(
                `INSERT INTO ai_usage_log (user_id, usage_type, credits_used, target_id)
                 VALUES ($1, $2, $3, $4)`,
                [userId, 'session_recap', safeCreditsUsed, `${roomId}:${sessionId}`]
            );
            effectiveChargedPoints = safeCreditsUsed;
        }

        await client.query(
            `INSERT INTO session_ai_review (user_id, room_id, session_id, review_json, credits_used, model_name, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (user_id, room_id, session_id)
             DO UPDATE SET review_json = EXCLUDED.review_json,
                           credits_used = EXCLUDED.credits_used,
                           model_name = EXCLUDED.model_name,
                           updated_at = NOW()`,
            [userId, roomId, sessionId, JSON.stringify(review), effectiveChargedPoints, modelName || null]
        );

        const updatedJobResult = await client.query(
            `UPDATE ai_work_job
             SET status = 'completed',
                 current_step = '处理完成',
                 progress_percent = 100,
                 charged_points = $2,
                 model_name = $3,
                 result_json = $4,
                 error_message = '',
                 finished_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [safeJobId, effectiveChargedPoints, modelName || '', safeJsonStringify(resultPayload)]
        );

        await client.query('COMMIT');
        return {
            success: true,
            chargedPoints: effectiveChargedPoints,
            job: updatedJobResult.rows[0] ? serializeAdminAiWorkJob(updatedJobResult.rows[0]) : lockedJob
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('[AI] Save session recap review error:', err.message);
        return { success: false, error: err.message };
    } finally {
        client.release();
    }
}

const AI_MODEL_FAILURE_COOLDOWN_MS = (() => {
    const raw = parseInt(process.env.AI_MODEL_FAILURE_COOLDOWN_MS || `${5 * 60 * 1000}`, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();

function getAiRuntimeCooldownDate(rawValue) {
    if (!rawValue) return null;
    const parsed = new Date(rawValue);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isAiRuntimeCooling(runtime, nowMs = Date.now()) {
    const cooldownUntil = getAiRuntimeCooldownDate(runtime?.cooldownUntil);
    return Boolean(cooldownUntil && cooldownUntil.getTime() > nowMs);
}

async function listAiRuntimeCandidates() {
    const aiModels = await db.all(
        `SELECT m.id, m.model_id, m.name AS model_name, m.is_default, m.cooldown_until, m.consecutive_failures,
                c.api_url, c.api_key
         FROM ai_models m JOIN ai_channels c ON m.channel_id = c.id
         WHERE m.is_active = true AND c.is_active = true
         ORDER BY m.is_default DESC, m.id ASC`
    );

    if (aiModels.length > 0) {
        const runtimes = aiModels.map(item => ({
            apiKey: item.apiKey,
            modelName: item.modelId,
            apiUrl: item.apiUrl,
            aiModelId: item.id,
            runtimeLabel: item.modelName || item.modelId,
            isDefault: Boolean(item.isDefault),
            cooldownUntil: item.cooldownUntil || null,
            consecutiveFailures: Number(item.consecutiveFailures || 0)
        }));

        const nowMs = Date.now();
        const available = runtimes.filter(item => !isAiRuntimeCooling(item, nowMs));
        const cooling = runtimes.filter(item => isAiRuntimeCooling(item, nowMs));

        if (available.length > 0 && cooling.length > 0) {
            const cooledDefault = cooling.find(item => item.isDefault);
            if (cooledDefault) {
                console.log(`[AI] Default model ${cooledDefault.runtimeLabel} is cooling down, temporarily deprioritized`);
            }
            return [...available, ...cooling];
        }

        return runtimes;
    }

    const dbSettings = await manager.getAllSettings();
    const apiKey = dbSettings.ai_api_key || process.env.AI_API_KEY;
    if (!apiKey) return [];

    return [{
        apiKey,
        modelName: dbSettings.ai_model_name || process.env.AI_MODEL_NAME || 'deepseek-ai/DeepSeek-V3.2',
        apiUrl: dbSettings.ai_api_url || process.env.AI_API_URL || 'https://api-inference.modelscope.cn/v1/',
        aiModelId: null,
        runtimeLabel: 'legacy-settings'
    }];
}

async function markAiModelSuccess(aiModelId, latencyMs) {
    if (!aiModelId) return;
    try {
        await db.run(
            `UPDATE ai_models
             SET call_count = call_count + 1, success_count = success_count + 1,
                 consecutive_failures = 0, cooldown_until = NULL,
                 last_status = 'ok', last_error = NULL, last_used_at = NOW(), avg_latency_ms = ?, updated_at = NOW()
             WHERE id = ?`,
            [latencyMs, aiModelId]
        );
    } catch (err) {
        console.error('[AI] Update model success status error:', err.message);
    }
}

async function markAiModelFailure(aiModelId, errorMessage) {
    if (!aiModelId) return;
    try {
        const cooldownUntil = new Date(Date.now() + AI_MODEL_FAILURE_COOLDOWN_MS).toISOString();
        await db.run(
            `UPDATE ai_models
             SET call_count = call_count + 1, fail_count = fail_count + 1,
                 consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
                 cooldown_until = ?, last_status = 'error', last_error = ?,
                 last_used_at = NOW(), updated_at = NOW()
             WHERE id = ?`,
            [cooldownUntil, String(errorMessage || 'Unknown error').slice(0, 200), aiModelId]
        );
    } catch (err) {
        console.error('[AI] Update model failure status error:', err.message);
    }
}

function normalizeAiRuntimeError(err) {
    return err instanceof Error ? err.message : String(err || 'Unknown error');
}

async function emitAiTrace(trace, entry = {}) {
    if (typeof trace !== 'function') return;
    try {
        await trace(entry);
    } catch (err) {
        console.warn('[AI] Trace write failed:', err.message);
    }
}

function getSessionAiFallbackReason(err) {
    const message = normalizeAiRuntimeError(err).toLowerCase();
    if (message.includes('high risk') || message.includes('high-risk') || message.includes('considered high risk') || message.includes('风控') || message.includes('风险') || message.includes('safety') || message.includes('moderation')) {
        return 'high-risk';
    }
    if (message.includes('api key not configured')) {
        return 'config-missing';
    }
    return 'upstream-error';
}

async function requestAiChatCompletion({ messages, requestLabel, trace = null }) {
    const runtimes = await listAiRuntimeCandidates();
    if (runtimes.length === 0) {
        throw new Error('AI API Key not configured');
    }

    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const errors = [];

    for (let index = 0; index < runtimes.length; index++) {
        const runtime = runtimes[index];
        const startedAt = Date.now();

        try {
            console.log(`[AI] ${requestLabel} attempt ${index + 1}/${runtimes.length} with ${runtime.runtimeLabel}`);
            await emitAiTrace(trace, {
                phase: 'ai_request',
                level: 'info',
                message: '发起 AI 请求',
                payload: {
                    requestLabel,
                    attempt: index + 1,
                    totalAttempts: runtimes.length,
                    runtimeLabel: runtime.runtimeLabel,
                    modelName: runtime.modelName
                }
            });
            const aiBaseUrl = runtime.apiUrl.endsWith('/') ? runtime.apiUrl : `${runtime.apiUrl}/`;
            const response = await fetch(`${aiBaseUrl}chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${runtime.apiKey}` },
                body: JSON.stringify({
                    model: runtime.modelName,
                    messages,
                    stream: false
                })
            });
            const latencyMs = Date.now() - startedAt;

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status}: ${(errText || response.statusText || '请求失败').slice(0, 200)}`);
            }

            const completion = await response.json();
            const content = completion?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('AI 响应内容为空');
            }

            await markAiModelSuccess(runtime.aiModelId, latencyMs);
            await emitAiTrace(trace, {
                phase: 'ai_request',
                level: 'info',
                message: 'AI 请求成功',
                payload: {
                    requestLabel,
                    attempt: index + 1,
                    runtimeLabel: runtime.runtimeLabel,
                    modelName: runtime.modelName,
                    latencyMs
                }
            });

            if (index > 0) {
                console.log(`[AI] ${requestLabel} switched to fallback model ${runtime.runtimeLabel}`);
            }

            return {
                completion,
                modelName: runtime.modelName,
                latencyMs,
                aiModelId: runtime.aiModelId
            };
        } catch (err) {
            const errorMessage = normalizeAiRuntimeError(err);
            await markAiModelFailure(runtime.aiModelId, errorMessage);
            errors.push(`${runtime.runtimeLabel}: ${errorMessage}`);
            await emitAiTrace(trace, {
                phase: 'ai_request',
                level: 'error',
                message: 'AI 请求失败',
                payload: {
                    requestLabel,
                    attempt: index + 1,
                    runtimeLabel: runtime.runtimeLabel,
                    modelName: runtime.modelName,
                    error: errorMessage
                }
            });
            console.error(`[AI] ${requestLabel} failed for ${runtime.runtimeLabel}: ${errorMessage}`);
        }
    }

    throw new Error(`AI API Error: ${errors.join(' | ')}`);
}

const SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD = 10;

function isLowValueCommentSignal(text) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return true;
    if (normalized.length <= 1) return true;
    if (/^[\d\W_]+$/.test(normalized)) return true;

    const stopPhrases = new Set([
        '111', '1', '6', '66', '666', '777', '888', '999', '哈哈', '哈哈哈', 'hhhh', 'hh', '啊啊啊', '来了',
        '在吗', '看看', '支持', '冲', '顶', '真棒', '好看', '好美', '喜欢', '爱了', '么么哒', '姐姐好美',
        '主播好美', '晚安', '早点休息', '路过', '卡了', '进来了', '在', '滴', '收到'
    ]);

    return stopPhrases.has(normalized);
}

function buildHeuristicValuableComments(commentCandidates = []) {
    return commentCandidates
        .map(item => ({
            text: safeTrimString(item.text || item.comment || '', 80),
            count: clampNumber(item.count, 0, 999999, 0)
        }))
        .filter(item => item.text && item.count > 0)
        .filter(item => !isLowValueCommentSignal(item.text))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12)
        .map(item => ({
            text: item.text,
            count: item.count,
            reason: '高频出现且具备明确语义，适合用于复盘内容反馈。',
            insight: '可用于判断用户真实关注点、异议点或情绪反馈。'
        }));
}

async function filterSessionRecapCommentSignals(roomId, sessionId, commentCandidates = [], { trace = null } = {}) {
    const normalizedCandidates = Array.isArray(commentCandidates)
        ? commentCandidates
            .map(item => ({
                text: safeTrimString(item.text || item.comment || '', 80),
                count: clampNumber(item.count, 0, 999999, 0)
            }))
            .filter(item => item.text && item.count > 0)
        : [];

    const originalCandidateCount = normalizedCandidates.length;
    const repeatFilteredCount = normalizedCandidates.filter(item => item.count > SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD).length;
    const topCandidates = normalizedCandidates
        .filter(item => item.count <= SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD)
        .slice(0, 50);

    if (!topCandidates.length) {
        await emitAiTrace(trace, {
            phase: 'comment_filter',
            level: 'info',
            message: '高频弹幕已被重复阈值过滤',
            payload: {
                originalCandidateCount,
                filteredByRepeatThreshold: repeatFilteredCount,
                repeatThreshold: SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD
            }
        });
        return [];
    }

    const fallback = buildHeuristicValuableComments(topCandidates);
    await emitAiTrace(trace, {
        phase: 'comment_filter',
        level: 'info',
        message: '开始筛选高价值弹幕',
        payload: {
            originalCandidateCount,
            candidateCount: topCandidates.length,
            filteredByRepeatThreshold: repeatFilteredCount,
            repeatThreshold: SESSION_RECAP_AUTO_COMMENT_REPEAT_THRESHOLD,
            fallbackCount: fallback.length
        }
    });

    try {
        const template = await getPromptTemplate('session_recap_comment_filter');
        const promptText = renderPromptTemplate(template?.content || '', {
            topCommentCandidatesJson: JSON.stringify(topCandidates, null, 2)
        });
        await emitAiTrace(trace, {
            phase: 'comment_filter',
            level: 'info',
            message: '高频弹幕筛选提示词已渲染',
            payload: { templateKey: 'session_recap_comment_filter', promptLength: promptText.length }
        });
        const { completion } = await requestAiChatCompletion({
            trace,
            requestLabel: `session recap comment filter ${roomId}/${sessionId}`,
            messages: [
                {
                    role: 'system',
                    content: '你是直播复盘数据清洗助手。严格按照用户提示词筛选高价值弹幕，并且只输出合法 JSON。'
                },
                {
                    role: 'user',
                    content: promptText
                }
            ]
        });
        const rawContent = completion.choices?.[0]?.message?.content || '';
        const extracted = extractFirstJsonObject(rawContent);
        const parsed = extracted ? JSON.parse(extracted) : JSON.parse(rawContent);
        const normalized = normalizeAiReviewValuableComments(parsed?.valuableComments, 12);
        await emitAiTrace(trace, {
            phase: 'comment_filter',
            level: 'info',
            message: '高价值弹幕筛选完成',
            payload: { resultCount: normalized.length || fallback.length, usedFallback: normalized.length === 0 }
        });
        return normalized.length ? normalized : fallback;
    } catch (err) {
        const errorMessage = normalizeAiRuntimeError(err);
        await emitAiTrace(trace, {
            phase: 'comment_filter',
            level: 'warning',
            message: '高价值弹幕筛选失败，回退启发式结果',
            payload: { error: errorMessage, fallbackCount: fallback.length }
        });
        console.warn(`[AI] Session recap comment filter ${roomId}/${sessionId} fallback: ${errorMessage}`);
        return fallback;
    }
}

async function generateSessionAiReviewFromRecap(roomId, sessionId, recap, { trace = null } = {}) {
    await emitAiTrace(trace, {
        phase: 'review',
        level: 'info',
        message: '开始生成 AI 直播复盘',
        payload: {
            roomId,
            sessionId,
            totalGiftValue: Number(recap?.overview?.totalGiftValue || 0),
            totalComments: Number(recap?.overview?.totalComments || 0),
            totalLikes: Number(recap?.overview?.totalLikes || 0),
            timelineCount: Array.isArray(recap?.timeline) ? recap.timeline.length : 0,
            topCommentCount: Array.isArray(recap?.commentSignals?.topComments) ? recap.commentSignals.topComments.length : 0
        }
    });
    const valuableComments = await filterSessionRecapCommentSignals(roomId, sessionId, recap?.commentSignals?.topComments || [], { trace });
    if (recap?.commentSignals) {
        recap.commentSignals.valuableComments = valuableComments;
    }

    try {
        const template = await getPromptTemplate('session_recap_review');
        const templateContent = injectMissingStructuredDataTokens({
            scene: 'session_recap_review',
            templateContent: template?.content || ''
        });
        const structuredVariables = await resolveAiStructuredDataVariables({
            scene: 'session_recap_review',
            context: {
                roomId,
                sessionId,
                recap,
                valuableComments
            }
        });
        const promptText = renderPromptTemplate(templateContent, structuredVariables);
        const promptPayloadLength = String(structuredVariables.sessionDataJson || '').length;
        await emitAiTrace(trace, {
            phase: 'review',
            level: 'info',
            message: '主分析提示词已渲染',
            payload: {
                templateKey: 'session_recap_review',
                promptLength: promptText.length,
                payloadLength: promptPayloadLength,
                valuableCommentCount: valuableComments.length,
                structuredSourceKeys: Object.keys(structuredVariables)
            }
        });
        const { completion, modelName, latencyMs: aiLatency } = await requestAiChatCompletion({
            trace,
            requestLabel: `session recap ${roomId}/${sessionId}`,
            messages: [
                {
                    role: 'system',
                    content: '你是直播复盘结构化输出助手。你必须严格遵守用户提示词，并且只输出合法 JSON。'
                },
                {
                    role: 'user',
                    content: promptText
                }
            ]
        });
        const rawContent = completion.choices?.[0]?.message?.content || '';

        const extracted = extractFirstJsonObject(rawContent);
        if (!extracted && !String(rawContent || '').trim().startsWith('{')) {
            throw new Error('AI 返回内容不是合法 JSON');
        }
        const parsed = parseSessionAiReview(extracted || rawContent, recap) || buildFallbackSessionAiReview(recap);
        await emitAiTrace(trace, {
            phase: 'review',
            level: 'info',
            message: 'AI 复盘解析完成',
            payload: { modelName, latencyMs: aiLatency, highlightCount: parsed.highlights?.length || 0, issueCount: parsed.issues?.length || 0 }
        });

        return {
            ...parsed,
            modelName,
            latencyMs: aiLatency,
            usedFallback: false
        };
    } catch (err) {
        const fallbackReason = getSessionAiFallbackReason(err);
        await emitAiTrace(trace, {
            phase: 'review',
            level: 'warning',
            message: '主分析失败，已回退到规则复盘',
            payload: { fallbackReason, error: normalizeAiRuntimeError(err) }
        });
        console.warn(`[AI] Session recap ${roomId}/${sessionId} downgraded to fallback (${fallbackReason})`);
        return {
            ...buildFallbackSessionAiReview(recap),
            modelName: `fallback:${fallbackReason}`,
            latencyMs: 0,
            usedFallback: true
        };
    }
}

const AI_WORKER_POLL_MS = Math.max(3000, parseInt(process.env.AI_WORKER_POLL_MS || '5000', 10) || 5000);
const AI_WORKER_MAX_CONCURRENCY = Math.max(1, Math.min(6, parseInt(process.env.AI_WORKER_MAX_CONCURRENCY || '3', 10) || 3));
const aiWorkRuntime = {
    timer: null,
    activeJobs: new Set(),
    ticking: false
};

async function appendAiWorkTrace(jobId, { phase = '', level = 'info', message = '', payload = null } = {}) {
    if (!jobId || !message) return;
    try {
        await appendAiWorkJobLog(jobId, { phase, level, message, payload });
    } catch (err) {
        console.error('[AI_WORK] append log error:', err.message);
    }
}

async function sendAiWorkJobNotification(job, { success = true, errorMessage = '' } = {}) {
    if (!job || !job.userId || job.notificationSent) return;

    try {
        const isCustomerAnalysisJob = String(job.jobType || '') === AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS;
        const roomName = job.roomId ? await getRoomDisplayNameForUser(job.userId, job.roomId) : '';
        const title = success
            ? (isCustomerAnalysisJob ? 'AI客户分析已完成' : 'AI直播复盘已完成')
            : (isCustomerAnalysisJob ? 'AI客户分析处理失败' : 'AI直播复盘处理失败');
        const content = success
            ? (isCustomerAnalysisJob
                ? `${job.title || 'AI客户分析'} 已处理完成，点击查看结果。`
                : `${job.title || 'AI直播复盘'} 已处理完成，点击可直达该房间的 AI复盘。`)
            : (isCustomerAnalysisJob
                ? `${job.title || 'AI客户分析'} 处理失败，请点击查看。`
                : `${job.title || 'AI直播复盘'} 处理失败，请点击回到该房间查看。`);
        const actionUrl = buildAiWorkActionUrl(job.jobType, {
            roomId: job.roomId || '',
            sessionId: job.sessionId || '',
            roomName,
            requestPayload: job.requestPayload || null
        });

        await notificationService.createUserNotification({
            userId: job.userId,
            type: 'ai_work',
            level: success ? 'success' : 'error',
            title,
            content,
            actionTab: 'notifications',
            actionUrl
        });

        await updateAiWorkJob(job.id, { notificationSent: true });
    } catch (err) {
        console.error('[AI_WORK] send notification error:', err.message);
    }
}

async function processSessionRecapAiWorkJob(job) {
    const isAdmin = Boolean(job.isAdmin);
    const sessionRecapPointCost = await getAiPointCost(AI_POINT_SCENES.SESSION_RECAP);
    const trace = async ({ phase = '', level = 'info', message = '', payload = null } = {}) => {
        await appendAiWorkTrace(job.id, { phase, level, message, payload });
    };

    try {
        await markAiWorkJobStarted(job.id, '正在读取场次数据');
        await trace({ phase: 'job', level: 'info', message: '任务开始执行', payload: { roomId: job.roomId, sessionId: job.sessionId, attemptCount: job.attemptCount } });

        const session = await manager.getSession(job.sessionId);
        if (!session) {
            await trace({ phase: 'job', level: 'warning', message: 'session 表中未找到该场次，继续按事件数据尝试生成', payload: { roomId: job.roomId, sessionId: job.sessionId } });
        } else if (String(session.roomId || '') !== String(job.roomId || '')) {
            await trace({ phase: 'job', level: 'warning', message: '场次房间与任务房间不一致，继续尝试按任务房间生成', payload: { requestRoomId: job.roomId, sessionRoomId: session.roomId, sessionId: job.sessionId } });
        }

        const roomFilter = await getRoomFilterForUserScope(job.userId, isAdmin);
        await updateAiWorkJob(job.id, { currentStep: '正在汇总复盘数据', progressPercent: 18 });
        const recap = await manager.getSessionRecap(job.roomId, job.sessionId, roomFilter);
        await trace({
            phase: 'recap',
            level: 'info',
            message: '场次复盘数据加载完成',
            payload: {
                score: Number(recap?.overview?.score || 0),
                totalGiftValue: Number(recap?.overview?.totalGiftValue || 0),
                totalComments: Number(recap?.overview?.totalComments || 0),
                totalLikes: Number(recap?.overview?.totalLikes || 0),
                timelineCount: Array.isArray(recap?.timeline) ? recap.timeline.length : 0,
                keyMomentCount: Array.isArray(recap?.keyMoments) ? recap.keyMoments.length : 0
            }
        });

        await updateAiWorkJob(job.id, {
            currentStep: '正在筛选高价值弹幕并生成复盘',
            progressPercent: 42,
            requestPayload: {
                trigger: 'async_worker',
                roomId: job.roomId,
                sessionId: job.sessionId,
                pointCost: Number(job.pointCost || sessionRecapPointCost),
                forceRegenerate: Boolean(job.forceRegenerate),
                recapMetrics: {
                    score: Number(recap?.overview?.score || 0),
                    totalGiftValue: Number(recap?.overview?.totalGiftValue || 0),
                    totalComments: Number(recap?.overview?.totalComments || 0),
                    totalLikes: Number(recap?.overview?.totalLikes || 0),
                    participantCount: Number(recap?.overview?.participantCount || 0),
                    payingUsers: Number(recap?.overview?.payingUsers || 0)
                },
                topCommentCount: Array.isArray(recap?.commentSignals?.topComments) ? recap.commentSignals.topComments.length : 0,
                topGiftUserCount: Array.isArray(recap?.giftSignals?.topGifters) ? recap.giftSignals.topGifters.length : 0
            }
        });

        const generated = await generateSessionAiReviewFromRecap(job.roomId, job.sessionId, recap, { trace });
        const review = parseSessionAiReview(generated, recap) || buildFallbackSessionAiReview(recap);
        const chargedPoints = isAdmin || generated.usedFallback ? 0 : Number(job.pointCost || sessionRecapPointCost);
        const resultPayload = {
            review,
            usedFallback: Boolean(generated.usedFallback),
            latencyMs: Number(generated.latencyMs || 0),
            modelName: generated.modelName || '',
            chargedPoints
        };

        await updateAiWorkJob(job.id, { currentStep: '正在保存复盘结果', progressPercent: 78, modelName: generated.modelName || '' });
        const saveResult = await saveSessionAiReviewRecord(
            job.id,
            job.userId,
            job.roomId,
            job.sessionId,
            review,
            generated.modelName,
            chargedPoints,
            resultPayload
        );

        if (!saveResult.success) {
            if (saveResult.insufficient) {
                throw new Error('AI 点数不足，任务执行时扣点失败');
            }
            throw new Error(saveResult.error || '保存 AI 复盘失败');
        }

        await trace({
            phase: 'result',
            level: 'info',
            message: 'AI 复盘结果已落库',
            payload: {
                chargedPoints: Number(saveResult.chargedPoints || chargedPoints),
                usedFallback: Boolean(generated.usedFallback),
                modelName: generated.modelName || '',
                latencyMs: Number(generated.latencyMs || 0)
            }
        });

        const effectiveChargedPoints = Number(saveResult.chargedPoints || chargedPoints);
        await trace({ phase: 'job', level: 'info', message: '任务处理完成', payload: { jobId: job.id, chargedPoints: effectiveChargedPoints } });
        await sendAiWorkJobNotification(saveResult.job || { ...job, chargedPoints: effectiveChargedPoints }, { success: true });
    } catch (err) {
        const errorMessage = err?.message || '处理失败';
        await trace({ phase: 'job', level: 'error', message: '任务执行失败', payload: { error: errorMessage } });
        const failedJob = await markAiWorkJobFailed(job.id, {
            errorMessage,
            currentStep: '处理失败',
            modelName: String(job.modelName || '')
        });
        await sendAiWorkJobNotification(failedJob || job, { success: false, errorMessage });
    }
}

async function processCustomerAnalysisAiWorkJob(job) {
    const isAdmin = Boolean(job.isAdmin);
    const customerAnalysisPointCost = await getAiPointCost(AI_POINT_SCENES.CUSTOMER_ANALYSIS);
    const requestPayload = job.requestPayload || {};
    const targetUserId = String(requestPayload.targetUserId || '').trim();
    const requestedRoomId = String(requestPayload.requestedRoomId || job.roomId || '').trim();
    const forceRegenerate = Boolean(requestPayload.force || job.forceRegenerate);
    const trace = async ({ phase = '', level = 'info', message = '', payload = null } = {}) => {
        await appendAiWorkTrace(job.id, { phase, level, message, payload });
    };

    if (!targetUserId) {
        throw new Error('缺少客户分析目标用户ID');
    }

    try {
        await markAiWorkJobStarted(job.id, '正在准备客户上下文');
        await trace({
            phase: 'job',
            level: 'info',
            message: '客户分析任务开始执行',
            payload: { targetUserId, roomId: requestedRoomId || '', attemptCount: job.attemptCount, forceRegenerate }
        });

        const roomFilter = await getRoomFilterForUserScope(job.userId, isAdmin);
        const preparedAnalysis = await prepareCustomerAnalysis({
            userId: targetUserId,
            roomId: requestedRoomId || null,
            roomFilter
        });
        const chatCount = Number(preparedAnalysis.chatCount || 0);
        const currentRoomId = preparedAnalysis.currentRoomId || '';
        const targetNickname = String(requestPayload.targetNickname || preparedAnalysis?.customerContext?.identity?.nickname || '').trim();
        const targetUniqueId = String(requestPayload.targetUniqueId || preparedAnalysis?.customerContext?.identity?.uniqueId || '').trim();

        await updateAiWorkJob(job.id, {
            roomId: currentRoomId,
            currentStep: '正在构建结构化客户上下文',
            progressPercent: 18,
            requestPayload: {
                ...requestPayload,
                analysisScene: 'room_customer',
                trigger: 'async_worker',
                targetUserId,
                targetNickname,
                targetUniqueId,
                requestedRoomId,
                currentRoomId,
                force: forceRegenerate,
                chatCount,
                promptKey: preparedAnalysis.promptKey,
                promptUpdatedAt: preparedAnalysis.promptUpdatedAt,
                contextVersion: preparedAnalysis.cacheSignature.contextVersion
            }
        });
        await trace({
            phase: 'context',
            level: 'info',
            message: '客户上下文构建完成',
            payload: {
                targetUserId,
                currentRoomId,
                chatCount,
                promptKey: preparedAnalysis.promptKey,
                contextVersion: preparedAnalysis.cacheSignature.contextVersion
            }
        });

        if (!forceRegenerate) {
            const memberCache = await getLatestMemberRoomCustomerAnalysis(job.userId, targetUserId, currentRoomId || requestedRoomId);
            if (isCustomerAnalysisCacheReusable(memberCache, preparedAnalysis.cacheSignature)) {
                const cachedAnalysis = normalizeAnalysisPayload(safeParseJsonObject(memberCache.resultJson) || {});
                const cachedChatCount = Number(memberCache.chatCount || chatCount || 0);
                const cachedResult = String(memberCache.result || '').trim();
                const cachedModelName = String(memberCache.modelName || '').trim();

                await updateAiWorkJob(job.id, {
                    currentStep: '命中缓存，正在复用客户分析结果',
                    progressPercent: 72,
                    modelName: cachedModelName
                });
                await trace({
                    phase: 'cache',
                    level: 'info',
                    message: '命中当前账号客户分析缓存，直接复用结果',
                    payload: { targetUserId, currentRoomId, chatCount: cachedChatCount }
                });

                const completedJob = await markAiWorkJobCompleted(job.id, {
                    chargedPoints: 0,
                    modelName: cachedModelName,
                    currentStep: '已复用缓存结果',
                    resultPayload: {
                        analysisScene: 'room_customer',
                        targetUserId,
                        targetNickname,
                        targetUniqueId,
                        analysis: cachedAnalysis,
                        result: cachedResult,
                        resultJsonText: memberCache.resultJson || null,
                        chatCount: cachedChatCount,
                        source: 'member_cache',
                        latencyMs: Number(memberCache.latencyMs || 0),
                        modelName: cachedModelName,
                        chargedPoints: 0,
                        cached: true
                    }
                });

                await trace({ phase: 'job', level: 'info', message: '客户分析任务命中缓存并完成', payload: { jobId: job.id, targetUserId } });
                await sendAiWorkJobNotification(completedJob || job, { success: true });
                return;
            }
        }

        if (chatCount < 10) {
            throw new Error('待分析语料不足（需至少10条弹幕记录）');
        }

        await updateAiWorkJob(job.id, {
            currentStep: '正在调用 AI 生成客户分析',
            progressPercent: 52
        });

        const generated = await runCustomerAnalysis({
            preparedInput: preparedAnalysis,
            requestAiChatCompletion,
            trace
        });
        await trace({
            phase: 'analysis',
            level: 'info',
            message: 'AI 客户分析生成完成',
            payload: {
                targetUserId,
                summary: generated.analysis?.summary || '',
                modelName: generated.modelName || '',
                latencyMs: Number(generated.latencyMs || 0)
            }
        });

        await updateAiWorkJob(job.id, {
            currentStep: '正在保存客户分析结果',
            progressPercent: 78,
            modelName: generated.modelName || ''
        });

        const resultPayload = {
            analysisScene: 'room_customer',
            targetUserId,
            targetNickname,
            targetUniqueId,
            analysis: generated.analysis,
            result: generated.result,
            resultJsonText: generated.resultJsonText,
            chatCount,
            source: 'api',
            latencyMs: Number(generated.latencyMs || 0),
            modelName: generated.modelName || '',
            chargedPoints: isAdmin ? 0 : Number(job.pointCost || customerAnalysisPointCost)
        };
        const finalizeResult = await finalizeMemberAnalysisJob({
            jobId: job.id,
            memberId: job.userId,
            targetUserId,
            result: generated.result,
            resultJson: generated.resultJsonText,
            chatCount,
            modelName: generated.modelName,
            modelVersion: generated.modelVersion,
            promptKey: preparedAnalysis.promptKey,
            promptUpdatedAt: preparedAnalysis.promptUpdatedAt,
            contextVersion: preparedAnalysis.cacheSignature.contextVersion,
            currentRoomId: preparedAnalysis.currentRoomId,
            latencyMs: generated.latencyMs,
            source: 'api',
            chargedPoints: isAdmin ? 0 : Number(job.pointCost || customerAnalysisPointCost),
            usageType: 'analysis',
            usageTargetId: targetUserId,
            resultPayload
        });
        if (!finalizeResult.success) {
            if (finalizeResult.insufficient) {
                throw new Error('AI 点数不足，任务执行时扣点失败');
            }
            throw new Error(finalizeResult.error || '保存客户分析结果失败');
        }

        const chargedPoints = Number(finalizeResult.chargedPoints || 0);
        await trace({ phase: 'job', level: 'info', message: '客户分析任务处理完成', payload: { jobId: job.id, targetUserId, chargedPoints } });
        await sendAiWorkJobNotification(finalizeResult.job || { ...job, chargedPoints }, { success: true });
    } catch (err) {
        const errorMessage = err?.message || '处理失败';
        await trace({ phase: 'job', level: 'error', message: '客户分析任务执行失败', payload: { targetUserId, error: errorMessage } });
        const failedJob = await markAiWorkJobFailed(job.id, {
            errorMessage,
            currentStep: '处理失败',
            modelName: String(job.modelName || '')
        });
        await sendAiWorkJobNotification(failedJob || job, { success: false, errorMessage });
    }
}

async function processAiWorkJob(job) {
    if (!job) return;
    if (job.jobType === AI_WORK_JOB_TYPE_SESSION_RECAP) {
        await processSessionRecapAiWorkJob(job);
        return;
    }
    if (job.jobType === AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS) {
        await processCustomerAnalysisAiWorkJob(job);
        return;
    }
    throw new Error(`暂不支持的 AI 工作类型: ${job.jobType}`);
}

async function tickAiWorkQueue() {
    if (aiWorkRuntime.ticking) return;
    if (aiWorkRuntime.activeJobs.size >= AI_WORKER_MAX_CONCURRENCY) return;

    aiWorkRuntime.ticking = true;
    try {
        const slots = AI_WORKER_MAX_CONCURRENCY - aiWorkRuntime.activeJobs.size;
        if (slots <= 0) return;

        const jobs = await claimNextAiWorkJobs(slots, 20);
        for (const job of jobs) {
            if (!job || aiWorkRuntime.activeJobs.has(job.id)) continue;
            aiWorkRuntime.activeJobs.add(job.id);
            appendAiWorkTrace(job.id, { phase: 'job', level: 'info', message: '任务已被后台 worker 领取', payload: { status: job.status, attemptCount: job.attemptCount } }).catch(() => {});
            processAiWorkJob(job)
                .catch(err => {
                    console.error('[AI_WORK] process job error:', err.message);
                })
                .finally(() => {
                    aiWorkRuntime.activeJobs.delete(job.id);
                    setTimeout(() => {
                        tickAiWorkQueue().catch(() => {});
                    }, 100);
                });
        }
    } catch (err) {
        console.error('[AI_WORK] tick queue error:', err.message);
    } finally {
        aiWorkRuntime.ticking = false;
    }
}

function kickAiWorkQueue(reason = 'manual') {
    setImmediate(() => {
        tickAiWorkQueue().catch(err => console.error(`[AI_WORK] ${reason} tick error:`, err.message));
    });
}

function startAiWorkQueueProcessor() {
    if (aiWorkRuntime.timer) return;
    kickAiWorkQueue('startup');
    aiWorkRuntime.timer = setInterval(() => {
        tickAiWorkQueue().catch(err => console.error('[AI_WORK] interval tick error:', err.message));
    }, AI_WORKER_POLL_MS);
    console.log(`[AI_WORK] Queue processor started (poll=${AI_WORKER_POLL_MS}ms, concurrency=${AI_WORKER_MAX_CONCURRENCY})`);
}

function getSimulatedAiDelayMs() {
    return 2000 + Math.floor(Math.random() * 2001);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



app.get('/api/analysis/stats', optionalAuth, async (req, res) => {
    try {
        const roomFilter = await getUserRoomFilter(req);
        console.log(`[API] /api/analysis/stats - user: ${req.user?.username || 'anonymous'}, roomFilter: ${roomFilter === null ? 'null(admin)' : JSON.stringify(roomFilter)}`);
        const cacheKey = buildAnalysisCacheKey('stats', req, roomFilter);
        const stats = await getCachedAnalysisPayload(cacheKey, () => manager.getGlobalStats(roomFilter));
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/landing/metrics', async (_req, res) => {
    try {
        const payload = await loadLandingMetricsPayload();
        res.json({
            eventCount: payload.eventCount,
            updatedAt: payload.updatedAt,
        });
    } catch (err) {
        console.error('[API] /api/landing/metrics error:', err.message);
        res.status(500).json({
            error: '获取首页指标失败',
        });
    }
});

app.get('/api/analysis/rooms/entry', optionalAuth, async (req, res) => {
    try {
        const { startDate, endDate, limit } = req.query;
        const roomFilter = await getUserRoomFilter(req);
        console.log(`[API] /api/analysis/rooms/entry - user: ${req.user?.username || 'anonymous'}, roomFilter: ${roomFilter === null ? 'null(admin)' : JSON.stringify(roomFilter)}`);
        const cacheKey = buildAnalysisCacheKey('rooms_entry', req, roomFilter, {
            startDate: String(startDate || ''),
            endDate: String(endDate || ''),
            limit: String(limit || '')
        });
        const stats = await getCachedAnalysisPayload(cacheKey, () => manager.getRoomEntryStats(startDate, endDate, limit, roomFilter));
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/analysis/ai', optionalAuth, async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: '请先登录' });

        const userId = req.body?.userId;
        const personalityPointCost = await getAiPointCost(AI_POINT_SCENES.USER_PERSONALITY);
        const force = parseRequestBoolean(req.body?.force);
        const memberId = req.user.id;
        const isAdmin = req.user?.role === 'admin';
        const roomFilter = await getUserRoomFilter(req);
        if (!userId) {
            return res.status(400).json({ error: 'userId 不能为空' });
        }

        const history = await manager.getUserChatHistory(userId, 200, roomFilter);
        const chatCount = history ? history.length : 0;
        if (chatCount < 10) {
            return res.json({ result: '待分析语料不足（需至少10条弹幕记录）', chatCount, skipped: true });
        }

        const chatCorpusText = history
            .map(item => String(item?.comment || '').trim())
            .filter(Boolean)
            .join('\n');
        const template = await getPromptTemplate(USER_PERSONALITY_ANALYSIS_PROMPT_KEY);
        const promptUpdatedAt = template?.updatedAt || null;

        if (!force) {
            const memberCache = await getLatestMemberPersonalityAnalysis(memberId, userId);
            if (isUserPersonalityAnalysisCacheReusable(memberCache, {
                promptKey: USER_PERSONALITY_ANALYSIS_PROMPT_KEY,
                promptUpdatedAt
            })) {
                return res.json({
                    result: memberCache.result,
                    pointCost: personalityPointCost,
                    cached: true,
                    chatCount: memberCache.chatCount || chatCount,
                    analyzedAt: memberCache.createdAt,
                    source: 'member_cache'
                });
            }
        }

        const existingAiJob = await getLatestPersonalityAiWorkJobForUser(memberId, userId);
        if (existingAiJob && ['queued', 'processing'].includes(String(existingAiJob.status || '').toLowerCase())) {
            return res.status(202).json({
                accepted: true,
                queued: existingAiJob.status === 'queued',
                processing: existingAiJob.status === 'processing',
                reused: true,
                cached: false,
                pointCost: personalityPointCost,
                job: serializeSessionAiWorkJobForClient(existingAiJob),
                message: 'AI 已启动，正在后台生成性格分析，完成后会自动刷新。'
            });
        }

        if (!isAdmin && !hasConfirmedAiConsumption(req)) {
            return res.status(409).json(
                buildAiConsumptionConfirmationPayload(force ? '重新分析' : '生成 AI性格分析', personalityPointCost)
            );
        }

        if (!isAdmin) {
            const credits = await db.get('SELECT ai_credits_remaining FROM users WHERE id = ?', [memberId]);
            const remaining = Number(credits?.aiCreditsRemaining || 0);
            if (remaining < personalityPointCost) {
                return res.status(403).json({ error: 'AI 点数不足，请购买点数包或升级套餐', code: 'AI_CREDITS_EXHAUSTED' });
            }
        }

        const targetProfile = await db.get('SELECT nickname, unique_id FROM "user" WHERE user_id = ?', [userId]);
        const targetNickname = String(targetProfile?.nickname || '').trim();
        const targetUniqueId = String(targetProfile?.uniqueId || '').trim();
        const creationResult = await createAiWorkJobWithLock({
            lockScope: 'ai_work_job:personality',
            lockIdentity: `${memberId}:${String(userId || '').trim()}`,
            findExistingJob: () => getLatestPersonalityAiWorkJobForUser(memberId, userId).then(existingJob => (
                existingJob && ['queued', 'processing'].includes(String(existingJob.status || '').toLowerCase())
                    ? existingJob
                    : null
            )),
            createJob: client => createAiWorkJob({
                userId: memberId,
                jobType: AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS,
                roomId: '',
                sessionId: '',
                title: `AI性格分析 · 用户 ${targetNickname ? `${targetNickname} (${userId})` : userId}`,
                pointCost: personalityPointCost,
                forceRegenerate: force,
                isAdmin,
                requestPayload: {
                    analysisScene: 'personality',
                    targetUserId: String(userId || '').trim(),
                    targetNickname,
                    targetUniqueId,
                    force,
                    chatCount,
                    pointCost: personalityPointCost,
                    promptKey: USER_PERSONALITY_ANALYSIS_PROMPT_KEY,
                    promptUpdatedAt,
                    contextVersion: USER_PERSONALITY_ANALYSIS_CONTEXT_VERSION
                },
                client
            })
        });
        const job = creationResult.job;
        if (creationResult.reused) {
            return res.status(202).json({
                accepted: true,
                queued: job.status === 'queued',
                processing: job.status === 'processing',
                reused: true,
                cached: false,
                pointCost: personalityPointCost,
                job: serializeSessionAiWorkJobForClient(job),
                message: 'AI 已启动，正在后台生成性格分析，完成后会自动刷新。'
            });
        }

        await appendAiWorkJobLog(job.id, {
            phase: 'start',
            level: 'info',
            message: '性格分析任务开始执行',
            payload: {
                analysisScene: 'personality',
                targetUserId: String(userId || '').trim(),
                chatCount,
                force
            }
        });
        await markAiWorkJobStarted(job.id, '正在生成性格分析');

        try {
            const templateContent = injectMissingStructuredDataTokens({
                scene: USER_PERSONALITY_ANALYSIS_SCENE,
                templateContent: template?.content || ''
            });
            const structuredVariables = await resolveAiStructuredDataVariables({
                scene: USER_PERSONALITY_ANALYSIS_SCENE,
                context: {
                    userId: String(userId || '').trim(),
                    roomFilter,
                    chatCorpusText
                }
            });
            const promptText = renderPromptTemplate(templateContent, structuredVariables);
            const { completion, modelName, latencyMs: aiLatency } = await requestAiChatCompletion({
                requestLabel: `user personality analysis ${userId}`,
                messages: [{ role: 'user', content: promptText }]
            });
            const result = completion.choices?.[0]?.message?.content?.trim() || '无法获取分析结果';

            const resultPayload = {
                analysisScene: 'personality',
                targetUserId: String(userId || '').trim(),
                targetNickname,
                targetUniqueId,
                result,
                summary: result,
                chatCount,
                source: 'api',
                latencyMs: Number(aiLatency || 0),
                modelName: modelName || '',
                chargedPoints: isAdmin ? 0 : personalityPointCost
            };
            const finalizeResult = await finalizeMemberAnalysisJob({
                jobId: job.id,
                memberId,
                targetUserId: userId,
                result,
                resultJson: null,
                chatCount,
                modelName,
                modelVersion: modelName,
                promptKey: USER_PERSONALITY_ANALYSIS_PROMPT_KEY,
                promptUpdatedAt,
                contextVersion: USER_PERSONALITY_ANALYSIS_CONTEXT_VERSION,
                currentRoomId: null,
                latencyMs: aiLatency,
                source: 'api',
                chargedPoints: isAdmin ? 0 : personalityPointCost,
                usageType: 'analysis',
                usageTargetId: userId,
                resultPayload
            });
            if (!finalizeResult.success) {
                if (finalizeResult.insufficient) {
                    throw new Error('AI 点数不足，请购买点数包或升级套餐');
                }
                throw new Error(finalizeResult.error || '保存性格分析结果失败');
            }

            return res.json({ result, pointCost: personalityPointCost, cached: false, chatCount, latency: aiLatency, model: modelName, source: 'api' });
        } catch (analysisErr) {
            await markAiWorkJobFailed(job.id, {
                errorMessage: analysisErr?.message || '性格分析失败',
                currentStep: '处理失败'
            });
            throw analysisErr;
        }
    } catch (err) {
        console.error('[AI] Personality analysis error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:id/customer-analysis/:userId', optionalAuth, async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: '请先登录' });

        const roomId = String(req.params.id || '').trim();
        const targetUserId = String(req.params.userId || '').trim();
        const customerAnalysisPointCost = await getAiPointCost(AI_POINT_SCENES.CUSTOMER_ANALYSIS);
        if (!roomId || !targetUserId) return res.status(400).json({ error: '参数无效' });

        const access = await canAccessRoom(req, roomId);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });

        const memberAnalysis = await getLatestMemberRoomCustomerAnalysis(req.user.id, targetUserId, roomId);
        const latestAiJob = await getLatestCustomerAnalysisAiWorkJobForUser(req.user.id, targetUserId, roomId);

        res.json({
            result: memberAnalysis?.result ? localizeCustomerAnalysisText(memberAnalysis.result) : null,
            analysis: memberAnalysis?.resultJson ? normalizeAnalysisPayload(safeParseJsonObject(memberAnalysis.resultJson) || {}) : null,
            pointCost: customerAnalysisPointCost,
            chatCount: Number(memberAnalysis?.chatCount || 0),
            analyzedAt: memberAnalysis?.createdAt || null,
            source: memberAnalysis?.source || null,
            aiJob: latestAiJob && ['queued', 'processing'].includes(String(latestAiJob.status || '').toLowerCase())
                ? serializeSessionAiWorkJobForClient(latestAiJob)
                : null
        });
    } catch (err) {
        console.error('[AI] Load room customer analysis error:', err);
        res.status(500).json({ error: err.message || '获取客户分析失败' });
    }
});

app.post('/api/rooms/:id/customer-analysis', optionalAuth, async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: '请先登录' });

        const roomId = String(req.params.id || '').trim();
        const targetUserId = String(req.body?.userId || '').trim();
        const customerAnalysisPointCost = await getAiPointCost(AI_POINT_SCENES.CUSTOMER_ANALYSIS);
        const force = parseRequestBoolean(req.body?.force);
        if (!roomId) return res.status(400).json({ error: '房间ID不能为空' });
        if (!targetUserId) return res.status(400).json({ error: 'userId 不能为空' });

        const access = await canAccessRoom(req, roomId);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });

        const memberId = req.user.id;
        const isAdmin = req.user?.role === 'admin';

        const existingJob = await findReusableCustomerAnalysisAiWorkJob({
            userId: memberId,
            targetUserId,
            roomId
        });
        if (existingJob) {
            return res.status(202).json({
                accepted: true,
                queued: existingJob.status === 'queued',
                processing: existingJob.status === 'processing',
                reused: true,
                cached: false,
                pointCost: customerAnalysisPointCost,
                job: serializeSessionAiWorkJobForClient(existingJob),
                message: 'AI 已启动，正在后台分析客户，完成后会主动通知。'
            });
        }

        if (!isAdmin && !hasConfirmedAiConsumption(req)) {
            return res.status(409).json(
                buildAiConsumptionConfirmationPayload(force ? '重新挖掘客户价值' : '开始客户价值深度挖掘', customerAnalysisPointCost)
            );
        }

        if (!isAdmin) {
            const credits = await db.get('SELECT ai_credits_remaining FROM users WHERE id = ?', [memberId]);
            const remaining = Number(credits?.aiCreditsRemaining || 0);
            if (remaining < customerAnalysisPointCost) {
                return res.status(403).json({ error: 'AI 点数不足，请购买点数包或升级套餐', code: 'AI_CREDITS_EXHAUSTED' });
            }
        }

        const targetProfile = await db.get('SELECT nickname, unique_id FROM "user" WHERE user_id = ?', [targetUserId]);
        const targetNickname = String(targetProfile?.nickname || '').trim();
        const targetUniqueId = String(targetProfile?.uniqueId || '').trim();
        const creationResult = await createAiWorkJobWithLock({
            lockScope: 'ai_work_job:room_customer',
            lockIdentity: `${memberId}:${roomId}:${targetUserId}`,
            findExistingJob: () => findReusableCustomerAnalysisAiWorkJob({
                userId: memberId,
                targetUserId,
                roomId
            }),
            createJob: client => createAiWorkJob({
                userId: memberId,
                jobType: AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS,
                roomId,
                sessionId: '',
                title: buildAiWorkTitle(AI_WORK_JOB_TYPE_CUSTOMER_ANALYSIS, {
                    roomId,
                    targetUserId,
                    targetNickname
                }),
                pointCost: customerAnalysisPointCost,
                forceRegenerate: force,
                isAdmin,
                requestPayload: {
                    analysisScene: 'room_customer',
                    trigger: 'room_detail_submit',
                    targetUserId,
                    targetNickname,
                    targetUniqueId,
                    requestedRoomId: roomId,
                    currentRoomId: roomId,
                    force,
                    pointCost: customerAnalysisPointCost
                },
                client
            })
        });
        const job = creationResult.job;
        if (creationResult.reused) {
            return res.status(202).json({
                accepted: true,
                queued: job.status === 'queued',
                processing: job.status === 'processing',
                reused: true,
                cached: false,
                pointCost: customerAnalysisPointCost,
                job: serializeSessionAiWorkJobForClient(job),
                message: 'AI 已启动，正在后台分析客户，完成后会主动通知。'
            });
        }

        await appendAiWorkJobLog(job.id, {
            phase: 'queued',
            level: 'info',
            message: '房间客户分析任务已入队，等待后台调度',
            payload: {
                targetUserId,
                currentRoomId: roomId,
                force,
                pointCost: customerAnalysisPointCost
            }
        });
        kickAiWorkQueue('room-customer-analysis-submit');

        res.status(202).json({
            accepted: true,
            queued: true,
            cached: false,
            pointCost: customerAnalysisPointCost,
            job: serializeSessionAiWorkJobForClient(job),
            message: 'AI 已启动，正在后台分析客户，完成后会主动通知。'
        });
    } catch (err) {
        console.error('[AI] Queue room customer analysis error:', err);
        res.status(500).json({ error: '创建房间客户分析任务失败，请稍后重试' });
    }
});



app.post('/api/rooms', optionalAuth, async (req, res) => {
    try {
        let { roomId, name, address, isMonitorEnabled, language, priority, isRecordingEnabled, recordingAccountId } = req.body;

        // Normalize roomId: remove @ prefix to prevent duplicates (e.g. @blooming1881 vs blooming1881)
        if (roomId && roomId.startsWith('@')) {
            roomId = roomId.substring(1);
            console.log(`[API] Normalized roomId by removing @ prefix: ${roomId}`);
        }

        if (!roomId) return res.status(400).json({ error: '房间ID不能为空' });

        const isAdmin = req.user && req.user.role === 'admin';

        // ==================== Admin: direct system-level operation ====================
        if (isAdmin) {
            const room = await manager.updateRoom(roomId, name, address, isMonitorEnabled, language, priority, isRecordingEnabled, recordingAccountId);
            console.log(`[API] Admin updated room:`, room);

            // If monitor was just disabled, disconnect immediately
            if (isMonitorEnabled === false || isMonitorEnabled === 0 || isMonitorEnabled === '0') {
                console.log(`[API] Room ${roomId} monitor disabled. Triggering immediate disconnect...`);
                await autoRecorder.disconnectRoom(roomId);
            }

            await invalidateRoomListCaches('admin room update');
            return res.json({ success: true, room });
        }

        // ==================== Member: user_room copy logic ====================
        if (!req.user) return res.status(401).json({ error: '请先登录' });

        // Check existing user_room (including soft-deleted)
        const existingCopy = await db.get(
            'SELECT id, deleted_at, first_added_at FROM user_room WHERE user_id = ? AND room_id = ?',
            [req.user.id, roomId]
        );

        // For NEW room (no existing copy, or soft-deleted copy) - check quota + daily limit
        const isNewForUser = !existingCopy || existingCopy.deletedAt;
        if (isNewForUser) {
            const quota = await getUserQuota(req.user.id);
            if (!quota.hasSubscription && quota.limit === 0) {
                return res.status(403).json({
                    error: '您还没有有效的订阅套餐，请前往用户中心购买套餐后再使用',
                    code: 'NO_SUBSCRIPTION',
                    quota
                });
            }
            if (quota.limit !== -1 && quota.remaining <= 0) {
                return res.status(403).json({
                    error: '房间配额已满，请升级套餐或购买扩容包',
                    code: 'QUOTA_EXCEEDED',
                    quota
                });
            }

            if (quota.dailyLimit !== -1 && quota.dailyRemaining <= 0) {
                return res.status(403).json({
                    error: `今日新建房间次数已达上限（${quota.dailyLimit}次/天），请明天再试`,
                    code: 'DAILY_LIMIT_EXCEEDED',
                    dailyLimit: quota.dailyLimit,
                    createdToday: quota.dailyUsed,
                    quota
                });
            }
        }

        // Ensure system-level room record exists (INSERT only, never update existing)
        const existingRoom = await db.get('SELECT room_id FROM room WHERE room_id = ?', [roomId]);
        if (!existingRoom) {
            // New room created by user - mark user_id, enable monitoring
            await db.run(
                `INSERT INTO room (room_id, name, is_monitor_enabled, user_id, updated_at) VALUES (?, ?, 1, ?, NOW())`,
                [roomId, roomId, req.user.id]
            );
            console.log(`[API] User ${req.user.id} created new system room: ${roomId}`);
        } else {
            // Room exists but might have monitoring disabled (was orphaned before)
            // Re-enable monitoring when a user adds it
            await db.run('UPDATE room SET is_monitor_enabled = 1, updated_at = NOW() WHERE room_id = ? AND is_monitor_enabled = 0', [roomId]);
        }

        // Upsert user_room copy
        const alias = name || null;
        if (existingCopy && existingCopy.deletedAt) {
            // Restoring a soft-deleted copy
            // Check if first_added_at is within 7 days - if so, keep it; otherwise reset
            const firstAdded = existingCopy.firstAddedAt ? new Date(existingCopy.firstAddedAt) : null;
            const daysSinceFirst = firstAdded ? (Date.now() - firstAdded.getTime()) / (1000 * 60 * 60 * 24) : 999;
            const newFirstAdded = daysSinceFirst <= 7 ? existingCopy.firstAddedAt : new Date();

            await db.run(
                `UPDATE user_room SET alias = ?, deleted_at = NULL, is_enabled = true, first_added_at = ?, updated_at = NOW() WHERE id = ?`,
                [alias, newFirstAdded, existingCopy.id]
            );
            console.log(`[API] User ${req.user.id} restored room copy: ${roomId} (data from ${daysSinceFirst <= 7 ? 'previous' : 'now'})`);
        } else if (existingCopy) {
            // Update existing active copy (user editing alias)
            await db.run(
                'UPDATE user_room SET alias = ?, updated_at = NOW() WHERE id = ?',
                [alias, existingCopy.id]
            );
            console.log(`[API] User ${req.user.id} updated room alias: ${roomId} -> ${alias}`);
        } else {
            // Brand new copy
            await db.run(
                'INSERT INTO user_room (user_id, room_id, alias, first_added_at) VALUES (?, ?, ?, NOW())',
                [req.user.id, roomId, alias]
            );
            console.log(`[API] User ${req.user.id} added new room copy: ${roomId}`);
        }

        await invalidateRoomListCaches('member room upsert');
        res.json({ success: true, room: { room_id: roomId, name: alias || roomId } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rename room (Migrate ID / Merge)
app.post('/api/rooms/:id/rename', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const normalizeRenameRoomId = (value) => {
            const text = String(value || '').trim();
            return text.startsWith('@') ? text.slice(1) : text;
        };

        const roomId = normalizeRenameRoomId(req.params.id);
        const newRoomId = normalizeRenameRoomId(req.body?.newRoomId);
        const mergeExisting = Boolean(req.body?.mergeExisting);

        if (!roomId) {
            return res.status(400).json({ error: '原房间ID不能为空' });
        }
        if (!newRoomId) {
            return res.status(400).json({ error: '新房间ID不能为空' });
        }

        const sourceRoom = await db.get('SELECT room_id FROM room WHERE room_id = ?', [roomId]);
        if (!sourceRoom) {
            const existingTargetRoom = await db.get(
                'SELECT room_id, name, is_monitor_enabled, is_recording_enabled FROM room WHERE room_id = ?',
                [newRoomId]
            );
            if (existingTargetRoom) {
                return res.status(409).json({
                    error: '原房间可能已完成迁移，请刷新列表确认',
                    code: 'ROOM_ALREADY_MIGRATED',
                    oldRoomId: roomId,
                    newRoomId,
                    targetRoom: {
                        roomId: existingTargetRoom.roomId || existingTargetRoom.room_id,
                        name: existingTargetRoom.name || existingTargetRoom.roomId || existingTargetRoom.room_id || newRoomId,
                        isMonitorEnabled: Number(existingTargetRoom.isMonitorEnabled ?? existingTargetRoom.is_monitor_enabled ?? 0),
                        isRecordingEnabled: Number(existingTargetRoom.isRecordingEnabled ?? existingTargetRoom.is_recording_enabled ?? 0)
                    }
                });
            }
            return res.status(404).json({ error: '源房间不存在', code: 'ROOM_NOT_FOUND' });
        }

        if (!mergeExisting) {
            const targetRoom = await db.get(
                'SELECT room_id, name, is_monitor_enabled, is_recording_enabled FROM room WHERE room_id = ?',
                [newRoomId]
            );
            if (targetRoom) {
                return res.status(409).json({
                    error: '目标房间ID已存在，请确认是否合并',
                    code: 'TARGET_ROOM_EXISTS',
                    requiresConfirmation: true,
                    oldRoomId: roomId,
                    newRoomId,
                    targetRoom: {
                        roomId: targetRoom.roomId || targetRoom.room_id,
                        name: targetRoom.name || targetRoom.roomId || targetRoom.room_id || newRoomId,
                        isMonitorEnabled: Number(targetRoom.isMonitorEnabled ?? targetRoom.is_monitor_enabled ?? 0),
                        isRecordingEnabled: Number(targetRoom.isRecordingEnabled ?? targetRoom.is_recording_enabled ?? 0)
                    }
                });
            }
        }

        // Stop live ingestion before queuing background processing to avoid new events on old room_id.
        await autoRecorder.disconnectRoom(roomId).catch((err) => {
            console.warn(`[API] Failed to disconnect room ${roomId} before rename:`, err?.message || err);
        });
        if (recordingManager.isRecording(roomId)) {
            await recordingManager.stopRecording(roomId).catch((err) => {
                console.warn(`[API] Failed to stop recording for room ${roomId} before rename:`, err?.message || err);
            });
        }

        const queuedJob = await enqueueRoomRenameJob({
            oldRoomId: roomId,
            newRoomId,
            mergeExisting,
            createdByUserId: req.user?.id,
            source: 'monitor-room-list'
        });
        res.status(202).json({
            success: true,
            accepted: true,
            queued: queuedJob.queued,
            processing: queuedJob.processing,
            reused: queuedJob.reused,
            oldRoomId: roomId,
            newRoomId,
            mergeExisting,
            job: queuedJob.job,
            message: queuedJob.reused
                ? `已有同房间${mergeExisting ? '合并' : '迁移'}任务正在后台执行，可在右下角任务面板查看进度。`
                : `房间${mergeExisting ? '合并' : '迁移'}任务已提交，可在右下角任务面板查看进度。`
        });
    } catch (err) {
        if (err?.code === 'ROOM_RENAME_IN_PROGRESS') {
            return res.status(409).json({
                error: '该房间正在执行迁移或合并，请勿重复提交',
                code: 'ROOM_RENAME_IN_PROGRESS',
                oldRoomId: String(req.params.id || '').trim(),
                newRoomId: String(req.body?.newRoomId || '').trim()
            });
        }
        if (err?.code === 'ROOM_ALREADY_MIGRATED') {
            return res.status(409).json({
                error: '原房间已不存在，可能已完成迁移或合并。请刷新列表确认结果。',
                code: 'ROOM_ALREADY_MIGRATED',
                oldRoomId: String(req.params.id || '').trim(),
                newRoomId: String(req.body?.newRoomId || '').trim(),
                targetRoom: err?.details?.targetRoom || null
            });
        }
        if (err?.code === 'TARGET_ROOM_EXISTS') {
            return res.status(409).json({
                error: '目标房间ID已存在，请确认是否合并',
                code: 'TARGET_ROOM_EXISTS',
                requiresConfirmation: true,
                oldRoomId: String(req.params.id || '').trim(),
                newRoomId: String(req.body?.newRoomId || '').trim(),
                targetRoom: err?.details?.targetRoom || null
            });
        }
        if (err?.code === 'ROOM_NOT_FOUND') {
            return res.status(404).json({ error: '源房间不存在', code: 'ROOM_NOT_FOUND' });
        }
        console.error('[API] Rename room error:', err);
        res.status(500).json({ error: err.message || '房间ID更新失败' });
    }
});

app.post('/api/rooms/:id/stop', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const roomId = req.params.id;
        // Stop monitoring
        const result = await autoRecorder.disconnectRoom(roomId);
        // Stop recording if active
        if (recordingManager.isRecording(roomId)) {
            await recordingManager.stopRecording(roomId);
        }
        await invalidateRoomListCaches('room stop');
        res.json({ success: true, stopped: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recording API
app.post('/api/rooms/:id/recording/start', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const roomIdFromUrl = req.params.id;
        let { roomId, uniqueId, accountId } = req.body;

        // Use URL param if body doesn't have roomId
        roomId = roomId || roomIdFromUrl;

        // If uniqueId not provided, look it up from the room record
        if (!uniqueId) {
            const room = await manager.getRoom(roomId);
            console.log(`[Recording API] Looking up room ${roomId}:`, room);
            if (room) {
                // Database returns snake_case column names
                uniqueId = room.room_id;
                console.log(`[Recording API] Resolved uniqueId: ${uniqueId}`);
            }
        }

        if (!uniqueId) {
            return res.status(400).json({ success: false, error: 'uniqueId is required' });
        }

        const result = await recordingManager.startRecording(roomId, uniqueId, accountId || null);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/rooms/:id/recording/stop', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const roomId = req.params.id;
        const result = await recordingManager.stopRecording(roomId);
        res.json({ success: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:id/recording/status', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), (req, res) => {
    const roomId = req.params.id;
    res.json({ isRecording: recordingManager.isRecording(roomId) });
});

app.get('/api/recordings/active', (req, res) => {
    // Return array of roomIds
    const activeRooms = Array.from(recordingManager.activeRecordings.keys());
    res.json(activeRooms);
});

// Recording Task Management API
app.get('/api/recording_tasks', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const db = require('./db');
        const { roomId, status, dateFrom, dateTo, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = [];
        let params = [];
        let paramNum = 1;

        if (roomId) {
            whereClause.push(`room_id = $${paramNum++}`);
            params.push(roomId);
        }
        if (status) {
            whereClause.push(`status = $${paramNum++}`);
            params.push(status);
        }
        if (dateFrom) {
            whereClause.push(`start_time >= $${paramNum++}`);
            params.push(dateFrom);
        }
        if (dateTo) {
            whereClause.push(`start_time <= $${paramNum++}`);
            params.push(dateTo + ' 23:59:59');
        }

        const whereStr = whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : '';

        // Get total count
        const countResult = await db.get(`SELECT COUNT(*) as total FROM recording_task ${whereStr}`, params);
        const total = parseInt(countResult.total);

        // Get paginated results
        params.push(parseInt(limit));
        params.push(offset);
        const tasks = await db.query(`
            SELECT ${SAFE_RECORDING_TASK_SELECT} FROM recording_task
            ${whereStr}
            ORDER BY start_time DESC
            LIMIT $${paramNum++} OFFSET $${paramNum}
        `, params);

        res.json({
            tasks: tasks.map(serializeRecordingTask),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('[API] Error fetching recording tasks:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get rooms with recording history (for dropdown)
app.get('/api/recording_tasks/rooms', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const db = require('./db');
        const rooms = await db.query(`
            SELECT room_id, COUNT(*) as task_count, MAX(start_time) as last_recorded
            FROM recording_task
            GROUP BY room_id
            ORDER BY last_recorded DESC
        `);
        res.json(rooms);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get single task detail
app.get('/api/recording_tasks/:id', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const db = require('./db');
        const task = await db.get(`SELECT ${SAFE_RECORDING_TASK_SELECT} FROM recording_task WHERE id = $1`, [req.params.id]);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }
        res.json(serializeRecordingTask(task));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete recording task
app.delete('/api/recording_tasks/:id', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const db = require('./db');
        const { deleteFile } = req.query;
        const task = await db.get('SELECT id, file_path FROM recording_task WHERE id = $1', [req.params.id]);

        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Optionally delete the file
        if (deleteFile === 'true' && task.filePath) {
            const fs = require('fs');
            if (fs.existsSync(task.filePath)) {
                fs.unlinkSync(task.filePath);
                console.log(`[Recorder] Deleted file: ${task.filePath}`);
            }
        }

        await db.run('DELETE FROM recording_task WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recording_tasks/:id/access', authenticate, async (req, res) => {
    try {
        const task = await getRecordingTaskInternal(req.params.id);
        const access = await ensureRecordingTaskAccess(req, task);
        if (!access.allowed) return res.status(access.status).json(access.payload);

        const recordingAccessConfig = getEffectiveRecordingAccessConfig();
        const expiresAt = new Date(Date.now() + recordingAccessConfig.ttlSecs * 1000).toISOString();

        if (isRecordingStoredRemotely(task)) {
            const url = recordingStorageService.createRecordingSignedUrl(task, {
                expiresInSeconds: recordingAccessConfig.ttlSecs,
            });
            return res.json({
                url,
                expiresAt,
                source: 'object_storage',
                status: task.status,
            });
        }

        if (task.filePath) {
            const accessToken = buildRecordingAccessToken(task, req.user);
            return res.json({
                url: `/api/recording_tasks/${task.id}/download?accessToken=${encodeURIComponent(accessToken)}`,
                expiresAt,
                source: 'local_proxy',
                status: task.status,
            });
        }

        return res.status(409).json({ error: '录播文件暂不可用', code: 'RECORDING_NOT_READY' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download recording file
app.get('/api/recording_tasks/:id/download', optionalAuth, async (req, res) => {
    try {
        const task = await getRecordingTaskInternal(req.params.id);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const tokenAccess = verifyRecordingAccessToken(req.query.accessToken, req.params.id);
        let allowed = Boolean(tokenAccess);
        if (!allowed && req.user) {
            const access = await ensureRecordingTaskAccess(req, task);
            allowed = access.allowed;
            if (!allowed) {
                return res.status(access.status).json(access.payload);
            }
        }

        if (!allowed) {
            return res.status(401).json({ error: '无权下载此录播' });
        }

        if (task.filePath) {
            const fs = require('fs');
            const path = require('path');
            if (fs.existsSync(task.filePath)) {
                const fileName = path.basename(task.filePath);
                return res.download(task.filePath, fileName);
            }
        }

        if (isRecordingStoredRemotely(task)) {
            const signedUrl = recordingStorageService.createRecordingSignedUrl(task, {
                expiresInSeconds: getEffectiveRecordingAccessConfig().ttlSecs,
            });
            return res.redirect(signedUrl);
        }

        return res.status(404).json({ error: 'File not found' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// ============= Highlight Clip API =============
const highlightExtractor = require('./highlight_extractor');

// Analyze recording for potential highlights (preview)
app.get('/api/recording_tasks/:id/highlights/analyze', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const options = {
            minDiamonds: parseInt(req.query.minDiamonds) || highlightExtractor.DEFAULT_MIN_DIAMONDS,
            bufferBefore: parseInt(req.query.bufferBefore) || highlightExtractor.DEFAULT_BUFFER_BEFORE,
            bufferAfter: parseInt(req.query.bufferAfter) || highlightExtractor.DEFAULT_BUFFER_AFTER,
            mergeWindow: parseInt(req.query.mergeWindow) || highlightExtractor.DEFAULT_MERGE_WINDOW
        };

        const segments = await highlightExtractor.analyzeRecordingForHighlights(
            parseInt(req.params.id),
            options
        );

        res.json({
            success: true,
            segments,
            options,
            count: segments.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start highlight extraction
app.post('/api/recording_tasks/:id/highlights/extract', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const options = {
            minDiamonds: parseInt(req.body.minDiamonds) || highlightExtractor.DEFAULT_MIN_DIAMONDS,
            bufferBefore: parseInt(req.body.bufferBefore) || highlightExtractor.DEFAULT_BUFFER_BEFORE,
            bufferAfter: parseInt(req.body.bufferAfter) || highlightExtractor.DEFAULT_BUFFER_AFTER,
            mergeWindow: parseInt(req.body.mergeWindow) || highlightExtractor.DEFAULT_MERGE_WINDOW
        };

        const results = await highlightExtractor.extractAllHighlights(
            parseInt(req.params.id),
            options
        );

        res.json({
            success: true,
            results,
            extracted: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get highlight clips for a recording
app.get('/api/recording_tasks/:id/highlights', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const clips = await highlightExtractor.getHighlightClips(parseInt(req.params.id));
        res.json({ success: true, clips });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download a highlight clip
app.get('/api/highlight_clips/:id/download', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const db = require('./db');
        const clip = await db.get('SELECT * FROM highlight_clip WHERE id = $1', [req.params.id]);

        if (!clip || !clip.filePath) {
            return res.status(404).json({ error: 'Clip not found' });
        }

        const fs = require('fs');
        const path = require('path');

        if (!fs.existsSync(clip.filePath)) {
            return res.status(404).json({ error: 'Clip file does not exist on disk' });
        }

        const fileName = path.basename(clip.filePath);
        res.download(clip.filePath, fileName);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a highlight clip
app.delete('/api/highlight_clips/:id', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const deleteFile = req.query.deleteFile !== 'false';
        await highlightExtractor.deleteHighlightClip(parseInt(req.params.id), deleteFile);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// TikTok Account API
app.get('/api/tiktok_accounts', async (req, res) => {
    try {
        const accounts = await manager.getTikTokAccounts();
        res.json({ accounts });
    } catch (err) {
        // Fallback if manager method not exists yet
        try {
            const db = require('./db');
            const accounts = await db.query('SELECT * FROM tiktok_account ORDER BY id DESC');
            res.json({ accounts });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }
});

app.post('/api/tiktok_accounts', async (req, res) => {
    try {
        const { username, cookie, proxyId, isActive } = req.body;
        const db = require('./db');
        await db.run('INSERT INTO tiktok_account (username, cookie, proxy_id, is_active) VALUES ($1, $2, $3, $4)',
            [username, cookie, proxyId, isActive]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tiktok_accounts/:id', async (req, res) => {
    try {
        const db = require('./db');
        await db.run('DELETE FROM tiktok_account WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tiktok_accounts/:id', async (req, res) => {
    try {
        const db = require('./db');
        const { username, cookie, proxyId, isActive } = req.body;
        console.log(`[API] PUT /api/tiktok_accounts/${req.params.id}`, req.body);

        // Build dynamic update query
        const updates = [];
        const params = [];
        let paramNum = 1;

        if (username !== undefined) { updates.push(`username = $${paramNum++}`); params.push(username); }
        if (cookie !== undefined) { updates.push(`cookie = $${paramNum++}`); params.push(cookie); }
        if (proxyId !== undefined) { updates.push(`proxy_id = $${paramNum++}`); params.push(proxyId); }
        if (isActive !== undefined) { updates.push(`is_active = $${paramNum++}`); params.push(isActive); }

        if (updates.length > 0) {
            updates.push(`updated_at = NOW()`);
            const query = `UPDATE tiktok_account SET ${updates.join(', ')} WHERE id = $${paramNum} RETURNING *`;
            params.push(req.params.id);
            console.log(`[API] Executing update: ${query} params:`, params);
            // Use pool.query directly to get rowCount and rows
            const result = await db.pool.query(query, params);

            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Account not found' });
            }
            const updatedAccount = result.rows[0];
            res.json(updatedAccount);
        } else {
            res.status(400).json({ error: 'No fields to update' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Socks5 Proxy API
app.get('/api/socks5_proxies', async (req, res) => {
    try {
        const db = require('./db');
        const proxies = await db.query('SELECT * FROM socks5_proxy ORDER BY id DESC');
        res.json(proxies);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/socks5_proxies', async (req, res) => {
    try {
        const { name, host, port, username, password, isActive } = req.body;
        const db = require('./db');
        await db.run('INSERT INTO socks5_proxy (name, host, port, username, password, is_active) VALUES ($1, $2, $3, $4, $5, $6)',
            [name, host, port, username, password, isActive]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/socks5_proxies/:id', async (req, res) => {
    try {
        const db = require('./db');
        await db.run('DELETE FROM socks5_proxy WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/socks5_proxies/:id', async (req, res) => {
    try {
        const db = require('./db');
        const { name, host, port, username, password, isActive } = req.body;

        // Build dynamic update query
        const updates = [];
        const params = [];
        let paramNum = 1;

        if (name !== undefined) { updates.push(`name = $${paramNum++}`); params.push(name); }
        if (host !== undefined) { updates.push(`host = $${paramNum++}`); params.push(host); }
        if (port !== undefined) { updates.push(`port = $${paramNum++}`); params.push(port); }
        if (username !== undefined) { updates.push(`username = $${paramNum++}`); params.push(username); }
        if (password !== undefined) { updates.push(`password = $${paramNum++}`); params.push(password); }
        if (isActive !== undefined) { updates.push(`is_active = $${paramNum++}`); params.push(isActive); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(req.params.id);
        await db.run(`UPDATE socks5_proxy SET ${updates.join(', ')} WHERE id = $${paramNum}`, params);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/socks5_proxies/:id/test', async (req, res) => {
    try {
        const db = require('./db');
        const { SocksProxyAgent } = require('socks-proxy-agent');
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        const proxy = await db.get('SELECT * FROM socks5_proxy WHERE id = $1', [req.params.id]);
        if (!proxy) {
            return res.status(404).json({ error: 'Proxy not found' });
        }

        const proxyUrl = `socks5://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
        const agent = new SocksProxyAgent(proxyUrl, {
            rejectUnauthorized: false,
            timeout: 15000,
            keepAlive: true
        });

        // Allow custom test URL (for CDN testing)
        const testUrl = req.body.testUrl || 'https://pull-f5-sg01.tiktokcdn.com/';
        console.log(`[ProxyTest] Testing ${proxy.host}:${proxy.port} -> ${testUrl}`);

        const start = Date.now();
        const response = await fetch(testUrl, {
            agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 20000
        });

        const duration = Date.now() - start;
        console.log(`[ProxyTest] Result: ${response.status} in ${duration}ms`);

        if (response.ok || response.status < 500) {
            res.json({ success: true, duration, status: response.status, testedUrl: testUrl });
        } else {
            res.json({ success: false, error: `HTTP ${response.status}`, duration, testedUrl: testUrl });
        }
    } catch (err) {
        console.error(`[ProxyTest] Failed: ${err.message}`);
        res.json({ success: false, error: err.message });
    }
});


// Debug API - Force clear a stale connection (for testing)
app.delete('/api/debug/connections/:id', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    const roomId = req.params.id;
    console.log(`[Debug] Force clearing connection for ${roomId}`);
    const result = await autoRecorder.disconnectRoom(roomId);
    await invalidateRoomListCaches('debug connection clear');
    res.json({ cleared: true, roomId, result });
});

// Migrate events from numeric room_id to username room_id
app.post('/api/migrate-events', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const queuedJob = await enqueueEventMigrationJob({
            source: 'legacy-api',
            createdByUserId: req.user?.id,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            message: buildAcceptedAdminJobMessage('事件房间标识迁移任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fix orphaned events - create sessions for events without session_id
app.post('/api/fix-orphaned-events', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const queuedJob = await enqueueSessionMaintenanceJob('fix_orphaned_events', {
            source: 'legacy-api',
            createdByUserId: req.user?.id,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            taskKey: 'fix_orphaned_events',
            message: buildAcceptedAdminJobMessage('孤儿事件修复任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete empty sessions (sessions with 0 events)
app.post('/api/delete-empty-sessions', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const queuedJob = await enqueueSessionMaintenanceJob('delete_empty_sessions', {
            source: 'legacy-api',
            createdByUserId: req.user?.id,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            taskKey: 'delete_empty_sessions',
            message: buildAcceptedAdminJobMessage('空场次清理任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rebuild missing session records (for events with session_id but no session record)
app.post('/api/rebuild-missing-sessions', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const queuedJob = await enqueueSessionMaintenanceJob('rebuild_missing_sessions', {
            source: 'legacy-api',
            createdByUserId: req.user?.id,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            taskKey: 'rebuild_missing_sessions',
            message: buildAcceptedAdminJobMessage('缺失场次重建任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function shouldRunStatsJobsInWebProcess() {
    return !schemeAConfig.worker.enableStats;
}

function readOptionalBooleanEnv(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return null;
    }
    return String(raw).trim().toLowerCase() === 'true';
}

function isPeriodicStatsRefreshEnabled() {
    const explicit = readOptionalBooleanEnv('ENABLE_PERIODIC_STATS_REFRESH');
    if (explicit !== null) return explicit;
    return false;
}

function isStartupStatsWarmupEnabled() {
    const explicit = readOptionalBooleanEnv('ENABLE_STARTUP_STATS_WARMUP');
    if (explicit !== null) return explicit;
    return false;
}

function buildAcceptedAdminJobMessage(defaultMessage, queuedJob) {
    return queuedJob?.reused
        ? `已有同类后台任务正在执行：${defaultMessage}`
        : defaultMessage;
}

function sendAcceptedAdminJobResponse(res, queuedJob, payload = {}) {
    return res.status(202).json({
        success: true,
        accepted: true,
        queued: Boolean(queuedJob?.queued),
        processing: Boolean(queuedJob?.processing),
        reused: Boolean(queuedJob?.reused),
        job: queuedJob?.job || null,
        ...payload,
    });
}

// Manually refresh room_stats cache (for immediate update after changes)
app.post('/api/maintenance/refresh_room_stats', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const queuedJob = await enqueueStatsRefreshJob('room', {
            source: 'manual-api',
            createdByUserId: req.user?.id,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            message: buildAcceptedAdminJobMessage('房间统计刷新任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually refresh user_stats cache (for immediate update after changes)
app.post('/api/maintenance/refresh_user_stats', authenticate, requireAdmin, requireAdminPermission('session_maintenance.manage'), async (req, res) => {
    try {
        const queuedJob = await enqueueStatsRefreshJob('user', {
            source: 'manual-api',
            createdByUserId: req.user?.id,
        });
        return sendAcceptedAdminJobResponse(res, queuedJob, {
            message: buildAcceptedAdminJobMessage('用户统计刷新任务已加入后台队列。', queuedJob),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
const PORT = process.env.PORT || 8081;
httpServer.listen(PORT, async () => {
    console.log(`Server started on http://localhost:${PORT}`);

    await db.initDb();
    await refreshSchemeARuntimeConfig('startup-db-sync');
    await repairCriticalPromptTemplates().catch((err) => {
        console.error('[AI Prompt] Critical template repair skipped:', err.message);
    });

    metricsService.emitLog('info', 'scheme_a.startup', {
        featureFlags: getSchemeAFeatureFlags(),
        redisConfigured: Boolean(schemeAConfig.redis.url),
        objectStorageConfigured: Boolean(schemeAConfig.objectStorage.endpoint && schemeAConfig.objectStorage.bucket),
        recordingUploadWorker: {
            enabled: schemeAConfig.worker.enableRecordingUpload,
            daemonEnabled: schemeAConfig.worker.enableRecordingUploadDaemon,
            pollMs: schemeAConfig.worker.recordingUploadPollMs,
            batchSize: schemeAConfig.worker.recordingUploadBatchSize,
            cleanupEnabled: schemeAConfig.worker.enableRecordingLocalCleanup,
            cleanupDelayMs: schemeAConfig.worker.recordingLocalCleanupDelayMs,
            daemonRestartDelayMs: schemeAConfig.worker.recordingUploadDaemonRestartDelayMs,
            daemonMaxRestarts: schemeAConfig.worker.recordingUploadDaemonMaxRestarts,
        },
        statsWorker: {
            enabled: schemeAConfig.worker.enableStats,
        },
        maintenanceWorker: {
            enabled: schemeAConfig.worker.enableMaintenance,
        },
    });

    // Cleanup orphaned recording tasks from previous session (crashed or force-closed)
    await recordingManager.cleanupOrphanedTasks();

    // Start user management periodic tasks (subscription expiry, token cleanup)
    startPeriodicTasks();
    startAiWorkQueueProcessor();
    ensureStatsWorkerDaemon();
    ensureMaintenanceWorkerDaemon();
    scheduleAdminAsyncJobWebFallback();

    // Scheduled jobs
    // Run user language analysis every hour
    setInterval(async () => {
        try {
            console.log('[CRON] Running hourly user language analysis...');
            await manager.analyzeUserLanguages(2000);
        } catch (err) {
            console.error('[CRON] Language analysis error:', err.message);
        }
    }, 60 * 60 * 1000); // Every hour

    if (isPeriodicStatsRefreshEnabled()) {
        // Refresh room_stats cache every 30 minutes (for fast API responses)
        setInterval(async () => {
            if (!shouldRunStatsJobsInWebProcess()) return;
            try {
                await runRoomStatsRefreshJob('interval');
            } catch (err) {
                console.error('[CRON] Room stats refresh error:', err.message);
            }
        }, 30 * 60 * 1000); // Every 30 minutes

        // Refresh user_stats cache every 30 minutes (for fast user analysis API)
        setInterval(async () => {
            if (!shouldRunStatsJobsInWebProcess()) return;
            try {
                await runUserStatsRefreshJob('interval');
            } catch (err) {
                console.error('[CRON] User stats refresh error:', err.message);
            }
        }, 30 * 60 * 1000); // Every 30 minutes
    } else if (shouldRunStatsJobsInWebProcess()) {
        setInterval(async () => {
            try {
                await runDirtyRoomStatsRepairJob('web-fallback-interval');
            } catch (err) {
                console.error('[CRON] Dirty room_stats repair error:', err.message);
            }
        }, 2 * 60 * 1000);
    } else {
        console.log('[CRON] Periodic room_stats/user_stats refresh disabled in web process');
    }

    // Run initial tasks after startup
    setTimeout(async () => {
        try {
            console.log('[CRON] Running initial user language analysis...');
            await manager.analyzeUserLanguages(2000);
        } catch (err) {
            console.error('[CRON] Initial language analysis error:', err.message);
        }
    }, 30000); // 30 seconds after startup

    if (isStartupStatsWarmupEnabled()) {
        // Refresh room stats on startup (for API performance)
        setTimeout(async () => {
            if (!shouldRunStatsJobsInWebProcess()) return;
            try {
                await runRoomStatsRefreshJob('startup');
            } catch (err) {
                console.error('[CRON] Initial room stats refresh error:', err.message);
            }
        }, 10000); // 10 seconds after startup

        // Refresh user stats on startup (for API performance)
        setTimeout(async () => {
            if (!shouldRunStatsJobsInWebProcess()) return;
            try {
                await runUserStatsRefreshJob('startup');
            } catch (err) {
                console.error('[CRON] Initial user stats refresh error:', err.message);
            }
        }, 15000); // 15 seconds after startup
    } else if (shouldRunStatsJobsInWebProcess()) {
        setTimeout(async () => {
            try {
                await runDirtyRoomStatsRepairJob('web-fallback-startup');
            } catch (err) {
                console.error('[CRON] Initial dirty room_stats repair error:', err.message);
            }
        }, 12000);
    } else {
        console.log('[CRON] Startup room_stats/user_stats warmup disabled in web process');
    }

    // Refresh global stats on startup (for /api/analysis/stats performance)
    setTimeout(async () => {
        if (!shouldRunStatsJobsInWebProcess()) return;
        try {
            console.log('[CRON] Initial global stats refresh...');
            await runGlobalStatsRefreshJob('startup');
        } catch (err) {
            console.error('[CRON] Initial global stats refresh error:', err.message);
        }
    }, 20000); // 20 seconds after startup

    // Refresh global_stats cache every 30 minutes (for fast /api/analysis/stats responses)
    setInterval(async () => {
        if (!shouldRunStatsJobsInWebProcess()) return;
        try {
            console.log('[CRON] Refreshing global stats cache...');
            await runGlobalStatsRefreshJob('interval');
        } catch (err) {
            console.error('[CRON] Global stats refresh error:', err.message);
        }
    }, 30 * 60 * 1000); // Every 30 minutes

    // 7-day data retention cleanup - runs every 6 hours
    setInterval(async () => {
        if (schemeAConfig.worker.enableMaintenance) return;
        try {
            console.log('[CRON] Running expired room data cleanup (7-day retention)...');
            await runExpiredRoomCleanupJob('web-interval');
        } catch (err) {
            console.error('[CRON] Room data cleanup error:', err.message);
        }
    }, 6 * 60 * 60 * 1000); // Every 6 hours

    // Run initial cleanup 60 seconds after startup
    setTimeout(async () => {
        if (schemeAConfig.worker.enableMaintenance) return;
        try {
            console.log('[CRON] Initial expired room data cleanup...');
            await runExpiredRoomCleanupJob('web-startup');
        } catch (err) {
            console.error('[CRON] Initial room data cleanup error:', err.message);
        }
    }, 60000); // 60 seconds after startup
});

// Graceful shutdown handling - save all active recordings before exit
async function gracefulShutdown(signal) {
    console.log(`\n[Server] Received ${signal}, initiating graceful shutdown...`);

    try {
        await stopManagedWorkers(signal);

        // Stop all active recordings and save their state
        await recordingManager.stopAllRecordings();

        liveStateService.shutdownLiveStateService();
        await disconnectRedisClient();

        // Close HTTP server
        httpServer.close(() => {
            console.log('[Server] HTTP server closed.');
            process.exit(0);
        });

        // Force exit after 10 seconds if server doesn't close
        setTimeout(() => {
            console.warn('[Server] Forcing exit after timeout.');
            process.exit(1);
        }, 10000);

    } catch (err) {
        console.error('[Server] Error during shutdown:', err.message);
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
