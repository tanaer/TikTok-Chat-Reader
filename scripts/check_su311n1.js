/**
 * Quick check for su311n1 sessions and events
 */
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root',
});

async function check() {
    const roomId = 'su311n1';
    const uniqueId = 'jjou223223';

    // 1. Check sessions
    console.log('=== Sessions for su311n1 ===');
    const sessions = await pool.query(`
        SELECT session_id, created_at FROM session 
        WHERE room_id = $1 ORDER BY created_at DESC LIMIT 5
    `, [roomId]);
    sessions.rows.forEach(s => console.log(s.session_id, '-', s.created_at));

    // 2. Check latest events (with session_id)
    console.log('\n=== Latest events in su311n1 (with session) ===');
    const eventsWithSession = await pool.query(`
        SELECT id, session_id, type, timestamp, unique_id 
        FROM event WHERE room_id = $1 AND session_id IS NOT NULL
        ORDER BY timestamp DESC LIMIT 5
    `, [roomId]);
    eventsWithSession.rows.forEach(e => console.log(e.id, e.session_id, e.type, e.timestamp, e.unique_id));

    // 3. Check if jjou223223 exists in any session for this room
    console.log('\n=== Check jjou223223 in su311n1 ===');
    const userEvents = await pool.query(`
        SELECT id, session_id, type, timestamp, comment 
        FROM event WHERE room_id = $1 AND unique_id = $2
        ORDER BY timestamp DESC LIMIT 5
    `, [roomId, uniqueId]);
    console.log('Events found:', userEvents.rows.length);
    userEvents.rows.forEach(e => console.log(e.id, e.type, e.timestamp, e.comment));

    // 4. Check latest events overall in room (regardless of session)
    console.log('\n=== Absolute latest events in su311n1 ===');
    const latestAll = await pool.query(`
        SELECT MAX(timestamp) as max_ts, MIN(timestamp) as min_ts, COUNT(*) as total
        FROM event WHERE room_id = $1
    `, [roomId]);
    console.log(latestAll.rows[0]);

    await pool.end();
}

check().catch(e => { console.error(e); pool.end(); });
