/**
 * Check repeatEnd pattern to understand the duplication
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
        // Check how many events have repeatEnd = true vs false
        const stats = await pool.query(`
            SELECT 
                data_json::jsonb->>'repeatEnd' as repeat_end,
                data_json::jsonb->>'giftType' as gift_type,
                COUNT(*) as cnt
            FROM event
            WHERE room_id = 'blooming1881' 
              AND type = 'gift' 
              AND timestamp >= '2025-12-17' AND timestamp < '2025-12-18'
            GROUP BY data_json::jsonb->>'repeatEnd', data_json::jsonb->>'giftType'
        `);

        console.log('Gift events by repeatEnd and giftType:');
        console.table(stats.rows);

        // Look at a specific combo sequence for one user
        console.log('\n--- Sample of one user combo sequence ---');
        const sequence = await pool.query(`
            SELECT id, timestamp, repeat_count,
                   data_json::jsonb->>'repeatEnd' as repeat_end,
                   diamond_count
            FROM event
            WHERE room_id = 'blooming1881' 
              AND type = 'gift' 
              AND user_id = '7569569600435323926'
              AND gift_id = 5655
              AND timestamp >= '2025-12-17 12:53:00' 
              AND timestamp <= '2025-12-17 12:53:30'
            ORDER BY timestamp, id
        `);

        console.log('User 7569569600435323926 gift 5655 combo:');
        for (const row of sequence.rows) {
            console.log(`ID:${row.id} | ${row.timestamp} | x${row.repeat_count} | end:${row.repeat_end}`);
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

check();
