/**
 * KeyManager - Manages multiple Euler API keys with rotation, rate-limit handling,
 * and database-backed storage with usage tracking
 */
const db = require('../db');

class KeyManager {
    constructor() {
        this.keys = [];         // Array of { id, key, name, isActive }
        this.disabledKeys = new Map(); // key -> disableUntil timestamp
        this.currentIndex = 0;
        this._dbLoaded = false;

        // Load initial keys from environment (will be overridden by loadFromDb)
        this._loadKeysFromString(process.env.EULER_KEYS || process.env.EULER_API_KEY || '');
    }

    _loadKeysFromString(rawKeys) {
        if (rawKeys) {
            const keyStrs = rawKeys.split(',').map(k => k.trim()).filter(k => k.length > 0);
            this.keys = keyStrs.map((k, i) => ({ id: null, key: k, name: `env-key-${i + 1}`, isActive: true }));
        } else {
            this.keys = [];
        }
        console.log(`[KeyManager] Loaded ${this.keys.length} keys.`);
        this.keys.forEach((k, i) => {
            console.log(`[KeyManager] Key #${i + 1}: ${k.key.slice(0, 10)}...`);
        });
    }

    /**
     * Load keys from database table euler_api_keys
     */
    async loadFromDb() {
        try {
            const rows = await db.all('SELECT * FROM euler_api_keys WHERE is_active = true ORDER BY id');
            if (rows.length > 0) {
                this.keys = rows.map(r => ({
                    id: r.id,
                    key: r.keyValue,
                    name: r.name || '',
                    isActive: r.isActive
                }));
                this._dbLoaded = true;
                console.log(`[KeyManager] Loaded ${this.keys.length} keys from database.`);
            } else if (!this._dbLoaded) {
                // Keep env keys if no DB keys exist
                console.log(`[KeyManager] No DB keys found, keeping ${this.keys.length} env keys.`);
            }
        } catch (err) {
            console.error('[KeyManager] Failed to load from DB:', err.message);
        }
    }

    /**
     * Refresh keys - try DB first, fall back to settings/env
     */
    async refreshKeys(dbSettings) {
        try {
            const dbRows = await db.all('SELECT * FROM euler_api_keys WHERE is_active = true ORDER BY id');
            if (dbRows.length > 0) {
                this.keys = dbRows.map(r => ({
                    id: r.id,
                    key: r.keyValue,
                    name: r.name || '',
                    isActive: r.isActive
                }));
                this._dbLoaded = true;
                return;
            }
        } catch (err) {
            // DB table might not exist yet
        }

        // Fallback to old settings/env approach
        const dbKeys = dbSettings?.euler_keys || '';
        const envKeys = process.env.EULER_KEYS || process.env.EULER_API_KEY || '';
        const rawKeys = dbKeys || envKeys;
        if (rawKeys && rawKeys !== this.keys.map(k => k.key).join(',')) {
            this._loadKeysFromString(rawKeys);
        }
    }

    getKeyCount() {
        return this.keys.length;
    }

    getActiveKey() {
        if (this.keys.length === 0) return null;
        const now = Date.now();

        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            const entry = this.keys[idx];
            const disableUntil = this.disabledKeys.get(entry.key);

            if (!disableUntil || now >= disableUntil) {
                if (disableUntil && now >= disableUntil) {
                    this.disabledKeys.delete(entry.key);
                    console.log(`[KeyManager] Key ${entry.key.slice(0, 10)}... re-enabled`);
                }
                this.currentIndex = (idx + 1) % this.keys.length;
                // Track usage asynchronously
                this._trackUsage(entry.id);
                return entry.key;
            }
        }

        console.log(`[KeyManager] All ${this.keys.length} keys are currently disabled`);
        return null;
    }

    disableKey(key, durationMs) {
        if (!key) return;
        const until = Date.now() + durationMs;
        this.disabledKeys.set(key, until);
        console.log(`[KeyManager] Key ${key.slice(0, 10)}... disabled for ${Math.round(durationMs / 60000)} minutes`);
    }

    /**
     * Record a call result for a key
     */
    async recordResult(key, success, errorMsg = null) {
        const entry = this.keys.find(k => k.key === key);
        if (!entry || !entry.id) return;
        try {
            if (success) {
                await db.run(
                    `UPDATE euler_api_keys SET call_count = call_count + 1, last_used_at = NOW(), last_status = 'ok', last_error = NULL, updated_at = NOW() WHERE id = ?`,
                    [entry.id]
                );
            } else {
                await db.run(
                    `UPDATE euler_api_keys SET call_count = call_count + 1, last_used_at = NOW(), last_status = 'error', last_error = ?, updated_at = NOW() WHERE id = ?`,
                    [errorMsg || 'unknown', entry.id]
                );
            }
        } catch (err) {
            // Ignore tracking errors
        }
    }

    /**
     * Track usage (increment call_count) asynchronously
     */
    _trackUsage(keyId) {
        if (!keyId) return;
        db.run('UPDATE euler_api_keys SET call_count = call_count + 1, last_used_at = NOW() WHERE id = ?', [keyId]).catch(() => {});
    }

    getStatus() {
        const now = Date.now();
        return {
            total: this.keys.length,
            active: this.keys.filter(k => !this.disabledKeys.get(k.key) || now >= this.disabledKeys.get(k.key)).length,
            disabled: this.keys.filter(k => this.disabledKeys.get(k.key) && now < this.disabledKeys.get(k.key)).length
        };
    }

    /**
     * Get all keys with full status info (for admin UI)
     */
    async getAllKeysStatus() {
        try {
            return await db.all('SELECT id, name, key_value, is_active, call_count, last_used_at, last_error, last_status, created_at FROM euler_api_keys ORDER BY id');
        } catch (err) {
            return [];
        }
    }
}

// Singleton instance
const keyManager = new KeyManager();

module.exports = keyManager;
