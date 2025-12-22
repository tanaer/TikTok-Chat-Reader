/**
 * 正确重置所有直播间的礼物累计
 * 方案：删除所有 gift 类型事件（礼物数据会从零开始）
 * 保留 chat/member/like 事件供用户分析
 */
require('dotenv').config();
const { Pool } = require('pg');

async function properReset() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        console.log('=== 正确重置礼物累计 ===\n');

        // 1. 统计当前礼物数据
        const giftCount = await pool.query(`SELECT COUNT(*) as cnt FROM event WHERE type = 'gift'`);
        console.log(`当前礼物事件数: ${giftCount.rows[0].cnt}`);

        // 2. 删除所有礼物事件
        console.log('\n删除所有礼物事件...');
        const deleteGifts = await pool.query(`DELETE FROM event WHERE type = 'gift'`);
        console.log(`  ✓ 删除了 ${deleteGifts.rowCount} 条礼物事件`);

        // 3. 验证
        console.log('\n=== 完成 ===');
        const remaining = await pool.query(`SELECT type, COUNT(*) as cnt FROM event GROUP BY type ORDER BY type`);
        console.log('剩余事件统计:');
        for (const row of remaining.rows) {
            console.log(`  - ${row.type}: ${row.cnt}`);
        }

        console.log('\n✅ 所有直播间的礼物累计已重置为零！');
        console.log('   新的礼物数据将使用 groupId 精确去重。');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

properReset();
