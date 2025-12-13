const fs = require('fs');
const path = require('path');

const managerPath = path.join(__dirname, '../manager.js');
let content = fs.readFileSync(managerPath, 'utf-8');

// Find the insertion point: the end of the class Manager
// which is the last '}' before 'const manager = new Manager();'

const pivot = 'const manager = new Manager();';
const pivotIndex = content.lastIndexOf(pivot);

if (pivotIndex === -1) {
    console.error('Could not find pivot point');
    process.exit(1);
}

const beforePivot = content.substring(0, pivotIndex);
const afterPivot = content.substring(pivotIndex); // This contains the garbage in the broken file

// Find the last '}' in beforePivot
const lastBraceIndex = beforePivot.lastIndexOf('}');
if (lastBraceIndex === -1) {
    console.error('Could not find class closing brace');
    process.exit(1);
}

// Construct new content
const newMethod = `
    // Archive stale live events (fix for "long session" bug)
    // Splits "live" events (session_id IS NULL) if there's a large time gap
    async archiveStaleLiveEvents(roomId) {
        await this.ensureDb();
        
        // Get all timestamps of current live events
        const events = query(\`
            SELECT id, timestamp 
            FROM event 
            WHERE room_id = ? AND session_id IS NULL 
            ORDER BY timestamp ASC
        \`, [roomId]);

        if (events.length < 2) return { archived: 0 };

        const GAP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour gap counts as new session
        let lastTime = new Date(events[0].timestamp).getTime();
        let splitIndex = -1;

        // Find the first major gap
        for (let i = 1; i < events.length; i++) {
            const currTime = new Date(events[i].timestamp).getTime();
            if (currTime - lastTime > GAP_THRESHOLD_MS) {
                splitIndex = i;
                break;
            }
            lastTime = currTime;
        }

        if (splitIndex !== -1) {
            // Found a gap! events[0...splitIndex-1] should be archived
            const staleEvents = events.slice(0, splitIndex);
            const firstT = events[0].timestamp;
            const lastT = events[splitIndex - 1].timestamp;

            const sessionId = firstT.slice(0, 10).replace(/-/g, '') + '99'; // e.g. 2025121299
            
            // Generate unique session ID if collision
            let finalSessionId = sessionId;
            let suffix = 99;
            while (get(\`SELECT 1 FROM session WHERE session_id = ?\`, [finalSessionId])) {
                suffix--;
                finalSessionId = firstT.slice(0, 10).replace(/-/g, '') + suffix;
            }

            console.log(\`[Manager] Archiving \${staleEvents.length} stale events for \${roomId} (Gap at \${events[splitIndex].timestamp})\`);

            // Create session
            run(\`INSERT INTO session (session_id, room_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)\`, [
                finalSessionId,
                roomId,
                JSON.stringify({
                    auto_generated: true, 
                    note: \`Archived stale events (Gap detected)\`,
                    range: \`\${firstT} - \${lastT}\`
                }),
                firstT
            ]);

            // Update events
            run(\`
                UPDATE event 
                SET session_id = ? 
                WHERE room_id = ? AND session_id IS NULL AND timestamp <= ?
            \`, [finalSessionId, roomId, lastT]);

            return { archived: staleEvents.length, sessionId: finalSessionId };
        }

        return { archived: 0 };
    }
`;

// Reconstruct: valid class body + new method + closing brace + clean exports
const header = beforePivot.substring(0, lastBraceIndex);
const footer = `}

const manager = new Manager();
module.exports = { manager };
`;

const finalContent = header + newMethod + footer;

fs.writeFileSync(managerPath, finalContent, 'utf-8');
console.log('Successfully patched manager.js');
