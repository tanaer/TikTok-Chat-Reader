/**
 * Cleanup script: Delete all sessions without gift events
 * - Unlinks events from session (sets session_id to NULL, becomes orphan)
 * - Deletes session records
 * - Orphan events can be consolidated into future sessions with gifts
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
        console.log('Finding sessions without gift events...\n');

        // Find sessions with 0 gift events
        const noGiftSessions = await pool.query(`
            SELECT s.session_id, s.room_id,
                   COUNT(CASE WHEN e.type='gift' THEN 1 END) as gift_count,
                   COUNT(e.id) as total_events
            FROM session s
            LEFT JOIN event e ON e.session_id = s.session_id
            GROUP BY s.session_id, s.room_id
            HAVING COUNT(CASE WHEN e.type='gift' THEN 1 END) = 0
        `);

        console.log(`Found ${noGiftSessions.rows.length} sessions without gifts\n`);

        if (noGiftSessions.rows.length === 0) {
            console.log('No sessions to clean up!');
            return;
        }

        // Group by room for stats
        const roomStats = {};
        for (const s of noGiftSessions.rows) {
            roomStats[s.room_id] = (roomStats[s.room_id] || 0) + 1;
        }

        console.log('Sessions to delete by room:');
        const sortedRooms = Object.entries(roomStats).sort((a, b) => b[1] - a[1]);
        for (const [roomId, count] of sortedRooms.slice(0, 15)) {
            console.log(`  ${roomId}: ${count}`);
        }
        if (sortedRooms.length > 15) {
            console.log(`  ... and ${sortedRooms.length - 15} more rooms`);
        }

        const sessionIds = noGiftSessions.rows.map(s => s.session_id);

        console.log('\n--- Starting cleanup ---\n');

        // Step 1: Unlink events (set session_id to NULL → becomes orphan)
        const unlinkResult = await pool.query(`
            UPDATE event SET session_id = NULL 
            WHERE session_id = ANY($1::text[])
        `, [sessionIds]);
        console.log(`Step 1: Unlinked ${unlinkResult.rowCount} events from sessions`);

        // Step 2: Delete session records
        const deleteResult = await pool.query(`
            DELETE FROM session WHERE session_id = ANY($1::text[])
        `, [sessionIds]);
        console.log(`Step 2: Deleted ${deleteResult.rowCount} session records`);

        console.log('\n✅ Cleanup complete!');
        console.log(`   - ${deleteResult.rowCount} no-gift sessions removed`);
        console.log(`   - Events are now orphans (will be consolidated into future gift sessions)`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

cleanup();
