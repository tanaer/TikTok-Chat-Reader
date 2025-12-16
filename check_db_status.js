const db = require('./db');

(async () => {
    try {
        await db.initDb();
        const row = db.get("SELECT * FROM room WHERE room_id = 'blooming1881'");
        console.log('blooming1881:', row ? JSON.stringify(row, null, 2) : 'NOT FOUND');
    } catch (e) {
        console.error(e);
    }
})();
