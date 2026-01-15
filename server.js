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

const app = express();
const httpServer = createServer(app);

// Start Auto Recorder (Dynamic interval from DB)
const autoRecorder = new AutoRecorder();

// Enable CORS & JSON parsing
// Enable CORS & JSON parsing
app.use(express.json());
app.use(express.static('public')); // Serve static files first for performance

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

// Config API
app.get('/api/config', async (req, res) => {
    try {
        const settings = await manager.getAllSettings();
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Settings API - POST to save settings
app.post('/api/settings', async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Alias: POST /api/config also saves settings
app.post('/api/config', async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
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

app.put('/api/gifts/:id', async (req, res) => {
    try {
        const { nameCn } = req.body;
        await manager.updateGiftChineseName(req.params.id, nameCn);
        res.json({ success: true });
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
app.get('/api/rooms/:id/sessions', async (req, res) => {
    try {
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

// Price API
app.post('/api/price', (req, res) => {
    const { id, price } = req.body;
    manager.savePrice(id, parseFloat(price));
    res.json({ success: true });
});

// Room API
app.get('/api/rooms/stats', async (req, res) => {
    try {
        const liveRoomIds = autoRecorder.getLiveRoomIds();
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const search = req.query.search || '';
        const sort = req.query.sort || 'default';
        const result = await manager.getRoomStats(liveRoomIds, { page, limit, search, sort });
        res.json(result);
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

app.get('/api/rooms', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const search = req.query.search || '';
        const result = await manager.getRooms({ page, limit, search });

        // Merge isLive status from autoRecorder activeConnections
        const liveRoomIds = autoRecorder.getLiveRoomIds();
        result.data = result.data.map(room => ({
            ...room,
            isLive: liveRoomIds.includes(room.roomId)
        }));

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Room Management API
app.post('/api/rooms', async (req, res) => {
    try {
        const { roomId, name, isMonitorEnabled, language, priority } = req.body;
        if (!roomId) return res.status(400).json({ error: 'roomId required' });

        const result = await manager.updateRoom(roomId, name, null, isMonitorEnabled, language, priority);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/rooms/:id', async (req, res) => {
    try {
        const roomId = req.params.id;
        await manager.deleteRoom(roomId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:id/stats_detail', async (req, res) => {
    try {
        const roomId = req.params.id;
        const sessionId = req.query.sessionId || null;

        console.log(`[API] stats_detail request: room=${roomId}, session=${sessionId}`);

        // Get stats
        const data = await manager.getRoomDetailStats(roomId, sessionId);

        console.log(`[API] stats_detail data keys:`, data ? Object.keys(data) : 'null');
        if (data && data.leaderboards) {
            console.log(`[API] leaderboards.gifters count:`, data.leaderboards.gifters?.length || 0);
        }

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
app.get('/api/rooms/:id/alltime-leaderboards', async (req, res) => {
    try {
        const roomId = req.params.id;
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

app.get('/api/sessions', async (req, res) => {
    try {
        const roomId = req.query.roomId;
        const sessions = await manager.getSessions(roomId);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions/:id', async (req, res) => {
    try {
        const data = await manager.getSession(req.params.id);
        if (data) {
            res.json(data);
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// History API
app.get('/api/history', async (req, res) => {
    try {
        const roomId = req.query.roomId;
        const stats = await manager.getTimeStats(roomId);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// User Analysis API
app.get('/api/analysis/users', async (req, res) => {
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
        const result = await manager.getTopGifters(page, pageSize, filters);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analysis/user/:userId', async (req, res) => {
    try {
        const data = await manager.getUserAnalysis(req.params.userId);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export API - fetch user list with full details for export
app.get('/api/analysis/users/export', async (req, res) => {
    try {
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

        // Get user list first
        const result = await manager.getTopGifters(1, limit, filters);

        // Fetch details for each user
        const usersWithDetails = [];
        for (const user of result.users) {
            const details = await manager.getUserAnalysis(user.userId);
            usersWithDetails.push({
                ...user,
                ...details,
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



app.get('/api/analysis/stats', async (req, res) => {
    try {
        const stats = await manager.getGlobalStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/analysis/ai', async (req, res) => {
    try {
        const { userId, force = false } = req.body;

        // Check if analysis already exists
        if (!force) {
            const userAnalysis = await manager.getUserAnalysis(userId);
            if (userAnalysis && userAnalysis.aiAnalysis) {
                console.log(`[AI] Returning cached analysis for ${userId}`);
                return res.json({ result: userAnalysis.aiAnalysis, cached: true });
            }
        }

        // Get user chat history
        const history = await manager.getUserChatHistory(userId, 100);

        if (!history || history.length === 0) {
            console.log(`[AI] User ${userId} has no chat history, skipping analysis`);
            return res.json({ result: "该用户没有足够的弹幕记录进行分析。" });
        }

        const chatText = history.map(h => h.comment).join('\n');

        // Call AI API
        const dbSettings = await manager.getAllSettings();
        const apiKey = dbSettings.ai_api_key || process.env.AI_API_KEY;
        const modelName = dbSettings.ai_model_name || process.env.AI_MODEL_NAME || 'deepseek-ai/DeepSeek-V3.2';
        const apiUrl = dbSettings.ai_api_url || process.env.AI_API_URL || 'https://api-inference.modelscope.cn/v1/';

        if (!apiKey) {
            return res.status(500).json({ error: "AI API Key not configured" });
        }

        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        console.log(`[AI] Requesting analysis for ${userId}...`);
        const response = await fetch(`${apiUrl}chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [
                    { role: 'system', content: '你是一个数十年经验的专业娱乐主播运营总监，并且你的情商非常高。请根据用户的弹幕历史，简要分析该用户的：1、常用语种 2、掌握语种 3、感兴趣的话题 4、 聊天风格。请用简洁的中文回答。5、建议破冰方式。请用简洁的中文回答。' },
                    { role: 'user', content: `用户弹幕记录：\n${chatText}` }
                ],
                stream: false
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`AI API Error: ${err}`);
        }

        const completion = await response.json();
        const result = completion.choices?.[0]?.message?.content || "无法获取分析结果";

        // Save full analysis
        await manager.updateAIAnalysis(userId, result);

        // Parse result for languages to update searchable fields
        // let commonLang = '';
        // let masteredLang = '';

        // const commonMatch = result.match(/1、常用语种[：:]?\s*([^\n\r]+)/);
        // if (commonMatch) commonLang = commonMatch[1].replace(/[,，、]/g, ',');

        // const masteredMatch = result.match(/2、掌握语种[：:]?\s*([^\n\r]+)/);
        // if (masteredMatch) masteredLang = masteredMatch[1].replace(/[,，、]/g, ',');

        // if (commonLang || masteredLang) {
        //     await manager.updateUserLanguages(userId, commonLang, masteredLang);
        // }

        res.json({ result: result, cached: false });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});



app.post('/api/rooms', async (req, res) => {
    try {
        let { roomId, name, address, isMonitorEnabled, language, priority } = req.body;

        // Normalize roomId: remove @ prefix to prevent duplicates (e.g. @blooming1881 vs blooming1881)
        if (roomId && roomId.startsWith('@')) {
            roomId = roomId.substring(1);
            console.log(`[API] Normalized roomId by removing @ prefix: ${roomId}`);
        }

        console.log(`[API] POST /api/rooms - roomId: ${roomId}, isMonitorEnabled: ${isMonitorEnabled} (type: ${typeof isMonitorEnabled}), priority: ${priority}`);

        // If isMonitorEnabled is undefined, default to 1 (true) for new rooms, or preserve existing?
        // Manager handles upsert. We should pass what we have.
        // Frontend "saveRoom" sends all fields.
        const room = await manager.updateRoom(roomId, name, address, isMonitorEnabled, language, priority);
        console.log(`[API] Room updated:`, room);

        // If monitor was just disabled, disconnect immediately and save session
        if (isMonitorEnabled === false || isMonitorEnabled === 0 || isMonitorEnabled === '0') {
            console.log(`[API] Room ${roomId} monitor disabled. Triggering immediate disconnect...`);
            await autoRecorder.disconnectRoom(roomId);
        }

        res.json({ success: true, room });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/rooms/:id', async (req, res) => {
    try {
        await manager.deleteRoom(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rooms/:id/stats_detail', async (req, res) => {
    try {
        const roomId = req.params.id;
        const sessionId = req.query.sessionId || null;
        const data = await manager.getRoomDetailStats(roomId, sessionId);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/rooms/:id/stop', async (req, res) => {
    try {
        const roomId = req.params.id;
        const result = await autoRecorder.disconnectRoom(roomId);
        res.json({ success: true, stopped: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Debug API - View all active connections
app.get('/api/debug/connections', (req, res) => {
    const connections = autoRecorder.getLiveRoomIds();
    res.json({ activeConnections: connections });
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

app.get('/api/sessions', async (req, res) => {
    try {
        const roomId = req.query.roomId;
        const sessions = await manager.getSessions(roomId);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually refresh room_stats cache (for immediate update after changes)
app.post('/api/maintenance/refresh_room_stats', async (req, res) => {
    try {
        console.log('[API] Manual room stats refresh requested...');
        const result = await manager.refreshRoomStats();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually refresh user_stats cache (for immediate update after changes)
app.post('/api/maintenance/refresh_user_stats', async (req, res) => {
    try {
        console.log('[API] Manual user stats refresh requested...');
        const result = await manager.refreshUserStats();
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
const PORT = process.env.PORT || 8081;
httpServer.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);

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

    // Refresh room_stats cache every 30 minutes (for fast API responses)
    setInterval(async () => {
        try {
            console.log('[CRON] Refreshing room stats cache...');
            await manager.refreshRoomStats();
        } catch (err) {
            console.error('[CRON] Room stats refresh error:', err.message);
        }
    }, 30 * 60 * 1000); // Every 30 minutes

    // Refresh user_stats cache every 30 minutes (for fast user analysis API)
    setInterval(async () => {
        try {
            console.log('[CRON] Refreshing user stats cache...');
            await manager.refreshUserStats();
        } catch (err) {
            console.error('[CRON] User stats refresh error:', err.message);
        }
    }, 30 * 60 * 1000); // Every 30 minutes

    // Run initial tasks after startup
    setTimeout(async () => {
        try {
            console.log('[CRON] Running initial user language analysis...');
            await manager.analyzeUserLanguages(2000);
        } catch (err) {
            console.error('[CRON] Initial language analysis error:', err.message);
        }
    }, 30000); // 30 seconds after startup

    // Refresh room stats on startup (for API performance)
    setTimeout(async () => {
        try {
            console.log('[CRON] Initial room stats refresh...');
            await manager.refreshRoomStats();
        } catch (err) {
            console.error('[CRON] Initial room stats refresh error:', err.message);
        }
    }, 10000); // 10 seconds after startup

    // Refresh user stats on startup (for API performance)
    setTimeout(async () => {
        try {
            console.log('[CRON] Initial user stats refresh...');
            await manager.refreshUserStats();
        } catch (err) {
            console.error('[CRON] Initial user stats refresh error:', err.message);
        }
    }, 15000); // 15 seconds after startup
});
