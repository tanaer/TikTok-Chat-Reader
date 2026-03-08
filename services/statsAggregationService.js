const db = require('../db');
const metricsService = require('./metricsService');
const { getSchemeAConfig } = require('./featureFlagService');

const DEFAULT_MINUTE_WINDOW_MINUTES = 3;
const DEFAULT_MINUTE_LAG_MINUTES = 1;
const DEFAULT_SESSION_LOOKBACK_HOURS = 72;
const DEFAULT_SESSION_INACTIVE_MINUTES = 10;
const DEFAULT_SESSION_BATCH_SIZE = 200;

function clampInteger(value, fallback, { min = null, max = null } = {}) {
    const parsed = Number.parseInt(value, 10);
    let nextValue = Number.isFinite(parsed) ? parsed : fallback;

    if (min !== null && nextValue < min) nextValue = min;
    if (max !== null && nextValue > max) nextValue = max;
    return nextValue;
}

function isIncrementalStatsEnabled() {
    return Boolean(getSchemeAConfig().event.enableIncrementalStats);
}

async function aggregateRoomMinuteStats(options = {}) {
    const minuteWindowMinutes = clampInteger(options.minuteWindowMinutes, DEFAULT_MINUTE_WINDOW_MINUTES, { min: 1, max: 180 });
    const minuteLagMinutes = clampInteger(options.minuteLagMinutes, DEFAULT_MINUTE_LAG_MINUTES, { min: 0, max: 30 });
    const startTime = Date.now();

    const result = await db.pool.query(`
        INSERT INTO room_minute_stats (
            room_id,
            stat_minute,
            chat_count,
            gift_value,
            member_count,
            like_count,
            max_viewer_count,
            gift_user_count,
            chat_user_count,
            updated_at
        )
        SELECT
            e.room_id,
            date_trunc('minute', e.timestamp) AS stat_minute,
            COUNT(*) FILTER (WHERE e.type = 'chat') AS chat_count,
            SUM(CASE WHEN e.type = 'gift' THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END) AS gift_value,
            COUNT(*) FILTER (WHERE e.type = 'member') AS member_count,
            SUM(CASE WHEN e.type = 'like' THEN COALESCE(e.like_count, 0) ELSE 0 END) AS like_count,
            GREATEST(
                MAX(CASE WHEN e.type = 'roomUser' THEN COALESCE(e.viewer_count, 0) ELSE 0 END),
                COUNT(*) FILTER (WHERE e.type = 'member')
            ) AS max_viewer_count,
            COUNT(DISTINCT CASE WHEN e.type = 'gift' THEN NULLIF(e.user_id, '') END) AS gift_user_count,
            COUNT(DISTINCT CASE WHEN e.type = 'chat' THEN NULLIF(e.user_id, '') END) AS chat_user_count,
            NOW() AS updated_at
        FROM event e
        WHERE e.timestamp >= date_trunc('minute', NOW()) - ($1 * interval '1 minute')
          AND e.timestamp < date_trunc('minute', NOW()) - ($2 * interval '1 minute')
        GROUP BY e.room_id, date_trunc('minute', e.timestamp)
        ON CONFLICT (room_id, stat_minute) DO UPDATE SET
            chat_count = EXCLUDED.chat_count,
            gift_value = EXCLUDED.gift_value,
            member_count = EXCLUDED.member_count,
            like_count = EXCLUDED.like_count,
            max_viewer_count = EXCLUDED.max_viewer_count,
            gift_user_count = EXCLUDED.gift_user_count,
            chat_user_count = EXCLUDED.chat_user_count,
            updated_at = NOW()
    `, [minuteWindowMinutes, minuteLagMinutes]);

    const durationMs = Date.now() - startTime;
    metricsService.recordTiming('stats.incremental.room_minute.duration_ms', durationMs, {
        status: 'success',
        minuteWindowMinutes,
        minuteLagMinutes,
    }, { log: false });

    return {
        updatedRows: result.rowCount || 0,
        minuteWindowMinutes,
        minuteLagMinutes,
        durationMs,
    };
}

async function aggregateSessionSummaries(options = {}) {
    const sessionLookbackHours = clampInteger(options.sessionLookbackHours, DEFAULT_SESSION_LOOKBACK_HOURS, { min: 1, max: 24 * 30 });
    const sessionInactiveMinutes = clampInteger(options.sessionInactiveMinutes, DEFAULT_SESSION_INACTIVE_MINUTES, { min: 1, max: 24 * 60 });
    const sessionBatchSize = clampInteger(options.sessionBatchSize, DEFAULT_SESSION_BATCH_SIZE, { min: 1, max: 2000 });
    const startTime = Date.now();

    const result = await db.pool.query(`
        WITH candidate_sessions AS (
            SELECT
                e.session_id,
                MAX(e.timestamp) AS last_event_at
            FROM event e
            WHERE e.session_id IS NOT NULL
              AND e.session_id != ''
              AND e.timestamp >= NOW() - ($1 * interval '1 hour')
            GROUP BY e.session_id
            HAVING MAX(e.timestamp) < NOW() - ($2 * interval '1 minute')
            ORDER BY MAX(e.timestamp) DESC
            LIMIT $3
        ),
        session_metrics AS (
            SELECT
                e.session_id,
                MAX(e.room_id) AS room_id,
                MIN(e.timestamp) AS start_time,
                MAX(e.timestamp) AS end_time,
                COUNT(*) FILTER (WHERE e.type = 'chat') AS chat_count,
                SUM(CASE WHEN e.type = 'gift' THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END) AS gift_value,
                COUNT(*) FILTER (WHERE e.type = 'member') AS member_count,
                GREATEST(
                    MAX(CASE WHEN e.type = 'roomUser' THEN COALESCE(e.viewer_count, 0) ELSE 0 END),
                    COUNT(*) FILTER (WHERE e.type = 'member')
                ) AS max_viewer_count
            FROM event e
            INNER JOIN candidate_sessions cs ON cs.session_id = e.session_id
            GROUP BY e.session_id
        ),
        top_gifters AS (
            SELECT DISTINCT ON (e.session_id)
                e.session_id,
                NULLIF(e.user_id, '') AS top_gifter_user_id,
                SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) AS top_gifter_value
            FROM event e
            INNER JOIN candidate_sessions cs ON cs.session_id = e.session_id
            WHERE e.type = 'gift'
            GROUP BY e.session_id, NULLIF(e.user_id, '')
            ORDER BY e.session_id, SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) DESC, NULLIF(e.user_id, '') ASC
        )
        INSERT INTO session_summary (
            session_id,
            room_id,
            start_time,
            end_time,
            duration_secs,
            chat_count,
            gift_value,
            member_count,
            max_viewer_count,
            top_gifter_user_id,
            top_gifter_value,
            updated_at
        )
        SELECT
            sm.session_id,
            sm.room_id,
            sm.start_time,
            sm.end_time,
            GREATEST(EXTRACT(EPOCH FROM (sm.end_time - sm.start_time))::INTEGER, 0) AS duration_secs,
            COALESCE(sm.chat_count, 0) AS chat_count,
            COALESCE(sm.gift_value, 0) AS gift_value,
            COALESCE(sm.member_count, 0) AS member_count,
            COALESCE(sm.max_viewer_count, 0) AS max_viewer_count,
            tg.top_gifter_user_id,
            COALESCE(tg.top_gifter_value, 0) AS top_gifter_value,
            NOW() AS updated_at
        FROM session_metrics sm
        LEFT JOIN top_gifters tg ON tg.session_id = sm.session_id
        ON CONFLICT (session_id) DO UPDATE SET
            room_id = EXCLUDED.room_id,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            duration_secs = EXCLUDED.duration_secs,
            chat_count = EXCLUDED.chat_count,
            gift_value = EXCLUDED.gift_value,
            member_count = EXCLUDED.member_count,
            max_viewer_count = EXCLUDED.max_viewer_count,
            top_gifter_user_id = EXCLUDED.top_gifter_user_id,
            top_gifter_value = EXCLUDED.top_gifter_value,
            updated_at = NOW()
    `, [sessionLookbackHours, sessionInactiveMinutes, sessionBatchSize]);

    const durationMs = Date.now() - startTime;
    metricsService.recordTiming('stats.incremental.session_summary.duration_ms', durationMs, {
        status: 'success',
        sessionLookbackHours,
        sessionInactiveMinutes,
        sessionBatchSize,
    }, { log: false });

    return {
        updatedRows: result.rowCount || 0,
        sessionLookbackHours,
        sessionInactiveMinutes,
        sessionBatchSize,
        durationMs,
    };
}

async function runIncrementalStatsCycle(trigger = 'manual', options = {}) {
    await db.initDb();

    if (!isIncrementalStatsEnabled()) {
        metricsService.emitLog('info', 'stats.incremental', {
            trigger,
            status: 'skipped',
            reason: 'feature_flag_off',
        });
        return {
            skipped: true,
            reason: 'feature_flag_off',
        };
    }

    const startTime = Date.now();
    const minuteResult = await aggregateRoomMinuteStats(options);
    const sessionResult = await aggregateSessionSummaries(options);
    const durationMs = Date.now() - startTime;

    metricsService.emitLog('info', 'stats.incremental', {
        trigger,
        status: 'success',
        durationMs,
        roomMinuteRows: minuteResult.updatedRows,
        sessionSummaryRows: sessionResult.updatedRows,
    });

    return {
        trigger,
        durationMs,
        roomMinute: minuteResult,
        sessionSummary: sessionResult,
    };
}

module.exports = {
    DEFAULT_MINUTE_WINDOW_MINUTES,
    DEFAULT_MINUTE_LAG_MINUTES,
    DEFAULT_SESSION_LOOKBACK_HOURS,
    DEFAULT_SESSION_INACTIVE_MINUTES,
    DEFAULT_SESSION_BATCH_SIZE,
    isIncrementalStatsEnabled,
    aggregateRoomMinuteStats,
    aggregateSessionSummaries,
    runIncrementalStatsCycle,
};
