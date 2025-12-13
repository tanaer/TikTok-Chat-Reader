
const { TikTokConnectionWrapper } = require('./connectionWrapper');
const { manager } = require('./manager');

class AutoRecorder {
    constructor() {
        this.defaultInterval = 300 * 1000;
        this.monitoring = true;
        this.activeConnections = new Map(); // roomId -> { wrapper, startTime, lastEventTime }

        this.timer = null;
        this.heartbeatTimer = null;

        // Delay initial check to not block server startup
        setTimeout(() => this.startLoop(), 2000);

        // Start heartbeat check every 60 seconds
        this.startHeartbeat();

        console.log(`[AutoRecorder] Service started.`);
    }

    // Heartbeat check - actively verify connections are still live
    startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            this.checkConnectionHealth();
        }, 60000); // Check every 60 seconds
    }

    async checkConnectionHealth() {
        console.log(`[AutoRecorder] Heartbeat: Checking ${this.activeConnections.size} active connections...`);

        for (const [uniqueId, conn] of this.activeConnections.entries()) {
            const { wrapper } = conn;

            try {
                // ACTIVE VERIFICATION: Use fetchIsLive to check if room is actually streaming
                const isLive = await wrapper.connection.fetchIsLive();

                if (!isLive) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} is NO LONGER LIVE (verified via API). Disconnecting...`);
                    this.handleDisconnect(uniqueId);
                }
            } catch (err) {
                // If fetchIsLive fails, check if we have recent events as fallback
                const now = Date.now();
                const lastEventTime = conn.lastEventTime || 0;
                const timeSinceEvent = now - lastEventTime;
                const staleThreshold = 5 * 60 * 1000; // 5 minutes

                if (timeSinceEvent > staleThreshold) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} - fetchIsLive failed and no events for ${Math.floor(timeSinceEvent / 1000)}s. Disconnecting...`);
                    this.handleDisconnect(uniqueId);
                } else {
                    // Has recent events, probably just API error - keep alive
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} - fetchIsLive failed but has recent events, keeping alive`);
                }
            }
        }
    }

    // Returns array of room IDs that are currently connected
    getLiveRoomIds() {
        return Array.from(this.activeConnections.keys());
    }

    async startLoop() {
        // Dynamic Loop
        const run = async () => {
            if (!this.monitoring) return;
            try {
                await this.monitor();
            } catch (e) { console.error('[AutoRecorder] monitor error:', e); }

            // Get interval from DB
            const intervalStr = await manager.getSetting('interval', '5'); // default 5 mins
            const intervalMins = parseInt(intervalStr) || 5;
            const intervalMs = intervalMins * 60 * 1000;

            this.timer = setTimeout(run, intervalMs);
        };
        run();
    }

    async monitor() {
        if (!this.monitoring) return;

        console.log('[AutoRecorder] Checking for live rooms...');

        // Get all rooms from DB
        const rooms = await manager.getRooms();

        // Check global Auto Monitor setting (default to 'true' if not set)
        const autoEnabled = await manager.getSetting('auto_monitor_enabled', 'true');
        if (autoEnabled !== 'true' && autoEnabled !== true) {
            console.log('[AutoRecorder] Auto monitoring is disabled in settings');
            return;
        }

        // Filter rooms that have a name (user configured rooms)
        const targetRooms = rooms.filter(r => r.name && r.name.trim() !== '');

        // Build list of rooms to check (excluding already connected and disabled)
        const roomsToCheck = [];
        for (const room of targetRooms) {
            const roomEnabled = (room.is_monitor_enabled !== 0);
            if (!roomEnabled) {
                if (this.activeConnections.has(room.room_id)) {
                    console.log(`[AutoRecorder] Room ${room.room_id} monitor disabled. Disconnecting...`);
                    this.handleDisconnect(room.room_id);
                }
                continue;
            }
            if (this.activeConnections.has(room.room_id)) {
                continue;
            }
            roomsToCheck.push(room);
        }

        // Check rooms with concurrency limit (max 3 at a time to avoid overloading sign server)
        if (roomsToCheck.length > 0) {
            const CONCURRENCY_LIMIT = 3;
            console.log(`[AutoRecorder] Checking ${roomsToCheck.length} rooms (max ${CONCURRENCY_LIMIT} concurrent)...`);

            for (let i = 0; i < roomsToCheck.length; i += CONCURRENCY_LIMIT) {
                const batch = roomsToCheck.slice(i, i + CONCURRENCY_LIMIT);
                await Promise.allSettled(batch.map(room => this.checkAndConnect(room)));
                // Small delay between batches to avoid rate limiting
                if (i + CONCURRENCY_LIMIT < roomsToCheck.length) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }
    }

    async checkAndConnect(room) {
        const uniqueId = room.room_id; // Using room_id as uniqueId/username to connect

        console.log(`[AutoRecorder] Checking ${uniqueId} (${room.name})...`);

        try {
            // Fetch Settings
            const dbSettings = await manager.getAllSettings();

            // Create a temporary wrapper just to check status or connect
            const options = {
                enableExtendedGiftInfo: true,
                fetchRoomInfoOnConnect: true,
                sessionId: dbSettings.session_id || process.env.SESSIONID,
                proxyUrl: dbSettings.proxy,
                eulerApiKey: dbSettings.euler_api_key
            };

            const wrapper = new TikTokConnectionWrapper(uniqueId, options, true);

            // Hook up events
            wrapper.once('connected', state => {
                console.log(`[AutoRecorder] ${uniqueId} is LIVE! Connected. RoomID: ${state.roomId}`);
                this.activeConnections.set(uniqueId, {
                    wrapper: wrapper,
                    startTime: new Date(),
                    roomId: state.roomId // Actual numeric room ID
                });

                // Save numeric room ID for mapping (enables data migration)
                if (state.roomId) {
                    manager.setNumericRoomId(uniqueId, state.roomId).catch(console.error);
                }

                // Set up event logging
                this.setupLogging(wrapper, uniqueId, state.roomId);
            });

            wrapper.once('disconnected', reason => {
                console.log(`[AutoRecorder] ${uniqueId} disconnected: ${reason}`);
                this.handleDisconnect(uniqueId);
            });

            wrapper.connection.on('streamEnd', () => {
                console.log(`[AutoRecorder] ${uniqueId} stream ended.`);
                this.handleDisconnect(uniqueId);
            });

            // Attempt connect
            await wrapper.connect();

        } catch (err) {
            // Expected if offline
            // console.log(`[AutoRecorder] ${uniqueId} is likely offline or error: ${err.message}`);
        }
    }

    setupLogging(wrapper, uniqueId, numericRoomId) {
        // FORCE use of uniqueId (string) for logging to match DB queries
        const logId = uniqueId;
        console.log(`[AutoRecorder] Setting up event logging for ${uniqueId}`);
        let eventCount = { member: 0, chat: 0, gift: 0, like: 0 };

        // Helper to update lastEventTime for heartbeat tracking
        const updateLastEventTime = () => {
            const conn = this.activeConnections.get(uniqueId);
            if (conn) {
                conn.lastEventTime = Date.now();
            }
        };

        // Helper to extract user role and fan badge info
        const extractRoleInfo = (msg) => ({
            isAdmin: msg.user?.userAttr?.isAdmin || false,
            isSuperAdmin: msg.user?.userAttr?.isSuperAdmin || false,
            isModerator: msg.userIdentity?.isModeratorOfAnchor || false,
            fanLevel: msg.user?.fansClub?.data?.level || 0,
            fanClubName: msg.user?.fansClub?.data?.clubName || ''
        });

        wrapper.connection.on('member', msg => {
            eventCount.member++;
            updateLastEventTime();
            if (eventCount.member === 1) console.log(`[AutoRecorder] First member event for ${uniqueId}`);
            const roleInfo = extractRoleInfo(msg);
            const data = {
                uniqueId: msg.user?.uniqueId || msg.uniqueId,
                nickname: msg.user?.nickname || msg.nickname,
                userId: msg.user?.userId || msg.userId,
                ...roleInfo
            };
            manager.logEvent(logId, 'member', data).catch(console.error);
        });

        wrapper.connection.on('chat', msg => {
            updateLastEventTime();
            const roleInfo = extractRoleInfo(msg);
            const data = {
                uniqueId: msg.user?.uniqueId || msg.uniqueId,
                nickname: msg.user?.nickname || msg.nickname,
                comment: msg.comment,
                userId: msg.user?.userId || msg.userId,
                region: msg.user?.region || '',
                ...roleInfo
            };
            manager.logEvent(logId, 'chat', data).catch(console.error);
        });

        wrapper.connection.on('gift', msg => {
            updateLastEventTime();
            const gift = msg.gift || {};
            const extendedGift = msg.extendedGiftInfo || {};
            let giftImage = gift.icon?.url_list?.[0] || '';
            const roleInfo = extractRoleInfo(msg);

            const data = {
                uniqueId: msg.user?.uniqueId || msg.uniqueId,
                nickname: msg.user?.nickname || msg.nickname,
                userId: msg.user?.userId || msg.userId,
                region: msg.user?.region || '',
                giftId: msg.giftId || gift.id,
                giftName: gift.giftName || extendedGift.name || msg.giftName || 'Unknown',
                giftImage: giftImage,
                repeatCount: msg.repeatCount || 1,
                giftType: msg.giftType || gift.giftType,
                diamondCount: gift.diamondCount || extendedGift.diamond_count || msg.diamondCount || 0,
                repeatEnd: msg.repeatEnd,
                ...roleInfo
            };

            if (data.giftType !== 1 || msg.repeatEnd) {
                manager.logEvent(logId, 'gift', data).catch(console.error);
            }
        });

        wrapper.connection.on('like', msg => {
            updateLastEventTime();
            const roleInfo = extractRoleInfo(msg);
            const data = {
                uniqueId: msg.user?.uniqueId || msg.uniqueId,
                nickname: msg.user?.nickname || msg.nickname,
                userId: msg.user?.userId || msg.userId,
                likeCount: msg.likeCount,
                totalLikeCount: msg.totalLikeCount,
                ...roleInfo
            };
            manager.logEvent(logId, 'like', data).catch(console.error);
        });
    }

    // Check if a room is currently connected
    isConnected(uniqueId) {
        return this.activeConnections.has(uniqueId);
    }

    // Get the connection wrapper for a room (for event forwarding to UI)
    getConnection(uniqueId) {
        const conn = this.activeConnections.get(uniqueId);
        return conn ? conn.wrapper : null;
    }

    // Manually start recording a room (triggered by user from UI)
    async startRoom(uniqueId) {
        if (this.activeConnections.has(uniqueId)) {
            console.log(`[AutoRecorder] Room ${uniqueId} already connected`);
            return { success: true, alreadyConnected: true };
        }

        console.log(`[AutoRecorder] Manual start requested for ${uniqueId}`);

        try {
            // Create a room entry if it doesn't exist (don't overwrite name or monitor setting)
            await manager.updateRoom(uniqueId, null, null, undefined);

            // Use the same connection logic as checkAndConnect
            const dbSettings = await manager.getAllSettings();
            const options = {
                enableExtendedGiftInfo: true,
                fetchRoomInfoOnConnect: true,
                sessionId: dbSettings.session_id || process.env.SESSIONID,
                proxyUrl: dbSettings.proxy_url || dbSettings.proxy,
                eulerApiKey: dbSettings.euler_api_key
            };

            const wrapper = new TikTokConnectionWrapper(uniqueId, options, true);

            return new Promise((resolve, reject) => {
                let connected = false;

                wrapper.once('connected', state => {
                    connected = true;
                    console.log(`[AutoRecorder] ${uniqueId} is LIVE! Connected. RoomID: ${state.roomId}`);
                    this.activeConnections.set(uniqueId, {
                        wrapper: wrapper,
                        startTime: new Date(),
                        roomId: state.roomId
                    });

                    if (state.roomId) {
                        manager.setNumericRoomId(uniqueId, state.roomId).catch(console.error);
                    }

                    this.setupLogging(wrapper, uniqueId, state.roomId);

                    // Set up post-connection event handlers
                    wrapper.once('disconnected', reason => {
                        console.log(`[AutoRecorder] ${uniqueId} disconnected after connection: ${reason}`);
                        this.handleDisconnect(uniqueId);
                    });

                    wrapper.connection.on('streamEnd', () => {
                        console.log(`[AutoRecorder] ${uniqueId} stream ended.`);
                        this.handleDisconnect(uniqueId);
                    });

                    resolve({ success: true, state });
                });

                // Handle connection failure (before connected)
                wrapper.once('disconnected', reason => {
                    if (!connected) {
                        console.log(`[AutoRecorder] ${uniqueId} failed to connect: ${reason}`);
                        reject(new Error(reason));
                    }
                });

                wrapper.connect();
            });
        } catch (err) {
            console.error(`[AutoRecorder] Error starting ${uniqueId}:`, err.message);
            throw err;
        }
    }

    // Manually stop a recording session
    async disconnectRoom(uniqueId) {
        if (this.activeConnections.has(uniqueId)) {
            console.log(`[AutoRecorder] Manual stop requested for ${uniqueId}`);
            // Logic to prevent immediate reconnect? 
            // For now, just disconnect. If the monitor loop runs, it might reconnect if logic allows.
            // But usually 'monitor' loops every 5 mins.
            // If user stops, they probably want it stopped. 
            // We should probably set a "cooldown" or just hope 5 mins is enough.

            await this.handleDisconnect(uniqueId);
            return true;
        }
        return false;
    }

    async handleDisconnect(uniqueId) {
        if (this.activeConnections.has(uniqueId)) {
            const conn = this.activeConnections.get(uniqueId);
            const { wrapper, roomId, startTime } = conn;

            // Clean up connection
            try {
                wrapper.disconnect();
            } catch (e) { }

            this.activeConnections.delete(uniqueId);

            // Check if there are any events to save before creating session
            const eventCount = await manager.getUntaggedEventCount(uniqueId, startTime.toISOString());

            if (eventCount === 0) {
                console.log(`[AutoRecorder] No events recorded for ${uniqueId}, skipping session save.`);
                return;
            }

            // Auto Save Session (only if we have events)
            console.log(`[AutoRecorder] Archiving session for ${uniqueId} with ${eventCount} events...`);
            try {
                // FORCE uniqueId (string) for session creation to match logging
                const sessionId = await manager.createSession(uniqueId, {
                    auto_generated: true,
                    note: `Auto recorded session (${eventCount} events)`
                });

                await manager.tagEventsWithSession(uniqueId, sessionId, startTime.toISOString());
                console.log(`[AutoRecorder] Session saved: ${sessionId}`);

            } catch (err) {
                console.error(`[AutoRecorder] Error saving session: ${err.message}`);
            }
        }
    }
}

module.exports = { AutoRecorder };
