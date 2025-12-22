/**
 * Check if groupId is available in stored gift events
 */
require('dotenv').config();
const { Pool } = require('pg');

async function check() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        // Get a sample of gift event data_json to see what fields are stored
        const sample = await pool.query(`
            SELECT id, data_json
            FROM event
            WHERE type = 'gift'
            ORDER BY id DESC
            LIMIT 5
        `);

        console.log('Sample gift event data_json fields:\n');
        for (const row of sample.rows) {
            const data = typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json;
            console.log(`Event ${row.id}:`);
            console.log('  Keys:', Object.keys(data).join(', '));
            if (data.groupId) console.log('  groupId:', data.groupId);
            if (data.groupCount) console.log('  groupCount:', data.groupCount);
            if (data.comboCount) console.log('  comboCount:', data.comboCount);
            if (data.giftType) console.log('  giftType:', data.giftType);
            if (data.repeatEnd !== undefined) console.log('  repeatEnd:', data.repeatEnd);
            if (data.repeatCount) console.log('  repeatCount:', data.repeatCount);
            console.log('');
        }

        // Check if any events have groupId
        const withGroupId = await pool.query(`
            SELECT COUNT(*) as cnt
            FROM event
            WHERE type = 'gift' AND data_json::jsonb ? 'groupId'
        `);
        console.log('Events with groupId:', withGroupId.rows[0].cnt);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

check();
