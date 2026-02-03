const db = require('../db');

async function check() {
    const tasks = await db.query("SELECT id, room_id, status, start_time FROM recording_task ORDER BY id DESC LIMIT 5");
    console.log('Current recording tasks:');
    tasks.forEach(t => {
        console.log(`  ID: ${t.id}, room_id: "${t.room_id}" (type: ${typeof t.room_id}), status: ${t.status}`);
    });
    process.exit(0);
}

check();
