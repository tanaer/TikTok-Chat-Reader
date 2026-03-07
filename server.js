/**
 * TikTok Chat Reader - Node.js Server
 * Combined Socket.IO (TikTok events) + REST API (data management)
 */
require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { TikTokConnectionWrapper, getGlobalConnectionCount } = require('./connectionWrapper');
const { manager } = require('./manager');
const { AutoRecorder } = require('./auto_recorder');
const recordingManager = require('./recording_manager');
const ffmpegManager = require('./utils/ffmpeg_manager');
const { router: userManagementRouter, startPeriodicTasks } = require('./routes/index');
const { optionalAuth, authenticate, requireAdmin } = require('./middleware/auth');
const { checkRoomQuota, getUserQuota } = require('./middleware/quota');
const db = require('./db');
const keyManager = require('./utils/keyManager');

// Helper: get user's room access context in a single query per request
async function getUserRoomAccessContext(req) {
    if (req._userRoomAccessContext) return req._userRoomAccessContext;

    if (!req.user) {
        req._userRoomAccessContext = { roomFilter: [], userRoomData: {}, dataStartTimes: {} };
        return req._userRoomAccessContext;
    }
    if (req.user.role === 'admin') {
        req._userRoomAccessContext = { roomFilter: null, userRoomData: null, dataStartTimes: null };
        return req._userRoomAccessContext;
    }

    const rows = await db.all(
        'SELECT room_id, alias, first_added_at FROM user_room WHERE user_id = ? AND deleted_at IS NULL',
        [req.user.id]
    );

    const roomFilter = [];
    const userRoomData = {};
    const dataStartTimes = {};
    for (const row of rows) {
        roomFilter.push(row.roomId);
        userRoomData[row.roomId] = { alias: row.alias, firstAddedAt: row.firstAddedAt };
        if (row.firstAddedAt) dataStartTimes[row.roomId] = row.firstAddedAt;
    }

    req._userRoomAccessContext = { roomFilter, userRoomData, dataStartTimes };
    return req._userRoomAccessContext;
}

// Helper: get user's allowed room IDs (returns null for admin = no filter)
async function getUserRoomFilter(req) {
    const { roomFilter } = await getUserRoomAccessContext(req);
    return roomFilter;
}

// Helper: get user's room data map { roomId -> { alias, firstAddedAt } } for display name & time filter
async function getUserRoomDataMap(req) {
    const { userRoomData } = await getUserRoomAccessContext(req);
    return userRoomData;
}

// Helper: get data start time for a specific room (member's first_added_at, null for admin)
async function getDataStartTime(req, roomId) {
    const dataStartTimes = await getDataStartTimes(req);
    if (dataStartTimes === null) return null;
    return dataStartTimes[roomId] || null;
}

// Helper: get data start times map for all user's rooms { roomId: ISO string }
async function getDataStartTimes(req) {
    const { dataStartTimes } = await getUserRoomAccessContext(req);
    return dataStartTimes;
}

// Helper: Check if user can access a specific room
async function canAccessRoom(req, roomId) {
    if (!req.user) return { allowed: false, reason: 'Not logged in' };
    if (req.user.role === 'admin') return { allowed: true };
    const row = await db.get('SELECT room_id FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NULL', [req.user.id, roomId]);
    return { allowed: !!row };
}
// Helper: check if user owns a specific room
async function checkRoomOwnership(req, roomId) {
    if (!req.user) return false; // not logged in
    if (req.user.role === 'admin') return true; // admin - owns all
    const row = await db.get('SELECT 1 FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NULL', [req.user.id, roomId]);
    return !!row;
}


const app = express();
const httpServer = createServer(app);

// Start Auto Recorder (Dynamic interval from DB)
const autoRecorder = new AutoRecorder();
autoRecorder.setRecordingManager(recordingManager);
recordingManager.startMonitoring(); // Start stall detection for recordings

// Enable CORS & request body parsing
const REQUEST_BODY_LIMIT = '20mb';
const ROOM_LIST_CACHE_TTL_MS = Math.max(0, parseInt(process.env.ROOM_LIST_CACHE_TTL_MS || '10000', 10) || 10000);
const ROOM_LIST_CACHE_MAX_ENTRIES = 200;
const roomListResponseCache = new Map();
let roomListCacheVersion = 0;

function getRoomListActorCacheKey(req) {
    if (!req.user) return 'guest';
    return `${req.user.role}:${req.user.id || 0}`;
}

function buildRoomListCacheKey(endpoint, req, params = {}) {
    return JSON.stringify([
        endpoint,
        roomListCacheVersion,
        getRoomListActorCacheKey(req),
        Number(params.page || 1),
        Number(params.limit || 50),
        String(params.search || ''),
        String(params.sort || '')
    ]);
}

function readRoomListCache(cacheKey) {
    if (ROOM_LIST_CACHE_TTL_MS <= 0) return null;
    const cached = roomListResponseCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        roomListResponseCache.delete(cacheKey);
        return null;
    }
    return cached.payload;
}

function writeRoomListCache(cacheKey, payload) {
    if (ROOM_LIST_CACHE_TTL_MS <= 0) return payload;
    if (roomListResponseCache.size >= ROOM_LIST_CACHE_MAX_ENTRIES) {
        const oldestKey = roomListResponseCache.keys().next().value;
        if (oldestKey) roomListResponseCache.delete(oldestKey);
    }
    roomListResponseCache.set(cacheKey, {
        payload,
        expiresAt: Date.now() + ROOM_LIST_CACHE_TTL_MS,
    });
    return payload;
}

function invalidateRoomListCaches(reason = 'manual') {
    roomListCacheVersion += 1;
    roomListResponseCache.clear();
    console.log(`[CACHE] Room list cache invalidated: ${reason}`);
}

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));
app.use(express.static('public')); // Serve static files first for performance

// Mount user management routes (auth, user center, subscription, admin)
app.use(userManagementRouter);

const io = new Server(httpServer, {
    cors: {
        origin: '*'
    },
    // Performance optimizations
    transports: ['websocket', 'polling'], // Prefer WebSocket, fallback to polling
    pingInterval: 10000,  // 10s instead of default 25s
    pingTimeout: 5000,    // 5s instead of default 20s
    upgradeTimeout: 10000 // Faster upgrade to WebSocket
});

// ========================
// Socket.IO - TikTok Events (USES AutoRecorder for persistent connections)
// ========================
io.on('connection', (socket) => {
    let subscribedRoomId = null;  // Room this socket is subscribed to
    let eventListeners = [];      // Track event listeners for cleanup

    console.info('New connection from origin', socket.handshake.headers['origin'] || socket.handshake.headers['referer']);

    socket.on('setUniqueId', async (uniqueId, options) => {
        // Clean up previous subscription
        if (subscribedRoomId && eventListeners.length > 0) {
            const prevWrapper = autoRecorder.getConnection(subscribedRoomId);
            if (prevWrapper) {
                eventListeners.forEach(({ event, handler }) => {
                    prevWrapper.connection.off(event, handler);
                });
            }
            eventListeners = [];
        }

        subscribedRoomId = uniqueId;

        // Check if AutoRecorder is already connected to this room
        if (autoRecorder.isConnected(uniqueId)) {
            console.log(`[Socket] Room ${uniqueId} already connected via AutoRecorder, subscribing to events`);
            const wrapper = autoRecorder.getConnection(uniqueId);
            subscribeToWrapper(socket, wrapper, uniqueId);
            socket.emit('tiktokConnected', { roomId: uniqueId, alreadyConnected: true });
            return;
        }

        // Start recording via AutoRecorder (runs independently of socket)
        try {
            socket.emit('tiktokConnecting', { roomId: uniqueId });
            const result = await autoRecorder.startRoom(uniqueId);

            // Subscribe to events
            const wrapper = autoRecorder.getConnection(uniqueId);
            if (wrapper) {
                subscribeToWrapper(socket, wrapper, uniqueId);
            }
            socket.emit('tiktokConnected', result.state);
        } catch (err) {
            // Clear subscriptions on failure to prevent receiving wrong room's events
            eventListeners = [];
            subscribedRoomId = null;
            socket.emit('tiktokDisconnected', err.toString());
        }
    });

    // Subscribe this socket to a wrapper's events (for UI display only)
    function subscribeToWrapper(socket, wrapper, roomId) {
        console.log(`[Socket] Subscribing to wrapper events for ${roomId}, wsConnected: ${wrapper?.connection?.isConnected}`);

        if (!wrapper?.connection) {
            console.error(`[Socket] ERROR: wrapper.connection is null for ${roomId}!`);
            return;
        }

        const handlers = {
            roomUser: msg => socket.emit('roomUser', msg),
            member: msg => {
                socket.emit('member', {
                    uniqueId: msg.user?.uniqueId || msg.uniqueId,
                    nickname: msg.user?.nickname || msg.nickname,
                    userId: msg.user?.userId || msg.userId
                });
            },
            chat: msg => {
                // Debug log for first few chat messages
                console.log(`[Socket] Forwarding chat from ${roomId}: ${msg.user?.uniqueId || msg.uniqueId}`);
                socket.emit('chat', {
                    uniqueId: msg.user?.uniqueId || msg.uniqueId,
                    nickname: msg.user?.nickname || msg.nickname,
                    comment: msg.comment,
                    userId: msg.user?.userId || msg.userId
                });
            },
            gift: msg => {
                const gift = msg.gift || {};
                const extendedGift = msg.extendedGiftInfo || {};
                let giftImage = '';
                if (gift.icon?.url_list?.[0]) giftImage = gift.icon.url_list[0];
                else if (extendedGift.image?.url_list?.[0]) giftImage = extendedGift.image.url_list[0];
                else if (extendedGift.icon?.url_list?.[0]) giftImage = extendedGift.icon.url_list[0];

                socket.emit('gift', {
                    uniqueId: msg.user?.uniqueId || msg.uniqueId,
                    nickname: msg.user?.nickname || msg.nickname,
                    giftId: msg.giftId || gift.id,
                    giftName: gift.giftName || extendedGift.name || 'Gift',
                    giftImage: giftImage,
                    diamondCount: gift.diamondCount || extendedGift.diamond_count || 0,
                    repeatCount: msg.repeatCount || 1,
                    repeatEnd: msg.repeatEnd
                });
            },
            like: msg => {
                socket.emit('like', {
                    uniqueId: msg.user?.uniqueId || msg.uniqueId,
                    nickname: msg.user?.nickname || msg.nickname,
                    likeCount: msg.likeCount,
                    totalLikeCount: msg.totalLikeCount
                });
            },
            streamEnd: () => socket.emit('streamEnd'),
            social: msg => socket.emit('social', msg),
            questionNew: msg => socket.emit('questionNew', msg),
            linkMicBattle: msg => socket.emit('linkMicBattle', msg),
            linkMicArmies: msg => socket.emit('linkMicArmies', msg),
            liveIntro: msg => socket.emit('liveIntro', msg),
            emote: msg => socket.emit('emote', msg),
            envelope: msg => socket.emit('envelope', msg),
            subscribe: msg => socket.emit('subscribe', msg)
        };

        // Add event listeners
        for (const [event, handler] of Object.entries(handlers)) {
            wrapper.connection.on(event, handler);
            eventListeners.push({ event, handler });
        }

        // Handle wrapper disconnect (notify UI)
        wrapper.once('disconnected', reason => {
            socket.emit('tiktokDisconnected', reason);
        });
    }

    // Unsubscribe from live events (used when switching to history view)
    // This DOES NOT stop recording - only cleans up UI event listeners
    socket.on('unsubscribe', () => {
        console.log(`[Socket] User unsubscribed from ${subscribedRoomId}. Recording continues in background.`);
        // Clean up UI listeners but do NOT call autoRecorder.disconnectRoom()
        if (subscribedRoomId && eventListeners.length > 0) {
            const wrapper = autoRecorder.getConnection(subscribedRoomId);
            if (wrapper) {
                eventListeners.forEach(({ event, handler }) => {
                    wrapper.connection.off(event, handler);
                });
            }
            eventListeners = [];
        }
        // Clear subscribed room so events don't get sent to this socket
        subscribedRoomId = null;
    });

    socket.on('requestDisconnect', () => {
        // User manually requested stop - this DOES stop the AutoRecorder recording
        console.log('Client requested disconnect');
        if (subscribedRoomId && autoRecorder.isConnected(subscribedRoomId)) {
            autoRecorder.disconnectRoom(subscribedRoomId);
        }
        socket.emit('tiktokDisconnected', '用户手动断开');
    });

    socket.on('disconnect', () => {
        // Clean up event listeners but DON'T disconnect the AutoRecorder
        // Recording continues even when user leaves page!
        if (subscribedRoomId && eventListeners.length > 0) {
            const wrapper = autoRecorder.getConnection(subscribedRoomId);
            if (wrapper) {
                eventListeners.forEach(({ event, handler }) => {
                    wrapper.connection.off(event, handler);
                });
            }
            console.log(`[Socket] User left page, cleaned up listeners for ${subscribedRoomId}. Recording continues.`);
        }
    });
});

// Emit global connection statistics
setInterval(() => {
    io.emit('statistic', { globalConnectionCount: getGlobalConnectionCount() });
}, 5000);

// ========================
// REST API - Data Management
// ========================

// Sensitive setting keys that should NOT be exposed to non-admin users
const SENSITIVE_SETTING_KEYS = [
    'euler_keys', 'ai_api_key', 'ai_api_url', 'ai_model_name',
    'proxy_url', 'dynamic_tunnel_proxy', 'proxy_api_url',
    'session_id', 'port',
    'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass',
    'smtp_from', 'smtp_from_name', 'email_verification_enabled',
    'single_session_login_enabled'
];

function filterSensitiveSettings(settings) {
    const filtered = {};
    for (const [key, value] of Object.entries(settings)) {
        if (!SENSITIVE_SETTING_KEYS.includes(key)) {
            filtered[key] = value;
        }
    }
    return filtered;
}

// Config API
app.get('/api/config', optionalAuth, async (req, res) => {
    try {
        const settings = await manager.getAllSettings();
        const isAdmin = req.user && req.user.role === 'admin';
        res.json(isAdmin ? settings : filterSensitiveSettings(settings));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Settings API - GET to load settings
app.get('/api/settings', optionalAuth, async (req, res) => {
    try {
        const settings = await manager.getAllSettings();
        const isAdmin = req.user && req.user.role === 'admin';
        res.json(isAdmin ? settings : filterSensitiveSettings(settings));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Settings API - POST to save settings (admin only)
app.post('/api/settings', authenticate, requireAdmin, async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
        }
        // Refresh Euler API keys if they were updated
        if (settings.euler_keys !== undefined) {
            const dbSettings = await manager.getAllSettings();
            keyManager.refreshKeys(dbSettings);
        }
        // Reset email transporter if SMTP settings changed
        if (Object.keys(settings).some(k => k.startsWith('smtp_') || k === 'email_verification_enabled')) {
            try { require('./services/emailService').resetTransporter(); } catch (e) {}
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Alias: POST /api/config also saves settings (admin only)
app.post('/api/config', authenticate, requireAdmin, async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
        }
        // Refresh Euler API keys if they were updated
        if (settings.euler_keys !== undefined) {
            const dbSettings = await manager.getAllSettings();
            keyManager.refreshKeys(dbSettings);
        }
        // Reset email transporter if SMTP settings changed
        if (Object.keys(settings).some(k => k.startsWith('smtp_') || k === 'email_verification_enabled')) {
            try { require('./services/emailService').resetTransporter(); } catch (e) {}
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Gift Management API
app.get('/api/gifts', async (req, res) => {
    try {
        const gifts = await manager.getGifts();
        res.json(gifts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Gift display names API (for frontend batch lookup)
app.get('/api/gifts/display-names', async (req, res) => {
    try {
        const names = await manager.getGiftDisplayNames();
        res.json(names);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Room Sessions API
app.get('/api/rooms/:id/sessions', optionalAuth, async (req, res) => {
    try {
        const access = await canAccessRoom(req, req.params.id);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });
        const sessions = await manager.getSessions(req.params.id);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Archive Stale Live Events API (Fix for long sessions)
app.post('/api/rooms/:id/archive_stale', async (req, res) => {
    try {
        console.log(`[API] Archiving stale events for room ${req.params.id}`);
        const result = await manager.archiveStaleLiveEvents(req.params.id);
        res.json(result);
    } catch (err) {
        console.error('Error archiving stale events:', err);
        res.status(500).json({ error: err.message });
    }
});

// Maintenance API: Rebuild missing session records from events
app.post('/api/maintenance/rebuild_sessions', async (req, res) => {
    try {
        console.log('[API] Rebuilding missing sessions...');
        const result = await manager.rebuildMissingSessions();
        res.json(result);
    } catch (err) {
        console.error('Error rebuilding sessions:', err);
        res.status(500).json({ error: err.message });
    }
});

// Maintenance API: Merge Short Sessions
app.post('/api/maintenance/merge_sessions', async (req, res) => {
    try {
        console.log('[API] Merging short sessions...');
        const result = await manager.mergeContinuitySessions();
        res.json(result);
    } catch (err) {
        console.error('Error merging sessions:', err);
        res.status(500).json({ error: err.message });
    }
});

// FFmpeg Maintenance APIs
app.get('/api/maintenance/ffmpeg', async (req, res) => {
    try {
        const status = await ffmpegManager.checkFFmpegStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/maintenance/ffmpeg/install', async (req, res) => {
    try {
        const force = req.body.force === true;

        // Start installation in background or wait?
        // Let's wait, but user might timeout. Installation is fast (70MB download).
        // Let's set a long timeout on client or return "started" and poll?
        // Simple first: await.
        const result = await ffmpegManager.installFFmpeg(force);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Price API
app.post('/api/price', (req, res) => {
    const { id, price } = req.body;
    manager.savePrice(id, parseFloat(price));
    res.json({ success: true });
});

// Room API
// Get user's room quota info (for add-room modal)
app.get('/api/rooms/quota', optionalAuth, async (req, res) => {
    try {
        if (!req.user) return res.json({ quota: null });
        if (req.user.role === 'admin') {
            return res.json({
                quota: {
                    isAdmin: true,
                    limit: -1,
                    totalLimit: -1,
                    used: 0,
                    remaining: -1,
                    isUnlimited: true,
                    openRoomLimit: -1,
                    openRemaining: -1,
                    dailyLimit: -1,
                    dailyUsed: 0,
                    dailyRemaining: -1,
                }
            });
        }
        const quota = await getUserQuota(req.user.id);
        res.json({ quota });
    } catch (err) {
        console.error('[API] Quota error:', err.message);
        res.status(500).json({ error: '获取配额失败' });
    }
});

app.get('/api/rooms/stats', optionalAuth, async (req, res) => {
    try {
        const liveRoomIds = autoRecorder.getLiveRoomIds();
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const search = req.query.search || '';
        const sort = req.query.sort || 'default';
        const cacheKey = buildRoomListCacheKey('stats', req, { page, limit, search, sort });
        const cached = readRoomListCache(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const { roomFilter, userRoomData } = await getUserRoomAccessContext(req);

        console.log(`[API] /api/rooms/stats - user: ${req.user?.username || 'anonymous'}, role: ${req.user?.role || 'none'}, roomFilter: ${roomFilter === null ? 'null(admin)' : roomFilter?.length + ' rooms'}`);

        const result = await manager.getRoomStats(liveRoomIds, { page, limit, search, sort, roomFilter });

        // For members: overlay displayName from user_room alias
        if (userRoomData && result.data) {
            result.data = result.data.map(room => {
                const copy = userRoomData[room.roomId];
                return {
                    ...room,
                    displayName: (copy && copy.alias) || room.name || room.roomId,
                    firstAddedAt: copy ? copy.firstAddedAt : null,
                };
            });
        }

        const payload = writeRoomListCache(cacheKey, result);
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Debug API for connection diagnostics
app.get('/api/debug/connections', (req, res) => {
    try {
        const stats = autoRecorder.getConnectionStats();
        res.json({
            activeCount: stats.length,
            connections: stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms', optionalAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const search = req.query.search || '';
        const cacheKey = buildRoomListCacheKey('rooms', req, { page, limit, search });
        const cached = readRoomListCache(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const { roomFilter, userRoomData } = await getUserRoomAccessContext(req);
        const result = await manager.getRooms({ page, limit, search, roomFilter });

        // Merge isLive status from autoRecorder activeConnections
        const liveRoomIds = autoRecorder.getLiveRoomIds();
        result.data = result.data.map(room => {
            const copy = userRoomData ? userRoomData[room.roomId] : null;
            return {
                ...room,
                isLive: liveRoomIds.includes(room.roomId),
                displayName: copy ? (copy.alias || room.name || room.roomId) : room.name,
                firstAddedAt: copy ? copy.firstAddedAt : null,
            };
        });

        const payload = writeRoomListCache(cacheKey, result);
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Room Management API


app.delete('/api/rooms/:id', authenticate, async (req, res) => {
    try {
        const roomId = req.params.id;
        const isAdmin = req.user.role === 'admin';

        if (isAdmin) {
            // Admin: hard delete system room + all data
            await manager.deleteRoom(roomId);
            invalidateRoomListCaches('admin room delete');
            return res.json({ success: true });
        }

        // Member: soft-delete user_room copy only
        const copy = await db.get('SELECT id FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NULL', [req.user.id, roomId]);
        if (!copy) {
            return res.status(403).json({ error: '无权访问此房间' });
        }

        await db.run('UPDATE user_room SET deleted_at = NOW(), is_enabled = false, updated_at = NOW() WHERE id = ?', [copy.id]);
        console.log(`[API] User ${req.user.id} soft-deleted room copy: ${roomId}`);

        // Check if this was the last active copy - if so, disable monitoring to save resources
        const remainingCopies = await db.get(
            'SELECT COUNT(*) AS count FROM user_room WHERE room_id = ? AND deleted_at IS NULL',
            [roomId]
        );
        if (Number(remainingCopies?.count || 0) === 0) {
            console.log(`[API] Room ${roomId} has no active copies left, disabling monitoring`);
            await db.run('UPDATE room SET is_monitor_enabled = 0, updated_at = NOW() WHERE room_id = ?', [roomId]);
            await autoRecorder.disconnectRoom(roomId);
        }

        invalidateRoomListCaches('member room delete');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:id/stats_detail', optionalAuth, async (req, res) => {
    try {
        const roomId = req.params.id;
        const access = await canAccessRoom(req, roomId);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });

        const sessionId = req.query.sessionId || null;

        // Get stats
        const data = await manager.getRoomDetailStats(roomId, sessionId);

        // Get isLive status
        const liveRoomIds = autoRecorder.getLiveRoomIds();
        const isLive = liveRoomIds.includes(roomId);

        // Get last session for fallback
        const sessions = await manager.getSessions(roomId);
        const lastSession = sessions && sessions.length > 0 ? sessions[0] : null;

        res.json({
            ...data,
            isLive,
            lastSession,
            currentSessionId: sessionId
        });
    } catch (err) {
        console.error('[API] stats_detail error:', err);
        res.status(500).json({ error: err.message });
    }
});

// All-Time TOP30 Leaderboards API (for room detail sidebar)
app.get('/api/rooms/:id/alltime-leaderboards', optionalAuth, async (req, res) => {
    try {
        const roomId = req.params.id;
        const access = await canAccessRoom(req, roomId);
        if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });

        const data = await manager.getAllTimeLeaderboards(roomId);
        res.json(data);
    } catch (err) {
        console.error('[API] alltime-leaderboards error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Session API
app.post('/api/sessions/end', async (req, res) => {
    try {
        const { roomId, snapshot, startTime } = req.body;

        // Create session first to get session_id
        const sessionId = await manager.createSession(roomId, snapshot);

        // Tag all untagged events for this room with the new session_id
        await manager.tagEventsWithSession(roomId, sessionId, startTime);

        console.log(`[SESSION] Ended session ${sessionId} for room ${roomId}, events tagged`);
        res.json({ success: true, sessionId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions', optionalAuth, async (req, res) => {
    try {
        const roomId = req.query.roomId;
        if (roomId) {
            const access = await canAccessRoom(req, roomId);
            if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });
        }
        const sessions = await manager.getSessions(roomId);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions/:id', optionalAuth, async (req, res) => {
    try {
        const data = await manager.getSession(req.params.id);
        if (data) {
            // Check room access via session's room_id
            const access = await canAccessRoom(req, data.roomId);
            if (!access.allowed) return res.status(403).json({ error: '无权访问' });
            res.json(data);
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// History API
app.get('/api/history', optionalAuth, async (req, res) => {
    try {
        const roomId = req.query.roomId;
        if (roomId) {
            const access = await canAccessRoom(req, roomId);
            if (!access.allowed) return res.status(403).json({ error: '无权访问此房间' });
        }
        const stats = await manager.getTimeStats(roomId);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// User Analysis API
app.get('/api/analysis/users', optionalAuth, async (req, res) => {
    try {
        const filters = {
            lang: req.query.lang || '',
            languageFilter: req.query.languageFilter || '',
            minRooms: parseInt(req.query.minRooms) || 1,
            activeHour: req.query.activeHour !== undefined ? req.query.activeHour : null,
            activeHourEnd: req.query.activeHourEnd !== undefined ? req.query.activeHourEnd : null,
            search: req.query.search || '',
            searchExact: req.query.searchExact === 'true',
            giftPreference: req.query.giftPreference || ''
        };
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const roomFilter = await getUserRoomFilter(req);
        if (roomFilter) filters.roomFilter = roomFilter;
        console.log(`[API] /api/analysis/users - user: ${req.user?.username || 'anonymous'}, role: ${req.user?.role || 'none'}, roomFilter: ${roomFilter === null ? 'null(admin)' : JSON.stringify(roomFilter)}`);
        const result = await manager.getTopGifters(page, pageSize, filters);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analysis/user/:userId', optionalAuth, async (req, res) => {
    try {
        // This shows a TikTok user's analysis; access requires login
        if (!req.user) return res.status(401).json({ error: '请先登录' });
        const roomFilter = await getUserRoomFilter(req);
        const data = await manager.getUserAnalysis(req.params.userId, roomFilter);

        const response = serializeUserAnalysisDetail(data);
        if (req.user.role !== 'admin') {
            const memberAnalysis = await getLatestMemberAnalysis(req.user.id, req.params.userId);
            response.aiAnalysis = memberAnalysis?.result || null;
        }

        res.json(response);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export API - fetch user list with full details for export
app.get('/api/analysis/users/export', optionalAuth, async (req, res) => {
    try {
        // Check export permission: admin or paid plan with export feature
        if (!req.user) return res.status(401).json({ error: '请先登录' });
        if (req.user.role !== 'admin') {
            const sub = await db.get(
                `SELECT sp.feature_flags FROM user_subscriptions us
                 JOIN subscription_plans sp ON us.plan_id = sp.id
                 WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
                 ORDER BY us.end_date DESC LIMIT 1`,
                [req.user.id]
            );
            const flags = sub?.featureFlags || {};
            if (!flags.export) {
                return res.status(403).json({ error: '数据导出为付费功能，请升级套餐后使用', code: 'EXPORT_NOT_ALLOWED' });
            }
        }
        const filters = {
            lang: req.query.lang || '',
            languageFilter: req.query.languageFilter || '',
            minRooms: parseInt(req.query.minRooms) || 1,
            activeHour: req.query.activeHour !== undefined ? req.query.activeHour : null,
            activeHourEnd: req.query.activeHourEnd !== undefined ? req.query.activeHourEnd : null,
            search: req.query.search || '',
            giftPreference: req.query.giftPreference || ''
        };
        const limit = parseInt(req.query.limit) || 1000;
        const roomFilter = await getUserRoomFilter(req);
        if (roomFilter) filters.roomFilter = roomFilter;

        // Get user list first
        const result = await manager.getTopGifters(1, limit, filters);
        const memberAnalysisMap = req.user.role === 'admin'
            ? new Map()
            : await getLatestMemberAnalysisMap(req.user.id, result.users.map(user => user.userId));

        // Fetch details for each user
        const usersWithDetails = [];
        for (const user of result.users) {
            const details = await manager.getUserAnalysis(user.userId, roomFilter);
            const aiAnalysis = req.user.role === 'admin'
                ? (details.aiAnalysis || null)
                : (memberAnalysisMap.get(user.userId)?.result || null);

            usersWithDetails.push({
                ...user,
                ...details,
                aiAnalysis,
                // Format top gifts
                topGiftsText: (user.topGifts || []).map(g => `${g.giftName || g.giftId}(${g.totalValue})`).join(', '),
                roseValue: user.roseValue || 0,
                tiktokValue: user.tiktokValue || 0,
                // Format rooms
                giftRoomsText: (details.giftRooms || []).slice(0, 5).map(r => `${r.name || r.roomId}(${r.val})`).join(', '),
                visitRoomsText: (details.visitRooms || []).slice(0, 5).map(r => `${r.name || r.roomId}(${r.cnt}次)`).join(', '),
                // Format time distribution
                peakHours: formatPeakHours(details.hourStats),
                peakDays: formatPeakDays(details.dayStats)
            });
        }

        res.json({ users: usersWithDetails, total: result.total });
    } catch (err) {
        console.error('[Export API Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper functions for export
function formatPeakHours(hourStats) {
    if (!hourStats || hourStats.length === 0) return '';
    const sorted = [...hourStats].sort((a, b) => (b.cnt || 0) - (a.cnt || 0));
    return sorted.slice(0, 3).map(h => `${h.hour}时`).join(', ');
}

function formatPeakDays(dayStats) {
    if (!dayStats || dayStats.length === 0) return '';
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const sorted = [...dayStats].sort((a, b) => (b.cnt || 0) - (a.cnt || 0));
    return sorted.slice(0, 3).map(d => dayNames[parseInt(d.day)] || '').join(', ');
}

function serializeUserAnalysisDetail(data = {}) {
    return {
        totalValue: data.totalValue || 0,
        activeDays: data.activeDays || 0,
        dailyAvg: data.dailyAvg || 0,
        giftRooms: Array.isArray(data.giftRooms) ? data.giftRooms : [],
        visitRooms: Array.isArray(data.visitRooms) ? data.visitRooms : [],
        hourStats: Array.isArray(data.hourStats) ? data.hourStats : [],
        dayStats: Array.isArray(data.dayStats) ? data.dayStats : [],
        isAdmin: data.isAdmin || 0,
        isSuperAdmin: data.isSuperAdmin || 0,
        isModerator: data.isModerator || 0,
        fanLevel: data.fanLevel || 0,
        fanClubName: data.fanClubName || '',
        commonLanguage: data.commonLanguage || '',
        masteredLanguages: data.masteredLanguages || '',
        region: data.region || '',
        aiAnalysis: data.aiAnalysis || null,
        moderatorRooms: Array.isArray(data.moderatorRooms) ? data.moderatorRooms : []
    };
}

async function getLatestMemberAnalysis(memberId, targetUserId) {
    if (!memberId || !targetUserId) return null;

    return await db.get(
        `SELECT result, chat_count, created_at, model_name, latency_ms, source
         FROM user_ai_analysis
         WHERE member_id = ? AND target_user_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [memberId, targetUserId]
    );
}

async function getLatestMemberAnalysisMap(memberId, targetUserIds = []) {
    if (!memberId || !Array.isArray(targetUserIds) || targetUserIds.length === 0) {
        return new Map();
    }

    const placeholders = targetUserIds.map(() => '?').join(',');
    const rows = await db.query(
        `SELECT DISTINCT ON (target_user_id) target_user_id, result, chat_count, created_at, model_name, latency_ms, source
         FROM user_ai_analysis
         WHERE member_id = ? AND target_user_id IN (${placeholders})
         ORDER BY target_user_id, created_at DESC`,
        [memberId, ...targetUserIds]
    );

    return new Map(rows.map(row => [row.targetUserId, row]));
}

function getSimulatedAiDelayMs() {
    return 2000 + Math.floor(Math.random() * 2001);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



app.get('/api/analysis/stats', optionalAuth, async (req, res) => {
    try {
        const roomFilter = await getUserRoomFilter(req);
        console.log(`[API] /api/analysis/stats - user: ${req.user?.username || 'anonymous'}, roomFilter: ${roomFilter === null ? 'null(admin)' : JSON.stringify(roomFilter)}`);
        const stats = await manager.getGlobalStats(roomFilter);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analysis/rooms/entry', optionalAuth, async (req, res) => {
    try {
        const { startDate, endDate, limit } = req.query;
        const roomFilter = await getUserRoomFilter(req);
        console.log(`[API] /api/analysis/rooms/entry - user: ${req.user?.username || 'anonymous'}, roomFilter: ${roomFilter === null ? 'null(admin)' : JSON.stringify(roomFilter)}`);
        const stats = await manager.getRoomEntryStats(startDate, endDate, limit, roomFilter);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/analysis/ai', optionalAuth, async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: '请先登录' });

        const { userId, force = false } = req.body;
        const memberId = req.user.id;
        const isAdmin = req.user?.role === 'admin';
        const roomFilter = await getUserRoomFilter(req);

        // 1. Get chat history and check minimum corpus (10 messages)
        const history = await manager.getUserChatHistory(userId, 200, roomFilter);
        const chatCount = history ? history.length : 0;
        if (chatCount < 10) {
            return res.json({ result: '待分析语料不足（需至少10条弹幕记录）', chatCount, skipped: true });
        }

        // 2. For non-admin members: check if already in their personal analysis table
        if (!force && !isAdmin) {
            const memberCache = await getLatestMemberAnalysis(memberId, userId);
            if (memberCache) {
                return res.json({ result: memberCache.result, cached: true, chatCount: memberCache.chatCount, analyzedAt: memberCache.createdAt, source: 'member_cache' });
            }
        }

        // 3. Check system-level cache ("user".ai_analysis) - within 3 months
        let systemAnalysis = null;
        if (!force) {
            systemAnalysis = await db.get(
                `SELECT ai_analysis, updated_at FROM "user" WHERE user_id = ? AND ai_analysis IS NOT NULL AND ai_analysis != ''`,
                [userId]
            );
            if (systemAnalysis && systemAnalysis.aiAnalysis) {
                const updatedAt = new Date(systemAnalysis.updatedAt);
                const threeMonthsAgo = new Date();
                threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

                if (updatedAt > threeMonthsAgo) {
                    // System cache is fresh — use it, write to member table, and charge
                    if (!isAdmin) {
                        // Check credits before charging
                        const credits = await db.get('SELECT ai_credits_remaining FROM users WHERE id = ?', [memberId]);
                        const remaining = Number(credits?.aiCreditsRemaining || 0);
                        if (remaining <= 0) {
                            return res.status(403).json({ error: 'AI 点数不足，请购买点数包或升级套餐', code: 'AI_CREDITS_EXHAUSTED' });
                        }

                        const simulatedLatency = getSimulatedAiDelayMs();
                        await sleep(simulatedLatency);

                        // Write to member table
                        await db.run(
                            `INSERT INTO user_ai_analysis (member_id, target_user_id, result, chat_count, model_name, latency_ms, source)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [memberId, userId, systemAnalysis.aiAnalysis, chatCount, 'system_cache', simulatedLatency, 'system_cache']
                        );
                        // Deduct credit
                        await db.run('UPDATE users SET ai_credits_remaining = GREATEST(ai_credits_remaining - 1, 0), ai_credits_used = ai_credits_used + 1 WHERE id = ?', [memberId]);
                        await db.run('INSERT INTO ai_usage_log (user_id, usage_type, credits_used, target_id) VALUES (?, ?, 1, ?)', [memberId, 'analysis', userId]);

                        console.log(`[AI] Reused system cache for member ${memberId}, target ${userId}, simulated ${simulatedLatency}ms`);
                        return res.json({ result: systemAnalysis.aiAnalysis, cached: false, chatCount, latency: simulatedLatency, source: 'api' });
                    }
                    console.log(`[AI] Using system cache for ${userId} (updated ${updatedAt.toISOString()})`);
                    return res.json({ result: systemAnalysis.aiAnalysis, cached: true, chatCount, analyzedAt: systemAnalysis.updatedAt, source: 'system_cache' });
                }
            }
        }

        // 4. Need fresh AI analysis — check credits for non-admin
        if (!isAdmin) {
            const credits = await db.get('SELECT ai_credits_remaining FROM users WHERE id = ?', [memberId]);
            const remaining = Number(credits?.aiCreditsRemaining || 0);
            if (remaining <= 0) {
                return res.status(403).json({ error: 'AI 点数不足，请购买点数包或升级套餐', code: 'AI_CREDITS_EXHAUSTED' });
            }
        }

        // 5. Get AI model config
        let apiKey, modelName, apiUrl, aiModelId;
        const aiModel = await db.get(
            `SELECT m.id, m.model_id, m.name AS model_name, c.api_url, c.api_key
             FROM ai_models m JOIN ai_channels c ON m.channel_id = c.id
             WHERE m.is_active = true AND c.is_active = true
             ORDER BY m.is_default DESC, m.id ASC LIMIT 1`
        );
        if (aiModel) {
            apiKey = aiModel.apiKey;
            modelName = aiModel.modelId;
            apiUrl = aiModel.apiUrl;
            aiModelId = aiModel.id;
        } else {
            const dbSettings = await manager.getAllSettings();
            apiKey = dbSettings.ai_api_key || process.env.AI_API_KEY;
            modelName = dbSettings.ai_model_name || process.env.AI_MODEL_NAME || 'deepseek-ai/DeepSeek-V3.2';
            apiUrl = dbSettings.ai_api_url || process.env.AI_API_URL || 'https://api-inference.modelscope.cn/v1/';
        }

        if (!apiKey) {
            return res.status(500).json({ error: 'AI API Key not configured' });
        }

        // 6. Call AI API
        const chatText = history.map(h => h.comment).join('\n');
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        console.log(`[AI] Requesting analysis for ${userId}, ${chatCount} messages, model ${modelName}`);
        const aiStartTime = Date.now();
        const aiBaseUrl = apiUrl.endsWith('/') ? apiUrl : apiUrl + '/';
        const response = await fetch(`${aiBaseUrl}chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: modelName,
                messages: [
                    { role: 'system', content: '你是一个数十年经验的专业娱乐主播运营总监，并且你的情商非常高。请根据用户的弹幕历史，简要分析该用户的：1、常用语种 2、掌握语种 3、感兴趣的话题 4、 聊天风格。请用简洁的中文回答。5、建议破冰方式。请用简洁的中文回答。' },
                    { role: 'user', content: `用户弹幕记录：\n${chatText}` }
                ],
                stream: false
            })
        });
        const aiLatency = Date.now() - aiStartTime;

        if (!response.ok) {
            const err = await response.text();
            if (aiModelId) {
                await db.run(
                    `UPDATE ai_models SET call_count = call_count + 1, fail_count = fail_count + 1, last_status = 'error', last_error = ?, last_used_at = NOW(), updated_at = NOW() WHERE id = ?`,
                    [`HTTP ${response.status}: ${err.slice(0, 200)}`, aiModelId]
                );
            }
            throw new Error(`AI API Error: ${err}`);
        }

        const completion = await response.json();
        const result = completion.choices?.[0]?.message?.content || '无法获取分析结果';

        // 7. Track AI model success
        if (aiModelId) {
            await db.run(
                `UPDATE ai_models SET call_count = call_count + 1, success_count = success_count + 1, last_status = 'ok', last_error = NULL, last_used_at = NOW(), avg_latency_ms = ?, updated_at = NOW() WHERE id = ?`,
                [aiLatency, aiModelId]
            );
        }

        // 8. Save to system-level user table when missing, or always refresh for admin
        let shouldPersistSystemAnalysis = isAdmin;
        if (!isAdmin) {
            if (!systemAnalysis) {
                systemAnalysis = await db.get(
                    `SELECT ai_analysis FROM "user" WHERE user_id = ? AND ai_analysis IS NOT NULL AND ai_analysis != ''`,
                    [userId]
                );
            }
            shouldPersistSystemAnalysis = !systemAnalysis?.aiAnalysis;
        }
        if (shouldPersistSystemAnalysis) {
            await manager.updateAIAnalysis(userId, result);
        }

        // 9. Save to member's personal table & deduct credits
        if (!isAdmin) {
            await db.run(
                `INSERT INTO user_ai_analysis (member_id, target_user_id, result, chat_count, model_name, latency_ms, source)
                 VALUES (?, ?, ?, ?, ?, ?, 'api')`,
                [memberId, userId, result, chatCount, modelName, aiLatency]
            );
            await db.run('UPDATE users SET ai_credits_remaining = GREATEST(ai_credits_remaining - 1, 0), ai_credits_used = ai_credits_used + 1 WHERE id = ?', [memberId]);
            await db.run('INSERT INTO ai_usage_log (user_id, usage_type, credits_used, target_id) VALUES (?, ?, 1, ?)', [memberId, 'analysis', userId]);
        }

        res.json({ result, cached: false, chatCount, latency: aiLatency, model: modelName, source: 'api' });

    } catch (err) {
        console.error('[AI] Analysis error:', err);
        res.status(500).json({ error: err.message });
    }
});



app.post('/api/rooms', optionalAuth, async (req, res) => {
    try {
        let { roomId, name, address, isMonitorEnabled, language, priority, isRecordingEnabled, recordingAccountId } = req.body;

        // Normalize roomId: remove @ prefix to prevent duplicates (e.g. @blooming1881 vs blooming1881)
        if (roomId && roomId.startsWith('@')) {
            roomId = roomId.substring(1);
            console.log(`[API] Normalized roomId by removing @ prefix: ${roomId}`);
        }

        if (!roomId) return res.status(400).json({ error: '房间ID不能为空' });

        const isAdmin = req.user && req.user.role === 'admin';

        // ==================== Admin: direct system-level operation ====================
        if (isAdmin) {
            const room = await manager.updateRoom(roomId, name, address, isMonitorEnabled, language, priority, isRecordingEnabled, recordingAccountId);
            console.log(`[API] Admin updated room:`, room);

            // If monitor was just disabled, disconnect immediately
            if (isMonitorEnabled === false || isMonitorEnabled === 0 || isMonitorEnabled === '0') {
                console.log(`[API] Room ${roomId} monitor disabled. Triggering immediate disconnect...`);
                await autoRecorder.disconnectRoom(roomId);
            }

            invalidateRoomListCaches('admin room update');
            return res.json({ success: true, room });
        }

        // ==================== Member: user_room copy logic ====================
        if (!req.user) return res.status(401).json({ error: '请先登录' });

        // Check existing user_room (including soft-deleted)
        const existingCopy = await db.get(
            'SELECT id, deleted_at, first_added_at FROM user_room WHERE user_id = ? AND room_id = ?',
            [req.user.id, roomId]
        );

        // For NEW room (no existing copy, or soft-deleted copy) - check quota + daily limit
        const isNewForUser = !existingCopy || existingCopy.deletedAt;
        if (isNewForUser) {
            const quota = await getUserQuota(req.user.id);
            if (!quota.hasSubscription && quota.limit === 0) {
                return res.status(403).json({
                    error: '您还没有有效的订阅套餐，请前往用户中心购买套餐后再使用',
                    code: 'NO_SUBSCRIPTION',
                    quota
                });
            }
            if (quota.limit !== -1 && quota.remaining <= 0) {
                return res.status(403).json({
                    error: '房间配额已满，请升级套餐或购买扩容包',
                    code: 'QUOTA_EXCEEDED',
                    quota
                });
            }
            // Check open room limit (simultaneously monitored rooms)
            if (quota.openRoomLimit !== -1 && quota.openRemaining <= 0) {
                return res.status(403).json({
                    error: `同时打开的房间数已达上限（${quota.openRoomLimit}个），请关闭其他房间后再试`,
                    code: 'OPEN_ROOM_LIMIT',
                    quota
                });
            }

            if (quota.dailyLimit !== -1 && quota.dailyRemaining <= 0) {
                return res.status(403).json({
                    error: `今日新建房间次数已达上限（${quota.dailyLimit}次/天），请明天再试`,
                    code: 'DAILY_LIMIT_EXCEEDED',
                    dailyLimit: quota.dailyLimit,
                    createdToday: quota.dailyUsed,
                    quota
                });
            }
        }

        // Ensure system-level room record exists (INSERT only, never update existing)
        const existingRoom = await db.get('SELECT room_id FROM room WHERE room_id = ?', [roomId]);
        if (!existingRoom) {
            // New room created by user - mark user_id, enable monitoring
            await db.run(
                `INSERT INTO room (room_id, name, is_monitor_enabled, user_id, updated_at) VALUES (?, ?, 1, ?, NOW())`,
                [roomId, roomId, req.user.id]
            );
            console.log(`[API] User ${req.user.id} created new system room: ${roomId}`);
        } else {
            // Room exists but might have monitoring disabled (was orphaned before)
            // Re-enable monitoring when a user adds it
            await db.run('UPDATE room SET is_monitor_enabled = 1, updated_at = NOW() WHERE room_id = ? AND is_monitor_enabled = 0', [roomId]);
        }

        // Upsert user_room copy
        const alias = name || null;
        if (existingCopy && existingCopy.deletedAt) {
            // Restoring a soft-deleted copy
            // Check if first_added_at is within 7 days - if so, keep it; otherwise reset
            const firstAdded = existingCopy.firstAddedAt ? new Date(existingCopy.firstAddedAt) : null;
            const daysSinceFirst = firstAdded ? (Date.now() - firstAdded.getTime()) / (1000 * 60 * 60 * 24) : 999;
            const newFirstAdded = daysSinceFirst <= 7 ? existingCopy.firstAddedAt : new Date();

            await db.run(
                `UPDATE user_room SET alias = ?, deleted_at = NULL, is_enabled = true, first_added_at = ?, updated_at = NOW() WHERE id = ?`,
                [alias, newFirstAdded, existingCopy.id]
            );
            console.log(`[API] User ${req.user.id} restored room copy: ${roomId} (data from ${daysSinceFirst <= 7 ? 'previous' : 'now'})`);
        } else if (existingCopy) {
            // Update existing active copy (user editing alias)
            await db.run(
                'UPDATE user_room SET alias = ?, updated_at = NOW() WHERE id = ?',
                [alias, existingCopy.id]
            );
            console.log(`[API] User ${req.user.id} updated room alias: ${roomId} -> ${alias}`);
        } else {
            // Brand new copy
            await db.run(
                'INSERT INTO user_room (user_id, room_id, alias, first_added_at) VALUES (?, ?, ?, NOW())',
                [req.user.id, roomId, alias]
            );
            console.log(`[API] User ${req.user.id} added new room copy: ${roomId}`);
        }

        invalidateRoomListCaches('member room upsert');
        res.json({ success: true, room: { room_id: roomId, name: alias || roomId } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rename room (Migrate ID)
app.post('/api/rooms/:id/rename', optionalAuth, async (req, res) => {
    try {
        const roomId = req.params.id;
        const { newRoomId } = req.body;
        if (!newRoomId) return res.status(400).json({ error: 'New Room ID is required' });

        // Check ownership
        const accessCheck = await canAccessRoom(req, roomId);
        if (!accessCheck.allowed) {
            return res.status(403).json({ error: '无权访问此房间' });
        }

        await manager.migrateRoomId(roomId, newRoomId);
        invalidateRoomListCaches('room rename');
        res.json({ success: true, oldRoomId: roomId, newRoomId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/rooms/:id/stop', authenticate, requireAdmin, async (req, res) => {
    try {
        const roomId = req.params.id;
        // Stop monitoring
        const result = await autoRecorder.disconnectRoom(roomId);
        // Stop recording if active
        if (recordingManager.isRecording(roomId)) {
            await recordingManager.stopRecording(roomId);
        }
        invalidateRoomListCaches('room stop');
        res.json({ success: true, stopped: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recording API
app.post('/api/rooms/:id/recording/start', async (req, res) => {
    try {
        const roomIdFromUrl = req.params.id;
        let { roomId, uniqueId, accountId } = req.body;

        // Use URL param if body doesn't have roomId
        roomId = roomId || roomIdFromUrl;

        // If uniqueId not provided, look it up from the room record
        if (!uniqueId) {
            const room = await manager.getRoom(roomId);
            console.log(`[Recording API] Looking up room ${roomId}:`, room);
            if (room) {
                // Database returns snake_case column names
                uniqueId = room.room_id;
                console.log(`[Recording API] Resolved uniqueId: ${uniqueId}`);
            }
        }

        if (!uniqueId) {
            return res.status(400).json({ success: false, error: 'uniqueId is required' });
        }

        const result = await recordingManager.startRecording(roomId, uniqueId, accountId || null);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/rooms/:id/recording/stop', async (req, res) => {
    try {
        const roomId = req.params.id;
        const result = await recordingManager.stopRecording(roomId);
        res.json({ success: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:id/recording/status', (req, res) => {
    const roomId = req.params.id;
    res.json({ isRecording: recordingManager.isRecording(roomId) });
});

app.get('/api/recordings/active', (req, res) => {
    // Return array of roomIds
    const activeRooms = Array.from(recordingManager.activeRecordings.keys());
    res.json(activeRooms);
});

// Recording Task Management API
app.get('/api/recording_tasks', async (req, res) => {
    try {
        const db = require('./db');
        const { roomId, status, dateFrom, dateTo, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = [];
        let params = [];
        let paramNum = 1;

        if (roomId) {
            whereClause.push(`room_id = $${paramNum++}`);
            params.push(roomId);
        }
        if (status) {
            whereClause.push(`status = $${paramNum++}`);
            params.push(status);
        }
        if (dateFrom) {
            whereClause.push(`start_time >= $${paramNum++}`);
            params.push(dateFrom);
        }
        if (dateTo) {
            whereClause.push(`start_time <= $${paramNum++}`);
            params.push(dateTo + ' 23:59:59');
        }

        const whereStr = whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : '';

        // Get total count
        const countResult = await db.get(`SELECT COUNT(*) as total FROM recording_task ${whereStr}`, params);
        const total = parseInt(countResult.total);

        // Get paginated results
        params.push(parseInt(limit));
        params.push(offset);
        const tasks = await db.query(`
            SELECT * FROM recording_task 
            ${whereStr}
            ORDER BY start_time DESC
            LIMIT $${paramNum++} OFFSET $${paramNum}
        `, params);

        res.json({
            tasks,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('[API] Error fetching recording tasks:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get rooms with recording history (for dropdown)
app.get('/api/recording_tasks/rooms', async (req, res) => {
    try {
        const db = require('./db');
        const rooms = await db.query(`
            SELECT room_id, COUNT(*) as task_count, MAX(start_time) as last_recorded
            FROM recording_task
            GROUP BY room_id
            ORDER BY last_recorded DESC
        `);
        res.json(rooms);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get single task detail
app.get('/api/recording_tasks/:id', async (req, res) => {
    try {
        const db = require('./db');
        const task = await db.get('SELECT * FROM recording_task WHERE id = $1', [req.params.id]);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }
        res.json(task);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete recording task
app.delete('/api/recording_tasks/:id', async (req, res) => {
    try {
        const db = require('./db');
        const { deleteFile } = req.query;
        const task = await db.get('SELECT * FROM recording_task WHERE id = $1', [req.params.id]);

        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Optionally delete the file
        if (deleteFile === 'true' && task.file_path) {
            const fs = require('fs');
            if (fs.existsSync(task.file_path)) {
                fs.unlinkSync(task.file_path);
                console.log(`[Recorder] Deleted file: ${task.file_path}`);
            }
        }

        await db.run('DELETE FROM recording_task WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download recording file
app.get('/api/recording_tasks/:id/download', async (req, res) => {
    try {
        const db = require('./db');
        const task = await db.get('SELECT * FROM recording_task WHERE id = $1', [req.params.id]);
        if (!task || !task.filePath) {
            return res.status(404).json({ error: 'File not found' });
        }

        const fs = require('fs');
        const path = require('path');

        if (!fs.existsSync(task.filePath)) {
            return res.status(404).json({ error: 'File does not exist on disk' });
        }

        const fileName = path.basename(task.filePath);
        res.download(task.filePath, fileName);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// ============= Highlight Clip API =============
const highlightExtractor = require('./highlight_extractor');

// Analyze recording for potential highlights (preview)
app.get('/api/recording_tasks/:id/highlights/analyze', async (req, res) => {
    try {
        const options = {
            minDiamonds: parseInt(req.query.minDiamonds) || highlightExtractor.DEFAULT_MIN_DIAMONDS,
            bufferBefore: parseInt(req.query.bufferBefore) || highlightExtractor.DEFAULT_BUFFER_BEFORE,
            bufferAfter: parseInt(req.query.bufferAfter) || highlightExtractor.DEFAULT_BUFFER_AFTER,
            mergeWindow: parseInt(req.query.mergeWindow) || highlightExtractor.DEFAULT_MERGE_WINDOW
        };

        const segments = await highlightExtractor.analyzeRecordingForHighlights(
            parseInt(req.params.id),
            options
        );

        res.json({
            success: true,
            segments,
            options,
            count: segments.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start highlight extraction
app.post('/api/recording_tasks/:id/highlights/extract', async (req, res) => {
    try {
        const options = {
            minDiamonds: parseInt(req.body.minDiamonds) || highlightExtractor.DEFAULT_MIN_DIAMONDS,
            bufferBefore: parseInt(req.body.bufferBefore) || highlightExtractor.DEFAULT_BUFFER_BEFORE,
            bufferAfter: parseInt(req.body.bufferAfter) || highlightExtractor.DEFAULT_BUFFER_AFTER,
            mergeWindow: parseInt(req.body.mergeWindow) || highlightExtractor.DEFAULT_MERGE_WINDOW
        };

        const results = await highlightExtractor.extractAllHighlights(
            parseInt(req.params.id),
            options
        );

        res.json({
            success: true,
            results,
            extracted: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get highlight clips for a recording
app.get('/api/recording_tasks/:id/highlights', async (req, res) => {
    try {
        const clips = await highlightExtractor.getHighlightClips(parseInt(req.params.id));
        res.json({ success: true, clips });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download a highlight clip
app.get('/api/highlight_clips/:id/download', async (req, res) => {
    try {
        const db = require('./db');
        const clip = await db.get('SELECT * FROM highlight_clip WHERE id = $1', [req.params.id]);

        if (!clip || !clip.filePath) {
            return res.status(404).json({ error: 'Clip not found' });
        }

        const fs = require('fs');
        const path = require('path');

        if (!fs.existsSync(clip.filePath)) {
            return res.status(404).json({ error: 'Clip file does not exist on disk' });
        }

        const fileName = path.basename(clip.filePath);
        res.download(clip.filePath, fileName);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a highlight clip
app.delete('/api/highlight_clips/:id', async (req, res) => {
    try {
        const deleteFile = req.query.deleteFile !== 'false';
        await highlightExtractor.deleteHighlightClip(parseInt(req.params.id), deleteFile);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// TikTok Account API
app.get('/api/tiktok_accounts', async (req, res) => {
    try {
        const accounts = await manager.getTikTokAccounts();
        res.json({ accounts });
    } catch (err) {
        // Fallback if manager method not exists yet
        try {
            const db = require('./db');
            const accounts = await db.query('SELECT * FROM tiktok_account ORDER BY id DESC');
            res.json({ accounts });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }
});

app.post('/api/tiktok_accounts', async (req, res) => {
    try {
        const { username, cookie, proxyId, isActive } = req.body;
        const db = require('./db');
        await db.run('INSERT INTO tiktok_account (username, cookie, proxy_id, is_active) VALUES ($1, $2, $3, $4)',
            [username, cookie, proxyId, isActive]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tiktok_accounts/:id', async (req, res) => {
    try {
        const db = require('./db');
        await db.run('DELETE FROM tiktok_account WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tiktok_accounts/:id', async (req, res) => {
    try {
        const db = require('./db');
        const { username, cookie, proxyId, isActive } = req.body;
        console.log(`[API] PUT /api/tiktok_accounts/${req.params.id}`, req.body);

        // Build dynamic update query
        const updates = [];
        const params = [];
        let paramNum = 1;

        if (username !== undefined) { updates.push(`username = $${paramNum++}`); params.push(username); }
        if (cookie !== undefined) { updates.push(`cookie = $${paramNum++}`); params.push(cookie); }
        if (proxyId !== undefined) { updates.push(`proxy_id = $${paramNum++}`); params.push(proxyId); }
        if (isActive !== undefined) { updates.push(`is_active = $${paramNum++}`); params.push(isActive); }

        if (updates.length > 0) {
            updates.push(`updated_at = NOW()`);
            const query = `UPDATE tiktok_account SET ${updates.join(', ')} WHERE id = $${paramNum} RETURNING *`;
            params.push(req.params.id);
            console.log(`[API] Executing update: ${query} params:`, params);
            // Use pool.query directly to get rowCount and rows
            const result = await db.pool.query(query, params);

            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Account not found' });
            }
            const updatedAccount = result.rows[0];
            res.json(updatedAccount);
        } else {
            res.status(400).json({ error: 'No fields to update' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Socks5 Proxy API
app.get('/api/socks5_proxies', async (req, res) => {
    try {
        const db = require('./db');
        const proxies = await db.query('SELECT * FROM socks5_proxy ORDER BY id DESC');
        res.json(proxies);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/socks5_proxies', async (req, res) => {
    try {
        const { name, host, port, username, password, isActive } = req.body;
        const db = require('./db');
        await db.run('INSERT INTO socks5_proxy (name, host, port, username, password, is_active) VALUES ($1, $2, $3, $4, $5, $6)',
            [name, host, port, username, password, isActive]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/socks5_proxies/:id', async (req, res) => {
    try {
        const db = require('./db');
        await db.run('DELETE FROM socks5_proxy WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/socks5_proxies/:id', async (req, res) => {
    try {
        const db = require('./db');
        const { name, host, port, username, password, isActive } = req.body;

        // Build dynamic update query
        const updates = [];
        const params = [];
        let paramNum = 1;

        if (name !== undefined) { updates.push(`name = $${paramNum++}`); params.push(name); }
        if (host !== undefined) { updates.push(`host = $${paramNum++}`); params.push(host); }
        if (port !== undefined) { updates.push(`port = $${paramNum++}`); params.push(port); }
        if (username !== undefined) { updates.push(`username = $${paramNum++}`); params.push(username); }
        if (password !== undefined) { updates.push(`password = $${paramNum++}`); params.push(password); }
        if (isActive !== undefined) { updates.push(`is_active = $${paramNum++}`); params.push(isActive); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(req.params.id);
        await db.run(`UPDATE socks5_proxy SET ${updates.join(', ')} WHERE id = $${paramNum}`, params);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/socks5_proxies/:id/test', async (req, res) => {
    try {
        const db = require('./db');
        const { SocksProxyAgent } = require('socks-proxy-agent');
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        const proxy = await db.get('SELECT * FROM socks5_proxy WHERE id = $1', [req.params.id]);
        if (!proxy) {
            return res.status(404).json({ error: 'Proxy not found' });
        }

        const proxyUrl = `socks5://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
        const agent = new SocksProxyAgent(proxyUrl, {
            rejectUnauthorized: false,
            timeout: 15000,
            keepAlive: true
        });

        // Allow custom test URL (for CDN testing)
        const testUrl = req.body.testUrl || 'https://pull-f5-sg01.tiktokcdn.com/';
        console.log(`[ProxyTest] Testing ${proxy.host}:${proxy.port} -> ${testUrl}`);

        const start = Date.now();
        const response = await fetch(testUrl, {
            agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 20000
        });

        const duration = Date.now() - start;
        console.log(`[ProxyTest] Result: ${response.status} in ${duration}ms`);

        if (response.ok || response.status < 500) {
            res.json({ success: true, duration, status: response.status, testedUrl: testUrl });
        } else {
            res.json({ success: false, error: `HTTP ${response.status}`, duration, testedUrl: testUrl });
        }
    } catch (err) {
        console.error(`[ProxyTest] Failed: ${err.message}`);
        res.json({ success: false, error: err.message });
    }
});


// Debug API - Force clear a stale connection (for testing)
app.delete('/api/debug/connections/:id', async (req, res) => {
    const roomId = req.params.id;
    console.log(`[Debug] Force clearing connection for ${roomId}`);
    const result = await autoRecorder.disconnectRoom(roomId);
    res.json({ cleared: true, roomId, result });
});

// Migrate events from numeric room_id to username room_id
app.post('/api/migrate-events', async (req, res) => {
    try {
        await manager.migrateEventRoomIds();
        res.json({ success: true, message: 'Events migrated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fix orphaned events - create sessions for events without session_id
app.post('/api/fix-orphaned-events', async (req, res) => {
    try {
        const result = await manager.fixOrphanedEvents();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete empty sessions (sessions with 0 events)
app.post('/api/delete-empty-sessions', async (req, res) => {
    try {
        const result = await manager.deleteEmptySessions();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rebuild missing session records (for events with session_id but no session record)
app.post('/api/rebuild-missing-sessions', async (req, res) => {
    try {
        const result = await manager.rebuildMissingSessions();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const ENABLE_PERIODIC_STATS_REFRESH = String(process.env.ENABLE_PERIODIC_STATS_REFRESH || 'false').toLowerCase() === 'true';
const ENABLE_STARTUP_STATS_WARMUP = String(process.env.ENABLE_STARTUP_STATS_WARMUP || 'false').toLowerCase() === 'true';
let isRoomStatsRefreshRunning = false;
let isUserStatsRefreshRunning = false;

async function runRoomStatsRefreshJob(trigger = 'manual') {
    if (isRoomStatsRefreshRunning) {
        console.log(`[CRON] Skip room stats refresh (${trigger}) because a previous run is still active`);
        return { skipped: true, trigger };
    }
    isRoomStatsRefreshRunning = true;
    try {
        console.log(`[CRON] Running room stats refresh (${trigger})...`);
        return await manager.refreshRoomStats();
    } finally {
        isRoomStatsRefreshRunning = false;
    }
}

async function runUserStatsRefreshJob(trigger = 'manual') {
    if (isUserStatsRefreshRunning) {
        console.log(`[CRON] Skip user stats refresh (${trigger}) because a previous run is still active`);
        return { skipped: true, trigger };
    }
    isUserStatsRefreshRunning = true;
    try {
        console.log(`[CRON] Running user stats refresh (${trigger})...`);
        return await manager.refreshUserStats();
    } finally {
        isUserStatsRefreshRunning = false;
    }
}

// Manually refresh room_stats cache (for immediate update after changes)
app.post('/api/maintenance/refresh_room_stats', async (req, res) => {
    try {
        const result = await runRoomStatsRefreshJob('manual-api');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually refresh user_stats cache (for immediate update after changes)
app.post('/api/maintenance/refresh_user_stats', async (req, res) => {
    try {
        const result = await runUserStatsRefreshJob('manual-api');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
const PORT = process.env.PORT || 8081;
httpServer.listen(PORT, async () => {
    console.log(`Server started on http://localhost:${PORT}`);

    // Cleanup orphaned recording tasks from previous session (crashed or force-closed)
    await recordingManager.cleanupOrphanedTasks();

    // Start user management periodic tasks (subscription expiry, token cleanup)
    startPeriodicTasks();

    // Scheduled jobs
    // Run user language analysis every hour
    setInterval(async () => {
        try {
            console.log('[CRON] Running hourly user language analysis...');
            await manager.analyzeUserLanguages(2000);
        } catch (err) {
            console.error('[CRON] Language analysis error:', err.message);
        }
    }, 60 * 60 * 1000); // Every hour

    // Run session consolidation every hour
    setInterval(async () => {
        try {
            console.log('[CRON] Running hourly session consolidation...');
            await manager.consolidateRecentSessions(48, 60);
        } catch (err) {
            console.error('[CRON] Session consolidation error:', err.message);
        }
    }, 60 * 60 * 1000); // Every hour

    if (ENABLE_PERIODIC_STATS_REFRESH) {
        // Refresh room_stats cache every 30 minutes (for fast API responses)
        setInterval(async () => {
            try {
                await runRoomStatsRefreshJob('interval');
            } catch (err) {
                console.error('[CRON] Room stats refresh error:', err.message);
            }
        }, 30 * 60 * 1000); // Every 30 minutes

        // Refresh user_stats cache every 30 minutes (for fast user analysis API)
        setInterval(async () => {
            try {
                await runUserStatsRefreshJob('interval');
            } catch (err) {
                console.error('[CRON] User stats refresh error:', err.message);
            }
        }, 30 * 60 * 1000); // Every 30 minutes
    } else {
        console.log('[CRON] Periodic room_stats/user_stats refresh disabled in web process');
    }

    // Run initial tasks after startup
    setTimeout(async () => {
        try {
            console.log('[CRON] Running initial user language analysis...');
            await manager.analyzeUserLanguages(2000);
        } catch (err) {
            console.error('[CRON] Initial language analysis error:', err.message);
        }
    }, 30000); // 30 seconds after startup

    if (ENABLE_STARTUP_STATS_WARMUP) {
        // Refresh room stats on startup (for API performance)
        setTimeout(async () => {
            try {
                await runRoomStatsRefreshJob('startup');
            } catch (err) {
                console.error('[CRON] Initial room stats refresh error:', err.message);
            }
        }, 10000); // 10 seconds after startup

        // Refresh user stats on startup (for API performance)
        setTimeout(async () => {
            try {
                await runUserStatsRefreshJob('startup');
            } catch (err) {
                console.error('[CRON] Initial user stats refresh error:', err.message);
            }
        }, 15000); // 15 seconds after startup
    } else {
        console.log('[CRON] Startup room_stats/user_stats warmup disabled in web process');
    }

    // Refresh global stats on startup (for /api/analysis/stats performance)
    setTimeout(async () => {
        try {
            console.log('[CRON] Initial global stats refresh...');
            await manager.refreshGlobalStats();
        } catch (err) {
            console.error('[CRON] Initial global stats refresh error:', err.message);
        }
    }, 20000); // 20 seconds after startup

    // Refresh global_stats cache every 30 minutes (for fast /api/analysis/stats responses)
    setInterval(async () => {
        try {
            console.log('[CRON] Refreshing global stats cache...');
            await manager.refreshGlobalStats();
        } catch (err) {
            console.error('[CRON] Global stats refresh error:', err.message);
        }
    }, 30 * 60 * 1000); // Every 30 minutes

    // 7-day data retention cleanup - runs every 6 hours
    setInterval(async () => {
        try {
            console.log('[CRON] Running expired room data cleanup (7-day retention)...');
            await manager.cleanupExpiredRoomData();
        } catch (err) {
            console.error('[CRON] Room data cleanup error:', err.message);
        }
    }, 6 * 60 * 60 * 1000); // Every 6 hours

    // Run initial cleanup 60 seconds after startup
    setTimeout(async () => {
        try {
            console.log('[CRON] Initial expired room data cleanup...');
            await manager.cleanupExpiredRoomData();
        } catch (err) {
            console.error('[CRON] Initial room data cleanup error:', err.message);
        }
    }, 60000); // 60 seconds after startup
});

// Graceful shutdown handling - save all active recordings before exit
async function gracefulShutdown(signal) {
    console.log(`\n[Server] Received ${signal}, initiating graceful shutdown...`);

    try {
        // Stop all active recordings and save their state
        await recordingManager.stopAllRecordings();

        // Close HTTP server
        httpServer.close(() => {
            console.log('[Server] HTTP server closed.');
            process.exit(0);
        });

        // Force exit after 10 seconds if server doesn't close
        setTimeout(() => {
            console.warn('[Server] Forcing exit after timeout.');
            process.exit(1);
        }, 10000);

    } catch (err) {
        console.error('[Server] Error during shutdown:', err.message);
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
