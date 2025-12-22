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
        // Check all-time gift values (without session_id filter)
        const allTime = await pool.query(`
            SELECT room_id, SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as val 
            FROM event 
            WHERE type = 'gift'
            GROUP BY room_id 
            ORDER BY val DESC 
            LIMIT 10
        `);

        console.log('All-time gift values (top 10):');
        for (const r of allTime.rows) {
            console.log(`  ${r.room_id}: ${r.val}`);
        }

        // Check current session gift values 
        const current = await pool.query(`
            SELECT room_id, SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as val 
            FROM event 
            WHERE type = 'gift' AND session_id IS NULL
            GROUP BY room_id 
            ORDER BY val DESC 
            LIMIT 10
        `);

        console.log('\nCurrent session gift values (top 10):');
        for (const r of current.rows) {
            console.log(`  ${r.room_id}: ${r.val}`);
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
        process.exit(0);
    }
})();
