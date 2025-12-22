/**
 * Final analysis: Why is blooming1881 still 1.39x higher than expected?
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

    try {
        console.log('=== Final Analysis: blooming1881 Dec 17 ===\n');
        console.log('Current value: 7,295 | Expected: 5,250 | Diff: 2,045\n');

        // Check if there are still duplicates (same user+gift in same minute with different repeatCount)
        const remaining = await pool.query(`
            SELECT user_id, gift_id, diamond_count,
                   DATE_TRUNC('minute', timestamp) as minute,
                   COUNT(*) as events,
                   array_agg(repeat_count ORDER BY repeat_count) as repeat_counts,
                   SUM(diamond_count * repeat_count) as total_value
            FROM event
            WHERE room_id = 'blooming1881' AND type = 'gift'
              AND timestamp >= '2025-12-17' AND timestamp < '2025-12-18'
            GROUP BY user_id, gift_id, diamond_count, DATE_TRUNC('minute', timestamp)
            HAVING COUNT(*) > 1
            ORDER BY total_value DESC
            LIMIT 20
        `);

        console.log('Remaining duplicates (same user+gift per minute with multiple events):');
        console.table(remaining.rows.map(r => ({
            user: r.user_id.slice(-6),
            gift: r.gift_id,
            minute: r.minute,
            events: r.events,
            repeats: r.repeat_counts.join(','),
            value: r.total_value
        })));

        // Sum up the extra value from duplicates
        let extraValue = 0;
        for (const row of remaining.rows) {
            // Expected: only highest repeatCount * diamond
            const maxRepeat = Math.max(...row.repeat_counts);
            const expected = parseInt(row.diamond_count) * maxRepeat;
            const actual = parseInt(row.total_value);
            extraValue += (actual - expected);
        }
        console.log(`\nExtra value from visible duplicates: ${extraValue}`);

        // Let's also check unique gift combos
        console.log('\n--- All gift combos (grouped by user+gift per hour) ---');
        const hourly = await pool.query(`
            SELECT DATE_TRUNC('hour', timestamp) as hour,
                   COUNT(*) as events,
                   SUM(diamond_count * repeat_count) as value
            FROM event
            WHERE room_id = 'blooming1881' AND type = 'gift'
              AND timestamp >= '2025-12-17' AND timestamp < '2025-12-18'
            GROUP BY DATE_TRUNC('hour', timestamp)
            ORDER BY hour
        `);
        console.table(hourly.rows);

        // Calculate what the value would be if we only counted the final repeat per combo
        // A combo = same user + same gift within sequential events (no gap > 30 sec)
        console.log('\n--- Simulating correct calculation ---');
        const allEvents = await pool.query(`
            SELECT id, user_id, gift_id, diamond_count, repeat_count, timestamp
            FROM event
            WHERE room_id = 'blooming1881' AND type = 'gift'
              AND timestamp >= '2025-12-17' AND timestamp < '2025-12-18'
            ORDER BY user_id, gift_id, timestamp
        `);

        let correctValue = 0;
        let currentCombo = null;
        let comboCount = 0;

        for (const event of allEvents.rows) {
            const key = `${event.user_id}_${event.gift_id}`;
            const ts = new Date(event.timestamp).getTime();

            if (currentCombo && currentCombo.key === key) {
                // Same user+gift
                const gap = ts - currentCombo.lastTime;
                if (gap <= 60000) { // Within 60 seconds = same combo
                    // Update combo with higher repeatCount
                    if (event.repeat_count > currentCombo.maxRepeat) {
                        currentCombo.maxRepeat = event.repeat_count;
                    }
                    currentCombo.lastTime = ts;
                } else {
                    // Gap too big, end previous combo and start new
                    correctValue += currentCombo.diamond * currentCombo.maxRepeat;
                    comboCount++;
                    currentCombo = {
                        key,
                        diamond: parseInt(event.diamond_count),
                        maxRepeat: event.repeat_count,
                        lastTime: ts
                    };
                }
            } else {
                // Different user or gift
                if (currentCombo) {
                    correctValue += currentCombo.diamond * currentCombo.maxRepeat;
                    comboCount++;
                }
                currentCombo = {
                    key,
                    diamond: parseInt(event.diamond_count),
                    maxRepeat: event.repeat_count,
                    lastTime: ts
                };
            }
        }
        // Don't forget the last combo
        if (currentCombo) {
            correctValue += currentCombo.diamond * currentCombo.maxRepeat;
            comboCount++;
        }

        console.log(`Corrected value (max repeat per 60-sec combo): ${correctValue}`);
        console.log(`Number of distinct combos: ${comboCount}`);
        console.log(`Ratio to expected (5250): ${(correctValue / 5250).toFixed(2)}x`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

analyze();
