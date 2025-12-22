/**
 * Migration script: SQLite to PostgreSQL
 * Transfers all data from data.db (SQLite) to PostgreSQL
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DB_PATH = path.join(__dirname, '..', 'data.db');

// PostgreSQL connection
const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'tkmonitor',
    user: 'postgres',
    password: 'root',
});

async function migrate() {
    console.log('Starting SQLite to PostgreSQL migration...\n');

    // Load SQLite database
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(DB_PATH);
    const sqlite = new SQL.Database(buffer);

    // Helper to query SQLite
    const sqliteQuery = (sql) => {
        const stmt = sqlite.prepare(sql);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    };

    try {
        // Create tables first
        console.log('Creating PostgreSQL tables...');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS room (
                id SERIAL PRIMARY KEY,
                room_id TEXT UNIQUE NOT NULL,
                numeric_room_id TEXT,
                name TEXT,
                address TEXT,
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
                is_moderator INTEGER DEFAULT 0
            )
        `);

        // Create indexes
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_room ON event(room_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_session ON event(session_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_type ON event(type)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_timestamp ON event(timestamp)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_user ON event(user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_room ON session(room_id)`);

        console.log('  Tables and indexes created.\n');

        // 1. Migrate rooms
        console.log('Migrating rooms...');
        const rooms = sqliteQuery('SELECT * FROM room');
        for (const room of rooms) {
            await pool.query(`
                INSERT INTO room (id, room_id, numeric_room_id, name, address, updated_at, is_monitor_enabled)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (room_id) DO NOTHING
            `, [room.id, room.room_id, room.numeric_room_id, room.name, room.address, room.updated_at, room.is_monitor_enabled]);
        }
        console.log(`  Migrated ${rooms.length} rooms.`);

        // 2. Migrate sessions
        console.log('Migrating sessions...');
        const sessions = sqliteQuery('SELECT * FROM session');
        for (const session of sessions) {
            await pool.query(`
                INSERT INTO session (id, session_id, room_id, snapshot_json, created_at)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (session_id) DO NOTHING
            `, [session.id, session.session_id, session.room_id, session.snapshot_json, session.created_at]);
        }
        console.log(`  Migrated ${sessions.length} sessions.`);

        // 3. Migrate users
        console.log('Migrating users...');
        const users = sqliteQuery('SELECT * FROM user');
        let userCount = 0;
        for (const user of users) {
            try {
                await pool.query(`
                    INSERT INTO "user" (user_id, unique_id, nickname, avatar, updated_at, common_language, mastered_languages, is_moderator)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (user_id) DO NOTHING
                `, [user.user_id, user.unique_id, user.nickname, user.avatar, user.updated_at, user.common_language, user.mastered_languages, user.is_moderator || 0]);
                userCount++;
            } catch (e) {
                // Skip on error, continue with next
            }
        }
        console.log(`  Migrated ${userCount} users.`);

        // 4. Migrate events (in batches for performance)
        console.log('Migrating events...');
        const eventCount = sqliteQuery('SELECT COUNT(*) as cnt FROM event')[0].cnt;
        console.log(`  Total events to migrate: ${eventCount}`);

        const batchSize = 5000;
        let offset = 0;
        let migrated = 0;

        while (offset < eventCount) {
            const events = sqliteQuery(`SELECT * FROM event LIMIT ${batchSize} OFFSET ${offset}`);

            for (const event of events) {
                try {
                    await pool.query(`
                        INSERT INTO event (id, room_id, session_id, type, timestamp, user_id, unique_id, nickname, 
                                          gift_id, diamond_count, repeat_count, like_count, total_like_count, 
                                          comment, viewer_count, data_json)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                        ON CONFLICT DO NOTHING
                    `, [
                        event.id, event.room_id, event.session_id, event.type, event.timestamp,
                        event.user_id, event.unique_id, event.nickname,
                        event.gift_id, event.diamond_count || 0, event.repeat_count || 1,
                        event.like_count || 0, event.total_like_count || 0,
                        event.comment, event.viewer_count, event.data_json
                    ]);
                    migrated++;
                } catch (e) {
                    // Skip on error, continue with next
                }
            }

            offset += batchSize;
            console.log(`  Progress: ${Math.min(offset, eventCount)}/${eventCount} (${Math.round(Math.min(offset, eventCount) / eventCount * 100)}%)`);
        }
        console.log(`\n  Migrated ${migrated} events.`);

        // Reset sequences
        console.log('\nResetting sequences...');
        await pool.query(`SELECT setval('room_id_seq', (SELECT MAX(id) FROM room))`);
        await pool.query(`SELECT setval('session_id_seq', (SELECT MAX(id) FROM session))`);
        await pool.query(`SELECT setval('event_id_seq', (SELECT MAX(id) FROM event))`);
        console.log('  Sequences reset.');

        console.log('\n✅ Migration complete!');

    } catch (e) {
        console.error('Migration error:', e);
    } finally {
        sqlite.close();
        await pool.end();
    }
}

migrate().catch(console.error);
