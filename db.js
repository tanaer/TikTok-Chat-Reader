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
                diamond_count INTEGER DEFAULT 0,
                repeat_count INTEGER DEFAULT 1,
                like_count INTEGER DEFAULT 0,
                total_like_count INTEGER DEFAULT 0,
                comment TEXT,
                viewer_count INTEGER,
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
                error_msg TEXT
            )
        `);

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

        // Migration: 套餐打开房间数限制 (同时启用监控的房间数, -1=不限)
        await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS open_room_limit INTEGER DEFAULT -1`);

        // Per-user quota overrides for admin adjustments
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_quota_overrides (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                room_limit_permanent INTEGER,
                room_limit_temporary INTEGER,
                room_limit_temporary_expires_at TIMESTAMP,
                open_room_limit_permanent INTEGER,
                open_room_limit_temporary INTEGER,
                open_room_limit_temporary_expires_at TIMESTAMP,
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
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                read_at TIMESTAMP
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created ON user_notifications(user_id, created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread ON user_notifications(user_id, is_read, created_at DESC)`);

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
                chat_count INTEGER DEFAULT 0,
                model_name TEXT,
                latency_ms INTEGER DEFAULT 0,
                source TEXT DEFAULT 'api',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_ai_analysis_member ON user_ai_analysis(member_id, target_user_id)`);

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
