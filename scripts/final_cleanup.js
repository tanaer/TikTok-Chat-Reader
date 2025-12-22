/**
 * Final cleanup: Keep only ONE event (with highest repeatCount) per user+gift per minute
 */
require('dotenv').config();
const { Pool } = require('pg');

async function cleanup() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        console.log('=== Final Cleanup: One event per user+gift per minute ===\n');

        // For each (room, user, gift, minute), keep only the event with highest repeatCount
        const duplicates = await pool.query(`
            WITH ranked AS (
                SELECT id, room_id, user_id, gift_id, repeat_count, timestamp,
                       ROW_NUMBER() OVER (
                           PARTITION BY room_id, user_id, gift_id, DATE_TRUNC('minute', timestamp)
                           ORDER BY repeat_count DESC, timestamp DESC
                       ) as rn
                FROM event
                WHERE type = 'gift'
            )
            SELECT id FROM ranked WHERE rn > 1
        `);

        console.log(`Found ${duplicates.rows.length} events to delete`);

        if (duplicates.rows.length > 0) {
            const idsToDelete = duplicates.rows.map(r => r.id);
            let deleted = 0;
            const batchSize = 1000;
            for (let i = 0; i < idsToDelete.length; i += batchSize) {
                const batch = idsToDelete.slice(i, i + batchSize);
                const result = await pool.query(`DELETE FROM event WHERE id = ANY($1::int[])`, [batch]);
                deleted += result.rowCount;
            }
            console.log(`Deleted ${deleted} rows\n`);
        }

        // Check blooming1881
        const blooming = await pool.query(`
            SELECT COUNT(*) as events, SUM(diamond_count * repeat_count) as value
            FROM event
            WHERE room_id = 'blooming1881' AND type = 'gift'
              AND timestamp >= '2025-12-17' AND timestamp < '2025-12-18'
        `);
        console.log('blooming1881 Dec 17 after cleanup:', blooming.rows[0]);
        console.log(`Expected: 5,250 | Ratio: ${(blooming.rows[0].value / 5250).toFixed(2)}x`);

        // Overall stats
        const total = await pool.query(`
            SELECT COUNT(*) as events, SUM(diamond_count * repeat_count) as value
            FROM event WHERE type = 'gift'
        `);
        console.log('\nTotal gift events:', total.rows[0]);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

cleanup();
