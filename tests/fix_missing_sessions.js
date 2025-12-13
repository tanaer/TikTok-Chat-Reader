const { initDb, run, query } = require('../db');

(async () => {
    await initDb();

    // Check existing sessions for suc.girlsvibe
    const existingSessions = query(`SELECT DISTINCT session_id FROM event WHERE room_id = 'suc.girlsvibe' AND session_id IS NOT NULL`);
    console.log('Event session IDs:', existingSessions);

    // Get session records
    const sessionRecords = query(`SELECT * FROM session WHERE room_id = 'suc.girlsvibe'`);
    console.log('Session records:', sessionRecords);

    // Create missing sessions
    for (const e of existingSessions) {
        const sid = e.session_id;
        const exists = query(`SELECT 1 FROM session WHERE session_id = ?`, [sid]);
        if (exists.length === 0) {
            console.log('Creating missing session:', sid);
            // Get time range for this session
            const timeRange = query(`SELECT MIN(timestamp) as minT, MAX(timestamp) as maxT, COUNT(*) as cnt FROM event WHERE room_id = 'suc.girlsvibe' AND session_id = ?`, [sid]);
            const snapshot = JSON.stringify({
                auto_generated: true,
                note: `Recovered session (${timeRange[0].cnt} events)`,
                startTime: timeRange[0].minT,
                endTime: timeRange[0].maxT
            });
            run(`INSERT INTO session (session_id, room_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)`,
                [sid, 'suc.girlsvibe', snapshot, timeRange[0].minT]);
            console.log('Created session:', sid);
        } else {
            console.log('Session exists:', sid);
        }
    }

    console.log('Done!');
    process.exit(0);
})();
