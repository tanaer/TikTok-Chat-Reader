/**
 * Cleanup Script: Remove users without chat, gift, or like events
 * 
 * This script removes user records that only have member/view events
 * (i.e., users who never chatted, gifted, or liked)
 * 
 * Usage: node scripts/cleanup_users.js [--dry-run]
 */

require('dotenv').config();
const { Pool } = require('pg');

async function cleanup() {
    const dryRun = process.argv.includes('--dry-run');

    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        console.log('=== User Cleanup Script ===\n');
        console.log(dryRun ? 'DRY RUN MODE - No changes will be made\n' : 'LIVE MODE - Users will be deleted\n');

        // Count total users
        const totalResult = await pool.query('SELECT COUNT(*) as cnt FROM "user"');
        console.log(`Total users in database: ${totalResult.rows[0].cnt}`);

        // Find users with chat, gift, or like events
        const validUsersResult = await pool.query(`
            SELECT DISTINCT user_id 
            FROM event 
            WHERE type IN ('chat', 'gift', 'like') AND user_id IS NOT NULL
        `);
        const validUserIds = new Set(validUsersResult.rows.map(r => r.user_id));
        console.log(`Users with chat/gift/like events: ${validUserIds.size}`);

        // Find users to delete (those not in valid set)
        const allUsersResult = await pool.query('SELECT user_id FROM "user"');
        const usersToDelete = allUsersResult.rows.filter(r => !validUserIds.has(r.user_id));
        console.log(`Users to delete (no chat/gift/like events): ${usersToDelete.length}`);

        if (usersToDelete.length === 0) {
            console.log('\nNo users to delete. All users have valid events.');
            return;
        }

        console.log(`\nSample users to delete:`);
        usersToDelete.slice(0, 5).forEach(u => console.log(`  - ${u.user_id}`));
        if (usersToDelete.length > 5) {
            console.log(`  ... and ${usersToDelete.length - 5} more`);
        }

        if (dryRun) {
            console.log('\n[DRY RUN] Would delete these users. Run without --dry-run to execute.');
        } else {
            // Delete in batches to avoid memory issues
            const BATCH_SIZE = 500;
            let deleted = 0;

            for (let i = 0; i < usersToDelete.length; i += BATCH_SIZE) {
                const batch = usersToDelete.slice(i, i + BATCH_SIZE);
                const ids = batch.map(u => u.user_id);
                const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(',');

                await pool.query(`DELETE FROM "user" WHERE user_id IN (${placeholders})`, ids);
                deleted += batch.length;
                console.log(`Deleted ${deleted}/${usersToDelete.length} users...`);
            }

            console.log(`\n✅ Cleanup complete! Deleted ${deleted} users.`);
        }

        // Show final stats
        const finalResult = await pool.query('SELECT COUNT(*) as cnt FROM "user"');
        console.log(`\nUsers remaining: ${finalResult.rows[0].cnt}`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

cleanup();
