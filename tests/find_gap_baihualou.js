const { initDb, query } = require('../db');

(async () => {
    await initDb();
    const events = query(`
        SELECT timestamp 
        FROM event 
        WHERE room_id = 'baihualou666' AND session_id IS NULL 
        ORDER BY timestamp ASC
    `);

    let maxGap = 0;
    let gapStart = null;
    let gapEnd = null;
    let prev = null;

    for (const e of events) {
        if (prev) {
            const diff = new Date(e.timestamp) - new Date(prev.timestamp);
            if (diff > maxGap) {
                maxGap = diff;
                gapStart = prev.timestamp;
                gapEnd = e.timestamp;
            }
        }
        prev = e;
    }

    console.log(`Max Gap: ${(maxGap / 1000 / 60).toFixed(2)} minutes`);
    console.log(`From: ${gapStart}`);
    console.log(`To:   ${gapEnd}`);
    process.exit(0);
})();
