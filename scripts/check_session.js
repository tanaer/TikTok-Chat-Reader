/**
 * 检查礼物记录的 session_id
 */
const { Pool } = require('pg');

const pool = new Pool({
    host: '109.244.73.132',
    port: 5566,
    database: 'tkmonitor',
    user: 'postgres',
    password: 'qq123456',
    connectionTimeoutMillis: 30000,
    query_timeout: 30000
});

async function check() {
    console.log('Connecting...');

    try {
        // 1. 检查 Meteor Shower 礼物的 session_id
        console.log('\n=== Meteor Shower (gift_id=6563) records ===');
        const meteor = await pool.query(`
            SELECT id, nickname, gift_id, diamond_count, session_id, timestamp 
            FROM event 
            WHERE room_id = 'c1ous8df81' AND gift_id = 6563
            ORDER BY timestamp DESC
        `);
        meteor.rows.forEach(r => console.log(r));

        // 2. 检查该房间的 session 列表
        console.log('\n=== Recent sessions ===');
        const sessions = await pool.query(`
            SELECT session_id, created_at FROM session 
            WHERE room_id = 'c1ous8df81' 
            ORDER BY created_at DESC LIMIT 5
        `);
        sessions.rows.forEach(r => console.log(r));

        // 3. 检查当前 live 模式下能看到的礼物数量
        console.log('\n=== Live mode stats ===');
        const liveStats = await pool.query(`
            SELECT type, COUNT(*) as cnt 
            FROM event 
            WHERE room_id = 'c1ous8df81' AND session_id IS NULL
            GROUP BY type
        `);
        liveStats.rows.forEach(r => console.log(r));

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await pool.end();
    }
}

check();
