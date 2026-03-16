
const { TikTokConnectionWrapper } = require('./connectionWrapper');
const db = require('./db');
const { manager } = require('./manager');
const {
    getSessionMaintenanceConfig,
    runSessionMaintenanceTask,
    recordSessionMaintenanceEvent,
} = require('./services/sessionMaintenanceService');
const { getSchemeAConfig } = require('./services/featureFlagService');
const keyManager = require('./utils/keyManager');
const dynamicProxyManager = require('./utils/DynamicProxyManager');
const liveStateService = require('./services/liveStateService');
const { invalidateRoomDetailCaches } = require('./services/roomDetailCacheService');
const { getLivePageSnapshot, fetchLivePageHtml, extractLivePageSnapshotFromHtml } = require('./utils/tiktok_spider');

const LIVE_ROOM_RECENT_EVENT_WINDOW_MS = 2 * 60 * 1000;
const LIVE_ROOM_HEALTH_CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const LIVE_ROOM_OFFLINE_CONFIRM_MS = 2 * 60 * 1000;
const LIVE_ROOM_RECYCLE_STALE_MS = 10 * 60 * 1000;
const LIVE_ROOM_CHECK_ALIVE_TIMEOUT_MS = 15 * 1000;
const AUTO_MONITOR_PRECHECK_CONCURRENCY_CAP = 12;
const AUTO_MONITOR_PRECHECK_CONCURRENCY_FLOOR = 6;
const AUTO_MONITOR_PRECHECK_BATCH_GAP_MS = 200;
const AUTO_MONITOR_CONNECT_START_GAP_MS = 1500;
const AUTO_MONITOR_CONNECT_RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 1000;
const AUTO_MONITOR_PRECHECK_FAILURE_COOLDOWN_MS = 60 * 1000;
const AUTO_MONITOR_RETRYABLE_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const AUTO_MONITOR_PRECHECK_RETRY_DELAY_MS = 1200;
const AUTO_MONITOR_PROBE_UNAVAILABLE_DIRECT_CONNECT_MAX_PER_CYCLE = 4;
const AUTO_MONITOR_PROBE_UNAVAILABLE_DIRECT_CONNECT_MIN_SCORE = 35;
const AUTO_MONITOR_BLOCKED_PROBE_CACHED_ROOM_CONNECT_MAX_PER_CYCLE = 6;
const AUTO_MONITOR_SCHEDULE_PROFILE_CACHE_TTL_MS = 30 * 60 * 1000;
const AUTO_MONITOR_SCHEDULE_LOOKBACK_DAYS = 21;
const AUTO_MONITOR_SCHEDULE_MAX_SESSIONS_PER_ROOM = 12;
const AUTO_MONITOR_SCHEDULE_NEARBY_WINDOW_HOURS = 1;
const AUTO_MONITOR_SCHEDULE_SHOULDER_WINDOW_HOURS = 2;
const AUTO_MONITOR_FAILURE_HISTORY_LIMIT = 60;
const AUTO_MONITOR_DYNAMIC_PROFILE_SETTING_KEY = '_auto_monitor_dynamic_profiles';
const AUTO_MONITOR_DYNAMIC_PROFILE_CACHE_TTL_MS = 60 * 1000;
const AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE = 'blocked_probe_connectable';
const AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TTL_MS = 12 * 60 * 60 * 1000;
const AUTO_MONITOR_BLOCKED_PROBE_PROFILE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const AUTO_MONITOR_BLOCKED_PROBE_PROFILE_SUCCESS_SCORE = 18;
const AUTO_MONITOR_BLOCKED_PROBE_PROFILE_FAILURE_PENALTY = 12;
const AUTO_MONITOR_BLOCKED_PROBE_PROFILE_PROBE_RECOVERY_PENALTY = 8;
const AUTO_MONITOR_BLOCKED_PROBE_PROFILE_OFFLINE_PENALTY = 18;
const AUTO_MONITOR_BLOCKED_PROBE_PROFILE_STALE_EVICT_MS = 6 * 60 * 60 * 1000;
const BEIJING_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function getBeijingHour(value) {
    const date = value instanceof Date ? value : new Date(value);
    const timeMs = date.getTime();
    if (!Number.isFinite(timeMs)) return null;
    const beijingDate = new Date(timeMs + BEIJING_TZ_OFFSET_MS);
    return beijingDate.getUTCHours();
}

function getCircularHourDistance(leftHour, rightHour) {
    const left = Number(leftHour);
    const right = Number(rightHour);
    if (!Number.isInteger(left) || !Number.isInteger(right)) return Number.POSITIVE_INFINITY;
    const rawDistance = Math.abs(left - right);
    return Math.min(rawDistance, 24 - rawDistance);
}

function clampNumber(value, min, max) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return min;
    }
    return Math.max(min, Math.min(max, normalized));
}

function isExpiredTimestamp(value, now = Date.now()) {
    const timestamp = value ? new Date(value).getTime() : 0;
    return !Number.isFinite(timestamp) || timestamp <= now;
}

function enumerateTouchedBeijingHours(startValue, endValue) {
    const start = startValue instanceof Date ? startValue : new Date(startValue);
    const end = endValue instanceof Date ? endValue : new Date(endValue);
    const startMs = start.getTime();
    const endMs = end.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return [];
    }

    const normalizedEndMs = endMs >= startMs ? endMs : startMs;
    const durationMs = Math.max(0, normalizedEndMs - startMs);
    const maxSteps = Math.max(1, Math.min(12, Math.ceil(durationMs / (60 * 60 * 1000)) + 1));
    const hours = [];
    const seen = new Set();

    for (let step = 0; step < maxSteps; step += 1) {
        const hour = getBeijingHour(startMs + step * 60 * 60 * 1000);
        if (!Number.isInteger(hour) || seen.has(hour)) continue;
        seen.add(hour);
        hours.push(hour);
    }

    if (hours.length === 0) {
        const fallbackHour = getBeijingHour(startMs);
        if (Number.isInteger(fallbackHour)) {
            hours.push(fallbackHour);
        }
    }

    return hours;
}

function compactHoursToRanges(hours = []) {
    const normalizedHours = Array.from(new Set((hours || [])
        .map((hour) => Number(hour))
        .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)))
        .sort((left, right) => left - right);

    if (normalizedHours.length === 0) {
        return [];
    }

    const ranges = [];
    let rangeStart = normalizedHours[0];
    let previous = normalizedHours[0];

    for (let index = 1; index < normalizedHours.length; index += 1) {
        const current = normalizedHours[index];
        if (current === previous + 1) {
            previous = current;
            continue;
        }

        ranges.push({ startHour: rangeStart, endHour: previous });
        rangeStart = current;
        previous = current;
    }

    ranges.push({ startHour: rangeStart, endHour: previous });

    if (ranges.length >= 2 && ranges[0].startHour === 0 && ranges[ranges.length - 1].endHour === 23) {
        const head = ranges.shift();
        const tail = ranges.pop();
        ranges.unshift({
            startHour: tail.startHour,
            endHour: head.endHour,
            wrapsMidnight: true,
        });
    }

    return ranges;
}

async function fetchRoomAliveStatus(numericRoomId) {
    const roomId = String(numericRoomId || '').trim();
    if (!roomId) {
        return { ok: false, alive: null, roomId: null, error: 'missing room id' };
    }

    const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_ROOM_CHECK_ALIVE_TIMEOUT_MS);

    try {
        const response = await fetch(
            `https://webcast.tiktok.com/webcast/room/check_alive/?aid=1988&room_ids=${encodeURIComponent(roomId)}`,
            {
                headers: {
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'accept': 'application/json, text/plain, */*',
                    'referer': 'https://www.tiktok.com/',
                },
                signal: controller.signal,
            }
        );

        const body = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        if (!body) {
            throw new Error('Empty response body');
        }

        const payload = JSON.parse(body);
        const rows = Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.room_alive_list)
                ? payload.room_alive_list
                : [];

        const matched = rows.find((item) => {
            const candidate = String(item?.room_id ?? item?.roomId ?? item?.id ?? '').trim();
            return candidate === roomId;
        }) || rows[0] || null;

        const rawAlive = matched?.alive
            ?? matched?.is_alive
            ?? payload?.alive
            ?? payload?.data?.alive
            ?? null;

        if (rawAlive === null || rawAlive === undefined) {
            throw new Error('Missing alive field');
        }

        const normalized = String(rawAlive).trim().toLowerCase();
        const alive = rawAlive === true || rawAlive === 1 || normalized === 'true' || normalized === '1';

        return {
            ok: true,
            alive,
            roomId,
        };
    } catch (error) {
        return {
            ok: false,
            alive: null,
            roomId,
            error: error?.message || String(error),
        };
    } finally {
        clearTimeout(timeout);
    }
}

function getConnectErrorText(error) {
    const collect = (value) => {
        if (!value) return '';
        const parts = [];
        if (typeof value.message === 'string') parts.push(value.message);
        if (typeof value.info === 'string') parts.push(value.info);
        if (typeof value.name === 'string') parts.push(value.name);
        if (typeof value.toString === 'function') parts.push(value.toString());
        return parts.join(' ');
    };

    return [
        collect(error),
        collect(error?.exception),
        Array.isArray(error?.errors) ? error.errors.map(collect).join(' ') : '',
    ].filter(Boolean).join(' ');
}

function isRetryableCachedRoomIdError(errorText = '') {
    const normalized = String(errorText || '');
    return normalized.includes('UserOfflineError') ||
        normalized.includes("isn't online") ||
        normalized.includes('Room is offline') ||
        normalized.includes('Unexpected server response: 200') ||
        normalized.includes('Websocket connection failed') ||
        normalized.includes('Connection Timeout');
}

function isRoomIdResolutionFailure(errorText = '') {
    const normalized = String(errorText || '').toLowerCase();
    return normalized.includes('room id') ||
        normalized.includes('fetchisliveerror') ||
        normalized.includes('sigi_state') ||
        normalized.includes('failed to extract') ||
        normalized.includes('could not extract live page snapshot') ||
        normalized.includes('invalid response from api') ||
        normalized.includes('failed to retrieve live status from all sources');
}

function isRetryableAutoConnectError(errorText = '') {
    const normalized = String(errorText || '');
    return normalized.includes('504') ||
        normalized.includes('500') ||
        normalized.includes('408') ||
        normalized.includes('Unexpected server response: 200') ||
        normalized.includes('Websocket connection failed') ||
        normalized.includes('Connection Timeout') ||
        normalized.includes('Sign Error') ||
        normalized.includes('SignAPIError');
}

function isConnectionStartRateLimitedError(errorText = '') {
    const normalized = String(errorText || '').toLowerCase();
    return normalized.includes('too many connections started') ||
        normalized.includes('signatureratelimiterror') ||
        normalized.includes('[rate limited]');
}

function extractApiLiveStatus(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const candidates = [
        payload.status,
        payload.data?.status,
        payload.data?.liveRoom?.status,
        payload.liveRoom?.status,
        payload.liveRoomUserInfo?.liveRoom?.status,
    ];

    for (const value of candidates) {
        const normalized = Number(value);
        if (Number.isFinite(normalized)) {
            return normalized;
        }
    }

    return null;
}

function isMaintenanceWorkerEnabled() {
    return Boolean(getSchemeAConfig().worker.enableMaintenance);
}

class AutoRecorder {
    constructor() {
        this.recordingManager = null; // Injected via setter
        this.defaultInterval = 300 * 1000;

        this.monitoring = true;
        this.activeConnections = new Map(); // roomId -> { wrapper, startTime, lastEventTime }

        // In-flight operations (avoid connect/disconnect races per room)
        this.connectingRooms = new Map();    // roomId -> Promise (connect attempt)
        this.disconnectingRooms = new Map(); // roomId -> Promise (disconnect + archive)

        // Failure tracking for auto-disable
        this.failureCount = new Map();       // roomId -> consecutive failure count
        this.pendingOffline = new Map();     // roomId -> timestamp (for heartbeat double-check)
        this.connectCooldowns = new Map();   // roomId -> retry timestamp
        this.connectCooldownMeta = new Map();// roomId -> { reason, updatedAt }
        this.globalConnectCooldownUntil = 0;
        this.globalConnectCooldownReason = null;
        this.globalConnectCooldownSetAt = null;
        this.lastConnectStartAt = 0;
        this.connectStartQueue = Promise.resolve();
        this.precheckedLiveRooms = new Map(); // roomId -> { expiresAt, numericRoomId, source, updatedAt }
        this.roomScheduleProfiles = new Map(); // roomId -> derived live-time windows
        this.roomScheduleProfilesLoadedAt = 0;
        this.dynamicRoomProfiles = new Map(); // roomId -> short-lived dynamic monitor hints
        this.dynamicRoomProfilesLoadedAt = 0;
        this.dynamicRoomProfilesSavePromise = Promise.resolve();
        this.roomMonitorScanState = new Map(); // roomId -> { lastScheduledAt, bucket, score }
        this.recentMonitorFailures = [];

        // Session resume: track recent disconnects to allow 30-min resume
        // roomId -> { startTime, startIso, disconnectTime, timerId }
        // Delayed archiving: sessions are archived 30 min after disconnect unless reconnection happens
        this.pendingArchives = new Map();
        this.ARCHIVE_DELAY_MS = 30 * 60 * 1000; // 30 minutes
        this.sessionMaintenanceConfig = null;
        this.maintenanceTimers = {
            staleCleanup: null,
            consolidation: null,
        };
        this.maintenanceScheduleMeta = {
            staleCleanupNextRunAt: null,
            consolidationNextRunAt: null,
        };

        this.timer = null;
        this.heartbeatTimer = null;

        // Delay initial check to not block server startup
        setTimeout(() => this.startLoop(), 2000);

        // Start heartbeat check every 60 seconds
        this.startHeartbeat();

        // Restore any saved connection state from previous run
        this.restoreConnectionState();

        // Register shutdown handler to save state
        this.registerShutdownHandler();

        console.log(`[AutoRecorder] Service started.`);
    }

    // Save active connection state before shutdown
    async saveConnectionState() {
        const state = [];
        for (const [uniqueId, conn] of this.activeConnections.entries()) {
            const wsConnected = conn?.wrapper?.connection?.isConnected === true;
            if (conn?.liveValidated !== true || !wsConnected) {
                continue;
            }
            state.push({
                uniqueId,
                startTime: conn.startTime?.toISOString(),
                roomId: conn.roomId,
                lastEventTime: conn.lastEventTime,
                lastConfirmedLiveAt: conn.lastConfirmedLiveAt || null,
            });
        }

        try {
            if (state.length > 0) {
                await manager.saveSetting('_connection_state', JSON.stringify(state));
                console.log(`[AutoRecorder] Saved ${state.length} active connections for restart`);
                return;
            }

            await manager.saveSetting('_connection_state', '');
            console.log('[AutoRecorder] No validated active connections to save for restart');
        } catch (err) {
            console.error('[AutoRecorder] Failed to save connection state:', err.message);
        }
    }

    // Restore connection state from previous run
    async restoreConnectionState() {
        try {
            const stateStr = await manager.getSetting('_connection_state', '');
            if (!stateStr) return;

            const state = JSON.parse(stateStr);
            if (!Array.isArray(state) || state.length === 0) return;

            console.log(`[AutoRecorder] Found ${state.length} saved connections from previous run`);

            // Store restored state for later processing after rooms are loaded
            this.restoredConnections = state;

            // Clear the saved state (one-time restore)
            await manager.saveSetting('_connection_state', '');
        } catch (err) {
            console.error('[AutoRecorder] Failed to restore connection state:', err.message);
        }
    }

    // Process restored connections - call this after monitor() first run
    async processRestoredConnections() {
        if (!this.restoredConnections || this.restoredConnections.length === 0) return;

        const restored = this.restoredConnections;
        this.restoredConnections = null;

        console.log(`[AutoRecorder] Processing ${restored.length} restored connections...`);

        for (const saved of restored) {
            // Skip if already connected
            if (this.activeConnections.has(saved.uniqueId)) continue;
            if (this.connectingRooms.has(saved.uniqueId)) continue;

            // Restore the startTime for session continuity
            const restoredStartTime = saved.startTime ? new Date(saved.startTime) : null;

            // Check if room is actually live and connect if so
            try {
                const room = { roomId: saved.uniqueId, name: saved.uniqueId };

                // Set the restored startTime before connecting
                this._restoredStartTime = restoredStartTime;
                await this.checkAndConnect(room);
                this._restoredStartTime = null;

            } catch (err) {
                console.log(`[AutoRecorder] Could not restore ${saved.uniqueId}: ${err.message}`);
            }
        }
    }

    // Register shutdown handler
    registerShutdownHandler() {
        const shutdown = async (signal) => {
            if (global.__TIKTOK_MONITOR_APP_MANAGES_SHUTDOWN__ || global.__TIKTOK_MONITOR_APP_SHUTTING_DOWN__) {
                console.log(`[AutoRecorder] Received ${signal}, app-level graceful shutdown will handle connection state.`);
                return;
            }
            console.log(`\n[AutoRecorder] Received ${signal}, saving connection state...`);
            await this.saveConnectionState();
            process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    }

    // Get list of VALIDATED live room IDs (only rooms with actual events or passed 65s validation)
    getLiveRoomIds() {
        const validatedLive = [];
        const now = Date.now();

        for (const [roomId, conn] of this.activeConnections.entries()) {
            if (this.isConnectionLiveForRoomList(roomId, conn, now)) {
                validatedLive.push(roomId);
            }
        }

        return validatedLive;
    }

    getTrackedRoomIds() {
        return Array.from(this.activeConnections.keys());
    }

    isConnectionSocketAlive(uniqueId) {
        const conn = this.activeConnections.get(uniqueId);
        return conn?.wrapper?.connection?.isConnected === true;
    }

    async recoverStaleActiveConnection(uniqueId, reason = 'stale-active') {
        const normalizedRoomId = String(uniqueId || '').trim();
        if (!normalizedRoomId) return false;

        const conn = this.activeConnections.get(normalizedRoomId);
        if (!conn) return false;

        const wsConnected = conn.wrapper?.connection?.isConnected === true;
        if (wsConnected) {
            return false;
        }

        if (this.disconnectingRooms.has(normalizedRoomId) || this.connectingRooms.has(normalizedRoomId)) {
            console.log(`[AutoRecorder] ${normalizedRoomId} stale connection recovery skipped (${reason}); room already transitioning.`);
            return true;
        }

        console.warn(`[AutoRecorder] ${normalizedRoomId} has stale active connection (${reason}). Recycling tracked state for auto-reconnect.`);

        try {
            try {
                conn.wrapper?.disconnect?.();
            } catch (disconnectError) {
                console.warn(`[AutoRecorder] Failed to disconnect stale wrapper for ${normalizedRoomId}:`, disconnectError?.message || disconnectError);
            }

            this.activeConnections.delete(normalizedRoomId);
            this.pendingOffline.delete(normalizedRoomId);
            await liveStateService.markRoomOffline(normalizedRoomId, {
                lastEventAt: conn.lastEventTime ? new Date(conn.lastEventTime).toISOString() : undefined,
            });
        } catch (error) {
            console.error(`[AutoRecorder] Failed to recycle stale connection for ${normalizedRoomId}:`, error?.message || error);
        }

        return true;
    }

    async ensureAutoRecordingForRoom(uniqueId, connectedRoomId, roomConfig = null, trigger = 'auto-connect') {
        if (!this.recordingManager) return false;
        if (!connectedRoomId) {
            console.warn(`[AutoRecorder] ${uniqueId} connected without numeric room id during ${trigger}, skipping auto-recording.`);
            return false;
        }

        const room = roomConfig || await manager.getRoom(uniqueId).catch(() => null);
        const recordingEnabled = Number(room?.isRecordingEnabled ?? room?.is_recording_enabled ?? 0) === 1;
        if (!recordingEnabled) {
            return false;
        }

        if (this.recordingManager.isRecording(connectedRoomId)) {
            return true;
        }

        const recordingAccountId = room?.recordingAccountId ?? room?.recording_account_id ?? null;
        console.log(`[AutoRecorder] 🎥 Auto-starting recording for ${uniqueId} via ${trigger} (Account: ${recordingAccountId || 'None'})`);

        try {
            const result = await this.recordingManager.startRecording(connectedRoomId, uniqueId, recordingAccountId);
            if (result?.success === false && !String(result.error || '').includes('Already recording')) {
                console.warn(`[AutoRecorder] Auto-recording start returned failure for ${uniqueId}: ${result.error || 'unknown error'}`);
                return false;
            }
            return true;
        } catch (error) {
            console.error(`[AutoRecorder] Failed to start auto-recording for ${uniqueId}:`, error?.message || error);
            return false;
        }
    }

    markPrecheckedRoomLive(uniqueId, numericRoomId, options = {}) {
        const normalizedRoomId = String(uniqueId || '').trim();
        if (!normalizedRoomId) return false;

        const ttlMs = Math.max(60 * 1000, Number(options.ttlMs) || 0);
        this.precheckedLiveRooms.set(normalizedRoomId, {
            expiresAt: Date.now() + ttlMs,
            numericRoomId: String(numericRoomId || '').trim() || null,
            source: options.source || 'precheck',
            updatedAt: Date.now(),
        });
        return true;
    }

    clearPrecheckedRoomLive(uniqueId) {
        const normalizedRoomId = String(uniqueId || '').trim();
        if (!normalizedRoomId) return false;
        return this.precheckedLiveRooms.delete(normalizedRoomId);
    }

    getPrecheckedLiveRoomIds(now = Date.now()) {
        const roomIds = [];
        for (const [roomId, entry] of this.precheckedLiveRooms.entries()) {
            const expiresAt = Number(entry?.expiresAt) || 0;
            if (expiresAt <= now) {
                this.precheckedLiveRooms.delete(roomId);
                continue;
            }
            roomIds.push(roomId);
        }
        return roomIds;
    }

    isRoomPrecheckedLive(uniqueId, now = Date.now()) {
        const normalizedRoomId = String(uniqueId || '').trim();
        if (!normalizedRoomId) return false;
        const entry = this.precheckedLiveRooms.get(normalizedRoomId);
        if (!entry) return false;
        const expiresAt = Number(entry.expiresAt) || 0;
        if (expiresAt <= now) {
            this.precheckedLiveRooms.delete(normalizedRoomId);
            return false;
        }
        return true;
    }

    isConnectCooldownActive(uniqueId) {
        return this.getConnectCooldownInfo(uniqueId).active;
    }

    setConnectCooldown(uniqueId, delayMs, reason = 'retry-later') {
        const normalizedRoomId = String(uniqueId || '').trim();
        if (!normalizedRoomId) return;

        const safeDelayMs = Math.max(1000, Number(delayMs) || 0);
        const until = Date.now() + safeDelayMs;
        this.connectCooldowns.set(normalizedRoomId, until);
        this.connectCooldownMeta.set(normalizedRoomId, {
            reason,
            updatedAt: new Date().toISOString(),
        });
        console.log(`[AutoRecorder] ${normalizedRoomId} enter connect cooldown ${Math.round(safeDelayMs / 1000)}s (${reason}).`);
    }

    isGlobalConnectCooldownActive() {
        return this.getGlobalConnectCooldownSnapshot().active;
    }

    setGlobalConnectCooldown(delayMs, reason = 'connect-rate-limit') {
        const safeDelayMs = Math.max(1000, Number(delayMs) || 0);
        const nextUntil = Date.now() + safeDelayMs;
        this.globalConnectCooldownUntil = Math.max(this.globalConnectCooldownUntil || 0, nextUntil);
        this.globalConnectCooldownReason = reason;
        this.globalConnectCooldownSetAt = new Date().toISOString();
        console.warn(`[AutoRecorder] Global connect cooldown ${Math.round(safeDelayMs / 1000)}s (${reason}).`);
    }

    async waitForConnectStartSlot(uniqueId) {
        const run = async () => {
            const notBefore = Math.max(
                this.isGlobalConnectCooldownActive() ? this.globalConnectCooldownUntil : 0,
                (this.lastConnectStartAt || 0) + AUTO_MONITOR_CONNECT_START_GAP_MS
            );
            const waitMs = Math.max(0, notBefore - Date.now());
            if (waitMs > 0) {
                console.log(`[AutoRecorder] Waiting ${waitMs}ms before starting connection for ${uniqueId}.`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
            this.lastConnectStartAt = Date.now();
        };

        const task = this.connectStartQueue.then(run, run);
        this.connectStartQueue = task.catch(() => { });
        await task;
    }

    async probeRoomLiveState(uniqueId, cachedRoomId, options = {}) {
        const normalizedUniqueId = String(uniqueId || '').trim();
        const normalizedCachedRoomId = String(cachedRoomId || '').trim() || null;
        const proxyUrl = options.proxyUrl || null;
        const eulerApiKey = options.eulerApiKey || null;

        if (normalizedCachedRoomId) {
            const aliveStatus = await fetchRoomAliveStatus(normalizedCachedRoomId);
            if (aliveStatus.ok && aliveStatus.alive === true) {
                return {
                    shouldConnect: true,
                    numericRoomId: normalizedCachedRoomId,
                    source: 'check_alive_cached',
                };
            }
        }

        let snapshot = null;
        let snapshotError = null;

        try {
            snapshot = await getLivePageSnapshot(normalizedUniqueId, proxyUrl, null);
        } catch (error) {
            snapshotError = error;
        }

        if (!snapshot) {
            try {
                await new Promise(resolve => setTimeout(resolve, AUTO_MONITOR_PRECHECK_RETRY_DELAY_MS));
                const html = await fetchLivePageHtml(normalizedUniqueId, proxyUrl, null);
                const extracted = extractLivePageSnapshotFromHtml(html);
                if (extracted) {
                    snapshot = {
                        uniqueId: normalizedUniqueId,
                        html,
                        ...extracted,
                    };
                }
            } catch (retryError) {
                snapshotError = retryError || snapshotError;
            }
        }

        if (!snapshot) {
            try {
                const probeWrapper = new TikTokConnectionWrapper(normalizedUniqueId, {
                    enableExtendedGiftInfo: false,
                    fetchRoomInfoOnConnect: false,
                    preferEulerRoomLookup: false,
                    proxyUrl,
                    eulerApiKey,
                }, false);
                const apiRoomInfo = await probeWrapper.connection?.webClient?.fetchRoomInfoFromApiLive?.({ uniqueId: normalizedUniqueId });
                const apiRoomId = String(apiRoomInfo?.data?.user?.roomId || apiRoomInfo?.data?.liveRoom?.roomId || '').trim() || null;
                const apiStatus = extractApiLiveStatus(apiRoomInfo);

                if (apiRoomId) {
                    const aliveStatus = await fetchRoomAliveStatus(apiRoomId);
                    if (aliveStatus.ok && aliveStatus.alive === true) {
                        if (apiRoomId !== normalizedCachedRoomId) {
                            await manager.setNumericRoomId(normalizedUniqueId, apiRoomId).catch((error) => {
                                console.warn(`[AutoRecorder] Failed to refresh numeric room id from API for ${normalizedUniqueId}:`, error?.message || error);
                            });
                        }

                        return {
                            shouldConnect: true,
                            numericRoomId: apiRoomId,
                            source: 'api_live_room_info',
                            liveStatus: apiStatus,
                        };
                    }

                    return {
                        shouldConnect: false,
                        numericRoomId: apiRoomId,
                        source: 'api_live_room_info_offline',
                        liveStatus: apiStatus,
                    };
                }
            } catch (apiError) {
                snapshotError = apiError || snapshotError;
            }

            return {
                shouldConnect: false,
                numericRoomId: normalizedCachedRoomId,
                source: 'snapshot_unavailable',
                liveStatus: null,
                error: snapshotError?.message || 'live snapshot unavailable',
            };
        }

        const snapshotRoomId = String(snapshot?.roomId || '').trim() || null;
        const snapshotStatus = Number(snapshot?.status);
        const isStrictlyLive = Number.isFinite(snapshotStatus) && snapshotStatus === 2;

        if (isStrictlyLive && snapshotRoomId && snapshotRoomId !== normalizedCachedRoomId) {
            await manager.setNumericRoomId(normalizedUniqueId, snapshotRoomId).catch((error) => {
                console.warn(`[AutoRecorder] Failed to refresh numeric room id for ${normalizedUniqueId}:`, error?.message || error);
            });
        }

        if (!isStrictlyLive || !snapshotRoomId) {
            return {
                shouldConnect: false,
                numericRoomId: snapshotRoomId,
                source: 'snapshot_offline',
                liveStatus: Number.isFinite(snapshotStatus) ? snapshotStatus : null,
            };
        }

        return {
            shouldConnect: true,
            numericRoomId: snapshotRoomId,
            source: 'snapshot_live',
            liveStatus: snapshotStatus,
        };
    }

    isConnectionLiveForRoomList(roomId, conn, now = Date.now()) {
        if (!conn) return false;

        const wsConnected = conn.wrapper?.connection?.isConnected === true;
        if (!wsConnected) return false;

        const startTimeMs = conn.startTime?.getTime() || now;
        const lastEventTime = Number(conn.lastEventTime) || 0;
        const connectionAge = now - startTimeMs;
        const hasReceivedEvents = lastEventTime > (startTimeMs + 1000);

        if (hasReceivedEvents && (now - lastEventTime) <= LIVE_ROOM_RECENT_EVENT_WINDOW_MS) {
            return true;
        }

        const pendingSince = Number(this.pendingOffline.get(roomId)) || 0;
        if (pendingSince > 0 && (now - pendingSince) >= LIVE_ROOM_OFFLINE_CONFIRM_MS) {
            return false;
        }

        const lastConfirmedLiveAt = Number(conn.lastConfirmedLiveAt) || 0;
        return conn.liveValidated === true
            && lastConfirmedLiveAt > 0
            && (now - lastConfirmedLiveAt) <= LIVE_ROOM_HEALTH_CONFIRM_WINDOW_MS;
    }

    async promoteConnectionToLive(uniqueId, patch = {}, reason = 'runtime') {
        const conn = this.activeConnections.get(uniqueId);
        if (!conn) {
            return false;
        }

        this.clearPrecheckedRoomLive(uniqueId);
        const now = Date.now();
        conn.lastConfirmedLiveAt = now;

        const livePatch = {
            ...patch,
            lastEventAt: patch.lastEventAt || new Date(now).toISOString(),
        };

        if (conn.liveValidated === true) {
            await liveStateService.touchRoomLive(uniqueId, livePatch);
            return true;
        }

        conn.liveValidated = true;
        const resetAggregates = conn.pendingLiveResetAggregates !== false;
        conn.pendingLiveResetAggregates = false;

        await liveStateService.markRoomLive(uniqueId, {
            ...livePatch,
            resetAggregates,
        });

        console.log(`[AutoRecorder] ${uniqueId} live confirmed via ${reason}.`);
        return true;
    }

    async confirmConnectionLive(uniqueId, reason = 'connect', patch = {}) {
        const conn = this.activeConnections.get(uniqueId);
        if (!conn) {
            return false;
        }

        const numericRoomId = String(conn.roomId || '').trim();
        if (!numericRoomId) {
            return false;
        }

        const aliveStatus = await fetchRoomAliveStatus(numericRoomId);
        if (aliveStatus.ok && aliveStatus.alive === true) {
            await this.promoteConnectionToLive(uniqueId, patch, reason);
            return true;
        }

        return false;
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
        const recentActivityThresholdMs = 90 * 1000;

        for (const [uniqueId, conn] of this.activeConnections.entries()) {
            const { wrapper } = conn;
            const now = Date.now();
            const lastEventTime = conn.lastEventTime ?? (conn.startTime instanceof Date ? conn.startTime.getTime() : now);
            const timeSinceEventMs = Math.max(0, now - lastEventTime);
            const timeSinceEvent = Math.floor(timeSinceEventMs / 1000);

            const wsConnected = wrapper?.connection?.isConnected ?? false;
            const numericRoomId = String(conn.roomId || '').trim() || null;

            if (wsConnected && timeSinceEventMs <= recentActivityThresholdMs) {
                if (conn.liveValidated === true) {
                    conn.lastConfirmedLiveAt = now;
                }
                if (this.pendingOffline.has(uniqueId)) {
                    this.pendingOffline.delete(uniqueId);
                }
                continue;
            }

            const aliveStatus = numericRoomId
                ? await fetchRoomAliveStatus(numericRoomId)
                : { ok: false, alive: null, error: 'missing numeric room id' };

            if (aliveStatus.ok && aliveStatus.alive === true) {
                await this.promoteConnectionToLive(uniqueId, {}, 'heartbeat-check_alive');
                if (this.pendingOffline.has(uniqueId)) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} check_alive=true. Clearing pending offline state.`);
                    this.pendingOffline.delete(uniqueId);
                }
                if (!wsConnected && timeSinceEventMs > recentActivityThresholdMs) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} check_alive=true but WebSocket disconnected (${timeSinceEvent}s silent). Waiting for wrapper reconnect.`);
                }
                continue;
            }

            if (aliveStatus.ok && aliveStatus.alive === false) {
                if (!this.pendingOffline.has(uniqueId)) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} check_alive=false. Starting offline confirmation window...`);
                    this.pendingOffline.set(uniqueId, now);
                    continue;
                }

                const pendingSince = Number(this.pendingOffline.get(uniqueId)) || now;
                const pendingDurationMs = now - pendingSince;
                const shouldDisconnect = pendingDurationMs >= LIVE_ROOM_OFFLINE_CONFIRM_MS
                    && (!wsConnected || timeSinceEventMs >= recentActivityThresholdMs);

                if (shouldDisconnect) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} offline confirmed by check_alive=false for ${Math.floor(pendingDurationMs / 1000)}s and ${timeSinceEvent}s silent. Disconnecting...`);
                    this.pendingOffline.delete(uniqueId);
                    this.handleDisconnect(uniqueId, 'Heartbeat: offline confirmed by check_alive');
                } else if (timeSinceEventMs > recentActivityThresholdMs) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} check_alive=false but still inside confirmation window (${Math.floor(pendingDurationMs / 1000)}s).`);
                }
                continue;
            }

            if (wsConnected) {
                if (timeSinceEventMs >= LIVE_ROOM_RECYCLE_STALE_MS) {
                    console.log(`[AutoRecorder] Heartbeat: ${uniqueId} quiet for ${timeSinceEvent}s and check_alive unavailable (${aliveStatus.error || 'unknown'}). Keeping connection to avoid false offline.`);
                }
                continue;
            }

            if (timeSinceEventMs >= LIVE_ROOM_RECYCLE_STALE_MS) {
                console.log(`[AutoRecorder] Heartbeat: ${uniqueId} WebSocket disconnected for ${timeSinceEvent}s and check_alive unavailable (${aliveStatus.error || 'unknown'}). Recycling connection...`);
                this.pendingOffline.delete(uniqueId);
                this.handleDisconnect(uniqueId, 'Heartbeat: disconnected and live check unavailable');
            } else if (timeSinceEventMs > recentActivityThresholdMs) {
                console.log(`[AutoRecorder] Heartbeat: ${uniqueId} WebSocket disconnected (${timeSinceEvent}s silent), waiting for reconnect because live status is unavailable.`);
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
                roomNumericId: conn.roomId,
                liveValidated: conn.liveValidated === true
            };
        });
    }

    getConnectionState(uniqueId) {
        const conn = this.activeConnections.get(uniqueId);
        if (!conn) {
            return null;
        }

        const wsConnected = conn.wrapper?.connection?.isConnected === true;
        return {
            uniqueId,
            roomId: conn.roomId || null,
            liveValidated: conn.liveValidated === true,
            isLive: this.isConnectionLiveForRoomList(uniqueId, conn),
            wsConnected,
            startTime: conn.startTime?.toISOString() || null,
            lastEventTime: conn.lastEventTime || null,
            lastConfirmedLiveAt: conn.lastConfirmedLiveAt || null,
        };
    }

    isConnectionUsable(uniqueId, now = Date.now()) {
        const conn = this.activeConnections.get(uniqueId);
        if (!conn) {
            return false;
        }

        if (conn.wrapper?.connection?.isConnected !== true) {
            return false;
        }

        if (this.isRoomPrecheckedLive(uniqueId, now)) {
            return true;
        }

        return this.isConnectionLiveForRoomList(uniqueId, conn, now);
    }

    async recycleUnusableConnection(uniqueId, reason = 'unusable-connection') {
        const normalizedRoomId = String(uniqueId || '').trim();
        if (!normalizedRoomId) return false;

        const conn = this.activeConnections.get(normalizedRoomId);
        if (!conn) return false;

        console.warn(`[AutoRecorder] ${normalizedRoomId} has unusable tracked connection (${reason}). Recycling state for reconnect.`);

        try {
            try {
                conn.wrapper?.disconnect?.();
            } catch (disconnectError) {
                console.warn(`[AutoRecorder] Failed to disconnect unusable wrapper for ${normalizedRoomId}:`, disconnectError?.message || disconnectError);
            }

            this.activeConnections.delete(normalizedRoomId);
            this.pendingOffline.delete(normalizedRoomId);
            this.clearPrecheckedRoomLive(normalizedRoomId);
            await liveStateService.markRoomOffline(normalizedRoomId, {
                lastEventAt: conn.lastEventTime ? new Date(conn.lastEventTime).toISOString() : undefined,
            });
        } catch (error) {
            console.error(`[AutoRecorder] Failed to recycle unusable connection for ${normalizedRoomId}:`, error?.message || error);
        }

        return true;
    }

    getSessionMaintenanceRuntimeSnapshot() {
        const pendingArchives = Array.from(this.pendingArchives.entries()).map(([roomId, pending]) => ({
            roomId,
            disconnectTime: pending.disconnectTime ? new Date(pending.disconnectTime).toISOString() : null,
            startIso: pending.startIso || null,
            eventCount: Number(pending.eventCount || 0),
            archiveDelayMinutes: pending.archiveDelayMs != null ? Math.round(Number(pending.archiveDelayMs || 0) / 60000) : null,
        }));

        return {
            pendingArchives: pendingArchives.length,
            pendingArchiveRooms: pendingArchives.slice(0, 10),
            scheduler: {
                staleCleanupNextRunAt: this.maintenanceScheduleMeta.staleCleanupNextRunAt,
                consolidationNextRunAt: this.maintenanceScheduleMeta.consolidationNextRunAt,
            },
            config: this.sessionMaintenanceConfig,
        };
    }

    recordMonitorFailure(uniqueId, category = 'unknown', errorMessage = '', extra = {}) {
        const roomId = String(uniqueId || '').trim() || null;
        const entry = {
            roomId,
            category: String(category || 'unknown').trim() || 'unknown',
            errorMessage: String(errorMessage || '').trim() || null,
            stage: extra.stage ? String(extra.stage).trim() : null,
            reason: extra.reason ? String(extra.reason).trim() : null,
            source: extra.source ? String(extra.source).trim() : null,
            recordedAt: new Date().toISOString(),
        };

        this.recentMonitorFailures.unshift(entry);
        if (this.recentMonitorFailures.length > AUTO_MONITOR_FAILURE_HISTORY_LIMIT) {
            this.recentMonitorFailures.length = AUTO_MONITOR_FAILURE_HISTORY_LIMIT;
        }
    }

    getConnectCooldownInfo(uniqueId, now = Date.now()) {
        const normalizedRoomId = String(uniqueId || '').trim();
        if (!normalizedRoomId) {
            return {
                active: false,
                until: 0,
                remainingMs: 0,
                reason: null,
                updatedAt: null,
            };
        }

        const until = Number(this.connectCooldowns.get(normalizedRoomId)) || 0;
        if (until <= 0 || until <= now) {
            this.connectCooldowns.delete(normalizedRoomId);
            this.connectCooldownMeta.delete(normalizedRoomId);
            return {
                active: false,
                until: 0,
                remainingMs: 0,
                reason: null,
                updatedAt: null,
            };
        }

        const meta = this.connectCooldownMeta.get(normalizedRoomId) || {};
        return {
            active: true,
            until,
            remainingMs: Math.max(0, until - now),
            reason: meta.reason || null,
            updatedAt: meta.updatedAt || null,
        };
    }

    getGlobalConnectCooldownSnapshot(now = Date.now()) {
        if (this.globalConnectCooldownUntil <= 0 || this.globalConnectCooldownUntil <= now) {
            if (this.globalConnectCooldownUntil > 0 && this.globalConnectCooldownUntil <= now) {
                this.globalConnectCooldownUntil = 0;
                this.globalConnectCooldownReason = null;
                this.globalConnectCooldownSetAt = null;
            }
            return {
                active: false,
                until: 0,
                remainingMs: 0,
                reason: null,
                updatedAt: null,
            };
        }

        return {
            active: true,
            until: this.globalConnectCooldownUntil,
            remainingMs: Math.max(0, this.globalConnectCooldownUntil - now),
            reason: this.globalConnectCooldownReason || null,
            updatedAt: this.globalConnectCooldownSetAt || null,
        };
    }

    async getMonitoringRuntimeSnapshot(options = {}) {
        const sampleSize = Math.max(3, Math.min(20, Number(options.sampleSize) || 8));
        const runtimeContext = await this.buildRuntimeContext();
        const roomsResult = await manager.getRooms({ limit: 9999 });
        const rooms = Array.isArray(roomsResult?.data) ? roomsResult.data : [];
        const namedRooms = rooms.filter((room) => room?.name && String(room.name).trim() !== '');
        const nowMs = Number(runtimeContext.schedulerNow || Date.now());
        const keyStatus = runtimeContext.keyStatus || {};
        const globalCooldown = this.getGlobalConnectCooldownSnapshot(nowMs);
        const activeConnectionSamples = [];
        let usableConnectionCount = 0;

        for (const [roomId, conn] of this.activeConnections.entries()) {
            const usable = this.isConnectionUsable(roomId, nowMs);
            if (usable) {
                usableConnectionCount += 1;
            }

            activeConnectionSamples.push({
                roomId,
                numericRoomId: conn.roomId || null,
                wsConnected: conn.wrapper?.connection?.isConnected === true,
                liveValidated: conn.liveValidated === true,
                usable,
                startTime: conn.startTime?.toISOString?.() || null,
                lastEventTime: conn.lastEventTime ? new Date(conn.lastEventTime).toISOString() : null,
                lastConfirmedLiveAt: conn.lastConfirmedLiveAt ? new Date(conn.lastConfirmedLiveAt).toISOString() : null,
            });
        }

        const precheckedLiveRooms = Array.from(this.precheckedLiveRooms.entries())
            .map(([roomId, entry]) => ({
                roomId,
                numericRoomId: entry.numericRoomId || null,
                source: entry.source || null,
                updatedAt: entry.updatedAt || null,
                expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
            }))
            .filter((entry) => {
                const expiresAtMs = entry.expiresAt ? new Date(entry.expiresAt).getTime() : 0;
                return expiresAtMs > nowMs;
            })
            .sort((left, right) => {
                return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
            });

        const pendingArchiveRooms = Array.from(this.pendingArchives.entries())
            .map(([roomId, pending]) => ({
                roomId,
                disconnectTime: pending.disconnectTime ? new Date(pending.disconnectTime).toISOString() : null,
                startTime: pending.startTime?.toISOString?.() || pending.startIso || null,
                eventCount: Number(pending.eventCount || 0),
            }))
            .sort((left, right) => {
                return new Date(right.disconnectTime || 0).getTime() - new Date(left.disconnectTime || 0).getTime();
            });

        const bucketCounts = {
            live: 0,
            scheduledHot: 0,
            scheduledWarm: 0,
            cold: 0,
            invalid: 0,
            other: 0,
        };
        const hotRooms = [];
        const scheduleCooldownRooms = [];
        const connectCooldownRooms = [];
        const failureRooms = [];
        let enabledRoomCount = 0;
        let disabledRoomCount = 0;
        let eligibleRoomCount = 0;
        let scheduleSkippedCount = 0;
        let connectCooldownCount = 0;

        for (const room of namedRooms) {
            const roomId = String(room?.roomId || room?.room_id || '').trim();
            if (!roomId) continue;

            const roomEnabled = Number(room.isMonitorEnabled ?? room.is_monitor_enabled ?? 1) !== 0;
            if (!roomEnabled) {
                disabledRoomCount += 1;
                continue;
            }
            enabledRoomCount += 1;

            const priority = this.getRoomMonitorPriority(room, runtimeContext);
            const bucketKey = priority.bucket === 'scheduled-hot'
                ? 'scheduledHot'
                : priority.bucket === 'scheduled-warm'
                    ? 'scheduledWarm'
                    : priority.bucket === 'live'
                        ? 'live'
                        : priority.bucket === 'cold'
                            ? 'cold'
                            : priority.bucket === 'invalid'
                                ? 'invalid'
                                : 'other';
            bucketCounts[bucketKey] += 1;

            const scanState = this.roomMonitorScanState.get(roomId);
            const scanCooldownMs = this.getRoomScanCooldownMs(priority, runtimeContext);
            const lastScheduledAt = Number(scanState?.lastScheduledAt || 0);
            const scheduleCooldownRemainingMs = scanCooldownMs > 0 && lastScheduledAt > 0
                ? Math.max(0, scanCooldownMs - (nowMs - lastScheduledAt))
                : 0;
            const connectCooldown = this.getConnectCooldownInfo(roomId, nowMs);
            const failureCount = Number(this.failureCount.get(roomId) || 0);
            const hasActiveConnection = this.activeConnections.has(roomId);
            const usableConnection = hasActiveConnection ? this.isConnectionUsable(roomId, nowMs) : false;
            const item = {
                roomId,
                name: room.name || roomId,
                score: Number(priority.score || 0),
                bucket: priority.bucket || 'other',
                reasons: Array.isArray(priority.reasons) ? priority.reasons.slice(0, 5) : [],
                dynamicProfile: priority.dynamicProfile ? {
                    profileType: priority.dynamicProfile.profileType || null,
                    score: Number(priority.dynamicProfile.score || 0),
                    successCount: Number(priority.dynamicProfile.successCount || 0),
                    failureCount: Number(priority.dynamicProfile.failureCount || 0),
                    expiresAt: priority.dynamicProfile.expiresAt || null,
                    lastSuccessAt: priority.dynamicProfile.lastSuccessAt || null,
                    lastFailureAt: priority.dynamicProfile.lastFailureAt || null,
                    lastProbeError: priority.dynamicProfile.lastProbeError || null,
                } : null,
                failureCount,
                hasActiveConnection,
                usableConnection,
                isConnecting: this.connectingRooms.has(roomId),
                isDisconnecting: this.disconnectingRooms.has(roomId),
                scheduleCooldownRemainingMs,
                connectCooldownRemainingMs: connectCooldown.remainingMs,
                connectCooldownReason: connectCooldown.reason,
                scanCooldownMs,
                profileSampleSessions: Number(priority.profile?.sampleSessions || 0),
                preferredRanges: Array.isArray(priority.profile?.preferredRanges) ? priority.profile.preferredRanges : [],
                updatedAt: room.updatedAt || room.updated_at || null,
                priorityValue: Number(room.priority ?? room.priority_desc ?? 0) || 0,
            };

            if (scheduleCooldownRemainingMs > 0) {
                scheduleSkippedCount += 1;
                scheduleCooldownRooms.push(item);
            }

            if (connectCooldown.active) {
                connectCooldownCount += 1;
                connectCooldownRooms.push({
                    ...item,
                    connectCooldownUntil: connectCooldown.until ? new Date(connectCooldown.until).toISOString() : null,
                    connectCooldownUpdatedAt: connectCooldown.updatedAt || null,
                });
            }

            if (failureCount > 0) {
                failureRooms.push(item);
            }

            if (
                !hasActiveConnection &&
                !item.isConnecting &&
                !item.isDisconnecting &&
                scheduleCooldownRemainingMs <= 0 &&
                !connectCooldown.active
            ) {
                eligibleRoomCount += 1;
                hotRooms.push(item);
            }
        }

        const recentFailures = this.recentMonitorFailures.slice(0, sampleSize);
        const roomIdResolutionFailureCount = recentFailures.filter((item) => item.category === 'room_id_resolution').length;
        const snapshotUnavailableCount = recentFailures.filter((item) => item.category === 'snapshot_unavailable').length;

        const precheckConcurrency = this.resolveMonitorPrecheckConcurrencyLimit(
            Math.max(eligibleRoomCount, 1),
            keyStatus,
            runtimeContext.dbSettings
        );

        const scheduleProfileCoverage = enabledRoomCount > 0
            ? Math.round(((runtimeContext.scheduleProfiles?.size || 0) / enabledRoomCount) * 100)
            : 0;
        const dynamicProfileCount = runtimeContext.dynamicProfiles?.size || 0;
        const blockedProbeProfiles = Array.from((runtimeContext.dynamicProfiles || new Map()).values())
            .filter((profile) => profile?.profileType === AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE)
            .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0));
        const diagnosis = [];

        if (Number(keyStatus.total || 0) <= 0) {
            diagnosis.push({
                level: 'critical',
                code: 'no_keys',
                text: '当前没有可用 Euler Key，自动监控只能依赖 TikTok 页面快照和公开接口回退，稳定性会明显下降。',
            });
        } else if (Number(keyStatus.active || 0) <= 0) {
            diagnosis.push({
                level: 'critical',
                code: 'keys_exhausted',
                text: '所有 Euler Key 都处于冷却或不可用状态。当前瓶颈是 Key 可用性，不是扫描逻辑本身。',
            });
        } else if (Number(keyStatus.disabled || 0) > 0) {
            diagnosis.push({
                level: 'warning',
                code: 'keys_degraded',
                text: `${keyStatus.disabled}/${keyStatus.total} 把 Euler Key 正在冷却，当前预探活吞吐已经下降。`,
            });
        }

        if (globalCooldown.active) {
            diagnosis.push({
                level: 'warning',
                code: 'global_connect_cooldown',
                text: '当前处于全局建连冷却。说明最近触发了 TikTok 连接启动限流，单纯加 Key 不能直接解决这个问题。',
            });
        }

        if (roomIdResolutionFailureCount >= 2 || snapshotUnavailableCount >= 2) {
            diagnosis.push({
                level: 'warning',
                code: 'room_resolution_unstable',
                text: '近期存在较多房间号解析或 live 快照失败。这里更像是上游页面/API 可达性问题，加 Key 只能部分缓解，不能根治。',
            });
        }

        if (enabledRoomCount > 0 && enabledRoomCount >= Math.max(60, precheckConcurrency * 12)) {
            diagnosis.push({
                level: 'info',
                code: 'room_pool_large',
                text: `当前启用监控房间 ${enabledRoomCount} 个，而本轮预探活并发上限为 ${precheckConcurrency}。这个规模下，热点优先和冷房间退避比继续线性加 Key 更重要。`,
            });
        }

        if (scheduleProfileCoverage < 40 && enabledRoomCount >= 20) {
            diagnosis.push({
                level: 'info',
                code: 'schedule_coverage_low',
                text: `当前只有 ${scheduleProfileCoverage}% 的启用房间已经形成历史直播时段画像。随着历史场次增长，时段优先级的收益会继续提升。`,
            });
        }

        if (blockedProbeProfiles.length > 0) {
            diagnosis.push({
                level: 'info',
                code: 'dynamic_probe_profiles_active',
                text: `当前有 ${blockedProbeProfiles.length} 个房间带有“探活常被拦但近期直连可达”的短期画像。它们会在 TTL 内被更积极地重试，后续会自动衰减，不会永久固化。`,
            });
        }

        return {
            generatedAt: new Date(nowMs).toISOString(),
            summary: {
                totalRooms: rooms.length,
                namedRooms: namedRooms.length,
                enabledRooms: enabledRoomCount,
                disabledRooms: disabledRoomCount,
                eligibleRooms: eligibleRoomCount,
                scheduleSkippedRooms: scheduleSkippedCount,
                connectCooldownRooms: connectCooldownCount,
                failureRooms: failureRooms.length,
                activeConnections: this.activeConnections.size,
                usableConnections: usableConnectionCount,
                connectingRooms: this.connectingRooms.size,
                disconnectingRooms: this.disconnectingRooms.size,
                precheckedLiveRooms: precheckedLiveRooms.length,
                pendingArchives: this.pendingArchives.size,
                scheduleProfiles: runtimeContext.scheduleProfiles?.size || 0,
                scheduleProfileCoverage,
                dynamicProfiles: dynamicProfileCount,
                blockedProbeProfiles: blockedProbeProfiles.length,
                scanIntervalMinutes: runtimeContext.configuredScanIntervalMins,
                precheckConcurrency,
            },
            buckets: bucketCounts,
            globalCooldown: {
                active: globalCooldown.active,
                until: globalCooldown.until ? new Date(globalCooldown.until).toISOString() : null,
                remainingMs: globalCooldown.remainingMs,
                reason: globalCooldown.reason,
                updatedAt: globalCooldown.updatedAt,
            },
            keys: {
                total: Number(keyStatus.total || 0),
                active: Number(keyStatus.active || 0),
                disabled: Number(keyStatus.disabled || 0),
                poolStatus: keyStatus.poolStatus || 'unknown',
                connectivityMode: keyStatus.connectivityMode || 'unknown',
                selectionCount: Number(keyStatus.selectionCount || 0),
                rotationCount: Number(keyStatus.rotationCount || 0),
                rateLimitCount: Number(keyStatus.rateLimitCount || 0),
                roomLookupRequestCount: Number(keyStatus.roomLookupRequestCount || 0),
                liveCheckRequestCount: Number(keyStatus.liveCheckRequestCount || 0),
                connectSuccessCount: Number(keyStatus.connectSuccessCount || 0),
                fallbackConnectCount: Number(keyStatus.fallbackConnectCount || 0),
                permissionDeniedCount: Number(keyStatus.permissionDeniedCount || 0),
                allKeysDisabledCount: Number(keyStatus.allKeysDisabledCount || 0),
                lastSelectedAt: keyStatus.lastSelectedAt || null,
                lastDisabledAt: keyStatus.lastDisabledAt || null,
                lastDisableReason: keyStatus.lastDisableReason || null,
                lastConnectAt: keyStatus.lastConnectAt || null,
                lastConnectPath: keyStatus.lastConnectPath || null,
                lastKeySource: keyStatus.lastKeySource || null,
                configSource: keyStatus.configSource || null,
                samples: Array.isArray(keyStatus.keys)
                    ? keyStatus.keys.slice(0, sampleSize).map((item) => ({
                        name: item.name || '',
                        keyMasked: item.keyMasked || '',
                        isDisabled: item.isDisabled === true,
                        disabledUntil: item.disabledUntil || null,
                        selectedCount: Number(item.selectedCount || 0),
                        rateLimitCount: Number(item.rateLimitCount || 0),
                        roomLookupRequestCount: Number(item.roomLookupRequestCount || 0),
                        liveCheckRequestCount: Number(item.liveCheckRequestCount || 0),
                        successCount: Number(item.successCount || 0),
                        lastSelectedAt: item.lastSelectedAt || null,
                        lastDisabledAt: item.lastDisabledAt || null,
                        lastDisableReason: item.lastDisableReason || null,
                        lastConnectAt: item.lastConnectAt || null,
                        lastConnectPath: item.lastConnectPath || null,
                        lastError: item.lastError || null,
                        premiumRoomLookupState: item.premiumRoomLookupState || 'unknown',
                    }))
                    : [],
            },
            diagnosis,
            dynamicProfiles: {
                total: dynamicProfileCount,
                blockedProbeConnectable: blockedProbeProfiles.length,
                samples: blockedProbeProfiles.slice(0, sampleSize).map((profile) => ({
                    roomId: profile.roomId,
                    profileType: profile.profileType || null,
                    score: Number(profile.score || 0),
                    successCount: Number(profile.successCount || 0),
                    failureCount: Number(profile.failureCount || 0),
                    source: profile.source || null,
                    lastProbeError: profile.lastProbeError || null,
                    lastSuccessAt: profile.lastSuccessAt || null,
                    lastFailureAt: profile.lastFailureAt || null,
                    expiresAt: profile.expiresAt || null,
                })),
            },
            hotRooms: hotRooms
                .sort((left, right) => right.score - left.score)
                .slice(0, sampleSize),
            scheduleCooldownRooms: scheduleCooldownRooms
                .sort((left, right) => right.scheduleCooldownRemainingMs - left.scheduleCooldownRemainingMs)
                .slice(0, sampleSize),
            connectCooldownRooms: connectCooldownRooms
                .sort((left, right) => right.connectCooldownRemainingMs - left.connectCooldownRemainingMs)
                .slice(0, sampleSize),
            failureRooms: failureRooms
                .sort((left, right) => {
                    if (right.failureCount !== left.failureCount) return right.failureCount - left.failureCount;
                    return right.score - left.score;
                })
                .slice(0, sampleSize),
            recentFailures,
            precheckedLiveRooms: precheckedLiveRooms.slice(0, sampleSize),
            activeConnectionRooms: activeConnectionSamples
                .sort((left, right) => {
                    return new Date(right.lastEventTime || right.startTime || 0).getTime() -
                        new Date(left.lastEventTime || left.startTime || 0).getTime();
                })
                .slice(0, sampleSize),
            pendingArchiveRooms: pendingArchiveRooms.slice(0, sampleSize),
        };
    }

    async getSessionMaintenanceConfig() {
        if (this.sessionMaintenanceConfig) return this.sessionMaintenanceConfig;
        return this.refreshSessionMaintenanceConfig('lazy-load');
    }

    async buildRuntimeContext(existingSettings = null) {
        const dbSettings = existingSettings || await manager.getAllSettings();

        await keyManager.refreshKeys(dbSettings);
        dynamicProxyManager.refreshConfig(dbSettings);
        const scheduleProfiles = await this.loadRoomScheduleProfiles();
        const dynamicProfiles = await this.loadDynamicRoomProfiles();

        const rawSessionId = dbSettings.session_id || process.env.SESSIONID;
        const isValidSession = rawSessionId &&
            !rawSessionId.includes('=') &&
            !rawSessionId.includes('csrf') &&
            rawSessionId.length >= 32;
        const sessionId = isValidSession ? rawSessionId : null;

        if (rawSessionId && !sessionId) {
            console.log(`[AutoRecorder] Ignoring invalid sessionId format: ${rawSessionId.slice(0, 20)}...`);
        }

        const configuredScanIntervalMins = Math.max(1, parseInt(dbSettings.scan_interval || dbSettings.interval || '5', 10) || 5);

        return {
            dbSettings,
            keyStatus: keyManager.getStatus(),
            proxyUrl: dbSettings.proxy_url || dbSettings.proxy,
            sessionId,
            configuredScanIntervalMins,
            precheckLiveTtlMs: Math.max(2 * 60 * 1000, configuredScanIntervalMins * 60 * 1000 + 60 * 1000),
            sessionOpsConfig: await this.getSessionMaintenanceConfig(),
            scheduleProfiles,
            dynamicProfiles,
            schedulerNow: Date.now(),
        };
    }

    pruneDynamicRoomProfiles(now = Date.now(), persist = false) {
        const nextProfiles = new Map();
        let changed = false;

        for (const [roomId, profile] of this.dynamicRoomProfiles.entries()) {
            const normalizedRoomId = String(roomId || '').trim();
            if (!normalizedRoomId || !profile || typeof profile !== 'object') {
                changed = true;
                continue;
            }

            const expiresAtMs = profile.expiresAt ? new Date(profile.expiresAt).getTime() : 0;
            const lastEvidenceAtMs = profile.lastEvidenceAt ? new Date(profile.lastEvidenceAt).getTime() : 0;
            const successCount = Math.max(0, Number(profile.successCount || 0));
            const failureCount = Math.max(0, Number(profile.failureCount || 0));
            const score = Math.max(0, Number(profile.score || 0));

            if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || (successCount <= 0 && score <= 0)) {
                changed = true;
                continue;
            }

            if (failureCount >= successCount + 2 && score <= AUTO_MONITOR_BLOCKED_PROBE_PROFILE_FAILURE_PENALTY) {
                changed = true;
                continue;
            }

            if (lastEvidenceAtMs > 0 && (now - lastEvidenceAtMs) >= AUTO_MONITOR_BLOCKED_PROBE_PROFILE_STALE_EVICT_MS && score <= AUTO_MONITOR_BLOCKED_PROBE_PROFILE_FAILURE_PENALTY) {
                changed = true;
                continue;
            }

            nextProfiles.set(normalizedRoomId, {
                roomId: normalizedRoomId,
                profileType: profile.profileType || AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE,
                score,
                successCount,
                failureCount,
                source: profile.source || null,
                lastProbeError: profile.lastProbeError || null,
                lastSuccessAt: profile.lastSuccessAt || null,
                lastFailureAt: profile.lastFailureAt || null,
                lastEvidenceAt: profile.lastEvidenceAt || profile.lastSuccessAt || profile.lastFailureAt || null,
                expiresAt: profile.expiresAt || null,
                updatedAt: profile.updatedAt || null,
            });
        }

        if (changed || nextProfiles.size !== this.dynamicRoomProfiles.size) {
            this.dynamicRoomProfiles = nextProfiles;
            this.dynamicRoomProfilesLoadedAt = now;
            if (persist) {
                this.queueDynamicRoomProfilesSave();
            }
        }

        return nextProfiles;
    }

    serializeDynamicRoomProfiles() {
        const rows = [];
        for (const [roomId, profile] of this.dynamicRoomProfiles.entries()) {
            rows.push({
                roomId,
                profileType: profile.profileType || AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE,
                score: Number(profile.score || 0),
                successCount: Number(profile.successCount || 0),
                failureCount: Number(profile.failureCount || 0),
                source: profile.source || null,
                lastProbeError: profile.lastProbeError || null,
                lastSuccessAt: profile.lastSuccessAt || null,
                lastFailureAt: profile.lastFailureAt || null,
                lastEvidenceAt: profile.lastEvidenceAt || profile.lastSuccessAt || profile.lastFailureAt || null,
                expiresAt: profile.expiresAt || null,
                updatedAt: profile.updatedAt || null,
            });
        }
        return rows;
    }

    queueDynamicRoomProfilesSave() {
        this.dynamicRoomProfilesSavePromise = this.dynamicRoomProfilesSavePromise
            .catch(() => { })
            .then(async () => {
                const payload = this.serializeDynamicRoomProfiles();
                try {
                    await manager.saveSetting(
                        AUTO_MONITOR_DYNAMIC_PROFILE_SETTING_KEY,
                        payload.length > 0 ? JSON.stringify(payload) : ''
                    );
                } catch (error) {
                    console.error('[AutoRecorder] Failed to save dynamic room profiles:', error?.message || error);
                }
            });

        return this.dynamicRoomProfilesSavePromise;
    }

    async loadDynamicRoomProfiles(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this.dynamicRoomProfilesLoadedAt > 0 && (now - this.dynamicRoomProfilesLoadedAt) < AUTO_MONITOR_DYNAMIC_PROFILE_CACHE_TTL_MS) {
            return this.pruneDynamicRoomProfiles(now);
        }

        let parsed = [];
        try {
            const raw = await manager.getSetting(AUTO_MONITOR_DYNAMIC_PROFILE_SETTING_KEY, '');
            if (raw) {
                const json = JSON.parse(raw);
                if (Array.isArray(json)) {
                    parsed = json;
                }
            }
        } catch (error) {
            console.warn('[AutoRecorder] Failed to load dynamic room profiles:', error?.message || error);
        }

        const nextProfiles = new Map();
        for (const entry of parsed) {
            const roomId = String(entry?.roomId || entry?.room_id || '').trim();
            if (!roomId) continue;
            nextProfiles.set(roomId, {
                roomId,
                profileType: entry?.profileType || entry?.profile_type || AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE,
                score: Math.max(0, Number(entry?.score || 0)),
                successCount: Math.max(0, Number(entry?.successCount || entry?.success_count || 0)),
                failureCount: Math.max(0, Number(entry?.failureCount || entry?.failure_count || 0)),
                source: entry?.source || null,
                lastProbeError: entry?.lastProbeError || entry?.last_probe_error || null,
                lastSuccessAt: entry?.lastSuccessAt || entry?.last_success_at || null,
                lastFailureAt: entry?.lastFailureAt || entry?.last_failure_at || null,
                lastEvidenceAt: entry?.lastEvidenceAt || entry?.last_evidence_at || entry?.lastSuccessAt || entry?.lastFailureAt || null,
                expiresAt: entry?.expiresAt || entry?.expires_at || null,
                updatedAt: entry?.updatedAt || entry?.updated_at || null,
            });
        }

        this.dynamicRoomProfiles = nextProfiles;
        this.dynamicRoomProfilesLoadedAt = now;
        return this.pruneDynamicRoomProfiles(now, nextProfiles.size > 0);
    }

    getDynamicRoomProfile(roomId, runtimeContext = null) {
        const normalizedRoomId = String(roomId || '').trim();
        if (!normalizedRoomId) return null;
        const dynamicProfiles = runtimeContext?.dynamicProfiles || this.dynamicRoomProfiles;
        const profile = dynamicProfiles?.get?.(normalizedRoomId) || null;
        if (!profile) return null;
        if (isExpiredTimestamp(profile.expiresAt, Number(runtimeContext?.schedulerNow || Date.now()))) {
            return null;
        }
        return profile;
    }

    async updateBlockedProbeDynamicProfile(roomId, action, extra = {}) {
        const normalizedRoomId = String(roomId || '').trim();
        if (!normalizedRoomId) return null;

        await this.loadDynamicRoomProfiles();

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const current = this.dynamicRoomProfiles.get(normalizedRoomId) || {
            roomId: normalizedRoomId,
            profileType: AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE,
            score: 0,
            successCount: 0,
            failureCount: 0,
            source: null,
            lastProbeError: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastEvidenceAt: null,
            expiresAt: null,
            updatedAt: null,
        };

        if (String(current.profileType || AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE) !== AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE) {
            return current;
        }

        let nextScore = Math.max(0, Number(current.score || 0));
        let nextSuccessCount = Math.max(0, Number(current.successCount || 0));
        let nextFailureCount = Math.max(0, Number(current.failureCount || 0));
        let nextExpiresAtMs = current.expiresAt ? new Date(current.expiresAt).getTime() : 0;
        let shouldDelete = false;

        if (action === 'connect-success') {
            nextSuccessCount += 1;
            nextFailureCount = Math.max(0, nextFailureCount - 1);
            nextScore = clampNumber(nextScore + AUTO_MONITOR_BLOCKED_PROBE_PROFILE_SUCCESS_SCORE, 0, 100);
            const ttlMs = Math.min(
                AUTO_MONITOR_BLOCKED_PROBE_PROFILE_MAX_TTL_MS,
                AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TTL_MS + Math.max(0, nextSuccessCount - 1) * 2 * 60 * 60 * 1000
            );
            nextExpiresAtMs = nowMs + ttlMs;
        } else if (action === 'connect-failure') {
            nextFailureCount += 1;
            nextScore = Math.max(0, nextScore - AUTO_MONITOR_BLOCKED_PROBE_PROFILE_FAILURE_PENALTY);
            if (nextScore <= 0 || nextFailureCount >= nextSuccessCount + 2) {
                shouldDelete = true;
            } else {
                nextExpiresAtMs = Math.max(nowMs + 60 * 60 * 1000, nextExpiresAtMs - 60 * 60 * 1000);
            }
        } else if (action === 'probe-recovered') {
            nextScore = Math.max(0, nextScore - AUTO_MONITOR_BLOCKED_PROBE_PROFILE_PROBE_RECOVERY_PENALTY);
            if (nextScore <= 0 && nextSuccessCount <= 1) {
                shouldDelete = true;
            }
        } else if (action === 'offline') {
            nextFailureCount += 1;
            nextScore = Math.max(0, nextScore - AUTO_MONITOR_BLOCKED_PROBE_PROFILE_OFFLINE_PENALTY);
            if (nextScore <= 0 || nextFailureCount > nextSuccessCount + 1) {
                shouldDelete = true;
            } else {
                nextExpiresAtMs = Math.max(nowMs + 30 * 60 * 1000, nextExpiresAtMs - 2 * 60 * 60 * 1000);
            }
        } else {
            return current;
        }

        if (shouldDelete) {
            this.dynamicRoomProfiles.delete(normalizedRoomId);
            this.dynamicRoomProfilesLoadedAt = nowMs;
            this.queueDynamicRoomProfilesSave();
            return null;
        }

        const updated = {
            ...current,
            roomId: normalizedRoomId,
            profileType: AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE,
            score: nextScore,
            successCount: nextSuccessCount,
            failureCount: nextFailureCount,
            source: extra.source || current.source || null,
            lastProbeError: extra.probeError || current.lastProbeError || null,
            lastSuccessAt: action === 'connect-success' ? nowIso : current.lastSuccessAt || null,
            lastFailureAt: action === 'connect-failure' || action === 'offline' ? nowIso : current.lastFailureAt || null,
            lastEvidenceAt: nowIso,
            expiresAt: new Date(nextExpiresAtMs || (nowMs + AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TTL_MS)).toISOString(),
            updatedAt: nowIso,
        };

        this.dynamicRoomProfiles.set(normalizedRoomId, updated);
        this.dynamicRoomProfilesLoadedAt = nowMs;
        this.queueDynamicRoomProfilesSave();
        return updated;
    }

    async loadRoomScheduleProfiles(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this.roomScheduleProfilesLoadedAt > 0 && (now - this.roomScheduleProfilesLoadedAt) < AUTO_MONITOR_SCHEDULE_PROFILE_CACHE_TTL_MS) {
            return this.roomScheduleProfiles;
        }

        const rows = await db.query(`
            SELECT
                room_id,
                created_at,
                end_time
            FROM (
                SELECT
                    s.room_id,
                    COALESCE(MIN(e.timestamp), s.created_at) AS created_at,
                    COALESCE(MAX(e.timestamp), COALESCE(ss.end_time, s.created_at)) AS end_time,
                    ROW_NUMBER() OVER (
                        PARTITION BY s.room_id
                        ORDER BY COALESCE(MIN(e.timestamp), s.created_at) DESC
                    ) AS rn
                FROM session s
                LEFT JOIN event e ON e.session_id = s.session_id
                LEFT JOIN session_summary ss ON ss.session_id = s.session_id
                WHERE s.created_at >= NOW() - ($1::int * INTERVAL '1 day')
                GROUP BY s.session_id, s.room_id, s.created_at, ss.end_time
            ) ranked
            WHERE rn <= $2
            ORDER BY room_id ASC, created_at DESC
        `, [AUTO_MONITOR_SCHEDULE_LOOKBACK_DAYS, AUTO_MONITOR_SCHEDULE_MAX_SESSIONS_PER_ROOM]);

        const groupedRows = new Map();
        for (const row of rows) {
            const roomId = String(row?.roomId || row?.room_id || '').trim();
            if (!roomId) continue;
            if (!groupedRows.has(roomId)) {
                groupedRows.set(roomId, []);
            }
            groupedRows.get(roomId).push(row);
        }

        const nextProfiles = new Map();
        for (const [roomId, sessionRows] of groupedRows.entries()) {
            const sessions = [];
            const hourWeights = new Map();

            for (const sessionRow of sessionRows) {
                const startValue = sessionRow?.createdAt || sessionRow?.created_at;
                const endValue = sessionRow?.endTime || sessionRow?.end_time || startValue;
                const touchedHours = enumerateTouchedBeijingHours(startValue, endValue);
                if (touchedHours.length === 0) continue;

                sessions.push({
                    startTime: startValue,
                    endTime: endValue,
                    touchedHours,
                });

                for (const hour of touchedHours) {
                    hourWeights.set(hour, (hourWeights.get(hour) || 0) + 1);
                }
            }

            if (sessions.length === 0) continue;

            const sortedHours = Array.from(hourWeights.entries())
                .sort((left, right) => {
                    if (right[1] !== left[1]) return right[1] - left[1];
                    return left[0] - right[0];
                });

            const preferredHours = sortedHours
                .filter(([, count]) => count >= 2)
                .map(([hour]) => hour);

            const fallbackHours = preferredHours.length > 0
                ? preferredHours
                : sortedHours.slice(0, Math.min(3, sortedHours.length)).map(([hour]) => hour);

            nextProfiles.set(roomId, {
                roomId,
                sampleSessions: sessions.length,
                preferredHours: fallbackHours,
                preferredRanges: compactHoursToRanges(fallbackHours),
                hourWeights: Object.fromEntries(sortedHours),
                updatedAt: now,
            });
        }

        this.roomScheduleProfiles = nextProfiles;
        this.roomScheduleProfilesLoadedAt = now;
        return nextProfiles;
    }

    getRoomScheduleProfile(roomId, runtimeContext = null) {
        const normalizedRoomId = String(roomId || '').trim();
        if (!normalizedRoomId) return null;
        const scheduleProfiles = runtimeContext?.scheduleProfiles || this.roomScheduleProfiles;
        return scheduleProfiles?.get?.(normalizedRoomId) || null;
    }

    getRoomMonitorPriority(room, runtimeContext = null) {
        const roomId = String(room?.roomId || room?.room_id || '').trim();
        if (!roomId) {
            return { score: -100, bucket: 'invalid', reasons: ['missing-room-id'] };
        }

        const nowMs = Number(runtimeContext?.schedulerNow || Date.now());
        const nowHour = getBeijingHour(nowMs);
        const reasons = [];
        let score = 0;
        let bucket = 'cold';

        const priority = Number(room?.priority ?? room?.priority_desc ?? 0) || 0;
        if (priority !== 0) {
            score += priority * 10;
            reasons.push(`manual-priority:${priority}`);
        }

        if (this.pendingArchives.has(roomId)) {
            score += 45;
            reasons.push('pending-archive');
        }

        if (this.isRoomPrecheckedLive(roomId, nowMs)) {
            score += 80;
            bucket = 'live';
            reasons.push('prechecked-live');
        }

        if (this.isConnectCooldownActive(roomId)) {
            score -= 60;
            reasons.push('connect-cooldown');
        }

        const profile = this.getRoomScheduleProfile(roomId, runtimeContext);
        if (profile && Number.isInteger(nowHour)) {
            const distances = (profile.preferredHours || [])
                .map((hour) => getCircularHourDistance(hour, nowHour))
                .filter((distance) => Number.isFinite(distance));
            const minDistance = distances.length > 0 ? Math.min(...distances) : Number.POSITIVE_INFINITY;

            if (minDistance <= AUTO_MONITOR_SCHEDULE_NEARBY_WINDOW_HOURS) {
                score += 40;
                bucket = bucket === 'live' ? bucket : 'scheduled-hot';
                reasons.push(`schedule-near:${minDistance}h`);
            } else if (minDistance <= AUTO_MONITOR_SCHEDULE_SHOULDER_WINDOW_HOURS) {
                score += 20;
                bucket = bucket === 'live' ? bucket : 'scheduled-warm';
                reasons.push(`schedule-shoulder:${minDistance}h`);
            } else {
                score -= 10;
                reasons.push(`schedule-cold:${minDistance}h`);
            }
        } else {
            reasons.push('schedule-unknown');
        }

        const updatedAtValue = room?.updatedAt || room?.updated_at || null;
        const updatedAtMs = updatedAtValue ? new Date(updatedAtValue).getTime() : 0;
        if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
            const ageHours = Math.max(0, (nowMs - updatedAtMs) / (60 * 60 * 1000));
            if (ageHours <= 6) {
                score += 12;
                reasons.push('recent-room-touch');
            } else if (ageHours >= 72) {
                score -= 6;
                reasons.push('stale-room-touch');
            }
        }

        const cachedNumericRoomId = String(room?.numericRoomId || room?.numeric_room_id || '').trim();
        if (cachedNumericRoomId) {
            score += 6;
            reasons.push('cached-room-id');
        }

        const dynamicProfile = this.getDynamicRoomProfile(roomId, runtimeContext);
        if (dynamicProfile?.profileType === AUTO_MONITOR_BLOCKED_PROBE_PROFILE_TYPE) {
            const profileScore = Math.max(0, Math.min(20, Math.round(Number(dynamicProfile.score || 0) / 5)));
            if (profileScore > 0) {
                score += profileScore;
                reasons.push(`dynamic-profile:${profileScore}`);
                if (bucket !== 'live') {
                    if (profileScore >= 16) {
                        bucket = 'scheduled-hot';
                    } else if (profileScore >= 8 && bucket === 'cold') {
                        bucket = 'scheduled-warm';
                    }
                }
            }
        }

        return { score, bucket, reasons, profile, dynamicProfile };
    }

    getRoomScanCooldownMs(priorityInfo, runtimeContext = null) {
        const baseIntervalMins = Math.max(1, Number(runtimeContext?.configuredScanIntervalMins || 5));
        const baseIntervalMs = baseIntervalMins * 60 * 1000;
        const bucket = String(priorityInfo?.bucket || 'cold');

        if (bucket === 'live') {
            return 0;
        }
        if (bucket === 'scheduled-hot') {
            return Math.max(30 * 1000, Math.round(baseIntervalMs * 0.5));
        }
        if (bucket === 'scheduled-warm') {
            return baseIntervalMs;
        }

        if (!priorityInfo?.profile) {
            return baseIntervalMs;
        }

        return Math.max(baseIntervalMs, Math.round(baseIntervalMs * 2.5));
    }

    getProbeUnavailableDirectConnectCooldownMs(runtimeContext = null) {
        const baseIntervalMins = Math.max(1, Number(runtimeContext?.configuredScanIntervalMins || 5));
        const baseIntervalMs = baseIntervalMins * 60 * 1000;
        return Math.max(2 * 60 * 1000, Math.round(baseIntervalMs * 0.75));
    }

    resolveProbeUnavailableDirectConnectBudget(precheckConcurrencyLimit, dbSettings = {}) {
        const configuredLimit = parseInt(
            dbSettings.auto_monitor_probe_unavailable_connect_limit || process.env.AUTO_MONITOR_PROBE_UNAVAILABLE_CONNECT_LIMIT || '0',
            10
        ) || 0;

        if (configuredLimit > 0) {
            return Math.max(0, configuredLimit);
        }

        const concurrency = Math.max(0, Number(precheckConcurrencyLimit) || 0);
        if (concurrency <= 0) {
            return 0;
        }

        return Math.max(
            1,
            Math.min(
                AUTO_MONITOR_PROBE_UNAVAILABLE_DIRECT_CONNECT_MAX_PER_CYCLE,
                Math.ceil(concurrency / 3)
            )
        );
    }

    resolveBlockedProbeCachedRoomConnectBudget(precheckConcurrencyLimit, dbSettings = {}) {
        const configuredLimit = parseInt(
            dbSettings.auto_monitor_blocked_probe_cached_room_connect_limit || process.env.AUTO_MONITOR_BLOCKED_PROBE_CACHED_ROOM_CONNECT_LIMIT || '0',
            10
        ) || 0;

        if (configuredLimit > 0) {
            return Math.max(0, configuredLimit);
        }

        const concurrency = Math.max(0, Number(precheckConcurrencyLimit) || 0);
        if (concurrency <= 0) {
            return 0;
        }

        return Math.max(
            2,
            Math.min(
                AUTO_MONITOR_BLOCKED_PROBE_CACHED_ROOM_CONNECT_MAX_PER_CYCLE,
                Math.ceil(concurrency / 2)
            )
        );
    }

    shouldAttemptDirectConnectAfterUnavailableProbe(room, runtimeContext = null, options = {}) {
        const roomId = String(room?.roomId || room?.room_id || '').trim();
        if (!roomId) {
            return {
                shouldAttempt: false,
                reason: 'missing-room-id',
                priority: { score: -100, bucket: 'invalid', reasons: ['missing-room-id'] },
                remainingBudget: 0,
                budgetType: 'general',
            };
        }

        const priority = this.getRoomMonitorPriority(room, runtimeContext);
        const manualPriority = Number(room?.priority ?? room?.priority_desc ?? 0) || 0;
        const cachedRoomId = String(options.cachedRoomId || '').trim();
        const probeErrorText = String(options.probeError || '').toLowerCase();
        const nowMs = Number(runtimeContext?.schedulerNow || Date.now());
        const state = this.roomMonitorScanState.get(roomId);
        const dynamicProfile = this.getDynamicRoomProfile(roomId, runtimeContext);
        const lastFallbackConnectAttemptAt = Number(state?.lastFallbackConnectAttemptAt || 0);
        const fallbackCooldownMs = this.getProbeUnavailableDirectConnectCooldownMs(runtimeContext);
        const remainingBudget = Math.max(0, Number(runtimeContext?.probeUnavailableDirectConnectBudget?.remaining || 0));
        const blockedProbeCachedRoomRemainingBudget = Math.max(0, Number(runtimeContext?.blockedProbeCachedRoomConnectBudget?.remaining || 0));
        const probeLooksBlocked = probeErrorText.includes('403')
            || probeErrorText.includes('429')
            || probeErrorText.includes('user_not_found')
            || probeErrorText.includes('status code 403');
        const dynamicProfileBoost = Math.max(0, Number(dynamicProfile?.score || 0));
        const hasCachedRoomSignal = Boolean(cachedRoomId) && (probeLooksBlocked || dynamicProfileBoost >= 20) && (
            priority.bucket === 'scheduled-hot'
            || priority.bucket === 'scheduled-warm'
            || manualPriority >= 1
            || Number(priority.score || 0) >= 20
            || dynamicProfileBoost >= 20
        );
        const hasPriority = priority.bucket === 'scheduled-hot'
            || manualPriority >= 2
            || Number(priority.score || 0) >= AUTO_MONITOR_PROBE_UNAVAILABLE_DIRECT_CONNECT_MIN_SCORE
            || dynamicProfileBoost >= 24
            || hasCachedRoomSignal;

        if (!hasPriority) {
            return {
                shouldAttempt: false,
                reason: 'priority-too-low',
                priority,
                remainingBudget,
                blockedProbeCachedRoomRemainingBudget,
                budgetType: hasCachedRoomSignal ? 'cached_room_blocked_probe' : 'general',
            };
        }

        if (hasCachedRoomSignal && blockedProbeCachedRoomRemainingBudget <= 0) {
            return {
                shouldAttempt: false,
                reason: 'blocked-probe-budget-exhausted',
                priority,
                remainingBudget,
                blockedProbeCachedRoomRemainingBudget,
                budgetType: 'cached_room_blocked_probe',
            };
        }

        if (!hasCachedRoomSignal && remainingBudget <= 0) {
            return {
                shouldAttempt: false,
                reason: 'cycle-budget-exhausted',
                priority,
                remainingBudget,
                blockedProbeCachedRoomRemainingBudget,
                budgetType: 'general',
            };
        }

        if (lastFallbackConnectAttemptAt > 0 && (nowMs - lastFallbackConnectAttemptAt) < fallbackCooldownMs) {
            return {
                shouldAttempt: false,
                reason: 'room-fallback-cooldown',
                priority,
                remainingBudget,
                blockedProbeCachedRoomRemainingBudget,
                cooldownRemainingMs: fallbackCooldownMs - (nowMs - lastFallbackConnectAttemptAt),
                budgetType: hasCachedRoomSignal ? 'cached_room_blocked_probe' : 'general',
            };
        }

        return {
            shouldAttempt: true,
            reason: hasCachedRoomSignal ? 'cached-roomid-blocked-probe' : 'priority-allow',
            priority,
            remainingBudget,
            blockedProbeCachedRoomRemainingBudget,
            budgetType: hasCachedRoomSignal ? 'cached_room_blocked_probe' : 'general',
        };
    }

    consumeProbeUnavailableDirectConnectBudget(roomId, runtimeContext = null, priority = null, budgetType = 'general') {
        const normalizedRoomId = String(roomId || '').trim();
        if (!normalizedRoomId) return false;

        const budget = budgetType === 'cached_room_blocked_probe'
            ? runtimeContext?.blockedProbeCachedRoomConnectBudget
            : runtimeContext?.probeUnavailableDirectConnectBudget;
        if (!budget || Number(budget.remaining || 0) <= 0) {
            return false;
        }

        budget.remaining = Math.max(0, Number(budget.remaining || 0) - 1);
        const state = this.roomMonitorScanState.get(normalizedRoomId) || {};
        this.roomMonitorScanState.set(normalizedRoomId, {
            ...state,
            lastFallbackConnectAttemptAt: Number(runtimeContext?.schedulerNow || Date.now()),
            bucket: priority?.bucket || state.bucket || null,
            score: Number(priority?.score ?? state.score ?? 0),
        });
        return true;
    }

    shouldSkipRoomBySchedule(room, runtimeContext = null) {
        const roomId = String(room?.roomId || room?.room_id || '').trim();
        if (!roomId) {
            return { skip: true, priority: { score: -100, bucket: 'invalid', reasons: ['missing-room-id'] } };
        }

        const priority = this.getRoomMonitorPriority(room, runtimeContext);
        const cooldownMs = this.getRoomScanCooldownMs(priority, runtimeContext);
        const nowMs = Number(runtimeContext?.schedulerNow || Date.now());
        const state = this.roomMonitorScanState.get(roomId);
        const lastScheduledAt = Number(state?.lastScheduledAt || 0);

        if (cooldownMs > 0 && lastScheduledAt > 0 && (nowMs - lastScheduledAt) < cooldownMs) {
            return {
                skip: true,
                priority,
                cooldownRemainingMs: cooldownMs - (nowMs - lastScheduledAt),
            };
        }

        this.roomMonitorScanState.set(roomId, {
            lastScheduledAt: nowMs,
            bucket: priority.bucket,
            score: priority.score,
        });

        return { skip: false, priority, cooldownRemainingMs: 0 };
    }

    resolveMonitorPrecheckConcurrencyLimit(roomCount, keyStatus = {}, dbSettings = {}) {
        const normalizedRoomCount = Math.max(0, Number(roomCount) || 0);
        if (normalizedRoomCount === 0) {
            return 0;
        }

        const configuredLimit = parseInt(
            dbSettings.auto_monitor_precheck_concurrency || process.env.AUTO_MONITOR_PRECHECK_CONCURRENCY || '0',
            10
        ) || 0;

        if (configuredLimit > 0) {
            return Math.max(1, Math.min(normalizedRoomCount, configuredLimit));
        }

        const activeKeyCount = Math.max(0, Number(keyStatus.active || 0));
        const derivedLimit = activeKeyCount > 0
            ? activeKeyCount + 2
            : AUTO_MONITOR_PRECHECK_CONCURRENCY_FLOOR;

        return Math.max(
            1,
            Math.min(
                normalizedRoomCount,
                AUTO_MONITOR_PRECHECK_CONCURRENCY_CAP,
                Math.max(AUTO_MONITOR_PRECHECK_CONCURRENCY_FLOOR, derivedLimit)
            )
        );
    }

    async runPreconnectSessionMaintenance(uniqueId, sessionOpsConfig) {
        const shouldSkipStaleArchive = await this.shouldSkipPreconnectStaleArchive(uniqueId, sessionOpsConfig);

        if (shouldSkipStaleArchive) {
            await this.recordSessionMaintenanceEventSafe({
                taskKey: 'preconnect_stale_archive',
                triggerSource: 'preconnect-guard',
                roomId: uniqueId,
                status: 'skipped',
                message: '房间仍处于续场窗口内，跳过开播前遗留事件拆场',
                summary: {
                    resumeWindowMinutes: sessionOpsConfig.resumeWindowMinutes,
                    reason: 'resume-window-guard',
                },
                config: sessionOpsConfig,
            });
            return;
        }

        const staleInfo = await manager.archiveStaleLiveEvents(uniqueId, {
            gapThresholdMinutes: sessionOpsConfig.staleGapThresholdMinutes,
            splitOlderThanMinutes: sessionOpsConfig.staleSplitAgeMinutes,
            archiveAllOlderThanMinutes: sessionOpsConfig.staleArchiveAllAgeMinutes,
        });

        if (!staleInfo || staleInfo.archived <= 0) {
            return;
        }

        console.log(`[AutoRecorder] Cleaned up ${staleInfo.archived} stale events for ${uniqueId} before new connection.`);
        await this.recordSessionMaintenanceEventSafe({
            taskKey: 'preconnect_stale_archive',
            triggerSource: 'preconnect-guard',
            roomId: uniqueId,
            status: 'success',
            message: '新连接建立前已清理遗留未归档事件',
            summary: staleInfo,
            config: sessionOpsConfig,
        });

        const merged = await manager.consolidateRoomSessions(uniqueId, {
            lookbackHours: sessionOpsConfig.consolidationLookbackHours,
            gapMinutes: sessionOpsConfig.consolidationGapMinutes,
        });

        if (merged.mergedCount > 0) {
            await this.recordSessionMaintenanceEventSafe({
                taskKey: 'consolidate_recent_sessions',
                triggerSource: 'preconnect-inline',
                roomId: uniqueId,
                status: 'success',
                message: `开播前已即时合并 ${merged.mergedCount} 个碎片场次`,
                summary: merged,
                config: sessionOpsConfig,
            });
        }
    }

    async refreshSessionMaintenanceConfig(reason = 'manual') {
        const previousDelayMs = this.ARCHIVE_DELAY_MS;
        const config = await getSessionMaintenanceConfig();
        this.sessionMaintenanceConfig = config;
        this.ARCHIVE_DELAY_MS = Math.max(0, Number(config.archiveDelayMinutes || 0)) * 60 * 1000;

        if (previousDelayMs !== this.ARCHIVE_DELAY_MS && this.pendingArchives.size > 0) {
            this.reschedulePendingArchives();
        }

        this.scheduleMaintenanceTask('staleCleanup', reason);
        this.scheduleMaintenanceTask('consolidation', reason);
        return config;
    }

    scheduleMaintenanceTask(taskName, reason = 'manual') {
        if (this.maintenanceTimers[taskName]) {
            clearTimeout(this.maintenanceTimers[taskName]);
            this.maintenanceTimers[taskName] = null;
        }
        this.maintenanceScheduleMeta[taskName === 'staleCleanup' ? 'staleCleanupNextRunAt' : 'consolidationNextRunAt'] = null;

        if (isMaintenanceWorkerEnabled()) {
            return;
        }

        const config = this.sessionMaintenanceConfig;
        if (!config) return;

        const intervalMinutes = taskName === 'staleCleanup'
            ? Number(config.staleCleanupIntervalMinutes || 0)
            : Number(config.consolidationIntervalMinutes || 0);

        if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
            return;
        }

        const nextRunAt = new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
        this.maintenanceScheduleMeta[taskName === 'staleCleanup' ? 'staleCleanupNextRunAt' : 'consolidationNextRunAt'] = nextRunAt;

        this.maintenanceTimers[taskName] = setTimeout(async () => {
            try {
                const latestConfig = await getSessionMaintenanceConfig();
                this.sessionMaintenanceConfig = latestConfig;
                this.ARCHIVE_DELAY_MS = Math.max(0, Number(latestConfig.archiveDelayMinutes || 0)) * 60 * 1000;

                if (taskName === 'staleCleanup') {
                    await runSessionMaintenanceTask('cleanup_stale_live_events', {
                        triggerSource: 'auto-recorder-interval',
                        configOverride: latestConfig,
                    });
                    console.log('[AutoRecorder] Periodic stale event cleanup completed');
                } else {
                    await runSessionMaintenanceTask('consolidate_recent_sessions', {
                        triggerSource: 'auto-recorder-interval',
                        configOverride: latestConfig,
                    });
                    console.log('[AutoRecorder] Periodic session consolidation completed');
                }
            } catch (err) {
                console.error(`[AutoRecorder] ${taskName} failed:`, err?.message || err);
            } finally {
                this.scheduleMaintenanceTask(taskName, 'reschedule');
            }
        }, intervalMinutes * 60 * 1000);

        if (reason !== 'reschedule') {
            console.log(`[AutoRecorder] Scheduled ${taskName} every ${intervalMinutes} minute(s)`);
        }
    }

    reschedulePendingArchives() {
        for (const [uniqueId, pending] of this.pendingArchives.entries()) {
            if (pending.timerId) {
                clearTimeout(pending.timerId);
            }

            const nextDelayMs = Math.max(0, (pending.disconnectTime + this.ARCHIVE_DELAY_MS) - Date.now());
            pending.archiveDelayMs = this.ARCHIVE_DELAY_MS;
            pending.timerId = setTimeout(() => {
                this.executeArchive(uniqueId, pending.startIso, pending.reason, pending.eventCount).catch(err => {
                    console.error(`[AutoRecorder] Rescheduled archive failed for ${uniqueId}:`, err?.message || err);
                });
            }, nextDelayMs);
            this.pendingArchives.set(uniqueId, pending);
        }
    }

    async recordSessionMaintenanceEventSafe(payload) {
        try {
            const config = payload.config || await this.getSessionMaintenanceConfig();
            await recordSessionMaintenanceEvent({ ...payload, config });
        } catch (err) {
            console.error('[AutoRecorder] Failed to write session maintenance log:', err?.message || err);
        }
    }

    async shouldSkipPreconnectStaleArchive(uniqueId, sessionOpsConfig) {
        const normalizedRoomId = String(uniqueId || '').trim();
        if (!normalizedRoomId) return false;

        const pendingArchive = this.pendingArchives.get(normalizedRoomId);
        if (pendingArchive) {
            return true;
        }

        const resumeWindowMs = Math.max(0, Number(sessionOpsConfig?.resumeWindowMinutes || 0)) * 60 * 1000;
        if (resumeWindowMs <= 0) return false;

        const orphanBounds = await manager.getOrphanEventBounds(normalizedRoomId);
        if (orphanBounds.eventCount === 0 || !orphanBounds.newestTimeMs) {
            return false;
        }

        const now = Date.now();
        if ((now - orphanBounds.newestTimeMs) > resumeWindowMs) {
            return false;
        }

        const sessions = await manager.getSessions(normalizedRoomId);
        const lastSession = Array.isArray(sessions) ? sessions[0] : null;
        if (!lastSession) {
            return false;
        }

        const sessionEndTime = lastSession.endTime
            ? new Date(lastSession.endTime).getTime()
            : new Date(lastSession.created_at || lastSession.createdAt).getTime();
        if (!Number.isFinite(sessionEndTime)) {
            return false;
        }

        return (now - sessionEndTime) <= resumeWindowMs;
    }

    async startLoop() {
        const sessionOpsConfig = await this.refreshSessionMaintenanceConfig('startup');

        try {
            if (!isMaintenanceWorkerEnabled() && sessionOpsConfig.startupCleanupEnabled) {
                console.log('[AutoRecorder] Running startup cleanup...');
                await runSessionMaintenanceTask('cleanup_stale_live_events', {
                    triggerSource: 'auto-recorder-startup',
                    configOverride: sessionOpsConfig,
                });
            }

            if (!isMaintenanceWorkerEnabled() && sessionOpsConfig.startupConsolidationEnabled) {
                console.log('[AutoRecorder] Running startup session consolidation...');
                await runSessionMaintenanceTask('consolidate_recent_sessions', {
                    triggerSource: 'auto-recorder-startup',
                    configOverride: sessionOpsConfig,
                });
            }
        } catch (e) {
            console.error('[AutoRecorder] Startup maintenance failed:', e);
        }

        // Dynamic Loop
        let firstRun = true;
        const run = async () => {
            if (!this.monitoring) return;
            const runStartedAt = Date.now();
            try {
                await this.monitor();

                // After first monitor run, process any restored connections
                if (firstRun) {
                    firstRun = false;
                    await this.processRestoredConnections();
                }
            } catch (e) { console.error('[AutoRecorder] monitor error:', e); }

            // Get interval from DB
            const intervalStr = await manager.getSetting('scan_interval', await manager.getSetting('interval', '5'));
            const intervalMins = parseInt(intervalStr, 10) || 5;
            const intervalMs = intervalMins * 60 * 1000;
            const elapsedMs = Date.now() - runStartedAt;
            const nextDelayMs = Math.max(1000, intervalMs - elapsedMs);

            this.timer = setTimeout(run, nextDelayMs);
        };
        run();
    }

    async monitor() {
        if (!this.monitoring) return;

        console.log('[AutoRecorder] Checking for live rooms...');
        const runtimeContext = await this.buildRuntimeContext();

        // Get all rooms from DB (no pagination needed for auto-monitor)
        const roomsResult = await manager.getRooms({ limit: 9999 });
        const rooms = roomsResult.data || [];
        const dbSettings = runtimeContext.dbSettings;

        // Check global Auto Monitor setting (default to 'true' if not set)
        const autoEnabled = dbSettings.auto_monitor_enabled ?? 'true';
        if (autoEnabled !== 'true' && autoEnabled !== true) {
            console.log('[AutoRecorder] Auto monitoring is disabled in settings');
            return;
        }

        // Filter rooms that have a name (user configured rooms)
        // Sort so enabled rooms come first, disabled rooms last
        const targetRooms = rooms
            .filter(r => r.name && r.name.trim() !== '')
            .sort((a, b) => {
                const aEnabled = Number(a.isMonitorEnabled ?? a.is_monitor_enabled ?? 1) !== 0 ? 0 : 1;
                const bEnabled = Number(b.isMonitorEnabled ?? b.is_monitor_enabled ?? 1) !== 0 ? 0 : 1;
                if (aEnabled !== bEnabled) {
                    return aEnabled - bEnabled; // 0 comes before 1
                }

                const aPriority = this.getRoomMonitorPriority(a, runtimeContext);
                const bPriority = this.getRoomMonitorPriority(b, runtimeContext);
                if (bPriority.score !== aPriority.score) {
                    return bPriority.score - aPriority.score;
                }

                return 0;
            });

        // Build list of rooms to check (excluding already connected and disabled)
        const roomsToCheck = [];
        for (const room of targetRooms) {
            const roomEnabled = Number(room.isMonitorEnabled ?? room.is_monitor_enabled ?? 1) !== 0;
            if (!roomEnabled) {
                if (this.activeConnections.has(room.roomId)) {
                    console.log(`[AutoRecorder] Room ${room.roomId} monitor disabled. Disconnecting...`);
                    this.handleDisconnect(room.roomId, 'Monitor disabled');
                }
                continue;
            }
            if (this.activeConnections.has(room.roomId)) {
                const recovered = await this.recoverStaleActiveConnection(room.roomId, 'monitor-scan');
                if (!recovered && this.activeConnections.has(room.roomId)) {
                    if (this.isConnectionUsable(room.roomId)) {
                        continue;
                    }
                    await this.recycleUnusableConnection(room.roomId, 'monitor-scan-unusable');
                }
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

            const scheduleDecision = this.shouldSkipRoomBySchedule(room, runtimeContext);
            if (scheduleDecision.skip) {
                continue;
            }
            roomsToCheck.push(room);
        }

        // Precheck throughput is intentionally higher than connect throughput.
        // Actual connect starts are still serialized by waitForConnectStartSlot().
        if (roomsToCheck.length > 0) {
            const keyStatus = runtimeContext.keyStatus;
            const activeKeyCount = Math.max(0, Number(keyStatus.active || 0));
            const totalKeyCount = Math.max(0, Number(keyStatus.total || 0));
            const CONCURRENCY_LIMIT = this.resolveMonitorPrecheckConcurrencyLimit(
                roomsToCheck.length,
                keyStatus,
                dbSettings
            );
            runtimeContext.probeUnavailableDirectConnectBudget = {
                remaining: this.resolveProbeUnavailableDirectConnectBudget(CONCURRENCY_LIMIT, dbSettings),
            };
            runtimeContext.blockedProbeCachedRoomConnectBudget = {
                remaining: this.resolveBlockedProbeCachedRoomConnectBudget(CONCURRENCY_LIMIT, dbSettings),
            };
            console.log(`[AutoRecorder] Checking ${roomsToCheck.length} rooms (max ${CONCURRENCY_LIMIT} concurrent, based on ${activeKeyCount}/${totalKeyCount} active Euler keys)...`);

            for (let i = 0; i < roomsToCheck.length; i += CONCURRENCY_LIMIT) {
                const batch = roomsToCheck.slice(i, i + CONCURRENCY_LIMIT);
                await Promise.allSettled(batch.map(room => this.checkAndConnect(room, runtimeContext)));

                // Small delay between batches to avoid rate limiting
                if (i + CONCURRENCY_LIMIT < roomsToCheck.length) {
                    await new Promise(r => setTimeout(r, AUTO_MONITOR_PRECHECK_BATCH_GAP_MS));
                }
            }
        }
    }

    async checkAndConnect(room, runtimeContext = null) {
        const uniqueId = room.roomId; // Using roomId as uniqueId/username to connect

        if (this.disconnectingRooms.has(uniqueId)) {
            // Avoid starting a new connection while we are archiving a session for this room
            return;
        }

        if (this.connectingRooms.has(uniqueId)) {
            // A connection attempt is already in progress
            return;
        }

        if (this.isConnectCooldownActive(uniqueId)) {
            return;
        }

        if (this.isGlobalConnectCooldownActive()) {
            return;
        }

        console.log(`[AutoRecorder] Checking ${uniqueId} (${room.name})...`);

        const connectTask = (async () => {
            const context = runtimeContext || await this.buildRuntimeContext();
            const { dbSettings, proxyUrl, sessionId, precheckLiveTtlMs, sessionOpsConfig } = context;

            // Create a temporary wrapper just to check status or connect
            let cachedRoomId = null;
            try {
                cachedRoomId = await manager.getCachedRoomId(uniqueId);
                if (cachedRoomId) {
                    console.log(`[AutoRecorder] Using cached Room ID for ${uniqueId}: ${cachedRoomId}`);
                }
            } catch (e) {
                console.warn(`[AutoRecorder] Failed to read cached Room ID for ${uniqueId}:`, e?.message || e);
            }

            let liveProbe = null;
            let allowDirectConnectAfterUnavailableProbe = false;
            let usedDirectFallbackAfterUnavailableProbe = false;
            let directFallbackBudgetType = null;
            try {
                liveProbe = await this.probeRoomLiveState(uniqueId, cachedRoomId, {
                    proxyUrl,
                    eulerApiKey: dbSettings.euler_api_key || null,
                });
            } catch (error) {
                this.setConnectCooldown(uniqueId, AUTO_MONITOR_PRECHECK_FAILURE_COOLDOWN_MS, 'probe-failed');
                throw error;
            }

            if (!liveProbe?.shouldConnect) {
                this.clearPrecheckedRoomLive(uniqueId);
                if (liveProbe?.source === 'snapshot_offline') {
                    await this.updateBlockedProbeDynamicProfile(uniqueId, 'offline', {
                        source: liveProbe.source || 'snapshot_offline',
                    }).catch(() => { });
                    await liveStateService.markRoomOffline(uniqueId, {
                        lastEventAt: new Date().toISOString(),
                    }).catch(() => { });
                    console.log(`[AutoRecorder] ${uniqueId} probe status=${liveProbe.liveStatus ?? 'unknown'}; skip connect.`);
                } else if (liveProbe?.source === 'snapshot_unavailable') {
                    const fallbackDecision = this.shouldAttemptDirectConnectAfterUnavailableProbe(room, context, {
                        cachedRoomId,
                        probeError: liveProbe.error || '',
                    });
                    if (fallbackDecision.shouldAttempt && this.consumeProbeUnavailableDirectConnectBudget(uniqueId, context, fallbackDecision.priority, fallbackDecision.budgetType)) {
                        allowDirectConnectAfterUnavailableProbe = true;
                        usedDirectFallbackAfterUnavailableProbe = true;
                        directFallbackBudgetType = fallbackDecision.budgetType || null;
                        console.log(
                            `[AutoRecorder] ${uniqueId} live snapshot unavailable; allow direct connect fallback ` +
                            `(bucket=${fallbackDecision.priority.bucket}, score=${fallbackDecision.priority.score}, ` +
                            `budgetLeft=${fallbackDecision.budgetType === 'cached_room_blocked_probe'
                                ? context.blockedProbeCachedRoomConnectBudget?.remaining ?? 0
                                : context.probeUnavailableDirectConnectBudget?.remaining ?? 0}, ` +
                            `budgetType=${fallbackDecision.budgetType}).`
                        );
                    } else {
                        this.setConnectCooldown(uniqueId, AUTO_MONITOR_PRECHECK_FAILURE_COOLDOWN_MS, 'snapshot-unavailable');
                        this.recordMonitorFailure(uniqueId, 'snapshot_unavailable', liveProbe.error || 'live snapshot unavailable', {
                            stage: 'probe',
                            reason: fallbackDecision.reason || 'snapshot-unavailable',
                            source: liveProbe.source || null,
                        });
                        console.log(`[AutoRecorder] ${uniqueId} live snapshot unavailable; retry later (${liveProbe.error || 'unknown'}).`);
                    }
                }
                if (!allowDirectConnectAfterUnavailableProbe) {
                    return;
                }
            }

            if (liveProbe?.shouldConnect) {
                try {
                    await this.runPreconnectSessionMaintenance(uniqueId, sessionOpsConfig);
                } catch (err) {
                    console.error(`[AutoRecorder] Warning: Failed to check stale events for ${uniqueId}:`, err.message);
                }

                cachedRoomId = String(liveProbe.numericRoomId || cachedRoomId || '').trim() || null;
                this.markPrecheckedRoomLive(uniqueId, cachedRoomId, {
                    ttlMs: precheckLiveTtlMs,
                    source: liveProbe.source || 'precheck',
                });
                await liveStateService.markRoomLive(uniqueId, {
                    resetAggregates: false,
                    lastEventAt: new Date().toISOString(),
                }).catch((error) => {
                    console.warn(`[AutoRecorder] Failed to publish prechecked live state for ${uniqueId}:`, error?.message || error);
                });
            }

            const options = {
                enableExtendedGiftInfo: true,
                fetchRoomInfoOnConnect: !cachedRoomId,
                preferEulerRoomLookup: false,
                proxyUrl,
                eulerApiKey: dbSettings.euler_api_key,
                // Conditionally add session credentials
                ...(sessionId ? {
                    sessionId: sessionId,
                    ttTargetIdc: dbSettings.tt_target_idc || process.env.TT_TARGET_IDC || 'useast2a'
                } : {})
            };

            const maxRetries = 3;
            let lastError = null;
            let useCachedRoomId = Boolean(cachedRoomId);

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                const wrapper = new TikTokConnectionWrapper(uniqueId, options, true);

                try {
                    await this.waitForConnectStartSlot(uniqueId);
                    await new Promise((resolve, reject) => {
                        let initialConnectionEstablished = false;
                        let promiseSettled = false;
                        const connectTimeoutMs = 45000;
                        const timeout = setTimeout(() => {
                            if (!initialConnectionEstablished) {
                                try { wrapper.disconnect(); } catch (e) { }
                                if (!promiseSettled) {
                                    promiseSettled = true;
                                    reject(new Error('Connection Timeout'));
                                }
                            }
                        }, connectTimeoutMs);

                        wrapper.on('connected', async state => {
                            const isInitialConnect = !initialConnectionEstablished;
                            if (isInitialConnect) {
                                initialConnectionEstablished = true;
                                clearTimeout(timeout);
                            }

                            try {
                                const existing = this.activeConnections.get(uniqueId);
                                const hadExistingConnection = Boolean(existing);
                                const connectedRoomId = String(state.roomId || existing?.roomId || cachedRoomId || '').trim() || null;
                                console.log(`[AutoRecorder] ${uniqueId} connected on attempt ${attempt}. RoomID: ${connectedRoomId || 'unknown'}`);

                                let shouldResetLiveState = true;

                                if (existing) {
                                    existing.wrapper = wrapper;
                                    existing.pendingWrites = existing.pendingWrites || new Set();
                                    if (connectedRoomId) {
                                        existing.roomId = connectedRoomId;
                                    }
                                    if (typeof existing.pendingLiveResetAggregates !== 'boolean') {
                                        existing.pendingLiveResetAggregates = false;
                                    }
                                    shouldResetLiveState = false;
                                    console.log(`[AutoRecorder] ${uniqueId} reconnected, refreshing event listeners`);
                                } else {
                                    const sessionOpsConfig = await this.getSessionMaintenanceConfig();
                                    const resumeWindowMs = Math.max(0, Number(sessionOpsConfig.resumeWindowMinutes || 0)) * 60 * 1000;
                                    let shouldResume = false;

                                    try {
                                        const sessions = await manager.getSessions(uniqueId);
                                        if (sessions && sessions.length > 0) {
                                            const lastSession = sessions[0];
                                            const sessionEndTime = lastSession.endTime
                                                ? new Date(lastSession.endTime).getTime()
                                                : new Date(lastSession.created_at || lastSession.createdAt).getTime();
                                            const timeSinceSessionEnd = Date.now() - sessionEndTime;

                                            if (timeSinceSessionEnd < resumeWindowMs) {
                                                console.log(`[AutoRecorder] ${uniqueId} reconnecting within 30 mins of last session END (${Math.floor(timeSinceSessionEnd / 1000 / 60)}m ago). Resuming...`);
                                                shouldResume = true;
                                            }
                                        }

                                        const pendingArchive = this.pendingArchives.get(uniqueId);
                                        let resumedStartTime = null;
                                        if (pendingArchive && (Date.now() - pendingArchive.disconnectTime) < resumeWindowMs) {
                                            if (pendingArchive.timerId) {
                                                clearTimeout(pendingArchive.timerId);
                                            }
                                            console.log(`[AutoRecorder] 🔄 ${uniqueId} reconnected within ${sessionOpsConfig.resumeWindowMinutes} min, cancelling archive timer and resuming session...`);
                                            shouldResume = true;
                                            resumedStartTime = pendingArchive.startTime;
                                            this.pendingArchives.delete(uniqueId);
                                            await this.recordSessionMaintenanceEventSafe({
                                                taskKey: 'pending_archive_cancelled',
                                                triggerSource: 'reconnect-resume',
                                                roomId: uniqueId,
                                                status: 'cancelled',
                                                message: '断线延迟归档被取消，恢复到原场次继续采集',
                                                summary: {
                                                    resumeWindowMinutes: sessionOpsConfig.resumeWindowMinutes,
                                                    disconnectAgoMs: Date.now() - pendingArchive.disconnectTime,
                                                },
                                                config: sessionOpsConfig,
                                            });
                                        }

                                        if (!shouldResume) {
                                            const orphanCount = await manager.getUntaggedEventCount(uniqueId, null);
                                            if (orphanCount > 0) {
                                                console.log(`[AutoRecorder] Found ${orphanCount} orphan events for ${uniqueId}, archiving before new stream...`);
                                                await runSessionMaintenanceTask('archive_stale_live_events_room', {
                                                    roomId: uniqueId,
                                                    triggerSource: 'new-stream-guard',
                                                    configOverride: sessionOpsConfig,
                                                });
                                            }
                                        } else {
                                            const orphanCount = await manager.getUntaggedEventCount(uniqueId, null);
                                            if (orphanCount > 0) {
                                                console.log(`[AutoRecorder] ${uniqueId} resuming with ${orphanCount} existing events (no new archive created)`);
                                            }
                                            await this.recordSessionMaintenanceEventSafe({
                                                taskKey: 'reconnect_resume_session',
                                                triggerSource: 'reconnect-resume',
                                                roomId: uniqueId,
                                                status: 'success',
                                                message: '直播间在续场窗口内恢复连接，沿用原逻辑场次',
                                                summary: {
                                                    resumeWindowMinutes: sessionOpsConfig.resumeWindowMinutes,
                                                    pendingArchive: Boolean(pendingArchive),
                                                },
                                                config: sessionOpsConfig,
                                            });
                                        }

                                        shouldResetLiveState = !shouldResume;
                                        const sessionStartTime = resumedStartTime || this._restoredStartTime || new Date();
                                        const initialLastEventTime = sessionStartTime instanceof Date ? sessionStartTime.getTime() : Date.now();
                                        this.activeConnections.set(uniqueId, {
                                            wrapper,
                                            startTime: sessionStartTime,
                                            lastEventTime: initialLastEventTime,
                                            lastConfirmedLiveAt: 0,
                                            liveValidated: false,
                                            pendingLiveResetAggregates: shouldResetLiveState,
                                            pendingWrites: new Set(),
                                            roomId: connectedRoomId
                                        });
                                    } catch (e) {
                                        console.error(`[AutoRecorder] Error checking resume status for ${uniqueId}:`, e);

                                        const fallbackStartTime = this._restoredStartTime || new Date();
                                        const initialLastEventTime = fallbackStartTime instanceof Date ? fallbackStartTime.getTime() : Date.now();
                                        this.activeConnections.set(uniqueId, {
                                            wrapper,
                                            startTime: fallbackStartTime,
                                            lastEventTime: initialLastEventTime,
                                            lastConfirmedLiveAt: 0,
                                            liveValidated: false,
                                            pendingLiveResetAggregates: true,
                                            pendingWrites: new Set(),
                                            roomId: connectedRoomId
                                        });
                                    }
                                }

                                this.pendingOffline.delete(uniqueId);
                                this.failureCount.delete(uniqueId);

                if (connectedRoomId) {
                    manager.setNumericRoomId(uniqueId, connectedRoomId).catch(console.error);
                }

                if (usedDirectFallbackAfterUnavailableProbe) {
                    await this.updateBlockedProbeDynamicProfile(uniqueId, 'connect-success', {
                        source: directFallbackBudgetType || 'direct-fallback',
                        probeError: liveProbe?.error || null,
                    }).catch((error) => {
                        console.warn(`[AutoRecorder] Failed to update dynamic profile after fallback success for ${uniqueId}:`, error?.message || error);
                    });
                } else if (liveProbe?.shouldConnect) {
                    await this.updateBlockedProbeDynamicProfile(uniqueId, 'probe-recovered', {
                        source: liveProbe?.source || 'precheck',
                    }).catch(() => { });
                }

                if (state.roomInfo && state.roomInfo.owner) {
                    const ownerId = state.roomInfo.owner.id_str || state.roomInfo.owner.id;
                                    if (ownerId) {
                                        manager.updateRoomOwner(uniqueId, ownerId.toString()).catch(err =>
                                            console.error(`[AutoRecorder] Failed to update owner for ${uniqueId}:`, err.message)
                                        );
                                    }
                                }

                                this.setupLogging(wrapper, uniqueId, connectedRoomId);

                                if (connectedRoomId) {
                                    const liveConfirmed = await this.confirmConnectionLive(uniqueId, hadExistingConnection ? 'reconnect-check_alive' : 'connect-check_alive');
                                    if (!liveConfirmed) {
                                        console.log(`[AutoRecorder] ${uniqueId} connected but not yet live-validated by check_alive.`);
                                    }
                                } else {
                                    console.log(`[AutoRecorder] ${uniqueId} connected without numeric room id, waiting for first event to validate live state.`);
                                }

                                await this.ensureAutoRecordingForRoom(uniqueId, connectedRoomId, room, hadExistingConnection ? 'auto-reconnect' : 'auto-connect');

                                if (wrapper.connection && !wrapper.__autoRecorderStreamEndBound) {
                                    wrapper.__autoRecorderStreamEndBound = true;
                                    wrapper.connection.on('streamEnd', () => {
                                        console.log(`[AutoRecorder] ${uniqueId} stream ended.`);
                                        this.handleDisconnect(uniqueId, 'streamEnd');
                                    });
                                }

                                const validationDelayMs = 60 * 1000;
                                setTimeout(async () => {
                                    const conn = this.activeConnections.get(uniqueId);
                                    if (!conn) return;

                                    const now = Date.now();
                                    const timeSinceStart = now - (conn.startTime?.getTime() || now);
                                    const timeSinceEvent = now - (conn.lastEventTime || now);

                                    if (timeSinceStart >= validationDelayMs && timeSinceEvent >= validationDelayMs - 5000) {
                                        const currentRoomId = String(conn.roomId || connectedRoomId || '').trim() || null;
                                        const aliveStatus = currentRoomId
                                            ? await fetchRoomAliveStatus(currentRoomId)
                                            : { ok: false, alive: null, error: 'missing numeric room id' };

                                        if (aliveStatus.ok && aliveStatus.alive === true) {
                                            await this.promoteConnectionToLive(uniqueId, {}, 'delayed-check_alive');
                                            console.log(`[AutoRecorder] ${uniqueId} has no events after ${Math.floor(timeSinceStart / 1000)}s, but check_alive=true. Keeping connection.`);
                                            return;
                                        }

                                        if (aliveStatus.ok && aliveStatus.alive === false) {
                                            if (!this.pendingOffline.has(uniqueId)) {
                                                this.pendingOffline.set(uniqueId, Date.now());
                                            }
                                            console.log(`[AutoRecorder] ${uniqueId} has no events after ${Math.floor(timeSinceStart / 1000)}s and check_alive=false. Waiting for heartbeat confirmation.`);
                                            return;
                                        }

                                        console.log(`[AutoRecorder] ${uniqueId} has no events after ${Math.floor(timeSinceStart / 1000)}s, but live status is unavailable (${aliveStatus.error || 'unknown'}). Keeping connection.`);
                                    }
                                }, validationDelayMs);

                                if (!promiseSettled) {
                                    promiseSettled = true;
                                    resolve();
                                }
                            } catch (error) {
                                if (!promiseSettled) {
                                    promiseSettled = true;
                                    reject(error);
                                    return;
                                }
                                console.error(`[AutoRecorder] Failed to refresh connected state for ${uniqueId}:`, error?.message || error);
                            }
                        });

                        wrapper.once('disconnected', reason => {
                            if (!initialConnectionEstablished) {
                                clearTimeout(timeout);
                                if (!promiseSettled) {
                                    promiseSettled = true;
                                    reject(new Error(reason));
                                }
                                return;
                            }

                            console.log(`[AutoRecorder] ${uniqueId} disconnected: ${reason}`);
                            this.handleDisconnect(uniqueId, reason);
                        });

                        wrapper.connect(false, useCachedRoomId ? cachedRoomId : null).catch(err => {
                            if (!initialConnectionEstablished) {
                                clearTimeout(timeout);
                                if (!promiseSettled) {
                                    promiseSettled = true;
                                    reject(err);
                                }
                            }
                        });
                    });

                    return;
                } catch (err) {
                    lastError = err;
                    const errStr = getConnectErrorText(err);

                    if (isConnectionStartRateLimitedError(errStr)) {
                        this.setGlobalConnectCooldown(AUTO_MONITOR_CONNECT_RATE_LIMIT_COOLDOWN_MS, 'too-many-connections-started');
                        this.setConnectCooldown(uniqueId, AUTO_MONITOR_CONNECT_RATE_LIMIT_COOLDOWN_MS, 'too-many-connections-started');
                    }

                    if (useCachedRoomId && isRetryableCachedRoomIdError(errStr)) {
                        console.log(`[AutoRecorder] ${uniqueId} cached Room ID ${cachedRoomId} failed, retrying with fresh room lookup...`);
                        await manager.setNumericRoomId(uniqueId, null).catch(() => { });
                        cachedRoomId = null;
                        useCachedRoomId = false;
                        continue;
                    }

                    if (isRetryableAutoConnectError(errStr) && attempt < maxRetries) {
                        const delay = 2000 * attempt;
                        console.log(`[AutoRecorder] ${uniqueId} auto connect attempt ${attempt}/${maxRetries} failed: ${errStr.slice(0, 80)}... Retrying in ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }

                    throw err;
                }
            }

            throw lastError || new Error('Connection failed after all retries');

        })();

        this.connectingRooms.set(uniqueId, connectTask);

        try {
            await connectTask;
        } catch (err) {

            // Track failures for persistent room ID fetch issues
            const errMsg = getConnectErrorText(err);
            const isRoomIdError = isRoomIdResolutionFailure(errMsg);

            if (isRoomIdError) {
                const count = (this.failureCount.get(uniqueId) || 0) + 1;
                this.failureCount.set(uniqueId, count);
                await this.updateBlockedProbeDynamicProfile(uniqueId, 'connect-failure', {
                    source: 'room-id-resolution-failed',
                    probeError: errMsg,
                }).catch(() => { });
                this.recordMonitorFailure(uniqueId, 'room_id_resolution', errMsg, {
                    stage: 'connect',
                    reason: 'room-id-resolution-failed',
                });
                console.log(`[AutoRecorder] ${uniqueId} 房间信息解析失败 (${count} 次)。保留监控并稍后重试。`);
                this.setConnectCooldown(uniqueId, AUTO_MONITOR_RETRYABLE_FAILURE_COOLDOWN_MS, 'room-id-resolution-failed');
            } else if (isConnectionStartRateLimitedError(errMsg)) {
                this.recordMonitorFailure(uniqueId, 'connect_rate_limited', errMsg, {
                    stage: 'connect',
                    reason: 'too-many-connections-started',
                });
                this.setConnectCooldown(uniqueId, AUTO_MONITOR_CONNECT_RATE_LIMIT_COOLDOWN_MS, 'too-many-connections-started');
            } else if (isRetryableAutoConnectError(errMsg)) {
                await this.updateBlockedProbeDynamicProfile(uniqueId, 'connect-failure', {
                    source: 'retryable-connect-failed',
                    probeError: errMsg,
                }).catch(() => { });
                this.recordMonitorFailure(uniqueId, 'retryable_connect_error', errMsg, {
                    stage: 'connect',
                    reason: 'retryable-connect-failed',
                });
                this.setConnectCooldown(uniqueId, AUTO_MONITOR_RETRYABLE_FAILURE_COOLDOWN_MS, 'retryable-connect-failed');
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

        const syncLiveState = (patch = {}) => {
            const conn = this.activeConnections.get(uniqueId);
            if (!conn) return;

            if (conn.liveValidated === true) {
                liveStateService.touchRoomLive(uniqueId, patch).catch((error) => {
                    console.error(`[AutoRecorder] Failed to refresh live state for ${uniqueId}:`, error?.message || error);
                });
                return;
            }

            this.promoteConnectionToLive(uniqueId, patch, 'runtime-event').catch((error) => {
                console.error(`[AutoRecorder] Failed to promote live state for ${uniqueId}:`, error?.message || error);
            });
        };

        const trackGiftLiveValue = (giftData) => {
            const giftValue = Math.max(0, Number(giftData?.diamondCount || 0) * Number(giftData?.repeatCount || 1));
            if (giftValue > 0) {
                syncLiveState({ giftValueDelta: giftValue });
            } else {
                syncLiveState();
            }
        };

        // Helper to update lastEventTime for heartbeat tracking
        const updateLastEventTime = (patch = {}) => {
            const conn = this.activeConnections.get(uniqueId);
            const lastEventTime = Date.now();
            if (conn) {
                conn.lastEventTime = lastEventTime;
                if (conn.liveValidated === true) {
                    conn.lastConfirmedLiveAt = lastEventTime;
                }
            }
            syncLiveState({
                ...patch,
                lastEventAt: new Date(lastEventTime).toISOString(),
            });
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
                region: msg.user?.region || '',
                ...roleInfo
            };
            logEvent('member', data);
        });

        wrapper.connection.on('chat', msg => {
            updateLastEventTime({ chatCountDelta: 1 });
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
                        trackGiftLiveValue(existing.data);
                        logEvent('gift', existing.data);
                        activeGiftCombos.delete(groupId);
                    }
                } else {
                    // First event of this combo
                    activeGiftCombos.set(groupId, { data: data, timestamp: Date.now() });

                    // If repeatEnd is true immediately (single gift or instant combo end), log it
                    if (msg.repeatEnd) {
                        trackGiftLiveValue(data);
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
                        trackGiftLiveValue(combo.data);
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
            trackGiftLiveValue(data);
            logEvent('gift', data);
        });

        wrapper.connection.on('like', msg => {
            updateLastEventTime();
            const roleInfo = extractRoleInfo(msg);
            const data = {
                uniqueId: msg.user?.uniqueId || msg.uniqueId,
                nickname: msg.user?.nickname || msg.nickname,
                userId: msg.user?.userId || msg.userId,
                region: msg.user?.region || '',
                likeCount: msg.likeCount,
                totalLikeCount: msg.totalLikeCount,
                ...roleInfo
            };
            logEvent('like', data);
        });


        wrapper.connection.on('roomUser', msg => {
            const viewerCount = Number(
                msg?.viewerCount
                ?? msg?.viewer_count
                ?? msg?.onlineUserCount
                ?? msg?.userCount
                ?? msg?.roomUserCount
                ?? msg?.viewer?.count
                ?? 0
            ) || 0;
            updateLastEventTime({ viewerCount });
            logEvent('roomUser', {
                viewerCount,
                comment: viewerCount > 0 ? `viewer:${viewerCount}` : null
            });
        });
    }

    // Check if a room is currently connected
    isConnected(uniqueId) {
        const conn = this.activeConnections.get(uniqueId);
        return conn?.wrapper?.connection?.isConnected === true;
    }

    // Get the connection wrapper for a room (for event forwarding to UI)
    getConnection(uniqueId) {
        const conn = this.activeConnections.get(uniqueId);
        return conn ? conn.wrapper : null;
    }

    // Trigger an immediate background connect attempt after a room is added or monitoring is re-enabled.
    requestImmediateCheck(room, reason = 'manual-trigger') {
        const roomPayload = typeof room === 'string'
            ? { roomId: String(room || '').trim(), name: String(room || '').trim() }
            : {
                ...room,
                roomId: String(room?.roomId || '').trim(),
                name: room?.name || room?.roomId || '',
            };

        if (!roomPayload.roomId) {
            return false;
        }

        setTimeout(async () => {
            try {
                const latestRoom = await manager.getRoom(roomPayload.roomId).catch(() => null);
                const effectiveRoom = latestRoom || roomPayload;
                if (effectiveRoom.isMonitorEnabled === 0 || effectiveRoom.is_monitor_enabled === 0) {
                    return;
                }

                console.log(`[AutoRecorder] Immediate connect check requested for ${roomPayload.roomId} (${reason})`);
                await this.checkAndConnect({
                    ...effectiveRoom,
                    roomId: effectiveRoom.roomId || roomPayload.roomId,
                    name: effectiveRoom.name || roomPayload.name || roomPayload.roomId,
                });
            } catch (err) {
                console.error(`[AutoRecorder] Immediate connect check failed for ${roomPayload.roomId}:`, err?.message || err);
            }
        }, 0);

        return true;
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
            await this.recoverStaleActiveConnection(uniqueId, 'manual-start');
        }

        if (this.activeConnections.has(uniqueId)) {
            if (this.isConnectionUsable(uniqueId)) {
                const state = this.getConnectionState(uniqueId);
                console.log(`[AutoRecorder] Room ${uniqueId} already connected`);
                return { success: true, alreadyConnected: true, state };
            }
            console.log(`[AutoRecorder] Room ${uniqueId} has unusable active state. Recycling before reconnect...`);
            await this.recycleUnusableConnection(uniqueId, 'manual-start-unusable');
        }

        // If an auto-monitor connect attempt is already running, wait for it instead of starting a duplicate.
        const pendingConnect = this.connectingRooms.get(uniqueId);
        if (pendingConnect) {
            console.log(`[AutoRecorder] ${uniqueId} connection attempt already in progress. Waiting...`);
            try { await pendingConnect; } catch (e) { }
            if (this.activeConnections.has(uniqueId)) {
                if (this.isConnectionUsable(uniqueId)) {
                    const state = this.getConnectionState(uniqueId);
                    return { success: true, alreadyConnected: true, state };
                }
            }
        }

        console.log(`[AutoRecorder] Manual start requested for ${uniqueId}`);

        const connectTask = (async () => {
            // Create a room entry if it doesn't exist (don't overwrite name or monitor setting)
            await manager.updateRoom(uniqueId, null, null, undefined);

            // Fetch room details (including recording settings)
            const room = await manager.getRoom(uniqueId);


            // Use the same connection logic as checkAndConnect
            const runtimeContext = await this.buildRuntimeContext();
            const { dbSettings, proxyUrl, sessionId, precheckLiveTtlMs } = runtimeContext;

            let cachedRoomId = null;
            let usedDirectFallbackAfterUnavailableProbe = false;
            try {
                cachedRoomId = await manager.getCachedRoomId(uniqueId);
                if (cachedRoomId) {
                    console.log(`[AutoRecorder] Manual start will use cached Room ID for ${uniqueId}: ${cachedRoomId}`);
                }
            } catch (e) {
                console.warn(`[AutoRecorder] Failed to read cached Room ID for manual start ${uniqueId}:`, e?.message || e);
            }

            let liveProbe = null;
            try {
                liveProbe = await this.probeRoomLiveState(uniqueId, cachedRoomId, {
                    proxyUrl,
                    eulerApiKey: dbSettings.euler_api_key,
                });
            } catch (error) {
                console.warn(`[AutoRecorder] Manual precheck failed for ${uniqueId}:`, error?.message || error);
            }

            if (liveProbe?.shouldConnect) {
                cachedRoomId = String(liveProbe.numericRoomId || cachedRoomId || '').trim() || null;
                this.markPrecheckedRoomLive(uniqueId, cachedRoomId, {
                    ttlMs: precheckLiveTtlMs,
                    source: liveProbe.source || 'manual-precheck',
                });
                await liveStateService.markRoomLive(uniqueId, {
                    resetAggregates: false,
                    lastEventAt: new Date().toISOString(),
                }).catch((error) => {
                    console.warn(`[AutoRecorder] Failed to publish manual prechecked live state for ${uniqueId}:`, error?.message || error);
                });
            } else if (liveProbe?.source === 'snapshot_unavailable') {
                this.clearPrecheckedRoomLive(uniqueId);
                usedDirectFallbackAfterUnavailableProbe = Boolean(cachedRoomId);
                console.log(`[AutoRecorder] ${uniqueId} manual precheck unavailable; keep direct connect path available.`);
            } else if (liveProbe) {
                this.clearPrecheckedRoomLive(uniqueId);
                await this.updateBlockedProbeDynamicProfile(uniqueId, 'offline', {
                    source: liveProbe.source || 'manual-offline',
                }).catch(() => { });
                await liveStateService.markRoomOffline(uniqueId, {
                    lastEventAt: new Date().toISOString(),
                }).catch(() => { });
                throw new Error(`Room is offline (precheck: ${liveProbe.source || 'unknown'}, status: ${liveProbe.liveStatus ?? 'unknown'})`);
            }

            const options = {
                enableExtendedGiftInfo: true,
                fetchRoomInfoOnConnect: !cachedRoomId,
                preferEulerRoomLookup: false,
                proxyUrl,
                eulerApiKey: dbSettings.euler_api_key,
                ...(sessionId ? {
                    sessionId: sessionId,
                    ttTargetIdc: dbSettings.tt_target_idc || process.env.TT_TARGET_IDC || 'useast2a'
                } : {})
            };

            // Retry loop - create new wrapper for each attempt
            const maxRetries = 3;
            let lastError = null;
            let useCachedRoomId = Boolean(cachedRoomId);

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

                        wrapper.once('connected', async state => {
                            connected = true;
                            clearTimeout(timeout);
                            const connectedRoomId = String(state.roomId || cachedRoomId || '').trim() || null;
                            console.log(`[AutoRecorder] ${uniqueId} connected on attempt ${attempt}. RoomID: ${connectedRoomId || 'unknown'}`);
                            this.activeConnections.set(uniqueId, {
                                wrapper: wrapper,
                                startTime: new Date(),
                                lastEventTime: Date.now(),
                                lastConfirmedLiveAt: 0,
                                liveValidated: false,
                                pendingLiveResetAggregates: true,
                                pendingWrites: new Set(),
                                roomId: connectedRoomId
                            });
                            this.pendingOffline.delete(uniqueId);

                            if (connectedRoomId) {
                                manager.setNumericRoomId(uniqueId, connectedRoomId).catch(console.error);
                            }

                            if (usedDirectFallbackAfterUnavailableProbe) {
                                await this.updateBlockedProbeDynamicProfile(uniqueId, 'connect-success', {
                                    source: 'manual-direct-fallback',
                                    probeError: liveProbe?.error || null,
                                }).catch(() => { });
                            } else if (liveProbe?.shouldConnect) {
                                await this.updateBlockedProbeDynamicProfile(uniqueId, 'probe-recovered', {
                                    source: liveProbe?.source || 'manual-precheck',
                                }).catch(() => { });
                            }

                            this.setupLogging(wrapper, uniqueId, connectedRoomId);

                            if (connectedRoomId) {
                                const liveConfirmed = await this.confirmConnectionLive(uniqueId, 'manual-connect-check_alive');
                                if (!liveConfirmed) {
                                    console.log(`[AutoRecorder] ${uniqueId} manual connection established but not yet live-validated by check_alive.`);
                                }
                            } else {
                                console.log(`[AutoRecorder] ${uniqueId} manual connection missing numeric room id, waiting for first event to validate live state.`);
                            }

                            await this.ensureAutoRecordingForRoom(uniqueId, connectedRoomId, room, 'manual-connect');

                            wrapper.once('disconnected', reason => {

                                console.log(`[AutoRecorder] ${uniqueId} disconnected after connection: ${reason}`);
                                this.handleDisconnect(uniqueId, reason);
                            });

                            wrapper.connection.on('streamEnd', () => {

                                console.log(`[AutoRecorder] ${uniqueId} stream ended.`);
                                this.handleDisconnect(uniqueId, 'streamEnd');
                            });

                            resolve({ success: true, state: this.getConnectionState(uniqueId) || { uniqueId, roomId: connectedRoomId, liveValidated: false, isLive: false, wsConnected: true } });
                        });

                        wrapper.once('disconnected', reason => {
                            if (!connected) {
                                clearTimeout(timeout);
                                reject(new Error(reason));
                            }
                        });

                        wrapper.connect(false, useCachedRoomId ? cachedRoomId : null).catch(err => {
                            if (!connected) {
                                clearTimeout(timeout);
                                reject(err);
                            }
                        });
                    });

                    return result; // Success!

                } catch (err) {
                    lastError = err;
                    const errStr = getConnectErrorText(err);

                    if (usedDirectFallbackAfterUnavailableProbe) {
                        await this.updateBlockedProbeDynamicProfile(uniqueId, 'connect-failure', {
                            source: 'manual-connect-failed',
                            probeError: errStr,
                        }).catch(() => { });
                    }

                    if (useCachedRoomId && isRetryableCachedRoomIdError(errStr)) {
                        console.log(`[AutoRecorder] ${uniqueId} cached Room ID ${cachedRoomId} failed, retrying with fresh room lookup...`);
                        await manager.setNumericRoomId(uniqueId, null).catch(() => { });
                        cachedRoomId = null;
                        useCachedRoomId = false;
                        continue;
                    }

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
                this.pendingOffline.delete(uniqueId);
                this.clearPrecheckedRoomLive(uniqueId);
                await liveStateService.markRoomOffline(uniqueId, {
                    lastEventAt: conn.lastEventTime ? new Date(conn.lastEventTime).toISOString() : undefined,
                });

                // Stop Recording if active
                if (this.recordingManager) {
                    // We need the numeric roomId to stop recording
                    // conn.roomId should be available
                    if (conn.roomId) {
                        this.recordingManager.stopRecording(conn.roomId)
                            .catch(err => console.error(`[AutoRecorder] Failed to stop recording for ${uniqueId}: ${err.message}`));
                    }
                }

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
                const sessionOpsConfig = await this.getSessionMaintenanceConfig();
                const archiveDelayMinutes = Math.max(0, Number(sessionOpsConfig.archiveDelayMinutes || 0));

                if (immediate || archiveDelayMinutes === 0) {
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
                    const disconnectTime = Date.now();
                    const timerId = setTimeout(() => {
                        this.executeArchive(uniqueId, startIso, reason, eventCount).catch(err => {
                            console.error(`[AutoRecorder] Delayed archive failed for ${uniqueId}:`, err?.message);
                        });
                    }, this.ARCHIVE_DELAY_MS);

                    // Store pending archive info
                    this.pendingArchives.set(uniqueId, {
                        startTime: startTime,
                        startIso: startIso,
                        disconnectTime,
                        timerId: timerId,
                        eventCount: eventCount,
                        reason: reason,
                        archiveDelayMs: this.ARCHIVE_DELAY_MS,
                    });

                    console.log(`[AutoRecorder] ⏰ Session for ${uniqueId} will be archived in ${archiveDelayMinutes} min (${eventCount} events). Reconnection will resume.`);
                    await this.recordSessionMaintenanceEventSafe({
                        taskKey: 'pending_archive_scheduled',
                        triggerSource: immediate ? 'manual-stop' : 'disconnect-delay',
                        roomId: uniqueId,
                        status: 'scheduled',
                        message: '断线后已创建延迟归档任务，等待续场窗口结束',
                        summary: {
                            eventCount,
                            archiveDelayMinutes,
                            resumeWindowMinutes: sessionOpsConfig.resumeWindowMinutes,
                            reason: reason || '',
                        },
                        config: sessionOpsConfig,
                    });
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
        const sessionOpsConfig = await this.getSessionMaintenanceConfig();
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
            await this.recordSessionMaintenanceEventSafe({
                taskKey: 'execute_archive_session',
                triggerSource: 'disconnect-archive',
                roomId: uniqueId,
                status: 'skipped',
                message: '归档跳过：归档时没有礼物事件',
                summary: {
                    eventCount: finalEventCount,
                    giftCount: finalGiftCount,
                    reason: reason || '',
                },
                config: sessionOpsConfig,
            });
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
            await manager.markRoomStatsDirty([uniqueId], 'auto-recorder-archive');
            await invalidateRoomDetailCaches(uniqueId, [sessionId]);
            console.log(`[AutoRecorder] ✅ Session saved: ${sessionId}`);
            await this.recordSessionMaintenanceEventSafe({
                taskKey: 'execute_archive_session',
                triggerSource: 'disconnect-archive',
                roomId: uniqueId,
                status: 'success',
                message: `场次归档成功：${sessionId}`,
                summary: {
                    sessionId,
                    eventCount: finalEventCount,
                    giftCount: finalGiftCount,
                    reason: reason || '',
                    requestedEventCount: eventCount,
                },
                config: sessionOpsConfig,
            });

            const merged = await manager.consolidateRoomSessions(uniqueId, {
                lookbackHours: sessionOpsConfig.consolidationLookbackHours,
                gapMinutes: sessionOpsConfig.consolidationGapMinutes,
            });
            if (merged.mergedCount > 0) {
                await this.recordSessionMaintenanceEventSafe({
                    taskKey: 'consolidate_recent_sessions',
                    triggerSource: 'disconnect-inline',
                    roomId: uniqueId,
                    status: 'success',
                    message: `归档后已即时合并 ${merged.mergedCount} 个碎片场次`,
                    summary: merged,
                    config: sessionOpsConfig,
                });
            }

        } catch (err) {
            console.error(`[AutoRecorder] Error saving session: ${err?.message || err}`);
            await this.recordSessionMaintenanceEventSafe({
                taskKey: 'execute_archive_session',
                triggerSource: 'disconnect-archive',
                roomId: uniqueId,
                status: 'failed',
                message: '场次归档失败',
                summary: {
                    eventCount: finalEventCount,
                    giftCount: finalGiftCount,
                    reason: reason || '',
                },
                errorMessage: err?.message || String(err),
                config: sessionOpsConfig,
            });
        }
    }
    setRecordingManager(rm) {
        this.recordingManager = rm;
    }
}

module.exports = { AutoRecorder };
