require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT) || 5432,
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root'
});

const roomId = process.argv[2] || 'wbjhvtey46d';

(async () => {
    try {
        console.log(`=== Session history for ${roomId} ===\n`);

        // Get all sessions with event time ranges
        const sessions = await pool.query(`
            SELECT s.session_id, s.room_id, s.created_at,
                   MIN(e.timestamp) as start_time,
                   MAX(e.timestamp) as end_time,
                   COUNT(e.id) as event_count
            FROM session s
            LEFT JOIN event e ON s.session_id = e.session_id
            WHERE s.room_id = $1 
            GROUP BY s.session_id, s.room_id, s.created_at
            ORDER BY s.created_at DESC
            LIMIT 20
        `, [roomId]);

        console.log(`Found ${sessions.rows.length} sessions:\n`);

        let prevStartTime = null;
        for (const s of sessions.rows) {
            const start = s.start_time ? new Date(s.start_time) : new Date(s.created_at);
            const end = s.end_time ? new Date(s.end_time) : null;
            const durationMins = end ? Math.round((end - start) / 60000) : 0;

            // Check gap from previous session (which is actually the NEXT one chronologically since we're DESC)
            let gap = '';
            if (prevStartTime && end) {
                const gapMs = prevStartTime - end;
                const gapMins = Math.round(gapMs / 60000);
                if (gapMins >= 0 && gapMins < 30) {
                    gap = ` ⚠️ Gap to next: ${gapMins} mins (< 30 mins, should merge!)`;
                } else if (gapMins >= 0) {
                    gap = ` (Gap to next: ${gapMins} mins)`;
                }
            }

            console.log(`Session ${s.session_id} (${s.event_count} events):`);
            console.log(`  Start: ${start.toLocaleString()}`);
            console.log(`  End: ${end ? end.toLocaleString() : 'no events'}`);
            console.log(`  Duration: ${durationMins} mins${gap}`);
            console.log('');

            prevStartTime = start;
        }

        // Check if there are events without session_id (live events)
        const liveEvents = await pool.query(`
            SELECT COUNT(*) as count, 
                   MIN(timestamp) as first_event,
                   MAX(timestamp) as last_event
            FROM event 
            WHERE room_id = $1 AND session_id IS NULL
        `, [roomId]);

        if (parseInt(liveEvents.rows[0].count) > 0) {
            console.log(`\n=== Live (unsession-ed) events ===`);
            console.log(`Count: ${liveEvents.rows[0].count}`);
            console.log(`First: ${new Date(liveEvents.rows[0].first_event).toLocaleString()}`);
            console.log(`Last: ${new Date(liveEvents.rows[0].last_event).toLocaleString()}`);

            // Check gaps in live events
            const liveGaps = await pool.query(`
                WITH ordered_events AS (
                    SELECT timestamp, 
                           LAG(timestamp) OVER (ORDER BY timestamp) as prev_ts
                    FROM event 
                    WHERE room_id = $1 AND session_id IS NULL
                )
                SELECT timestamp, prev_ts, 
                       EXTRACT(EPOCH FROM (timestamp - prev_ts)) / 60 as gap_mins
                FROM ordered_events
                WHERE EXTRACT(EPOCH FROM (timestamp - prev_ts)) / 60 > 10
                ORDER BY gap_mins DESC
                LIMIT 5
            `, [roomId]);

            if (liveGaps.rows.length > 0) {
                console.log(`\nLarge gaps in live events (> 10 mins):`);
                for (const g of liveGaps.rows) {
                    console.log(`  ${new Date(g.prev_ts).toLocaleString()} -> ${new Date(g.timestamp).toLocaleString()} = ${Math.round(g.gap_mins)} mins`);
                }
            }
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
        process.exit(0);
    }
})();
