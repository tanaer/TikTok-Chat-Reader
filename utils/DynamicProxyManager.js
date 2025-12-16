// Remove top-level require
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
// fetch will be loaded dynamically
let fetch;

class DynamicProxyManager {
    constructor() {
        this.cachePath = path.join(__dirname, '..', 'proxy_cache.json');
        this.proxies = [];
        this.currentIndex = 0;
        this.apiUrl = process.env.PROXY_API_URL; // e.g. "http://api.proxy.com/get?..."
        this.isFetching = false;

        // Load cache on init
        this.tunnelProxy = process.env.DYNAMIC_TUNNEL_PROXY; // "http://user:pass@host:port"
    }

    loadCache() {
        // If tunnel proxy is set, we don't need cache
        if (this.tunnelProxy) return;

        try {
            if (fs.existsSync(this.cachePath)) {
                this.proxies = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
                console.log(`[DynamicProxy] Loaded ${this.proxies.length} proxies from cache.`);
            }
        } catch (e) {
            console.error('[DynamicProxy] Load cache failed:', e);
        }
    }

    saveCache() {
        try {
            fs.writeFileSync(this.cachePath, JSON.stringify(this.proxies, null, 2));
        } catch (e) {
            console.error('[DynamicProxy] Save cache failed:', e);
        }
    }

    /**
     * Get a proxy from pool. Rotating logic.
     * @returns {Object|null} { host, port, username, password }
     */
    async getProxy() {
        // Priority: Tunnel Proxy
        if (this.tunnelProxy) {
            try {
                // Parse "http://user:pass@host:port" or "http://host:port"
                // Remove protocol if present for easier parsing or use URL
                const u = new URL(this.tunnelProxy.startsWith('http') ? this.tunnelProxy : 'http://' + this.tunnelProxy);
                return {
                    hostname: u.hostname,
                    port: u.port,
                    username: u.username,
                    password: u.password
                };
            } catch (e) {
                console.error('[DynamicProxy] Invalid Tunnel configuration:', e.message);
                return null;
            }
        }

        if (this.proxies.length === 0) {
            await this.refreshProxies();
        }

        if (this.proxies.length === 0) {
            return null; // Failed to get any proxies
        }

        // Return current and rotate
        const proxy = this.proxies[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
        return proxy;
    }

    /**
     * Fetch new proxies from API
     */
    async refreshProxies() {
        // Skip if tunnel proxy is configured
        if (this.tunnelProxy) return;

        if (this.isFetching || !this.apiUrl) return;
        this.isFetching = true;

        if (!fetch) {
            fetch = (await import('node-fetch')).default;
        }

        console.log('[DynamicProxy] Fetching new proxies...');
        try {
            // Mock implementation or real fetch based on user example
            // User Ex: curl -x hk.ipdodo.cloud:10801 -U "..."
            // Actually user PROXY_API_URL might just return text list "ip:port"
            // For now, let's assume it returns text format "ip:port" or "ip:port:user:pass"

            const res = await fetch(this.apiUrl);
            const text = await res.text();

            // Basic parsing assumes "ip:port" per line
            const lines = text.split('\n').filter(l => l.trim());
            const newProxies = [];

            for (const line of lines) {
                // simple parse logic, adjust based on actual API format
                // support "host:port:user:pass" or just "host:port"
                const parts = line.trim().split(':');
                if (parts.length >= 2) {
                    newProxies.push({
                        hostname: parts[0],
                        port: parts[1],
                        username: parts[2] || '', // Optional auth
                        password: parts[3] || ''
                    });
                }
            }

            if (newProxies.length > 0) {
                this.proxies = newProxies;
                this.currentIndex = 0;
                this.saveCache();
                console.log(`[DynamicProxy] Refreshed pool with ${newProxies.length} proxies.`);
            } else {
                console.warn('[DynamicProxy] API returned no valid proxies.');
            }

        } catch (e) {
            console.error('[DynamicProxy] Fetch failed:', e.message);
        } finally {
            this.isFetching = false;
        }
    }
}

module.exports = new DynamicProxyManager();
