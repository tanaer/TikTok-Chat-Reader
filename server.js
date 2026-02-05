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


const app = express();
const httpServer = createServer(app);

// Start Auto Recorder (Dynamic interval from DB)
const autoRecorder = new AutoRecorder();
autoRecorder.setRecordingManager(recordingManager);
recordingManager.startMonitoring(); // Start stall detection for recordings

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

// Settings API - GET to load settings
app.get('/api/settings', async (req, res) => {
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

app.get('/api/analysis/rooms/entry', async (req, res) => {
    try {
        const { startDate, endDate, limit } = req.query;
        const stats = await manager.getRoomEntryStats(startDate, endDate, limit);
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
        let { roomId, name, address, isMonitorEnabled, language, priority, isRecordingEnabled, recordingAccountId } = req.body;


        // Normalize roomId: remove @ prefix to prevent duplicates (e.g. @blooming1881 vs blooming1881)
        if (roomId && roomId.startsWith('@')) {
            roomId = roomId.substring(1);
            console.log(`[API] Normalized roomId by removing @ prefix: ${roomId}`);
        }

        console.log(`[API] POST /api/rooms - roomId: ${roomId}, isMonitorEnabled: ${isMonitorEnabled} (type: ${typeof isMonitorEnabled}), priority: ${priority}`);

        // If isMonitorEnabled is undefined, default to 1 (true) for new rooms, or preserve existing?
        // Manager handles upsert. We should pass what we have.
        // Frontend "saveRoom" sends all fields.
        const room = await manager.updateRoom(roomId, name, address, isMonitorEnabled, language, priority, isRecordingEnabled, recordingAccountId);
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

// Rename room (Migrate ID)
app.post('/api/rooms/:id/rename', async (req, res) => {
    try {
        const { newRoomId } = req.body;
        if (!newRoomId) return res.status(400).json({ error: 'New Room ID is required' });

        await manager.migrateRoomId(req.params.id, newRoomId);
        res.json({ success: true, oldRoomId: req.params.id, newRoomId });
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
        // Stop monitoring
        const result = await autoRecorder.disconnectRoom(roomId);
        // Stop recording if active
        if (recordingManager.isRecording(roomId)) {
            await recordingManager.stopRecording(roomId);
        }
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
httpServer.listen(PORT, async () => {
    console.log(`Server started on http://localhost:${PORT}`);

    // Cleanup orphaned recording tasks from previous session (crashed or force-closed)
    await recordingManager.cleanupOrphanedTasks();

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
