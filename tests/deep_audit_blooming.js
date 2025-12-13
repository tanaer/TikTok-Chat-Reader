const { initDb, query, get } = require('../db');

(async () => {
    await initDb();
    console.log('=== blooming1881 Deep Diagnostics ===');

    // 1. Check Session Table for this room
    const sessions = query(`SELECT * FROM session WHERE room_id = 'blooming1881' ORDER BY created_at DESC`);
    console.log(`\n[Session Table] Found ${sessions.length} records:`);
    sessions.forEach(s => console.log(`  - ID: ${s.session_id}, Created: ${s.created_at}, Info: ${s.snapshot_json}`));

    // 2. Check Event Table for this room (Group by Session ID)
    const eventStats = query(`
        SELECT session_id, COUNT(*) as cnt, MIN(timestamp) as minT, MAX(timestamp) as maxT 
        FROM event 
        WHERE room_id = 'blooming1881' 
        GROUP BY session_id
    `);
    console.log(`\n[Event Table] Stats by Session ID:`);
    eventStats.forEach(s => {
        const sid = s.session_id === null ? 'NULL (Live/Orphaned)' : s.session_id;
        console.log(`  - Session: ${sid}, Count: ${s.cnt}, Range: ${s.minT} ~ ${s.maxT}`);
    });

    // 3. Check for specific session ID 2025121199 (which we tried to recover earlier)
    const specificSession = get(`SELECT * FROM session WHERE session_id = '2025121199'`);
    console.log(`\n[Specific Check] Session 2025121199 exists? ${!!specificSession}`);
    if (specificSession) console.log('  ->', specificSession);

    // 4. Check if there are events with session_id='2025121199' but NO session record
    const orphanedEvents = get(`
        SELECT COUNT(*) as cnt 
        FROM event e
        LEFT JOIN session s ON e.session_id = s.session_id
        WHERE e.room_id = 'blooming1881' AND e.session_id = '2025121199' AND s.session_id IS NULL
    `);
    console.log(`\n[Integrity Check] Events with session_id='2025121199' but no session record: ${orphanedEvents.cnt}`);

    process.exit(0);
})();
