const { initDb, run, query, get } = require('../db');

(async () => {
    await initDb();
    const TARGET_ROOM = 'blooming1881';
    const OLD_SESSION_ID = '2025121199';

    // 1. Check if events exist for this room/session
    const events = query(`
        SELECT COUNT(*) as cnt, MIN(timestamp) as minT 
        FROM event 
        WHERE room_id = ? AND session_id = ?
    `, [TARGET_ROOM, OLD_SESSION_ID]);

    if (events[0].cnt > 0) {
        console.log(`Found ${events[0].cnt} events for ${TARGET_ROOM} with shared ID ${OLD_SESSION_ID}`);

        // 2. Generate new unique session ID
        let newSessionId = '2025121198'; // Try 98, 97...
        while (get(`SELECT 1 FROM session WHERE session_id = ?`, [newSessionId])) {
            newSessionId = (parseInt(newSessionId) - 1).toString();
        }

        console.log(`Assigning new unique Session ID: ${newSessionId}`);

        // 3. Create Session Record
        run(`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)`, [
            newSessionId,
            TARGET_ROOM,
            events[0].minT,
            JSON.stringify({
                rebuilt: true,
                note: `Fixed ID collision (was ${OLD_SESSION_ID})`,
                recovered_events: events[0].cnt
            })
        ]);

        // 4. Update Events
        run(`UPDATE event SET session_id = ? WHERE room_id = ? AND session_id = ?`,
            [newSessionId, TARGET_ROOM, OLD_SESSION_ID]);

        console.log('Fixed!');
    } else {
        console.log('No events found needing fix.');
    }

    process.exit(0);
})();
