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
        // Performance optimization: index for MAX(timestamp) aggregation in getSessions
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_session_timestamp_desc ON event(session_id, timestamp DESC)`);

        // Performance optimization: functional index for activeHour filtering in getTopGifters
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_timestamp_hour ON event(EXTRACT(HOUR FROM timestamp))`);

        // Migrations for new columns
        await pool.query(`ALTER TABLE room ADD COLUMN IF NOT EXISTS language TEXT DEFAULT '中文'`);
        await pool.query(`ALTER TABLE room ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0`);
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
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
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
    run,
    get,
    saveDb,
    backupDb,
    // Expose pool for direct access if needed
    pool
};
