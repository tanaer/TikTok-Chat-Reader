/**
 * Deep analysis of duplicate gift events
 */
require('dotenv').config();
const { Pool } = require('pg');

async function analyze() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        // Find a sample of duplicate-looking events
        console.log('Analyzing duplicate pattern...\n');

        const samples = await pool.query(`
            SELECT id, timestamp, user_id, gift_id, diamond_count, repeat_count,
                   data_json::jsonb->>'repeatEnd' as repeat_end,
                   data_json::jsonb->>'giftType' as gift_type
            FROM event 
            WHERE room_id = 'blooming1881' 
              AND type = 'gift' 
              AND timestamp >= '2025-12-17 12:43:00' 
              AND timestamp <= '2025-12-17 12:43:20'
            ORDER BY timestamp, id
        `);

        console.log('Sample gift events (12:43:00 - 12:43:20):');
        for (const row of samples.rows) {
            console.log(`ID:${row.id} | ${row.timestamp} | gift:${row.gift_id} | d:${row.diamond_count} x${row.repeat_count} | type:${row.gift_type} | end:${row.repeat_end}`);
        }

        console.log('\n--- Checking duplicates with same user + gift + repeatCount within 2 sec ---');
        const sameCounts = await pool.query(`
            SELECT user_id, gift_id, repeat_count, COUNT(*) as occurrences,
                   MIN(timestamp) as first_time, MAX(timestamp) as last_time
            FROM event
            WHERE room_id = 'blooming1881' 
              AND type = 'gift' 
              AND timestamp >= '2025-12-17' AND timestamp < '2025-12-18'
            GROUP BY user_id, gift_id, repeat_count
            HAVING COUNT(*) > 1
            ORDER BY occurrences DESC
            LIMIT 20
        `);

        console.log('\nSame user+gift+repeatCount appearing multiple times:');
        console.table(sameCounts.rows);

        // Check if events have different session_id (meaning recorded across reconnects)
        console.log('\n--- Checking events across different sessions ---');
        const crossSession = await pool.query(`
            SELECT session_id, COUNT(*) as cnt, 
                   SUM(diamond_count * repeat_count) as total_value
            FROM event
            WHERE room_id = 'blooming1881' 
              AND type = 'gift' 
              AND timestamp >= '2025-12-17' AND timestamp < '2025-12-18'
            GROUP BY session_id
            ORDER BY session_id
        `);
        console.table(crossSession.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

analyze();
