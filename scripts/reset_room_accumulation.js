/**
 * 重置所有直播间的累计数据
 * - 删除所有 session 记录
 * - 清空 event 表的 session_id 关联
 * - 保留原始事件数据（用户分析仍可使用）
 */
require('dotenv').config();
const { Pool } = require('pg');

async function reset() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        console.log('=== 重置所有直播间累计数据 ===\n');

        // 1. 统计当前数据
        const sessionCount = await pool.query(`SELECT COUNT(*) as cnt FROM session`);
        const eventCount = await pool.query(`SELECT COUNT(*) as cnt FROM event`);
        const eventWithSession = await pool.query(`SELECT COUNT(*) as cnt FROM event WHERE session_id IS NOT NULL`);

        console.log('当前状态:');
        console.log(`  - 场次记录: ${sessionCount.rows[0].cnt}`);
        console.log(`  - 总事件数: ${eventCount.rows[0].cnt}`);
        console.log(`  - 已关联场次的事件: ${eventWithSession.rows[0].cnt}`);

        // 2. 清空 event 表的 session_id
        console.log('\n步骤 1: 断开事件与场次的关联...');
        const updateResult = await pool.query(`UPDATE event SET session_id = NULL WHERE session_id IS NOT NULL`);
        console.log(`  ✓ 更新了 ${updateResult.rowCount} 条事件记录`);

        // 3. 删除所有 session 记录
        console.log('\n步骤 2: 删除所有场次记录...');
        const deleteResult = await pool.query(`DELETE FROM session`);
        console.log(`  ✓ 删除了 ${deleteResult.rowCount} 条场次记录`);

        // 4. 验证结果
        console.log('\n=== 完成 ===');
        const finalSessionCount = await pool.query(`SELECT COUNT(*) as cnt FROM session`);
        const finalEventCount = await pool.query(`SELECT COUNT(*) as cnt FROM event`);
        console.log(`  - 剩余场次记录: ${finalSessionCount.rows[0].cnt}`);
        console.log(`  - 保留事件数: ${finalEventCount.rows[0].cnt}`);
        console.log('\n所有直播间的礼物累计已重置，历史事件数据已保留供用户分析使用。');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

reset();
