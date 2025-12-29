/**
 * Check room ID variants for su311n1
 */
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root',
});

async function check() {
    // 1. Find all rooms with CS-005 name or su311 pattern
    console.log('=== Rooms matching pattern ===');
    const rooms = await pool.query(`
        SELECT room_id, numeric_room_id, name 
        FROM room 
        WHERE name LIKE '%CS-005%' OR room_id LIKE '%su311%'
    `);
    rooms.rows.forEach(r => console.log(r.room_id, '-', r.name, '- numericId:', r.numeric_room_id));

    // 2. Check if numeric_room_id was used for events
    if (rooms.rows.length > 0 && rooms.rows[0].numeric_room_id) {
        const numericId = rooms.rows[0].numeric_room_id;
        console.log('\n=== Events using numeric room ID ===');
        const numericEvents = await pool.query(`
            SELECT COUNT(*) as cnt, MAX(timestamp) as last_event 
            FROM event WHERE room_id = $1
        `, [numericId]);
        console.log('Numeric ID:', numericId);
        console.log('Events:', numericEvents.rows[0]);
    }

    // 3. Check all December sessions for this room
    console.log('\n=== All December sessions ===');
    const decSessions = await pool.query(`
        SELECT session_id, room_id, created_at FROM session 
        WHERE room_id = 'su311n1' AND created_at >= '2025-12-01'
        ORDER BY created_at DESC
    `);
    decSessions.rows.forEach(s => console.log(s.session_id, s.room_id, s.created_at));

    await pool.end();
}

check().catch(e => { console.error(e); pool.end(); });
