/**
 * KeyManager - Manages multiple Euler API keys with rotation, rate-limit handling,
 * and database-backed storage with usage tracking
 */
const db = require('../db');
const { isEulerRateLimitMessage } = require('./eulerKeyStatus');
const {
    PREMIUM_ROOM_LOOKUP_LEVELS,
    getPremiumRoomLookupState,
    getPremiumRoomLookupLevel,
    getPremiumRoomLookupCheckedAt,
    supportsPremiumRoomLookup,
} = require('./eulerKeyCapability');

let metricsService;
try {
    metricsService = require('../services/metricsService');
} catch (err) {
    metricsService = {
        incrementCounter: () => 0,
        emitLog: () => {},
    };
}

class KeyManager {
    constructor() {
        this.keys = [];
        this.disabledKeys = new Map();
        this.currentIndex = 0;
        this._dbLoaded = false;
        this.runtimeStats = {
            selectionCount: 0,
            rotationCount: 0,
            disabledCount: 0,
            reenabledCount: 0,
            rateLimitCount: 0,
            roomLookupRequestCount: 0,
            liveCheckRequestCount: 0,
            connectSuccessCount: 0,
            fallbackConnectCount: 0,
            permissionDeniedCount: 0,
            allKeysDisabledCount: 0,
            lastSelectedKey: null,
            lastSelectedAt: null,
            lastDisabledKey: null,
            lastDisabledAt: null,
            lastDisableReason: null,
            lastConnectAt: null,
            lastConnectPath: null,
            lastKeySource: 'env',
            configSource: 'env',
        };
        this.keyRuntime = new Map();
        this.capabilityProbeInFlight = false;
        this.capabilityRefreshTimer = null;
        this.pendingCapabilityForce = false;
        this.capabilitySweepIntervalMs = 0;

        this._loadKeysFromString(process.env.EULER_KEYS || process.env.EULER_API_KEY || '');
    }

    _maskKey(key) {
        if (!key) return '';
        return `${key.slice(0, 10)}...`;
    }

    _getRuntimeEntry(key) {
        if (!this.keyRuntime.has(key)) {
            this.keyRuntime.set(key, {
                selectedCount: 0,
                disabledCount: 0,
                reenabledCount: 0,
                rateLimitCount: 0,
                roomLookupRequestCount: 0,
                liveCheckRequestCount: 0,
                successCount: 0,
                permissionDeniedCount: 0,
                lastSelectedAt: null,
                lastDisabledAt: null,
                lastDisableReason: null,
                lastConnectAt: null,
                lastConnectPath: null,
                lastError: null,
            });
        }
        return this.keyRuntime.get(key);
    }

    _setConfigSource(source) {
        this.runtimeStats.configSource = source || 'unknown';
    }


    _hydrateDbKeyEntry(row) {
        return {
            id: row.id,
            key: row.keyValue,
            name: row.name || '',
            isActive: row.isActive,
            premiumRoomLookupLevel: getPremiumRoomLookupLevel(row),
            premiumRoomLookupState: getPremiumRoomLookupState(row),
            premiumRoomLookupCheckedAt: getPremiumRoomLookupCheckedAt(row),
            premiumRoomLookupLastStatus: Number(row.premiumRoomLookupLastStatus || 0),
            premiumRoomLookupLastError: row.premiumRoomLookupLastError || '',
            premiumRoomLookupProbeUniqueId: row.premiumRoomLookupProbeUniqueId || '',
        };
    }

    scheduleCapabilityRefresh() {
        return;
    }

    async refreshPremiumCapabilityStates() {
        return;
    }

    _entrySupportsCapability(entry, capability = '') {
        if (!entry || !capability) return true;
        if (capability === 'premium_room_lookup') {
            return supportsPremiumRoomLookup(entry);
        }
        return true;
    }

    _syncRuntimeEntries() {
        const activeKeys = new Set(this.keys.map(entry => entry.key));
        for (const key of Array.from(this.keyRuntime.keys())) {
            if (!activeKeys.has(key)) {
                this.keyRuntime.delete(key);
                this.disabledKeys.delete(key);
            }
        }
        for (const entry of this.keys) {
            this._getRuntimeEntry(entry.key);
        }
    }

    _loadKeysFromString(rawKeys, source = 'env') {
        if (rawKeys) {
            const keyStrs = rawKeys.split(',').map(k => k.trim()).filter(k => k.length > 0);
            this.keys = keyStrs.map((k, i) => ({
                id: null,
                key: k,
                name: `env-key-${i + 1}`,
                isActive: true,
                premiumRoomLookupLevel: PREMIUM_ROOM_LOOKUP_LEVELS.UNSET,
                premiumRoomLookupState: 'unknown',
                premiumRoomLookupCheckedAt: null,
                premiumRoomLookupLastStatus: 0,
                premiumRoomLookupLastError: '',
                premiumRoomLookupProbeUniqueId: '',
            }));
        } else {
            this.keys = [];
        }
        this._setConfigSource(source);
        this._syncRuntimeEntries();
        console.log(`[KeyManager] Loaded ${this.keys.length} keys.`);
        this.keys.forEach((k, i) => {
            console.log(`[KeyManager] Key #${i + 1}: ${k.key.slice(0, 10)}...`);
        });
    }

    async loadFromDb() {
        try {
            const rows = await db.all('SELECT * FROM euler_api_keys WHERE is_active = true ORDER BY id');
            if (rows.length > 0) {
                this.keys = rows.map(r => this._hydrateDbKeyEntry(r));
                this._dbLoaded = true;
                this._setConfigSource('db_table');
                this._syncRuntimeEntries();
                console.log(`[KeyManager] Loaded ${this.keys.length} keys from database.`);
            } else if (!this._dbLoaded) {
                console.log(`[KeyManager] No DB keys found, keeping ${this.keys.length} env keys.`);
            }
        } catch (err) {
            console.error('[KeyManager] Failed to load from DB:', err.message);
        }
    }

    async refreshKeys(dbSettings) {
        try {
            const dbRows = await db.all('SELECT * FROM euler_api_keys WHERE is_active = true ORDER BY id');
            if (dbRows.length > 0) {
                this.keys = dbRows.map(r => this._hydrateDbKeyEntry(r));
                this._dbLoaded = true;
                this._setConfigSource('db_table');
                this._syncRuntimeEntries();
                return;
            }
        } catch (err) {
        }

        const dbKeys = dbSettings?.euler_keys || '';
        const envKeys = process.env.EULER_KEYS || process.env.EULER_API_KEY || '';
        const rawKeys = dbKeys || envKeys;
        const source = dbKeys ? 'settings' : (envKeys ? 'env' : 'none');
        if (!rawKeys) {
            this.keys = [];
            this._setConfigSource(source);
            this._syncRuntimeEntries();
            return;
        }

        if (rawKeys && rawKeys !== this.keys.map(k => k.key).join(',')) {
            this._loadKeysFromString(rawKeys, source);
        } else {
            this._setConfigSource(source);
        }
    }

    getKeyCount() {
        return this.keys.length;
    }

    _recordSelection(entry) {
        const runtime = this._getRuntimeEntry(entry.key);
        const nowIso = new Date().toISOString();
        runtime.selectedCount += 1;
        runtime.lastSelectedAt = nowIso;
        this.runtimeStats.selectionCount += 1;
        if (this.runtimeStats.lastSelectedKey && this.runtimeStats.lastSelectedKey !== entry.key) {
            this.runtimeStats.rotationCount += 1;
        }
        this.runtimeStats.lastSelectedKey = entry.key;
        this.runtimeStats.lastSelectedAt = nowIso;

        metricsService.incrementCounter('euler.key.selection', 1, { keyName: entry.name || 'unnamed' }, { log: false });
        metricsService.emitLog('info', 'euler.key.selected', {
            keyName: entry.name || 'unnamed',
            keyMasked: this._maskKey(entry.key),
            selectionCount: runtime.selectedCount,
            totalSelections: this.runtimeStats.selectionCount,
            rotations: this.runtimeStats.rotationCount,
            activeKeys: this.getStatus().active,
            disabledKeys: this.getStatus().disabled,
        });
    }

    getActiveKeyEntry(options = {}) {
        if (this.keys.length === 0) return null;
        const now = Date.now();
        const capability = options?.capability || '';

        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            const entry = this.keys[idx];
            const disableUntil = this.disabledKeys.get(entry.key);

            if (disableUntil && now < disableUntil) {
                continue;
            }

            if (disableUntil && now >= disableUntil) {
                this.disabledKeys.delete(entry.key);
                const runtime = this._getRuntimeEntry(entry.key);
                runtime.reenabledCount += 1;
                this.runtimeStats.reenabledCount += 1;
                console.log(`[KeyManager] Key ${entry.key.slice(0, 10)}... re-enabled`);
                metricsService.incrementCounter('euler.key.reenabled', 1, { keyName: entry.name || 'unnamed' }, { log: false });
                metricsService.emitLog('info', 'euler.key.reenabled', {
                    keyName: entry.name || 'unnamed',
                    keyMasked: this._maskKey(entry.key),
                    reenabledCount: runtime.reenabledCount,
                    totalReenabled: this.runtimeStats.reenabledCount,
                });
            }

            if (!this._entrySupportsCapability(entry, capability)) {
                continue;
            }

            this.currentIndex = (idx + 1) % this.keys.length;
            this._trackUsage(entry.id);
            this._recordSelection(entry);
            return entry;
        }

        if (capability) {
            console.log(`[KeyManager] No active Euler keys matched capability filter (${capability})`);
            return null;
        }

        this.runtimeStats.allKeysDisabledCount += 1;
        console.log(`[KeyManager] No active Euler keys matched current selection filter (capability=${capability || 'any'})`);
        metricsService.incrementCounter('euler.key.all_disabled', 1, {}, { log: false });
        metricsService.emitLog('warn', 'euler.key.all_disabled', {
            totalKeys: this.keys.length,
            allDisabledCount: this.runtimeStats.allKeysDisabledCount,
            capability: capability || 'any',
        });
        return null;
    }

    getActiveKey(options = {}) {
        const entry = this.getActiveKeyEntry(options);
        return entry ? entry.key : null;
    }

    disableKey(key, durationMs, reason = 'manual', details = {}) {
        if (!key) return;
        const safeDurationMs = Math.max(1000, Number(durationMs) || 0);
        const until = Date.now() + safeDurationMs;
        const entry = this.keys.find(item => item.key === key);
        const runtime = this._getRuntimeEntry(key);
        const untilIso = new Date(until).toISOString();

        this.disabledKeys.set(key, until);
        runtime.disabledCount += 1;
        runtime.lastDisabledAt = untilIso;
        runtime.lastDisableReason = reason;
        runtime.lastError = details.error || null;
        this.runtimeStats.disabledCount += 1;
        this.runtimeStats.lastDisabledKey = key;
        this.runtimeStats.lastDisabledAt = untilIso;
        this.runtimeStats.lastDisableReason = reason;
        if (reason === 'rate_limit') {
            runtime.rateLimitCount += 1;
            this.runtimeStats.rateLimitCount += 1;
        }

        console.log(`[KeyManager] Key ${key.slice(0, 10)}... disabled for ${Math.round(safeDurationMs / 60000)} minutes (reason=${reason})`);
        metricsService.incrementCounter('euler.key.disabled', 1, { reason, keyName: entry?.name || 'unnamed' }, { log: false });
        metricsService.emitLog('warn', 'euler.key.disabled', {
            keyName: entry?.name || 'unnamed',
            keyMasked: this._maskKey(key),
            reason,
            durationMs: safeDurationMs,
            disableUntil: untilIso,
            disabledCount: runtime.disabledCount,
            totalDisabled: this.runtimeStats.disabledCount,
            totalRateLimited: this.runtimeStats.rateLimitCount,
            details,
        });

        if (entry?.id) {
            const persistedStatus = reason === 'rate_limit' ? 'ok' : 'error';
            db.run(
                `UPDATE euler_api_keys SET last_status = $1, last_error = $2, updated_at = NOW() WHERE id = $3`,
                [persistedStatus, details.error || reason, entry.id]
            ).catch(() => {});
        }
    }

    async recordResult(key, success, errorMsg = null) {
        const entry = this.keys.find(k => k.key === key);
        const runtime = key ? this._getRuntimeEntry(key) : null;
        const isRateLimited = !success && isEulerRateLimitMessage(errorMsg);
        if (runtime) {
            runtime.lastError = success ? null : (errorMsg || 'unknown');
        }
        if (!entry || !entry.id) return;
        try {
            if (success) {
                await db.run(
                    `UPDATE euler_api_keys SET last_status = 'ok', last_error = NULL, last_used_at = NOW(), updated_at = NOW() WHERE id = ?`,
                    [entry.id]
                );
            } else {
                await db.run(
                    `UPDATE euler_api_keys SET last_status = ?, last_error = ?, last_used_at = NOW(), updated_at = NOW() WHERE id = ?`,
                    [isRateLimited ? 'ok' : 'error', errorMsg || 'unknown', entry.id]
                );
            }
        } catch (err) {
        }
    }

    recordEulerRequest(key, requestType = 'room_lookup') {
        if (requestType === 'live_check') {
            this.runtimeStats.liveCheckRequestCount += 1;
            if (key) {
                const runtime = this._getRuntimeEntry(key);
                runtime.liveCheckRequestCount += 1;
            }
            return;
        }

        this.runtimeStats.roomLookupRequestCount += 1;
        if (key) {
            const runtime = this._getRuntimeEntry(key);
            runtime.roomLookupRequestCount += 1;
        }
    }

    recordConnectionOutcome({ key = null, success = false, path = 'unknown', fallbackUsed = false, permissionDenied = false, keySource = 'unknown' } = {}) {
        const nowIso = new Date().toISOString();
        this.runtimeStats.lastConnectAt = nowIso;
        this.runtimeStats.lastConnectPath = path;
        this.runtimeStats.lastKeySource = keySource;

        if (success) {
            this.runtimeStats.connectSuccessCount += 1;
            if (fallbackUsed) {
                this.runtimeStats.fallbackConnectCount += 1;
            }
        }
        if (permissionDenied) {
            this.runtimeStats.permissionDeniedCount += 1;
        }

        if (!key) return;
        const runtime = this._getRuntimeEntry(key);
        runtime.lastConnectAt = nowIso;
        runtime.lastConnectPath = path;
        if (success) {
            runtime.successCount += 1;
        }
        if (permissionDenied) {
            runtime.permissionDeniedCount += 1;
        }
    }

    _trackUsage(keyId) {
        if (!keyId) return;
        db.run('UPDATE euler_api_keys SET call_count = call_count + 1, last_used_at = NOW() WHERE id = ?', [keyId]).catch(() => {});
    }

    getStatus() {
        const now = Date.now();
        const active = this.keys.filter(k => !this.disabledKeys.get(k.key) || now >= this.disabledKeys.get(k.key)).length;
        const disabled = this.keys.filter(k => this.disabledKeys.get(k.key) && now < this.disabledKeys.get(k.key)).length;
        let premiumRoomLookupPremiumCount = 0;
        let premiumRoomLookupBasicCount = 0;
        let premiumRoomLookupUnsetCount = 0;
        for (const entry of this.keys) {
            const level = getPremiumRoomLookupLevel(entry);
            if (level === PREMIUM_ROOM_LOOKUP_LEVELS.PREMIUM) {
                premiumRoomLookupPremiumCount += 1;
            } else if (level === PREMIUM_ROOM_LOOKUP_LEVELS.BASIC) {
                premiumRoomLookupBasicCount += 1;
            } else {
                premiumRoomLookupUnsetCount += 1;
            }
        }
        const poolStatus = this.keys.length === 0
            ? 'empty'
            : active === 0
                ? 'exhausted'
                : disabled > 0
                    ? 'degraded'
                    : 'healthy';
        const fallbackActivePaths = new Set(['tiktok_fallback', 'tiktok_html', 'tiktok_api', 'euler_room_lookup_fallback']);
        const connectivityMode = fallbackActivePaths.has(this.runtimeStats.lastConnectPath)
            ? 'fallback_active'
            : active > 0
                ? 'euler_available'
                : this.keys.length > 0
                    ? 'fallback_possible'
                    : 'unknown';
        return {
            total: this.keys.length,
            active,
            disabled,
            poolStatus,
            connectivityMode,
            selectionCount: this.runtimeStats.selectionCount,
            rotationCount: this.runtimeStats.rotationCount,
            disabledCount: this.runtimeStats.disabledCount,
            reenabledCount: this.runtimeStats.reenabledCount,
            rateLimitCount: this.runtimeStats.rateLimitCount,
            roomLookupRequestCount: this.runtimeStats.roomLookupRequestCount,
            liveCheckRequestCount: this.runtimeStats.liveCheckRequestCount,
            connectSuccessCount: this.runtimeStats.connectSuccessCount,
            fallbackConnectCount: this.runtimeStats.fallbackConnectCount,
            permissionDeniedCount: this.runtimeStats.permissionDeniedCount,
            allKeysDisabledCount: this.runtimeStats.allKeysDisabledCount,
            premiumRoomLookupPremiumCount,
            premiumRoomLookupBasicCount,
            premiumRoomLookupUnsetCount,
            currentKeyMasked: this._maskKey(this.runtimeStats.lastSelectedKey),
            lastSelectedAt: this.runtimeStats.lastSelectedAt,
            lastDisabledAt: this.runtimeStats.lastDisabledAt,
            lastDisableReason: this.runtimeStats.lastDisableReason,
            lastConnectAt: this.runtimeStats.lastConnectAt,
            lastConnectPath: this.runtimeStats.lastConnectPath,
            lastKeySource: this.runtimeStats.lastKeySource,
            configSource: this.runtimeStats.configSource,
            keys: this.keys.map((entry, index) => {
                const disableUntil = this.disabledKeys.get(entry.key);
                const runtime = this._getRuntimeEntry(entry.key);
                const isDisabled = Boolean(disableUntil && now < disableUntil);
                return {
                    id: entry.id,
                    index: index + 1,
                    name: entry.name || '',
                    keyMasked: this._maskKey(entry.key),
                    disabledUntil: isDisabled ? new Date(disableUntil).toISOString() : null,
                    isDisabled,
                    selectedCount: runtime.selectedCount,
                    disabledCount: runtime.disabledCount,
                    reenabledCount: runtime.reenabledCount,
                    rateLimitCount: runtime.rateLimitCount,
                    roomLookupRequestCount: runtime.roomLookupRequestCount,
                    liveCheckRequestCount: runtime.liveCheckRequestCount,
                    successCount: runtime.successCount,
                    permissionDeniedCount: runtime.permissionDeniedCount,
                    premiumRoomLookupLevel: getPremiumRoomLookupLevel(entry),
                    premiumRoomLookupState: getPremiumRoomLookupState(entry),
                    premiumRoomLookupCheckedAt: getPremiumRoomLookupCheckedAt(entry),
                    premiumRoomLookupLastStatus: Number(entry.premiumRoomLookupLastStatus || 0),
                    premiumRoomLookupLastError: entry.premiumRoomLookupLastError || '',
                    premiumRoomLookupProbeUniqueId: entry.premiumRoomLookupProbeUniqueId || '',
                    lastSelectedAt: runtime.lastSelectedAt,
                    lastDisabledAt: runtime.lastDisabledAt,
                    lastDisableReason: runtime.lastDisableReason,
                    lastConnectAt: runtime.lastConnectAt,
                    lastConnectPath: runtime.lastConnectPath,
                    lastError: runtime.lastError,
                };
            })
        };
    }

    async getAllKeysStatus() {
        try {
            return await db.all('SELECT id, name, key_value, is_active, call_count, last_used_at, last_error, last_status, created_at, premium_room_lookup_level, premium_room_lookup_state, premium_room_lookup_checked_at, premium_room_lookup_last_status, premium_room_lookup_last_error, premium_room_lookup_probe_unique_id FROM euler_api_keys ORDER BY id');
        } catch (err) {
            return [];
        }
    }
}

const keyManager = new KeyManager();

module.exports = keyManager;
