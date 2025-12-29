const { Pool } = require('pg');

const pool = new Pool({
    host: '14.215.39.218',
    port: 48499,
    user: 'postgres',
    password: 'qq123456',
    database: 'tkmonitor',
    connectionTimeoutMillis: 30000
});

async function check() {
    try {
        // Check how many events have the wrong session_id
        const r1 = await pool.query(`
            SELECT e.room_id, e.session_id, s.room_id as session_room_id, COUNT(*) as cnt
            FROM event e
            JOIN session s ON e.session_id = s.session_id
            WHERE e.room_id != s.room_id
            GROUP BY e.room_id, e.session_id, s.room_id
            ORDER BY cnt DESC
            LIMIT 20
        `);
        console.log('Events with mismatched room_id and session room_id:', r1.rows);

        // Check blooming1881 events specifically
        const r2 = await pool.query(`
            SELECT session_id, COUNT(*) as cnt, 
                   MIN(timestamp) as first_ts, 
                   MAX(timestamp) as last_ts
            FROM event 
            WHERE room_id = 'blooming1881' AND timestamp > '2025-12-25'
            GROUP BY session_id
            ORDER BY first_ts DESC
        `);
        console.log('\nblooming1881 events today by session_id:', r2.rows);

        await pool.end();
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

check();
