/**
 * Deep analysis for blooming1881 Dec 17 to understand why value is still inflated
 */
require('dotenv').config();
const { Pool } = require('pg');

async function analyze() {
    const pool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT) || 5432,
        database: process.env.PG_DATABASE || 'tkmonitor',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || 'root'
    });

    const roomId = 'blooming1881';
    const dateStart = '2025-12-17';
    const dateEnd = '2025-12-18';

    try {
        console.log('=== Deep Analysis: blooming1881 Dec 17 ===\n');
        console.log('Expected actual value: 5,250 diamonds\n');

        // 1. Current total
        const total = await pool.query(`
            SELECT COUNT(*) as events, SUM(diamond_count * repeat_count) as total_value
            FROM event
            WHERE room_id = $1 AND type = 'gift' AND timestamp >= $2 AND timestamp < $3
        `, [roomId, dateStart, dateEnd]);
        console.log('Current DB values:', total.rows[0]);
        console.log(`Inflation ratio: ${(total.rows[0].total_value / 5250).toFixed(2)}x\n`);

        // 2. Top contributors to the inflation
        const topUsers = await pool.query(`
            SELECT user_id, 
                   COUNT(*) as events, 
                   SUM(diamond_count * repeat_count) as contributed_value,
                   COUNT(DISTINCT gift_id) as unique_gifts
            FROM event
            WHERE room_id = $1 AND type = 'gift' AND timestamp >= $2 AND timestamp < $3
            GROUP BY user_id
            ORDER BY contributed_value DESC
            LIMIT 10
        `, [roomId, dateStart, dateEnd]);
        console.log('Top 10 users by contributed value:');
        console.table(topUsers.rows);

        // 3. For top user, look at their gift pattern
        const topUserId = topUsers.rows[0]?.user_id;
        if (topUserId) {
            console.log(`\n--- Analyzing top user: ${topUserId} ---`);
            const userGifts = await pool.query(`
                SELECT gift_id, diamond_count, 
                       COUNT(*) as events,
                       SUM(diamond_count * repeat_count) as value,
                       MAX(repeat_count) as max_repeat,
                       array_agg(repeat_count ORDER BY timestamp) as repeat_sequence
                FROM event
                WHERE room_id = $1 AND type = 'gift' AND user_id = $2 
                  AND timestamp >= $3 AND timestamp < $4
                GROUP BY gift_id, diamond_count
                ORDER BY value DESC
            `, [roomId, topUserId, dateStart, dateEnd]);
            console.table(userGifts.rows.slice(0, 5));

            // Show repeat_sequence for first gift
            if (userGifts.rows[0]) {
                console.log(`\nRepeat sequence example (gift ${userGifts.rows[0].gift_id}):`);
                console.log(userGifts.rows[0].repeat_sequence);
            }
        }

        // 4. Key insight: count by repeat_count value
        console.log('\n--- Distribution of repeat_count values ---');
        const repeatDist = await pool.query(`
            SELECT repeat_count, COUNT(*) as cnt, SUM(diamond_count * repeat_count) as value
            FROM event
            WHERE room_id = $1 AND type = 'gift' AND timestamp >= $2 AND timestamp < $3
            GROUP BY repeat_count
            ORDER BY repeat_count
        `, [roomId, dateStart, dateEnd]);
        console.table(repeatDist.rows);

        // 5. Show what correct calculation should be
        // For combo gifts: only count the last (highest) repeat_count per combo sequence
        console.log('\n--- Attempting correct calculation ---');
        console.log('For combo gifts, we should only count the FINAL repeatCount per sequence.');
        console.log('A sequence is: same user + same gift + events within ~5 seconds interval.\n');

        // This gives us the MAX repeat_count per user+gift per ~5 second window
        const correctedValue = await pool.query(`
            WITH gift_windows AS (
                SELECT user_id, gift_id, diamond_count, repeat_count, timestamp,
                       -- Create a window ID that groups events within 5 seconds
                       SUM(CASE WHEN timestamp - LAG(timestamp) OVER (PARTITION BY user_id, gift_id ORDER BY timestamp) > INTERVAL '5 seconds' 
                                THEN 1 ELSE 0 END) 
                           OVER (PARTITION BY user_id, gift_id ORDER BY timestamp) as window_id
                FROM event
                WHERE room_id = $1 AND type = 'gift' AND timestamp >= $2 AND timestamp < $3
            ),
            max_per_window AS (
                SELECT user_id, gift_id, diamond_count, MAX(repeat_count) as max_repeat
                FROM gift_windows
                GROUP BY user_id, gift_id, diamond_count, window_id
            )
            SELECT SUM(diamond_count * max_repeat) as corrected_total,
                   COUNT(*) as distinct_combos
            FROM max_per_window
        `, [roomId, dateStart, dateEnd]);
        console.log('Corrected calculation (max repeat per combo window):');
        console.log(correctedValue.rows[0]);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

analyze();
