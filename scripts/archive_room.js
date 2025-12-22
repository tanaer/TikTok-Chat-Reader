/**
 * Archive stale events for a specific room
 * This script will archive old live events that should have been saved to sessions
 */
require('dotenv').config();
const { initDb } = require('../db');
const { manager } = require('../manager');

const roomId = process.argv[2];
if (!roomId) {
    console.log('Usage: node archive_room.js <roomId>');
    process.exit(1);
}

(async () => {
    try {
        await initDb();
        console.log(`=== Archiving stale events for ${roomId} ===\n`);

        // First check what we have
        const staleInfo = await manager.archiveStaleLiveEvents(roomId);

        if (staleInfo && staleInfo.archived > 0) {
            console.log(`✅ Archived ${staleInfo.archived} events into session ${staleInfo.sessionId}`);
        } else {
            console.log('No stale events found to archive, or all events are current.');
        }

        // Run merge to consolidate any fragmented sessions
        console.log('\n=== Running session merge ===');
        const mergeResult = await manager.mergeContinuitySessions(30);
        console.log(`Merged ${mergeResult.mergedCount} sessions.`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit(0);
    }
})();
