/**
 * Cleanup Empty Sessions Script
 * Removes sessions with 0 events (false positive live detections)
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root',
});

async function cleanupEmptySessions() {
    console.log('[Cleanup] Starting empty session cleanup...');

    try {
        // Find sessions with 0 events
        const findQuery = `
            SELECT s.session_id, s.room_id, s.created_at
            FROM session s
            LEFT JOIN event e ON e.session_id = s.session_id
            GROUP BY s.session_id, s.room_id, s.created_at
            HAVING COUNT(e.id) = 0
            ORDER BY s.created_at DESC
        `;

        const emptySessionsResult = await pool.query(findQuery);
        const emptySessions = emptySessionsResult.rows;

        console.log(`[Cleanup] Found ${emptySessions.length} empty sessions to remove`);

        if (emptySessions.length === 0) {
            console.log('[Cleanup] No empty sessions found. Done.');
            await pool.end();
            return;
        }

        // Group by room for logging
        const byRoom = {};
        emptySessions.forEach(s => {
            byRoom[s.room_id] = (byRoom[s.room_id] || 0) + 1;
        });

        console.log('[Cleanup] Empty sessions by room:');
        Object.entries(byRoom).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([room, count]) => {
            console.log(`  - ${room}: ${count} empty sessions`);
        });

        // Delete empty sessions
        const sessionIds = emptySessions.map(s => s.session_id);
        const deleteQuery = `DELETE FROM session WHERE session_id = ANY($1)`;

        const result = await pool.query(deleteQuery, [sessionIds]);
        console.log(`[Cleanup] Deleted ${result.rowCount} empty sessions`);

        console.log('[Cleanup] Done!');

    } catch (error) {
        console.error('[Cleanup] Error:', error);
    } finally {
        await pool.end();
    }
}

cleanupEmptySessions();
