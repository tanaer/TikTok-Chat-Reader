const { initDb, query, get } = require('../db');

(async () => {
    await initDb();
    const roomId = 'looklook1023';

    // Get range of current "live" events
    const liveStats = get(`
        SELECT MIN(timestamp) as startT, MAX(timestamp) as endT, COUNT(*) as cnt 
        FROM event 
        WHERE room_id = ? AND session_id IS NULL
    `, [roomId]);

    console.log('Current Live Stats (session_id IS NULL):');
    console.log(JSON.stringify(liveStats, null, 2));

    if (liveStats.startT) {
        const start = new Date(liveStats.startT);
        const end = new Date(liveStats.endT);
        const hours = (end - start) / 1000 / 3600;
        console.log(`Duration: ${hours.toFixed(2)} hours`);

        // Check for gaps > 10 minutes to see if multiple sessions are merged
        const events = query(`SELECT timestamp FROM event WHERE room_id = ? AND session_id IS NULL ORDER BY timestamp ASC`, [roomId]);
        let maxGap = 0;
        let gapIndex = -1;
        for (let i = 1; i < events.length; i++) {
            const diff = (new Date(events[i].timestamp) - new Date(events[i - 1].timestamp)) / 1000 / 60; // minutes
            if (diff > maxGap) {
                maxGap = diff;
                gapIndex = i;
            }
        }
        console.log(`Max gap between events: ${maxGap.toFixed(1)} minutes`);
        if (maxGap > 10) {
            console.log(`Potential break at index ${gapIndex}: ${events[gapIndex - 1].timestamp} -> ${events[gapIndex].timestamp}`);
        }
    }

    process.exit(0);
})();
