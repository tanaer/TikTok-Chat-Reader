/**
 * 彻底修复开始时间 - 删除12月18日之前的所有孤立事件
 * 使用明确的UTC+8时区计算
 */
require('dotenv').config();
const { Pool } = require('pg');

async function fixStartTimesV2() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        console.log('=== 彻底修复开始时间 (v2) ===\n');

        // 明确的截止时间：2025-12-18 00:00:00 UTC+8 = 2025-12-17 16:00:00 UTC
        const cutoffUTC = '2025-12-17 16:00:00';
        console.log(`删除时间截止: ${cutoffUTC} UTC (= 2025-12-18 00:00:00 UTC+8)\n`);

        // 1. 查看当前孤立事件
        const before = await pool.query(`
            SELECT COUNT(*) as cnt, MIN(timestamp) as min_ts, MAX(timestamp) as max_ts
            FROM event WHERE session_id IS NULL
        `);
        console.log('当前孤立事件:', before.rows[0]);

        // 2. 删除截止时间之前的所有事件
        console.log('\n删除 2025-12-18 00:00 UTC+8 之前的所有孤立事件...');
        const deleteResult = await pool.query(`
            DELETE FROM event 
            WHERE session_id IS NULL 
            AND timestamp < $1::timestamp
        `, [cutoffUTC]);
        console.log(`  ✓ 删除了 ${deleteResult.rowCount} 条事件`);

        // 3. 验证结果
        const after = await pool.query(`
            SELECT COUNT(*) as cnt, MIN(timestamp) as min_ts, MAX(timestamp) as max_ts
            FROM event WHERE session_id IS NULL
        `);
        console.log('\n删除后孤立事件:', after.rows[0]);

        // 4. 检查每个房间的第一个事件时间
        console.log('\n各房间最早事件 (应该都在 2025-12-17T16:00:00Z 之后):');
        const rooms = await pool.query(`
            SELECT room_id, 
                   MIN(timestamp) as first_event,
                   COUNT(*) as event_count
            FROM event 
            WHERE session_id IS NULL
            GROUP BY room_id
            ORDER BY first_event ASC
            LIMIT 20
        `);
        console.table(rooms.rows);

        // 5. 检查是否还有问题
        const problematic = await pool.query(`
            SELECT room_id, MIN(timestamp) as first_event
            FROM event 
            WHERE session_id IS NULL
            GROUP BY room_id
            HAVING MIN(timestamp) < '2025-12-17 16:00:00'
        `);

        if (problematic.rows.length > 0) {
            console.log('\n⚠️ 仍有问题的房间:');
            console.table(problematic.rows);
        } else {
            console.log('\n✅ 所有房间的开始时间都在今天（12月18日 UTC+8）！');
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

fixStartTimesV2();
