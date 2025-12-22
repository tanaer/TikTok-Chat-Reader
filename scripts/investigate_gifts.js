/**
 * Investigation: blooming1881 Dec 17 gift data issue
 */
require('dotenv').config();
const { Pool } = require('pg');

async function investigate() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    try {
        const roomId = 'blooming1881';
        const dateStart = '2025-12-17';
        const dateEnd = '2025-12-18';

        console.log(`=== Investigating ${roomId} on ${dateStart} ===\n`);

        // 1. Get all sessions for this room on Dec 17
        console.log('1. Sessions on Dec 17:');
        const sessions = await pool.query(`
            SELECT s.session_id, s.created_at,
                   COUNT(e.id) as event_count,
                   COUNT(CASE WHEN e.type='gift' THEN 1 END) as gift_count,
                   SUM(CASE WHEN e.type='gift' THEN COALESCE(e.diamond_count,0) * COALESCE(e.repeat_count,1) ELSE 0 END) as total_diamonds
            FROM session s
            LEFT JOIN event e ON e.session_id = s.session_id
            WHERE s.room_id = $1 
              AND s.created_at >= $2 
              AND s.created_at < $3
            GROUP BY s.session_id, s.created_at
            ORDER BY s.created_at
        `, [roomId, dateStart, dateEnd]);
        console.table(sessions.rows);

        // 2. Check for duplicate gift events (same user, same gift, same time)
        console.log('\n2. Checking for duplicate gift events:');
        const duplicates = await pool.query(`
            SELECT user_id, gift_id, timestamp, diamond_count, repeat_count, COUNT(*) as dup_count
            FROM event
            WHERE room_id = $1 
              AND type = 'gift'
              AND timestamp >= $2 
              AND timestamp < $3
            GROUP BY user_id, gift_id, timestamp, diamond_count, repeat_count
            HAVING COUNT(*) > 1
            ORDER BY dup_count DESC
            LIMIT 20
        `, [roomId, dateStart, dateEnd]);

        if (duplicates.rows.length > 0) {
            console.log(`FOUND ${duplicates.rows.length} duplicate groups!`);
            console.table(duplicates.rows);
        } else {
            console.log('No exact duplicates found.');
        }

        // 3. Check for events with same user_id, gift_id within 1 second (potential duplicates)
        console.log('\n3. Checking for near-duplicate gifts (same user+gift within 2 sec):');
        const nearDuplicates = await pool.query(`
            SELECT e1.id as id1, e2.id as id2, 
                   e1.user_id, e1.gift_id, e1.diamond_count, e1.repeat_count,
                   e1.timestamp as t1, e2.timestamp as t2
            FROM event e1
            JOIN event e2 ON e1.user_id = e2.user_id 
                         AND e1.gift_id = e2.gift_id 
                         AND e1.id < e2.id
                         AND ABS(EXTRACT(EPOCH FROM (e1.timestamp - e2.timestamp))) < 2
            WHERE e1.room_id = $1 
              AND e1.type = 'gift'
              AND e1.timestamp >= $2 
              AND e1.timestamp < $3
            ORDER BY e1.timestamp
            LIMIT 30
        `, [roomId, dateStart, dateEnd]);

        if (nearDuplicates.rows.length > 0) {
            console.log(`FOUND ${nearDuplicates.rows.length} near-duplicate pairs!`);
            console.table(nearDuplicates.rows);
        } else {
            console.log('No near-duplicates found.');
        }

        // 4. Look at the 23:05 session specifically
        console.log('\n4. Gift breakdown for session around 23:05:');
        const sessionGifts = await pool.query(`
            SELECT e.timestamp, e.user_id, e.nickname, e.gift_id, 
                   e.diamond_count, e.repeat_count,
                   (e.diamond_count * e.repeat_count) as value
            FROM event e
            JOIN session s ON e.session_id = s.session_id
            WHERE e.room_id = $1 
              AND e.type = 'gift'
              AND s.created_at >= $2 
              AND s.created_at < $3
              AND EXTRACT(HOUR FROM e.timestamp) = 23
            ORDER BY e.timestamp
            LIMIT 50
        `, [roomId, dateStart, dateEnd]);
        console.table(sessionGifts.rows);

        // 5. Total gifts summary
        console.log('\n5. Total gift value for Dec 17:');
        const total = await pool.query(`
            SELECT COUNT(*) as gift_events, 
                   SUM(COALESCE(diamond_count,0) * COALESCE(repeat_count,1)) as total_diamonds
            FROM event
            WHERE room_id = $1 
              AND type = 'gift'
              AND timestamp >= $2 
              AND timestamp < $3
        `, [roomId, dateStart, dateEnd]);
        console.log(total.rows[0]);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

investigate();
