const fs = require('fs');
const path = require('path');

const managerPath = path.join(__dirname, '../manager.js');
let content = fs.readFileSync(managerPath, 'utf-8');

const startMarker = 'async rebuildMissingSessions() {';
const endMarker = 'async getSessionEvents(sessionId) {';

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error('Could not find markers');
    process.exit(1);
}

// Keep the previous comments if any? No, just replace carefully.
// The markers are:
// startIndex points to 'async rebuildMissingSessions'
// endIndex points to the NEXT function.

// We need to look backwards from endMarker to find the closing brace of the previous function and the comments.
// Actually, let's just replace the block.

const newMethod = `async rebuildMissingSessions() {
        await this.ensureDb();

        // 1. Missing Sessions
        const missingSessions = query(\`
            SELECT DISTINCT e.session_id, e.room_id, 
                   MIN(e.timestamp) as first_event,
                   MAX(e.timestamp) as last_event,
                   COUNT(*) as event_count
            FROM event e
            LEFT JOIN session s ON e.session_id = s.session_id
            WHERE e.session_id IS NOT NULL AND s.session_id IS NULL
            GROUP BY e.session_id, e.room_id
        \`);
        
        // 2. Collided Sessions (Event room_id != Session room_id)
        const collidedSessions = query(\`
            SELECT e.session_id, e.room_id, COUNT(*) as event_count,
                   MIN(e.timestamp) as first_event, MAX(e.timestamp) as last_event
            FROM event e
            JOIN session s ON e.session_id = s.session_id
            WHERE e.room_id != s.room_id
            GROUP BY e.session_id, e.room_id
        \`);
        
        console.log(\`[Manager] Rebuild Check: \${missingSessions.length} missing, \${collidedSessions.length} collisions\`);

        let sessionsCreated = 0;
        let collisionsFixed = 0;

        // Fix Collisions
        for (const c of collidedSessions) {
            const datePrefix = c.first_event ? c.first_event.slice(0, 10).replace(/-/g, '') : c.session_id.slice(0, 8);
            
            let newSessionId = datePrefix + '98'; 
            let suffix = 98;
            while(get(\`SELECT 1 FROM session WHERE session_id = ?\`, [newSessionId])) {
                suffix--;
                newSessionId = datePrefix + String(suffix).padStart(2, '0');
            }
            
            console.log(\`[Manager] Fixing collision for \${c.room_id}: \${c.session_id} -> \${newSessionId}\`);
            
            run(\`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)\`, [
                newSessionId,
                c.room_id,
                c.first_event,
                JSON.stringify({
                    fixed_collision: true,
                    original_id: c.session_id,
                    note: \`Split from collision\`
                })
            ]);
            
            run(\`UPDATE event SET session_id = ? WHERE session_id = ? AND room_id = ?\`, 
                [newSessionId, c.session_id, c.room_id]);
                
            collisionsFixed++;
            sessionsCreated++;
        }

        // Fix Missing
        for (const ms of missingSessions) {
            run(\`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)\`, [
                ms.session_id,
                ms.room_id,
                ms.first_event,
                JSON.stringify({
                    rebuilt: true,
                    note: \`Rebuilt session with \${ms.event_count} events\`,
                    originalRange: \`\${ms.first_event} to \${ms.last_event}\`
                })
            ]);
            sessionsCreated++;
        }

        return { sessionsCreated, collisionsFixed };
    }

    // Get events for a specific session
    `;

// Before constructing, we need to handle the fact that newMethod includes the endMarker equivalent? NO.
// I included "    // Get events for a specific session\n    " at the end of newMethod string? No.
// Let's do exact slice replacement.

// Find strict split point
// We want to replace from `startMarker` up to `// Get events for a specific session` (which is usually a few lines before endMarker)
// Let's look at the file content again in my memory.
/*
347:     // Rebuild missing session records - for events that have session_id but no session record
348:     async rebuildMissingSessions() {
...
383:     }
384: 
385:     // Get events for a specific session
386:     async getSessionEvents(sessionId) {
*/

// So I replace from `async rebuildMissingSessions() {` up to `// Get events for a specific session`
const splitB = content.indexOf('// Get events for a specific session');
if (splitB === -1) {
    console.error('Split point B not found');
    process.exit(1);
}

const before = content.substring(0, startIndex);
const after = content.substring(splitB);

const finalStr = before + newMethod + after;
fs.writeFileSync(managerPath, finalStr, 'utf-8');
console.log('Patched manager.js successfully');
