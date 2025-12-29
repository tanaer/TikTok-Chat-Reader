const { Pool } = require('pg');

const pool = new Pool({
    host: '14.215.39.218',
    port: 48499,
    user: 'postgres',
    password: 'qq123456',
    database: 'tkmonitor',
    connectionTimeoutMillis: 30000
});

async function analyze() {
    try {
        console.log('Connecting to database...');

        // Total gifts in gift table
        const r1 = await pool.query('SELECT COUNT(*) as cnt FROM gift');
        console.log('Total gifts in gift table:', r1.rows[0].cnt);

        // Sample from gift table
        const r2 = await pool.query('SELECT gift_id, name_en, name_cn FROM gift LIMIT 5');
        console.log('Sample gifts:', r2.rows);

        // Missing gift IDs with count
        const r3 = await pool.query(`
            SELECT e.gift_id, COUNT(*) as cnt 
            FROM event e 
            LEFT JOIN gift g ON e.gift_id = g.gift_id 
            WHERE e.type='gift' AND e.gift_id IS NOT NULL AND g.gift_id IS NULL 
            GROUP BY e.gift_id 
            ORDER BY cnt DESC LIMIT 10
        `);
        console.log('Missing gift_ids (not in gift table):', r3.rows);

        // Check if data_json has gift info for missing gifts
        const r4 = await pool.query(`
            SELECT gift_id, 
                   data_json::json->>'giftName' as gift_name,
                   data_json::json->>'giftPictureUrl' as icon_url,
                   diamond_count
            FROM event 
            WHERE type='gift' AND gift_id IS NOT NULL 
                  AND data_json IS NOT NULL 
                  AND data_json::json->>'giftName' IS NOT NULL
            LIMIT 10
        `);
        console.log('Sample events with data_json gift info:', r4.rows);

        await pool.end();
        console.log('Done.');
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

analyze();
