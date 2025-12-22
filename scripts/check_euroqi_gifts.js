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
        const roomId = 'euroqi.l';

        console.log(`=== Checking recent gifts for ${roomId} ===\n`);

        // Check recent gift events
        const gifts = await pool.query(`
            SELECT id, timestamp, nickname, diamond_count, repeat_count, 
                   data_json::json->>'giftName' as gift_name,
                   data_json::json->>'groupId' as group_id,
                   data_json::json->>'repeatEnd' as repeat_end
            FROM event 
            WHERE room_id = $1 AND type = 'gift' AND session_id IS NULL 
            ORDER BY timestamp DESC 
            LIMIT 20
        `, [roomId]);

        console.log('Recent live gift events:');
        if (gifts.rows.length === 0) {
            console.log('  No live gift events found!\n');
        } else {
            for (const g of gifts.rows) {
                const value = g.diamond_count * g.repeat_count;
                console.log(`  [${g.timestamp}] ${g.nickname}: ${g.gift_name} x${g.repeat_count} 💎${value} (groupId=${g.group_id}, repeatEnd=${g.repeat_end})`);
            }
        }

        // Check for GG gifts specifically
        const ggGifts = await pool.query(`
            SELECT id, timestamp, nickname, diamond_count, repeat_count
            FROM event 
            WHERE room_id = $1 AND type = 'gift' 
              AND data_json::json->>'giftName' ILIKE '%GG%'
            ORDER BY timestamp DESC 
            LIMIT 10
        `, [roomId]);

        console.log(`\nGG gifts in ${roomId}:`, ggGifts.rows.length);
        for (const g of ggGifts.rows) {
            console.log(`  [${g.timestamp}] ${g.nickname}: GG x${g.repeat_count} 💎${g.diamond_count * g.repeat_count}`);
        }

        // Total gift value
        const totals = await pool.query(`
            SELECT COUNT(*) as gift_count, 
                   SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_value
            FROM event 
            WHERE room_id = $1 AND type = 'gift' AND session_id IS NULL
        `, [roomId]);
        console.log('\nTotal live gifts:', totals.rows[0].gift_count);
        console.log('Total live value:', totals.rows[0].total_value);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
        process.exit(0);
    }
})();
