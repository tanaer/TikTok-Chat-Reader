const { initDb, query } = require('../db');

(async () => {
    await initDb();

    console.log('=== blooming1881 Data Check ===\n');

    const sessions = query(`SELECT * FROM session WHERE room_id = 'blooming1881'`);
    console.log('Sessions:', JSON.stringify(sessions, null, 2));

    const events = query(`SELECT session_id, type, COUNT(*) as cnt FROM event WHERE room_id = 'blooming1881' GROUP BY session_id, type`);
    console.log('\nEvents by session and type:', JSON.stringify(events, null, 2));

    const totalEvents = query(`SELECT COUNT(*) as total FROM event WHERE room_id = 'blooming1881'`);
    console.log('\nTotal events:', totalEvents[0].total);

    process.exit(0);
})();
