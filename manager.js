/**
 * Manager module - Price, Room, Session, Event management
 * Replaces Python manager.py
 */
const fs = require('fs');
const path = require('path');
const { initDb, query, run, get } = require('./db');

const PRICE_FILE = path.join(__dirname, 'prices.json');

function getNowBeijing() {
    // Return YYYY-MM-DD HH:mm:ss in Beijing Time (UTC+8)
    const d = new Date();
    const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().slice(0, 19).replace('T', ' ');
}

// Helper: Convert ISO string or Date to Beijing time string (UTC+8) to match DB storage format
function convertToBeijingTimeString(input) {
    let d;
    if (!input) return null;
    if (typeof input === 'string') {
        d = new Date(input);
    } else if (input instanceof Date) {
        d = input;
    } else {
        return null;
    }
    const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().slice(0, 19).replace('T', ' ');
}

class Manager {
    constructor() {
        this.prices = this.loadPrices();
        this.dbReady = false;
    }

    async ensureDb() {
        if (!this.dbReady) {
            await initDb();
            this.dbReady = true;
        }
    }

    // Price Management
    loadPrices() {
        try {
            if (fs.existsSync(PRICE_FILE)) {
                return JSON.parse(fs.readFileSync(PRICE_FILE, 'utf-8'));
            }
        } catch (e) {
            console.error('Error loading prices:', e);
        }
        return {};
    }

    savePrice(giftId, price) {
        this.prices[String(giftId)] = price;
        fs.writeFileSync(PRICE_FILE, JSON.stringify(this.prices, null, 2), 'utf-8');
    }

    getPrice(giftId) {
        return parseFloat(this.prices[String(giftId)] || 0);
    }

    // Room Management
    async updateRoom(roomId, name, address, isMonitorEnabled) {
        await this.ensureDb();
        const now = getNowBeijing();

        // Check if room exists to preserve existing values when null is passed
        const existing = get('SELECT name, address, is_monitor_enabled FROM room WHERE room_id = ?', [roomId]);

        // Preserve name if null/undefined passed
        let finalName = name;
        if (name === null || name === undefined) {
            finalName = existing ? existing.name : roomId; // Default to roomId for new rooms
        }

        // Preserve address if null/undefined passed  
        let finalAddress = address;
        if (address === null || address === undefined) {
            finalAddress = existing ? existing.address : null;
        }

        // Handle monitor enabled - preserve existing value if undefined
        let monitorVal;
        console.log(`[Manager] updateRoom - isMonitorEnabled: ${isMonitorEnabled} (type: ${typeof isMonitorEnabled})`);

        if (isMonitorEnabled === undefined || isMonitorEnabled === null) {
            if (existing) {
                monitorVal = existing.is_monitor_enabled;
                console.log(`[Manager] Preserving existing monitor setting: ${monitorVal}`);
            } else {
                monitorVal = 1; // Default to enabled for new rooms only
            }
        } else if (isMonitorEnabled === false || isMonitorEnabled === 'false' || isMonitorEnabled === 0 || isMonitorEnabled === '0') {
            monitorVal = 0;
        } else {
            monitorVal = 1;
        }

        console.log(`[Manager] updateRoom - monitorVal: ${monitorVal}`);

        run(`
            INSERT INTO room (room_id, name, address, updated_at, is_monitor_enabled) 
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(room_id) DO UPDATE SET 
                name = excluded.name, 
                address = excluded.address, 
                updated_at = excluded.updated_at,
                is_monitor_enabled = excluded.is_monitor_enabled
        `, [roomId, finalName, finalAddress, now, monitorVal]);
        return { room_id: roomId, name: finalName, address: finalAddress, is_monitor_enabled: monitorVal };
    }

    async getRooms() {
        await this.ensureDb();
        return query('SELECT room_id, numeric_room_id, name, address, updated_at, is_monitor_enabled FROM room ORDER BY updated_at DESC');
    }

    // Save numeric room ID when connecting to a room
    async setNumericRoomId(uniqueId, numericRoomId) {
        await this.ensureDb();
        if (!numericRoomId) return;

        run(`UPDATE room SET numeric_room_id = ? WHERE room_id = ?`, [String(numericRoomId), uniqueId]);
        console.log(`[Manager] Saved numeric_room_id ${numericRoomId} for room ${uniqueId}`);
    }

    // Migrate events from numeric room_id to username room_id
    async migrateEventRoomIds() {
        await this.ensureDb();

        // Get all rooms with numeric_room_id
        const rooms = query('SELECT room_id, numeric_room_id FROM room WHERE numeric_room_id IS NOT NULL');

        for (const room of rooms) {
            const updated = run(`
                UPDATE event SET room_id = ? 
                WHERE room_id = ? AND room_id != ?
            `, [room.room_id, room.numeric_room_id, room.room_id]);
            console.log(`[Manager] Migrated events from ${room.numeric_room_id} to ${room.room_id}`);
        }
    }

    // Session Management
    async createSession(roomId, snapshotData) {
        await this.ensureDb();
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

        // Find next session number for today
        const result = get('SELECT COUNT(*) as cnt FROM session WHERE session_id LIKE ?', [dateStr + '%']);
        const cnt = result ? result.cnt : 0;
        const sessionId = `${dateStr}${String(cnt + 1).padStart(2, '0')}`;

        run('INSERT INTO session (session_id, room_id, snapshot_json) VALUES (?, ?, ?)',
            [sessionId, roomId, JSON.stringify(snapshotData)]);
        return sessionId;
    }

    async getSessions(roomId) {
        await this.ensureDb();
        if (roomId) {
            return query('SELECT session_id, room_id, created_at FROM session WHERE room_id = ? ORDER BY created_at DESC', [roomId]);
        }
        return query('SELECT session_id, room_id, created_at FROM session ORDER BY created_at DESC');
    }

    async getSession(sessionId) {
        await this.ensureDb();
        const row = get('SELECT snapshot_json FROM session WHERE session_id = ?', [sessionId]);
        if (row && row.snapshot_json) {
            try {
                return JSON.parse(row.snapshot_json);
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    // Event Logging - writes to both expanded columns and data_json
    async logEvent(roomId, eventType, data, sessionId = null) {
        await this.ensureDb();
        const now = getNowBeijing();

        // Sync user data
        if (data.userId) {
            await this.ensureUser({
                userId: data.userId,
                uniqueId: data.uniqueId,
                nickname: data.nickname,
                avatar: data.profilePictureUrl || ''
            });
        }

        // Insert with expanded columns for fast querying
        run(`INSERT INTO event (
            room_id, session_id, type, timestamp,
            user_id, unique_id, nickname,
            gift_id, diamond_count, repeat_count,
            like_count, total_like_count,
            comment, viewer_count,
            data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            roomId,
            sessionId,
            eventType,
            now,
            data.userId || null,
            data.uniqueId || null,
            data.nickname || null,
            data.giftId || null,
            data.diamondCount || 0,
            data.repeatCount || 1,
            data.likeCount || 0,
            data.totalLikeCount || 0,
            data.comment || null,
            data.viewerCount || null,
            JSON.stringify(data)
        ]);
    }

    async ensureUser(u) {
        // Skip if no userId - prevents "Wrong API use: undefined" errors
        if (!u || !u.userId) {
            return;
        }

        const now = getNowBeijing();
        run(`
            INSERT INTO user (user_id, unique_id, nickname, avatar, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                unique_id = excluded.unique_id,
                nickname = excluded.nickname,
                avatar = excluded.avatar,
                updated_at = excluded.updated_at
        `, [u.userId, u.uniqueId || '', u.nickname || '', u.avatar || '', now]);
    }

    // Get count of untagged events for a room (to check if session should be saved)
    async getUntaggedEventCount(roomId, startTime = null) {
        await this.ensureDb();
        let result;
        if (startTime) {
            const beijingTime = convertToBeijingTimeString(startTime);
            result = get('SELECT COUNT(*) as cnt FROM event WHERE room_id = ? AND session_id IS NULL AND timestamp >= ?',
                [roomId, beijingTime]);
        } else {
            result = get('SELECT COUNT(*) as cnt FROM event WHERE room_id = ? AND session_id IS NULL',
                [roomId]);
        }
        return result ? result.cnt : 0;
    }

    // Tag all untagged events for a room with a session_id (called when ending session)
    async tagEventsWithSession(roomId, sessionId, startTime = null) {
        await this.ensureDb();
        if (startTime) {
            // Convert to Beijing time string to match DB format
            const beijingTime = convertToBeijingTimeString(startTime);
            // Only tag events from after startTime
            run('UPDATE event SET session_id = ? WHERE room_id = ? AND session_id IS NULL AND timestamp >= ?',
                [sessionId, roomId, beijingTime]);
        } else {
            // Tag all untagged events for this room
            run('UPDATE event SET session_id = ? WHERE room_id = ? AND session_id IS NULL',
                [sessionId, roomId]);
        }
    }

    // Fix orphaned events - group by room_id + date and create sessions
    async fixOrphanedEvents() {
        await this.ensureDb();

        // Find all distinct room_id + date combinations with orphaned events
        const orphanGroups = query(`
            SELECT room_id, DATE(timestamp) as event_date, COUNT(*) as cnt
            FROM event 
            WHERE session_id IS NULL
            GROUP BY room_id, DATE(timestamp)
            ORDER BY event_date DESC
        `);

        console.log(`[Manager] Found ${orphanGroups.length} orphan groups to fix`);

        let sessionsCreated = 0;
        let eventsFixed = 0;

        for (const group of orphanGroups) {
            const { room_id, event_date, cnt } = group;

            // Create session_id from date (e.g., "2025-12-11" -> "2025121199" with 99 suffix to avoid collision)
            const sessionId = event_date.replace(/-/g, '') + '99';

            // Check if session already exists
            const existing = get('SELECT session_id FROM session WHERE session_id = ?', [sessionId]);

            if (!existing) {
                // Create new session
                run(`INSERT INTO session (session_id, room_id, created_at, info) VALUES (?, ?, ?, ?)`, [
                    sessionId,
                    room_id,
                    event_date + ' 00:00:00',
                    JSON.stringify({ migrated: true, note: `Recovered ${cnt} orphaned events` })
                ]);
                sessionsCreated++;
            }

            // Tag all orphaned events for this room+date
            run(`UPDATE event SET session_id = ? WHERE room_id = ? AND session_id IS NULL AND DATE(timestamp) = ?`,
                [sessionId, room_id, event_date]);
            eventsFixed += cnt;
        }

        console.log(`[Manager] Fixed ${eventsFixed} orphaned events, created ${sessionsCreated} sessions`);
        return { sessionsCreated, eventsFixed, groupsProcessed: orphanGroups.length };
    }

    // Delete sessions that have 0 events
    async deleteEmptySessions() {
        await this.ensureDb();

        // Find sessions with no events
        const emptySessions = query(`
            SELECT s.session_id, s.room_id
            FROM session s
            LEFT JOIN event e ON s.session_id = e.session_id
            GROUP BY s.session_id
            HAVING COUNT(e.id) = 0
        `);

        console.log(`[Manager] Found ${emptySessions.length} empty sessions to delete`);

        for (const s of emptySessions) {
            run('DELETE FROM session WHERE session_id = ?', [s.session_id]);
        }

        console.log(`[Manager] Deleted ${emptySessions.length} empty sessions`);
        return { deletedCount: emptySessions.length };
    }

    // Rebuild missing session records - for events that have session_id but no session record
    async rebuildMissingSessions() {
        await this.ensureDb();

        // 1. Missing Sessions
        const missingSessions = query(`
            SELECT DISTINCT e.session_id, e.room_id, 
                   MIN(e.timestamp) as first_event,
                   MAX(e.timestamp) as last_event,
                   COUNT(*) as event_count
            FROM event e
            LEFT JOIN session s ON e.session_id = s.session_id
            WHERE e.session_id IS NOT NULL AND s.session_id IS NULL
            GROUP BY e.session_id, e.room_id
        `);
        
        // 2. Collided Sessions (Event room_id != Session room_id)
        const collidedSessions = query(`
            SELECT e.session_id, e.room_id, COUNT(*) as event_count,
                   MIN(e.timestamp) as first_event, MAX(e.timestamp) as last_event
            FROM event e
            JOIN session s ON e.session_id = s.session_id
            WHERE e.room_id != s.room_id
            GROUP BY e.session_id, e.room_id
        `);
        
        console.log(`[Manager] Rebuild Check: ${missingSessions.length} missing, ${collidedSessions.length} collisions`);

        let sessionsCreated = 0;
        let collisionsFixed = 0;

        // Fix Collisions
        for (const c of collidedSessions) {
            const datePrefix = c.first_event ? c.first_event.slice(0, 10).replace(/-/g, '') : c.session_id.slice(0, 8);
            
            let newSessionId = datePrefix + '98'; 
            let suffix = 98;
            while(get(`SELECT 1 FROM session WHERE session_id = ?`, [newSessionId])) {
                suffix--;
                newSessionId = datePrefix + String(suffix).padStart(2, '0');
            }
            
            console.log(`[Manager] Fixing collision for ${c.room_id}: ${c.session_id} -> ${newSessionId}`);
            
            run(`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)`, [
                newSessionId,
                c.room_id,
                c.first_event,
                JSON.stringify({
                    fixed_collision: true,
                    original_id: c.session_id,
                    note: `Split from collision`
                })
            ]);
            
            run(`UPDATE event SET session_id = ? WHERE session_id = ? AND room_id = ?`, 
                [newSessionId, c.session_id, c.room_id]);
                
            collisionsFixed++;
            sessionsCreated++;
        }

        // Fix Missing
        for (const ms of missingSessions) {
            run(`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)`, [
                ms.session_id,
                ms.room_id,
                ms.first_event,
                JSON.stringify({
                    rebuilt: true,
                    note: `Rebuilt session with ${ms.event_count} events`,
                    originalRange: `${ms.first_event} to ${ms.last_event}`
                })
            ]);
            sessionsCreated++;
        }

        return { sessionsCreated, collisionsFixed };
    }

    // Get events for a specific session
    // Get events for a specific session
    
    // Merge sessions that are close together (same day, small gap)
    async mergeContinuitySessions(gapMinutes = 10) {
        await this.ensureDb();
        const rooms = query('SELECT DISTINCT room_id FROM session');
        let mergedCount = 0;
        const gapMs = gapMinutes * 60 * 1000;

        console.log(`[Manager] Checking for sessions to merge (Gap < ${gapMinutes}m)...`);

        for (const room of rooms) {
            // Get sessions ordered by time
            // We join with event boundaries to know actual start/end
            const sessions = query(`
                SELECT session_id, created_at,
                       (SELECT MIN(timestamp) FROM event WHERE session_id = session.session_id) as start_time,
                       (SELECT MAX(timestamp) FROM event WHERE session_id = session.session_id) as end_time
                FROM session 
                WHERE room_id = ?
                ORDER BY created_at ASC
            `, [room.room_id]);

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
                    console.log(`[Manager] Merging ${curr.session_id} into ${prev.session_id} (Gap: ${(gap/1000/60).toFixed(1)}m)`);
                    
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
        
        console.log(`[Manager] Merged ${mergedCount} sessions.`);
        return { mergedCount };
    }

async getSessionEvents(sessionId) {
        await this.ensureDb();
        return query('SELECT type, timestamp, data_json FROM event WHERE session_id = ? ORDER BY timestamp ASC',
            [sessionId]);
    }

    // Time Statistics (30-min intervals)
    async getTimeStats(roomId) {
        await this.ensureDb();
        const events = query(
            'SELECT type, timestamp, data_json FROM event WHERE room_id = ? AND type IN ("gift", "chat", "roomUser") ORDER BY timestamp ASC',
            [roomId]
        );
        const stats = {};

        for (const e of events) {
            const dt = new Date(e.timestamp);
            const hour = dt.getHours();
            const minute = dt.getMinutes();

            let startStr, endStr;
            if (minute < 30) {
                startStr = `${String(hour).padStart(2, '0')}:00`;
                endStr = `${String(hour).padStart(2, '0')}:30`;
            } else {
                startStr = `${String(hour).padStart(2, '0')}:30`;
                endStr = `${String((hour + 1) % 24).padStart(2, '0')}:00`;
            }

            const key = `${startStr}-${endStr}`;
            if (!stats[key]) {
                stats[key] = { income: 0, comments: 0, max_online: 0 };
            }

            if (e.type === 'chat') {
                stats[key].comments++;
            } else if (e.type === 'gift') {
                try {
                    const data = JSON.parse(e.data_json);
                    const giftId = data.giftId;
                    const count = data.repeatCount || 1;
                    const price = this.getPrice(giftId);
                    stats[key].income += count * price;
                } catch (err) {
                    // ignore parse error
                }
            } else if (e.type === 'roomUser') {
                try {
                    const data = JSON.parse(e.data_json);
                    const viewers = data.viewerCount || 0;
                    if (viewers > stats[key].max_online) {
                        stats[key].max_online = viewers;
                    }
                } catch (err) {
                    // ignore parse error
                }
            }
        }

        return Object.entries(stats).map(([time_range, val]) => ({
            time_range,
            income: val.income,
            comments: val.comments,
            max_online: val.max_online
        }));
    }

    // User Analysis
    async updateUserLanguages(userId, common, mastered) {
        await this.ensureDb();
        run('UPDATE user SET common_language = ?, mastered_languages = ? WHERE user_id = ?',
            [common, mastered, userId]);
    }

    async getTopGifters(page = 1, pageSize = 50, langFilter = '') {
        await this.ensureDb();

        const offset = (page - 1) * pageSize;

        let langCondition = '';
        let countParams = [];
        let mainParams = [];

        if (langFilter) {
            langCondition = `AND (u.mastered_languages LIKE ? OR u.common_language LIKE ?)`;
            countParams.push(`%${langFilter}%`, `%${langFilter}%`);
            mainParams.push(`%${langFilter}%`, `%${langFilter}%`);
        }

        // Get total count for pagination
        const countResult = get(`
            SELECT COUNT(DISTINCT u.user_id) as total
            FROM event e
            JOIN user u ON e.user_id = u.user_id
            WHERE e.type = 'gift' ${langCondition}
        `, countParams);
        const totalCount = countResult ? countResult.total : 0;

        mainParams.push(pageSize, offset);

        // Optimized single query with subqueries - includes role and fan info
        const rows = query(`
            SELECT 
                u.user_id as userId,
                u.unique_id as uniqueId,
                u.nickname as nickname,
                u.common_language as commonLanguage,
                u.mastered_languages as masteredLanguages,
                COALESCE(gift_agg.totalValue, 0) as totalValue,
                gift_agg.topRoom,
                gift_agg.roomCount,
                COALESCE(chat_agg.chatCount, 0) as chatCount,
                COALESCE(last_agg.lastActive, u.updated_at) as lastActive,
                COALESCE(role_agg.isAdmin, 0) as isAdmin,
                COALESCE(role_agg.isSuperAdmin, 0) as isSuperAdmin,
                COALESCE(role_agg.isModerator, 0) as isModerator,
                COALESCE(role_agg.fanLevel, 0) as fanLevel,
                role_agg.fanClubName
            FROM user u
            LEFT JOIN (
                SELECT 
                    user_id,
                    SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as totalValue,
                    (SELECT room_id FROM event e2 WHERE e2.type = 'gift' AND e2.user_id = e1.user_id 
                     GROUP BY room_id ORDER BY COUNT(*) DESC LIMIT 1) as topRoom,
                    COUNT(DISTINCT room_id) as roomCount
                FROM event e1
                WHERE type = 'gift'
                GROUP BY user_id
            ) gift_agg ON u.user_id = gift_agg.user_id
            LEFT JOIN (
                SELECT user_id, COUNT(*) as chatCount
                FROM event
                WHERE type = 'chat'
                GROUP BY user_id
            ) chat_agg ON u.user_id = chat_agg.user_id
            LEFT JOIN (
                SELECT user_id, MAX(timestamp) as lastActive
                FROM event
                GROUP BY user_id
            ) last_agg ON u.user_id = last_agg.user_id
            LEFT JOIN (
                SELECT 
                    user_id,
                    MAX(json_extract(data_json, '$.isAdmin')) as isAdmin,
                    MAX(json_extract(data_json, '$.isSuperAdmin')) as isSuperAdmin,
                    MAX(json_extract(data_json, '$.isModerator')) as isModerator,
                    MAX(json_extract(data_json, '$.fanLevel')) as fanLevel,
                    (SELECT json_extract(data_json, '$.fanClubName') FROM event e3 
                     WHERE e3.user_id = e2.user_id AND json_extract(data_json, '$.fanClubName') IS NOT NULL 
                     AND json_extract(data_json, '$.fanClubName') != '' ORDER BY timestamp DESC LIMIT 1) as fanClubName
                FROM event e2
                GROUP BY user_id
            ) role_agg ON u.user_id = role_agg.user_id
            WHERE gift_agg.totalValue > 0 ${langCondition}
            ORDER BY gift_agg.totalValue DESC
            LIMIT ? OFFSET ?
        `, mainParams);

        // For each user, check if they are moderator in their top room
        for (const user of rows) {
            if (user.topRoom) {
                const modCheck = get(`
                    SELECT MAX(json_extract(data_json, '$.isModerator')) as isMod
                    FROM event
                    WHERE user_id = ? AND room_id = ? AND json_extract(data_json, '$.isModerator') = 1
                    LIMIT 1
                `, [user.userId, user.topRoom]);
                user.isTopRoomModerator = modCheck && modCheck.isMod ? true : false;
            } else {
                user.isTopRoomModerator = false;
            }
        }

        return { users: rows, totalCount, page, pageSize };
    }

    async getUserChatHistory(userId, limit = 50) {
        await this.ensureDb();
        return query(`
            SELECT comment, timestamp
            FROM event
            WHERE type = 'chat' AND user_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `, [userId, limit]);
    }

    // Config Management
    async getSetting(key, defaultValue = null) {
        await this.ensureDb();
        const row = get('SELECT value FROM settings WHERE key = ?', [key]);
        return row ? row.value : defaultValue;
    }

    async saveSetting(key, value) {
        await this.ensureDb();
        run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, value]);
    }

    async getAllSettings() {
        await this.ensureDb();
        const rows = query('SELECT key, value FROM settings');
        const settings = {};
        for (const r of rows) settings[r.key] = r.value;
        return settings;
    }

    // Room Management
    async deleteRoom(roomId) {
        await this.ensureDb();
        run('DELETE FROM event WHERE room_id = ?', [roomId]);
        run('DELETE FROM session WHERE room_id = ?', [roomId]);
        run('DELETE FROM room WHERE room_id = ?', [roomId]);
    }

    async getGlobalStats() {
        await this.ensureDb();

        // 24-Hour Distribution - ALL historical data grouped by hour of day
        // Use substr instead of strftime for Beijing time string format 'YYYY-MM-DD HH:mm:ss'
        const hourRows = query(`
            SELECT substr(timestamp, 12, 2) as hour, type, data_json 
            FROM event 
            WHERE type = 'chat' OR type = 'gift'
        `);

        const hourStats = {};
        for (let i = 0; i < 24; i++) hourStats[String(i).padStart(2, '0')] = { gift: 0, chat: 0 };

        for (const r of hourRows) {
            const h = r.hour;
            if (!hourStats[h]) hourStats[h] = { gift: 0, chat: 0 };

            if (r.type === 'chat') {
                hourStats[h].chat++;
            } else if (r.type === 'gift') {
                try {
                    const data = JSON.parse(r.data_json);
                    const val = (data.diamondCount || 0) * (data.repeatCount || 1);
                    hourStats[h].gift += val;
                } catch (e) { }
            }
        }

        // Weekly Distribution - ALL historical data grouped by day of week
        // strftime('%w') should work on date part, but let's keep it consistent
        const dayRows = query(`
            SELECT strftime('%w', substr(timestamp, 1, 10)) as day, type, data_json 
            FROM event 
            WHERE type = 'chat' OR type = 'gift'
        `);

        const dayStats = {};
        for (let i = 0; i < 7; i++) dayStats[i] = { gift: 0, chat: 0 };

        for (const r of dayRows) {
            const d = parseInt(r.day);
            if (r.type === 'chat') {
                dayStats[d].chat++;
            } else if (r.type === 'gift') {
                try {
                    const data = JSON.parse(r.data_json);
                    const val = (data.diamondCount || 0) * (data.repeatCount || 1);
                    dayStats[d].gift += val;
                } catch (e) { }
            }
        }

        return { hourStats, dayStats };
    }

    async getRoomStats(liveRoomIds = []) {
        await this.ensureDb();
        // Stats for CURRENT LIVE SESSION ONLY (session_id IS NULL)

        const rooms = query('SELECT * FROM room ORDER BY updated_at DESC');
        const stats = [];

        for (const r of rooms) {
            // Only count events from current live session (session_id IS NULL)
            const visitCount = get(`SELECT COUNT(*) as c FROM event WHERE room_id = ? AND type = 'member' AND session_id IS NULL`, [r.room_id])?.c || 0;

            const giftValue = get(`
                SELECT SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as val 
                FROM event 
                WHERE room_id = ? AND type = 'gift' AND session_id IS NULL`,
                [r.room_id])?.val || 0;

            const commentCount = get(`SELECT COUNT(*) as c FROM event WHERE room_id = ? AND type = 'chat' AND session_id IS NULL`, [r.room_id])?.c || 0;

            const likeCountRow = get(`
                SELECT MAX(COALESCE(total_like_count, 0)) as m 
                FROM event 
                WHERE room_id = ? AND type = 'like' AND session_id IS NULL`, [r.room_id]);
            const likeCount = likeCountRow ? likeCountRow.m : 0;

            const lastSession = get(`SELECT * FROM session WHERE room_id = ? ORDER BY created_at DESC LIMIT 1`, [r.room_id]);

            // Check if room is currently live (connected via AutoRecorder)
            const isLive = liveRoomIds.includes(r.room_id);

            stats.push({
                ...r,
                isLive,
                totalVisits: visitCount,
                totalComments: commentCount,
                totalGiftValue: giftValue,
                totalLikes: likeCount || 0,
                lastSessionTime: lastSession ? lastSession.created_at : null
            });
        }

        // Sort: live rooms first, then by updated_at
        stats.sort((a, b) => {
            if (a.isLive && !b.isLive) return -1;
            if (!a.isLive && b.isLive) return 1;
            return 0; // keep original order (by updated_at)
        });

        return stats;
    }

    async getUserAnalysis(userId) {
        await this.ensureDb();

        // 1. Basic Stats
        const giftStats = get(`
            SELECT 
                SUM(
                    COALESCE(json_extract(data_json, '$.diamondCount'), 0) * 
                    COALESCE(json_extract(data_json, '$.repeatCount'), 1)
                ) as totalValue,
                MIN(timestamp) as firstSeen,
                MAX(timestamp) as lastSeen,
                COUNT(DISTINCT substr(timestamp, 1, 10)) as activeDays
            FROM event 
            WHERE type = 'gift' AND json_extract(data_json, '$.userId') = ?
        `, [userId]);

        // 2. Top Rooms (Gift)
        const giftRooms = query(`
            SELECT e.room_id, r.name, SUM(
                COALESCE(json_extract(e.data_json, '$.diamondCount'), 0) * 
                COALESCE(json_extract(e.data_json, '$.repeatCount'), 1)
            ) as val
            FROM event e
            LEFT JOIN room r ON e.room_id = r.room_id
            WHERE e.type = 'gift' AND json_extract(e.data_json, '$.userId') = ?
            GROUP BY e.room_id
            ORDER BY val DESC
            LIMIT 10
        `, [userId]);

        // 3. Top Rooms (Visit - from member/chat/gift combined or just member)
        // Since 'member' event is entry, let's use that for "visits"
        const visitRooms = query(`
             SELECT e.room_id, r.name, COUNT(*) as cnt
             FROM event e
             LEFT JOIN room r ON e.room_id = r.room_id
             WHERE e.type = 'member' AND json_extract(e.data_json, '$.userId') = ?
             GROUP BY e.room_id
             ORDER BY cnt DESC
             LIMIT 10
        `, [userId]);

        // 4. Time Distribution (Hour of Day)
        const hourStats = query(`
            SELECT strftime('%H', timestamp) as hour, COUNT(*) as cnt
            FROM event
            WHERE type = 'gift' AND json_extract(data_json, '$.userId') = ?
            GROUP BY hour
            ORDER BY hour
        `, [userId]);

        // 5. Day of Week (0 = Sunday, 6 = Saturday)
        const dayStats = query(`
            SELECT strftime('%w', timestamp) as day, COUNT(*) as cnt
            FROM event
            WHERE type = 'gift' AND json_extract(data_json, '$.userId') = ?
            GROUP BY day
            ORDER BY day
        `, [userId]);

        // 6. Role and Fan Badge Info (from latest event)
        const roleInfo = get(`
            SELECT 
                MAX(json_extract(data_json, '$.isAdmin')) as isAdmin,
                MAX(json_extract(data_json, '$.isSuperAdmin')) as isSuperAdmin,
                MAX(json_extract(data_json, '$.isModerator')) as isModerator,
                MAX(json_extract(data_json, '$.fanLevel')) as fanLevel,
                (SELECT json_extract(data_json, '$.fanClubName') FROM event 
                 WHERE json_extract(data_json, '$.userId') = ? 
                 AND json_extract(data_json, '$.fanClubName') IS NOT NULL 
                 AND json_extract(data_json, '$.fanClubName') != '' 
                 ORDER BY timestamp DESC LIMIT 1) as fanClubName
            FROM event
            WHERE json_extract(data_json, '$.userId') = ?
        `, [userId, userId]);

        // 7. Rooms where user is moderator
        const moderatorRooms = query(`
            SELECT DISTINCT e.room_id, r.name
            FROM event e
            LEFT JOIN room r ON e.room_id = r.room_id
            WHERE json_extract(e.data_json, '$.userId') = ?
            AND json_extract(e.data_json, '$.isModerator') = 1
        `, [userId]);

        return {
            totalValue: giftStats?.totalValue || 0,
            activeDays: giftStats?.activeDays || 1,
            dailyAvg: (giftStats?.totalValue || 0) / (giftStats?.activeDays || 1),
            giftRooms,
            visitRooms,
            hourStats,
            dayStats,
            isAdmin: roleInfo?.isAdmin || false,
            isSuperAdmin: roleInfo?.isSuperAdmin || false,
            isModerator: roleInfo?.isModerator || false,
            fanLevel: roleInfo?.fanLevel || 0,
            fanClubName: roleInfo?.fanClubName || '',
            moderatorRooms
        };
    }

    // Room Detail Statistics (Header + Leaderboards)
    async getRoomDetailStats(roomId, sessionId = null) {
        await this.ensureDb();

        // Build WHERE clause based on sessionId
        let whereClause = 'WHERE room_id = ?';
        let params = [roomId];
        let usedFallback = false;

        if (sessionId === 'live' || !sessionId) {
            // Live mode: show untagged events (session_id IS NULL)
            // No fallback - frontend handles empty state
            whereClause += ' AND session_id IS NULL';
        } else {
            // Specific session requested
            whereClause += ' AND session_id = ?';
            params.push(sessionId);
        }

        // 1. Summary Stats
        // Total Income, Total Comments, Total Likes (Max), Total Viewers (Max? or Sum of Uniques?)
        // For Viewers/Members: COUNT(*) of 'member' events approx unique entries if session-based.
        // For Likes: MAX(likeCount) is best for snapshot.

        const summary = get(`
            SELECT 
                SUM(CASE WHEN type='chat' THEN 1 ELSE 0 END) as totalComments,
                SUM(CASE WHEN type='member' THEN 1 ELSE 0 END) as totalVisits,
                MAX(CASE WHEN type='like' THEN COALESCE(total_like_count, 0) ELSE 0 END) as maxLikes,
                SUM(CASE WHEN type='gift' THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END) as totalGiftValue
            FROM event 
            ${whereClause}
        `, params);

        // Duration calculation
        // Min/Max timestamp
        const timeRange = get(`SELECT MIN(timestamp) as start, MAX(timestamp) as end FROM event ${whereClause}`, params);
        let duration = 0;
        if (timeRange.start && timeRange.end) {
            const start = new Date(timeRange.start);
            const end = new Date(timeRange.end);
            duration = Math.floor((end - start) / 1000); // seconds
        }

        // 2. Leaderboards

        // Top Gifters
        const topGifters = query(`
            SELECT 
                nickname,
                user_id as userId,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as value
            FROM event
            ${whereClause} AND type = 'gift'
            GROUP BY user_id
            ORDER BY value DESC
            LIMIT 20
        `, params);

        // Top Chatters
        const topChatters = query(`
            SELECT 
                nickname,
                user_id as userId,
                COUNT(*) as count
            FROM event
            ${whereClause} AND type = 'chat'
            GROUP BY user_id
            ORDER BY count DESC
            LIMIT 20
        `, params);

        // Top Likers
        // likeCount is the number of likes in each packet, SUM gives total contribution
        const topLikers = query(`
            SELECT 
                nickname,
                user_id as userId,
                SUM(COALESCE(like_count, 0)) as count
            FROM event
            ${whereClause} AND type = 'like'
            GROUP BY user_id
            ORDER BY count DESC
            LIMIT 20
        `, params);

        // Gift Details - breakdown by user + gift (for 礼物明细 tab)
        const giftDetails = query(`
            SELECT 
                nickname,
                unique_id as uniqueId,
                json_extract(data_json, '$.giftName') as giftName,
                SUM(COALESCE(repeat_count, 1)) as count,
                MAX(COALESCE(diamond_count, 0)) as unitPrice,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as totalValue
            FROM event
            ${whereClause} AND type = 'gift'
            GROUP BY user_id, json_extract(data_json, '$.giftId')
            ORDER BY totalValue DESC
            LIMIT 100
        `, params);

        return {
            summary: {
                duration,
                startTime: timeRange.start || null,  // Actual start time from database
                totalVisits: summary.totalVisits || 0,
                totalComments: summary.totalComments || 0,
                totalLikes: summary.maxLikes || 0, // Using max global likes as "Room Likes"
                totalGiftValue: summary.totalGiftValue || 0
            },
            leaderboards: {
                gifters: topGifters,
                chatters: topChatters,
                likers: topLikers,
                giftDetails: giftDetails  // New: per-user per-gift breakdown
            }
        };
    }

    // Archive stale live events (fix for "long session" bug)
    // Splits "live" events (session_id IS NULL) if there's a large time gap
    async archiveStaleLiveEvents(roomId) {
        await this.ensureDb();
        
        // Get all timestamps of current live events
        const events = query(`
            SELECT id, timestamp 
            FROM event 
            WHERE room_id = ? AND session_id IS NULL 
            ORDER BY timestamp ASC
        `, [roomId]);

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
            while (get(`SELECT 1 FROM session WHERE session_id = ?`, [finalSessionId])) {
                suffix--;
                finalSessionId = firstT.slice(0, 10).replace(/-/g, '') + suffix;
            }

            console.log(`[Manager] Archiving ${staleEvents.length} stale events for ${roomId} (Gap at ${events[splitIndex].timestamp})`);

            // Create session
            run(`INSERT INTO session (session_id, room_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)`, [
                finalSessionId,
                roomId,
                JSON.stringify({
                    auto_generated: true, 
                    note: `Archived stale events (Gap detected)`,
                    range: `${firstT} - ${lastT}`
                }),
                firstT
            ]);

            // Update events
            run(`
                UPDATE event 
                SET session_id = ? 
                WHERE room_id = ? AND session_id IS NULL AND timestamp <= ?
            `, [finalSessionId, roomId, lastT]);

            return { archived: staleEvents.length, sessionId: finalSessionId };
        }

        return { archived: 0 };
    }
}

const manager = new Manager();
module.exports = { manager };
