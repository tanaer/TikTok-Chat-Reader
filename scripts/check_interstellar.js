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
        const giftName = 'Interstellar';

        console.log(`=== Searching for ${giftName} in room ${roomId} ===\n`);

        // Check if there's ANY Interstellar gift in the entire database
        const allInterstellar = await pool.query(`
            SELECT id, room_id, timestamp, diamond_count, repeat_count, 
                   data_json::json->>'groupId' as group_id,
                   data_json::json->>'repeatEnd' as repeat_end,
                   data_json::json->>'giftType' as gift_type
            FROM event 
            WHERE type = 'gift' 
              AND data_json::json->>'giftName' ILIKE '%interstellar%'
            ORDER BY timestamp DESC 
            LIMIT 20
        `);

        console.log('All Interstellar gifts in database:', allInterstellar.rows.length);
        for (const g of allInterstellar.rows) {
            console.log(`  [${g.timestamp}] Room: ${g.room_id}, 💎${g.diamond_count}x${g.repeat_count}, groupId=${g.group_id}, repeatEnd=${g.repeat_end}, type=${g.gift_type}`);
        }

        // Check for today's gifts in ly.0014 with diamondCount >= 1000
        const today = new Date().toISOString().slice(0, 10);
        const highValueGifts = await pool.query(`
            SELECT id, timestamp, nickname, diamond_count, repeat_count,
                   data_json::json->>'giftName' as gift_name,
                   data_json::json->>'groupId' as group_id,
                   data_json::json->>'repeatEnd' as repeat_end
            FROM event 
            WHERE room_id = $1 
              AND type = 'gift' 
              AND DATE(timestamp) = $2
              AND (diamond_count * repeat_count) >= 1000
            ORDER BY (diamond_count * repeat_count) DESC
            LIMIT 10
        `, [roomId, today]);

        console.log(`\nHigh-value gifts (>=1000💎) in ${roomId} today:`, highValueGifts.rows.length);
        for (const g of highValueGifts.rows) {
            console.log(`  [${g.timestamp}] ${g.nickname}: ${g.gift_name} 💎${g.diamond_count * g.repeat_count}`);
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
        process.exit(0);
    }
})();
