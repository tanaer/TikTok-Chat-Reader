/**
 * Database module - PostgreSQL
 * Production-grade database with connection pooling
 */
const { Pool } = require('pg');
const path = require('path');

// PostgreSQL connection configuration
const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root',
    max: process.env.PG_MAX_CONNECTIONS || 20, // Maximum connections in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

let isInitialized = false;

/**
 * Initialize the database - create tables if needed
 */
async function initDb() {
    if (isInitialized) return;

    try {
        // Test connection
        const client = await pool.connect();
        console.log('[DB] Connected to PostgreSQL.');
        client.release();

        // Create tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS room (
                id SERIAL PRIMARY KEY,
                room_id TEXT UNIQUE NOT NULL,
                numeric_room_id TEXT,
                name TEXT,
                address TEXT,
                language TEXT DEFAULT '中文',
                updated_at TIMESTAMP DEFAULT NOW(),
                is_monitor_enabled INTEGER DEFAULT 1
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS session (
                id SERIAL PRIMARY KEY,
                session_id TEXT UNIQUE NOT NULL,
                room_id TEXT NOT NULL,
                snapshot_json TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS event (
                id SERIAL PRIMARY KEY,
                room_id TEXT NOT NULL,
                session_id TEXT,
                type TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT NOW(),
                user_id TEXT,
                unique_id TEXT,
                nickname TEXT,
                gift_id INTEGER,
                gift_name TEXT,
                gift_image TEXT,
                group_id TEXT,
                diamond_count INTEGER DEFAULT 0,
                repeat_count INTEGER DEFAULT 1,
                like_count INTEGER DEFAULT 0,
                total_like_count INTEGER DEFAULT 0,
                comment TEXT,
                viewer_count INTEGER,
                region TEXT,
                is_admin INTEGER DEFAULT 0,
                is_super_admin INTEGER DEFAULT 0,
                is_moderator INTEGER DEFAULT 0,
                fan_level INTEGER DEFAULT 0,
                fan_club_name TEXT,
                data_json TEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS "user" (
                user_id TEXT PRIMARY KEY,
                unique_id TEXT,
                nickname TEXT,
                avatar TEXT,
                updated_at TIMESTAMP DEFAULT NOW(),
                common_language TEXT,
                mastered_languages TEXT,
                ai_analysis TEXT,
                ai_analysis_json TEXT,
                ai_analysis_prompt_key TEXT,
                ai_analysis_prompt_updated_at TIMESTAMP,
                ai_analysis_context_version TEXT,
                ai_analysis_model_version TEXT,
                ai_analysis_current_room_id TEXT,
                is_moderator INTEGER DEFAULT 0,
                region TEXT
            )
        `);

        // Settings table for application configuration
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);


        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_role (
                id SERIAL PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                permissions_json TEXT NOT NULL DEFAULT '[]',
                is_system BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_admin_role (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                role_id INTEGER NOT NULL REFERENCES admin_role(id) ON DELETE RESTRICT,
                assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                assigned_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_admin_role_role_id ON user_admin_role(role_id)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS session_maintenance_log (
                id SERIAL PRIMARY KEY,
                task_key TEXT NOT NULL,
                trigger_source TEXT NOT NULL,
                room_id TEXT,
                status TEXT NOT NULL DEFAULT 'success',
                message TEXT,
                config_json TEXT,
                summary_json TEXT,
                error_message TEXT,
                started_at TIMESTAMP DEFAULT NOW(),
                finished_at TIMESTAMP DEFAULT NOW(),
                duration_ms INTEGER DEFAULT 0
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_maintenance_log_started_at ON session_maintenance_log(started_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_maintenance_log_task_status ON session_maintenance_log(task_key, status)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_maintenance_log_room_id ON session_maintenance_log(room_id)`);

        // Gift table for storing gift info with Chinese names
        await pool.query(`
            CREATE TABLE IF NOT EXISTS gift (
                gift_id TEXT PRIMARY KEY,
                name_en TEXT,
                name_cn TEXT,
                icon_url TEXT,
                diamond_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Create indexes for better performance
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_room ON event(room_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_session ON event(session_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_type ON event(type)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_timestamp ON event(timestamp)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_user ON event(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_room ON session(room_id)`);

        // Composite indexes for common query patterns (major performance boost)
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_room_session ON event(room_id, session_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_room_session_type ON event(room_id, session_id, type)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_session_timestamp ON event(session_id, timestamp)`);

        // Performance optimization: indexes for aggregation queries
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_type_session ON event(type, session_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_type_room ON event(type, room_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_gift_agg ON event(room_id, type, user_id) WHERE type = 'gift'`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_room_created ON session(room_id, created_at DESC)`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS gift_name TEXT`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS gift_image TEXT`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS group_id TEXT`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS region TEXT`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS is_admin INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS is_super_admin INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS is_moderator INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS fan_level INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE event ADD COLUMN IF NOT EXISTS fan_club_name TEXT`);

        // Performance optimization: partial index for orphaned events (session_id IS NULL)
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_room_null_session ON event(room_id, timestamp) WHERE session_id IS NULL`);
        // Composite partial index for getRoomStats currentStats query (room_id + type filter on untagged events)
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_room_null_session_type ON event(room_id, type) WHERE session_id IS NULL`);
        // Performance optimization: index for MAX(timestamp) aggregation in getSessions
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_session_timestamp_desc ON event(session_id, timestamp DESC)`);

        // Performance optimization: functional index for activeHour filtering in getTopGifters
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_timestamp_hour ON event(EXTRACT(HOUR FROM timestamp))`);

        // Migrations for new columns
        await pool.query(`ALTER TABLE room ADD COLUMN IF NOT EXISTS language TEXT DEFAULT '中文'`);
        await pool.query(`ALTER TABLE room ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE room ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
        await pool.query(`ALTER TABLE room ADD COLUMN IF NOT EXISTS is_admin_room INTEGER DEFAULT 0`);
        await pool.query(`UPDATE room SET is_admin_room = 1, updated_at = NOW() WHERE COALESCE(is_admin_room, 0) = 0 AND owner_user_id IS NULL`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS language_analyzed INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ai_analysis TEXT`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS region TEXT`);
        await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);

        // Room statistics cache table (pre-aggregated for performance)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_stats (
                room_id TEXT PRIMARY KEY REFERENCES room(room_id) ON DELETE CASCADE,
                all_time_gift_value BIGINT DEFAULT 0,
                all_time_visit_count INTEGER DEFAULT 0,
                all_time_chat_count INTEGER DEFAULT 0,
                valid_daily_avg INTEGER DEFAULT 0,
                valid_days INTEGER DEFAULT 0,
                top1_ratio INTEGER DEFAULT 0,
                top3_ratio INTEGER DEFAULT 0,
                top10_ratio INTEGER DEFAULT 0,
                top30_ratio INTEGER DEFAULT 0,
                gift_efficiency NUMERIC(10,2) DEFAULT 0,
                interact_efficiency NUMERIC(10,2) DEFAULT 0,
                account_quality NUMERIC(10,2) DEFAULT 0,
                monthly_gift_value BIGINT DEFAULT 0,
                last_session_time TIMESTAMP,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Migration: Add new columns if they don't exist
        await pool.query(`ALTER TABLE room_stats ADD COLUMN IF NOT EXISTS monthly_gift_value BIGINT DEFAULT 0`);
        await pool.query(`ALTER TABLE room_stats ADD COLUMN IF NOT EXISTS last_session_time TIMESTAMP`);
        // Indexes for fast sorting on pre-aggregated columns
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_room_stats_daily_avg ON room_stats(valid_daily_avg DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_room_stats_gift ON room_stats(all_time_gift_value DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_room_stats_top10 ON room_stats(top10_ratio)`);

        // User statistics cache table (pre-aggregated for performance)
        // This dramatically improves /api/analysis/users performance
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_stats (
                user_id TEXT PRIMARY KEY REFERENCES "user"(user_id) ON DELETE CASCADE,
                total_gift_value BIGINT DEFAULT 0,
                room_count INTEGER DEFAULT 0,
                chat_count INTEGER DEFAULT 0,
                rose_value BIGINT DEFAULT 0,
                tiktok_value BIGINT DEFAULT 0,
                rose_count INTEGER DEFAULT 0,
                tiktok_count INTEGER DEFAULT 0,
                top_room_id TEXT,
                top_room_value BIGINT DEFAULT 0,
                last_active TIMESTAMP,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Indexes for fast sorting on user_stats columns
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_stats_gift ON user_stats(total_gift_value DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_stats_room_count ON user_stats(room_count)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_stats_last_active ON user_stats(last_active DESC)`);

        // Global statistics cache table (pre-aggregated for /api/analysis/stats performance)
        // Stores hourly and daily aggregations to avoid expensive 4-query JOINs on event table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS global_stats (
                id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                hour_stats_json TEXT,
                day_stats_json TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Insert default row if not exists
        await pool.query(`
            INSERT INTO global_stats (id, hour_stats_json, day_stats_json)
            VALUES (1, '{}', '{}')
            ON CONFLICT (id) DO NOTHING
        `);


        // Proxy subscription management tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS proxy_node_group (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS proxy_node (
                id SERIAL PRIMARY KEY,
                group_id INTEGER REFERENCES proxy_node_group(id) ON DELETE CASCADE,
                name TEXT,
                type TEXT,
                server TEXT,
                port INTEGER,
                config_json TEXT,
                proxy_url TEXT,
                euler_status TEXT DEFAULT 'unknown',
                tiktok_status TEXT DEFAULT 'unknown',
                last_euler_test TIMESTAMP,
                last_tiktok_test TIMESTAMP,
                euler_latency INTEGER DEFAULT -1,
                tiktok_latency INTEGER DEFAULT -1,
                success_count INTEGER DEFAULT 0,
                fail_count INTEGER DEFAULT 0,
                last_used TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Index for fast node lookup by status
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxy_node_status ON proxy_node(euler_status, tiktok_status)`);

        // TikTok Account table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tiktok_account (
                id SERIAL PRIMARY KEY,
                username TEXT,
                cookie TEXT,
                proxy_id INTEGER,
                is_active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // SOCKS5 Proxy table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS socks5_proxy (
                id SERIAL PRIMARY KEY,
                name TEXT,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT,
                password TEXT,
                is_active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Recording Task table (for history/active tracking)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS recording_task (
                id SERIAL PRIMARY KEY,
                room_id TEXT NOT NULL,
                account_id INTEGER,
                start_time TIMESTAMP DEFAULT NOW(),
                end_time TIMESTAMP,
                file_path TEXT,
                file_size BIGINT,
                status TEXT, -- 'recording', 'completed', 'failed'
                error_msg TEXT,
                storage_provider TEXT,
                storage_bucket TEXT,
                storage_object_key TEXT,
                storage_etag TEXT,
                storage_metadata_json TEXT,
                upload_status TEXT DEFAULT 'not_requested',
                upload_attempt_count INTEGER DEFAULT 0,
                upload_started_at TIMESTAMP,
                upload_completed_at TIMESTAMP,
                upload_error_msg TEXT,
                cleanup_status TEXT DEFAULT 'not_requested',
                cleanup_attempt_count INTEGER DEFAULT 0,
                cleanup_started_at TIMESTAMP,
                cleanup_completed_at TIMESTAMP,
                cleanup_error_msg TEXT,
                local_file_deleted_at TIMESTAMP
            )
        `);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS storage_provider TEXT`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS storage_bucket TEXT`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS storage_object_key TEXT`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS storage_etag TEXT`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS storage_metadata_json TEXT`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS upload_status TEXT DEFAULT 'not_requested'`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS upload_attempt_count INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS upload_started_at TIMESTAMP`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS upload_completed_at TIMESTAMP`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS upload_error_msg TEXT`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS cleanup_status TEXT DEFAULT 'not_requested'`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS cleanup_attempt_count INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS cleanup_started_at TIMESTAMP`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS cleanup_completed_at TIMESTAMP`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS cleanup_error_msg TEXT`);
        await pool.query(`ALTER TABLE recording_task ADD COLUMN IF NOT EXISTS local_file_deleted_at TIMESTAMP`);
        await pool.query(`UPDATE recording_task SET upload_status = 'not_requested' WHERE upload_status IS NULL`);
        await pool.query(`UPDATE recording_task SET cleanup_status = 'not_requested' WHERE cleanup_status IS NULL`);
        await pool.query(`UPDATE recording_task SET upload_attempt_count = 0 WHERE upload_attempt_count IS NULL`);
        await pool.query(`UPDATE recording_task SET cleanup_attempt_count = 0 WHERE cleanup_attempt_count IS NULL`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_task_upload_status ON recording_task(upload_status, start_time DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_recording_task_cleanup_status ON recording_task(cleanup_status, start_time DESC)`);

        // Highlight Clip table (for extracted video clips from recordings)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS highlight_clip (
                id SERIAL PRIMARY KEY,
                recording_task_id INTEGER REFERENCES recording_task(id) ON DELETE CASCADE,
                room_id TEXT NOT NULL,
                start_offset_sec REAL,
                end_offset_sec REAL,
                gift_events_json TEXT,
                total_diamond_value INTEGER,
                file_path TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_minute_stats (
                room_id TEXT NOT NULL,
                stat_minute TIMESTAMP NOT NULL,
                chat_count INTEGER DEFAULT 0,
                gift_value BIGINT DEFAULT 0,
                member_count INTEGER DEFAULT 0,
                like_count BIGINT DEFAULT 0,
                max_viewer_count INTEGER DEFAULT 0,
                gift_user_count INTEGER DEFAULT 0,
                chat_user_count INTEGER DEFAULT 0,
                updated_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (room_id, stat_minute)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_room_minute_stats_stat_minute ON room_minute_stats(stat_minute DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_room_minute_stats_room_minute ON room_minute_stats(room_id, stat_minute DESC)`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS session_summary (
                session_id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                start_time TIMESTAMP,
                end_time TIMESTAMP,
                duration_secs INTEGER DEFAULT 0,
                chat_count INTEGER DEFAULT 0,
                gift_value BIGINT DEFAULT 0,
                member_count INTEGER DEFAULT 0,
                max_viewer_count INTEGER DEFAULT 0,
                top_gifter_user_id TEXT,
                top_gifter_value BIGINT DEFAULT 0,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_summary_room_end_time ON session_summary(room_id, end_time DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_summary_end_time ON session_summary(end_time DESC)`);

        // Add recording fields to room table
        await pool.query(`ALTER TABLE room ADD COLUMN IF NOT EXISTS is_recording_enabled INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE room ADD COLUMN IF NOT EXISTS recording_account_id INTEGER`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_room_updated_at ON room(updated_at DESC)`);


        // ========== SaaS Tables (use existing production tables: users, subscription_plans, etc.) ==========
        // No CREATE TABLE here - production tables already exist.
        // Run migrate_saas.js to add any missing columns on production.

        // Migration: make users.email nullable (business requirement: email is optional)
        await pool.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`).catch(() => {});

        // Migration: user_room副本机制 - 软删除 + 数据起始时间
        await pool.query(`ALTER TABLE user_room ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
        await pool.query(`ALTER TABLE user_room ADD COLUMN IF NOT EXISTS first_added_at TIMESTAMP DEFAULT NOW()`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_room_user_active_room ON user_room(user_id, room_id) WHERE deleted_at IS NULL`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_room_user_active_first_added ON user_room(user_id, first_added_at) WHERE deleted_at IS NULL`);

        // Migration: 套餐每日新建房间次数限制
        await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS daily_room_create_limit INTEGER DEFAULT -1`);

        // Per-user quota overrides for admin adjustments
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_quota_overrides (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                room_limit_permanent INTEGER,
                room_limit_temporary INTEGER,
                room_limit_temporary_expires_at TIMESTAMP,
                daily_room_create_limit_permanent INTEGER,
                daily_room_create_limit_temporary INTEGER,
                daily_room_create_limit_temporary_expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`ALTER TABLE user_quota_overrides ADD COLUMN IF NOT EXISTS daily_room_create_limit_permanent INTEGER`);
        await pool.query(`ALTER TABLE user_quota_overrides ADD COLUMN IF NOT EXISTS daily_room_create_limit_temporary INTEGER`);
        await pool.query(`ALTER TABLE user_quota_overrides ADD COLUMN IF NOT EXISTS daily_room_create_limit_temporary_expires_at TIMESTAMP`);

        // Refresh tokens for auth sessions
        await pool.query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                session_version INTEGER NOT NULL DEFAULT 0,
                expires_at TIMESTAMP NOT NULL,
                revoked BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_version INTEGER DEFAULT 0`);
        await pool.query(`UPDATE refresh_tokens SET session_version = 0 WHERE session_version IS NULL`).catch(() => {});
        await pool.query(`ALTER TABLE refresh_tokens ALTER COLUMN session_version SET DEFAULT 0`).catch(() => {});
        await pool.query(`ALTER TABLE refresh_tokens ALTER COLUMN session_version SET NOT NULL`).catch(() => {});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active ON refresh_tokens(user_id, revoked, expires_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_session_active ON refresh_tokens(user_id, session_version) WHERE revoked = FALSE`);

        // Session version supports global single-login enforcement
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER DEFAULT 0`);
        await pool.query(`UPDATE users SET session_version = 0 WHERE session_version IS NULL`).catch(() => {});
        await pool.query(`ALTER TABLE users ALTER COLUMN session_version SET DEFAULT 0`).catch(() => {});
        await pool.query(`ALTER TABLE users ALTER COLUMN session_version SET NOT NULL`).catch(() => {});

        // In-app user notifications
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_notifications (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type TEXT NOT NULL DEFAULT 'system',
                level TEXT NOT NULL DEFAULT 'info',
                title TEXT NOT NULL,
                content TEXT DEFAULT '',
                related_order_no TEXT DEFAULT '',
                action_tab TEXT DEFAULT 'notifications',
                action_url TEXT DEFAULT '',
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                read_at TIMESTAMP
            )
        `);
        await pool.query(`ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS action_url TEXT DEFAULT ''`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created ON user_notifications(user_id, created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread ON user_notifications(user_id, is_read, created_at DESC)`);

        // AI async work center tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_work_job (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                job_type TEXT NOT NULL,
                room_id TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'queued',
                current_step TEXT DEFAULT '',
                progress_percent INTEGER DEFAULT 0,
                point_cost INTEGER DEFAULT 0,
                charged_points INTEGER DEFAULT 0,
                force_regenerate BOOLEAN DEFAULT FALSE,
                is_admin BOOLEAN DEFAULT FALSE,
                attempt_count INTEGER DEFAULT 0,
                model_name TEXT DEFAULT '',
                request_payload_json TEXT,
                result_json TEXT,
                error_message TEXT DEFAULT '',
                notification_sent BOOLEAN DEFAULT FALSE,
                queued_at TIMESTAMP DEFAULT NOW(),
                started_at TIMESTAMP,
                finished_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_work_job_log (
                id SERIAL PRIMARY KEY,
                job_id INTEGER NOT NULL REFERENCES ai_work_job(id) ON DELETE CASCADE,
                phase TEXT DEFAULT '',
                level TEXT DEFAULT 'info',
                message TEXT NOT NULL,
                payload_json TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS room_id TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS title TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued'`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS current_step TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS progress_percent INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS point_cost INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS charged_points INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS force_regenerate BOOLEAN DEFAULT FALSE`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS model_name TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS request_payload_json TEXT`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS result_json TEXT`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS error_message TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS notification_sent BOOLEAN DEFAULT FALSE`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS queued_at TIMESTAMP DEFAULT NOW()`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
        await pool.query(`ALTER TABLE ai_work_job ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
        await pool.query(`ALTER TABLE ai_work_job_log ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE ai_work_job_log ADD COLUMN IF NOT EXISTS level TEXT DEFAULT 'info'`);
        await pool.query(`ALTER TABLE ai_work_job_log ADD COLUMN IF NOT EXISTS payload_json TEXT`);
        await pool.query(`ALTER TABLE ai_work_job_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_work_job_user_created ON ai_work_job(user_id, created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_work_job_status_created ON ai_work_job(status, created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_work_job_user_room_session ON ai_work_job(user_id, room_id, session_id, created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_work_job_log_job_created ON ai_work_job_log(job_id, created_at ASC)`);

        // Admin async job queue tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_async_job (
                id SERIAL PRIMARY KEY,
                queue_name TEXT NOT NULL,
                job_type TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                dedupe_key TEXT NOT NULL DEFAULT '',
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                current_step TEXT DEFAULT '',
                progress_percent INTEGER DEFAULT 0,
                attempt_count INTEGER DEFAULT 0,
                request_payload_json TEXT,
                result_json TEXT,
                error_message TEXT DEFAULT '',
                source TEXT NOT NULL DEFAULT 'manual',
                queued_at TIMESTAMP DEFAULT NOW(),
                started_at TIMESTAMP,
                finished_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS queue_name TEXT DEFAULT 'maintenance'`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS title TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS dedupe_key TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued'`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS current_step TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS progress_percent INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS request_payload_json TEXT`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS result_json TEXT`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS error_message TEXT DEFAULT ''`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS queued_at TIMESTAMP DEFAULT NOW()`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
        await pool.query(`ALTER TABLE admin_async_job ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_async_job_queue_status_created ON admin_async_job(queue_name, status, queued_at ASC, id ASC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_async_job_dedupe_status_created ON admin_async_job(dedupe_key, status, created_at DESC)`);

        // Email verification codes table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS email_verification (
                email TEXT NOT NULL,
                purpose TEXT NOT NULL DEFAULT 'register',
                code TEXT NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                attempts INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (email, purpose)
            )
        `);
        await pool.query(`ALTER TABLE email_verification ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT 'register'`);
        await pool.query(`UPDATE email_verification SET purpose = 'register' WHERE purpose IS NULL`).catch(() => {});
        await pool.query(`ALTER TABLE email_verification ALTER COLUMN purpose SET DEFAULT 'register'`).catch(() => {});
        await pool.query(`ALTER TABLE email_verification ALTER COLUMN purpose SET NOT NULL`).catch(() => {});
        await pool.query(`ALTER TABLE email_verification DROP CONSTRAINT IF EXISTS email_verification_pkey`).catch(() => {});
        await pool.query(`ALTER TABLE email_verification ADD CONSTRAINT email_verification_pkey PRIMARY KEY (email, purpose)`).catch(() => {});

        // Euler API Keys management table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS euler_api_keys (
                id SERIAL PRIMARY KEY,
                key_value TEXT NOT NULL,
                name TEXT DEFAULT '',
                is_active BOOLEAN DEFAULT true,
                call_count INTEGER DEFAULT 0,
                last_used_at TIMESTAMP,
                last_error TEXT,
                last_status TEXT DEFAULT 'unknown',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`ALTER TABLE euler_api_keys ADD COLUMN IF NOT EXISTS premium_room_lookup_level TEXT DEFAULT 'basic'`);
        await pool.query(`UPDATE euler_api_keys SET premium_room_lookup_level = 'basic' WHERE premium_room_lookup_level IS NULL OR TRIM(premium_room_lookup_level) = ''`).catch(() => {});
        await pool.query(`ALTER TABLE euler_api_keys ADD COLUMN IF NOT EXISTS premium_room_lookup_state TEXT DEFAULT 'unknown'`);
        await pool.query(`ALTER TABLE euler_api_keys ADD COLUMN IF NOT EXISTS premium_room_lookup_checked_at TIMESTAMP`);
        await pool.query(`ALTER TABLE euler_api_keys ADD COLUMN IF NOT EXISTS premium_room_lookup_last_status INTEGER`);
        await pool.query(`ALTER TABLE euler_api_keys ADD COLUMN IF NOT EXISTS premium_room_lookup_last_error TEXT`);
        await pool.query(`ALTER TABLE euler_api_keys ADD COLUMN IF NOT EXISTS premium_room_lookup_probe_unique_id TEXT`);
        await pool.query(`
            UPDATE euler_api_keys
               SET premium_room_lookup_checked_at = NULL,
                   premium_room_lookup_last_status = NULL,
                   premium_room_lookup_last_error = NULL,
                   premium_room_lookup_probe_unique_id = NULL,
                   premium_room_lookup_state = CASE
                       WHEN COALESCE(premium_room_lookup_level, 'basic') = 'premium' THEN 'enabled'
                       WHEN COALESCE(premium_room_lookup_level, 'basic') = 'basic' THEN 'disabled'
                       ELSE 'unknown'
                   END,
                   updated_at = NOW()
             WHERE COALESCE(premium_room_lookup_level, 'basic') <> 'premium'
        `).catch(() => {});
        await pool.query(`
            UPDATE euler_api_keys
               SET last_error = NULL,
                   last_status = CASE WHEN COALESCE(last_status, 'unknown') = 'error' THEN 'ok' ELSE last_status END,
                   updated_at = NOW()
             WHERE COALESCE(premium_room_lookup_level, 'basic') <> 'premium'
               AND (
                    LOWER(COALESCE(last_error, '')) LIKE '%euler room lookup%'
                 OR LOWER(COALESCE(last_error, '')) LIKE '%euler live status lookup%'
                 OR LOWER(COALESCE(last_error, '')) LIKE '%premium room lookup%'
               )
        `).catch(() => {});

        await pool.query(`
            CREATE TABLE IF NOT EXISTS smtp_services (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER DEFAULT 465,
                secure BOOLEAN DEFAULT true,
                username TEXT NOT NULL,
                password TEXT NOT NULL,
                from_email TEXT,
                from_name TEXT,
                is_active BOOLEAN DEFAULT true,
                is_default BOOLEAN DEFAULT false,
                call_count INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,
                fail_count INTEGER DEFAULT 0,
                consecutive_failures INTEGER DEFAULT 0,
                avg_latency_ms INTEGER DEFAULT 0,
                last_used_at TIMESTAMP,
                cooldown_until TIMESTAMP,
                last_error TEXT,
                last_status TEXT DEFAULT 'unknown',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_smtp_services_single_default ON smtp_services (is_default) WHERE is_default = true`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_smtp_services_active_default ON smtp_services (is_active, is_default, id)`);

        // AI channels table (provider-level: api_url + api_key)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_channels (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                api_url TEXT NOT NULL,
                api_key TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // AI models table (belongs to a channel)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_models (
                id SERIAL PRIMARY KEY,
                channel_id INTEGER REFERENCES ai_channels(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                model_id TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                is_default BOOLEAN DEFAULT false,
                call_count INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,
                fail_count INTEGER DEFAULT 0,
                consecutive_failures INTEGER DEFAULT 0,
                avg_latency_ms INTEGER DEFAULT 0,
                last_used_at TIMESTAMP,
                cooldown_until TIMESTAMP,
                last_error TEXT,
                last_status TEXT DEFAULT 'unknown',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Migration: add channel_id if ai_models existed from previous version (had api_url/api_key inline)
        try {
            await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES ai_channels(id) ON DELETE CASCADE`);
            await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false`);
            await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0`);
            await pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMP`);
            // Make old columns nullable since they're now on ai_channels
            await pool.query(`ALTER TABLE ai_models ALTER COLUMN api_url DROP NOT NULL`).catch(() => {});
            await pool.query(`ALTER TABLE ai_models ALTER COLUMN api_key DROP NOT NULL`).catch(() => {});

            const hasOldData = await pool.query(`SELECT id FROM ai_models WHERE api_url IS NOT NULL AND channel_id IS NULL LIMIT 1`);
            if (hasOldData.rows.length > 0) {
                // Migrate: move api_url/api_key from ai_models to ai_channels
                const oldModels = await pool.query(`SELECT DISTINCT api_url, api_key FROM ai_models WHERE api_url IS NOT NULL AND channel_id IS NULL`);
                for (const row of oldModels.rows) {
                    const chRes = await pool.query(
                        `INSERT INTO ai_channels (name, api_url, api_key) VALUES ($1, $2, $3) RETURNING id`,
                        ['迁移通道', row.api_url, row.api_key]
                    );
                    await pool.query(`UPDATE ai_models SET channel_id = $1 WHERE api_url = $2 AND api_key = $3`, [chRes.rows[0].id, row.api_url, row.api_key]);
                }
            }
        } catch (e) { /* ignore migration errors */ }

        // AI credit packages table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_credit_packages (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                credits INTEGER NOT NULL,
                price_cents INTEGER NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // AI usage log table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ai_usage_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                usage_type VARCHAR(50),
                credits_used INTEGER DEFAULT 1,
                target_id TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Member AI analysis results table (independent per member, billable)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_ai_analysis (
                id SERIAL PRIMARY KEY,
                member_id INTEGER NOT NULL,
                target_user_id TEXT NOT NULL,
                result TEXT NOT NULL,
                result_json TEXT,
                chat_count INTEGER DEFAULT 0,
                model_name TEXT,
                model_version TEXT,
                prompt_key TEXT,
                prompt_updated_at TIMESTAMP,
                context_version TEXT,
                current_room_id TEXT,
                source_job_id INTEGER,
                latency_ms INTEGER DEFAULT 0,
                source TEXT DEFAULT 'api',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_ai_analysis_member ON user_ai_analysis(member_id, target_user_id)`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ai_analysis_json TEXT`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ai_analysis_prompt_key TEXT`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ai_analysis_prompt_updated_at TIMESTAMP`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ai_analysis_context_version TEXT`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ai_analysis_model_version TEXT`);
        await pool.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ai_analysis_current_room_id TEXT`);
        await pool.query(`ALTER TABLE user_ai_analysis ADD COLUMN IF NOT EXISTS result_json TEXT`);
        await pool.query(`ALTER TABLE user_ai_analysis ADD COLUMN IF NOT EXISTS model_version TEXT`);
        await pool.query(`ALTER TABLE user_ai_analysis ADD COLUMN IF NOT EXISTS prompt_key TEXT`);
        await pool.query(`ALTER TABLE user_ai_analysis ADD COLUMN IF NOT EXISTS prompt_updated_at TIMESTAMP`);
        await pool.query(`ALTER TABLE user_ai_analysis ADD COLUMN IF NOT EXISTS context_version TEXT`);
        await pool.query(`ALTER TABLE user_ai_analysis ADD COLUMN IF NOT EXISTS current_room_id TEXT`);
        await pool.query(`ALTER TABLE user_ai_analysis ADD COLUMN IF NOT EXISTS source_job_id INTEGER`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ai_analysis_source_job_unique ON user_ai_analysis(source_job_id) WHERE source_job_id IS NOT NULL`);

        // Single-session AI review cache table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS session_ai_review (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                room_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                review_json TEXT NOT NULL,
                credits_used INTEGER DEFAULT 0,
                model_name TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id, room_id, session_id)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_ai_review_lookup ON session_ai_review(user_id, room_id, session_id)`);

        // Migration: users AI credit columns
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_credits_monthly INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_credits_remaining INTEGER DEFAULT 0`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_credits_used INTEGER DEFAULT 0`);
        // Seed default admin and plans (into production tables)
        await seedDefaultData();

        // Migration: Add group_id column if proxy_node has subscription_id instead
        try {
            const colCheck = await pool.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = 'proxy_node' AND column_name = 'group_id'
            `);

            if (colCheck.rows.length === 0) {
                console.log('[DB] Migrating proxy_node table: adding group_id column...');

                // Check if subscription_id exists (old schema)
                const subCheck = await pool.query(`
                    SELECT column_name FROM information_schema.columns 
                    WHERE table_name = 'proxy_node' AND column_name = 'subscription_id'
                `);

                if (subCheck.rows.length > 0) {
                    // Rename subscription_id to group_id
                    await pool.query(`ALTER TABLE proxy_node RENAME COLUMN subscription_id TO group_id`);
                } else {
                    // Add group_id column
                    await pool.query(`ALTER TABLE proxy_node ADD COLUMN IF NOT EXISTS group_id INTEGER`);
                }
                console.log('[DB] Migration complete: group_id column added');
            }
        } catch (migErr) {
            console.warn('[DB] Migration note:', migErr.message);
        }

        console.log('[DB] Tables and indexes created.');
        isInitialized = true;

        // Setup graceful shutdown
        setupShutdownHandlers();

    } catch (e) {
        console.error('[DB] Initialization error:', e);
        throw e;
    }
}

/**
 * Seed default admin account and subscription plans
 */
async function seedDefaultData() {
    try {
        const bcrypt = require('bcrypt');
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

        // Check if admin already exists (production table: users)
        const adminCheck = await pool.query(`SELECT id FROM users WHERE username = 'admin'`);
        if (adminCheck.rows.length === 0) {
            const hash = await bcrypt.hash(adminPassword, 10);
            await pool.query(
                `INSERT INTO users (username, email, password_hash, nickname, role, status)
                 VALUES ('admin', 'admin@local', $1, '管理员', 'admin', 'active')
                 ON CONFLICT DO NOTHING`,
                [hash]
            );
            console.log('[DB] Default admin account created (username: admin)');
        }

        // Seed default plans (production table: subscription_plans)
        const plans = [
            ['基础版', 'basic', 5, 99, 269, 899, 1],
            ['专业版', 'pro', 20, 299, 799, 2699, 2],
            ['企业版', 'enterprise', 100, 999, 2699, 8999, 3],
        ];
        for (const [name, code, roomLimit, pm, pq, py, sort] of plans) {
            await pool.query(
                `INSERT INTO subscription_plans (name, code, room_limit, price_monthly, price_quarterly, price_annual, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (code) DO NOTHING`,
                [name, code, roomLimit, pm, pq, py, sort]
            );
        }

        // Seed default addon packages (production table: room_addon_packages)
        // [name, room_count, price_monthly, price_quarterly, price_annual]
        const addons = [
            ['5房间扩容包', 5, 49, 129, 469],
            ['10房间扩容包', 10, 89, 239, 849],
            ['20房间扩容包', 20, 159, 429, 1519],
        ];
        for (const [name, count, pm, pq, pa] of addons) {
            const exists = await pool.query(
                `SELECT id FROM room_addon_packages WHERE name = $1`, [name]
            );
            if (exists.rows.length === 0) {
                await pool.query(
                    `INSERT INTO room_addon_packages (name, room_count, price_monthly, price_quarterly, price_annual) VALUES ($1, $2, $3, $4, $5)`,
                    [name, count, pm, pq, pa]
                );
            }
        }

        console.log('[DB] Default plans and addons seeded.');
    } catch (e) {
        console.warn('[DB] Seed data note:', e.message);
    }
}

/**
 * Setup graceful shutdown handlers
 */
function setupShutdownHandlers() {
    const shutdown = async (signal) => {
        console.log(`[DB] Received ${signal}, closing connection pool...`);
        try {
            await pool.end();
            console.log('[DB] Connection pool closed.');
        } catch (e) {
            console.error('[DB] Error closing pool:', e);
        }
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Convert snake_case or lowercase column names to camelCase
 * PostgreSQL returns lowercase column names, but frontend expects camelCase
 */
function toCamelCase(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(toCamelCase);

    const result = {};
    for (const key of Object.keys(obj)) {
        // Convert snake_case to camelCase: user_id -> userId
        // Also handle already lowercase: userid -> userId for common patterns
        let camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

        // Handle specific PostgreSQL lowercase patterns
        const knownMappings = {
            'userid': 'userId',
            'uniqueid': 'uniqueId',
            'giftname': 'giftName',
            'giftid': 'giftId',
            'totalvalue': 'totalValue',
            'unitprice': 'unitPrice',
            'roomcount': 'roomCount',
            'chatcount': 'chatCount',
            'likecount': 'likeCount',
            'lastactive': 'lastActive',
            'repeatcount': 'repeatCount',
            'diamondcount': 'diamondCount',
            'commonlanguage': 'commonLanguage',
            'masteredlanguages': 'masteredLanguages',
            'aianalysis': 'aiAnalysis',
            'viewercount': 'viewerCount',
            'roomid': 'roomId',
            'sessionid': 'sessionId',
            'toproom': 'topRoom',
            'fanlevel': 'fanLevel',
            'fanclubname': 'fanClubName',
            'isadmin': 'isAdmin',
            'issuperadmin': 'isSuperAdmin',
            'ismoderator': 'isModerator',
            'istooproommoderator': 'isTopRoomModerator',
            // Room detail stats mappings
            'totalcomments': 'totalComments',
            'totalvisits': 'totalVisits',
            'totalgiftvalue': 'totalGiftValue',
            'totallikes': 'totalLikes',
            'maxlikes': 'maxLikes',
            'starttime': 'startTime',
            'lastsessiontime': 'lastSessionTime',
            'numericroomid': 'numericRoomId',
            'ismonitorenabled': 'isMonitorEnabled',
            'updatedat': 'updatedAt',
            'createdat': 'createdAt',
            'totallikecount': 'totalLikeCount',
            'alltimegiftvalue': 'allTimeGiftValue',
            'currentgiftvalue': 'currentGiftValue',
            'durationsecs': 'durationSecs',
            'broadcastduration': 'broadcastDuration',
            'accountquality': 'accountQuality',
            'endtime': 'endTime',
            // User analysis stats mappings
            'activedays': 'activeDays',
            'firstseen': 'firstSeen',
            'lastseen': 'lastSeen',
            'dailyavg': 'dailyAvg',
            'dailyvalue': 'dailyValue',
            'toproomname': 'topRoomName'
        };

        if (knownMappings[camelKey.toLowerCase()]) {
            camelKey = knownMappings[camelKey.toLowerCase()];
        }

        result[camelKey] = obj[key];
    }
    return result;
}

/**
 * Run a query and return results
 * Converts SQLite-style ? placeholders to PostgreSQL $1, $2, etc.
 */
async function query(sql, params = []) {
    try {
        // Convert ? placeholders to $1, $2, etc.
        let paramIndex = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);

        const result = await pool.query(pgSql, params);
        // Convert column names to camelCase for frontend compatibility
        return result.rows.map(toCamelCase);
    } catch (e) {
        console.error('[DB] Query error:', sql, e.message);
        return [];
    }
}

/**
 * Execute a statement (INSERT, UPDATE, DELETE)
 */
async function run(sql, params = []) {
    try {
        // Convert ? placeholders to $1, $2, etc.
        let paramIndex = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);

        await pool.query(pgSql, params);
    } catch (e) {
        console.error('[DB] Run error:', sql, e.message);
    }
}

/**
 * Get a single row
 */
async function get(sql, params = []) {
    const results = await query(sql, params);
    return results.length > 0 ? results[0] : null;
}

/**
 * Get all rows (Alias for query)
 */
async function all(sql, params = []) {
    return query(sql, params);
}

/**
 * Get all system settings as an object
 */
async function getSystemSettings() {
    try {
        const res = await pool.query('SELECT key, value FROM settings');
        const settings = {};
        for (const row of res.rows) {
            let val = row.value;
            // Best-effort type conversion
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            else if (!isNaN(val) && val !== null && val.trim() !== '') val = Number(val);

            settings[row.key] = val;
        }
        return settings;
    } catch (err) {
        console.error('[DB] Failed to get settings:', err.message);
        return {};
    }
}

/**
 * Backup database (PostgreSQL uses pg_dump externally)
 */
function backupDb() {
    console.log('[DB] PostgreSQL backup should be done via pg_dump command.');
}

/**
 * Save database (PostgreSQL auto-commits, no-op)
 */
function saveDb() {
    // PostgreSQL auto-commits transactions, no manual save needed
}

// Synchronous versions for compatibility (use carefully)
function querySync(sql, params = []) {
    console.warn('[DB] querySync called - PostgreSQL is async, returning empty array');
    return [];
}

function runSync(sql, params = []) {
    console.warn('[DB] runSync called - PostgreSQL is async, operation may not complete');
}

function getSync(sql, params = []) {
    console.warn('[DB] getSync called - PostgreSQL is async, returning null');
    return null;
}

module.exports = {
    initDb,
    query,
    all,
    run,
    get,
    getSystemSettings,
    saveDb,
    backupDb,
    toCamelCase,
    pool
};
