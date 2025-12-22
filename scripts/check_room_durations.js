const { initDb, query } = require('../db');

(async () => {
    await initDb();

    console.log('\n=== Checking all rooms with unarchived events ===\n');

    const rooms = await query(`
        SELECT room_id, 
               COUNT(*) as cnt, 
               MIN(timestamp) as first_ts, 
               MAX(timestamp) as last_ts,
               EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 3600 as hours
        FROM event 
        WHERE session_id IS NULL 
        GROUP BY room_id 
        ORDER BY cnt DESC
    `);

    console.log(`Found ${rooms.length} rooms with unarchived events:\n`);

    for (const r of rooms) {
        const first = new Date(r.firstTs);
        const last = new Date(r.lastTs);
        const hours = parseFloat(r.hours) || 0;
        console.log(`📺 ${r.roomId}`);
        console.log(`   Events: ${r.cnt}`);
        console.log(`   First: ${first.toLocaleString('zh-CN')}`);
        console.log(`   Last:  ${last.toLocaleString('zh-CN')}`);
        console.log(`   Span:  ${hours.toFixed(2)} hours`);

        if (hours > 12) {
            console.log(`   ⚠️ WARNING: Duration > 12 hours - may need review`);
        }
        console.log('');
    }

    console.log('Done!');
    process.exit(0);
})().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
