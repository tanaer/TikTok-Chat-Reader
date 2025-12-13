const { initDb, query, run } = require('../db');

(async () => {
    await initDb();

    // Find sessions with no gift events
    const noGiftSessions = query(`
        SELECT s.session_id, s.room_id, s.created_at,
               COALESCE(total.cnt, 0) as total_events,
               COALESCE(gift.cnt, 0) as gift_count
        FROM session s
        LEFT JOIN (
            SELECT session_id, COUNT(*) as cnt FROM event GROUP BY session_id
        ) total ON s.session_id = total.session_id
        LEFT JOIN (
            SELECT session_id, COUNT(*) as cnt FROM event WHERE type = 'gift' GROUP BY session_id
        ) gift ON s.session_id = gift.session_id
        WHERE COALESCE(gift.cnt, 0) = 0
        ORDER BY s.created_at DESC
    `);

    console.log(`\nFound ${noGiftSessions.length} sessions with no gift events:\n`);
    noGiftSessions.forEach(s => console.log(`  - ${s.session_id} (${s.room_id}) - ${s.total_events} events, 0 gifts - ${s.created_at}`));

    if (noGiftSessions.length > 0) {
        console.log('\nDeleting sessions with no gifts and their events...');
        for (const s of noGiftSessions) {
            // Delete events first
            run('DELETE FROM event WHERE session_id = ?', [s.session_id]);
            // Then delete session
            run('DELETE FROM session WHERE session_id = ?', [s.session_id]);
            console.log(`Deleted: ${s.session_id} (${s.total_events} events)`);
        }
        console.log('\nDone!');
    }

    process.exit(0);
})();
