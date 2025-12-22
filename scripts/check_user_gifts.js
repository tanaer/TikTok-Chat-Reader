const { initDb, query, get } = require('../db');

const users = ['lry0801', 'jason021016', 'timbotron65', 'wei330903'];

(async () => {
    await initDb();

    for (const u of users) {
        console.log(`\n=== Checking ${u} ===`);

        // Get user_id first
        const userRes = await query(
            'SELECT user_id FROM "user" WHERE unique_id = ?',
            [u]
        );

        if (userRes.length === 0) {
            console.log('User not found in user table');
            continue;
        }

        const userId = userRes[0].userId;
        console.log('user_id:', userId);

        // Check for Rose and TikTok gifts specifically (extract from data_json)
        const giftRes = await query(`
            SELECT data_json::json->>'giftName' as gift_name, 
                   COUNT(*) as cnt,
                   SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total
            FROM event 
            WHERE user_id = ? 
              AND type = 'gift' 
              AND LOWER(data_json::json->>'giftName') IN ('rose', 'tiktok')
            GROUP BY data_json::json->>'giftName'
        `, [userId]);

        if (giftRes.length === 0) {
            console.log('No Rose or TikTok gifts found');
        } else {
            giftRes.forEach(g => {
                console.log(`${g.giftName}: ${g.cnt} times = ${g.total} 💎`);
            });
        }

        // Also show top 5 gifts
        const topRes = await query(`
            SELECT data_json::json->>'giftName' as gift_name, 
                   COUNT(*) as cnt,
                   SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total
            FROM event 
            WHERE user_id = ? AND type = 'gift'
            GROUP BY data_json::json->>'giftName'
            ORDER BY total DESC
            LIMIT 5
        `, [userId]);

        console.log('Top 5 gifts:');
        topRes.forEach(g => {
            console.log(`  ${g.giftName}: ${g.cnt}x = ${g.total} 💎`);
        });
    }

    console.log('\nDone!');
    process.exit(0);
})().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
