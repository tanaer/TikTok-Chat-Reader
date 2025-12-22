/**
 * Aggressive cleanup: For combo gift sequences, keep ONLY the event with the HIGHEST repeatCount
 * 
 * A combo sequence is defined as: same user + same gift + events occurring within a sliding 10-second window
 * For each sequence, we keep the event with the highest repeatCount (the final value)
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
        console.log('=== Aggressive Combo Gift Cleanup ===\n');

        // Step 1: Count before
        const beforeCount = await pool.query(`
            SELECT COUNT(*) as total, SUM(diamond_count * repeat_count) as value
            FROM event WHERE type = 'gift'
        `);
        console.log('Before cleanup:', beforeCount.rows[0]);

        // Step 2: Find all duplicate events within combo sequences
        // Keep only the event with highest repeat_count per (user, gift, room, time_bucket)
        // Time bucket: floor timestamp to 10-second intervals
        console.log('\nFinding combo sequence duplicates...');

        const duplicates = await pool.query(`
            WITH ranked_gifts AS (
                SELECT id, room_id, user_id, gift_id, repeat_count, timestamp, diamond_count,
                       ROW_NUMBER() OVER (
                           PARTITION BY room_id, user_id, gift_id, 
                                        DATE_TRUNC('minute', timestamp),
                                        -- Group by 10-second buckets within the minute
                                        FLOOR(EXTRACT(SECOND FROM timestamp) / 10)
                           ORDER BY repeat_count DESC, timestamp DESC
                       ) as rn
                FROM event
                WHERE type = 'gift'
            )
            SELECT id, room_id, user_id, gift_id, repeat_count, timestamp, diamond_count
            FROM ranked_gifts
            WHERE rn > 1
        `);

        if (duplicates.rows.length === 0) {
            console.log('No combo duplicates found!');

            // Maybe need longer window - try per minute
            console.log('\nTrying with 1-minute window...');
            const duplicates2 = await pool.query(`
                WITH ranked_gifts AS (
                    SELECT id, room_id, user_id, gift_id, repeat_count, timestamp, diamond_count,
                           ROW_NUMBER() OVER (
                               PARTITION BY room_id, user_id, gift_id, 
                                            DATE_TRUNC('minute', timestamp)
                               ORDER BY repeat_count DESC, timestamp DESC
                           ) as rn
                    FROM event
                    WHERE type = 'gift'
                )
                SELECT id, room_id, user_id, gift_id, repeat_count, timestamp, diamond_count
                FROM ranked_gifts
                WHERE rn > 1
            `);

            if (duplicates2.rows.length === 0) {
                console.log('Still no duplicates found with 1-minute window.');
                return;
            }

            console.log(`Found ${duplicates2.rows.length} duplicates with 1-minute window`);

            // Delete
            const idsToDelete = duplicates2.rows.map(r => r.id);
            let deleted = 0;
            const batchSize = 1000;
            for (let i = 0; i < idsToDelete.length; i += batchSize) {
                const batch = idsToDelete.slice(i, i + batchSize);
                const result = await pool.query(`DELETE FROM event WHERE id = ANY($1::int[])`, [batch]);
                deleted += result.rowCount;
            }
            console.log(`Deleted ${deleted} rows`);
        } else {
            console.log(`Found ${duplicates.rows.length} combo duplicates to remove`);

            // Delete in batches
            const idsToDelete = duplicates.rows.map(r => r.id);
            let deleted = 0;
            const batchSize = 1000;
            for (let i = 0; i < idsToDelete.length; i += batchSize) {
                const batch = idsToDelete.slice(i, i + batchSize);
                const result = await pool.query(`DELETE FROM event WHERE id = ANY($1::int[])`, [batch]);
                deleted += result.rowCount;
                console.log(`  Deleted batch ${Math.floor(i / batchSize) + 1}: ${result.rowCount} rows`);
            }
        }

        // Step 3: Count after
        const afterCount = await pool.query(`
            SELECT COUNT(*) as total, SUM(diamond_count * repeat_count) as value
            FROM event WHERE type = 'gift'
        `);
        console.log('\nAfter cleanup:', afterCount.rows[0]);

        // Step 4: Check blooming1881 specifically
        const blooming = await pool.query(`
            SELECT COUNT(*) as events, SUM(diamond_count * repeat_count) as value
            FROM event
            WHERE room_id = 'blooming1881' AND type = 'gift'
              AND timestamp >= '2025-12-17' AND timestamp < '2025-12-18'
        `);
        console.log('\nblooming1881 Dec 17:', blooming.rows[0]);
        console.log(`Expected: 5,250 | Ratio: ${(blooming.rows[0].value / 5250).toFixed(2)}x`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

cleanup();
