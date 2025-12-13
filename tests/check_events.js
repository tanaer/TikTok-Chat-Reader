const { query, initDb } = require('../db');

async function checkEventData() {
    await initDb();

    // Check total events
    const total = query('SELECT COUNT(*) as cnt FROM event');
    console.log('Total events:', total[0].cnt);

    // Check events per type
    const byType = query('SELECT type, COUNT(*) as cnt FROM event GROUP BY type');
    console.log('Events by type:', byType);

    // Check events per room
    const byRoom = query('SELECT room_id, type, COUNT(*) as cnt FROM event GROUP BY room_id, type ORDER BY cnt DESC LIMIT 20');
    console.log('Events by room:', byRoom);

    // Check if new columns have data
    const sampleEvents = query('SELECT id, room_id, type, user_id, diamond_count, like_count, comment FROM event LIMIT 5');
    console.log('Sample events (checking new columns):', sampleEvents);
}

checkEventData();
