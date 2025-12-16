/**
 * Database module - SQLite using sql.js (pure JavaScript)
 * Improved with crash-safe saving and expanded event schema
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const BACKUP_PATH = path.join(__dirname, 'data.db.backup');

let db = null;
let initPromise = null;
let isSaving = false;
let saveTimer = null; // Debounce timer for batched saves
let isDirty = false;  // Track if there are unsaved changes

/**
 * Initialize the database
 */
async function initDb() {
    if (db) return db;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const SQL = await initSqlJs();

        // Load existing database or create new
        try {
            if (fs.existsSync(DB_PATH)) {
                const fileBuffer = fs.readFileSync(DB_PATH);
                db = new SQL.Database(fileBuffer);
                console.log('[DB] Loaded existing database.');
            } else {
                db = new SQL.Database();
                console.log('[DB] Created new database.');
            }
        } catch (e) {
            console.error('[DB] Error loading database, creating new:', e);
            db = new SQL.Database();
        }

        // Create tables
        db.run(`
            CREATE TABLE IF NOT EXISTS room (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT UNIQUE NOT NULL,
                numeric_room_id TEXT,
                name TEXT,
                address TEXT,
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                is_monitor_enabled INTEGER DEFAULT 1
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS session (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE NOT NULL,
                room_id TEXT NOT NULL,
                snapshot_json TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            )
        `);

        // Event table with expanded fields for direct querying
        db.run(`
            CREATE TABLE IF NOT EXISTS event (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                session_id TEXT,
                type TEXT NOT NULL,
                timestamp TEXT DEFAULT (datetime('now', 'localtime')),
                -- Expanded fields
                user_id TEXT,
                unique_id TEXT,
                nickname TEXT,
                -- Gift fields
                gift_id INTEGER,
                diamond_count INTEGER DEFAULT 0,
                repeat_count INTEGER DEFAULT 1,
                -- Like fields
                like_count INTEGER DEFAULT 0,
                total_like_count INTEGER DEFAULT 0,
                -- Chat fields
                comment TEXT,
                -- roomUser fields
                viewer_count INTEGER,
                -- Keep original JSON for any extra fields
                data_json TEXT
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS user (
                user_id TEXT PRIMARY KEY,
                unique_id TEXT,
                nickname TEXT,
                avatar TEXT,
                updated_at TEXT DEFAULT (datetime('now', 'localtime')),
                common_language TEXT,
                mastered_languages TEXT
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            )
        `);

        // Migrations for existing tables
        migrateTable('user', 'common_language', 'TEXT');
        migrateTable('user', 'mastered_languages', 'TEXT');
        migrateTable('room', 'is_monitor_enabled', 'INTEGER DEFAULT 1');
        migrateTable('room', 'numeric_room_id', 'TEXT');

        // Migrate event table - add new columns
        migrateTable('event', 'user_id', 'TEXT');
        migrateTable('event', 'unique_id', 'TEXT');
        migrateTable('event', 'nickname', 'TEXT');
        migrateTable('event', 'gift_id', 'INTEGER');
        migrateTable('event', 'diamond_count', 'INTEGER DEFAULT 0');
        migrateTable('event', 'repeat_count', 'INTEGER DEFAULT 1');
        migrateTable('event', 'like_count', 'INTEGER DEFAULT 0');
        migrateTable('event', 'total_like_count', 'INTEGER DEFAULT 0');
        migrateTable('event', 'comment', 'TEXT');
        migrateTable('event', 'viewer_count', 'INTEGER');

        // Backfill existing data from data_json to new columns
        try {
            db.run(`
                UPDATE event SET 
                    user_id = json_extract(data_json, '$.userId'),
                    unique_id = json_extract(data_json, '$.uniqueId'),
                    nickname = json_extract(data_json, '$.nickname'),
                    gift_id = json_extract(data_json, '$.giftId'),
                    diamond_count = COALESCE(json_extract(data_json, '$.diamondCount'), 0),
                    repeat_count = COALESCE(json_extract(data_json, '$.repeatCount'), 1),
                    like_count = COALESCE(json_extract(data_json, '$.likeCount'), 0),
                    total_like_count = COALESCE(json_extract(data_json, '$.totalLikeCount'), 0),
                    comment = json_extract(data_json, '$.comment'),
                    viewer_count = json_extract(data_json, '$.viewerCount')
                WHERE user_id IS NULL AND data_json IS NOT NULL
            `);
            console.log('[DB] Backfilled event columns from data_json.');
        } catch (e) {
            console.log('[DB] Backfill skipped or already done.');
        }

        // Indexes for fast queries
        db.run(`CREATE INDEX IF NOT EXISTS idx_event_room_session ON event(room_id, session_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_event_timestamp ON event(timestamp)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_event_user_id ON event(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_event_type ON event(type)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_event_type_user ON event(type, user_id)`);
        // Additional indexes for performance
        db.run(`CREATE INDEX IF NOT EXISTS idx_event_type_room ON event(type, room_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_event_user_type ON event(user_id, type)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_event_room_type_session ON event(room_id, type, session_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_session_room ON session(room_id, created_at DESC)`);

        saveDb();

        // Setup graceful shutdown
        setupShutdownHandlers();

        // Periodic forced save (crash safety) - every 10 seconds
        setInterval(() => {
            if (isDirty) {
                saveDb();
                console.log('[DB] Periodic save completed.');
            }
        }, 10000); // Every 10 seconds

        return db;
    })();

    return initPromise;
}

/**
 * Add column if it doesn't exist
 */
function migrateTable(table, column, type) {
    try {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.log(`[DB] Added column ${table}.${column}`);
    } catch (e) {
        // Column already exists
    }
}

/**
 * Save database to file (immediate, no debounce)
 */
function saveDb() {
    if (!db || isSaving) return;
    isSaving = true;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);

        // Try atomic write (temp + rename), fallback to direct write on Windows lock issues
        try {
            const tempPath = DB_PATH + '.tmp';
            fs.writeFileSync(tempPath, buffer);
            fs.renameSync(tempPath, DB_PATH);
        } catch (renameErr) {
            // Fallback: direct write (less safe but works when file is locked)
            fs.writeFileSync(DB_PATH, buffer);
        }

        // Suppress frequent log messages - only log every 10th save
        if (!saveDb.counter) saveDb.counter = 0;
        saveDb.counter++;
        if (saveDb.counter % 10 === 0) {
            console.log('[DB] Saved.');
        }
        isDirty = false; // Reset dirty flag after successful save
    } catch (e) {
        // Show simplified error message - suppress stack trace for common issues
        const errMsg = e.code === 'UNKNOWN' || e.code === 'EBUSY' || e.code === 'EPERM'
            ? `[DB] Save temporarily blocked (file busy), will retry...`
            : `[DB] Save error: ${e.message || e}`;
        console.log(errMsg);
    } finally {
        isSaving = false;
    }
}

/**
 * Create backup of database
 */
function backupDb() {
    if (!db) return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(BACKUP_PATH, buffer);
        console.log('[DB] Backup created.');
    } catch (e) {
        console.error('[DB] Backup error:', e);
    }
}

/**
 * Setup graceful shutdown handlers
 */
function setupShutdownHandlers() {
    let isShuttingDown = false;

    const shutdown = (signal) => {
        if (isShuttingDown) return; // Prevent duplicate shutdown
        isShuttingDown = true;

        console.log(`[DB] Received ${signal}, saving database...`);
        // Clear any pending debounced save and save immediately
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        saveDb();
        backupDb();
        console.log('[DB] Shutdown complete, exiting...');

        // Force exit after a short delay to ensure clean shutdown
        setTimeout(() => {
            process.exit(0);
        }, 100);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Don't save again in exit event since shutdown already saved
    process.on('exit', () => {
        if (!isShuttingDown) {
            console.log('[DB] Unexpected exit, final save...');
            saveDb();
        }
    });
}

/**
 * Run a query and return results
 */
function query(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    } catch (e) {
        console.error('[DB] Query error:', sql, e);
        return [];
    }
}

/**
 * Execute a statement and save immediately
 */
function run(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    try {
        db.run(sql, params);
        debouncedSave(); // Debounced save - batches multiple writes to reduce disk I/O
    } catch (e) {
        console.error('[DB] Run error:', sql, e);
    }
}

/**
 * Debounced save - waits 200ms after last write before saving to disk
 * This batches rapid writes while keeping data loss window very small
 */
function debouncedSave() {
    isDirty = true; // Mark as having unsaved changes
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveDb();
    }, 200); // Save 200ms after last write (reduced from 1000ms for safety)
}

/**
 * Get a single row
 */
function get(sql, params = []) {
    const results = query(sql, params);
    return results.length > 0 ? results[0] : null;
}

module.exports = { initDb, query, run, get, saveDb, backupDb };

