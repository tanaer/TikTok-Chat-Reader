const { initDb, query, run } = require('../db');

(async () => {
    await initDb();

    // Find empty sessions
    const emptySessions = query(`
        SELECT s.session_id, s.room_id, s.created_at
        FROM session s
        LEFT JOIN event e ON s.session_id = e.session_id
        GROUP BY s.session_id
        HAVING COUNT(e.id) = 0
    `);

    console.log(`Found ${emptySessions.length} empty sessions:`);
    emptySessions.forEach(s => console.log(`  - ${s.session_id} (${s.room_id}) - ${s.created_at}`));

    if (emptySessions.length > 0) {
        console.log('\nDeleting empty sessions...');
        for (const s of emptySessions) {
            run('DELETE FROM session WHERE session_id = ?', [s.session_id]);
            console.log(`Deleted: ${s.session_id}`);
        }
        console.log('Done!');
    }

    process.exit(0);
})();
