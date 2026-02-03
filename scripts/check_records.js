const db = require('../db');

async function check() {
    try {
        const records = await db.query("SELECT id, room_id, status FROM recording_task ORDER BY id DESC LIMIT 20");
        console.log('Current records:');
        records.forEach(r => console.log(`  ID: ${r.id}, room_id: "${r.room_id}", status: ${r.status}`));

        // Count undefined
        const undefinedCount = await db.get("SELECT COUNT(*) as cnt FROM recording_task WHERE room_id = 'undefined'");
        console.log(`\nRecords with room_id = 'undefined': ${undefinedCount.cnt}`);

        process.exit(0);
    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
}

check();
