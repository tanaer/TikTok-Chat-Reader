/**
 * 强制删除所有孤立事件 - 从零开始
 */
require('dotenv').config();
const { Pool } = require('pg');

async function forceReset() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        console.log('=== 强制重置：删除所有孤立事件 ===\n');

        // 检查时间戳列的类型
        const colInfo = await pool.query(`
            SELECT column_name, data_type, udt_name 
            FROM information_schema.columns 
            WHERE table_name = 'event' AND column_name = 'timestamp'
        `);
        console.log('timestamp 列类型:', colInfo.rows[0]);

        // 查看一些样本数据
        const samples = await pool.query(`
            SELECT id, room_id, timestamp, 
                   pg_typeof(timestamp) as ts_type
            FROM event 
            WHERE session_id IS NULL 
            ORDER BY timestamp ASC 
            LIMIT 5
        `);
        console.log('\n样本数据:');
        console.table(samples.rows);

        // 强制删除所有孤立事件
        console.log('\n删除所有 session_id IS NULL 的事件...');
        const deleteResult = await pool.query(`
            DELETE FROM event WHERE session_id IS NULL
        `);
        console.log(`  ✓ 删除了 ${deleteResult.rowCount} 条事件`);

        // 验证
        const remaining = await pool.query(`
            SELECT COUNT(*) as cnt FROM event WHERE session_id IS NULL
        `);
        console.log(`\n剩余孤立事件: ${remaining.rows[0].cnt}`);

        console.log('\n✅ 完成！所有直播间数据已清空.');
        console.log('   新的数据将从下次直播开始累计。');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

forceReset();
