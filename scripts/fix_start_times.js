/**
 * 修复直播间开始时间问题
 * 删除今天之前的所有孤立事件（session_id IS NULL 且 timestamp < 今天）
 * 保留今天的事件，作为本场直播数据
 */
require('dotenv').config();
const { Pool } = require('pg');

async function fixStartTimes() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        console.log('=== 修复直播间开始时间 ===\n');

        // 获取今天的日期（UTC+8）
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().replace('T', ' ').slice(0, 19);
        console.log(`今天起始: ${todayStr}\n`);

        // 1. 检查孤立事件的时间分布
        const distribution = await pool.query(`
            SELECT 
                DATE(timestamp) as date,
                type,
                COUNT(*) as cnt
            FROM event 
            WHERE session_id IS NULL
            GROUP BY DATE(timestamp), type
            ORDER BY date DESC, type
            LIMIT 30
        `);
        console.log('孤立事件时间分布:');
        console.table(distribution.rows);

        // 2. 删除今天之前的孤立事件
        console.log('\n删除今天之前的孤立事件...');
        const deleteResult = await pool.query(`
            DELETE FROM event 
            WHERE session_id IS NULL 
            AND timestamp < $1
        `, [todayStr]);
        console.log(`  ✓ 删除了 ${deleteResult.rowCount} 条事件`);

        // 3. 验证每个房间的第一个事件时间
        console.log('\n验证各房间开始时间:');
        const roomStarts = await pool.query(`
            SELECT room_id, 
                   MIN(timestamp) as first_event,
                   COUNT(*) as event_count
            FROM event 
            WHERE session_id IS NULL
            GROUP BY room_id
            ORDER BY first_event DESC
            LIMIT 20
        `);
        console.table(roomStarts.rows);

        console.log('\n✅ 修复完成！各房间的开始时间现在应该正确显示。');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

fixStartTimes();
