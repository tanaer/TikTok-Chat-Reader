const { initDb, run, query } = require('../db');

(async () => {
    await initDb();

    // Get blooming1881 session info
    const info = query(`
        SELECT MIN(timestamp) as minT, MAX(timestamp) as maxT, COUNT(*) as cnt 
        FROM event 
        WHERE room_id = 'blooming1881' AND session_id = '2025121199'
    `);

    console.log('Session info:', info[0]);

    // Create session record
    run(`INSERT INTO session (session_id, room_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)`, [
        '2025121199',
        'blooming1881',
        JSON.stringify({ recovered: true, note: `Recovered ${info[0].cnt} events` }),
        info[0].minT
    ]);

    console.log('Session recovered for blooming1881!');
    process.exit(0);
})();
