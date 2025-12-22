/**
 * Cleanup duplicate gift events
 * 
 * For each user+gift+room+date combination, keep only the event with the HIGHEST repeatCount.
 * This removes intermediate combo updates while preserving the final gift value.
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
        console.log('=== Cleaning up duplicate gift events ===\n');

        // Step 1: Count duplicates before cleanup
        const beforeCount = await pool.query(`
            SELECT COUNT(*) as total FROM event WHERE type = 'gift'
        `);
        console.log(`Total gift events before cleanup: ${beforeCount.rows[0].total}`);

        // Step 2: Find duplicates - same user, gift, room within same minute (likely combo duplicates)
        // Keep the one with highest repeat_count (the final combo value)
        console.log('\nFinding duplicate gift events (same user+gift+room within 5 seconds)...');

        const duplicates = await pool.query(`
            WITH gift_groups AS (
                SELECT id, room_id, user_id, gift_id, repeat_count, timestamp,
                       diamond_count,
                       ROW_NUMBER() OVER (
                           PARTITION BY room_id, user_id, gift_id, 
                                        DATE_TRUNC('second', timestamp - INTERVAL '2 seconds')
                           ORDER BY repeat_count DESC, id DESC
                       ) as rn
                FROM event
                WHERE type = 'gift'
            )
            SELECT id, room_id, user_id, gift_id, repeat_count, timestamp, diamond_count
            FROM gift_groups
            WHERE rn > 1
            ORDER BY room_id, timestamp
        `);

        if (duplicates.rows.length === 0) {
            console.log('No duplicates found!');
            return;
        }

        console.log(`Found ${duplicates.rows.length} duplicate events to remove`);

        // Show sample of duplicates by room
        const byRoom = {};
        for (const d of duplicates.rows) {
            byRoom[d.room_id] = (byRoom[d.room_id] || 0) + 1;
        }

        console.log('\nDuplicates by room:');
        const sorted = Object.entries(byRoom).sort((a, b) => b[1] - a[1]).slice(0, 10);
        for (const [room, count] of sorted) {
            console.log(`  ${room}: ${count}`);
        }

        // Step 3: Delete duplicates
        console.log('\nDeleting duplicates...');
        const idsToDelete = duplicates.rows.map(r => r.id);

        // Delete in batches of 1000
        let deleted = 0;
        const batchSize = 1000;
        for (let i = 0; i < idsToDelete.length; i += batchSize) {
            const batch = idsToDelete.slice(i, i + batchSize);
            const result = await pool.query(`DELETE FROM event WHERE id = ANY($1::int[])`, [batch]);
            deleted += result.rowCount;
            console.log(`  Deleted batch ${Math.floor(i / batchSize) + 1}: ${result.rowCount} rows`);
        }

        // Step 4: Count after cleanup
        const afterCount = await pool.query(`
            SELECT COUNT(*) as total FROM event WHERE type = 'gift'
        `);

        console.log(`\n✅ Cleanup complete!`);
        console.log(`   Before: ${beforeCount.rows[0].total} gift events`);
        console.log(`   After:  ${afterCount.rows[0].total} gift events`);
        console.log(`   Removed: ${deleted} duplicate events`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

cleanup();
