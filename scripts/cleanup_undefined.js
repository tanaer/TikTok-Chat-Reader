const db = require('../db');

async function cleanup() {
    try {
        console.log('Truncating recording_task table...');
        await db.query("TRUNCATE TABLE recording_task RESTART IDENTITY");
        console.log('Done! Table is now empty.');

        // Verify
        const count = await db.get("SELECT COUNT(*) as cnt FROM recording_task");
        console.log(`Remaining record count: ${count.cnt}`);

        process.exit(0);
    } catch (e) {
        console.error('Error:', e);
        process.exit(1);
    }
}

cleanup();
