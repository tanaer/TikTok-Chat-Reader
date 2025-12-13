const { initDb, query } = require('../db');

(async () => {
    await initDb();

    const sessions = query(`SELECT * FROM session WHERE room_id = 'suc.girlsvibe' ORDER BY created_at DESC LIMIT 10`);
    console.log('Sessions:', JSON.stringify(sessions, null, 2));

    const events = query(`SELECT session_id, COUNT(*) as cnt FROM event WHERE room_id = 'suc.girlsvibe' GROUP BY session_id`);
    console.log('Events by session:', JSON.stringify(events, null, 2));

    process.exit(0);
})();
