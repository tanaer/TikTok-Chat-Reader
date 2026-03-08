const db = require('../db');
const { manager } = require('../manager');

const SESSION_MAINTENANCE_DEFAULTS = Object.freeze({
    session_maintenance_resume_window_minutes: 30,
    session_maintenance_archive_delay_minutes: 30,
    session_maintenance_startup_cleanup_enabled: true,
    session_maintenance_stale_cleanup_interval_minutes: 30,
    session_maintenance_stale_gap_threshold_minutes: 60,
    session_maintenance_stale_split_age_minutes: 120,
    session_maintenance_stale_archive_all_age_minutes: 30,
    session_maintenance_startup_consolidation_enabled: true,
    session_maintenance_consolidation_interval_minutes: 60,
    session_maintenance_consolidation_lookback_hours: 48,
    session_maintenance_consolidation_gap_minutes: 60,
    session_maintenance_manual_merge_gap_minutes: 10,
    session_maintenance_log_retention_days: 30,
});

const SESSION_MAINTENANCE_SETTING_DEFS = Object.freeze([
    {
        key: 'session_maintenance_resume_window_minutes',
        label: '断线续场保留时长',
        description: '直播间断开后，在该时间窗口内重连会继续沿用同一逻辑场次。',
        type: 'number',
        min: 0,
        max: 240,
        unit: '分钟',
        section: 'continuity'
    },
    {
        key: 'session_maintenance_archive_delay_minutes',
        label: '断线延迟归档',
        description: '非手动停止时，断线后等待多久再真正创建 session 并归档。',
        type: 'number',
        min: 0,
        max: 240,
        unit: '分钟',
        section: 'continuity'
    },
    {
        key: 'session_maintenance_startup_cleanup_enabled',
        label: '启动时执行陈旧 LIVE 清理',
        description: '服务启动时，先处理遗留未归档事件，避免跨场污染。',
        type: 'boolean',
        section: 'stale'
    },
    {
        key: 'session_maintenance_stale_cleanup_interval_minutes',
        label: '陈旧 LIVE 清理间隔',
        description: '定时扫描未归档事件；填 0 表示关闭自动清理，仅保留手动执行。',
        type: 'number',
        min: 0,
        max: 1440,
        unit: '分钟',
        section: 'stale'
    },
    {
        key: 'session_maintenance_stale_gap_threshold_minutes',
        label: '大间隔切场阈值',
        description: '未归档事件中出现超过该间隔的时间断层，视为应拆分成新场次。',
        type: 'number',
        min: 1,
        max: 720,
        unit: '分钟',
        section: 'stale'
    },
    {
        key: 'session_maintenance_stale_split_age_minutes',
        label: '按历史年龄强制拆分',
        description: '最早未归档事件超过该时长且又出现近期事件时，会把旧事件强制归档。',
        type: 'number',
        min: 1,
        max: 1440,
        unit: '分钟',
        section: 'stale'
    },
    {
        key: 'session_maintenance_stale_archive_all_age_minutes',
        label: '整段陈旧事件归档阈值',
        description: '全部未归档事件都早于该时长时，整段直接归档。',
        type: 'number',
        min: 1,
        max: 1440,
        unit: '分钟',
        section: 'stale'
    },
    {
        key: 'session_maintenance_startup_consolidation_enabled',
        label: '启动时执行碎片场次合并',
        description: '服务启动后，对最近碎片化 session 做一次整理。',
        type: 'boolean',
        section: 'merge'
    },
    {
        key: 'session_maintenance_consolidation_interval_minutes',
        label: '碎片场次巡检间隔',
        description: '定时扫描最近场次做合并；填 0 表示关闭自动巡检，仅保留手动执行。',
        type: 'number',
        min: 0,
        max: 1440,
        unit: '分钟',
        section: 'merge'
    },
    {
        key: 'session_maintenance_consolidation_lookback_hours',
        label: '碎片场次扫描窗口',
        description: '自动巡检仅扫描最近多少小时内的 session。',
        type: 'number',
        min: 1,
        max: 720,
        unit: '小时',
        section: 'merge'
    },
    {
        key: 'session_maintenance_consolidation_gap_minutes',
        label: '自动合并间隔阈值',
        description: '自动巡检时，同日且间隔不超过该值的场次会自动合并。',
        type: 'number',
        min: 1,
        max: 240,
        unit: '分钟',
        section: 'merge'
    },
    {
        key: 'session_maintenance_manual_merge_gap_minutes',
        label: '手动合并间隔阈值',
        description: '后台手动执行“合并连续场次”时使用的默认阈值。',
        type: 'number',
        min: 1,
        max: 240,
        unit: '分钟',
        section: 'merge'
    },
    {
        key: 'session_maintenance_log_retention_days',
        label: '日志保留时长',
        description: '仅保留最近 N 天运维日志，避免后台记录无限增长。',
        type: 'number',
        min: 1,
        max: 365,
        unit: '天',
        section: 'logs'
    }
]);

const SESSION_MAINTENANCE_TASKS = Object.freeze({
    cleanup_stale_live_events: { label: '清理陈旧 LIVE', kind: 'maintenance' },
    archive_stale_live_events_room: { label: '归档单房间陈旧 LIVE', kind: 'maintenance' },
    merge_continuity_sessions: { label: '手动合并连续场次', kind: 'maintenance' },
    consolidate_recent_sessions: { label: '扫描并合并碎片场次', kind: 'maintenance' },
    fix_orphaned_events: { label: '修复孤儿事件', kind: 'repair' },
    delete_empty_sessions: { label: '删除空场次', kind: 'repair' },
    rebuild_missing_sessions: { label: '重建缺失场次', kind: 'repair' },
    pending_archive_scheduled: { label: '断线延迟归档已排队', kind: 'lifecycle' },
    pending_archive_cancelled: { label: '断线归档已取消', kind: 'lifecycle' },
    reconnect_resume_session: { label: '断线续场恢复', kind: 'lifecycle' },
    execute_archive_session: { label: '执行场次归档', kind: 'lifecycle' },
    preconnect_stale_archive: { label: '开播前清理遗留事件', kind: 'lifecycle' },
});

const SESSION_MAINTENANCE_ACTION_ALIASES = Object.freeze({
    'cleanup-stale-live': 'cleanup_stale_live_events',
    cleanupStaleLive: 'cleanup_stale_live_events',
    'archive-room-stale': 'archive_stale_live_events_room',
    archiveRoomStale: 'archive_stale_live_events_room',
    'merge-continuity': 'merge_continuity_sessions',
    mergeContinuity: 'merge_continuity_sessions',
    'consolidate-recent': 'consolidate_recent_sessions',
    consolidateRecent: 'consolidate_recent_sessions',
    'fix-orphaned': 'fix_orphaned_events',
    fixOrphaned: 'fix_orphaned_events',
    'delete-empty': 'delete_empty_sessions',
    deleteEmpty: 'delete_empty_sessions',
    'rebuild-missing': 'rebuild_missing_sessions',
    rebuildMissing: 'rebuild_missing_sessions',
    'disconnect-pending-archive': 'pending_archive_scheduled',
    'disconnect-resume': 'reconnect_resume_session',
    'archive-session': 'execute_archive_session',
});

const SESSION_MAINTENANCE_SETTING_KEYS = new Set(SESSION_MAINTENANCE_SETTING_DEFS.map(item => item.key));
const SETTING_TO_CONFIG_KEY = Object.freeze({
    session_maintenance_resume_window_minutes: 'resumeWindowMinutes',
    session_maintenance_archive_delay_minutes: 'archiveDelayMinutes',
    session_maintenance_startup_cleanup_enabled: 'startupCleanupEnabled',
    session_maintenance_stale_cleanup_interval_minutes: 'staleCleanupIntervalMinutes',
    session_maintenance_stale_gap_threshold_minutes: 'staleGapThresholdMinutes',
    session_maintenance_stale_split_age_minutes: 'staleSplitAgeMinutes',
    session_maintenance_stale_archive_all_age_minutes: 'staleArchiveAllAgeMinutes',
    session_maintenance_startup_consolidation_enabled: 'startupConsolidationEnabled',
    session_maintenance_consolidation_interval_minutes: 'consolidationIntervalMinutes',
    session_maintenance_consolidation_lookback_hours: 'consolidationLookbackHours',
    session_maintenance_consolidation_gap_minutes: 'consolidationGapMinutes',
    session_maintenance_manual_merge_gap_minutes: 'manualMergeGapMinutes',
    session_maintenance_log_retention_days: 'logRetentionDays',
});
const CONFIG_TO_SETTING_KEY = Object.freeze(Object.fromEntries(
    Object.entries(SETTING_TO_CONFIG_KEY).map(([settingKey, configKey]) => [configKey, settingKey])
));

function parseBoolean(value, fallback) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return fallback;
}

function parseNumber(value, fallback, { min = null, max = null, allowZero = true } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (!allowZero && parsed === 0) return fallback;
    if (min !== null && parsed < min) return fallback;
    if (max !== null && parsed > max) return fallback;
    return parsed;
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

function buildConfigPayload(settings = {}) {
    return {
        resumeWindowMinutes: parseNumber(settings.session_maintenance_resume_window_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_resume_window_minutes, { min: 0, max: 240 }),
        archiveDelayMinutes: parseNumber(settings.session_maintenance_archive_delay_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_archive_delay_minutes, { min: 0, max: 240 }),
        startupCleanupEnabled: parseBoolean(settings.session_maintenance_startup_cleanup_enabled, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_startup_cleanup_enabled),
        staleCleanupIntervalMinutes: parseNumber(settings.session_maintenance_stale_cleanup_interval_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_stale_cleanup_interval_minutes, { min: 0, max: 1440 }),
        staleGapThresholdMinutes: parseNumber(settings.session_maintenance_stale_gap_threshold_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_stale_gap_threshold_minutes, { min: 1, max: 720, allowZero: false }),
        staleSplitAgeMinutes: parseNumber(settings.session_maintenance_stale_split_age_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_stale_split_age_minutes, { min: 1, max: 1440, allowZero: false }),
        staleArchiveAllAgeMinutes: parseNumber(settings.session_maintenance_stale_archive_all_age_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_stale_archive_all_age_minutes, { min: 1, max: 1440, allowZero: false }),
        startupConsolidationEnabled: parseBoolean(settings.session_maintenance_startup_consolidation_enabled, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_startup_consolidation_enabled),
        consolidationIntervalMinutes: parseNumber(settings.session_maintenance_consolidation_interval_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_consolidation_interval_minutes, { min: 0, max: 1440 }),
        consolidationLookbackHours: parseNumber(settings.session_maintenance_consolidation_lookback_hours, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_consolidation_lookback_hours, { min: 1, max: 720, allowZero: false }),
        consolidationGapMinutes: parseNumber(settings.session_maintenance_consolidation_gap_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_consolidation_gap_minutes, { min: 1, max: 240, allowZero: false }),
        manualMergeGapMinutes: parseNumber(settings.session_maintenance_manual_merge_gap_minutes, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_manual_merge_gap_minutes, { min: 1, max: 240, allowZero: false }),
        logRetentionDays: parseNumber(settings.session_maintenance_log_retention_days, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_log_retention_days, { min: 1, max: 365, allowZero: false }),
    };
}

function readConfigInput(config, snakeKey, camelKey) {
    if (config && config[snakeKey] !== undefined) return config[snakeKey];
    if (config && camelKey && config[camelKey] !== undefined) return config[camelKey];
    return undefined;
}

function buildStoredSettings(config = {}) {
    return {
        session_maintenance_resume_window_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_resume_window_minutes', 'resumeWindowMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_resume_window_minutes, { min: 0, max: 240 })),
        session_maintenance_archive_delay_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_archive_delay_minutes', 'archiveDelayMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_archive_delay_minutes, { min: 0, max: 240 })),
        session_maintenance_startup_cleanup_enabled: String(parseBoolean(readConfigInput(config, 'session_maintenance_startup_cleanup_enabled', 'startupCleanupEnabled'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_startup_cleanup_enabled)),
        session_maintenance_stale_cleanup_interval_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_stale_cleanup_interval_minutes', 'staleCleanupIntervalMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_stale_cleanup_interval_minutes, { min: 0, max: 1440 })),
        session_maintenance_stale_gap_threshold_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_stale_gap_threshold_minutes', 'staleGapThresholdMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_stale_gap_threshold_minutes, { min: 1, max: 720, allowZero: false })),
        session_maintenance_stale_split_age_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_stale_split_age_minutes', 'staleSplitAgeMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_stale_split_age_minutes, { min: 1, max: 1440, allowZero: false })),
        session_maintenance_stale_archive_all_age_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_stale_archive_all_age_minutes', 'staleArchiveAllAgeMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_stale_archive_all_age_minutes, { min: 1, max: 1440, allowZero: false })),
        session_maintenance_startup_consolidation_enabled: String(parseBoolean(readConfigInput(config, 'session_maintenance_startup_consolidation_enabled', 'startupConsolidationEnabled'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_startup_consolidation_enabled)),
        session_maintenance_consolidation_interval_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_consolidation_interval_minutes', 'consolidationIntervalMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_consolidation_interval_minutes, { min: 0, max: 1440 })),
        session_maintenance_consolidation_lookback_hours: String(parseNumber(readConfigInput(config, 'session_maintenance_consolidation_lookback_hours', 'consolidationLookbackHours'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_consolidation_lookback_hours, { min: 1, max: 720, allowZero: false })),
        session_maintenance_consolidation_gap_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_consolidation_gap_minutes', 'consolidationGapMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_consolidation_gap_minutes, { min: 1, max: 240, allowZero: false })),
        session_maintenance_manual_merge_gap_minutes: String(parseNumber(readConfigInput(config, 'session_maintenance_manual_merge_gap_minutes', 'manualMergeGapMinutes'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_manual_merge_gap_minutes, { min: 1, max: 240, allowZero: false })),
        session_maintenance_log_retention_days: String(parseNumber(readConfigInput(config, 'session_maintenance_log_retention_days', 'logRetentionDays'), SESSION_MAINTENANCE_DEFAULTS.session_maintenance_log_retention_days, { min: 1, max: 365, allowZero: false })),
    };
}

function serializeLogRow(row) {
    const normalized = db.toCamelCase(row || {});
    return {
        id: normalized.id,
        taskKey: normalized.taskKey,
        taskLabel: SESSION_MAINTENANCE_TASKS[normalized.taskKey]?.label || normalized.taskKey,
        triggerSource: normalized.triggerSource,
        roomId: normalized.roomId || null,
        status: normalized.status,
        message: normalized.message || '',
        config: safeJsonParse(normalized.configJson, {}),
        summary: safeJsonParse(normalized.summaryJson, {}),
        errorMessage: normalized.errorMessage || '',
        startedAt: normalized.startedAt || null,
        finishedAt: normalized.finishedAt || null,
        durationMs: Number(normalized.durationMs || 0),
    };
}

async function pruneLogs(retentionDays) {
    const days = parseNumber(retentionDays, SESSION_MAINTENANCE_DEFAULTS.session_maintenance_log_retention_days, { min: 1, max: 365, allowZero: false });
    await db.pool.query(`DELETE FROM session_maintenance_log WHERE started_at < NOW() - ($1::text || ' days')::interval`, [String(days)]);
}

async function createLogEntry({ taskKey, triggerSource, roomId = null, status = 'running', message = '', config = {}, summary = {}, errorMessage = '', startedAt = new Date(), finishedAt = null, durationMs = 0 }) {
    const res = await db.pool.query(
        `INSERT INTO session_maintenance_log
            (task_key, trigger_source, room_id, status, message, config_json, summary_json, error_message, started_at, finished_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
            taskKey,
            triggerSource,
            roomId,
            status,
            message,
            JSON.stringify(config || {}),
            JSON.stringify(summary || {}),
            errorMessage || null,
            startedAt,
            finishedAt || startedAt,
            durationMs,
        ]
    );
    return Number(res.rows[0]?.id || 0);
}

async function finishLogEntry(id, { status = 'success', message = '', summary = {}, errorMessage = '', finishedAt = new Date(), durationMs = 0 }) {
    await db.pool.query(
        `UPDATE session_maintenance_log
         SET status = $2,
             message = $3,
             summary_json = $4,
             error_message = $5,
             finished_at = $6,
             duration_ms = $7
         WHERE id = $1`,
        [id, status, message, JSON.stringify(summary || {}), errorMessage || null, finishedAt, durationMs]
    );
}

function summarizeTaskResult(taskKey, result = {}, options = {}) {
    switch (taskKey) {
        case 'cleanup_stale_live_events':
            return `清理完成，归档 ${Number(result.archived || 0)} 条陈旧事件`;
        case 'archive_stale_live_events_room':
            return `房间 ${options.roomId || '-'} 归档 ${Number(result.archived || 0)} 条陈旧事件`;
        case 'merge_continuity_sessions':
            return `手动合并完成，合并 ${Number(result.mergedCount || 0)} 个碎片场次`;
        case 'consolidate_recent_sessions':
            return `巡检完成，合并 ${Number(result.mergedCount || 0)} 个碎片场次`;
        case 'fix_orphaned_events':
            return `修复 ${Number(result.eventsFixed || 0)} 条孤儿事件，补建 ${Number(result.sessionsCreated || 0)} 个场次`;
        case 'delete_empty_sessions':
            return `删除 ${Number(result.deletedCount || 0)} 个空场次`;
        case 'rebuild_missing_sessions':
            return `重建 ${Number(result.sessionsCreated || 0)} 个缺失场次，修复 ${Number(result.collisionsFixed || 0)} 个碰撞场次`;
        default:
            return SESSION_MAINTENANCE_TASKS[taskKey]?.label || taskKey;
    }
}

function buildManagerRuntimeConfig(config = {}) {
    return {
        gapThresholdMinutes: config.staleGapThresholdMinutes,
        splitOlderThanMinutes: config.staleSplitAgeMinutes,
        archiveAllOlderThanMinutes: config.staleArchiveAllAgeMinutes,
    };
}

async function getSessionMaintenanceConfig() {
    const settings = await manager.getAllSettings();
    return buildConfigPayload(settings);
}

async function saveSessionMaintenanceConfig(input = {}) {
    const existingSettings = await manager.getAllSettings();
    const normalizedInput = {};
    for (const [key, value] of Object.entries(input || {})) {
        if (SESSION_MAINTENANCE_SETTING_KEYS.has(String(key))) {
            normalizedInput[key] = value;
            continue;
        }
        const mappedSettingKey = CONFIG_TO_SETTING_KEY[String(key)];
        if (mappedSettingKey) {
            normalizedInput[mappedSettingKey] = value;
        }
    }

    const normalized = buildStoredSettings({
        ...existingSettings,
        ...normalizedInput,
    });
    for (const [key, value] of Object.entries(normalized)) {
        await manager.saveSetting(key, value);
    }
    return getSessionMaintenanceConfig();
}

async function listSessionMaintenanceLogs({ limit = 50, taskKey = '', status = '', roomId = '' } = {}) {
    const finalLimit = parseNumber(limit, 50, { min: 1, max: 200, allowZero: false });
    const clauses = [];
    const params = [];

    if (taskKey) {
        const normalizedTaskKey = SESSION_MAINTENANCE_ACTION_ALIASES[String(taskKey)] || String(taskKey);
        params.push(normalizedTaskKey);
        clauses.push(`task_key = $${params.length}`);
    }
    if (status) {
        params.push(String(status));
        clauses.push(`status = $${params.length}`);
    }
    if (roomId) {
        params.push(String(roomId));
        clauses.push(`room_id = $${params.length}`);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(finalLimit);

    const res = await db.pool.query(
        `SELECT id, task_key, trigger_source, room_id, status, message, config_json, summary_json, error_message, started_at, finished_at, duration_ms
         FROM session_maintenance_log
         ${whereSql}
         ORDER BY started_at DESC, id DESC
         LIMIT $${params.length}`,
        params
    );

    return res.rows.map(serializeLogRow);
}

async function getSessionMaintenanceOverview() {
    const config = await getSessionMaintenanceConfig();
    await pruneLogs(config.logRetentionDays);

    const latestLogs = await listSessionMaintenanceLogs({ limit: 20 });
    const statsRes = await db.pool.query(`
        SELECT
            COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '24 hours') AS total_24h,
            COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '24 hours' AND status = 'success') AS success_24h,
            COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '24 hours' AND status = 'failed') AS failed_24h,
            COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '24 hours' AND status = 'scheduled') AS scheduled_24h,
            COUNT(*) FILTER (WHERE status = 'running') AS running_count,
            COUNT(*) FILTER (WHERE room_id IS NOT NULL AND started_at >= NOW() - INTERVAL '24 hours') AS room_events_24h
        FROM session_maintenance_log
    `);

    const byTaskRes = await db.pool.query(`
        SELECT task_key,
               COUNT(*) AS total_count,
               COUNT(*) FILTER (WHERE status = 'success') AS success_count,
               COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
               MAX(started_at) AS last_run_at
        FROM session_maintenance_log
        WHERE started_at >= NOW() - INTERVAL '7 days'
        GROUP BY task_key
        ORDER BY MAX(started_at) DESC
    `);

    return {
        config,
        defaults: buildConfigPayload(SESSION_MAINTENANCE_DEFAULTS),
        settingDefs: SESSION_MAINTENANCE_SETTING_DEFS,
        taskDefs: SESSION_MAINTENANCE_TASKS,
        stats: db.toCamelCase(statsRes.rows[0] || {}),
        taskStats: byTaskRes.rows.map(row => ({
            taskKey: row.task_key,
            taskLabel: SESSION_MAINTENANCE_TASKS[row.task_key]?.label || row.task_key,
            totalCount: Number(row.total_count || 0),
            successCount: Number(row.success_count || 0),
            failedCount: Number(row.failed_count || 0),
            lastRunAt: row.last_run_at || null,
        })),
        latestLogs,
        latestRuns: latestLogs,
    };
}

async function recordSessionMaintenanceEvent({ taskKey, triggerSource, roomId = null, status = 'success', message = '', config = {}, summary = {}, errorMessage = '' }) {
    const configPayload = config && Object.keys(config).length > 0 ? config : await getSessionMaintenanceConfig();
    await pruneLogs(configPayload.logRetentionDays);
    const now = new Date();
    const id = await createLogEntry({
        taskKey,
        triggerSource,
        roomId,
        status,
        message,
        config: configPayload,
        summary,
        errorMessage,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
    });
    return { id };
}

async function runSessionMaintenanceTask(taskKey, options = {}) {
    const startedAt = new Date();
    const config = options.configOverride || await getSessionMaintenanceConfig();
    await pruneLogs(config.logRetentionDays);

    const logId = await createLogEntry({
        taskKey,
        triggerSource: options.triggerSource || 'manual',
        roomId: options.roomId || null,
        status: 'running',
        message: `开始执行 ${SESSION_MAINTENANCE_TASKS[taskKey]?.label || taskKey}`,
        config,
        summary: {},
        startedAt,
    });

    try {
        let result;
        switch (taskKey) {
            case 'cleanup_stale_live_events':
                result = await manager.cleanupAllStaleEvents(buildManagerRuntimeConfig(config));
                break;
            case 'archive_stale_live_events_room':
                if (!options.roomId) {
                    throw new Error('缺少 roomId');
                }
                result = await manager.archiveStaleLiveEvents(options.roomId, buildManagerRuntimeConfig(config));
                break;
            case 'merge_continuity_sessions': {
                const gapMinutes = parseNumber(options.gapMinutes, config.manualMergeGapMinutes, { min: 1, max: 240, allowZero: false });
                result = await manager.mergeContinuitySessions(gapMinutes);
                result.gapMinutes = gapMinutes;
                break;
            }
            case 'consolidate_recent_sessions': {
                const lookbackHours = parseNumber(options.lookbackHours, config.consolidationLookbackHours, { min: 1, max: 720, allowZero: false });
                const gapMinutes = parseNumber(options.gapMinutes, config.consolidationGapMinutes, { min: 1, max: 240, allowZero: false });
                result = await manager.consolidateRecentSessions(lookbackHours, gapMinutes);
                result.lookbackHours = lookbackHours;
                result.gapMinutes = gapMinutes;
                break;
            }
            case 'fix_orphaned_events':
                result = await manager.fixOrphanedEvents();
                break;
            case 'delete_empty_sessions':
                result = await manager.deleteEmptySessions();
                break;
            case 'rebuild_missing_sessions':
                result = await manager.rebuildMissingSessions();
                break;
            default:
                throw new Error(`未知任务: ${taskKey}`);
        }

        const finishedAt = new Date();
        await finishLogEntry(logId, {
            status: 'success',
            message: summarizeTaskResult(taskKey, result, options),
            summary: result,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
        });

        return { logId, taskKey, config, result };
    } catch (error) {
        const finishedAt = new Date();
        await finishLogEntry(logId, {
            status: 'failed',
            message: `执行失败：${SESSION_MAINTENANCE_TASKS[taskKey]?.label || taskKey}`,
            summary: { roomId: options.roomId || null },
            errorMessage: error.message,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
        });
        throw error;
    }
}

function isSessionMaintenanceSettingKey(key) {
    return SESSION_MAINTENANCE_SETTING_KEYS.has(String(key));
}

module.exports = {
    SESSION_MAINTENANCE_DEFAULTS,
    SESSION_MAINTENANCE_SETTING_DEFS,
    SESSION_MAINTENANCE_TASKS,
    buildConfigPayload,
    getSessionMaintenanceConfig,
    saveSessionMaintenanceConfig,
    listSessionMaintenanceLogs,
    getSessionMaintenanceOverview,
    runSessionMaintenanceTask,
    recordSessionMaintenanceEvent,
    isSessionMaintenanceSettingKey,
    SESSION_MAINTENANCE_ACTION_ALIASES,
};
