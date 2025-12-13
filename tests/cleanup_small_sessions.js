const { initDb, query, run } = require('../db');

const MIN_EVENTS = 10; // Sessions with fewer events will be deleted

(async () => {
    await initDb();

    // Find sessions with very few events
    const smallSessions = query(`
        SELECT s.session_id, s.room_id, s.created_at, COALESCE(cnt, 0) as event_count
        FROM session s
        LEFT JOIN (
            SELECT session_id, COUNT(*) as cnt FROM event GROUP BY session_id
        ) e ON s.session_id = e.session_id
        WHERE COALESCE(cnt, 0) < ?
        ORDER BY s.created_at DESC
    `, [MIN_EVENTS]);

    console.log(`\nFound ${smallSessions.length} sessions with < ${MIN_EVENTS} events:\n`);
    smallSessions.forEach(s => console.log(`  - ${s.session_id} (${s.room_id}) - ${s.event_count} events - ${s.created_at}`));

    if (smallSessions.length > 0) {
        console.log('\nDeleting small sessions and their events...');
        for (const s of smallSessions) {
            // Delete events first
            run('DELETE FROM event WHERE session_id = ?', [s.session_id]);
            // Then delete session
            run('DELETE FROM session WHERE session_id = ?', [s.session_id]);
            console.log(`Deleted: ${s.session_id} (${s.event_count} events)`);
        }
        console.log('\nDone!');
    }

    process.exit(0);
})();
