const { Pool } = require('pg');

const pool = new Pool({
    host: '14.215.39.218',
    port: 48499,
    user: 'postgres',
    password: 'qq123456',
    database: 'tkmonitor',
    connectionTimeoutMillis: 30000
});

async function fix() {
    const client = await pool.connect();
    try {
        const roomId = 'blooming1881';
        console.log(`Fixing room: ${roomId}\n`);

        // 1. Get the mismatched events info
        const r1 = await client.query(`
            SELECT MIN(timestamp) as first_ts, MAX(timestamp) as last_ts, COUNT(*) as cnt,
                   SUM(CASE WHEN type='gift' THEN COALESCE(diamond_count,0)*COALESCE(repeat_count,1) ELSE 0 END) as gift_value
            FROM event 
            WHERE room_id = $1 AND timestamp > '2025-12-25'
        `, [roomId]);
        console.log('Today events stats:', r1.rows[0]);

        // 2. Create a new session for blooming1881
        const insertResult = await client.query(`
            INSERT INTO session (room_id, session_id, created_at, snapshot_json)
            VALUES ($1, $2, $3, $4)
            RETURNING id, session_id
        `, [
            roomId,
            `${roomId}_20251225`,
            r1.rows[0].first_ts,
            JSON.stringify({
                auto_generated: true,
                reason: 'Manual fix for mismatched session',
                note: `Fixed ${r1.rows[0].cnt} events`,
                gift_value: parseInt(r1.rows[0].gift_value) || 0
            })
        ]);
        console.log('\nCreated new session:', insertResult.rows[0]);

        const newSessionId = insertResult.rows[0].session_id;

        // 3. Update all today's events to use the new session
        const updateResult = await client.query(`
            UPDATE event 
            SET session_id = $1
            WHERE room_id = $2 AND timestamp > '2025-12-25'
        `, [newSessionId, roomId]);
        console.log(`Updated ${updateResult.rowCount} events to new session`);

        await pool.end();
        console.log('\nDone!');
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

fix();
