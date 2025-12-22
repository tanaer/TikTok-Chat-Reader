/**
 * Debug merge sessions
 */
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
const gapMinutes = parseInt(process.argv[3]) || 30;

(async () => {
    try {
        console.log(`=== Debug merge for ${roomId} (Gap < ${gapMinutes} mins) ===\n`);

        const sessions = await pool.query(`
            SELECT session_id, created_at,
                   (SELECT MIN(timestamp) FROM event WHERE session_id = session.session_id) as start_time,
                   (SELECT MAX(timestamp) FROM event WHERE session_id = session.session_id) as end_time
            FROM session 
            WHERE room_id = $1
            ORDER BY created_at ASC
        `, [roomId]);

        console.log(`Found ${sessions.rows.length} sessions:\n`);

        const gapMs = gapMinutes * 60 * 1000;

        for (let i = 0; i < sessions.rows.length; i++) {
            const s = sessions.rows[i];
            console.log(`Session ${i}: ${s.session_id}`);
            console.log(`  start_time: ${s.start_time} (${typeof s.start_time})`);
            console.log(`  end_time: ${s.end_time} (${typeof s.end_time})`);

            if (i > 0) {
                const prev = sessions.rows[i - 1];
                if (prev.end_time && s.start_time) {
                    const prevEnd = new Date(prev.end_time).getTime();
                    const currStart = new Date(s.start_time).getTime();
                    const gap = currStart - prevEnd;
                    const gapMins = gap / 1000 / 60;

                    const prevDay = prev.start_time instanceof Date
                        ? prev.start_time.toISOString().slice(0, 10)
                        : String(prev.start_time).slice(0, 10);
                    const currDay = s.start_time instanceof Date
                        ? s.start_time.toISOString().slice(0, 10)
                        : String(s.start_time).slice(0, 10);

                    console.log(`  Gap from prev: ${gapMins.toFixed(1)} mins`);
                    console.log(`  Days: prev=${prevDay}, curr=${currDay}`);

                    if (prevDay === currDay && gap < gapMs && gap >= 0) {
                        console.log(`  ✅ SHOULD MERGE!`);
                    } else if (gap < 0) {
                        console.log(`  ⚠️ OVERLAP (negative gap)`);
                    }
                }
            }
            console.log('');
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
        process.exit(0);
    }
})();
