const { initDb, query } = require('../db');

(async () => {
    await initDb();

    console.log('=== looklook1023 Data Check ===\n');

    // Check current live events (session_id IS NULL)
    const liveEvents = query(`
        SELECT type, COUNT(*) as cnt, MIN(timestamp) as first, MAX(timestamp) as last
        FROM event 
        WHERE room_id = 'looklook1023' AND session_id IS NULL
        GROUP BY type
    `);
    console.log('Live events (session_id IS NULL):', JSON.stringify(liveEvents, null, 2));

    // Check gift events specifically
    const giftEvents = query(`
        SELECT * FROM event 
        WHERE room_id = 'looklook1023' AND type = 'gift' AND session_id IS NULL
        ORDER BY timestamp DESC
        LIMIT 5
    `);
    console.log('\nRecent gift events:', JSON.stringify(giftEvents.map(e => ({
        timestamp: e.timestamp,
        diamond_count: e.diamond_count,
        repeat_count: e.repeat_count,
        data_json: e.data_json ? JSON.parse(e.data_json) : null
    })), null, 2));

    // Check all sessions
    const sessions = query(`SELECT * FROM session WHERE room_id = 'looklook1023' ORDER BY created_at DESC`);
    console.log('\nSessions:', JSON.stringify(sessions, null, 2));

    process.exit(0);
})();
