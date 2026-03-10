/**
 * Manager module - Price, Room, Session, Event management
 * Replaces Python manager.py
 */
const fs = require('fs');
const path = require('path');
const { initDb, query, run, get } = require('./db');
const metricsService = require('./services/metricsService');
const { getSchemeAConfig } = require('./services/featureFlagService');

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

function isLikelyExactRoomIdSearch(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._@-]+$/.test(value.trim());
}

function toOptionalText(value) {
    if (value === undefined || value === null || value === '') return null;
    return String(value);
}

function toInteger(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toBooleanInteger(value) {
    return value ? 1 : 0;
}

function safeJsonStringify(value, fallback = '{}') {
    try {
        return JSON.stringify(value ?? {});
    } catch {
        return fallback;
    }
}

const EVENT_GIFT_NAME_SQL = `COALESCE(NULLIF(gift_name, ''), data_json::json->>'giftName')`;
const EVENT_GIFT_IMAGE_SQL = `COALESCE(NULLIF(gift_image, ''), data_json::json->>'giftImage', data_json::json->>'giftPictureUrl')`;
const EVENT_GIFT_TYPE_SQL = `LOWER(COALESCE(NULLIF(gift_name, ''), data_json::json->>'giftName', ''))`;

function buildEventDataJsonFromRow(row = {}) {
    return safeJsonStringify({
        userId: row.userId || null,
        uniqueId: row.uniqueId || null,
        nickname: row.nickname || null,
        giftId: row.giftId ?? null,
        giftName: row.giftName || null,
        giftImage: row.giftImage || null,
        groupId: row.groupId || null,
        diamondCount: row.diamondCount ?? 0,
        repeatCount: row.repeatCount ?? 1,
        likeCount: row.likeCount ?? 0,
        totalLikeCount: row.totalLikeCount ?? 0,
        comment: row.comment || null,
        viewerCount: row.viewerCount ?? null,
        region: row.region || null,
        isAdmin: Boolean(row.isAdmin),
        isSuperAdmin: Boolean(row.isSuperAdmin),
        isModerator: Boolean(row.isModerator),
        fanLevel: row.fanLevel ?? 0,
        fanClubName: row.fanClubName || null,
    });
}

function isIncrementalStatsReadEnabled() {
    return Boolean(getSchemeAConfig().event.enableIncrementalStats);
}

class Manager {
    constructor() {
        this.prices = this.loadPrices();
        this.dbReady = false;
        // Settings cache to avoid frequent DB queries
        this.settingsCache = null;
        this.settingsCacheTime = 0;
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
    async updateRoom(roomId, name, address, isMonitorEnabled, language = null, priority = null, isRecordingEnabled = null, recordingAccountId = null) {
        await this.ensureDb();
        const now = getNowBeijing();

        // Check if room exists to preserve existing values when null is passed
        const existing = await get('SELECT name, address, is_monitor_enabled, language, priority, is_recording_enabled, recording_account_id FROM room WHERE room_id = ?', [roomId]);

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

        // Preserve priority if null/undefined passed (default 0)
        let finalPriority = priority;
        if (priority === null || priority === undefined) {
            finalPriority = existing ? (existing.priority || 0) : 0;
        } else {
            finalPriority = parseInt(priority) || 0;
        }

        // Handle monitor enabled - preserve existing value if undefined
        let monitorVal;
        console.log(`[Manager] updateRoom - isMonitorEnabled: ${isMonitorEnabled} (type: ${typeof isMonitorEnabled})`);

        if (isMonitorEnabled === undefined || isMonitorEnabled === null) {
            if (existing) {
                monitorVal = existing.is_monitor_enabled;
            } else {
                monitorVal = 1; // Default to enabled for new rooms only
            }
        } else if (isMonitorEnabled === false || isMonitorEnabled === 'false' || isMonitorEnabled === 0 || isMonitorEnabled === '0') {
            monitorVal = 0;
        } else {
            monitorVal = 1;
        }

        // Handle recording enabled
        let recordingVal;
        if (isRecordingEnabled === undefined || isRecordingEnabled === null) {
            recordingVal = existing ? existing.is_recording_enabled : 0; // Default disabled
        } else if (isRecordingEnabled === false || isRecordingEnabled === 'false' || isRecordingEnabled === 0 || isRecordingEnabled === '0') {
            recordingVal = 0;
        } else {
            recordingVal = 1;
        }

        // Handle recording account
        let recAccountVal = recordingAccountId;
        if (recAccountVal === undefined) {
            recAccountVal = existing ? existing.recording_account_id : null;
        }


        // console.log(`[Manager] updateRoom - monitorVal: ${monitorVal}, recVal: ${recordingVal}`);

        await run(`
            INSERT INTO room (room_id, name, address, language, updated_at, is_monitor_enabled, priority, is_recording_enabled, recording_account_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(room_id) DO UPDATE SET
                name = excluded.name,
                address = excluded.address,
                language = excluded.language,
                updated_at = excluded.updated_at,
                is_monitor_enabled = excluded.is_monitor_enabled,
                priority = excluded.priority,
                is_recording_enabled = excluded.is_recording_enabled,
                recording_account_id = excluded.recording_account_id
        `, [roomId, finalName, finalAddress, finalLanguage, now, monitorVal, finalPriority, recordingVal, recAccountVal]);

        return {
            room_id: roomId,
            name: finalName,
            address: finalAddress,
            language: finalLanguage,
            is_monitor_enabled: monitorVal,
            priority: finalPriority,
            is_recording_enabled: recordingVal,
            recording_account_id: recAccountVal
        };
    }


    async getRooms(options = {}) {
        await this.ensureDb();
        const { page = 1, limit = 50, search = '', roomFilter = null } = options;
        const offset = (page - 1) * limit;

        let whereClauses = [];
        let sql = 'SELECT room_id, numeric_room_id, name, address, updated_at, is_monitor_enabled, is_recording_enabled, recording_account_id FROM room';
        let countSql = 'SELECT COUNT(*) as total FROM room';
        const params = [];
        const countParams = [];

        if (search && search.trim()) {
            const trimmedSearch = search.trim();
            let usedExactMatch = false;
            if (isLikelyExactRoomIdSearch(trimmedSearch)) {
                const exactWhere = ['room_id = ?'];
                const exactParams = [trimmedSearch];
                if (roomFilter !== null) {
                    if (roomFilter.length === 0) {
                        return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };
                    }
                    const exactPlaceholders = roomFilter.map(() => '?').join(',');
                    exactWhere.push(`room_id IN (${exactPlaceholders})`);
                    exactParams.push(...roomFilter);
                }
                const exactMatch = await get(`SELECT room_id FROM room WHERE ${exactWhere.join(' AND ')} LIMIT 1`, exactParams);
                if (exactMatch) {
                    whereClauses.push('room_id = ?');
                    params.push(trimmedSearch);
                    countParams.push(trimmedSearch);
                    usedExactMatch = true;
                }
            }
            if (!usedExactMatch) {
                const likePattern = `%${trimmedSearch}%`;
                whereClauses.push('(room_id ILIKE ? OR name ILIKE ?)');
                params.push(likePattern, likePattern);
                countParams.push(likePattern, likePattern);
            }
        }
        if (roomFilter !== null) {
            if (roomFilter.length === 0) {
                return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };
            }
            const placeholders = roomFilter.map(() => '?').join(',');
            whereClauses.push(`room_id IN (${placeholders})`);
            params.push(...roomFilter);
            countParams.push(...roomFilter);
        }

        if (whereClauses.length > 0) {
            const where = ' WHERE ' + whereClauses.join(' AND ');
            sql += where;
            countSql += where;
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

    async getRoom(roomId) {
        await this.ensureDb();
        return await get('SELECT room_id, numeric_room_id, name, address, updated_at, is_monitor_enabled, is_recording_enabled, recording_account_id FROM room WHERE room_id = ?', [roomId]);
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
        const timeStr = now.toISOString().slice(11, 16).replace(':', '');

        // Use room_id + date + time as session_id to prevent collisions
        // Format: roomId_YYYYMMDD_HHMM (e.g., blooming1881_20251225_1430)
        const sessionId = `${roomId}_${dateStr}_${timeStr}`;

        await run('INSERT INTO session (session_id, room_id, snapshot_json) VALUES (?, ?, ?)',
            [sessionId, roomId, JSON.stringify(snapshotData)]);
        return sessionId;
    }

    async getSessions(roomId, sinceTime = null) {
        await this.ensureDb();
        if (roomId) {
            let timeFilter = '';
            const params = [roomId];
            if (sinceTime) {
                timeFilter = 'AND s.created_at >= ?';
                params.push(sinceTime);
            }
            return await query(`
                SELECT
                    s.session_id,
                    s.room_id,
                    s.created_at,
                    COALESCE(ss.end_time, et.end_time) as end_time
                FROM session s
                LEFT JOIN session_summary ss ON ss.session_id = s.session_id
                LEFT JOIN LATERAL (
                    SELECT MAX(timestamp) as end_time
                    FROM event
                    WHERE event.session_id = s.session_id
                ) et ON ss.session_id IS NULL
                WHERE s.room_id = ? ${timeFilter}
                ORDER BY s.created_at DESC
            `, params);
        }
        return await query(`
            SELECT
                s.session_id,
                s.room_id,
                s.created_at,
                COALESCE(ss.end_time, et.end_time) as end_time
            FROM session s
            LEFT JOIN session_summary ss ON ss.session_id = s.session_id
            LEFT JOIN LATERAL (
                SELECT MAX(timestamp) as end_time
                FROM event
                WHERE event.session_id = s.session_id
            ) et ON ss.session_id IS NULL
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

    // Event Logging - writes explicit analysis columns while retaining data_json for legacy compatibility
    async logEvent(roomId, eventType, data, sessionId = null) {
        await this.ensureDb();
        const now = getNowBeijing();
        const payload = data && typeof data === 'object' ? data : {};

        // Only sync user data for meaningful event types (chat, gift, like)
        // This prevents recording users who only triggered member/view events
        const userRecordableTypes = ['chat', 'gift', 'like'];
        if (payload.userId && userRecordableTypes.includes(eventType)) {
            await this.ensureUser({
                userId: payload.userId,
                uniqueId: payload.uniqueId,
                nickname: payload.nickname,
                avatar: payload.profilePictureUrl || '',
                region: payload.region || null
            });
        }

        await run(`INSERT INTO event (
        room_id, session_id, type, timestamp,
        user_id, unique_id, nickname,
        gift_id, gift_name, gift_image, group_id,
        diamond_count, repeat_count,
        like_count, total_like_count,
        comment, viewer_count, region,
        is_admin, is_super_admin, is_moderator,
        fan_level, fan_club_name,
        data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            roomId,
            sessionId,
            eventType,
            now,
            toOptionalText(payload.userId),
            toOptionalText(payload.uniqueId),
            toOptionalText(payload.nickname),
            payload.giftId == null || payload.giftId === '' ? null : toInteger(payload.giftId, null),
            toOptionalText(payload.giftName),
            toOptionalText(payload.giftImage),
            toOptionalText(payload.groupId),
            toInteger(payload.diamondCount, 0),
            toInteger(payload.repeatCount, 1),
            toInteger(payload.likeCount, 0),
            toInteger(payload.totalLikeCount, 0),
            toOptionalText(payload.comment),
            payload.viewerCount == null || payload.viewerCount === '' ? null : toInteger(payload.viewerCount, null),
            toOptionalText(payload.region),
            toBooleanInteger(payload.isAdmin),
            toBooleanInteger(payload.isSuperAdmin),
            toBooleanInteger(payload.isModerator),
            toInteger(payload.fanLevel, 0),
            toOptionalText(payload.fanClubName),
            safeJsonStringify(payload)
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
                await run(`INSERT INTO session (session_id, room_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)`, [
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
        const safeGapMinutes = Number.isFinite(Number(gapMinutes)) && Number(gapMinutes) > 0
            ? Number(gapMinutes)
            : 10;
        const gapMs = safeGapMinutes * 60 * 1000;

        console.log(`[Manager] Checking for sessions to merge (Gap < ${safeGapMinutes}m)...`);

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
        return { mergedCount, gapMinutes: safeGapMinutes };
    }

    // New optimized method for hourly job: Only check recent sessions
    // OPTIMIZED: Uses LEFT JOIN instead of N+1 subqueries
    async consolidateRecentSessions(hours = 48, gapMinutes = 60) {
        await this.ensureDb();
        const safeHours = Number.isFinite(Number(hours)) && Number(hours) > 0
            ? Number(hours)
            : 48;
        const safeGapMinutes = Number.isFinite(Number(gapMinutes)) && Number(gapMinutes) > 0
            ? Number(gapMinutes)
            : 60;
        const timeLimit = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
        const gapMs = safeGapMinutes * 60 * 1000;

        console.log(`[Manager] Consolidating sessions from last ${safeHours}h with gap < ${safeGapMinutes}m...`);

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
        return { mergedCount: totalMerged, lookbackHours: safeHours, gapMinutes: safeGapMinutes };
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
    async cleanupAllStaleEvents(options = {}) {
        await this.ensureDb();
        console.log('[Manager] Checking for orphaned live events...');

        const splitOlderThanMinutes = Number.isFinite(Number(options.splitOlderThanMinutes)) && Number(options.splitOlderThanMinutes) > 0
            ? Number(options.splitOlderThanMinutes)
            : 120;

        const rooms = await query('SELECT room_id FROM room WHERE is_monitor_enabled = 1');
        let totalArchived = 0;
        let scannedRooms = 0;

        for (const room of rooms) {
            scannedRooms++;
            const staleBefore = new Date(Date.now() - splitOlderThanMinutes * 60 * 1000).toISOString();

            // Just count them first to see if we need to act
            const staleCountRow = await get(`
                SELECT COUNT(*) as c FROM event
                WHERE room_id = ? AND session_id IS NULL AND timestamp < ?
            `, [room.room_id, staleBefore]);

            if (staleCountRow && staleCountRow.c > 0) {
                console.log(`[Manager] Found ${staleCountRow.c} orphaned events for ${room.room_id}. Archiving...`);
                const result = await this.archiveStaleLiveEvents(room.room_id, options);
                totalArchived += result.archived;
            }
        }

        if (totalArchived > 0) {
            console.log(`[Manager] Cleanup complete. Archived ${totalArchived} orphaned events.`);
        }

        return {
            archived: totalArchived,
            scannedRooms,
            splitOlderThanMinutes,
        };
    }

    async getSessionEvents(sessionId) {
        await this.ensureDb();
        const rows = await query(`
            SELECT
                type,
                timestamp,
                user_id,
                unique_id,
                nickname,
                gift_id,
                gift_name,
                gift_image,
                group_id,
                diamond_count,
                repeat_count,
                like_count,
                total_like_count,
                comment,
                viewer_count,
                region,
                is_admin,
                is_super_admin,
                is_moderator,
                fan_level,
                fan_club_name,
                data_json
            FROM event
            WHERE session_id = ?
            ORDER BY timestamp ASC
        `, [sessionId]);
        return rows.map(row => ({
            type: row.type,
            timestamp: row.timestamp,
            dataJson: row.dataJson || buildEventDataJsonFromRow(row),
        }));
    }

    // Time Statistics (30-min intervals) - supports full history or a specific session
    async getTimeStats(roomId, sessionId = null, sinceTime = null, options = {}) {
        await this.ensureDb();
        const includeBucketBounds = Boolean(options?.includeBucketBounds);

        if (roomId && !sessionId && sinceTime && isIncrementalStatsReadEnabled()) {
            const minuteParams = [roomId];
            let minuteWhereClause = 'WHERE room_id = ?';
            if (sinceTime) {
                minuteWhereClause += ' AND stat_minute >= ?';
                minuteParams.push(sinceTime);
            }

            const minuteStats = await query(`
                WITH bucketed AS (
                    SELECT
                        date_trunc('hour', stat_minute)
                            + floor(extract(minute from stat_minute) / 30) * interval '30 minute' as bucket_start,
                        SUM(COALESCE(chat_count, 0)) as comments,
                        SUM(COALESCE(gift_value, 0)) as income,
                        SUM(COALESCE(member_count, 0)) as member_entries,
                        0 as viewer_samples,
                        MAX(COALESCE(max_viewer_count, 0)) as max_online
                    FROM room_minute_stats
                    ${minuteWhereClause}
                    GROUP BY bucket_start
                )
                SELECT
                    bucket_start as bucket_start_at,
                    bucket_start + interval '30 minute' as bucket_end_at,
                    to_char(bucket_start, 'HH24:MI') || '-' ||
                    to_char(bucket_start + interval '30 minute', 'HH24:MI') as time_range,
                    comments,
                    income,
                    member_entries,
                    viewer_samples,
                    max_online
                FROM bucketed
                ORDER BY bucket_start ASC
            `, minuteParams);

            if (minuteStats.length > 0) {
                return minuteStats.map(s => ({
                    ...(includeBucketBounds ? {
                        bucket_start_at: s.bucketStartAt || s.bucket_start_at || null,
                        bucket_end_at: s.bucketEndAt || s.bucket_end_at || null
                    } : {}),
                    time_range: s.timeRange,
                    income: parseInt(s.income) || 0,
                    comments: parseInt(s.comments) || 0,
                    member_entries: parseInt(s.memberEntries) || 0,
                    viewer_samples: parseInt(s.viewerSamples) || 0,
                    max_online: parseInt(s.maxOnline) || 0
                }));
            }
        }

        let whereClause = `WHERE room_id = ? AND type IN ('gift', 'chat', 'roomUser', 'member')`;
        const params = [roomId];

        if (sessionId === 'live') {
            whereClause += ' AND session_id IS NULL';
        } else if (sessionId) {
            whereClause += ' AND session_id = ?';
            params.push(sessionId);
        }

        if (sinceTime) {
            whereClause += ' AND timestamp >= ?';
            params.push(sinceTime);
        }

        const stats = await query(`
            WITH bucketed AS (
                SELECT
                    timestamp,
                    type,
                    diamond_count,
                    repeat_count,
                    viewer_count,
                    date_trunc('hour', timestamp)
                        + floor(extract(minute from timestamp) / 30) * interval '30 minute' as bucket_start
                FROM event
                ${whereClause}
            )
            SELECT
                bucket_start as bucket_start_at,
                bucket_start + interval '30 minute' as bucket_end_at,
                to_char(bucket_start, 'HH24:MI') || '-' ||
                to_char(bucket_start + interval '30 minute', 'HH24:MI') as time_range,
                SUM(CASE WHEN type = 'chat' THEN 1 ELSE 0 END) as comments,
                SUM(CASE WHEN type = 'gift' THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END) as income,
                COUNT(*) FILTER (WHERE type = 'member') as member_entries,
                COUNT(*) FILTER (WHERE type = 'roomUser') as viewer_samples,
                GREATEST(
                    MAX(CASE
                        WHEN type = 'roomUser' THEN COALESCE(viewer_count, 0)
                        ELSE 0
                    END),
                    COUNT(*) FILTER (WHERE type = 'member')
                ) as max_online
            FROM bucketed
            GROUP BY bucket_start
            ORDER BY bucket_start ASC
        `, params);

        return stats.map(s => ({
            ...(includeBucketBounds ? {
                bucket_start_at: s.bucketStartAt || s.bucket_start_at || null,
                bucket_end_at: s.bucketEndAt || s.bucket_end_at || null
            } : {}),
            time_range: s.timeRange,
            income: parseInt(s.income) || 0,
            comments: parseInt(s.comments) || 0,
            member_entries: parseInt(s.memberEntries) || 0,
            viewer_samples: parseInt(s.viewerSamples) || 0,
            max_online: parseInt(s.maxOnline) || 0
        }));
    }

    async getSessionValueCustomers(roomId, sessionId = null, roomFilter = null) {
        await this.ensureDb();

        let whereClause = "WHERE room_id = ? AND type IN ('gift', 'chat', 'like', 'member')";
        const params = [roomId];

        if (sessionId === 'live' || !sessionId) {
            whereClause += ' AND session_id IS NULL';
        } else {
            whereClause += ' AND session_id = ?';
            params.push(sessionId);
        }

        const participantAggSql = `
            SELECT
                COALESCE(NULLIF(user_id, ''), NULLIF(unique_id, ''), nickname) as participant_key,
                MAX(user_id) as user_id,
                MAX(nickname) as nickname,
                MAX(unique_id) as unique_id,
                SUM(CASE WHEN type = 'gift' THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END) as session_gift_value,
                SUM(CASE WHEN type = 'gift' THEN COALESCE(repeat_count, 1) ELSE 0 END) as gift_count,
                COUNT(*) FILTER (WHERE type = 'chat') as chat_count,
                SUM(CASE WHEN type = 'like' THEN COALESCE(like_count, 0) ELSE 0 END) as like_count,
                COUNT(*) FILTER (WHERE type = 'member') as enter_count,
                MIN(timestamp) FILTER (WHERE type = 'member') as first_enter_at,
                MAX(timestamp) as last_active_at
            FROM event
            ${whereClause} AND COALESCE(NULLIF(user_id, ''), NULLIF(unique_id, ''), nickname) IS NOT NULL
            GROUP BY participant_key
        `;

        const participantSummary = await get(`
            SELECT
                COUNT(*) as participants,
                COUNT(*) FILTER (WHERE gift_count > 0) as paying_users,
                COUNT(*) FILTER (WHERE chat_count > 0) as chatting_users
            FROM (${participantAggSql}) participant_base
        `, params);

        const participants = await query(`
            SELECT *
            FROM (${participantAggSql}) participant_base
            ORDER BY session_gift_value DESC, chat_count DESC, like_count DESC
            LIMIT 48
        `, params);

        if (!participants.length) {
            return {
                core: [],
                potential: [],
                risk: [],
                meta: { participants: 0, payingUsers: 0, chattingUsers: 0 }
            };
        }

        const enriched = await Promise.all(participants.map(async (participant) => {
            const history = participant.userId ? await this.getUserAnalysis(participant.userId, roomFilter) : null;
            const sessionGiftValue = parseInt(participant.sessionGiftValue) || 0;
            const giftCount = parseInt(participant.giftCount) || 0;
            const chatCount = parseInt(participant.chatCount) || 0;
            const likeCount = parseInt(participant.likeCount) || 0;
            const enterCount = parseInt(participant.enterCount) || 0;
            const participantKey = participant.participantKey || participant.userId || participant.uniqueId || participant.nickname || '';
            const historicalValue = parseInt(history?.totalValue) || 0;
            const hasGiftAction = giftCount > 0;
            return {
                participantKey,
                userId: participant.userId,
                nickname: participant.nickname || participant.uniqueId || '匿名',
                uniqueId: participant.uniqueId || '',
                sessionGiftValue,
                hasGiftAction,
                giftCount,
                chatCount,
                likeCount,
                enterCount,
                firstEnterAt: participant.firstEnterAt || null,
                lastActiveAt: participant.lastActiveAt || null,
                historicalValue,
                activeDays: parseInt(history?.activeDays) || 0,
                dailyAvg: Math.round(Number(history?.dailyAvg) || 0),
                commonLanguage: history?.commonLanguage || '',
                masteredLanguages: history?.masteredLanguages || '',
                fanLevel: Number(history?.fanLevel || 0),
                fanClubName: history?.fanClubName || '',
                topGiftRoom: Array.isArray(history?.giftRooms) && history.giftRooms[0]
                    ? (history.giftRooms[0].name || history.giftRooms[0].roomId || '')
                    : '',
                weightedInteraction: chatCount * 4 + likeCount * 0.15 + enterCount * 2
            };
        }));

        const asCard = (item, reason, action) => ({
            participantKey: item.participantKey,
            userId: item.userId,
            nickname: item.nickname,
            uniqueId: item.uniqueId,
            sessionGiftValue: item.sessionGiftValue,
            giftCount: item.giftCount,
            historicalValue: item.historicalValue,
            chatCount: item.chatCount,
            likeCount: item.likeCount,
            enterCount: item.enterCount,
            firstEnterAt: item.firstEnterAt,
            lastActiveAt: item.lastActiveAt,
            fanLevel: item.fanLevel,
            commonLanguage: item.commonLanguage,
            topGiftRoom: item.topGiftRoom,
            reason,
            action
        });

        const core = enriched
            .filter(item => item.sessionGiftValue > 0)
            .sort((a, b) => (b.sessionGiftValue - a.sessionGiftValue) || (b.historicalValue - a.historicalValue))
            .slice(0, 5)
            .map(item => asCard(
                item,
                `本场贡献 💎${item.sessionGiftValue.toLocaleString()}，历史累计 💎${item.historicalValue.toLocaleString()}`,
                '适合重点点名维护，下一场优先给到情绪反馈和专属承接。'
            ));

        const used = new Set(core.map(item => item.participantKey));

        const potential = enriched
            .filter(item => !used.has(item.participantKey))
            .filter(item => item.weightedInteraction >= 12 && item.sessionGiftValue <= Math.max(0, Math.round(item.historicalValue * 0.03)))
            .sort((a, b) => (b.weightedInteraction - a.weightedInteraction) || (a.sessionGiftValue - b.sessionGiftValue))
            .slice(0, 5)
            .map(item => asCard(
                item,
                item.hasGiftAction
                    ? `互动信号强（${item.chatCount}条弹幕 / ${item.likeCount}点赞），已出手但仍有继续放大的空间。`
                    : `互动信号强（${item.chatCount}条弹幕 / ${item.likeCount}点赞），但本场转化仍偏低。`,
                item.hasGiftAction
                    ? '适合在高互动节点顺势抬档承接，优先放大参与感和连续支持。'
                    : '适合在高互动节点先加热关系，再试探第一次轻支持。'
            ));

        for (const item of potential) used.add(item.participantKey);

        let risk = enriched
            .filter(item => !used.has(item.participantKey))
            .filter(item => item.historicalValue >= 1000 && !item.hasGiftAction)
            .sort((a, b) => (b.historicalValue - a.historicalValue) || (b.enterCount - a.enterCount))
            .slice(0, 5)
            .map(item => asCard(
                item,
                `历史累计 💎${item.historicalValue.toLocaleString()}，但本场未形成有效出手。`,
                '建议下场重点召回，优先恢复存在感和关系温度。'
            ));

        if (!risk.length) {
            risk = enriched
                .filter(item => !used.has(item.participantKey))
                .filter(item => item.historicalValue >= 1000 && item.sessionGiftValue < Math.max(50, Math.round(item.historicalValue * 0.02)))
                .sort((a, b) => (b.historicalValue - a.historicalValue) || (a.sessionGiftValue - b.sessionGiftValue))
                .slice(0, 5)
                .map(item => asCard(
                    item,
                    `历史价值高，但本场贡献仅 💎${item.sessionGiftValue.toLocaleString()}，明显偏弱。`,
                    '建议尽快复盘该客户在本场的互动节点，避免持续降温。'
                ));
        }

        return {
            core,
            potential,
            risk,
            meta: {
                participants: parseInt(participantSummary?.participants) || 0,
                payingUsers: parseInt(participantSummary?.payingUsers) || 0,
                chattingUsers: parseInt(participantSummary?.chattingUsers) || 0
            }
        };
    }

    async getSessionRecap(roomId, sessionId = null, roomFilter = null) {
        await this.ensureDb();

        const detail = await this.getRoomDetailStats(roomId, sessionId);
        const rawTimeline = await this.getTimeStats(roomId, sessionId, null, { includeBucketBounds: true });
        const valueCustomers = await this.getSessionValueCustomers(roomId, sessionId, roomFilter);
        const sessionStartTime = detail?.summary?.startTime || null;
        const sessionEndTime = detail?.summary?.endTime || null;
        const sessionStartMs = sessionStartTime ? new Date(sessionStartTime).getTime() : NaN;

        const formatOffsetLabel = (pointMs) => {
            const diffMinutes = Math.max(0, Math.floor((pointMs - sessionStartMs) / 60000));
            const hours = Math.floor(diffMinutes / 60);
            const minutes = diffMinutes % 60;
            return `开播后${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        };

        const buildOffsetRangeLabel = (item = {}) => {
            const fallback = String(item?.time_range || '').trim();
            if (!Number.isFinite(sessionStartMs)) return fallback;

            const rawStartMs = item?.bucket_start_at ? new Date(item.bucket_start_at).getTime() : NaN;
            const rawEndMs = item?.bucket_end_at ? new Date(item.bucket_end_at).getTime() : NaN;
            if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs) || rawEndMs <= rawStartMs) return fallback;

            const sessionEndMs = sessionEndTime ? new Date(sessionEndTime).getTime() : NaN;
            const effectiveStartMs = Math.max(rawStartMs, sessionStartMs);
            const effectiveEndMs = Number.isFinite(sessionEndMs)
                ? Math.min(rawEndMs, sessionEndMs)
                : rawEndMs;

            if (!Number.isFinite(effectiveEndMs) || effectiveEndMs <= effectiveStartMs) return fallback;
            return `${formatOffsetLabel(effectiveStartMs)}-${formatOffsetLabel(effectiveEndMs)}`;
        };

        const timeline = Array.isArray(rawTimeline)
            ? rawTimeline.map(item => ({
                ...item,
                absolute_time_range: item?.time_range || '',
                time_range: buildOffsetRangeLabel(item)
            }))
            : [];

        let commentWhereClause = `WHERE room_id = ? AND type = 'chat' AND comment IS NOT NULL AND LENGTH(TRIM(comment)) > 0`;
        const commentParams = [roomId];
        if (sessionId === 'live' || !sessionId) {
            commentWhereClause += ' AND session_id IS NULL';
        } else {
            commentWhereClause += ' AND session_id = ?';
            commentParams.push(sessionId);
        }

        const topComments = await query(`
            SELECT
                TRIM(comment) as comment,
                COUNT(*) as count,
                MAX(timestamp) as lastSeenAt
            FROM event
            ${commentWhereClause}
            GROUP BY TRIM(comment)
            ORDER BY count DESC, lastSeenAt DESC
            LIMIT 80
        `, commentParams);

        const totalGiftValue = Number(detail?.summary?.totalGiftValue || 0);
        const totalComments = Number(detail?.summary?.totalComments || 0);
        const totalLikes = Number(detail?.summary?.totalLikes || 0);
        const totalVisits = Number(detail?.summary?.totalVisits || 0);
        const duration = Number(detail?.summary?.duration || 0);
        const participantCount = Number(valueCustomers?.meta?.participants || 0);
        const payingUsers = Number(valueCustomers?.meta?.payingUsers || 0);
        const topGiftValue = Number(detail?.leaderboards?.gifters?.[0]?.value || 0);
        const topGiftShare = totalGiftValue > 0 ? Number((topGiftValue / totalGiftValue).toFixed(4)) : 0;

        const activeBuckets = timeline.filter(item => (item.income || 0) > 0 || (item.comments || 0) > 0 || (item.max_online || 0) > 0);
        const hasViewerSnapshots = timeline.some(item => Number(item.viewer_samples || 0) > 0);
        const trafficMetricLabel = hasViewerSnapshots ? '在线波动' : '流量波动';
        const peakOnline = timeline.reduce((max, item) => Math.max(max, Number(item.max_online || 0)), 0);
        const avgOnline = activeBuckets.length
            ? Math.round(activeBuckets.reduce((sum, item) => sum + Number(item.max_online || 0), 0) / activeBuckets.length)
            : 0;
        let biggestDrop = null;
        if (hasViewerSnapshots) {
            for (let i = 1; i < timeline.length; i += 1) {
                const prev = timeline[i - 1];
                const curr = timeline[i];
                const drop = (prev.max_online || 0) - (curr.max_online || 0);
                if (drop > 0 && (!biggestDrop || drop > biggestDrop.dropValue)) {
                    biggestDrop = {
                        from: prev.time_range,
                        to: curr.time_range,
                        dropValue: drop,
                        fromValue: prev.max_online || 0,
                        toValue: curr.max_online || 0
                    };
                }
            }
        }

        const giftComponent = Math.min(25, Math.log10(totalGiftValue + 1) * 7);
        const interactionSignal = totalComments + totalLikes / 20 + totalVisits * 0.6;
        const interactionComponent = Math.min(20, Math.log10(interactionSignal + 1) * 7);
        const customerComponent = Math.min(12, valueCustomers.core.length * 3 + valueCustomers.potential.length * 2 + valueCustomers.risk.length);
        const rhythmComponent = Math.min(8, activeBuckets.length * 1.5);
        const score = totalGiftValue || totalComments || totalLikes || totalVisits
            ? Math.round(Math.min(98, 35 + giftComponent + interactionComponent + customerComponent + rhythmComponent))
            : 0;

        const grade = score >= 88 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score > 0 ? 'D' : '-';
        const gradeLabel = score >= 88 ? '强势场' : score >= 75 ? '稳态场' : score >= 60 ? '波动场' : score > 0 ? '待优化' : '暂无数据';

        const tags = [];
        if (topGiftShare >= 0.6 && totalGiftValue > 0) tags.push('大哥驱动');
        if (totalComments >= Math.max(20, totalVisits * 0.8)) tags.push('互动热');
        if (valueCustomers.potential.length >= 2) tags.push('高互动待转化');
        if (valueCustomers.core.length >= 2 && topGiftShare < 0.6) tags.push('客户结构健康');
        if (biggestDrop && biggestDrop.dropValue >= 15) tags.push('后段掉人');
        if (!tags.length && score > 0) tags.push('稳态经营');

        const topIncomeBucket = [...timeline].sort((a, b) => (b.income || 0) - (a.income || 0))[0] || null;
        const topCommentBucket = [...timeline].sort((a, b) => (b.comments || 0) - (a.comments || 0))[0] || null;
        const topOnlineBucket = [...timeline].sort((a, b) => (b.max_online || 0) - (a.max_online || 0))[0] || null;

        const keyMoments = [];
        if (topIncomeBucket && topIncomeBucket.income > 0) {
            keyMoments.push({
                type: 'gift_peak',
                title: '礼物高峰',
                timeRange: topIncomeBucket.time_range,
                metric: `💎 ${Number(topIncomeBucket.income || 0).toLocaleString()}`,
                description: `本场礼物峰值出现在 ${topIncomeBucket.time_range}，是最值得回看和复用的话术节点。`
            });
        }
        if (topCommentBucket && topCommentBucket.comments > 0) {
            keyMoments.push({
                type: 'comment_peak',
                title: '互动高峰',
                timeRange: topCommentBucket.time_range,
                metric: `💬 ${Number(topCommentBucket.comments || 0).toLocaleString()}`,
                description: `互动热度最高出现在 ${topCommentBucket.time_range}，说明该时段内容更容易把人留下来。`
            });
        }
        if (biggestDrop && biggestDrop.dropValue > 0) {
            keyMoments.push({
                type: 'audience_drop',
                title: trafficMetricLabel,
                timeRange: `${biggestDrop.from} → ${biggestDrop.to}`,
                metric: `-${biggestDrop.dropValue.toLocaleString()}`,
                description: `在线高点从 ${biggestDrop.fromValue.toLocaleString()} 降到 ${biggestDrop.toValue.toLocaleString()}，建议重点复盘该转折段。`
            });
        } else if (topOnlineBucket && topOnlineBucket.max_online > 0) {
            keyMoments.push({
                type: 'online_peak',
                title: hasViewerSnapshots ? '在线峰值' : '流量峰值',
                timeRange: topOnlineBucket.time_range,
                metric: `👥 ${Number(topOnlineBucket.max_online || 0).toLocaleString()}`,
                description: hasViewerSnapshots ? `在线峰值出现在 ${topOnlineBucket.time_range}，可作为下次起量阶段的节奏参考。` : `该时段流量触达最强，可作为下次起量节奏参考。`
            });
        }

        const highlights = [];
        if (totalGiftValue > 0) highlights.push(`本场累计礼物达到 💎${totalGiftValue.toLocaleString()}，具备清晰的变现结果。`);
        if (topIncomeBucket && topIncomeBucket.income > 0) highlights.push(`礼物高峰出现在 ${topIncomeBucket.time_range}，说明该时段内容更能打。`);
        if (valueCustomers.core.length > 0) highlights.push(`核心价值客户 ${valueCustomers.core[0].nickname} 本场贡献突出，适合重点维护。`);
        if (totalComments > Math.max(30, totalVisits)) highlights.push(`弹幕互动密度较高，说明内容具备留人能力。`);

        const issues = [];
        if (topGiftShare >= 0.6 && totalGiftValue > 0) issues.push(`本场收入对头部客户依赖较高，前排结构仍需扩宽。`);
        if (valueCustomers.potential.length >= 2) issues.push(`互动热度不低，但潜力客户尚未有效转化。`);
        if (biggestDrop && biggestDrop.dropValue >= 15) issues.push(`后段出现明显掉人，节奏衔接仍有优化空间。`);
        if (!totalGiftValue && (totalComments > 0 || totalLikes > 0)) issues.push(`本场有互动但变现偏弱，承接成交的动作不足。`);

        const actions = [];
        if (valueCustomers.core.length > 0) actions.push('下场开播前优先准备对核心价值客户的点名与情绪反馈。');
        if (valueCustomers.potential.length > 0) actions.push('在互动高点补一段轻成交话术，把热度尽快转成首单。');
        if (valueCustomers.risk.length > 0) actions.push('对流失风险客户做定向维护，避免高价值用户持续降温。');
        if (biggestDrop && biggestDrop.dropValue >= 15) actions.push(`重点回看 ${biggestDrop.from} 到 ${biggestDrop.to} 的内容切换，优化留存节点。`);

        const overview = {
            score,
            grade,
            gradeLabel,
            dominantTag: tags[0] || '稳态经营',
            tags: tags.slice(0, 3),
            totalGiftValue,
            totalComments,
            totalLikes,
            totalVisits,
            duration,
            startTime: detail?.summary?.startTime || null,
            participantCount,
            payingUsers,
            chattingUsers: Number(valueCustomers?.meta?.chattingUsers || 0),
            topGiftShare,
            sessionMode: sessionId === 'live' || !sessionId ? 'live' : 'archived',
            trafficMetricLabel
        };

        const radar = [
            { label: '变现', value: Math.max(5, Math.round(Math.min(100, giftComponent * 4))) },
            { label: '互动', value: Math.max(5, Math.round(Math.min(100, interactionComponent * 5))) },
            { label: '客户', value: Math.max(5, Math.round(Math.min(100, (customerComponent / 12) * 100))) },
            { label: '节奏', value: Math.max(5, Math.round(Math.min(100, activeBuckets.length ? (rhythmComponent / 8) * 100 : 0))) }
        ];

        return {
            overview,
            timeline,
            radar,
            keyMoments: keyMoments.slice(0, 3),
            traffic: {
                peakOnline,
                avgOnline,
                topRange: topOnlineBucket?.time_range || '',
                biggestDrop
            },
            insights: {
                highlights: highlights.slice(0, 3),
                issues: issues.slice(0, 3),
                actions: actions.slice(0, 3)
            },
            commentSignals: {
                topComments: Array.isArray(topComments) ? topComments.slice(0, 50).map(item => ({
                    text: item.comment,
                    count: parseInt(item.count) || 0,
                    lastSeenAt: item.lastSeenAt || null
                })) : []
            },
            giftSignals: {
                topGifters: Array.isArray(detail?.leaderboards?.gifters) ? detail.leaderboards.gifters.slice(0, 20).map(item => ({
                    nickname: item.nickname || '匿名',
                    userId: item.userId || '',
                    totalGiftValue: parseInt(item.value) || 0
                })) : [],
                topGiftDetails: Array.isArray(detail?.leaderboards?.giftDetails) ? detail.leaderboards.giftDetails.slice(0, 40).map(item => ({
                    nickname: item.nickname || '匿名',
                    uniqueId: item.uniqueId || '',
                    giftName: item.giftName || '',
                    giftCount: parseInt(item.count) || 0,
                    unitPrice: parseInt(item.unitPrice) || 0,
                    totalValue: parseInt(item.totalValue) || 0
                })) : []
            },
            valueCustomers
        };
    }

    // User Analysis
    async updateUserLanguages(userId, common, mastered) {
        await this.ensureDb();
        await run('UPDATE "user" SET common_language = ?, mastered_languages = ? WHERE user_id = ?',
            [common, mastered, userId]);
    }

    async updateAIAnalysis(userId, analysis, options = {}) {
        await this.ensureDb();
        const {
            resultJson = null,
            promptKey = null,
            promptUpdatedAt = null,
            contextVersion = null,
            modelVersion = null,
            currentRoomId = null
        } = options;

        await run(`
            INSERT INTO "user" (
                user_id,
                ai_analysis,
                ai_analysis_json,
                ai_analysis_prompt_key,
                ai_analysis_prompt_updated_at,
                ai_analysis_context_version,
                ai_analysis_model_version,
                ai_analysis_current_room_id,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            ON CONFLICT(user_id) DO UPDATE SET
                ai_analysis = EXCLUDED.ai_analysis,
                ai_analysis_json = EXCLUDED.ai_analysis_json,
                ai_analysis_prompt_key = EXCLUDED.ai_analysis_prompt_key,
                ai_analysis_prompt_updated_at = EXCLUDED.ai_analysis_prompt_updated_at,
                ai_analysis_context_version = EXCLUDED.ai_analysis_context_version,
                ai_analysis_model_version = EXCLUDED.ai_analysis_model_version,
                ai_analysis_current_room_id = EXCLUDED.ai_analysis_current_room_id,
                updated_at = NOW()
        `, [userId, analysis, resultJson, promptKey, promptUpdatedAt, contextVersion, modelVersion, currentRoomId]);
    }

    async getTopGifters(page = 1, pageSize = 50, filters = {}) {
        await this.ensureDb();

        const { lang: langFilter = '', languageFilter = '', minRooms = 1, activeHour = null, activeHourEnd = null, search = '', searchExact = false, giftPreference = '', roomFilter = null, dataStartTimes = null } = filters;
        const offset = (page - 1) * pageSize;

        // If roomFilter is empty array, user has no rooms
        if (roomFilter !== null && roomFilter !== undefined && roomFilter.length === 0) {
            return { users: [], totalCount: 0, page, pageSize };
        }

        // OPTIMIZED: Use pre-aggregated user_stats table instead of expensive event aggregation
        // Filters that require real-time event data (activeHour, dataStartTimes, roomFilter) fall back to slow path
        const needsRealTimeData = (activeHour !== null && activeHour !== '') || (dataStartTimes !== null && dataStartTimes !== undefined) || (roomFilter !== null);

        if (needsRealTimeData) {
            // Fall back to original slow query for time-based filters
            return await this._getTopGiftersRealtime(page, pageSize, filters);
        }

        // Fast path: Query from user_stats cache
        let conditions = ['us.total_gift_value > 0'];
        let params = [];

        // minRooms filter
        if (minRooms > 1) {
            conditions.push('us.room_count >= ?');
            params.push(parseInt(minRooms));
        }

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

        // Search filter for nickname or uniqueId
        if (search) {
            if (searchExact === true || searchExact === 'true') {
                conditions.push(`(LOWER(u.nickname) = LOWER(?) OR LOWER(u.unique_id) = LOWER(?))`);
                params.push(search, search);
            } else {
                conditions.push(`(u.nickname ILIKE ? OR u.unique_id ILIKE ?)`);
                params.push(`%${search}%`, `%${search}%`);
            }
        }

        // Gift preference filter: Rose > TikTok or TikTok > Rose
        if (giftPreference === 'true_love') {
            conditions.push('us.rose_value > us.tiktok_value');
        } else if (giftPreference === 'knife') {
            conditions.push('us.tiktok_value > us.rose_value');
        }

        // Room filter: only show users who have activity in specific rooms
        if (roomFilter && roomFilter.length > 0) {
            const rfPlaceholders = roomFilter.map(() => '?').join(',');
            conditions.push(`us.user_id IN (SELECT DISTINCT user_id FROM event WHERE room_id IN (${rfPlaceholders}))`);
            params.push(...roomFilter);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Build ORDER BY based on giftPreference
        let orderByClause = 'ORDER BY us.total_gift_value DESC';
        if (giftPreference === 'true_love') {
            orderByClause = 'ORDER BY (us.rose_value - us.tiktok_value) DESC';
        } else if (giftPreference === 'knife') {
            orderByClause = 'ORDER BY (us.tiktok_value - us.rose_value) DESC';
        }

        // Get total count
        const countSql = `
            SELECT COUNT(*) as total
            FROM user_stats us
            JOIN "user" u ON us.user_id = u.user_id
            ${whereClause}
        `;
        const countResult = await get(countSql, params);
        const totalCount = countResult ? parseInt(countResult.total) : 0;

        // Main query from cache
        const mainParams = [...params, pageSize, offset];
        const rows = await query(`
            SELECT
                u.user_id as userId,
                u.unique_id as uniqueId,
                u.nickname as nickname,
                u.common_language as commonLanguage,
                u.mastered_languages as masteredLanguages,
                u.region as region,
                us.total_gift_value as totalValue,
                us.room_count as roomCount,
                us.last_active as lastActive,
                us.rose_value as rose_value,
                us.tiktok_value as tiktok_value,
                us.chat_count as chatCount,
                us.top_room_id as topRoom,
                us.rose_count,
                us.tiktok_count
            FROM user_stats us
            JOIN "user" u ON us.user_id = u.user_id
            ${whereClause}
            ${orderByClause}
            LIMIT ? OFFSET ?
        `, mainParams);

        if (rows.length === 0) {
            return { users: [], totalCount, page, pageSize };
        }

        // Get room names for topRoom
        const roomIds = rows.filter(r => r.topRoom).map(r => r.topRoom);
        let roomNameMap = {};
        if (roomIds.length > 0) {
            const uniqueRoomIds = [...new Set(roomIds)];
            const placeholders = uniqueRoomIds.map(() => '?').join(',');
            const roomNames = await query(`SELECT room_id, name FROM room WHERE room_id IN (${placeholders})`, uniqueRoomIds);
            roomNameMap = Object.fromEntries(roomNames.map(r => [r.roomId, r.name || r.roomId]));
        }

        // Get top 6 gifts for displayed users (still needs event table, but only for current page)
        const userIds = rows.map(r => r.userId);
        const placeholders = userIds.map(() => '?').join(',');

        let topGiftRoomClause = '';
        const topGiftParams = [...userIds];
        if (roomFilter && roomFilter.length > 0) {
            const rfp = roomFilter.map(() => '?').join(',');
            topGiftRoomClause = `AND room_id IN (${rfp})`;
            topGiftParams.push(...roomFilter);
        }

        const topGiftStats = await query(`
            SELECT
                user_id,
                ${EVENT_GIFT_NAME_SQL} as gift_name,
                ${EVENT_GIFT_IMAGE_SQL} as gift_icon,
                MAX(COALESCE(diamond_count, 0)) as unit_price,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_value,
                SUM(COALESCE(repeat_count, 1)) as gift_count
            FROM event
            WHERE type = 'gift' AND user_id IN (${placeholders}) AND ${EVENT_GIFT_NAME_SQL} IS NOT NULL ${topGiftRoomClause}
            GROUP BY user_id, ${EVENT_GIFT_NAME_SQL}, ${EVENT_GIFT_IMAGE_SQL}
            ORDER BY user_id, total_value DESC
        `, topGiftParams);

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

        // Enrich rows
        for (const user of rows) {
            user.topRoomName = roomNameMap[user.topRoom] || user.topRoom;
            user.topGifts = topGiftsMap[user.userId] || [];
            user.roseStats = user.roseCount > 0 ? {
                totalValue: parseInt(user.roseValue) || 0,
                count: parseInt(user.roseCount) || 0
            } : null;
            user.tiktokStats = user.tiktokCount > 0 ? {
                totalValue: parseInt(user.tiktokValue) || 0,
                count: parseInt(user.tiktokCount) || 0
            } : null;
            user.isTopRoomModerator = false;
            user.isAdmin = 0;
            user.isSuperAdmin = 0;
            user.isModerator = 0;
            user.fanLevel = 0;
            user.fanClubName = null;

            // Clean up internal fields
            delete user.roseCount;
            delete user.tiktokCount;
        }

        return { users: rows, totalCount, page, pageSize };
    }

    // Original slow path for time-based filters (activeHour)
    async _getTopGiftersRealtime(page = 1, pageSize = 50, filters = {}) {
        const { lang: langFilter = '', languageFilter = '', minRooms = 1, activeHour = null, activeHourEnd = null, search = '', searchExact = false, giftPreference = '', roomFilter = null, dataStartTimes = null } = filters;
        const offset = (page - 1) * pageSize;

        let conditions = ["e.type = 'gift'"];
        let params = [];

        // Room filter
        if (roomFilter && roomFilter.length > 0) {
            const placeholders = roomFilter.map(() => '?').join(',');
            conditions.push(`e.room_id IN (${placeholders})`);
            params.push(...roomFilter);
        } else if (roomFilter !== null && roomFilter !== undefined && roomFilter.length === 0) {
            return { users: [], total: 0, page, pageSize };
        }

        // Data start time filter: use earliest first_added_at across user's rooms
        if (dataStartTimes && Object.keys(dataStartTimes).length > 0) {
            const earliest = Object.values(dataStartTimes).reduce((min, t) => {
                const d = new Date(t);
                return d < min ? d : min;
            }, new Date());
            conditions.push('e.timestamp >= ?');
            params.push(earliest.toISOString());
        }

        if (langFilter) {
            conditions.push(`(u.common_language = ? OR u.mastered_languages = ? OR u.mastered_languages LIKE ?)`);
            params.push(langFilter, langFilter, `%${langFilter}%`);
        }

        if (languageFilter) {
            conditions.push(`(u.common_language = ? OR u.mastered_languages = ? OR u.mastered_languages LIKE ?)`);
            params.push(languageFilter, languageFilter, `%${languageFilter}%`);
        }

        if (activeHour !== null && activeHour !== '') {
            if (activeHourEnd !== null && activeHourEnd !== '') {
                const startH = parseInt(activeHour);
                const endH = parseInt(activeHourEnd);
                if (startH <= endH) {
                    conditions.push(`EXTRACT(HOUR FROM e.timestamp) BETWEEN ? AND ?`);
                    params.push(startH, endH);
                } else {
                    conditions.push(`(EXTRACT(HOUR FROM e.timestamp) >= ? OR EXTRACT(HOUR FROM e.timestamp) <= ?)`);
                    params.push(startH, endH);
                }
            } else {
                conditions.push(`EXTRACT(HOUR FROM e.timestamp) = ?`);
                params.push(parseInt(activeHour));
            }
        }

        if (search) {
            if (searchExact === true || searchExact === 'true') {
                conditions.push(`(LOWER(u.nickname) = LOWER(?) OR LOWER(u.unique_id) = LOWER(?))`);
                params.push(search, search);
            } else {
                conditions.push(`(u.nickname ILIKE ? OR u.unique_id ILIKE ?)`);
                params.push(`%${search}%`, `%${search}%`);
            }
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        let havingConditions = [
            `SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) > 0`,
            `COUNT(DISTINCT e.room_id) >= ?`
        ];

        if (giftPreference === 'true_love') {
            havingConditions.push(`
                COALESCE(SUM(CASE WHEN ${EVENT_GIFT_TYPE_SQL} = 'rose'
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0) >
                COALESCE(SUM(CASE WHEN ${EVENT_GIFT_TYPE_SQL} = 'tiktok'
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0)
            `);
        } else if (giftPreference === 'knife') {
            havingConditions.push(`
                COALESCE(SUM(CASE WHEN ${EVENT_GIFT_TYPE_SQL} = 'tiktok'
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0) >
                COALESCE(SUM(CASE WHEN ${EVENT_GIFT_TYPE_SQL} = 'rose'
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0)
            `);
        }

        const havingClause = `HAVING ${havingConditions.join(' AND ')}`;

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

        let orderByClause = 'ORDER BY totalValue DESC';
        if (giftPreference === 'true_love') {
            orderByClause = 'ORDER BY (rose_value - tiktok_value) DESC';
        } else if (giftPreference === 'knife') {
            orderByClause = 'ORDER BY (tiktok_value - rose_value) DESC';
        }

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
                COALESCE(SUM(CASE WHEN ${EVENT_GIFT_TYPE_SQL} = 'rose'
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0) as rose_value,
                COALESCE(SUM(CASE WHEN ${EVENT_GIFT_TYPE_SQL} = 'tiktok'
                    THEN COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1) ELSE 0 END), 0) as tiktok_value
            FROM event e
            JOIN "user" u ON e.user_id = u.user_id
            ${whereClause}
            GROUP BY u.user_id, u.unique_id, u.nickname, u.common_language, u.mastered_languages, u.region
            ${havingClause}
            ${orderByClause}
            LIMIT ? OFFSET ?
        `, mainParams);

        if (rows.length === 0) {
            return { users: [], totalCount, page, pageSize };
        }

        const userIds = rows.map(r => r.userId);
        const placeholders = userIds.map(() => '?').join(',');

        // Build room filter clause for sub-queries
        let subRoomClause = '';
        const subRoomParams = [];
        if (roomFilter && roomFilter.length > 0) {
            const rfp = roomFilter.map(() => '?').join(',');
            subRoomClause = `AND room_id IN (${rfp})`;
            subRoomParams.push(...roomFilter);
        }

        const chatStats = await query(`
            SELECT user_id, COUNT(*) as chatCount
            FROM event
            WHERE type = 'chat' AND user_id IN (${placeholders}) ${subRoomClause}
            GROUP BY user_id
        `, [...userIds, ...subRoomParams]);
        const chatMap = Object.fromEntries(chatStats.map(r => [r.userId, r.chatCount]));

        const topRoomStats = await query(`
            SELECT e.user_id, e.room_id, r.name as room_name,
                   SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as roomValue
            FROM event e
            LEFT JOIN room r ON e.room_id = r.room_id
            WHERE e.type = 'gift' AND e.user_id IN (${placeholders}) ${subRoomClause ? subRoomClause.replace(/room_id/g, 'e.room_id') : ''}
            GROUP BY e.user_id, e.room_id, r.name
            ORDER BY e.user_id, roomValue DESC
        `, [...userIds, ...subRoomParams]);

        const topRoomMap = {};
        for (const stat of topRoomStats) {
            if (!topRoomMap[stat.userId]) {
                topRoomMap[stat.userId] = {
                    roomId: stat.roomId,
                    roomName: stat.roomName || stat.roomId
                };
            }
        }

        const topGiftStats = await query(`
            SELECT
                user_id,
                ${EVENT_GIFT_NAME_SQL} as gift_name,
                ${EVENT_GIFT_IMAGE_SQL} as gift_icon,
                MAX(COALESCE(diamond_count, 0)) as unit_price,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_value,
                SUM(COALESCE(repeat_count, 1)) as gift_count
            FROM event
            WHERE type = 'gift' AND user_id IN (${placeholders}) AND ${EVENT_GIFT_NAME_SQL} IS NOT NULL ${subRoomClause}
            GROUP BY user_id, ${EVENT_GIFT_NAME_SQL}, ${EVENT_GIFT_IMAGE_SQL}
            ORDER BY user_id, total_value DESC
        `, [...userIds, ...subRoomParams]);

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

        const roseTikTokStats = await query(`
            SELECT user_id,
                ${EVENT_GIFT_TYPE_SQL} as gift_type,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_value,
                SUM(COALESCE(repeat_count, 1)) as gift_count
            FROM event
            WHERE type = 'gift'
              AND user_id IN (${placeholders})
              AND ${EVENT_GIFT_TYPE_SQL} IN ('rose', 'tiktok')
            GROUP BY user_id, ${EVENT_GIFT_TYPE_SQL}
        `, userIds);

        const roseMap = {};
        const tiktokMap = {};
        for (const g of roseTikTokStats) {
            const stats = {
                totalValue: parseInt(g.totalValue) || 0,
                count: parseInt(g.giftCount) || 0
            };
            if (g.giftType === 'rose') {
                roseMap[g.userId] = stats;
            } else if (g.giftType === 'tiktok') {
                tiktokMap[g.userId] = stats;
            }
        }

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

    async getUserChatHistory(userId, limit = 50, roomFilter = null) {
        await this.ensureDb();

        if (roomFilter !== null && roomFilter.length === 0) {
            return [];
        }

        let roomFilterClause = '';
        const params = [userId];
        if (roomFilter && roomFilter.length > 0) {
            const placeholders = roomFilter.map(() => '?').join(',');
            roomFilterClause = ` AND room_id IN (${placeholders})`;
            params.push(...roomFilter);
        }

        params.push(limit);

        return await query(`
            SELECT comment, timestamp
            FROM event
            WHERE type = 'chat' AND user_id = ?${roomFilterClause}
            ORDER BY timestamp DESC
            LIMIT ?
        `, params);
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
        // Invalidate cache when settings change
        this.settingsCache = null;
    }

    async getAllSettings() {
        // Return cached settings if still valid (60s TTL)
        const CACHE_TTL = 60 * 1000;
        if (this.settingsCache && (Date.now() - this.settingsCacheTime) < CACHE_TTL) {
            return this.settingsCache;
        }

        await this.ensureDb();
        const rows = await query('SELECT key, value FROM settings');
        const settings = {};
        for (const r of rows) settings[r.key] = r.value;

        // Update cache
        this.settingsCache = settings;
        this.settingsCacheTime = Date.now();
        return settings;
    }

    // Room Management
    async deleteRoom(roomId) {
        await this.ensureDb();
        await run('DELETE FROM event WHERE room_id = ?', [roomId]);
        await run('DELETE FROM session WHERE room_id = ?', [roomId]);
        await run('DELETE FROM room WHERE room_id = ?', [roomId]);
    }

    /**
     * Clean up expired room data (7-day retention policy)
     * Removes events, sessions, stats for rooms that:
     * - Have is_monitor_enabled = 0 (disabled)
     * - Have no user_room associations (no user watching)
     * - Were disabled (updated_at) more than 7 days ago
     */
    async cleanupExpiredRoomData() {
        await this.ensureDb();
        const RETENTION_DAYS = 7;

        try {
            // Find rooms eligible for cleanup
            const expiredRooms = await query(`
                SELECT r.room_id, r.name, r.updated_at
                FROM room r
                WHERE r.is_monitor_enabled = 0
                  AND r.updated_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
                  AND NOT EXISTS (
                      SELECT 1 FROM user_room ur WHERE ur.room_id = r.room_id
                  )
            `);

            if (expiredRooms.length === 0) {
                console.log('[Cleanup] No expired rooms to clean up.');
                return { cleaned: 0 };
            }

            console.log(`[Cleanup] Found ${expiredRooms.length} expired rooms to clean up.`);

            let totalEvents = 0;
            let totalSessions = 0;
            for (const room of expiredRooms) {
                const roomId = room.roomId;
                console.log(`[Cleanup] Cleaning room ${roomId} (${room.name || 'unnamed'}) - disabled since ${room.updatedAt}`);

                // Delete events
                const eventResult = await query('SELECT COUNT(*) AS count FROM event WHERE room_id = ?', [roomId]);
                const eventCount = Number(eventResult[0]?.count || 0);
                await run('DELETE FROM event WHERE room_id = ?', [roomId]);
                totalEvents += eventCount;

                // Delete sessions
                const sessionResult = await query('SELECT COUNT(*) AS count FROM session WHERE room_id = ?', [roomId]);
                const sessionCount = Number(sessionResult[0]?.count || 0);
                await run('DELETE FROM session WHERE room_id = ?', [roomId]);
                totalSessions += sessionCount;

                // Delete cached room stats
                await run('DELETE FROM room_stats WHERE room_id = ?', [roomId]);

                // Delete recording tasks
                await run('DELETE FROM recording_task WHERE room_id = ?', [roomId]);

                // Delete the room itself
                await run('DELETE FROM room WHERE room_id = ?', [roomId]);

                console.log(`[Cleanup] Room ${roomId}: deleted ${eventCount} events, ${sessionCount} sessions.`);
            }

            console.log(`[Cleanup] Complete: cleaned ${expiredRooms.length} rooms, ${totalEvents} events, ${totalSessions} sessions.`);
            return { cleaned: expiredRooms.length, events: totalEvents, sessions: totalSessions };
        } catch (err) {
            console.error('[Cleanup] Error during expired room cleanup:', err.message);
            return { cleaned: 0, error: err.message };
        }
    }

    // Room Entry Analysis
    async getRoomEntryStats(startDate, endDate, limit = 100, roomFilter = null, dataStartTimes = null) {
        await this.ensureDb();

        if (roomFilter !== null && roomFilter.length === 0) {
            return [];
        }

        let start = startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
        const end = endDate ? new Date(endDate) : new Date();

        if (endDate && endDate.length <= 10) {
            end.setHours(23, 59, 59, 999);
        }

        // Apply data start time constraint for members
        if (dataStartTimes && Object.keys(dataStartTimes).length > 0) {
            const earliest = Object.values(dataStartTimes).reduce((min, t) => {
                const d = new Date(t);
                return d < min ? d : min;
            }, new Date());
            if (earliest > start) start = earliest;
        }

        const normalizedLimit = parseInt(limit) || 100;
        let roomFilterClause = '';
        const params = [start.toISOString(), end.toISOString()];
        if (roomFilter && roomFilter.length > 0) {
            const placeholders = roomFilter.map(() => '?').join(',');
            roomFilterClause = `AND rms.room_id IN (${placeholders})`;
            params.push(...roomFilter);
        }
        params.push(normalizedLimit);

        if (isIncrementalStatsReadEnabled()) {
            const minuteStats = await query(`
                SELECT
                    rms.room_id,
                    MAX(r.name) as room_name,
                    SUM(COALESCE(rms.member_count, 0)) as count,
                    MAX(rs.valid_daily_avg) as daily_avg
                FROM room_minute_stats rms
                LEFT JOIN room r ON rms.room_id = r.room_id
                LEFT JOIN room_stats rs ON rms.room_id = rs.room_id
                WHERE rms.stat_minute >= ?
                  AND rms.stat_minute <= ?
                  ${roomFilterClause}
                GROUP BY rms.room_id
                ORDER BY count DESC
                LIMIT ?
            `, params);

            if (minuteStats.length > 0) {
                return minuteStats.map(s => ({
                    roomId: s.roomId,
                    roomName: s.roomName || s.roomId,
                    count: parseInt(s.count) || 0,
                    dailyAvg: parseInt(s.dailyAvg) || 0
                }));
            }
        }

        let eventRoomFilterClause = '';
        const eventParams = [start.toISOString(), end.toISOString()];
        if (roomFilter && roomFilter.length > 0) {
            const placeholders = roomFilter.map(() => '?').join(',');
            eventRoomFilterClause = `AND e.room_id IN (${placeholders})`;
            eventParams.push(...roomFilter);
        }
        eventParams.push(normalizedLimit);

        const stats = await query(`
            SELECT
                e.room_id,
                MAX(r.name) as room_name,
                COUNT(*) as count,
                MAX(rs.valid_daily_avg) as daily_avg
            FROM event e
            LEFT JOIN room r ON e.room_id = r.room_id
            LEFT JOIN room_stats rs ON e.room_id = rs.room_id
            WHERE e.type = 'member'
            AND e.timestamp >= ?
            AND e.timestamp <= ?
            ${eventRoomFilterClause}
            GROUP BY e.room_id
            ORDER BY count DESC
            LIMIT ?
        `, eventParams);

        return stats.map(s => ({
            roomId: s.roomId,
            roomName: s.roomName || s.roomId,
            count: parseInt(s.count) || 0,
            dailyAvg: parseInt(s.dailyAvg) || 0
        }));
    }

    async getGlobalStats(roomFilter = null, dataStartTimes = null) {
        await this.ensureDb();

        // Use cache only when no room filter (admin/global view)
        if (!roomFilter) {
            // OPTIMIZED: Read from pre-aggregated global_stats cache table
            const cached = await get(`SELECT hour_stats_json, day_stats_json, updated_at FROM global_stats WHERE id = 1`);

            if (cached && cached.hourStatsJson && cached.dayStatsJson) {
                try {
                    const hourStats = JSON.parse(cached.hourStatsJson);
                    const dayStats = JSON.parse(cached.dayStatsJson);
                    return { hourStats, dayStats, cachedAt: cached.updatedAt };
                } catch (e) {
                    console.error('[Manager] Error parsing global_stats cache:', e);
                }
            }
        }

        // Real-time computation (for filtered view or cache miss)
        console.log('[Manager] Computing stats in real-time...');

        // Use the earliest data start time across user's rooms, or default to 30 days ago
        let sinceDate;
        if (dataStartTimes && Object.keys(dataStartTimes).length > 0) {
            const earliest = Object.values(dataStartTimes).reduce((min, t) => {
                const d = new Date(t);
                return d < min ? d : min;
            }, new Date());
            sinceDate = earliest.toISOString().replace('T', ' ').slice(0, 19);
        } else {
            sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                .toISOString().replace('T', ' ').slice(0, 19);
        }

        const chineseFilter = `(u.common_language = '中文' OR u.mastered_languages = '中文')`;

        let roomFilterClause = '';
        const extraParams = [];
        if (roomFilter && roomFilter.length > 0) {
            const placeholders = roomFilter.map(() => '?').join(',');
            roomFilterClause = `AND e.room_id IN (${placeholders})`;
            extraParams.push(...roomFilter);
        } else if (roomFilter !== null && roomFilter.length === 0) {
            return { hourStats: {}, dayStats: {} };
        }

        const hourChatRows = await query(`
            SELECT to_char(e.timestamp, 'HH24') as hour, COUNT(*) as cnt
            FROM event e
            LEFT JOIN "user" u ON e.user_id = u.user_id
            WHERE e.type = 'chat' AND e.timestamp >= ? AND ${chineseFilter} ${roomFilterClause}
            GROUP BY hour
        `, [sinceDate, ...extraParams]);

        const hourGiftRows = await query(`
            SELECT to_char(e.timestamp, 'HH24') as hour,
                   SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as val
            FROM event e
            LEFT JOIN "user" u ON e.user_id = u.user_id
            WHERE e.type = 'gift' AND e.timestamp >= ? AND ${chineseFilter} ${roomFilterClause}
            GROUP BY hour
        `, [sinceDate, ...extraParams]);

        const hourStats = {};
        for (let i = 0; i < 24; i++) hourStats[String(i).padStart(2, '0')] = { gift: 0, chat: 0 };
        for (const r of hourChatRows) {
            if (hourStats[r.hour]) hourStats[r.hour].chat = parseInt(r.cnt) || 0;
        }
        for (const r of hourGiftRows) {
            if (hourStats[r.hour]) hourStats[r.hour].gift = parseInt(r.val) || 0;
        }

        const dayChatRows = await query(`
            SELECT EXTRACT(DOW FROM e.timestamp)::int as day, COUNT(*) as cnt
            FROM event e
            LEFT JOIN "user" u ON e.user_id = u.user_id
            WHERE e.type = 'chat' AND e.timestamp >= ? AND ${chineseFilter} ${roomFilterClause}
            GROUP BY day
        `, [sinceDate, ...extraParams]);

        const dayGiftRows = await query(`
            SELECT EXTRACT(DOW FROM e.timestamp)::int as day,
                   SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as val
            FROM event e
            LEFT JOIN "user" u ON e.user_id = u.user_id
            WHERE e.type = 'gift' AND e.timestamp >= ? AND ${chineseFilter} ${roomFilterClause}
            GROUP BY day
        `, [sinceDate, ...extraParams]);

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
        const { page = 1, limit = 50, search = '', sort = 'updated_at', roomFilter = null } = options;
        const offset = (page - 1) * limit;

        // Define which sorts use cached room_stats (can be done in SQL)
        const cachedMetricSorts = [
            'gift_eff_desc', 'gift_eff_asc',
            'interact_eff_desc', 'interact_eff_asc',
            'account_quality_desc', 'account_quality_asc',
            'top10_ratio_desc', 'top10_ratio_asc',
            'top30_ratio_desc', 'top30_ratio_asc',
            'top1_ratio_desc', 'top1_ratio_asc',
            'top3_ratio_desc', 'top3_ratio_asc',
            'daily_avg_desc', 'daily_avg_asc',
            'total_gift_desc', 'total_gift_asc'
        ];
        const isCachedSort = cachedMetricSorts.includes(sort);

        // Build WHERE clause for search and room filter
        let whereClauses = [];
        const searchParams = [];
        if (search && search.trim()) {
            const trimmedSearch = search.trim();
            let usedExactMatch = false;
            if (isLikelyExactRoomIdSearch(trimmedSearch)) {
                const exactWhere = ['r.room_id = ?'];
                const exactParams = [trimmedSearch];
                if (roomFilter !== null) {
                    if (roomFilter.length === 0) {
                        return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };
                    }
                    const exactPlaceholders = roomFilter.map(() => '?').join(',');
                    exactWhere.push(`r.room_id IN (${exactPlaceholders})`);
                    exactParams.push(...roomFilter);
                }
                const exactMatch = await get(`SELECT r.room_id FROM room r WHERE ${exactWhere.join(' AND ')} LIMIT 1`, exactParams);
                if (exactMatch) {
                    whereClauses.push('r.room_id = ?');
                    searchParams.push(trimmedSearch);
                    usedExactMatch = true;
                }
            }
            if (!usedExactMatch) {
                const likePattern = `%${trimmedSearch}%`;
                whereClauses.push('(r.room_id ILIKE ? OR r.name ILIKE ?)');
                searchParams.push(likePattern, likePattern);
            }
        }
        if (roomFilter !== null) {
            if (roomFilter.length === 0) {
                // User has no rooms - return empty
                return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };
            }
            const placeholders = roomFilter.map(() => '?').join(',');
            whereClauses.push(`r.room_id IN (${placeholders})`);
            searchParams.push(...roomFilter);
        }
        const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

        // Get total count
        const countSql = `SELECT COUNT(*) as total FROM room r ${whereClause}`;
        const countResult = await get(countSql, searchParams);
        const total = countResult?.total || 0;

        if (total === 0) {
            return {
                data: [],
                pagination: { page, limit, total, totalPages: 0 }
            };
        }

        // Build ORDER BY clause based on sort type
        let orderByClause = '';
        let useRoomStatsJoin = isCachedSort;

        if (isCachedSort) {
            // Use cached room_stats table for sorting - FAST PATH
            switch (sort) {
                case 'gift_eff_desc':
                    orderByClause = 'COALESCE(rs.gift_efficiency, 0) DESC';
                    break;
                case 'gift_eff_asc':
                    orderByClause = 'COALESCE(rs.gift_efficiency, 0) ASC';
                    break;
                case 'interact_eff_desc':
                    orderByClause = 'COALESCE(rs.interact_efficiency, 0) DESC';
                    break;
                case 'interact_eff_asc':
                    orderByClause = 'COALESCE(rs.interact_efficiency, 0) ASC';
                    break;
                case 'account_quality_desc':
                    orderByClause = 'COALESCE(rs.account_quality, 0) DESC';
                    break;
                case 'account_quality_asc':
                    orderByClause = 'COALESCE(rs.account_quality, 0) ASC';
                    break;
                case 'top10_ratio_desc':
                    // Lower is better (more diversified) - sort ASC for "best" first
                    orderByClause = 'COALESCE(rs.top10_ratio, 100) ASC';
                    break;
                case 'top10_ratio_asc':
                    orderByClause = 'COALESCE(rs.top10_ratio, 0) DESC';
                    break;
                case 'top30_ratio_desc':
                    orderByClause = 'COALESCE(rs.top30_ratio, 100) ASC';
                    break;
                case 'top30_ratio_asc':
                    orderByClause = 'COALESCE(rs.top30_ratio, 0) DESC';
                    break;
                case 'top1_ratio_desc':
                    orderByClause = 'COALESCE(rs.top1_ratio, 100) ASC';
                    break;
                case 'top1_ratio_asc':
                    orderByClause = 'COALESCE(rs.top1_ratio, 0) DESC';
                    break;
                case 'top3_ratio_desc':
                    orderByClause = 'COALESCE(rs.top3_ratio, 100) ASC';
                    break;
                case 'top3_ratio_asc':
                    orderByClause = 'COALESCE(rs.top3_ratio, 0) DESC';
                    break;
                case 'daily_avg_desc':
                    orderByClause = 'COALESCE(rs.valid_daily_avg, 0) DESC';
                    break;
                case 'daily_avg_asc':
                    orderByClause = 'COALESCE(rs.valid_daily_avg, 0) ASC';
                    break;
                case 'total_gift_desc':
                    orderByClause = 'COALESCE(rs.all_time_gift_value, 0) DESC';
                    break;
                case 'total_gift_asc':
                    orderByClause = 'COALESCE(rs.all_time_gift_value, 0) ASC';
                    break;
            }
        } else if (sort === 'priority_desc') {
            orderByClause = 'COALESCE(r.priority, 0) DESC, r.updated_at DESC';
        } else if (sort === 'priority_asc') {
            orderByClause = 'COALESCE(r.priority, 0) ASC, r.updated_at DESC';
        } else {
            // Default sort: live rooms first, then by updated_at
            if (liveRoomIds.length > 0) {
                const livePlaceholders = liveRoomIds.map(() => '?').join(',');
                orderByClause = `
                    CASE WHEN r.room_id IN (${livePlaceholders}) THEN 0 ELSE 2 END +
                    CASE WHEN r.is_monitor_enabled = 0 THEN 1 ELSE 0 END,
                    r.updated_at DESC`;
            } else {
                orderByClause = 'CASE WHEN r.is_monitor_enabled = 0 THEN 1 ELSE 0 END, r.updated_at DESC';
            }
        }

        // Build main query with optional room_stats JOIN
        let mainSql;
        const mainParams = [...searchParams];

        if (useRoomStatsJoin) {
            mainSql = `
                SELECT r.*,
                       rs.all_time_gift_value, rs.all_time_visit_count, rs.all_time_chat_count,
                       rs.valid_daily_avg, rs.valid_days,
                       rs.top1_ratio, rs.top3_ratio, rs.top10_ratio, rs.top30_ratio,
                       rs.gift_efficiency, rs.interact_efficiency, rs.account_quality,
                       rs.monthly_gift_value, rs.last_session_time
                FROM room r
                LEFT JOIN room_stats rs ON r.room_id = rs.room_id
                ${whereClause}
                ORDER BY ${orderByClause}
                LIMIT ? OFFSET ?
            `;
            mainParams.push(limit, offset);
        } else {
            // For default/priority sorts, add liveRoomIds to params if needed
            if (sort !== 'priority_desc' && sort !== 'priority_asc' && liveRoomIds.length > 0) {
                mainParams.push(...liveRoomIds);
            }
            mainSql = `
                SELECT r.*
                FROM room r
                ${whereClause}
                ORDER BY ${orderByClause}
                LIMIT ? OFFSET ?
            `;
            mainParams.push(limit, offset);
        }

        const rooms = await query(mainSql, mainParams);

        if (rooms.length === 0) {
            return {
                data: [],
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
            };
        }

        // Get room IDs for batch queries
        const roomIds = rooms.map(r => r.roomId);
        const placeholders = roomIds.map(() => '?').join(',');

        // Fetch current session stats only for live rooms on the current page
        // PERF: room list主要展示当前直播表现，离线房间直接返回 0，可避免对大 event 表做无意义聚合
        const liveRoomIdSet = new Set(liveRoomIds);
        const currentStatRoomIds = roomIds.filter(roomId => liveRoomIdSet.has(roomId));
        let currentStatsMap = {};
        if (currentStatRoomIds.length > 0) {
            const currentStatsPlaceholders = currentStatRoomIds.map(() => '?').join(',');
            const currentStats = await query(`
                SELECT
                    room_id,
                    COUNT(*) FILTER (WHERE type = 'member') as curr_visits,
                    COUNT(*) FILTER (WHERE type = 'chat') as curr_comments,
                    COALESCE(SUM(CASE WHEN type = 'gift'
                        THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END), 0) as curr_gift,
                    MAX(CASE WHEN type = 'like'
                        THEN COALESCE(total_like_count, 0) ELSE 0 END) as curr_likes,
                    EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) as duration_secs,
                    MIN(timestamp) as start_time
                FROM event
                WHERE room_id IN (${currentStatsPlaceholders}) AND session_id IS NULL
                GROUP BY room_id
            `, currentStatRoomIds);
            currentStatsMap = Object.fromEntries(currentStats.map(r => [r.roomId, r]));
        }

        // If we didn't use room_stats JOIN, fetch cached stats now
        let cachedStatsMap = {};
        if (!useRoomStatsJoin) {
            const cachedStats = await query(`
                SELECT * FROM room_stats WHERE room_id IN (${placeholders})
            `, roomIds);
            cachedStatsMap = Object.fromEntries(cachedStats.map(r => [r.roomId, r]));
        }

        // NOTE: monthlyGifts and lastSessionTimes are now cached in room_stats table
        // No need for these expensive real-time queries anymore!

        // Build final stats objects
        const stats = rooms.map(r => {
            const curr = currentStatsMap[r.roomId] || {};
            const cached = useRoomStatsJoin ? r : (cachedStatsMap[r.roomId] || {});

            const currVisits = parseInt(curr.currVisits) || 0;
            const currComments = parseInt(curr.currComments) || 0;
            const currGift = parseInt(curr.currGift) || 0;
            const currLikes = parseInt(curr.currLikes) || 0;
            const durationSecs = parseFloat(curr.durationSecs) || 0;

            // Use cached all-time stats
            const allTimeGift = parseInt(cached.allTimeGiftValue) || 0;
            const giftEfficiency = parseFloat(cached.giftEfficiency) || 0;
            const interactEfficiency = parseFloat(cached.interactEfficiency) || 0;
            const accountQuality = parseFloat(cached.accountQuality) || 0;
            const top1Ratio = parseInt(cached.top1Ratio) || 0;
            const top3Ratio = parseInt(cached.top3Ratio) || 0;
            const top10Ratio = parseInt(cached.top10Ratio) || 0;
            const top30Ratio = parseInt(cached.top30Ratio) || 0;
            const validDailyAvg = parseInt(cached.validDailyAvg) || 0;
            const validDays = parseInt(cached.validDays) || 0;
            // Use cached monthly gift and last session time (no more slow queries!)
            const monthlyGift = parseInt(cached.monthlyGiftValue) || 0;
            const lastSession = cached.lastSessionTime || null;

            return {
                roomId: r.roomId,
                name: r.name,
                address: r.address,
                isMonitorEnabled: r.isMonitorEnabled,
                isRecordingEnabled: r.isRecordingEnabled,
                recordingAccountId: r.recordingAccountId,
                language: r.language,
                priority: r.priority,

                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
                isLive: liveRoomIds.includes(r.roomId),
                totalVisits: currVisits,
                totalComments: currComments,
                totalGiftValue: currGift,
                allTimeGiftValue: allTimeGift,
                monthlyGiftValue: monthlyGift,
                totalLikes: currLikes,
                lastSessionTime: lastSession,
                broadcastDuration: Math.round(durationSecs),
                startTime: curr.startTime || null,
                giftEfficiency: giftEfficiency,
                interactEfficiency: interactEfficiency,
                accountQuality: accountQuality,
                top1Ratio: top1Ratio,
                top3Ratio: top3Ratio,
                top10Ratio: top10Ratio,
                top30Ratio: top30Ratio,
                validDailyAvg: validDailyAvg,
                validDays: validDays
            };
        });

        // For default sort only: ensure live rooms come first within the page
        if (sort === 'default' || sort === 'updated_at') {
            stats.sort((a, b) => {
                if (a.isLive && !b.isLive) return -1;
                if (!a.isLive && b.isLive) return 1;
                return 0;
            });
        }

        return {
            data: stats,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }


    async getUserAnalysis(userId, roomFilter = null) {
        await this.ensureDb();

        // Build room filter clause for SQL queries
        let roomFilterClause = '';
        const roomFilterParams = [];
        if (roomFilter !== null && roomFilter.length === 0) {
            // User has no rooms - return empty analysis
            return {
                totalValue: 0, activeDays: 0, dailyAvg: 0,
                giftRooms: [], visitRooms: [], hourStats: [], dayStats: [],
                isAdmin: 0, isSuperAdmin: 0, isModerator: 0, fanLevel: 0,
                fanClubName: '', commonLanguage: '', masteredLanguages: '',
                region: '', aiAnalysis: null, moderatorRooms: []
            };
        }
        if (roomFilter && roomFilter.length > 0) {
            const placeholders = roomFilter.map(() => '?').join(',');
            roomFilterClause = `AND room_id IN (${placeholders})`;
            roomFilterParams.push(...roomFilter);
        }

        // 1. Basic Stats - use direct columns instead of JSON extraction to avoid Unicode errors
        const giftStats = await get(`
            SELECT
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as totalValue,
                MIN(timestamp) as firstSeen,
                MAX(timestamp) as lastSeen,
                COUNT(DISTINCT timestamp::date) as activeDays
            FROM event
            WHERE type = 'gift' AND user_id = ? ${roomFilterClause}
        `, [userId, ...roomFilterParams]);

        // 2. Top Rooms (Gift) - use direct columns
        const giftRooms = await query(`
            SELECT e.room_id, MAX(r.name) as name,
                   SUM(COALESCE(e.diamond_count, 0) * COALESCE(e.repeat_count, 1)) as val
            FROM event e
            LEFT JOIN room r ON e.room_id = r.room_id
            WHERE e.type = 'gift' AND e.user_id = ? ${roomFilterClause ? roomFilterClause.replace(/room_id/g, 'e.room_id') : ''}
            GROUP BY e.room_id
            ORDER BY val DESC
            LIMIT 10
        `, [userId, ...roomFilterParams]);

        // 3. Top Rooms (Visit - from member events)
        const visitRooms = await query(`
             SELECT e.room_id, MAX(r.name) as name, COUNT(*) as cnt
             FROM event e
             LEFT JOIN room r ON e.room_id = r.room_id
             WHERE e.type = 'member' AND e.user_id = ? ${roomFilterClause ? roomFilterClause.replace(/room_id/g, 'e.room_id') : ''}
             GROUP BY e.room_id
             ORDER BY cnt DESC
             LIMIT 10
        `, [userId, ...roomFilterParams]);

        // 4. Time Distribution (Hour of Day)
        const hourStats = await query(`
            SELECT to_char(timestamp, 'HH24') as hour, COUNT(*) as cnt
            FROM event
            WHERE type = 'gift' AND user_id = ? ${roomFilterClause}
            GROUP BY hour
            ORDER BY hour
        `, [userId, ...roomFilterParams]);

        // 5. Day of Week (0 = Sunday, 6 = Saturday)
        const dayStats = await query(`
            SELECT EXTRACT(DOW FROM timestamp)::int as day, COUNT(*) as cnt
            FROM event
            WHERE type = 'gift' AND user_id = ? ${roomFilterClause}
            GROUP BY day
            ORDER BY day
        `, [userId, ...roomFilterParams]);

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
            isAdmin: 0,
            isSuperAdmin: 0,
            isModerator: userInfo?.isModerator || 0,
            fanLevel: userInfo?.fanLevel || 0,
            fanClubName: userInfo?.fanClubName || '',
            commonLanguage: userInfo?.commonLanguage || '',
            masteredLanguages: userInfo?.masteredLanguages || '',
            region: userInfo?.region || '',
            aiAnalysis: userInfo?.aiAnalysis || null,
            aiAnalysisJson: userInfo?.aiAnalysisJson || null,
            moderatorRooms
        };
    }

    // Room Detail Statistics (Header + Leaderboards)

    // Update room owner ID (for tracking persistent upgrades)
    async updateRoomOwner(roomId, ownerUserId) {
        if (!ownerUserId) return;
        await run(`UPDATE room SET owner_user_id = ? WHERE room_id = ?`, [ownerUserId, roomId]);
    }

    // Rename a room (migrate all data)
    async migrateRoomId(oldRoomId, newRoomId) {
        if (!oldRoomId || !newRoomId || oldRoomId === newRoomId) return;
        await this.ensureDb();

        const oldRoom = await get(`SELECT * FROM room WHERE room_id = ?`, [oldRoomId]);
        if (!oldRoom) throw new Error(`Room ${oldRoomId} not found`);

        const newRoomExists = await get(`SELECT 1 FROM room WHERE room_id = ?`, [newRoomId]);
        if (newRoomExists) throw new Error(`Target Room ID ${newRoomId} already exists`);

        console.log(`[Manager] Migrating room ${oldRoomId} -> ${newRoomId}...`);

        // 1. Create new room with same properties
        await run(`
            INSERT INTO room (room_id, numeric_room_id, name, address, language, updated_at, is_monitor_enabled, priority, owner_user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            newRoomId,
            oldRoom.numericRoomId,
            oldRoom.name,
            oldRoom.address,
            oldRoom.language,
            new Date(),
            oldRoom.isMonitorEnabled,
            oldRoom.priority,
            oldRoom.ownerUserId
        ]);

        // 2. Update events (batch update might take time, but referenced via index so should be okay)
        console.log(`[Manager] Moving events...`);
        await run(`UPDATE event SET room_id = ? WHERE room_id = ?`, [newRoomId, oldRoomId]);

        // 3. Update sessions
        console.log(`[Manager] Moving sessions...`);
        await run(`UPDATE session SET room_id = ? WHERE room_id = ?`, [newRoomId, oldRoomId]);

        // 4. Update room stats (delete old, let it regenerate for new)
        await run(`DELETE FROM room_stats WHERE room_id = ?`, [oldRoomId]);

        // 5. Delete old room
        console.log(`[Manager] Deleting old room...`);
        await run(`DELETE FROM room WHERE room_id = ?`, [oldRoomId]);

        console.log(`[Manager] Migration complete: ${oldRoomId} -> ${newRoomId}`);
        return true;
    }

    async getRoomDetailStats(roomId, sessionId = null, sinceTime = null) {
        await this.ensureDb();

        // Build WHERE clause based on sessionId
        let whereClause = 'WHERE room_id = ?';
        let params = [roomId];
        let usedFallback = false;

        if (sessionId === 'live' || !sessionId) {
            // Live mode: show untagged events (session_id IS NULL)
            whereClause += ' AND session_id IS NULL';
            if (sinceTime) {
                whereClause += ' AND timestamp >= ?';
                params.push(sinceTime);
            }
        } else {
            // Specific session requested
            whereClause += ' AND session_id = ?';
            params.push(sessionId);
        }

        // 1. Summary Stats
        // Total Income, Total Comments, Total Likes (Max), Total Viewers (Max? or Sum of Uniques?)
        // For Viewers/Members: COUNT(*) of 'member' events approx unique entries if session-based.
        // For Likes: MAX(likeCount) is best for snapshot.

        let summary = null;
        let timeRange = { start: null, end: null };
        let duration = 0;

        if (sessionId && sessionId !== 'live' && isIncrementalStatsReadEnabled()) {
            const sessionSummary = await get(`
                SELECT
                    session_id,
                    room_id,
                    start_time,
                    end_time,
                    duration_secs,
                    chat_count,
                    gift_value,
                    member_count
                FROM session_summary
                WHERE room_id = ? AND session_id = ?
            `, [roomId, sessionId]);

            if (sessionSummary) {
                const likeSummary = await get(`
                    SELECT MAX(CASE WHEN type='like' THEN COALESCE(total_like_count, 0) ELSE 0 END) as maxLikes
                    FROM event
                    WHERE room_id = ? AND session_id = ?
                `, [roomId, sessionId]);

                summary = {
                    totalComments: sessionSummary.chatCount || 0,
                    totalVisits: sessionSummary.memberCount || 0,
                    maxLikes: likeSummary?.maxLikes || 0,
                    totalGiftValue: sessionSummary.giftValue || 0
                };
                timeRange = {
                    start: sessionSummary.startTime || null,
                    end: sessionSummary.endTime || null
                };
                duration = parseInt(sessionSummary.durationSecs) || 0;
            }
        }

        if (!summary) {
            summary = await get(`
                SELECT
                    SUM(CASE WHEN type='chat' THEN 1 ELSE 0 END) as totalComments,
                    SUM(CASE WHEN type='member' THEN 1 ELSE 0 END) as totalVisits,
                    MAX(CASE WHEN type='like' THEN COALESCE(total_like_count, 0) ELSE 0 END) as maxLikes,
                    SUM(CASE WHEN type='gift' THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END) as totalGiftValue
                FROM event
                ${whereClause}
            `, params);

            timeRange = await get(`SELECT MIN(timestamp) as start, MAX(timestamp) as end FROM event ${whereClause}`, params);
            if (timeRange.start && timeRange.end) {
                const start = new Date(timeRange.start);
                const end = new Date(timeRange.end);
                duration = Math.floor((end - start) / 1000);
            }
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
                endTime: timeRange.end || null,
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

    // All-time TOP50 leaderboards (across all sessions)
    async getAllTimeLeaderboards(roomId, sinceTime = null) {
        await this.ensureDb();

        let timeFilter = '';
        const baseParams = [roomId];
        if (sinceTime) {
            timeFilter = 'AND timestamp >= ?';
            baseParams.push(sinceTime);
        }

        // Top 50 Gifters (all time) - include unique_id for clickable search
        const topGifters = await query(`
            SELECT
                MAX(nickname) as nickname,
                MAX(unique_id) as unique_id,
                user_id as userId,
                SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as value
            FROM event
            WHERE room_id = ? AND type = 'gift' AND user_id IS NOT NULL ${timeFilter}
            GROUP BY user_id
            ORDER BY value DESC
            LIMIT 50
        `, [...baseParams]);

        // Top 50 Chatters (all time) - include unique_id for clickable search
        const topChatters = await query(`
            SELECT
                MAX(nickname) as nickname,
                MAX(unique_id) as unique_id,
                user_id as userId,
                COUNT(*) as count
            FROM event
            WHERE room_id = ? AND type = 'chat' AND user_id IS NOT NULL ${timeFilter}
            GROUP BY user_id
            ORDER BY count DESC
            LIMIT 50
        `, [...baseParams]);

        // Top 50 Likers (all time) - include unique_id for clickable search
        const topLikers = await query(`
            SELECT
                MAX(nickname) as nickname,
                MAX(unique_id) as unique_id,
                user_id as userId,
                SUM(COALESCE(like_count, 0)) as count
            FROM event
            WHERE room_id = ? AND type = 'like' AND user_id IS NOT NULL
            GROUP BY user_id
            ORDER BY count DESC
            LIMIT 50
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
    async archiveStaleLiveEvents(roomId, options = {}) {
        await this.ensureDb();

        const now = Date.now();
        const gapThresholdMinutes = Number.isFinite(Number(options.gapThresholdMinutes)) && Number(options.gapThresholdMinutes) > 0
            ? Number(options.gapThresholdMinutes)
            : 60;
        const splitOlderThanMinutes = Number.isFinite(Number(options.splitOlderThanMinutes)) && Number(options.splitOlderThanMinutes) > 0
            ? Number(options.splitOlderThanMinutes)
            : 120;
        const archiveAllOlderThanMinutes = Number.isFinite(Number(options.archiveAllOlderThanMinutes)) && Number(options.archiveAllOlderThanMinutes) > 0
            ? Number(options.archiveAllOlderThanMinutes)
            : 30;
        const splitOlderThanTimestamp = now - splitOlderThanMinutes * 60 * 1000;

        // Get all timestamps of current live events
        const events = await query(`
            SELECT id, timestamp
            FROM event
            WHERE room_id = ? AND session_id IS NULL
            ORDER BY timestamp ASC
        `, [roomId]);

        if (events.length === 0) return { archived: 0 };

        const GAP_THRESHOLD_MS = gapThresholdMinutes * 60 * 1000;
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

            if (ageOfOldest > splitOlderThanMinutes * 60 * 1000 && ageOfNewest < 10 * 60 * 1000) {
                // Archive events older than 2 hours as a separate session
                for (let i = 0; i < events.length; i++) {
                    const eventTimestamp = new Date(events[i].timestamp).getTime();
                    if (eventTimestamp > splitOlderThanTimestamp) {
                        splitIndex = i;
                        break;
                    }
                }
                if (splitIndex > 0) {
                    console.log(`[Manager] Forcing archive of ${splitIndex} old events for ${roomId} (Age-based split > ${splitOlderThanMinutes}m)`);
                }
            }
        }

        // Strategy 3: If all orphan events are older than 30 minutes, archive ALL of them
        // This handles the case where stream ended and we're reconnecting much later
        if (splitIndex === -1) {
            const newestEventTime = new Date(events[events.length - 1].timestamp).getTime();
            const ageOfNewest = now - newestEventTime;
            const STALE_THRESHOLD_MS = archiveAllOlderThanMinutes * 60 * 1000;

            if (ageOfNewest > STALE_THRESHOLD_MS) {
                // All events are stale - archive everything
                splitIndex = events.length; // Archive all
                console.log(`[Manager] Archiving all ${events.length} stale events for ${roomId} (All events > ${archiveAllOlderThanMinutes} min old)`);
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

            return {
                archived: staleEvents.length,
                sessionId: finalSessionId,
                gapThresholdMinutes,
                splitOlderThanMinutes,
                archiveAllOlderThanMinutes,
            };
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

    // Refresh room_stats table with pre-aggregated statistics
    // This dramatically improves getRoomStats performance for calculated sorts
    async refreshRoomStats() {
        await this.ensureDb();
        console.log('[Manager] Refreshing room_stats cache...');
        const startTime = Date.now();

        try {
            // Get all room IDs
            const rooms = await query(`SELECT room_id FROM room`);
            if (rooms.length === 0) {
                console.log('[Manager] No rooms to refresh');
                const elapsed = Date.now() - startTime;
                metricsService.incrementCounter('stats.room_refresh.success', 1, { outcome: 'noop' }, { log: false });
                metricsService.recordTiming('stats.room_refresh.duration_ms', elapsed, { outcome: 'noop' }, { log: false });
                metricsService.emitLog('info', 'stats.room_refresh', {
                    status: 'noop',
                    durationMs: elapsed,
                    refreshed: 0,
                    roomCount: 0,
                });
                return { refreshed: 0 };
            }

            const roomIds = rooms.map(r => r.roomId);
            const placeholders = roomIds.map(() => '?').join(',');

            // 1. Basic stats (all-time gift value, visit count, chat count)
            const basicStats = await query(`
                SELECT
                    room_id,
                    COALESCE(SUM(CASE WHEN type = 'gift'
                        THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END), 0) as all_gift,
                    COUNT(*) FILTER (WHERE type = 'member') as all_visits,
                    COUNT(*) FILTER (WHERE type = 'chat') as all_comments,
                    EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) as all_time_duration_secs
                FROM event
                WHERE room_id IN (${placeholders})
                GROUP BY room_id
            `, roomIds);
            const basicMap = Object.fromEntries(basicStats.map(r => [r.roomId, r]));

            // 2. Valid daily average (days with >= 2 hours of activity)
            const dailyStats = await query(`
                WITH daily_stats AS (
                    SELECT
                        room_id,
                        DATE(timestamp) as day,
                        SUM(CASE WHEN type = 'gift' THEN COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1) ELSE 0 END) as gift_value,
                        EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 3600 as hours
                    FROM event
                    WHERE room_id IN (${placeholders})
                    GROUP BY room_id, DATE(timestamp)
                    HAVING EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 3600 >= 2
                )
                SELECT room_id,
                       AVG(gift_value) as avg_gift,
                       COUNT(*) as valid_days
                FROM daily_stats
                GROUP BY room_id
            `, roomIds);
            const dailyMap = Object.fromEntries(dailyStats.map(r => [r.roomId, {
                avgGift: Math.round(parseFloat(r.avgGift)) || 0,
                validDays: parseInt(r.validDays) || 0
            }]));

            // 3. TOP concentration stats
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

            // 4. Monthly gift values (current month)
            const monthStart = new Date();
            monthStart.setDate(1);
            monthStart.setHours(0, 0, 0, 0);
            const monthlyStats = await query(`
                SELECT room_id,
                       COALESCE(SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)), 0) as monthly_gift
                FROM event
                WHERE room_id IN (${placeholders})
                AND type = 'gift'
                AND timestamp >= ?
                GROUP BY room_id
            `, [...roomIds, monthStart.toISOString()]);
            const monthlyMap = Object.fromEntries(monthlyStats.map(r => [r.roomId, parseInt(r.monthlyGift) || 0]));

            // 5. Last session times
            const lastSessionStats = await query(`
                SELECT s1.room_id, s1.created_at as last_session
                FROM session s1
                INNER JOIN (
                    SELECT room_id, MAX(created_at) as max_created
                    FROM session
                    WHERE room_id IN (${placeholders})
                    GROUP BY room_id
                ) s2 ON s1.room_id = s2.room_id AND s1.created_at = s2.max_created
            `, roomIds);
            const sessionMap = Object.fromEntries(lastSessionStats.map(r => [r.roomId, r.lastSession]));

            // 6. Upsert room_stats for each room
            let refreshed = 0;
            for (const roomId of roomIds) {
                const basic = basicMap[roomId] || {};
                const daily = dailyMap[roomId] || {};
                const conc = concentrationMap[roomId] || {};

                const allGift = parseInt(basic.allGift) || 0;
                const allVisits = parseInt(basic.allVisits) || 0;
                const allComments = parseInt(basic.allComments) || 0;
                const durationMins = (parseFloat(basic.allTimeDurationSecs) || 0) / 60;

                const giftEfficiency = allVisits > 0 ? (allGift / allVisits).toFixed(2) : 0;
                const interactEfficiency = allVisits > 0 ? (allComments / allVisits).toFixed(2) : 0;
                const accountQuality = durationMins > 0 ? (allVisits / durationMins).toFixed(2) : 0;

                const top1Ratio = conc.total > 0 ? Math.round((conc.top1 / conc.total) * 100) : 0;
                const top3Ratio = conc.total > 0 ? Math.round((conc.top3 / conc.total) * 100) : 0;
                const top10Ratio = conc.total > 0 ? Math.round((conc.top10 / conc.total) * 100) : 0;
                const top30Ratio = conc.total > 0 ? Math.round((conc.top30 / conc.total) * 100) : 0;

                const monthlyGift = monthlyMap[roomId] || 0;
                const lastSession = sessionMap[roomId] || null;

                await run(`
                    INSERT INTO room_stats (
                        room_id, all_time_gift_value, all_time_visit_count, all_time_chat_count,
                        valid_daily_avg, valid_days, top1_ratio, top3_ratio, top10_ratio, top30_ratio,
                        gift_efficiency, interact_efficiency, account_quality,
                        monthly_gift_value, last_session_time, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                    ON CONFLICT (room_id) DO UPDATE SET
                        all_time_gift_value = EXCLUDED.all_time_gift_value,
                        all_time_visit_count = EXCLUDED.all_time_visit_count,
                        all_time_chat_count = EXCLUDED.all_time_chat_count,
                        valid_daily_avg = EXCLUDED.valid_daily_avg,
                        valid_days = EXCLUDED.valid_days,
                        top1_ratio = EXCLUDED.top1_ratio,
                        top3_ratio = EXCLUDED.top3_ratio,
                        top10_ratio = EXCLUDED.top10_ratio,
                        top30_ratio = EXCLUDED.top30_ratio,
                        gift_efficiency = EXCLUDED.gift_efficiency,
                        interact_efficiency = EXCLUDED.interact_efficiency,
                        account_quality = EXCLUDED.account_quality,
                        monthly_gift_value = EXCLUDED.monthly_gift_value,
                        last_session_time = EXCLUDED.last_session_time,
                        updated_at = NOW()
                `, [
                    roomId, allGift, allVisits, allComments,
                    daily.avgGift || 0, daily.validDays || 0,
                    top1Ratio, top3Ratio, top10Ratio, top30Ratio,
                    giftEfficiency, interactEfficiency, accountQuality,
                    monthlyGift, lastSession
                ]);
                refreshed++;
            }

            const elapsed = Date.now() - startTime;
            console.log(`[Manager] Room stats refreshed: ${refreshed} rooms in ${elapsed}ms`);
            metricsService.incrementCounter('stats.room_refresh.success', 1, { outcome: 'success' }, { log: false });
            metricsService.recordTiming('stats.room_refresh.duration_ms', elapsed, { outcome: 'success' }, { log: false });
            metricsService.emitLog('info', 'stats.room_refresh', {
                status: 'success',
                durationMs: elapsed,
                refreshed,
                roomCount: roomIds.length,
            });
            return { refreshed, elapsedMs: elapsed };

        } catch (err) {
            const elapsed = Date.now() - startTime;
            metricsService.incrementCounter('stats.room_refresh.failure', 1, {}, { log: false });
            metricsService.recordTiming('stats.room_refresh.duration_ms', elapsed, { outcome: 'error' }, { log: false });
            metricsService.emitLog('error', 'stats.room_refresh', {
                status: 'error',
                durationMs: elapsed,
                error: metricsService.safeErrorMessage(err),
            });
            console.error('[Manager] Error refreshing room_stats:', err);
            throw err;
        }
    }

    // Get pre-aggregated room stats (fast path for calculated sorts)
    async getRoomStatsFromCache() {
        await this.ensureDb();
        return await query(`SELECT * FROM room_stats`);
    }

    // Refresh user_stats table with pre-aggregated statistics
    // This dramatically improves getTopGifters performance
    async refreshUserStats() {
        await this.ensureDb();
        console.log('[Manager] Refreshing user_stats cache...');
        const startTime = Date.now();

        try {
            // 1. Get all users who have gifted (only users with gifts matter)
            const users = await query(`
                SELECT DISTINCT user_id FROM event WHERE type = 'gift' AND user_id IS NOT NULL
            `);
            if (users.length === 0) {
                console.log('[Manager] No gifting users to refresh');
                const elapsed = Date.now() - startTime;
                metricsService.incrementCounter('stats.user_refresh.success', 1, { outcome: 'noop' }, { log: false });
                metricsService.recordTiming('stats.user_refresh.duration_ms', elapsed, { outcome: 'noop' }, { log: false });
                metricsService.emitLog('info', 'stats.user_refresh', {
                    status: 'noop',
                    durationMs: elapsed,
                    refreshed: 0,
                    userCount: 0,
                });
                return { refreshed: 0 };
            }

            const userIds = users.map(u => u.userId);
            console.log(`[Manager] Refreshing stats for ${userIds.length} users...`);

            // Process in batches of 500 to avoid memory issues
            const BATCH_SIZE = 500;
            let totalRefreshed = 0;

            for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
                const batchIds = userIds.slice(i, i + BATCH_SIZE);
                const placeholders = batchIds.map(() => '?').join(',');

                // 2. Basic gift stats per user
                const basicStats = await query(`
                    SELECT
                        user_id,
                        SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_gift,
                        COUNT(DISTINCT room_id) as room_count,
                        MAX(timestamp) as last_active
                    FROM event
                    WHERE type = 'gift' AND user_id IN (${placeholders})
                    GROUP BY user_id
                `, batchIds);
                const basicMap = Object.fromEntries(basicStats.map(r => [r.userId, r]));

                // 3. Chat counts per user
                const chatStats = await query(`
                    SELECT user_id, COUNT(*) as chat_count
                    FROM event
                    WHERE type = 'chat' AND user_id IN (${placeholders})
                    GROUP BY user_id
                `, batchIds);
                const chatMap = Object.fromEntries(chatStats.map(r => [r.userId, parseInt(r.chatCount) || 0]));

                // 4. Rose and TikTok gift stats
                const roseTiktokStats = await query(`
                    SELECT
                        user_id,
                        ${EVENT_GIFT_TYPE_SQL} as gift_type,
                        SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as total_value,
                        SUM(COALESCE(repeat_count, 1)) as gift_count
                    FROM event
                    WHERE type = 'gift'
                      AND user_id IN (${placeholders})
                      AND ${EVENT_GIFT_TYPE_SQL} IN ('rose', 'tiktok')
                    GROUP BY user_id, ${EVENT_GIFT_TYPE_SQL}
                `, batchIds);

                const roseMap = {};
                const tiktokMap = {};
                for (const r of roseTiktokStats) {
                    if (r.giftType === 'rose') {
                        roseMap[r.userId] = { value: parseInt(r.totalValue) || 0, count: parseInt(r.giftCount) || 0 };
                    } else if (r.giftType === 'tiktok') {
                        tiktokMap[r.userId] = { value: parseInt(r.totalValue) || 0, count: parseInt(r.giftCount) || 0 };
                    }
                }

                // 5. Top room per user (highest contribution)
                const topRoomStats = await query(`
                    WITH user_room_gifts AS (
                        SELECT user_id, room_id,
                               SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as room_value
                        FROM event
                        WHERE type = 'gift' AND user_id IN (${placeholders})
                        GROUP BY user_id, room_id
                    ),
                    ranked AS (
                        SELECT user_id, room_id, room_value,
                               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY room_value DESC) as rn
                        FROM user_room_gifts
                    )
                    SELECT user_id, room_id, room_value
                    FROM ranked WHERE rn = 1
                `, batchIds);
                const topRoomMap = Object.fromEntries(topRoomStats.map(r => [r.userId, {
                    roomId: r.roomId,
                    value: parseInt(r.roomValue) || 0
                }]));

                // 6. Upsert user_stats for each user in batch
                for (const userId of batchIds) {
                    const basic = basicMap[userId] || {};
                    const rose = roseMap[userId] || { value: 0, count: 0 };
                    const tiktok = tiktokMap[userId] || { value: 0, count: 0 };
                    const topRoom = topRoomMap[userId] || { roomId: null, value: 0 };

                    await run(`
                        INSERT INTO user_stats (
                            user_id, total_gift_value, room_count, chat_count,
                            rose_value, tiktok_value, rose_count, tiktok_count,
                            top_room_id, top_room_value, last_active, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                        ON CONFLICT (user_id) DO UPDATE SET
                            total_gift_value = EXCLUDED.total_gift_value,
                            room_count = EXCLUDED.room_count,
                            chat_count = EXCLUDED.chat_count,
                            rose_value = EXCLUDED.rose_value,
                            tiktok_value = EXCLUDED.tiktok_value,
                            rose_count = EXCLUDED.rose_count,
                            tiktok_count = EXCLUDED.tiktok_count,
                            top_room_id = EXCLUDED.top_room_id,
                            top_room_value = EXCLUDED.top_room_value,
                            last_active = EXCLUDED.last_active,
                            updated_at = NOW()
                    `, [
                        userId,
                        parseInt(basic.totalGift) || 0,
                        parseInt(basic.roomCount) || 0,
                        chatMap[userId] || 0,
                        rose.value,
                        tiktok.value,
                        rose.count,
                        tiktok.count,
                        topRoom.roomId,
                        topRoom.value,
                        basic.lastActive || null
                    ]);
                    totalRefreshed++;
                }

                console.log(`[Manager] Processed batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(userIds.length / BATCH_SIZE)}`);
            }

            const elapsed = Date.now() - startTime;
            console.log(`[Manager] User stats refreshed: ${totalRefreshed} users in ${elapsed}ms`);
            metricsService.incrementCounter('stats.user_refresh.success', 1, { outcome: 'success' }, { log: false });
            metricsService.recordTiming('stats.user_refresh.duration_ms', elapsed, { outcome: 'success' }, { log: false });
            metricsService.emitLog('info', 'stats.user_refresh', {
                status: 'success',
                durationMs: elapsed,
                refreshed: totalRefreshed,
                userCount: userIds.length,
            });
            return { refreshed: totalRefreshed, elapsedMs: elapsed };

        } catch (err) {
            const elapsed = Date.now() - startTime;
            metricsService.incrementCounter('stats.user_refresh.failure', 1, {}, { log: false });
            metricsService.recordTiming('stats.user_refresh.duration_ms', elapsed, { outcome: 'error' }, { log: false });
            metricsService.emitLog('error', 'stats.user_refresh', {
                status: 'error',
                durationMs: elapsed,
                error: metricsService.safeErrorMessage(err),
            });
            console.error('[Manager] Error refreshing user_stats:', err);
            throw err;
        }
    }

    // Refresh global_stats table with pre-aggregated hourly/daily statistics
    // This dramatically improves getGlobalStats performance (21s -> instant)
    async refreshGlobalStats() {
        await this.ensureDb();
        console.log('[Manager] Refreshing global_stats cache...');
        const startTime = Date.now();

        try {
            // Limit to last 30 days for practical use
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                .toISOString().replace('T', ' ').slice(0, 19);

            // Chinese language filter
            const chineseFilter = `(u.common_language = '中文' OR u.mastered_languages = '中文')`;

            // 24-Hour Distribution
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

            // Weekly Distribution
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

            // Save to cache table
            await run(`
                INSERT INTO global_stats (id, hour_stats_json, day_stats_json, updated_at)
                VALUES (1, ?, ?, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    hour_stats_json = EXCLUDED.hour_stats_json,
                    day_stats_json = EXCLUDED.day_stats_json,
                    updated_at = NOW()
            `, [JSON.stringify(hourStats), JSON.stringify(dayStats)]);

            const elapsed = Date.now() - startTime;
            console.log(`[Manager] Global stats refreshed in ${elapsed}ms`);
            metricsService.incrementCounter('stats.global_refresh.success', 1, { outcome: 'success' }, { log: false });
            metricsService.recordTiming('stats.global_refresh.duration_ms', elapsed, { outcome: 'success' }, { log: false });
            metricsService.emitLog('info', 'stats.global_refresh', {
                status: 'success',
                durationMs: elapsed,
            });
            return { success: true, elapsedMs: elapsed };

        } catch (err) {
            const elapsed = Date.now() - startTime;
            metricsService.incrementCounter('stats.global_refresh.failure', 1, {}, { log: false });
            metricsService.recordTiming('stats.global_refresh.duration_ms', elapsed, { outcome: 'error' }, { log: false });
            metricsService.emitLog('error', 'stats.global_refresh', {
                status: 'error',
                durationMs: elapsed,
                error: metricsService.safeErrorMessage(err),
            });
            console.error('[Manager] Error refreshing global_stats:', err);
            throw err;
        }
    }
}

const manager = new Manager();
module.exports = { manager };
