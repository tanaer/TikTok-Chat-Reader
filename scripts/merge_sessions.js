/**
 * Merge fragmented sessions that should have been one continuous session
 * Sessions with gaps < 30 minutes will be merged
 */
require('dotenv').config();
const { initDb } = require('../db');
const { manager } = require('../manager');

const gapMinutes = parseInt(process.argv[2]) || 30; // Default 30 minutes

(async () => {
    try {
        await initDb();
        console.log(`=== Merging fragmented sessions (Gap < ${gapMinutes} minutes) ===\n`);

        // Merge all sessions with gap < specified minutes
        const result = await manager.mergeContinuitySessions(gapMinutes);

        console.log(`\n✅ Done! Merged ${result.mergedCount} session pairs.`);

        if (result.mergedCount > 0) {
            console.log('\nThe fragmented sessions have been consolidated.');
        } else {
            console.log('\nNo sessions needed merging.');
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit(0);
    }
})();
