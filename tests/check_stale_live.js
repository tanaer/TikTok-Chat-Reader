const { initDb, query } = require('../db');

(async () => {
    await initDb();
    const rooms = ['baihualou666', 'blooming1881'];

    for (const r of rooms) {
        const events = query(`
            SELECT timestamp 
            FROM event 
            WHERE room_id = ? AND session_id IS NULL 
            ORDER BY timestamp ASC
        `, [r]);

        if (events.length > 0) {
            const start = new Date(events[0].timestamp);
            const end = new Date(events[events.length - 1].timestamp);
            const durationHrs = (end - start) / 1000 / 3600;

            console.log(`Room ${r}:`);
            console.log(`  Count: ${events.length}`);
            console.log(`  Start: ${events[0].timestamp}`);
            console.log(`  End:   ${events[events.length - 1].timestamp}`);
            console.log(`  Duration: ${durationHrs.toFixed(2)} hours`);
        } else {
            console.log(`Room ${r}: No live events found.`);
        }
    }
    process.exit(0);
})();
