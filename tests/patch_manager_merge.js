const fs = require('fs');
const path = require('path');

const managerPath = path.join(__dirname, '../manager.js');
let content = fs.readFileSync(managerPath, 'utf-8');

// We will insert the new method before "async getSessionEvents(sessionId) {"
// This is the same anchor we used before.

const anchor = 'async getSessionEvents(sessionId) {';
const insertPoint = content.indexOf(anchor);

if (insertPoint === -1) {
    console.error('Could not find anchor');
    process.exit(1);
}

const newMethod = `
    // Merge sessions that are close together (same day, small gap)
    async mergeContinuitySessions(gapMinutes = 10) {
        await this.ensureDb();
        const rooms = query('SELECT DISTINCT room_id FROM session');
        let mergedCount = 0;
        const gapMs = gapMinutes * 60 * 1000;

        console.log(\`[Manager] Checking for sessions to merge (Gap < \${gapMinutes}m)...\`);

        for (const room of rooms) {
            // Get sessions ordered by time
            // We join with event boundaries to know actual start/end
            const sessions = query(\`
                SELECT session_id, created_at,
                       (SELECT MIN(timestamp) FROM event WHERE session_id = session.session_id) as start_time,
                       (SELECT MAX(timestamp) FROM event WHERE session_id = session.session_id) as end_time
                FROM session 
                WHERE room_id = ?
                ORDER BY created_at ASC
            \`, [room.room_id]);

            if (sessions.length < 2) continue;

            let prev = sessions[0];
            
            for (let i = 1; i < sessions.length; i++) {
                const curr = sessions[i];
                
                // Skip invalid data
                if (!prev.end_time || !curr.start_time) {
                    prev = curr;
                    continue;
                }

                // Parse times
                const prevEnd = new Date(prev.end_time).getTime();
                const currStart = new Date(curr.start_time).getTime();
                const gap = currStart - prevEnd; // can be negative if overlaps
                
                // Compare Dates (YYYY-MM-DD)
                const prevDay = prev.start_time.slice(0, 10);
                const currDay = curr.start_time.slice(0, 10);

                // Logic: Same Day AND (Small Gap OR Overlap)
                if (prevDay === currDay && gap < gapMs) {
                    // Start Merge
                    console.log(\`[Manager] Merging \${curr.session_id} into \${prev.session_id} (Gap: \${(gap/1000/60).toFixed(1)}m)\`);
                    
                    // 1. Move events to prev session
                    run('UPDATE event SET session_id = ? WHERE session_id = ?', [prev.session_id, curr.session_id]);
                    
                    // 2. Delete current session record
                    run('DELETE FROM session WHERE session_id = ?', [curr.session_id]);

                    // 3. Update 'prev' end_time for next iteration
                    // New end time is max(prev.end, curr.end)
                    const currEnd = new Date(curr.end_time).getTime();
                    if (currEnd > prevEnd) {
                        prev.end_time = curr.end_time;
                    }
                    mergedCount++;
                } else {
                    // No merge, advance prev
                    prev = curr;
                }
            }
        }
        
        console.log(\`[Manager] Merged \${mergedCount} sessions.\`);
        return { mergedCount };
    }

`;

const finalContent = content.slice(0, insertPoint) + newMethod + content.slice(insertPoint);

fs.writeFileSync(managerPath, finalContent, 'utf-8');
console.log('Successfully injected mergeContinuitySessions');
