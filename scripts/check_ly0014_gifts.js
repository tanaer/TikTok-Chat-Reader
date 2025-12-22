require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT) || 5432,
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root'
});

(async () => {
    try {
        const roomId = 'ly.0014';

        console.log(`=== Checking room ${roomId} for gift events ===\n`);

        // Check recent live gift events
        const gifts = await pool.query(`
            SELECT id, timestamp, nickname, diamond_count, repeat_count, 
                   data_json::json->>'giftName' as gift_name
            FROM event 
            WHERE room_id = $1 AND type = 'gift' AND session_id IS NULL 
            ORDER BY timestamp DESC 
            LIMIT 15
        `, [roomId]);

        console.log('Recent live gift events:');
        if (gifts.rows.length === 0) {
            console.log('  No live gift events found!\n');
        } else {
            for (const g of gifts.rows) {
                console.log(`  [${g.timestamp}] ${g.nickname}: ${g.gift_name} x${g.repeat_count} 💎${g.diamond_count * g.repeat_count}`);
            }
        }

        // Check total gift value
        const totals = await pool.query(`
            SELECT COUNT(*) as gift_count, 
                   SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_value
            FROM event 
            WHERE room_id = $1 AND type = 'gift' AND session_id IS NULL
        `, [roomId]);
        console.log('\nTotal live gifts:', totals.rows[0].gift_count);
        console.log('Total live value:', totals.rows[0].total_value);

        // Check if there are ANY events for this room
        const allEvents = await pool.query(`
            SELECT type, COUNT(*) as cnt 
            FROM event 
            WHERE room_id = $1 AND session_id IS NULL 
            GROUP BY type
        `, [roomId]);
        console.log('\nAll live events by type:');
        for (const e of allEvents.rows) {
            console.log(`  - ${e.type}: ${e.cnt}`);
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
        process.exit(0);
    }
})();
