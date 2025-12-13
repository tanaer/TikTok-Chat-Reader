const { initDb, run, query, get } = require('../db');

(async () => {
    await initDb();

    const roomId = 'looklook1023';
    const today = '2025-12-13';

    // Check events from before today
    const oldEvents = get(`
        SELECT COUNT(*) as cnt, MIN(timestamp) as minT, MAX(timestamp) as maxT
        FROM event 
        WHERE room_id = ? AND session_id IS NULL AND DATE(timestamp) < ?
    `, [roomId, today]);

    console.log('Old events (before today):', oldEvents);

    if (oldEvents.cnt > 0) {
        // Create a session for old events
        const sessionId = '2025121299'; // Use a distinct session ID for yesterday's data

        // Check if session exists
        const existing = get(`SELECT * FROM session WHERE session_id = ? AND room_id = ?`, [sessionId, roomId]);

        if (!existing) {
            run(`INSERT INTO session (session_id, room_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)`, [
                sessionId,
                roomId,
                JSON.stringify({ auto_generated: true, note: `Archived ${oldEvents.cnt} old events` }),
                oldEvents.minT
            ]);
            console.log('Created session:', sessionId);
        }

        // Tag old events with this session
        run(`UPDATE event SET session_id = ? WHERE room_id = ? AND session_id IS NULL AND DATE(timestamp) < ?`,
            [sessionId, roomId, today]);

        console.log(`Tagged ${oldEvents.cnt} events with session ${sessionId}`);
    }

    // Verify current live events
    const liveNow = get(`
        SELECT COUNT(*) as cnt, MIN(timestamp) as minT, MAX(timestamp) as maxT
        FROM event 
        WHERE room_id = ? AND session_id IS NULL
    `, [roomId]);

    console.log('\nCurrent live events:', liveNow);

    process.exit(0);
})();
