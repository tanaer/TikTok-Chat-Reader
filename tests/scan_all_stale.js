const { initDb, query } = require('../db');

(async () => {
    await initDb();
    const rooms = query('SELECT DISTINCT room_id FROM event WHERE session_id IS NULL');

    console.log(`Checking ${rooms.length} rooms with live events...`);

    for (const r of rooms) {
        const events = query(`
            SELECT timestamp 
            FROM event 
            WHERE room_id = ? AND session_id IS NULL 
            ORDER BY timestamp ASC
        `, [r.room_id]);

        if (events.length > 0) {
            const start = new Date(events[0].timestamp);
            const end = new Date(events[events.length - 1].timestamp);
            const now = new Date();

            const durationHrs = (end - start) / 1000 / 3600;
            const silenceHrs = (now - end) / 1000 / 3600;

            // Flag if duration > 12h OR (Duration > 1h AND Silence > 1h)
            if (durationHrs > 12 || (durationHrs > 0.5 && silenceHrs > 1)) {
                console.log(`[ANOMALY] Room ${r.room_id}:`);
                console.log(`   Start: ${events[0].timestamp}`);
                console.log(`   End:   ${events[events.length - 1].timestamp}`);
                console.log(`   Duration: ${durationHrs.toFixed(2)}h`);
                console.log(`   Silence:  ${silenceHrs.toFixed(2)}h (Time since last event)`);
                console.log('-----------------------------------');
            }
        }
    }
    process.exit(0);
})();
