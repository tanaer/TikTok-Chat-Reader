/**
 * 检查 c1ous8df81 房间的礼物记录
 * 使用线上数据库
 */
const { Pool } = require('pg');

const pool = new Pool({
    host: '109.244.73.132',
    port: 5566,
    database: 'tkmonitor',
    user: 'postgres',
    password: 'qq123456',
    connectionTimeoutMillis: 10000
});

async function check() {
    console.log('Connecting to production database...');

    try {
        // 1. 查找房间
        const room = await pool.query(`
            SELECT room_id, name, is_monitor_enabled 
            FROM room 
            WHERE room_id ILIKE '%c1ous8df81%'
        `);
        console.log('\n=== Room ===');
        console.log(room.rows);

        // 2. 查找最近的礼物事件
        const gifts = await pool.query(`
            SELECT nickname, gift_id, diamond_count, repeat_count, timestamp 
            FROM event 
            WHERE room_id = 'c1ous8df81' AND type = 'gift' 
            ORDER BY timestamp DESC 
            LIMIT 20
        `);
        console.log('\n=== Recent gifts ===');
        console.log(gifts.rows);

        // 3. 查找高价值礼物 (>=1000钻)
        const bigGifts = await pool.query(`
            SELECT nickname, gift_id, diamond_count, repeat_count, timestamp 
            FROM event 
            WHERE room_id = 'c1ous8df81' AND type = 'gift' AND diamond_count >= 1000
            ORDER BY timestamp DESC 
            LIMIT 10
        `);
        console.log('\n=== Big gifts (>=1000💎) ===');
        console.log(bigGifts.rows);

        // 4. 统计该房间的事件类型
        const stats = await pool.query(`
            SELECT type, COUNT(*) as cnt 
            FROM event 
            WHERE room_id = 'c1ous8df81' 
            GROUP BY type
        `);
        console.log('\n=== Event stats ===');
        console.log(stats.rows);

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await pool.end();
    }
}

check();
