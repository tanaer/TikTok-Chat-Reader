const { initDb, run, query, get } = require('../db');

(async () => {
    try {
        await initDb();
        console.log('=== Comprehensive Database Repair ===\n');

        // 1. Rebuild Missing Sessions (including blooming1881)
        console.log('[1/3] Rebuilding missing sessions...');
        const missingSessions = query(`
            SELECT DISTINCT e.session_id, e.room_id, 
                   COUNT(*) as cnt, MIN(timestamp) as minT, MAX(timestamp) as maxT
            FROM event e
            LEFT JOIN session s ON e.session_id = s.session_id
            WHERE e.session_id IS NOT NULL AND s.session_id IS NULL
            GROUP BY e.session_id, e.room_id
        `);

        if (missingSessions.length > 0) {
            console.log(`Found ${missingSessions.length} missing sessions:`);
            for (const ms of missingSessions) {
                console.log(`  - Fixing ${ms.room_id} (Session: ${ms.session_id}, Events: ${ms.cnt})`);

                // Double check if session exists (to be safe)
                const exists = get('SELECT 1 FROM session WHERE session_id = ?', [ms.session_id]);
                if (!exists) {
                    run(`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)`, [
                        ms.session_id,
                        ms.room_id,
                        ms.minT,
                        JSON.stringify({
                            rebuilt: true,
                            note: `Comprehensive Repair: Recovered ${ms.cnt} events`,
                            range: `${ms.minT} - ${ms.maxT}`
                        })
                    ]);
                    console.log(`    -> Created session record.`);
                }
            }
        } else {
            console.log('No missing sessions found.');
        }

        // 2. Archive Stale Live Events (looklook1023 check)
        console.log('\n[2/3] Checking for stale live events...');
        const liveRooms = query(`SELECT DISTINCT room_id FROM event WHERE session_id IS NULL`);

        for (const r of liveRooms) {
            const events = query(`
                SELECT timestamp FROM event WHERE room_id = ? AND session_id IS NULL ORDER BY timestamp ASC
            `, [r.room_id]);

            if (events.length > 0) {
                const first = new Date(events[0].timestamp);
                const last = new Date(events[events.length - 1].timestamp);
                const durationHours = (last - first) / 1000 / 3600;

                if (durationHours > 24) {
                    console.warn(`  ! Room ${r.room_id} has live events spanning ${durationHours.toFixed(1)} hours!`);
                    // Logic to split could be added here, but for now we focus on critical repairs
                }
            }
        }

        // 3. Cleanup Empty Sessions (Safety check)
        console.log('\n[3/3] cleaning up empty sessions...');
        const emptySessions = query(`
            SELECT s.session_id FROM session s
            LEFT JOIN event e ON s.session_id = e.session_id
            GROUP BY s.session_id
            HAVING COUNT(e.id) = 0
        `);
        if (emptySessions.length > 0) {
            console.log(`Deleting ${emptySessions.length} empty sessions...`);
            for (const s of emptySessions) {
                run('DELETE FROM session WHERE session_id = ?', [s.session_id]);
            }
        } else {
            console.log('No empty sessions found.');
        }

        console.log('\n=== Repair Complete ===');
        console.log('Changes synced to disk.');

    } catch (e) {
        console.error('Repair failed:', e);
        process.exit(1);
    }
})();
