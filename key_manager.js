class KeyManager {
    constructor(keysString) {
        this.keys = [];
        if (keysString) {
            // Split by comma or semicolon, trim whitespace
            this.keys = keysString.split(/[,;]/).map(k => k.trim()).filter(k => k).map(k => ({
                key: k,
                disabledUntil: 0
            }));
        }
        this.currentIndex = 0;
    }

    getActiveKey() {
        const now = Date.now();
        // Find first active key starting from currentIndex
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            if (this.keys[idx].disabledUntil <= now) {
                this.currentIndex = (idx + 1) % this.keys.length; // Rotate for next call
                return this.keys[idx].key;
            }
        }
        return null; // All keys disabled
    }

    disableKey(key, durationMs = 3600000) { // Default 1 hour
        const entry = this.keys.find(k => k.key === key);
        if (entry) {
            entry.disabledUntil = Date.now() + durationMs;
            console.log(`[KeyManager] Key ${key.slice(0, 8)}... disabled for ${durationMs / 1000 / 60} minutes`);
        }
    }

    getStatus() {
        const now = Date.now();
        return this.keys.map(k => ({
            key: k.key.slice(0, 8) + '...',
            status: k.disabledUntil > now ? `Disabled (${Math.ceil((k.disabledUntil - now) / 60000)}m)` : 'Active'
        }));
    }
}

module.exports = KeyManager;
