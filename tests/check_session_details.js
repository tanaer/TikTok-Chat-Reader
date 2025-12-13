const { initDb, query } = require('../db');

(async () => {
    await initDb();

    // Check keekeebaby4ever sessions
    const sessions = query(`
        SELECT s.session_id, s.room_id, s.created_at, s.snapshot_json
        FROM session s
        WHERE s.room_id = 'keekeebaby4ever'
        ORDER BY s.created_at DESC
    `);

    console.log(`\nFound ${sessions.length} sessions for keekeebaby4ever:\n`);

    for (const s of sessions) {
        const eventCounts = query(`
            SELECT type, COUNT(*) as cnt 
            FROM event 
            WHERE session_id = ? 
            GROUP BY type
        `, [s.session_id]);

        const totalEvents = eventCounts.reduce((sum, e) => sum + e.cnt, 0);

        console.log(`Session: ${s.session_id} (${s.created_at})`);
        console.log(`  Total Events: ${totalEvents}`);
        eventCounts.forEach(e => console.log(`    - ${e.type}: ${e.cnt}`));
        console.log('');
    }

    process.exit(0);
})();
