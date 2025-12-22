
const { TikTokConnectionWrapper, getKeyCount } = require('./connectionWrapper');
const { manager } = require('./manager');

class AutoRecorder {
    constructor() {
        this.defaultInterval = 300 * 1000;
        this.monitoring = true;
        this.activeConnections = new Map(); // roomId -> { wrapper, startTime, lastEventTime }

        // In-flight operations (avoid connect/disconnect races per room)
        this.connectingRooms = new Map();    // roomId -> Promise (connect attempt)
        this.disconnectingRooms = new Map(); // roomId -> Promise (disconnect + archive)

        // Failure tracking for auto-disable
        this.failureCount = new Map();       // roomId -> consecutive failure count
        this.pendingOffline = new Map();     // roomId -> timestamp (for heartbeat double-check)

        // Session resume: track recent disconnects to allow 30-min resume
        // roomId -> { startTime, startIso, disconnectTime, timerId }
        // Delayed archiving: sessions are archived 30 min after disconnect unless reconnection happens
        this.pendingArchives = new Map();
        this.ARCHIVE_DELAY_MS = 30 * 60 * 1000; // 30 minutes

        // False positive cooldown: prevent repeated connection attempts for rooms that fail validation
        // roomId -> cooldownUntil timestamp
        this.falsePositiveCooldown = new Map();

        this.timer = null;
        this.heartbeatTimer = null;

        // Delay initial check to not block server startup
        setTimeout(() => this.startLoop(), 2000);

        // Start heartbeat check every 60 seconds
        this.startHeartbeat();

        console.log(`[AutoRecorder] Service started.`);
    }

    // Get list of VALIDATED live room IDs (only rooms with actual events or passed 65s validation)
    getLiveRoomIds() {
        const validatedLive = [];
        const now = Date.now();

        for (const [roomId, conn] of this.activeConnections.entries()) {
            // Check if connection has received actual events (lastEventTime updated beyond initial value)
            const startTimeMs = conn.startTime?.getTime() || now;
            const hasReceivedEvents = conn.lastEventTime && (conn.lastEventTime > startTimeMs + 1000);

            // Or connection has been alive past the 60s validation period
            const connectionAge = now - startTimeMs;
            const passedValidation = connectionAge > 65000; // 65s, past 60s validation

            if (hasReceivedEvents || passedValidation) {
                validatedLive.push(roomId);
            }
        }

        return validatedLive;
    }

    // Get connection wrapper for a room
    getConnection(roomId) {
        const conn = this.activeConnections.get(roomId);
        return conn ? conn.wrapper : null;
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
            const now = Date.now();
            const lastEventTime = conn.lastEventTime ?? (conn.startTime instanceof Date ? conn.startTime.getTime() : now);
            const timeSinceEvent = Math.floor((now - lastEventTime) / 1000);

            // CRITICAL CHECK 1: Is the underlying TikTok WebSocket actually connected?
            const wsConnected = wrapper?.connection?.isConnected ?? false;

            // ZOMBIE DETECTION: Even if wsConnected is true, TikTok WebSockets can silently die
            // If no events received for 2+ minutes, the connection is likely dead
            const zombieThreshold = 2 * 60 * 1000; // 2 minutes
            const isZombie = (now - lastEventTime) > zombieThreshold;

            if (isZombie) {
                // Force disconnect to allow fresh reconnection
                console.log(`[AutoRecorder] Heartbeat: ${uniqueId} ZOMBIE detected! No events for ${timeSinceEvent}s (wsConnected=${wsConnected}). Force disconnecting...`);
                this.handleDisconnect(uniqueId, `Heartbeat: zombie (${timeSinceEvent}s silent)`);
                continue;
            }

            if (!wsConnected) {
                // WebSocket is disconnected but connection is still in activeConnections
                console.log(`[AutoRecorder] Heartbeat: ${uniqueId} WebSocket DISCONNECTED (lastEvent ${timeSinceEvent}s ago). Waiting for auto-reconnect...`);
                continue;
            }

            // CRITICAL CHECK 2: Try to verify room is still live via API
            let isLive = null;
            try {
                isLive = await wrapper.connection.fetchIsLive();
            } catch (err) {
                // API check failed - rely on event activity instead
                const errName = err?.constructor?.name || 'Error';

                // Shorter threshold when API is broken: 2 minutes
                const staleThreshold = 2 * 60 * 1000;

                if (now - lastEventTime > staleThreshold) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} API error (${errName}) + ${timeSinceEvent}s inactive. Treating as zombie...`);
                    this.handleDisconnect(uniqueId, 'Heartbeat: zombie detected (API error + no events)');
                } else {
                    // Has recent events - connection is likely fine, just API is flaky
                    if (timeSinceEvent > 30) { // Only log if somewhat stale
                        console.log(`[AutoRecorder] Heartbeat: ${uniqueId} API error but active (${timeSinceEvent}s ago). Keeping alive.`);
                    }
                }
                continue;
            }

            try {
                if (!isLive) {
                    // Step 1: Mark as Pending Offline if not already
                    if (!this.pendingOffline.has(uniqueId)) {
                        console.log(`[AutoRecorder] Heartbeat: ${uniqueId} API reported offline. Verifying...`);
                        this.pendingOffline.set(uniqueId, Date.now());
                        continue;
                    }

                    // Step 2: Check Double Confirmation Time (30 seconds)
                    const pendingSince = this.pendingOffline.get(uniqueId);
                    if (Date.now() - pendingSince < 30 * 1000) {
                        // Wait for at least 30 seconds of consistent "offline" status
                        continue;
                    }

                    // Step 3: Check Activity (2-minute silence rule - reduced from 5 minutes)
                    const now = Date.now();
                    const lastEventTime = conn.lastEventTime ?? (conn.startTime instanceof Date ? conn.startTime.getTime() : 0);
                    const timeSinceEvent = now - lastEventTime;
                    const staleThreshold = 2 * 60 * 1000; // 2 minutes (was 5 minutes)

                    if (timeSinceEvent > staleThreshold) {
                        console.log(`[AutoRecorder] Heartbeat: ${uniqueId} offline CONFIRMED (API=false + ${Math.floor(timeSinceEvent / 1000)}s inactive). Disconnecting...`);
                        this.pendingOffline.delete(uniqueId);
                        this.handleDisconnect(uniqueId, 'Heartbeat: offline confirmed');
                    } else {
                        // Has recent events despite API saying offline - KEEP ALIVE
                        // This handles cases where API is flaky but WebSocket is sending data
                        console.log(`[AutoRecorder] Heartbeat: ${uniqueId} API says offline but active (${Math.floor(timeSinceEvent / 1000)}s ago). Keeping alive until ${Math.ceil((staleThreshold - timeSinceEvent) / 1000)}s more.`);
                    }

                } else {
                    // Room is LIVE -> Clear any pending offline status
                    if (this.pendingOffline.has(uniqueId)) {
                        console.log(`[AutoRecorder] Heartbeat: ${uniqueId} confirmed online. Clearing pending status.`);
                        this.pendingOffline.delete(uniqueId);
                    }
                }

            } catch (err) {
                // Network error during check -> Treat similarly to "offline" but relying purely on events
                // For safety, we do NOT trigger immediate disconnect on error. We rely on the 5-min stale check below.

                const now = Date.now();
                const lastEventTime = conn.lastEventTime ?? (conn.startTime instanceof Date ? conn.startTime.getTime() : 0);
                const timeSinceEvent = now - lastEventTime;
                const staleThreshold = 5 * 60 * 1000; // 5 minutes

                if (timeSinceEvent > staleThreshold) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} - Health check error and no events for ${Math.floor(timeSinceEvent / 1000)}s. Disconnecting...`);
                    this.handleDisconnect(uniqueId, 'Heartbeat: error/stale');
                }
            }
        }
    }



    // Returns detailed stats for debugging connection state
    getConnectionStats() {
        const now = Date.now();
        return Array.from(this.activeConnections.entries()).map(([roomId, conn]) => {
            const lastEvent = conn.lastEventTime || (conn.startTime?.getTime()) || now;
            return {
                roomId,
                startTime: conn.startTime?.toISOString(),
                lastEventAgo: Math.floor((now - lastEvent) / 1000) + 's',
                wsConnected: conn.wrapper?.connection?.isConnected ?? false,
                roomNumericId: conn.roomId
            };
        });
    }

    async startLoop() {
        // Run startup cleanup once
        try {
            console.log('[AutoRecorder] Running startup cleanup...');
            await manager.cleanupAllStaleEvents();
            console.log('[AutoRecorder] Running startup session consolidation...');
            await manager.consolidateRecentSessions();
        } catch (e) {
            console.error('[AutoRecorder] Startup maintenance failed:', e);
        }

        // Setup periodic maintenance jobs
        // 1. Cleanup stale events every 30 minutes (prevents 20+ hour "live" sessions)
        setInterval(async () => {
            try {
                await manager.cleanupAllStaleEvents();
                console.log('[AutoRecorder] Periodic stale event cleanup completed');
            } catch (err) {
                console.error('[AutoRecorder] Periodic cleanup failed:', err);
            }
        }, 30 * 60 * 1000); // Every 30 minutes

        // 2. Session consolidation every 60 minutes
        setInterval(() => {
            manager.consolidateRecentSessions().catch(err => console.error('[AutoRecorder] Hourly consolidation failed:', err));
        }, 60 * 60 * 1000);

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

        // Get all rooms from DB (no pagination needed for auto-monitor)
        const roomsResult = await manager.getRooms({ limit: 9999 });
        const rooms = roomsResult.data || [];

        // Check global Auto Monitor setting (default to 'true' if not set)
        const autoEnabled = await manager.getSetting('auto_monitor_enabled', 'true');
        if (autoEnabled !== 'true' && autoEnabled !== true) {
            console.log('[AutoRecorder] Auto monitoring is disabled in settings');
            return;
        }

        // Filter rooms that have a name (user configured rooms)
        // Sort so enabled rooms come first, disabled rooms last
        const targetRooms = rooms
            .filter(r => r.name && r.name.trim() !== '')
            .sort((a, b) => {
                const aEnabled = a.is_monitor_enabled !== 0 ? 0 : 1;
                const bEnabled = b.is_monitor_enabled !== 0 ? 0 : 1;
                return aEnabled - bEnabled; // 0 comes before 1
            });

        // Build list of rooms to check (excluding already connected and disabled)
        const roomsToCheck = [];
        for (const room of targetRooms) {
            const roomEnabled = (room.isMonitorEnabled !== 0);
            if (!roomEnabled) {
                if (this.activeConnections.has(room.roomId)) {
                    console.log(`[AutoRecorder] Room ${room.roomId} monitor disabled. Disconnecting...`);
                    this.handleDisconnect(room.roomId, 'Monitor disabled');
                }
                continue;
            }
            if (this.activeConnections.has(room.roomId)) {
                continue;
            }
            if (this.disconnectingRooms.has(room.roomId)) {
                // Avoid reconnecting while we are archiving a session for this room
                continue;
            }
            if (this.connectingRooms.has(room.roomId)) {
                // Connection attempt already in progress
                continue;
            }
            roomsToCheck.push(room);
        }

        // Check rooms with concurrency limit (Smart Concurrency: 1 per Key)
        if (roomsToCheck.length > 0) {
            const keyCount = getKeyCount();
            const CONCURRENCY_LIMIT = Math.max(1, keyCount);
            console.log(`[AutoRecorder] Checking ${roomsToCheck.length} rooms (max ${CONCURRENCY_LIMIT} concurrent, based on ${keyCount} keys)...`);

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
        const uniqueId = room.roomId; // Using roomId as uniqueId/username to connect

        if (this.disconnectingRooms.has(uniqueId)) {
            // Avoid starting a new connection while we are archiving a session for this room
            return;
        }

        if (this.connectingRooms.has(uniqueId)) {
            // A connection attempt is already in progress
            return;
        }

        // Check false positive cooldown (rooms that repeatedly fail validation)
        const cooldownUntil = this.falsePositiveCooldown.get(uniqueId);
        if (cooldownUntil && Date.now() < cooldownUntil) {
            // Still in cooldown, skip this room silently
            return;
        }
        // Clear expired cooldown
        if (cooldownUntil) {
            this.falsePositiveCooldown.delete(uniqueId);
        }

        console.log(`[AutoRecorder] Checking ${uniqueId} (${room.name})...`);

        const connectTask = (async () => {
            // Fetch Settings
            const dbSettings = await manager.getAllSettings();

            // Auto-Archive Stale Live Events (Prevent 24h+ duration bug)
            try {
                // If there are dangling events from a previous crash/restart > 1h ago, archive them now.
                const staleInfo = await manager.archiveStaleLiveEvents(uniqueId);
                if (staleInfo && staleInfo.archived > 0) {
                    console.log(`[AutoRecorder] Cleaned up ${staleInfo.archived} stale events for ${uniqueId} before new connection.`);
                }
            } catch (err) {
                console.error(`[AutoRecorder] Warning: Failed to check stale events for ${uniqueId}:`, err.message);
            }

            // Create a temporary wrapper just to check status or connect
            // IMPORTANT: Only include sessionId/ttTargetIdc when sessionId is a VALID TikTok session
            // Invalid formats (like csrf_session_id=...) cause WebSocket 200 errors
            let rawSessionId = dbSettings.session_id || process.env.SESSIONID;
            const isValidSession = rawSessionId &&
                !rawSessionId.includes('=') && // Not a key=value pair
                !rawSessionId.includes('csrf') && // Not a CSRF token
                rawSessionId.length >= 32; // Real TikTok sessions are long hashes
            const sessionId = isValidSession ? rawSessionId : null;

            const options = {
                enableExtendedGiftInfo: true,
                fetchRoomInfoOnConnect: true,
                proxyUrl: dbSettings.proxy,
                eulerApiKey: dbSettings.euler_api_key,
                // Conditionally add session credentials
                ...(sessionId ? {
                    sessionId: sessionId,
                    ttTargetIdc: dbSettings.tt_target_idc || process.env.TT_TARGET_IDC || 'useast2a'
                } : {})
            };

            const wrapper = new TikTokConnectionWrapper(uniqueId, options, true);

            // Hook up events - use 'on' instead of 'once' to handle reconnects
            wrapper.on('connected', async state => {
                console.log(`[AutoRecorder] ${uniqueId} is LIVE! Connected. RoomID: ${state.roomId}`);

                // Check if already in activeConnections (reconnect case)
                const existing = this.activeConnections.get(uniqueId);
                if (existing) {
                    // Reconnect - update lastEventTime but keep existing data
                    existing.lastEventTime = Date.now();
                    console.log(`[AutoRecorder] ${uniqueId} reconnected, refreshing event listeners`);
                } else {
                    // Initial connection - check if we should resume from recent disconnect
                    const resumeWindowMs = 30 * 60 * 1000; // 30 minutes
                    let shouldResume = false;

                    try {
                        // Check if there was a recent session (within 30 mins of its END time)
                        const sessions = await manager.getSessions(uniqueId);
                        if (sessions && sessions.length > 0) {
                            const lastSession = sessions[0];
                            // Use endTime if available (from most recent event), fallback to created_at
                            const sessionEndTime = lastSession.endTime
                                ? new Date(lastSession.endTime).getTime()
                                : new Date(lastSession.created_at).getTime();
                            const timeSinceSessionEnd = Date.now() - sessionEndTime;

                            if (timeSinceSessionEnd < resumeWindowMs) {
                                // Session ended within 30 mins - this is likely a resume
                                console.log(`[AutoRecorder] ${uniqueId} reconnecting within 30 mins of last session END (${Math.floor(timeSinceSessionEnd / 1000 / 60)}m ago). Resuming...`);
                                shouldResume = true;
                            }
                        }

                        // Also check pendingArchives for recent disconnects with pending timer
                        const pendingArchive = this.pendingArchives.get(uniqueId);
                        let resumedStartTime = null;
                        if (pendingArchive && (Date.now() - pendingArchive.disconnectTime) < resumeWindowMs) {
                            // Cancel the pending archive timer
                            if (pendingArchive.timerId) {
                                clearTimeout(pendingArchive.timerId);
                            }
                            console.log(`[AutoRecorder] 🔄 ${uniqueId} reconnected within 30 min, cancelling archive timer and resuming session...`);
                            shouldResume = true;
                            resumedStartTime = pendingArchive.startTime; // Restore original startTime
                            this.pendingArchives.delete(uniqueId);
                        }

                        // If NOT resuming, archive orphan events first
                        if (!shouldResume) {
                            const orphanCount = await manager.getUntaggedEventCount(uniqueId, null);
                            if (orphanCount > 0) {
                                console.log(`[AutoRecorder] Found ${orphanCount} orphan events for ${uniqueId}, archiving before new stream...`);
                                await manager.archiveStaleLiveEvents(uniqueId);
                            }
                        } else {
                            // Resuming - keep orphan events as-is, they'll be part of this session
                            const orphanCount = await manager.getUntaggedEventCount(uniqueId, null);
                            if (orphanCount > 0) {
                                console.log(`[AutoRecorder] ${uniqueId} resuming with ${orphanCount} existing events (no new archive created)`)
                            }
                        }

                        // Use resumed startTime if available, otherwise new Date()
                        const sessionStartTime = resumedStartTime || new Date();
                        this.activeConnections.set(uniqueId, {
                            wrapper: wrapper,
                            startTime: sessionStartTime,
                            lastEventTime: Date.now(),
                            pendingWrites: new Set(),
                            roomId: state.roomId // Actual numeric room ID
                        });
                    } catch (e) {
                        console.error(`[AutoRecorder] Error checking resume status for ${uniqueId}:`, e);

                        // Fallback: still set connection, just use new Date()
                        this.activeConnections.set(uniqueId, {
                            wrapper: wrapper,
                            startTime: new Date(),
                            lastEventTime: Date.now(),
                            pendingWrites: new Set(),
                            roomId: state.roomId
                        });
                    }
                }

                // Reset failure count on success
                this.failureCount.delete(uniqueId);

                // Save numeric room ID for mapping (enables data migration)
                if (state.roomId) {
                    manager.setNumericRoomId(uniqueId, state.roomId).catch(console.error);
                }

                // Set up event logging - called on EVERY connect/reconnect
                this.setupLogging(wrapper, uniqueId, state.roomId);

                // POST-CONNECTION VALIDATION: TikTok API can return success for offline rooms
                // If no events received within 60 seconds, room is likely not actually live
                const validationDelayMs = 60 * 1000;
                setTimeout(() => {
                    const conn = this.activeConnections.get(uniqueId);
                    if (!conn) return; // Already disconnected

                    const now = Date.now();
                    const timeSinceStart = now - (conn.startTime?.getTime() || now);
                    const timeSinceEvent = now - (conn.lastEventTime || now);

                    // If connected for 60s but no events received (lastEventTime is close to startTime)
                    if (timeSinceStart >= validationDelayMs && timeSinceEvent >= validationDelayMs - 5000) {
                        console.log(`[AutoRecorder] ${uniqueId} connected but NO EVENTS for ${Math.floor(timeSinceStart / 1000)}s. Likely offline (API false positive). Disconnecting...`);

                        // Set 30-min cooldown to prevent repeated connection attempts
                        const cooldownMs = 30 * 60 * 1000;
                        this.falsePositiveCooldown.set(uniqueId, Date.now() + cooldownMs);
                        console.log(`[AutoRecorder] ${uniqueId} placed in 30-min cooldown to prevent repeated false positives`);

                        this.handleDisconnect(uniqueId, 'No events after connection - likely offline');
                    }
                }, validationDelayMs);
            });

            wrapper.once('disconnected', reason => {
                console.log(`[AutoRecorder] ${uniqueId} disconnected: ${reason}`);
                this.handleDisconnect(uniqueId, reason);
            });

            // OPTIMIZATION: Try to get cached room ID to skip TikTok page parsing
            // DISABLED: Cached room IDs appear to cause WebSocket connections that don't emit events!
            // TODO: Investigate why cachedRoomId breaks event reception
            let cachedRoomId = null;
            // try {
            //     cachedRoomId = await manager.getCachedRoomId(uniqueId);
            //     if (cachedRoomId) {
            //         console.log(`[AutoRecorder] Using cached Room ID for ${uniqueId}: ${cachedRoomId}`);
            //     }
            // } catch (e) {
            //     // Ignore cache errors, will fetch fresh
            // }

            // Attempt connect WITHOUT cached room ID
            try {
                console.log(`[AutoRecorder] Connecting to ${uniqueId} (fresh room ID fetch)...`);
                await wrapper.connect(false, null); // Force fresh fetch
            } catch (err) {
                // If we used a cached room ID and got "UserOfflineError" (or similar), it might be a stale ID for a NEW stream.
                // Clear cache and retry without room ID to force fresh fetch.

                // Inspect strict error, nested exception, and info fields
                const checkStr = (obj) => {
                    if (!obj) return '';
                    return (obj.message || '') + (obj.toString() || '') + (obj.name || '');
                }

                const errStr = checkStr(err) + checkStr(err?.exception) + (err?.info || '');
                const isRetryableError = errStr.includes('UserOfflineError') ||
                    errStr.includes("isn't online") ||
                    errStr.includes("Room is offline") ||
                    errStr.includes("Unexpected server response: 200") ||
                    errStr.includes("Websocket connection failed");

                if (cachedRoomId && isRetryableError) {
                    console.log(`[AutoRecorder] ${uniqueId} possibly stale Room ID ${cachedRoomId}, retrying with fresh fetch...`);
                    // Clear the stale cache
                    manager.setNumericRoomId(uniqueId, null).catch(() => { });

                    // Retry without cached ID
                    await wrapper.connect(false, null);
                } else {
                    throw err; // Re-throw other errors
                }
            }

            // Setup streamEnd listener AFTER connect() creates the connection
            if (wrapper.connection) {
                wrapper.connection.on('streamEnd', () => {
                    console.log(`[AutoRecorder] ${uniqueId} stream ended.`);
                    this.handleDisconnect(uniqueId, 'streamEnd');
                });
            }

        })();

        this.connectingRooms.set(uniqueId, connectTask);

        try {
            await connectTask;
        } catch (err) {

            // Track failures for persistent room ID fetch issues
            const errMsg = (err?.message || '').toLowerCase();
            const isRoomIdError = errMsg.includes('room id') ||
                errMsg.includes('fetchisliveerror') ||
                errMsg.includes('sigi_state') ||
                errMsg.includes('failed to extract');

            if (isRoomIdError) {
                const count = (this.failureCount.get(uniqueId) || 0) + 1;
                this.failureCount.set(uniqueId, count);

                // Auto-disable after 3 consecutive failures
                if (count >= 3) {
                    console.log(`[AutoRecorder] ⛔ ${uniqueId} 连续 ${count} 次获取房间信息失败，自动关闭监控`);
                    try {
                        await manager.updateRoomMonitor(uniqueId, false);
                        this.failureCount.delete(uniqueId);
                    } catch (e) {
                        console.error(`[AutoRecorder] Failed to disable monitor for ${uniqueId}:`, e.message);
                    }
                } else {
                    console.log(`[AutoRecorder] ${uniqueId} 获取房间信息失败 (${count}/3)，稍后重试`);
                }
            }
            // Offline errors are expected, no action needed
        } finally {
            if (this.connectingRooms.get(uniqueId) === connectTask) {
                this.connectingRooms.delete(uniqueId);
            }
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

        // Track DB writes so we can flush before archiving (prevents missing last-second events)
        const trackWrite = (p) => {
            const conn = this.activeConnections.get(uniqueId);
            if (!conn) return;
            if (!conn.pendingWrites) {
                conn.pendingWrites = new Set();
            }
            conn.pendingWrites.add(p);
            p.finally(() => {
                conn.pendingWrites.delete(p);
            });
        };

        const logEvent = (type, data) => {
            const p = manager.logEvent(logId, type, data).catch(console.error);
            trackWrite(p);
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
            logEvent('member', data);
        });

        wrapper.connection.on('chat', msg => {
            updateLastEventTime();
            eventCount.chat++;
            // Only log first chat event as confirmation room is receiving data
            if (eventCount.chat === 1) console.log(`[AutoRecorder] ✓ ${uniqueId} receiving events`);
            const roleInfo = extractRoleInfo(msg);
            const data = {
                uniqueId: msg.user?.uniqueId || msg.uniqueId,
                nickname: msg.user?.nickname || msg.nickname,
                comment: msg.comment,
                userId: msg.user?.userId || msg.userId,
                region: msg.user?.region || '',
                ...roleInfo
            };
            logEvent('chat', data);
        });

        // Gift deduplication using groupId (unique combo sequence ID)
        // groupId is a TikTok-assigned unique identifier for each combo gift sequence
        // Same combo: same groupId, increasing repeatCount until repeatEnd=true
        const activeGiftCombos = new Map(); // key = groupId, value = { data, timestamp }
        const GIFT_COMBO_TIMEOUT_MS = 60000; // 60 seconds - max combo duration

        wrapper.connection.on('gift', msg => {
            updateLastEventTime();
            const gift = msg.gift || {};
            const extendedGift = msg.extendedGiftInfo || {};
            let giftImage = gift.icon?.url_list?.[0] || '';
            const roleInfo = extractRoleInfo(msg);

            // Extract groupId - this is the unique combo sequence identifier
            const groupId = msg.groupId?.toString() || null;

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
                groupId: groupId, // Store for debugging/analysis
                ...roleInfo
            };

            // Debug: Log first few gifts to verify groupId availability
            if (!this._giftDebugLogged) {
                this._giftDebugLogged = 0;
            }
            if (this._giftDebugLogged < 5) {
                console.log(`[Gift Debug] groupId=${groupId} repeatCount=${data.repeatCount} repeatEnd=${msg.repeatEnd} giftType=${data.giftType} gift=${data.giftName}`);
                this._giftDebugLogged++;
            }

            // Auto-collect gift info to database (icon, name, price)
            manager.upsertGift(data.giftId, data.giftName, data.giftImage, data.diamondCount).catch(err => {
                console.error('[Gift] Failed to upsert gift:', err.message);
            });

            // Strategy: Use groupId for precise deduplication if available
            if (groupId) {
                const existing = activeGiftCombos.get(groupId);

                if (existing) {
                    // Update with higher repeatCount
                    if (data.repeatCount >= existing.data.repeatCount) {
                        existing.data = data;
                        existing.timestamp = Date.now();
                    }

                    // If repeatEnd is true, this is the final event - log it and cleanup
                    if (msg.repeatEnd) {
                        logEvent('gift', existing.data);
                        activeGiftCombos.delete(groupId);
                    }
                } else {
                    // First event of this combo
                    activeGiftCombos.set(groupId, { data: data, timestamp: Date.now() });

                    // If repeatEnd is true immediately (single gift or instant combo end), log it
                    if (msg.repeatEnd) {
                        logEvent('gift', data);
                        activeGiftCombos.delete(groupId);
                    }
                }

                // Cleanup stale combos (combos that didn't receive repeatEnd)
                // Run cleanup EVERY TIME to ensure high-value gifts aren't lost
                const now = Date.now();
                for (const [gid, combo] of activeGiftCombos) {
                    if (now - combo.timestamp > GIFT_COMBO_TIMEOUT_MS) {
                        // Log stale combo with last known repeatCount
                        console.log(`[Gift] Logging stale combo ${gid} (${combo.data.giftName}) with repeatCount=${combo.data.repeatCount} 💎${combo.data.diamondCount * combo.data.repeatCount}`);
                        logEvent('gift', combo.data);
                        activeGiftCombos.delete(gid);
                    }
                }

                return; // Don't fall through to fallback logic
            }

            // Fallback: No groupId available (shouldn't happen with proper TikTok connection)
            // Use simple strategy: only log if repeatEnd is true OR if giftType is not 1 (non-combo)
            const isComboGift = data.giftType === 1;
            if (isComboGift && !msg.repeatEnd) {
                return; // Skip intermediate combo updates for combo gifts without groupId
            }

            // Log non-combo gifts immediately, or combo gifts when repeatEnd=true
            logEvent('gift', data);
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
            logEvent('like', data);
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
        // If we are currently archiving this room, wait for it to finish to avoid cross-session tagging.
        const pendingDisconnect = this.disconnectingRooms.get(uniqueId);
        if (pendingDisconnect) {
            console.log(`[AutoRecorder] ${uniqueId} is currently archiving. Waiting before starting...`);
            try { await pendingDisconnect; } catch (e) { }
        }

        if (this.activeConnections.has(uniqueId)) {
            console.log(`[AutoRecorder] Room ${uniqueId} already connected`);
            const conn = this.activeConnections.get(uniqueId);
            return { success: true, alreadyConnected: true, state: { roomId: conn?.roomId } };
        }

        // If an auto-monitor connect attempt is already running, wait for it instead of starting a duplicate.
        const pendingConnect = this.connectingRooms.get(uniqueId);
        if (pendingConnect) {
            console.log(`[AutoRecorder] ${uniqueId} connection attempt already in progress. Waiting...`);
            try { await pendingConnect; } catch (e) { }
            if (this.activeConnections.has(uniqueId)) {
                const conn = this.activeConnections.get(uniqueId);
                return { success: true, alreadyConnected: true, state: { roomId: conn?.roomId } };
            }
        }

        console.log(`[AutoRecorder] Manual start requested for ${uniqueId}`);

        const connectTask = (async () => {
            // Create a room entry if it doesn't exist (don't overwrite name or monitor setting)
            await manager.updateRoom(uniqueId, null, null, undefined);

            // Use the same connection logic as checkAndConnect
            const dbSettings = await manager.getAllSettings();
            // IMPORTANT: Only include sessionId/ttTargetIdc when sessionId is a VALID TikTok session
            // Invalid formats (like csrf_session_id=...) cause WebSocket 200 errors
            let rawSessionId = dbSettings.session_id || process.env.SESSIONID;
            const isValidSession = rawSessionId &&
                !rawSessionId.includes('=') && // Not a key=value pair
                !rawSessionId.includes('csrf') && // Not a CSRF token
                rawSessionId.length >= 32; // Real TikTok sessions are long hashes
            const sessionId = isValidSession ? rawSessionId : null;

            if (rawSessionId && !sessionId) {
                console.log(`[AutoRecorder] Ignoring invalid sessionId format: ${rawSessionId.slice(0, 20)}...`);
            }

            const options = {
                enableExtendedGiftInfo: true,
                fetchRoomInfoOnConnect: true,
                proxyUrl: dbSettings.proxy_url || dbSettings.proxy,
                eulerApiKey: dbSettings.euler_api_key,
                ...(sessionId ? {
                    sessionId: sessionId,
                    ttTargetIdc: dbSettings.tt_target_idc || process.env.TT_TARGET_IDC || 'useast2a'
                } : {})
            };

            // Retry loop - create new wrapper for each attempt
            const maxRetries = 3;
            let lastError = null;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                const wrapper = new TikTokConnectionWrapper(uniqueId, options, true);

                try {
                    const result = await new Promise((resolve, reject) => {
                        let connected = false;
                        const connectTimeoutMs = 45000;
                        const timeout = setTimeout(() => {
                            if (!connected) {
                                try { wrapper.disconnect(); } catch (e) { }
                                reject(new Error('Connection Timeout'));
                            }
                        }, connectTimeoutMs);

                        wrapper.once('connected', state => {
                            connected = true;
                            clearTimeout(timeout);
                            console.log(`[AutoRecorder] ${uniqueId} is LIVE! Connected on attempt ${attempt}. RoomID: ${state.roomId}`);
                            this.activeConnections.set(uniqueId, {
                                wrapper: wrapper,
                                startTime: new Date(),
                                lastEventTime: Date.now(),
                                pendingWrites: new Set(),
                                roomId: state.roomId
                            });

                            if (state.roomId) {
                                manager.setNumericRoomId(uniqueId, state.roomId).catch(console.error);
                            }

                            this.setupLogging(wrapper, uniqueId, state.roomId);

                            wrapper.once('disconnected', reason => {
                                console.log(`[AutoRecorder] ${uniqueId} disconnected after connection: ${reason}`);
                                this.handleDisconnect(uniqueId, reason);
                            });

                            wrapper.connection.on('streamEnd', () => {
                                console.log(`[AutoRecorder] ${uniqueId} stream ended.`);
                                this.handleDisconnect(uniqueId, 'streamEnd');
                            });

                            resolve({ success: true, state });
                        });

                        wrapper.once('disconnected', reason => {
                            if (!connected) {
                                clearTimeout(timeout);
                                reject(new Error(reason));
                            }
                        });

                        wrapper.connect().catch(err => {
                            if (!connected) {
                                clearTimeout(timeout);
                                reject(err);
                            }
                        });
                    });

                    return result; // Success!

                } catch (err) {
                    lastError = err;
                    const errStr = String(err?.message || err || '');
                    const isRetryable = errStr.includes('504') ||
                        errStr.includes('500') ||
                        errStr.includes('408') ||
                        errStr.includes('Unexpected server response: 200') ||
                        errStr.includes('Sign Error') ||
                        errStr.includes('SignAPIError');

                    if (isRetryable && attempt < maxRetries) {
                        const delay = 2000 * attempt; // 2s, 4s, 6s
                        console.log(`[AutoRecorder] ${uniqueId} attempt ${attempt}/${maxRetries} failed: ${errStr.slice(0, 60)}... Retrying in ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                        continue; // Try again with new wrapper
                    }

                    // Non-retryable or max retries reached
                    throw err;
                }
            }

            throw lastError || new Error('Connection failed after all retries');
        })();

        this.connectingRooms.set(uniqueId, connectTask);
        try {
            return await connectTask;
        } catch (err) {
            console.error(`[AutoRecorder] Error starting ${uniqueId}:`, err?.message || err);
            throw err;
        } finally {
            if (this.connectingRooms.get(uniqueId) === connectTask) {
                this.connectingRooms.delete(uniqueId);
            }
        }
    }

    // Manually stop a recording session
    async disconnectRoom(uniqueId) {
        const pendingDisconnect = this.disconnectingRooms.get(uniqueId);
        if (pendingDisconnect) {
            console.log(`[AutoRecorder] Disconnect already in progress for ${uniqueId}, waiting...`);
            try { await pendingDisconnect; } catch (e) { }
            return true;
        }

        // If a connect attempt is in-flight, wait for it to finish before trying to disconnect.
        const pendingConnect = this.connectingRooms.get(uniqueId);
        if (pendingConnect && !this.activeConnections.has(uniqueId)) {
            console.log(`[AutoRecorder] Disconnect requested for ${uniqueId} while connecting, waiting for connect attempt...`);
            try { await pendingConnect; } catch (e) { }
        }

        if (this.activeConnections.has(uniqueId)) {
            console.log(`[AutoRecorder] Manual stop requested for ${uniqueId}`);
            // Manual stop: archive immediately (don't wait 30 min)
            await this.handleDisconnect(uniqueId, 'Manual stop', true);
            return true;
        }
        return false;
    }

    async handleDisconnect(uniqueId, reason = '', immediate = false) {
        // Idempotent: only one disconnect/archive task per room at a time.
        if (this.disconnectingRooms.has(uniqueId)) {
            return this.disconnectingRooms.get(uniqueId);
        }

        const task = (async () => {
            try {
                if (!this.activeConnections.has(uniqueId)) {
                    return;
                }

                const conn = this.activeConnections.get(uniqueId);
                const { wrapper, startTime, pendingWrites } = conn;
                const startIso = startTime instanceof Date ? startTime.toISOString() : new Date().toISOString();

                // Stop recording first (prevents new events while we are tagging this session)
                try {
                    wrapper.disconnect();
                } catch (e) { }

                this.activeConnections.delete(uniqueId);

                // Flush any in-flight DB writes (best-effort) so the final events are included in the session.
                try {
                    if (pendingWrites && pendingWrites.size > 0) {
                        const flushTimeoutMs = 1500;
                        console.log(`[AutoRecorder] Waiting for ${pendingWrites.size} pending DB writes for ${uniqueId}...`);
                        await Promise.race([
                            Promise.allSettled(Array.from(pendingWrites)),
                            new Promise(resolve => setTimeout(resolve, flushTimeoutMs))
                        ]);
                    }
                } catch (e) { }

                // Check if there are any events to save before creating session
                const rawEventCount = await manager.getUntaggedEventCount(uniqueId, startIso);
                const eventCount = parseInt(rawEventCount) || 0;

                if (eventCount === 0) {
                    console.log(`[AutoRecorder] No events recorded for ${uniqueId}, skipping session.`);
                    return;
                }

                // STRICTER: Only create session if there are GIFT events (not just member/chat)
                const giftCount = await manager.getUntaggedGiftCount(uniqueId, startIso);
                if (giftCount === 0) {
                    console.log(`[AutoRecorder] No gift events for ${uniqueId} (${eventCount} other events), skipping session.`);
                    return;
                }

                // === DELAYED ARCHIVING LOGIC ===
                // If immediate=true (manual stop), archive now
                // Otherwise, set a timer to archive after 30 minutes

                if (immediate) {
                    console.log(`[AutoRecorder] 🔒 Immediate archive for ${uniqueId} (${reason})...`);
                    await this.executeArchive(uniqueId, startIso, reason, eventCount);
                } else {
                    // Check if there's already a pending archive for this room
                    const existing = this.pendingArchives.get(uniqueId);
                    if (existing && existing.timerId) {
                        // Clear old timer and update with new disconnect time
                        clearTimeout(existing.timerId);
                        console.log(`[AutoRecorder] ⏰ Resetting archive timer for ${uniqueId}`);
                    }

                    // Set delayed archive timer
                    const timerId = setTimeout(() => {
                        this.executeArchive(uniqueId, startIso, reason, eventCount).catch(err => {
                            console.error(`[AutoRecorder] Delayed archive failed for ${uniqueId}:`, err?.message);
                        });
                    }, this.ARCHIVE_DELAY_MS);

                    // Store pending archive info
                    this.pendingArchives.set(uniqueId, {
                        startTime: startTime,
                        startIso: startIso,
                        disconnectTime: Date.now(),
                        timerId: timerId,
                        eventCount: eventCount,
                        reason: reason
                    });

                    console.log(`[AutoRecorder] ⏰ Session for ${uniqueId} will be archived in 30 min (${eventCount} events). Reconnection will resume.`);
                }

            } catch (err) {
                console.error(`[AutoRecorder] handleDisconnect failed for ${uniqueId}: ${err?.message || err}`);
            }
        })();

        this.disconnectingRooms.set(uniqueId, task);

        try {
            await task;
        } finally {
            if (this.disconnectingRooms.get(uniqueId) === task) {
                this.disconnectingRooms.delete(uniqueId);
            }
        }

        return task;
    }

    // Execute the actual session archiving
    async executeArchive(uniqueId, startIso, reason, eventCount) {
        // Check if this archive was cancelled (room reconnected)
        const pending = this.pendingArchives.get(uniqueId);
        if (pending && pending.startIso !== startIso) {
            console.log(`[AutoRecorder] Archive cancelled for ${uniqueId} (session resumed with new startIso)`);
            return;
        }

        // Clean up pending archive entry
        this.pendingArchives.delete(uniqueId);

        // Re-check event counts in case more events arrived during the delay
        const finalEventCount = await manager.getUntaggedEventCount(uniqueId, startIso);
        const finalGiftCount = await manager.getUntaggedGiftCount(uniqueId, startIso);

        if (finalGiftCount === 0) {
            console.log(`[AutoRecorder] No gift events for ${uniqueId} at archive time, skipping.`);
            return;
        }

        console.log(`[AutoRecorder] 📦 Archiving session for ${uniqueId} (${finalEventCount} events, ${finalGiftCount} gifts)...`);
        try {
            const sessionId = await manager.createSession(uniqueId, {
                auto_generated: true,
                reason: reason || undefined,
                note: `Auto recorded session (${finalEventCount} events)`
            });

            await manager.tagEventsWithSession(uniqueId, sessionId, startIso);
            console.log(`[AutoRecorder] ✅ Session saved: ${sessionId}`);

        } catch (err) {
            console.error(`[AutoRecorder] Error saving session: ${err?.message || err}`);
        }
    }
}

module.exports = { AutoRecorder };
