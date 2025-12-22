/**
 * Debug: Check what field names db.js returns
 */
require('dotenv').config();
const { initDb, query } = require('../db');

const roomId = process.argv[2] || 'wbjhvtey46d';

(async () => {
    try {
        await initDb();

        const sessions = await query(`
            SELECT session_id, created_at,
                   (SELECT MIN(timestamp) FROM event WHERE session_id = session.session_id) as start_time,
                   (SELECT MAX(timestamp) FROM event WHERE session_id = session.session_id) as end_time
            FROM session 
            WHERE room_id = ?
            ORDER BY created_at ASC
            LIMIT 2
        `, [roomId]);

        console.log('=== Session data from db.js query ===\n');
        console.log('First session:');
        console.log('  Keys:', Object.keys(sessions[0]));
        console.log('  Data:', sessions[0]);

        console.log('\nField check:');
        console.log('  sessions[0].start_time:', sessions[0].start_time);
        console.log('  sessions[0].startTime:', sessions[0].startTime);
        console.log('  sessions[0].end_time:', sessions[0].end_time);
        console.log('  sessions[0].endTime:', sessions[0].endTime);
        console.log('  sessions[0].session_id:', sessions[0].session_id);
        console.log('  sessions[0].sessionId:', sessions[0].sessionId);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit(0);
    }
})();
