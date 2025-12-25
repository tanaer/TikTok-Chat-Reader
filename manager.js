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

    // Gift Management - Auto-collect gift info from events
    async upsertGift(giftId, nameEn, iconUrl, diamondCount) {
        if (!giftId) return;
        await this.ensureDb();

        // Upsert: insert or update if exists (preserve Chinese name if already set)
        await run(`
            INSERT INTO gift (gift_id, name_en, icon_url, diamond_count, updated_at)
            VALUES (?, ?, ?, ?, NOW())
            ON CONFLICT (gift_id) DO UPDATE SET
                name_en = COALESCE(EXCLUDED.name_en, gift.name_en),
                icon_url = COALESCE(EXCLUDED.icon_url, gift.icon_url),
                diamond_count = COALESCE(EXCLUDED.diamond_count, gift.diamond_count),
                updated_at = NOW()
        `, [String(giftId), nameEn, iconUrl, diamondCount || 0]);
    }

    async getGifts() {
        await this.ensureDb();
        return await query(`
            SELECT gift_id, name_en, name_cn, icon_url, diamond_count, created_at, updated_at
            FROM gift
            ORDER BY diamond_count DESC, name_en ASC
        `);
    }

    async updateGiftChineseName(giftId, nameCn) {
        await this.ensureDb();
        await run(`
            UPDATE gift SET name_cn = ?, updated_at = NOW()
            WHERE gift_id = ?
        `, [nameCn, String(giftId)]);
    }

    // Get display name: prefer Chinese, fallback to English
    async getGiftDisplayName(giftId) {
        await this.ensureDb();
        const gift = await get(`SELECT name_cn, name_en FROM gift WHERE gift_id = ?`, [String(giftId)]);
        if (gift) {
            return gift.nameCn || gift.nameEn || giftId;
        }
        return giftId;
    }

    // Get all gift display names at once (for batch display)
    async getGiftDisplayNames() {
        await this.ensureDb();
        const gifts = await query(`SELECT gift_id, name_cn, name_en, icon_url FROM gift`);
        const map = {};
        for (const g of gifts) {
            map[g.giftId] = {
                displayName: g.nameCn || g.nameEn || g.giftId,
                icon: g.iconUrl || ''
            };
        }
        return map;
    }

    // Room Management
    async updateRoom(roomId, name, address, isMonitorEnabled, language = null) {
        await this.ensureDb();
        const now = getNowBeijing();

        // Check if room exists to preserve existing values when null is passed
        const existing = await get('SELECT name, address, is_monitor_enabled, language FROM room WHERE room_id = ?', [roomId]);

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

        // Preserve language if null/undefined passed
        let finalLanguage = language;
        if (language === null || language === undefined) {
            finalLanguage = existing ? existing.language : '中文';
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

        console.log(`[Manager] updateRoom - monitorVal: ${monitorVal}, language: ${finalLanguage}`);

        await run(`
            INSERT INTO room (room_id, name, address, language, updated_at, is_monitor_enabled) 
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(room_id) DO UPDATE SET 
                name = excluded.name, 
                address = excluded.address,
                language = excluded.language,
                updated_at = excluded.updated_at,
                is_monitor_enabled = excluded.is_monitor_enabled
        `, [roomId, finalName, finalAddress, finalLanguage, now, monitorVal]);
        return { room_id: roomId, name: finalName, address: finalAddress, language: finalLanguage, is_monitor_enabled: monitorVal };
    }

    async getRooms(options = {}) {
        await this.ensureDb();
        const { page = 1, limit = 50, search = '' } = options;
        const offset = (page - 1) * limit;

        let sql = 'SELECT room_id, numeric_room_id, name, address, updated_at, is_monitor_enabled FROM room';
        let countSql = 'SELECT COUNT(*) as total FROM room';
        const params = [];
        const countParams = [];

        // Fuzzy search on room_id and name
        if (search && search.trim()) {
            const likePattern = `%${search.trim()}%`;
            sql += ' WHERE room_id LIKE ? OR name LIKE ?';
            countSql += ' WHERE room_id LIKE ? OR name LIKE ?';
            params.push(likePattern, likePattern);
            countParams.push(likePattern, likePattern);
        }

        sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rooms = await query(sql, params);
        const countResult = await get(countSql, countParams);

        return {
            data: rooms,
            pagination: {
                page,
                limit,
                total: countResult?.total || 0,
                totalPages: Math.ceil((countResult?.total || 0) / limit)
            }
        };
    }

    async deleteRoom(roomId) {
        await this.ensureDb();
        await run('DELETE FROM room WHERE room_id = ?', [roomId]);
    }

    // Save numeric room ID when connecting to a room
    async setNumericRoomId(uniqueId, numericRoomId) {
        await this.ensureDb();
        if (!numericRoomId) return;

        await run(`UPDATE room SET numeric_room_id = ? WHERE room_id = ?`, [String(numericRoomId), uniqueId]);
        console.log(`[Manager] Saved numeric_room_id ${numericRoomId} for room ${uniqueId}`);
    }

    // Get cached numeric room ID from database (avoids fetching from TikTok)
    async getCachedRoomId(uniqueId) {
        await this.ensureDb();
        const row = await get(`SELECT numeric_room_id FROM room WHERE room_id = ?`, [uniqueId]);
        return row?.numeric_room_id || null;
    }

    // Migrate events from numeric room_id to username room_id
    async migrateEventRoomIds() {
        await this.ensureDb();

        // Get all rooms with numeric_room_id
        const rooms = await query('SELECT room_id, numeric_room_id FROM room WHERE numeric_room_id IS NOT NULL');

        for (const room of rooms) {
            const updated = await run(`
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
        const result = await get('SELECT COUNT(*) as cnt FROM session WHERE session_id LIKE ?', [dateStr + '%']);
        const cnt = result ? result.cnt : 0;
        const sessionId = `${dateStr}${String(cnt + 1).padStart(2, '0')}`;

        await run('INSERT INTO session (session_id, room_id, snapshot_json) VALUES (?, ?, ?)',
            [sessionId, roomId, JSON.stringify(snapshotData)]);
        return sessionId;
    }

    async getSessions(roomId) {
        await this.ensureDb();
        // Use LEFT JOIN with aggregate instead of correlated subquery (much faster)
        if (roomId) {
            return await query(`
                SELECT s.session_id, s.room_id, s.created_at, et.end_time
                FROM session s
                LEFT JOIN (
                    SELECT session_id, MAX(timestamp) as end_time 
                    FROM event 
                    GROUP BY session_id
                ) et ON s.session_id = et.session_id
                WHERE s.room_id = ? 
                ORDER BY s.created_at DESC
            `, [roomId]);
        }
        return await query(`
            SELECT s.session_id, s.room_id, s.created_at, et.end_time
            FROM session s
            LEFT JOIN (
                SELECT session_id, MAX(timestamp) as end_time 
                FROM event 
                GROUP BY session_id
            ) et ON s.session_id = et.session_id
            ORDER BY s.created_at DESC
        `);
    }

    async getSession(sessionId) {
        await this.ensureDb();
        const row = await get('SELECT session_id, room_id, snapshot_json, created_at FROM session WHERE session_id = ?', [sessionId]);
        if (!row) {
            return null; // Session doesn't exist at all
        }

        // Return session info even if snapshot is empty
        let snapshot = {};
        if (row.snapshot_json) {
            try {
                snapshot = JSON.parse(row.snapshot_json);
            } catch (e) {
                console.error(`[Session] Failed to parse snapshot for ${sessionId}:`, e);
            }
        }

        return {
            sessionId: row.session_id,
            roomId: row.room_id,
            createdAt: row.created_at,
            ...snapshot
        };
    }

    // Event Logging - writes to expanded columns (data_json removed to save space)
    async logEvent(roomId, eventType, data, sessionId = null) {
        await this.ensureDb();
        const now = getNowBeijing();

        // Only sync user data for meaningful event types (chat, gift, like)
        // This prevents recording users who only triggered member/view events
        const userRecordableTypes = ['chat', 'gift', 'like'];
        if (data.userId && userRecordableTypes.includes(eventType)) {
            await this.ensureUser({
                userId: data.userId,
                uniqueId: data.uniqueId,
                nickname: data.nickname,
                avatar: data.profilePictureUrl || '',
                region: data.region || null
            });
        }

        // Insert with expanded columns for fast querying (no data_json to save space)
        await run(`INSERT INTO event (
        room_id, session_id, type, timestamp,
        user_id, unique_id, nickname,
        gift_id, diamond_count, repeat_count,
        like_count, total_like_count,
        comment, viewer_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
            data.viewerCount || null
        ]);
    }

    async ensureUser(u) {
        // Skip if no userId - prevents "Wrong API use: undefined" errors
        if (!u || !u.userId) {
            return;
        }

        const now = getNowBeijing();
        await run(`
            INSERT INTO "user" (user_id, unique_id, nickname, avatar, updated_at, region)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                unique_id = excluded.unique_id,
                nickname = excluded.nickname,
                avatar = excluded.avatar,
                updated_at = excluded.updated_at,
                region = COALESCE(excluded.region, "user".region)
        `, [u.userId, u.uniqueId || '', u.nickname || '', u.avatar || '', now, u.region || null]);
    }

    // Get count of untagged events for a room (to check if session should be saved)
    async getUntaggedEventCount(roomId, startTime = null) {
        await this.ensureDb();
        let result;
        if (startTime) {
            const beijingTime = convertToBeijingTimeString(startTime);
            result = await get('SELECT COUNT(*) as cnt FROM event WHERE room_id = ? AND session_id IS NULL AND timestamp >= ?',
                [roomId, beijingTime]);
        } else {
            result = await get('SELECT COUNT(*) as cnt FROM event WHERE room_id = ? AND session_id IS NULL',
                [roomId]);
        }
        return result ? result.cnt : 0;
    }

    // Get count of untagged GIFT events (only create sessions if gifts exist)
    async getUntaggedGiftCount(roomId, startTime = null) {
        await this.ensureDb();
        let result;
        if (startTime) {
            const beijingTime = convertToBeijingTimeString(startTime);
            result = await get(`SELECT COUNT(*) as cnt FROM event WHERE room_id = ? AND type = 'gift' AND session_id IS NULL AND timestamp >= ?`,
                [roomId, beijingTime]);
        } else {
            result = await get(`SELECT COUNT(*) as cnt FROM event WHERE room_id = ? AND type = 'gift' AND session_id IS NULL`,
                [roomId]);
        }
        return result ? parseInt(result.cnt) || 0 : 0;
    }

    // Get the timestamp of the oldest untagged event for a room
    async getOldestOrphanEventTime(roomId) {
        await this.ensureDb();
        const result = await get(`SELECT MIN(timestamp) as oldest FROM event WHERE room_id = ? AND session_id IS NULL`, [roomId]);
        return result && result.oldest ? new Date(result.oldest).getTime() : null;
    }

    // Tag all untagged events for a room with a session_id (called when ending session)
    async tagEventsWithSession(roomId, sessionId, startTime = null) {
        await this.ensureDb();
        if (startTime) {
            // Convert to Beijing time string to match DB format
            const beijingTime = convertToBeijingTimeString(startTime);
            // Only tag events from after startTime
            await run('UPDATE event SET session_id = ? WHERE room_id = ? AND session_id IS NULL AND timestamp >= ?',
                [sessionId, roomId, beijingTime]);
        } else {
            // Tag all untagged events for this room
            await run('UPDATE event SET session_id = ? WHERE room_id = ? AND session_id IS NULL',
                [sessionId, roomId]);
        }
    }

    // Fix orphaned events - group by room_id + date and create sessions
    async fixOrphanedEvents() {
        await this.ensureDb();

        // Find all distinct room_id + date combinations with orphaned events
        const orphanGroups = await query(`
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
            const existing = await get('SELECT session_id FROM session WHERE session_id = ?', [sessionId]);

            if (!existing) {
                // Create new session
                await run(`INSERT INTO session (session_id, room_id, created_at, info) VALUES (?, ?, ?, ?)`, [
                    sessionId,
                    room_id,
                    event_date + ' 00:00:00',
                    JSON.stringify({ migrated: true, note: `Recovered ${cnt} orphaned events` })
                ]);
                sessionsCreated++;
            }

            // Tag all orphaned events for this room+date
            await run(`UPDATE event SET session_id = ? WHERE room_id = ? AND session_id IS NULL AND DATE(timestamp) = ?`,
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
        const emptySessions = await query(`
            SELECT s.session_id, s.room_id
            FROM session s
            LEFT JOIN event e ON s.session_id = e.session_id
            GROUP BY s.session_id
            HAVING COUNT(e.id) = 0
        `);

        console.log(`[Manager] Found ${emptySessions.length} empty sessions to delete`);

        for (const s of emptySessions) {
            await run('DELETE FROM session WHERE session_id = ?', [s.session_id]);
        }

        console.log(`[Manager] Deleted ${emptySessions.length} empty sessions`);
        return { deletedCount: emptySessions.length };
    }

    // Rebuild missing session records - for events that have session_id but no session record
    async rebuildMissingSessions() {
        await this.ensureDb();

        // 1. Missing Sessions
        const missingSessions = await query(`
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
        const collidedSessions = await query(`
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
            while (await get(`SELECT 1 FROM session WHERE session_id = ?`, [newSessionId])) {
                suffix--;
                newSessionId = datePrefix + String(suffix).padStart(2, '0');
            }

            console.log(`[Manager] Fixing collision for ${c.room_id}: ${c.session_id} -> ${newSessionId}`);

            await run(`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)`, [
                newSessionId,
                c.room_id,
                c.first_event,
                JSON.stringify({
                    fixed_collision: true,
                    original_id: c.session_id,
                    note: `Split from collision`
                })
            ]);

            await run(`UPDATE event SET session_id = ? WHERE session_id = ? AND room_id = ?`,
                [newSessionId, c.session_id, c.room_id]);

            collisionsFixed++;
            sessionsCreated++;
        }

        // Fix Missing
        for (const ms of missingSessions) {
            await run(`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)`, [
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
    // OPTIMIZED: Uses LEFT JOIN instead of N+1 subqueries
    async mergeContinuitySessions(gapMinutes = 10) {
        await this.ensureDb();
        const gapMs = gapMinutes * 60 * 1000;

        console.log(`[Manager] Checking for sessions to merge (Gap < ${gapMinutes}m)...`);

        // Pre-compute ALL session boundaries in one query (MUCH faster than N+1)
        const allSessions = await query(`
            SELECT s.session_id, s.room_id, s.created_at, 
                   MIN(e.timestamp) as start_time, 
                   MAX(e.timestamp) as end_time
            FROM session s
            LEFT JOIN event e ON s.session_id = e.session_id
            GROUP BY s.session_id, s.room_id, s.created_at
            ORDER BY s.room_id, s.created_at ASC
        `);

        // Group by room
        const byRoom = {};
        for (const s of allSessions) {
            const roomId = s.room_id;
            if (!byRoom[roomId]) byRoom[roomId] = [];
            byRoom[roomId].push(s);
        }

        let mergedCount = 0;
        for (const sessions of Object.values(byRoom)) {
            mergedCount += await this._mergeSessionList(sessions, gapMs);
        }

        console.log(`[Manager] Merged ${mergedCount} sessions.`);
        return { mergedCount };
    }

    // New optimized method for hourly job: Only check recent sessions
    // OPTIMIZED: Uses LEFT JOIN instead of N+1 subqueries
    async consolidateRecentSessions(hours = 48, gapMinutes = 60) {
        await this.ensureDb();
        const timeLimit = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const gapMs = gapMinutes * 60 * 1000;

        console.log(`[Manager] Consolidating sessions from last ${hours}h with gap < ${gapMinutes}m...`);

        // Pre-compute ALL recent session boundaries in one query
        const recentSessions = await query(`
            SELECT s.session_id, s.room_id, s.created_at, 
                   MIN(e.timestamp) as start_time, 
                   MAX(e.timestamp) as end_time
            FROM session s
            LEFT JOIN event e ON s.session_id = e.session_id
            WHERE s.created_at > ?
            GROUP BY s.session_id, s.room_id, s.created_at
            ORDER BY s.room_id, s.created_at ASC
        `, [timeLimit]);

        // Group by room
        const byRoom = {};
        for (const s of recentSessions) {
            const roomId = s.room_id;
            if (!byRoom[roomId]) byRoom[roomId] = [];
            byRoom[roomId].push(s);
        }

        let totalMerged = 0;
        for (const sessions of Object.values(byRoom)) {
            totalMerged += await this._mergeSessionList(sessions, gapMs);
        }

        if (totalMerged > 0) {
            console.log(`[Manager] Consolidate job merged ${totalMerged} fragmented sessions.`);
        }
        return { mergedCount: totalMerged };
    }

    async _mergeSessionList(sessions, gapMs) {
        if (sessions.length < 2) return 0;
        let mergedCount = 0;
        let prev = sessions[0];

        for (let i = 1; i < sessions.length; i++) {
            const curr = sessions[i];

            // Handle both camelCase (from db.js) and snake_case field names
            const prevEndTime = prev.endTime || prev.end_time;
            const currStartTime = curr.startTime || curr.start_time;
            const prevStartTime = prev.startTime || prev.start_time;
            const currEndTime = curr.endTime || curr.end_time;
            const prevSessionId = prev.sessionId || prev.session_id;
            const currSessionId = curr.sessionId || curr.session_id;

            // Skip invalid data
            if (!prevEndTime || !currStartTime) {
                prev = curr;
                continue;
            }

            // Parse times
            const prevEnd = new Date(prevEndTime).getTime();
            const currStart = new Date(currStartTime).getTime();
            const gap = currStart - prevEnd; // can be negative if overlaps

            // Compare Dates (YYYY-MM-DD) - handle both Date objects (PostgreSQL) and strings (SQLite)
            const prevStartStr = prevStartTime instanceof Date ? prevStartTime.toISOString() : String(prevStartTime);
            const currStartStr = currStartTime instanceof Date ? currStartTime.toISOString() : String(currStartTime);
            const prevDay = prevStartStr.slice(0, 10);
            const currDay = currStartStr.slice(0, 10);

            // Logic: Same Day AND (Small Gap OR Overlap)
            if (prevDay === currDay && gap < gapMs && gap >= 0) {
                // Start Merge
                console.log(`[Manager] Merging ${currSessionId} into ${prevSessionId} (Gap: ${(gap / 1000 / 60).toFixed(1)}m)`);

                // 1. Move events to prev session
                await run('UPDATE event SET session_id = ? WHERE session_id = ?', [prevSessionId, currSessionId]);

                // 2. Delete current session record
                await run('DELETE FROM session WHERE session_id = ?', [currSessionId]);

                // 3. Update 'prev' end_time for next iteration
                const currEnd = new Date(currEndTime).getTime();
                if (currEnd > prevEnd) {
                    prev.end_time = currEndTime;
                    prev.endTime = currEndTime;
                }
                mergedCount++;
            } else {
                // No merge, advance prev
                prev = curr;
            }
        }
        return mergedCount;
    }

    // Startup Cleanup: Archive any "live" events that are old (orphaned from crash)
    async cleanupAllStaleEvents() {
        await this.ensureDb();
        console.log('[Manager] Checking for orphaned live events...');

        const rooms = await query('SELECT room_id FROM room WHERE is_monitor_enabled = 1');
        let totalArchived = 0;

        for (const room of rooms) {
            // Check for stale events > 2 hours old that are still "live"
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

            // Just count them first to see if we need to act
            const staleCountRow = await get(`
                SELECT COUNT(*) as c FROM event 
                WHERE room_id = ? AND session_id IS NULL AND timestamp < ?
            `, [room.room_id, twoHoursAgo]);

            if (staleCountRow && staleCountRow.c > 0) {
                console.log(`[Manager] Found ${staleCountRow.c} orphaned events for ${room.room_id}. Archiving...`);
                const result = await this.archiveStaleLiveEvents(room.room_id);
                totalArchived += result.archived;
            }
        }

        if (totalArchived > 0) {
            console.log(`[Manager] Cleanup complete. Archived ${totalArchived} orphaned events.`);
        }
    }

    async getSessionEvents(sessionId) {
        await this.ensureDb();
        return await query('SELECT type, timestamp, data_json FROM event WHERE session_id = ? ORDER BY timestamp ASC',
            [sessionId]);
    }

    // Time Statistics (30-min intervals)
    async getTimeStats(roomId) {
        await this.ensureDb();
        const events = await query(
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
        await run('UPDATE "user" SET common_language = ?, mastered_languages = ? WHERE user_id = ?',
            [common, mastered, userId]);
    }

    async updateAIAnalysis(userId, analysis) {
        await this.ensureDb();
        // Use upsert pattern - insert if not exists, update if exists
        await run(`
            INSERT INTO "user" (user_id, ai_analysis, updated_at) 
            VALUES (?, ?, NOW())
            ON CONFLICT(user_id) DO UPDATE SET 
                ai_analysis = EXCLUDED.ai_analysis,
                updated_at = NOW()
        `, [userId, analysis]);
    }

    async getTopGifters(page = 1, pageSize = 50, filters = {}) {
        await this.ensureDb();

        const { lang: langFilter = '', languageFilter = '', minRooms = 1, activeHour = null, activeHourEnd = null, search = '', giftPreference = '' } = filters;
        const offset = (page - 1) * pageSize;

        // Step 1: Build filter conditions
        let conditions = ["e.type = 'gift'"];
        let params = [];

        // Language filter from old lang parameter (for backward compatibility)
        if (langFilter) {
            conditions.push(`(u.common_language = ? OR u.mastered_languages = ? OR u.mastered_languages LIKE ?)`);
            params.push(langFilter, langFilter, `%${langFilter}%`);
        }

        // New language filter
        if (languageFilter) {
            conditions.push(`(u.common_language = ? OR u.mastered_languages = ? OR u.mastered_languages LIKE ?)`);
            params.push(languageFilter, languageFilter, `%${languageFilter}%`);
        }

        // Time range filter: if both startHour and endHour are set, filter by range
        if (activeHour !== null && activeHour !== '') {
            if (activeHourEnd !== null && activeHourEnd !== '') {
                // Range filter
                const startH = parseInt(activeHour);
                const endH = parseInt(activeHourEnd);
                if (startH <= endH) {
                    conditions.push(`EXTRACT(HOUR FROM e.timestamp) BETWEEN ? AND ?`);
                    params.push(startH, endH);
                } else {
                    // Wrap around midnight (e.g., 22:00 to 02:00)
                    conditions.push(`(EXTRACT(HOUR FROM e.timestamp) >= ? OR EXTRACT(HOUR FROM e.timestamp) <= ?)`);
                    params.push(startH, endH);
                }
            } else {
                // Single hour filter
                conditions.push(`EXTRACT(HOUR FROM e.timestamp) = ?`);
                params.push(parseInt(activeHour));
            }
        }

        // Search filter for nickname or uniqueId
        if (search) {
            conditions.push(`(u.nickname LIKE ? OR u.unique_id LIKE ?)`);
            params.push(`%${search}%`, `%${search}%`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Build HAVING clause with gift preference filter (Rose vs TikTok)
        let havingConditions = [
            `SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) > 0`,
            `COUNT(DISTINCT e.room_id) >= ?`
        ];

        // Gift preference filter: compare Rose vs TikTok gift totals
        // true_love = Rose > TikTok, knife = TikTok > Rose
        if (giftPreference === 'true_love') {
            havingConditions.push(`
                COALESCE(SUM(CASE WHEN LOWER(e.data_json::json->>'giftName') = 'rose' 
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0) >
                COALESCE(SUM(CASE WHEN LOWER(e.data_json::json->>'giftName') = 'tiktok' 
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0)
            `);
        } else if (giftPreference === 'knife') {
            havingConditions.push(`
                COALESCE(SUM(CASE WHEN LOWER(e.data_json::json->>'giftName') = 'tiktok' 
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0) >
                COALESCE(SUM(CASE WHEN LOWER(e.data_json::json->>'giftName') = 'rose' 
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0)
            `);
        }

        const havingClause = `HAVING ${havingConditions.join(' AND ')}`;

        // Get total count with filters
        const countSql = `
            SELECT COUNT(*) as total FROM (
                SELECT e.user_id
                FROM event e
                JOIN "user" u ON e.user_id = u.user_id
                ${whereClause}
                GROUP BY e.user_id
                ${havingClause}
            ) sub
        `;
        const countResult = await get(countSql, [...params, parseInt(minRooms)]);
        const totalCount = countResult ? countResult.total : 0;

        // Build ORDER BY based on giftPreference
        let orderByClause = 'ORDER BY totalValue DESC';
        if (giftPreference === 'true_love') {
            // Sort by Rose - TikTok difference (descending)
            orderByClause = 'ORDER BY (rose_value - tiktok_value) DESC';
        } else if (giftPreference === 'knife') {
            // Sort by TikTok - Rose difference (descending)
            orderByClause = 'ORDER BY (tiktok_value - rose_value) DESC';
        }

        // Main query
        const mainParams = [...params, parseInt(minRooms), pageSize, offset];
        const rows = await query(`
            SELECT 
                u.user_id as userId,
                u.unique_id as uniqueId,
                u.nickname as nickname,
                u.common_language as commonLanguage,
                u.mastered_languages as masteredLanguages,
                u.region as region,
                SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as totalValue,
                COUNT(DISTINCT e.room_id) as roomCount,
                MAX(e.timestamp) as lastActive,
                COALESCE(SUM(CASE WHEN LOWER(e.data_json::json->>'giftName') = 'rose' 
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0) as rose_value,
                COALESCE(SUM(CASE WHEN LOWER(e.data_json::json->>'giftName') = 'tiktok' 
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0) as tiktok_value
            FROM event e
            JOIN "user" u ON e.user_id = u.user_id
            ${whereClause}
            GROUP BY u.user_id, u.unique_id, u.nickname, u.common_language, u.mastered_languages, u.region
            ${havingClause}
            ${orderByClause}
            LIMIT ? OFFSET ?
        `, mainParams);

        // Step 2: Get additional data in batch for the returned users
        if (rows.length === 0) {
            return { users: [], totalCount, page, pageSize };
        }

        const userIds = rows.map(r => r.userId);
        const placeholders = userIds.map(() => '?').join(',');

        // Batch: chat counts
        const chatStats = await query(`
            SELECT user_id, COUNT(*) as chatCount
            FROM event
            WHERE type = 'chat' AND user_id IN (${placeholders})
            GROUP BY user_id
        `, userIds);
        const chatMap = Object.fromEntries(chatStats.map(r => [r.userId, r.chatCount]));

        // Batch: top room per user (with room name)
        const topRoomStats = await query(`
            SELECT e.user_id, e.room_id, r.name as room_name, 
                   SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as roomValue
            FROM event e
            LEFT JOIN room r ON e.room_id = r.room_id
            WHERE e.type = 'gift' AND e.user_id IN (${placeholders})
            GROUP BY e.user_id, e.room_id, r.name
            ORDER BY e.user_id, roomValue DESC
        `, userIds);

        const topRoomMap = {};
        for (const stat of topRoomStats) {
            if (!topRoomMap[stat.userId]) {
                topRoomMap[stat.userId] = {
                    roomId: stat.roomId,
                    roomName: stat.roomName || stat.roomId
                };
            }
        }

        // Batch: top 6 gifts per user (with gift icon from data_json)
        const topGiftStats = await query(`
            SELECT 
                user_id,
                (data_json::json->>'giftName') as gift_name,
                (data_json::json->>'giftPictureUrl') as gift_icon,
                MAX(COALESCE(diamond_count, 0)) as unit_price,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_value,
                SUM(COALESCE(repeat_count, 1)) as gift_count
            FROM event
            WHERE type = 'gift' AND user_id IN (${placeholders}) AND data_json IS NOT NULL
            GROUP BY user_id, (data_json::json->>'giftName'), (data_json::json->>'giftPictureUrl')
            ORDER BY user_id, total_value DESC
        `, userIds);

        // Group by user, keep top 6 per user
        const topGiftsMap = {};
        for (const g of topGiftStats) {
            if (!topGiftsMap[g.userId]) {
                topGiftsMap[g.userId] = [];
            }
            if (topGiftsMap[g.userId].length < 6) {
                topGiftsMap[g.userId].push({
                    name: g.giftName || '礼物',
                    icon: g.giftIcon || '',
                    unitPrice: parseInt(g.unitPrice) || 0,
                    totalValue: parseInt(g.totalValue) || 0,
                    count: parseInt(g.giftCount) || 0
                });
            }
        }

        // Separate query for Rose and TikTok gifts (not in TOP 6 because low value)
        const roseTikTokStats = await query(`
            SELECT user_id,
                LOWER(data_json::json->>'giftName') as gift_type,
                (data_json::json->>'giftPictureUrl') as gift_icon,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_value,
                SUM(COALESCE(repeat_count, 1)) as gift_count
            FROM event
            WHERE type = 'gift' 
              AND user_id IN (${placeholders}) 
              AND LOWER(data_json::json->>'giftName') IN ('rose', 'tiktok')
            GROUP BY user_id, LOWER(data_json::json->>'giftName'), (data_json::json->>'giftPictureUrl')
        `, userIds);

        // Build maps for Rose and TikTok
        const roseMap = {};
        const tiktokMap = {};
        for (const g of roseTikTokStats) {
            const stats = {
                icon: g.giftIcon || '',
                totalValue: parseInt(g.totalValue) || 0,
                count: parseInt(g.giftCount) || 0
            };
            if (g.giftType === 'rose') {
                roseMap[g.userId] = stats;
            } else if (g.giftType === 'tiktok') {
                tiktokMap[g.userId] = stats;
            }
        }

        // Enrich rows
        for (const user of rows) {
            user.chatCount = parseInt(chatMap[user.userId]) || 0;
            const topRoomInfo = topRoomMap[user.userId] || { roomId: null, roomName: null };
            user.topRoom = topRoomInfo.roomId;
            user.topRoomName = topRoomInfo.roomName;
            user.topGifts = topGiftsMap[user.userId] || [];
            user.roseStats = roseMap[user.userId] || null;
            user.tiktokStats = tiktokMap[user.userId] || null;
            user.isTopRoomModerator = false;
            user.isAdmin = 0;
            user.isSuperAdmin = 0;
            user.isModerator = 0;
            user.fanLevel = 0;
            user.fanClubName = null;
        }

        return { users: rows, totalCount, page, pageSize };
    }

    async getUserChatHistory(userId, limit = 50) {
        await this.ensureDb();
        return await query(`
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
        const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
        return row ? row.value : defaultValue;
    }

    async saveSetting(key, value) {
        await this.ensureDb();
        await run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, NOW())
             ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, value]);
    }

    async getAllSettings() {
        await this.ensureDb();
        const rows = await query('SELECT key, value FROM settings');
        const settings = {};
        for (const r of rows) settings[r.key] = r.value;
        return settings;
    }

    // Room Management
    async deleteRoom(roomId) {
        await this.ensureDb();
        await run('DELETE FROM event WHERE room_id = ?', [roomId]);
        await run('DELETE FROM session WHERE room_id = ?', [roomId]);
        await run('DELETE FROM room WHERE room_id = ?', [roomId]);
    }

    async getGlobalStats() {
        await this.ensureDb();

        // Limit to last 30 days for practical use and better performance
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            .toISOString().replace('T', ' ').slice(0, 19);

        // Chinese language filter: only include users with Chinese as primary or secondary language
        const chineseFilter = `(u.common_language = '中文' OR u.mastered_languages = '中文')`;

        // 24-Hour Distribution - use PostgreSQL EXTRACT for hour
        // Filter by Chinese-speaking users only
        const hourChatRows = await query(`
            SELECT to_char(e.timestamp, 'HH24') as hour, COUNT(*) as cnt
            FROM event e
            LEFT JOIN "user" u ON e.user_id = u.user_id
            WHERE e.type = 'chat' AND e.timestamp >= ? AND ${chineseFilter}
            GROUP BY hour
        `, [thirtyDaysAgo]);

        const hourGiftRows = await query(`
            SELECT to_char(e.timestamp, 'HH24') as hour, 
                   SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as val
            FROM event e
            LEFT JOIN "user" u ON e.user_id = u.user_id
            WHERE e.type = 'gift' AND e.timestamp >= ? AND ${chineseFilter}
            GROUP BY hour
        `, [thirtyDaysAgo]);

        const hourStats = {};
        for (let i = 0; i < 24; i++) hourStats[String(i).padStart(2, '0')] = { gift: 0, chat: 0 };

        for (const r of hourChatRows) {
            if (hourStats[r.hour]) hourStats[r.hour].chat = parseInt(r.cnt) || 0;
        }
        for (const r of hourGiftRows) {
            if (hourStats[r.hour]) hourStats[r.hour].gift = parseInt(r.val) || 0;
        }

        // Weekly Distribution - use PostgreSQL EXTRACT(DOW) for day of week (0=Sunday)
        // Filter by Chinese-speaking users only
        const dayChatRows = await query(`
            SELECT EXTRACT(DOW FROM e.timestamp)::int as day, COUNT(*) as cnt
            FROM event e
            LEFT JOIN "user" u ON e.user_id = u.user_id
            WHERE e.type = 'chat' AND e.timestamp >= ? AND ${chineseFilter}
            GROUP BY day
        `, [thirtyDaysAgo]);

        const dayGiftRows = await query(`
            SELECT EXTRACT(DOW FROM e.timestamp)::int as day,
                   SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as val
            FROM event e
            LEFT JOIN "user" u ON e.user_id = u.user_id
            WHERE e.type = 'gift' AND e.timestamp >= ? AND ${chineseFilter}
            GROUP BY day
        `, [thirtyDaysAgo]);

        const dayStats = {};
        for (let i = 0; i < 7; i++) dayStats[i] = { gift: 0, chat: 0 };

        for (const r of dayChatRows) {
            const d = parseInt(r.day);
            dayStats[d].chat = parseInt(r.cnt) || 0;
        }
        for (const r of dayGiftRows) {
            const d = parseInt(r.day);
            dayStats[d].gift = parseInt(r.val) || 0;
        }

        return { hourStats, dayStats };
    }

    async getRoomStats(liveRoomIds = [], options = {}) {
        await this.ensureDb();
        const { page = 1, limit = 50, search = '', sort = 'updated_at' } = options;

        // OPTIMIZED: Simple room query without expensive subqueries
        // Gift values are calculated in the batch combinedStats query for only the current page's rooms
        let roomSql = `SELECT * FROM room r`;
        let countSql = 'SELECT COUNT(*) as total FROM room';
        const params = [];
        const countParams = [];

        // 1. Apply Search Filter
        if (search && search.trim()) {
            const likePattern = `%${search.trim()}%`;
            roomSql += ' WHERE (r.room_id LIKE ? OR r.name LIKE ?)';
            countSql += ' WHERE (room_id LIKE ? OR name LIKE ?)';
            params.push(likePattern, likePattern);
            countParams.push(likePattern, likePattern);
        }

        // 2. Apply Ordering
        // NOTE: Gift-based sorts use in-memory sorting since we removed expensive subqueries
        let orderBy = '';
        if (sort === 'gift_desc' || sort === 'gift_asc' || sort === 'total_gift_desc' || sort === 'total_gift_asc') {
            // Will be sorted in-memory after fetching stats - use default order for now
            orderBy = 'r.updated_at DESC';
        } else {
            // Default: Live first, then updated_at
            if (liveRoomIds.length > 0) {
                const placeholders = liveRoomIds.map(() => '?').join(',');
                orderBy = `
                    CASE WHEN r.room_id IN (${placeholders}) THEN 0 ELSE 2 END + 
                    CASE WHEN r.is_monitor_enabled = 0 THEN 1 ELSE 0 END,
                    r.updated_at DESC`;
                params.push(...liveRoomIds);
            } else {
                orderBy = 'CASE WHEN r.is_monitor_enabled = 0 THEN 1 ELSE 0 END, r.updated_at DESC';
            }
        }

        roomSql += ` ORDER BY ${orderBy}`;

        // 3. Get total count
        const countResult = await get(countSql, countParams);
        const total = countResult?.total || 0;

        // Check if this is a calculated metric sort that requires in-memory sorting
        const calculatedMetricSorts = [
            'gift_desc', 'gift_asc', 'total_gift_desc', 'total_gift_asc',  // Gift sorts now in-memory
            'gift_eff_desc', 'gift_eff_asc',
            'interact_eff_desc', 'interact_eff_asc',
            'account_quality_desc', 'account_quality_asc',
            'top10_ratio_desc', 'top10_ratio_asc',
            'top30_ratio_desc', 'top30_ratio_asc',
            'top1_ratio_desc', 'top1_ratio_asc',
            'top3_ratio_desc', 'top3_ratio_asc',
            'daily_avg_desc', 'daily_avg_asc'
        ];
        const isCalculatedSort = calculatedMetricSorts.includes(sort);

        // 4. Apply Pagination (skip for calculated sorts - we'll paginate after sorting)
        const offset = (page - 1) * limit;
        if (!isCalculatedSort) {
            roomSql += ' LIMIT ? OFFSET ?';
            params.push(limit, offset);
        }

        const rooms = await query(roomSql, params);

        if (rooms.length === 0) {
            return {
                data: [],
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
            };
        }

        // 5. Batch fetch stats for these rooms (use roomId after camelCase conversion)
        const roomIds = rooms.map(r => r.roomId);
        const placeholders = roomIds.map(() => '?').join(',');

        // OPTIMIZED: Single consolidated query for all basic stats (replaces 9 separate queries)
        const combinedStats = await query(`
            SELECT 
                room_id,
                -- Current session stats (session_id IS NULL)
                COUNT(*) FILTER (WHERE type = 'member' AND session_id IS NULL) as curr_visits,
                COUNT(*) FILTER (WHERE type = 'chat' AND session_id IS NULL) as curr_comments,
                COALESCE(SUM(CASE WHEN type = 'gift' AND session_id IS NULL 
                    THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END), 0) as curr_gift,
                MAX(CASE WHEN type = 'like' AND session_id IS NULL 
                    THEN COALESCE(total_like_count, 0) ELSE 0 END) as curr_likes,
                -- All-time stats
                COUNT(*) FILTER (WHERE type = 'member') as all_visits,
                COUNT(*) FILTER (WHERE type = 'chat') as all_comments,
                COALESCE(SUM(CASE WHEN type = 'gift' 
                    THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END), 0) as all_gift,
                -- Duration (current session only)
                EXTRACT(EPOCH FROM (
                    MAX(CASE WHEN session_id IS NULL THEN timestamp END) - 
                    MIN(CASE WHEN session_id IS NULL THEN timestamp END)
                )) as duration_secs,
                MIN(CASE WHEN session_id IS NULL THEN timestamp END) as start_time,
                -- All-time duration (for accountQuality calculation)
                EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) as all_time_duration_secs
            FROM event 
            WHERE room_id IN (${placeholders})
            GROUP BY room_id
        `, roomIds);

        // Build lookup maps from combined query
        const statsMap = {};
        for (const r of combinedStats) {
            statsMap[r.roomId] = {
                currVisits: parseInt(r.currVisits) || 0,
                currComments: parseInt(r.currComments) || 0,
                currGift: parseInt(r.currGift) || 0,
                currLikes: parseInt(r.currLikes) || 0,
                allVisits: parseInt(r.allVisits) || 0,
                allComments: parseInt(r.allComments) || 0,
                allGift: parseInt(r.allGift) || 0,
                durationSecs: parseFloat(r.durationSecs) || 0,
                allTimeDurationSecs: parseFloat(r.allTimeDurationSecs) || 0,
                startTime: r.startTime || null
            };
        }

        // Last session times (keep separate - uses session table)
        const lastSessions = await query(`
            SELECT s1.room_id, s1.created_at 
            FROM session s1
            INNER JOIN (
                SELECT room_id, MAX(created_at) as max_created
                FROM session
                WHERE room_id IN (${placeholders})
                GROUP BY room_id
            ) s2 ON s1.room_id = s2.room_id AND s1.created_at = s2.max_created
        `, roomIds);
        const sessionMap = Object.fromEntries(lastSessions.map(r => [r.roomId, r.createdAt]));

        // Valid Daily Gift Average - only if sorting by daily average (for performance)
        const needsDailyAvg = sort.includes('daily_avg');

        // TOP1/TOP3/TOP10/TOP30 Gift Concentration - always calculate (displayed in default view)
        const concentrationStats = await query(`
            WITH user_gifts AS (
                SELECT room_id, user_id,
                       SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as user_total
                FROM event 
                WHERE room_id IN (${placeholders}) AND type = 'gift' AND user_id IS NOT NULL
                GROUP BY room_id, user_id
            ),
            ranked_users AS (
                SELECT room_id, user_id, user_total,
                       ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY user_total DESC) as rank,
                       SUM(user_total) OVER (PARTITION BY room_id) as room_total
                FROM user_gifts
            )
            SELECT room_id,
                   COALESCE(SUM(CASE WHEN rank <= 1 THEN user_total ELSE 0 END), 0) as top1_value,
                   COALESCE(SUM(CASE WHEN rank <= 3 THEN user_total ELSE 0 END), 0) as top3_value,
                   COALESCE(SUM(CASE WHEN rank <= 10 THEN user_total ELSE 0 END), 0) as top10_value,
                   COALESCE(SUM(CASE WHEN rank <= 30 THEN user_total ELSE 0 END), 0) as top30_value,
                   MAX(room_total) as total_value
            FROM ranked_users
            GROUP BY room_id
        `, roomIds);
        const concentrationMap = Object.fromEntries(concentrationStats.map(r => [r.roomId, {
            top1: parseInt(r.top1Value) || 0,
            top3: parseInt(r.top3Value) || 0,
            top10: parseInt(r.top10Value) || 0,
            top30: parseInt(r.top30Value) || 0,
            total: parseInt(r.totalValue) || 0
        }]));

        // Valid Daily Gift Average - only if sorting by daily average
        let validDailyMap = {};
        if (needsDailyAvg) {
            const validDailyStats = await query(`
                WITH daily_stats AS (
                    SELECT 
                        room_id,
                        DATE(timestamp) as day,
                        SUM(CASE WHEN type = 'gift' THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END) as gift_value,
                        EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 3600 as hours
                    FROM event 
                    WHERE room_id IN (${placeholders})
                    GROUP BY room_id, DATE(timestamp)
                    HAVING EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 3600 >= 3
                )
                SELECT room_id, 
                       AVG(gift_value) as avg_gift,
                       COUNT(*) as valid_days
                FROM daily_stats
                GROUP BY room_id
            `, roomIds);
            validDailyMap = Object.fromEntries(validDailyStats.map(r => [r.roomId, {
                avgGift: Math.round(parseFloat(r.avgGift)) || 0,
                validDays: parseInt(r.validDays) || 0
            }]));
        }

        // 6. Build final stats objects (use roomId after camelCase conversion)
        const stats = rooms.map(r => {
            const s = statsMap[r.roomId] || {};
            const visits = s.currVisits || 0;
            const comments = s.currComments || 0;
            const allTimeVisits = s.allVisits || 0;
            const allTimeComments = s.allComments || 0;
            const currentGift = s.currGift || 0;
            const allTimeGift = s.allGift || 0;
            const durationSecs = s.durationSecs || 0;
            const durationMins = durationSecs / 60;
            const allTimeDurationMins = (s.allTimeDurationSecs || 0) / 60;

            // Calculate efficiency metrics using ALL-TIME data (avoid division by zero)
            const giftEfficiency = allTimeVisits > 0 ? (allTimeGift / allTimeVisits).toFixed(2) : 0;
            const interactEfficiency = allTimeVisits > 0 ? (allTimeComments / allTimeVisits).toFixed(2) : 0;
            // Account quality: visits per minute of ALL-TIME broadcast (higher = better traffic quality)
            const accountQuality = allTimeDurationMins > 0 ? (allTimeVisits / allTimeDurationMins).toFixed(2) : 0;

            // TOP1/TOP3/TOP10/TOP30 gift concentration ratios (% of total gifts from top N users)
            const concentration = concentrationMap[r.roomId] || { top1: 0, top3: 0, top10: 0, top30: 0, total: 0 };
            const top1Ratio = concentration.total > 0 ? Math.round((concentration.top1 / concentration.total) * 100) : 0;
            const top3Ratio = concentration.total > 0 ? Math.round((concentration.top3 / concentration.total) * 100) : 0;
            const top10Ratio = concentration.total > 0 ? Math.round((concentration.top10 / concentration.total) * 100) : 0;
            const top30Ratio = concentration.total > 0 ? Math.round((concentration.top30 / concentration.total) * 100) : 0;

            return {
                ...r,
                isLive: liveRoomIds.includes(r.roomId),
                totalVisits: visits,
                totalComments: comments,
                totalGiftValue: currentGift,  // Current session gift value
                allTimeGiftValue: allTimeGift,  // All time gift value
                totalLikes: s.currLikes || 0,
                lastSessionTime: sessionMap[r.roomId] || null,
                broadcastDuration: Math.round(durationSecs),  // Current session seconds
                startTime: s.startTime || null,    // Current session start time
                giftEfficiency: parseFloat(giftEfficiency),  // Gift value per visitor
                interactEfficiency: parseFloat(interactEfficiency),  // Comments per visitor
                accountQuality: parseFloat(accountQuality),  // Visits per minute
                top1Ratio: top1Ratio,    // TOP1 gifter % of total
                top3Ratio: top3Ratio,    // TOP3 gifters % of total
                top10Ratio: top10Ratio,  // TOP10 gifters % of total
                top30Ratio: top30Ratio,  // TOP30 gifters % of total
                validDailyAvg: (validDailyMap[r.roomId]?.avgGift) || 0,    // Avg daily gift on valid days (>3h)
                validDays: (validDailyMap[r.roomId]?.validDays) || 0       // Number of valid broadcast days
            };
        });

        // In-memory sort for calculated metrics and default mode
        if (sort === 'default') {
            stats.sort((a, b) => {
                if (a.isLive && !b.isLive) return -1;
                if (!a.isLive && b.isLive) return 1;
                return 0;
            });
        } else if (sort === 'gift_desc') {
            stats.sort((a, b) => b.totalGiftValue - a.totalGiftValue);
        } else if (sort === 'gift_asc') {
            stats.sort((a, b) => a.totalGiftValue - b.totalGiftValue);
        } else if (sort === 'total_gift_desc') {
            stats.sort((a, b) => b.allTimeGiftValue - a.allTimeGiftValue);
        } else if (sort === 'total_gift_asc') {
            stats.sort((a, b) => a.allTimeGiftValue - b.allTimeGiftValue);
        } else if (sort === 'gift_eff_desc') {
            stats.sort((a, b) => b.giftEfficiency - a.giftEfficiency);
        } else if (sort === 'gift_eff_asc') {
            stats.sort((a, b) => a.giftEfficiency - b.giftEfficiency);
        } else if (sort === 'interact_eff_desc') {
            stats.sort((a, b) => b.interactEfficiency - a.interactEfficiency);
        } else if (sort === 'interact_eff_asc') {
            stats.sort((a, b) => a.interactEfficiency - b.interactEfficiency);
        } else if (sort === 'account_quality_desc') {
            stats.sort((a, b) => b.accountQuality - a.accountQuality);
        } else if (sort === 'account_quality_asc') {
            stats.sort((a, b) => a.accountQuality - b.accountQuality);
        } else if (sort === 'top10_ratio_desc') {
            // Sort from low to high (lower concentration = better diversification)
            stats.sort((a, b) => a.top10Ratio - b.top10Ratio);
        } else if (sort === 'top10_ratio_asc') {
            stats.sort((a, b) => b.top10Ratio - a.top10Ratio);
        } else if (sort === 'top30_ratio_desc') {
            stats.sort((a, b) => a.top30Ratio - b.top30Ratio);
        } else if (sort === 'top30_ratio_asc') {
            stats.sort((a, b) => b.top30Ratio - a.top30Ratio);
        } else if (sort === 'top1_ratio_desc') {
            stats.sort((a, b) => a.top1Ratio - b.top1Ratio);
        } else if (sort === 'top1_ratio_asc') {
            stats.sort((a, b) => b.top1Ratio - a.top1Ratio);
        } else if (sort === 'top3_ratio_desc') {
            stats.sort((a, b) => a.top3Ratio - b.top3Ratio);
        } else if (sort === 'top3_ratio_asc') {
            stats.sort((a, b) => b.top3Ratio - a.top3Ratio);
        } else if (sort === 'daily_avg_desc') {
            stats.sort((a, b) => b.validDailyAvg - a.validDailyAvg);
        } else if (sort === 'daily_avg_asc') {
            stats.sort((a, b) => a.validDailyAvg - b.validDailyAvg);
        }

        // Apply pagination AFTER in-memory sort for calculated metrics
        let paginatedStats = stats;
        if (isCalculatedSort) {
            paginatedStats = stats.slice(offset, offset + limit);
        }

        return {
            data: paginatedStats,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    async getUserAnalysis(userId) {
        await this.ensureDb();

        // 1. Basic Stats - use direct columns instead of JSON extraction to avoid Unicode errors
        const giftStats = await get(`
            SELECT 
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as totalValue,
                MIN(timestamp) as firstSeen,
                MAX(timestamp) as lastSeen,
                COUNT(DISTINCT timestamp::date) as activeDays
            FROM event 
            WHERE type = 'gift' AND user_id = ?
        `, [userId]);

        // 2. Top Rooms (Gift) - use direct columns
        const giftRooms = await query(`
            SELECT e.room_id, MAX(r.name) as name, 
                   SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as val
            FROM event e
            LEFT JOIN room r ON e.room_id = r.room_id
            WHERE e.type = 'gift' AND e.user_id = ?
            GROUP BY e.room_id
            ORDER BY val DESC
            LIMIT 10
        `, [userId]);

        // 3. Top Rooms (Visit - from member events)
        const visitRooms = await query(`
             SELECT e.room_id, MAX(r.name) as name, COUNT(*) as cnt
             FROM event e
             LEFT JOIN room r ON e.room_id = r.room_id
             WHERE e.type = 'member' AND e.user_id = ?
             GROUP BY e.room_id
             ORDER BY cnt DESC
             LIMIT 10
        `, [userId]);

        // 4. Time Distribution (Hour of Day)
        const hourStats = await query(`
            SELECT to_char(timestamp, 'HH24') as hour, COUNT(*) as cnt
            FROM event
            WHERE type = 'gift' AND user_id = ?
            GROUP BY hour
            ORDER BY hour
        `, [userId]);

        // 5. Day of Week (0 = Sunday, 6 = Saturday)
        const dayStats = await query(`
            SELECT EXTRACT(DOW FROM timestamp)::int as day, COUNT(*) as cnt
            FROM event
            WHERE type = 'gift' AND user_id = ?
            GROUP BY day
            ORDER BY day
        `, [userId]);

        // 6. Role and Fan Badge Info - query user table which stores these values
        const userInfo = await get(`SELECT * FROM "user" WHERE user_id = ?`, [userId]);

        // 7. Rooms where user is moderator - check from user table or skip if performance issue
        const moderatorRooms = [];

        return {
            totalValue: parseInt(giftStats?.totalValue) || 0,
            activeDays: parseInt(giftStats?.activeDays) || 1,
            dailyAvg: (parseInt(giftStats?.totalValue) || 0) / (parseInt(giftStats?.activeDays) || 1),
            giftRooms,
            visitRooms,
            hourStats,
            dayStats,
            isAdmin: userInfo?.isAdmin || 0,
            isSuperAdmin: userInfo?.isSuperAdmin || 0,
            isModerator: userInfo?.isModerator || 0,
            fanLevel: userInfo?.fanLevel || 0,
            fanClubName: userInfo?.fanClubName || '',
            commonLanguage: userInfo?.commonLanguage || '',
            masteredLanguages: userInfo?.masteredLanguages || '',
            region: userInfo?.region || '',
            aiAnalysis: userInfo?.aiAnalysis || null,
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

        const summary = await get(`
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
        const timeRange = await get(`SELECT MIN(timestamp) as start, MAX(timestamp) as end FROM event ${whereClause}`, params);
        let duration = 0;
        if (timeRange.start && timeRange.end) {
            const start = new Date(timeRange.start);
            const end = new Date(timeRange.end);
            duration = Math.floor((end - start) / 1000); // seconds
        }

        // 2. Leaderboards

        // Top Gifters
        const topGifters = await query(`
            SELECT 
                MAX(nickname) as nickname,
                user_id as userId,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as value
            FROM event
            ${whereClause} AND type = 'gift'
            GROUP BY user_id
            ORDER BY value DESC
            LIMIT 20
        `, params);

        // Top Chatters
        const topChatters = await query(`
            SELECT 
                MAX(nickname) as nickname,
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
        const topLikers = await query(`
            SELECT 
                MAX(nickname) as nickname,
                user_id as userId,
                SUM(COALESCE(like_count, 0)) as count
            FROM event
            ${whereClause} AND type = 'like'
            GROUP BY user_id
            ORDER BY count DESC
            LIMIT 20
        `, params);

        // Use LEFT JOIN gift table for gift names since data_json is no longer written
        // Note: e.gift_id is INTEGER but g.gift_id is TEXT, need to cast for JOIN
        const giftDetails = await query(`
            SELECT 
                MAX(e.nickname) as nickname,
                MAX(e.unique_id) as uniqueId,
                e.gift_id as giftId,
                COALESCE(g.name_cn, g.name_en, 'ID:' || e.gift_id) as giftName,
                SUM(COALESCE(e.repeat_count, 1)) as count,
                MAX(COALESCE(e.diamond_count, 0)) as unitPrice,
                SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as totalValue
            FROM event e
            LEFT JOIN gift g ON e.gift_id::TEXT = g.gift_id
            ${whereClause.replace(/room_id/g, 'e.room_id').replace(/session_id/g, 'e.session_id')} AND e.type = 'gift'
            GROUP BY e.user_id, e.gift_id, g.name_cn, g.name_en
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

    // All-time TOP30 leaderboards (across all sessions)
    async getAllTimeLeaderboards(roomId) {
        await this.ensureDb();

        // Top 30 Gifters (all time)
        const topGifters = await query(`
            SELECT 
                MAX(nickname) as nickname,
                user_id as userId,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as value
            FROM event
            WHERE room_id = ? AND type = 'gift' AND user_id IS NOT NULL
            GROUP BY user_id
            ORDER BY value DESC
            LIMIT 30
        `, [roomId]);

        // Top 30 Chatters (all time)
        const topChatters = await query(`
            SELECT 
                MAX(nickname) as nickname,
                user_id as userId,
                COUNT(*) as count
            FROM event
            WHERE room_id = ? AND type = 'chat' AND user_id IS NOT NULL
            GROUP BY user_id
            ORDER BY count DESC
            LIMIT 30
        `, [roomId]);

        // Top 30 Likers (all time)
        const topLikers = await query(`
            SELECT 
                MAX(nickname) as nickname,
                user_id as userId,
                SUM(COALESCE(like_count, 0)) as count
            FROM event
            WHERE room_id = ? AND type = 'like' AND user_id IS NOT NULL
            GROUP BY user_id
            ORDER BY count DESC
            LIMIT 30
        `, [roomId]);

        return {
            gifters: topGifters,
            chatters: topChatters,
            likers: topLikers
        };
    }

    // Archive stale live events (fix for "long session" bug)
    // Two strategies:
    // 1. If there's a large time gap (1 hour), split the events at the gap
    // 2. Force archive any events older than 2 hours (prevents 20+ hour "live" sessions)
    async archiveStaleLiveEvents(roomId) {
        await this.ensureDb();

        const now = Date.now();
        const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();

        // Get all timestamps of current live events
        const events = await query(`
            SELECT id, timestamp 
            FROM event 
            WHERE room_id = ? AND session_id IS NULL 
            ORDER BY timestamp ASC
        `, [roomId]);

        if (events.length === 0) return { archived: 0 };

        const GAP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour gap counts as new session
        let lastTime = new Date(events[0].timestamp).getTime();
        let splitIndex = -1;

        // Strategy 1: Find the first major time gap
        for (let i = 1; i < events.length; i++) {
            const currTime = new Date(events[i].timestamp).getTime();
            if (currTime - lastTime > GAP_THRESHOLD_MS) {
                splitIndex = i;
                break;
            }
            lastTime = currTime;
        }

        // Strategy 2: If no gap found, check if oldest events are > 2 hours old
        // This handles the case where stream ended but disconnect event was missed
        if (splitIndex === -1) {
            const oldestEventTime = new Date(events[0].timestamp).getTime();
            const newestEventTime = new Date(events[events.length - 1].timestamp).getTime();

            // If oldest event is > 2 hours old AND there are recent events (within last 10 mins)
            // this indicates a missed session boundary
            const ageOfOldest = now - oldestEventTime;
            const ageOfNewest = now - newestEventTime;

            if (ageOfOldest > 2 * 60 * 60 * 1000 && ageOfNewest < 10 * 60 * 1000) {
                // Archive events older than 2 hours as a separate session
                for (let i = 0; i < events.length; i++) {
                    if (events[i].timestamp > twoHoursAgo) {
                        splitIndex = i;
                        break;
                    }
                }
                if (splitIndex > 0) {
                    console.log(`[Manager] Forcing archive of ${splitIndex} old events for ${roomId} (Age-based split)`);
                }
            }
        }

        // Strategy 3: If all orphan events are older than 30 minutes, archive ALL of them
        // This handles the case where stream ended and we're reconnecting much later
        if (splitIndex === -1) {
            const newestEventTime = new Date(events[events.length - 1].timestamp).getTime();
            const ageOfNewest = now - newestEventTime;
            const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

            if (ageOfNewest > STALE_THRESHOLD_MS) {
                // All events are stale - archive everything
                splitIndex = events.length; // Archive all
                console.log(`[Manager] Archiving all ${events.length} stale events for ${roomId} (All events > 30 min old)`);
            }
        }

        if (splitIndex > 0) {
            // Archive events[0...splitIndex-1]
            const staleEvents = events.slice(0, splitIndex);
            const firstT = events[0].timestamp;
            const lastT = events[splitIndex - 1].timestamp;

            // Convert timestamp to string format if it's a Date object (PostgreSQL)
            const firstTStr = firstT instanceof Date ? firstT.toISOString().slice(0, 10) : firstT.slice(0, 10);
            const sessionId = firstTStr.replace(/-/g, '') + '99'; // e.g. 2025121299

            // Generate unique session ID if collision
            let finalSessionId = sessionId;
            let suffix = 99;
            while (await get(`SELECT 1 FROM session WHERE session_id = ?`, [finalSessionId])) {
                suffix--;
                finalSessionId = firstTStr.replace(/-/g, '') + suffix;
            }

            const splitInfo = splitIndex < events.length ? `Gap at ${events[splitIndex].timestamp}` : 'All events stale';
            console.log(`[Manager] Archiving ${staleEvents.length} stale events for ${roomId} (${splitInfo})`);

            // Create session
            await run(`INSERT INTO session (session_id, room_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)`, [
                finalSessionId,
                roomId,
                JSON.stringify({
                    auto_generated: true,
                    note: `Archived stale events (Gap/Age detected)`,
                    range: `${firstT} - ${lastT}`
                }),
                firstT
            ]);

            // Update events
            await run(`
                UPDATE event 
                SET session_id = ? 
                WHERE room_id = ? AND session_id IS NULL AND timestamp <= ?
            `, [finalSessionId, roomId, lastT]);

            return { archived: staleEvents.length, sessionId: finalSessionId };
        }

        return { archived: 0 };
    }

    // Analyze user languages from chat messages
    // Uses regex to detect Chinese and English, updates primary_language (common_language) and secondary_language (mastered_languages)
    async analyzeUserLanguages(limit = 100) {
        await this.ensureDb();
        console.log('[Manager] Starting user language analysis...');

        // Get users who haven't been analyzed yet (language_analyzed = 0 or NULL)
        const users = await query(`
            SELECT user_id FROM "user" 
            WHERE (language_analyzed IS NULL OR language_analyzed = 0)
            LIMIT ?
        `, [limit]);

        if (users.length === 0) {
            console.log('[Manager] No users to analyze');
            return { analyzed: 0 };
        }

        console.log(`[Manager] Analyzing language for ${users.length} users...`);

        const CHINESE_REGEX = /[\u4e00-\u9fff]/g;
        const ENGLISH_REGEX = /[a-zA-Z]{2,}/g;
        const EMOJI_ONLY_REGEX = /^[\p{Emoji}\s\d]+$/u;

        let analyzed = 0;
        for (const user of users) {
            // Get last 20 chat messages for this user
            const chats = await query(`
                SELECT comment FROM event 
                WHERE user_id = ? AND type = 'chat' AND comment IS NOT NULL
                ORDER BY timestamp DESC LIMIT 20
            `, [user.userId]);

            if (chats.length === 0) {
                // Mark as analyzed with no language
                await run(`UPDATE "user" SET language_analyzed = 1 WHERE user_id = ?`, [user.userId]);
                continue;
            }

            let chineseCount = 0;
            let englishCount = 0;
            let validMessages = 0;

            for (const chat of chats) {
                const text = chat.comment || '';

                // Skip emoji-only messages
                if (EMOJI_ONLY_REGEX.test(text)) continue;

                validMessages++;
                const chineseMatches = text.match(CHINESE_REGEX) || [];
                const englishMatches = text.match(ENGLISH_REGEX) || [];

                if (chineseMatches.length > 0) chineseCount++;
                if (englishMatches.length > 0) englishCount++;
            }

            if (validMessages === 0) {
                await run(`UPDATE "user" SET language_analyzed = 1 WHERE user_id = ?`, [user.userId]);
                continue;
            }

            // Determine primary and secondary language
            let primaryLang = null;
            let secondaryLang = null;

            if (chineseCount > 0 && englishCount > 0) {
                // Both detected
                if (chineseCount >= englishCount) {
                    primaryLang = '中文';
                    secondaryLang = 'English';
                } else {
                    primaryLang = 'English';
                    secondaryLang = '中文';
                }
            } else if (chineseCount > 0) {
                primaryLang = '中文';
            } else if (englishCount > 0) {
                primaryLang = 'English';
            } else {
                primaryLang = '其他语种';
            }

            // Update user
            await run(`
                UPDATE "user" SET 
                    common_language = ?,
                    mastered_languages = ?,
                    language_analyzed = 1
                WHERE user_id = ?
            `, [primaryLang, secondaryLang, user.userId]);

            analyzed++;
        }

        console.log(`[Manager] Language analysis complete. Analyzed ${analyzed} users.`);
        return { analyzed };
    }
}

const manager = new Manager();
module.exports = { manager };
