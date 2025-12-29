/**
 * Investigate user jjou223223's room activity
 */
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root',
});

async function investigate() {
    const uniqueId = 'jjou223223';
    const roomId = 'su311n1';

    console.log(`\n=== Investigation: ${uniqueId} in ${roomId} ===\n`);

    // 0. Check if room exists and is monitored
    const roomInfo = await pool.query(`
        SELECT room_id, name, is_monitor_enabled, updated_at 
        FROM room WHERE room_id = $1
    `, [roomId]);
    console.log(`0. Room "${roomId}" status:`);
    if (roomInfo.rows[0]) {
        const r = roomInfo.rows[0];
        console.log(`   Name: ${r.name || 'N/A'}`);
        console.log(`   Monitor Enabled: ${r.is_monitor_enabled === 1 ? 'YES' : 'NO'}`);
        console.log(`   Last Updated: ${r.updated_at}`);
    } else {
        console.log(`   NOT FOUND in room table`);
    }

    // 0b. Check total events in this room
    const totalEvents = await pool.query(`
        SELECT COUNT(*) as cnt FROM event WHERE room_id = $1
    `, [roomId]);
    console.log(`   Total events in room: ${totalEvents.rows[0].cnt}`);

    // 0c. Check most recent events in this room
    const recentEvents = await pool.query(`
        SELECT unique_id, nickname, type, timestamp, comment 
        FROM event WHERE room_id = $1 
        ORDER BY timestamp DESC LIMIT 5
    `, [roomId]);
    console.log(`   Recent events:`);
    recentEvents.rows.forEach(e => console.log(`     ${e.timestamp}: ${e.unique_id} (${e.type}) ${e.comment || ''}`));

    // 1. Check events for this user in su311n1
    const eventsInRoom = await pool.query(`
        SELECT id, room_id, type, timestamp, comment 
        FROM event 
        WHERE unique_id = $1 AND room_id = $2
        ORDER BY timestamp DESC
        LIMIT 10
    `, [uniqueId, roomId]);
    console.log(`\n1. Events for ${uniqueId} in ${roomId}:`, eventsInRoom.rows.length);
    eventsInRoom.rows.forEach(r => console.log(`   ${r.type} @ ${r.timestamp}: ${r.comment || ''}`));

    // 2. Get all rooms this user has visited
    const allRooms = await pool.query(`
        SELECT room_id, type, COUNT(*) as cnt, 
               SUM(CASE WHEN type = 'gift' THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END) as gift_value
        FROM event 
        WHERE unique_id = $1
        GROUP BY room_id, type
        ORDER BY cnt DESC
    `, [uniqueId]);
    console.log(`\n2. All rooms for ${uniqueId} (by event type):`);
    allRooms.rows.forEach(r => console.log(`   ${r.room_id} - ${r.type}: ${r.cnt} events, ${r.gift_value || 0} diamonds`));

    // 3. Check user record
    const userRecord = await pool.query(`SELECT * FROM "user" WHERE unique_id = $1`, [uniqueId]);
    console.log(`\n3. User record:`, userRecord.rows[0] ? `Found (user_id: ${userRecord.rows[0].user_id})` : 'NOT FOUND');

    await pool.end();
}

investigate().catch(e => { console.error(e); pool.end(); });
