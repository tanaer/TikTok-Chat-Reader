/**
 * KeyManager - Manages multiple Euler API keys with rotation and rate-limit handling
 */

class KeyManager {
    constructor() {
        this.keys = [];
        this.disabledKeys = new Map(); // key -> disableUntil timestamp
        this.currentIndex = 0;

        // Load keys from environment
        const rawKeys = process.env.EULER_KEYS || process.env.EULER_API_KEY || '';
        console.log(`[KeyManager] Initializing with raw keys string length: ${rawKeys.length}`);

        if (rawKeys) {
            this.keys = rawKeys.split(',').map(k => k.trim()).filter(k => k.length > 0);
        }

        console.log(`[KeyManager] Loaded ${this.keys.length} keys.`);
        this.keys.forEach((key, i) => {
            console.log(`[KeyManager] Key #${i + 1}: ${key.slice(0, 10)}...`);
        });
    }

    getKeyCount() {
        return this.keys.length;
    }

    getActiveKey() {
        if (this.keys.length === 0) return null;

        const now = Date.now();

        // Find a key that is not disabled
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            const key = this.keys[idx];
            const disableUntil = this.disabledKeys.get(key);

            if (!disableUntil || now >= disableUntil) {
                // Re-enable if time passed
                if (disableUntil && now >= disableUntil) {
                    this.disabledKeys.delete(key);
                    console.log(`[KeyManager] Key ${key.slice(0, 10)}... re-enabled`);
                }

                // Rotate to next key for next call
                this.currentIndex = (idx + 1) % this.keys.length;
                return key;
            }
        }

        // All keys disabled
        console.log(`[KeyManager] All ${this.keys.length} keys are currently disabled`);
        return null;
    }

    disableKey(key, durationMs) {
        if (!key) return;
        const until = Date.now() + durationMs;
        this.disabledKeys.set(key, until);
        console.log(`[KeyManager] Key ${key.slice(0, 10)}... disabled for ${Math.round(durationMs / 60000)} minutes`);
    }

    getStatus() {
        const now = Date.now();
        return {
            total: this.keys.length,
            active: this.keys.filter(k => !this.disabledKeys.get(k) || now >= this.disabledKeys.get(k)).length,
            disabled: this.keys.filter(k => this.disabledKeys.get(k) && now < this.disabledKeys.get(k)).length
        };
    }
}

// Singleton instance
const keyManager = new KeyManager();

module.exports = keyManager;
