/**
 * ProxyManager - Proxy subscription management with node testing and smart selection
 */
require('dotenv').config();
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const db = require('../db');

class ProxyManager {
    constructor() {
        this.nodes = [];
        this.lastRefresh = null;
    }

    // ==================== Subscription Management ====================

    async addSubscription(name, url) {
        const result = await db.query(
            `INSERT INTO proxy_subscription (name, url) VALUES (?, ?) RETURNING id`,
            [name, url]
        );
        const subId = result[0]?.id;
        if (subId) {
            await this.refreshSubscription(subId);
        }
        return subId;
    }

    async getSubscriptions() {
        return await db.query(`SELECT * FROM proxy_subscription ORDER BY created_at DESC`);
    }

    async deleteSubscription(id) {
        await db.query(`DELETE FROM proxy_subscription WHERE id = ?`, [id]);
    }

    async refreshSubscription(subId) {
        const subs = await db.query(`SELECT * FROM proxy_subscription WHERE id = ?`, [subId]);
        if (!subs || subs.length === 0) return { error: 'Subscription not found' };

        const sub = subs[0];
        try {
            const nodes = await this.parseSubscription(sub.url);

            // Delete old nodes for this subscription
            await db.query(`DELETE FROM proxy_node WHERE subscription_id = ?`, [subId]);

            // Insert new nodes
            for (const node of nodes) {
                await db.query(
                    `INSERT INTO proxy_node (subscription_id, name, type, server, port, config_json, proxy_url)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [subId, node.name, node.type, node.server, node.port, JSON.stringify(node.config), node.proxyUrl]
                );
            }

            // Update last_updated
            await db.query(
                `UPDATE proxy_subscription SET last_updated = NOW() WHERE id = ?`,
                [subId]
            );

            return { success: true, nodeCount: nodes.length };
        } catch (e) {
            console.error(`[ProxyManager] Failed to parse subscription ${subId}:`, e.message);
            return { error: e.message };
        }
    }

    async refreshAllSubscriptions() {
        const subs = await db.query(`SELECT id FROM proxy_subscription WHERE is_enabled = 1`);
        const results = [];
        for (const sub of subs) {
            const result = await this.refreshSubscription(sub.id);
            results.push({ id: sub.id, ...result });
        }
        return results;
    }

    // ==================== Subscription Parsing ====================

    async parseSubscription(url) {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        const yaml = require('yaml');

        console.log(`[ProxyManager] Fetching subscription from: ${url.slice(0, 50)}...`);

        const res = await fetch(url, {
            timeout: 30000,
            headers: { 'User-Agent': 'ClashForWindows/0.20.0' }
        });
        let text = await res.text();

        console.log(`[ProxyManager] Received ${text.length} bytes, first 100 chars: ${text.slice(0, 100).replace(/\n/g, '\\n')}`);

        return this.parseContent(text);
    }

    // Parse content directly (for manual input or fetched content)
    parseContent(text) {
        const yaml = require('yaml');
        text = text.trim();

        // Detect if content looks like Base64 (no spaces in first line, mostly alphanumeric)
        const firstLine = text.split('\n')[0].trim();
        const looksLikeBase64 = /^[A-Za-z0-9+/=]+$/.test(firstLine) && firstLine.length > 50;

        console.log(`[ProxyManager] Content analysis: length=${text.length}, firstLine=${firstLine.slice(0, 50)}..., looksLikeBase64=${looksLikeBase64}`);

        // Try Base64 decode FIRST if content looks like Base64
        if (looksLikeBase64) {
            try {
                const decoded = Buffer.from(text, 'base64').toString('utf-8');
                if (decoded.includes('://')) {
                    console.log(`[ProxyManager] Successfully decoded Base64, found ${decoded.split('\n').filter(l => l.includes('://')).length} URI lines`);
                    const nodes = this.parseURIList(decoded);
                    if (nodes.length > 0) {
                        return nodes;
                    }
                }
            } catch (e) {
                console.log(`[ProxyManager] Base64 decode failed: ${e.message}`);
            }
        }

        // Try YAML (Clash format)
        try {
            const parsed = yaml.parse(text);
            if (parsed && typeof parsed === 'object') {
                const keys = Object.keys(parsed);
                console.log(`[ProxyManager] YAML keys: ${keys.join(', ')}`);

                const proxies = parsed.proxies || parsed.Proxies || parsed.proxy || parsed.Proxy;
                console.log(`[ProxyManager] proxies type: ${typeof proxies}, isArray: ${Array.isArray(proxies)}, length: ${proxies?.length || 0}`);

                if (proxies && Array.isArray(proxies) && proxies.length > 0) {
                    console.log(`[ProxyManager] Detected Clash YAML with ${proxies.length} proxies`);
                    return this.parseClashConfig({ proxies });
                }
            }

            // Check if parsed is directly an array (e.g., YAML list of proxies)
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name) {
                console.log(`[ProxyManager] Detected YAML array with ${parsed.length} proxies`);
                return this.parseClashConfig({ proxies: parsed });
            }
        } catch (e) {
            console.log(`[ProxyManager] YAML parse error: ${e.message.slice(0, 50)}`);
        }

        // Try JSON (sing-box format)
        try {
            const json = JSON.parse(text);
            if (json.outbounds) {
                console.log(`[ProxyManager] Detected sing-box JSON format`);
                return this.parseSingboxConfig(json);
            }
            if (json.proxies) {
                console.log(`[ProxyManager] Detected Clash JSON format`);
                return this.parseClashConfig(json);
            }
        } catch (e) {
            // Not JSON
        }

        // Try direct URI list (plain text with :// lines)
        if (text.includes('://')) {
            console.log(`[ProxyManager] Trying as plain URI list`);
            const nodes = this.parseURIList(text);
            if (nodes.length > 0) {
                return nodes;
            }
        }

        // Last resort: try Base64 even if it doesn't look like it
        try {
            const decoded = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf-8');
            if (decoded.includes('://')) {
                console.log(`[ProxyManager] Fallback Base64 decode succeeded`);
                return this.parseURIList(decoded);
            }
        } catch (e) {
            // Not Base64
        }

        console.error(`[ProxyManager] Unknown format. Content preview: ${text.slice(0, 200)}`);
        throw new Error('Unknown subscription format');
    }

    parseURIList(text) {
        const lines = text.split('\n').filter(l => l.trim() && l.includes('://'));
        const nodes = [];

        for (const line of lines) {
            try {
                const node = this.parseProxyURI(line.trim());
                if (node) nodes.push(node);
            } catch (e) {
                console.warn(`[ProxyManager] Failed to parse line: ${line.slice(0, 50)}...`);
            }
        }

        return nodes;
    }

    parseProxyURI(uri) {
        const url = new URL(uri);
        const type = url.protocol.replace(':', '');

        if (type === 'ss') {
            // Shadowsocks: ss://base64(method:password)@server:port#name
            const decoded = Buffer.from(url.username, 'base64').toString();
            const [method, password] = decoded.split(':');
            return {
                name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
                type: 'ss',
                server: url.hostname,
                port: parseInt(url.port),
                config: { method, password },
                proxyUrl: `ss://${url.username}@${url.hostname}:${url.port}`
            };
        }

        if (type === 'vmess') {
            // VMess: vmess://base64(json)
            const config = JSON.parse(Buffer.from(url.hostname + url.pathname, 'base64').toString());
            return {
                name: config.ps || config.add,
                type: 'vmess',
                server: config.add,
                port: parseInt(config.port),
                config,
                proxyUrl: null // VMess needs special handling
            };
        }

        if (type === 'vless' || type === 'trojan') {
            // VLESS/Trojan: vless://uuid@server:port?params#name
            return {
                name: decodeURIComponent(url.hash.slice(1)) || url.hostname,
                type,
                server: url.hostname,
                port: parseInt(url.port),
                config: { uuid: url.username, ...Object.fromEntries(url.searchParams) },
                proxyUrl: null // Needs special handling
            };
        }

        if (type === 'socks5' || type === 'socks') {
            return {
                name: decodeURIComponent(url.hash.slice(1)) || `${url.hostname}:${url.port}`,
                type: 'socks5',
                server: url.hostname,
                port: parseInt(url.port),
                config: { username: url.username, password: url.password },
                proxyUrl: `socks5://${url.username ? url.username + ':' + url.password + '@' : ''}${url.hostname}:${url.port}`
            };
        }

        if (type === 'http' || type === 'https') {
            return {
                name: decodeURIComponent(url.hash.slice(1)) || `${url.hostname}:${url.port}`,
                type: 'http',
                server: url.hostname,
                port: parseInt(url.port) || (type === 'https' ? 443 : 80),
                config: { username: url.username, password: url.password },
                proxyUrl: `${type}://${url.username ? url.username + ':' + url.password + '@' : ''}${url.hostname}:${url.port}`
            };
        }

        return null;
    }

    parseSingboxConfig(json) {
        const nodes = [];
        for (const outbound of (json.outbounds || [])) {
            if (['direct', 'block', 'dns', 'selector', 'urltest'].includes(outbound.type)) continue;

            nodes.push({
                name: outbound.tag || outbound.server,
                type: outbound.type,
                server: outbound.server,
                port: outbound.server_port || outbound.port,
                config: outbound,
                proxyUrl: this.buildProxyUrl(outbound)
            });
        }
        return nodes;
    }

    parseClashConfig(json) {
        const nodes = [];
        for (const proxy of (json.proxies || [])) {
            nodes.push({
                name: proxy.name,
                type: proxy.type,
                server: proxy.server,
                port: proxy.port,
                config: proxy,
                proxyUrl: this.buildProxyUrl(proxy)
            });
        }
        return nodes;
    }

    buildProxyUrl(config) {
        if (config.type === 'socks5' || config.type === 'socks') {
            const auth = config.username ? `${config.username}:${config.password}@` : '';
            return `socks5://${auth}${config.server}:${config.server_port || config.port}`;
        }
        if (config.type === 'http') {
            const auth = config.username ? `${config.username}:${config.password}@` : '';
            return `http://${auth}${config.server}:${config.server_port || config.port}`;
        }
        // For SS/VMess/VLESS/Trojan - these need local sing-box to convert
        return null;
    }

    // ==================== Node Testing ====================

    async getNodes(filters = {}) {
        let sql = `SELECT * FROM proxy_node`;
        const params = [];
        const conditions = [];

        if (filters.subscriptionId) {
            conditions.push(`subscription_id = ?`);
            params.push(filters.subscriptionId);
        }
        if (filters.eulerStatus) {
            conditions.push(`euler_status = ?`);
            params.push(filters.eulerStatus);
        }
        if (filters.tiktokStatus) {
            conditions.push(`tiktok_status = ?`);
            params.push(filters.tiktokStatus);
        }

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }
        sql += ` ORDER BY euler_latency ASC NULLS LAST, tiktok_latency ASC NULLS LAST`;

        return await db.query(sql, params);
    }

    async testNode(nodeId) {
        const nodes = await db.query(`SELECT * FROM proxy_node WHERE id = ?`, [nodeId]);
        if (!nodes || nodes.length === 0) return { error: 'Node not found' };

        const node = nodes[0];
        let eulerResult, tiktokResult;

        // For node types that require sing-box (anytls, vmess, vless, trojan, ss),
        // use Clash API to switch to specific node, then test via main proxy
        const singboxTypes = ['anytls', 'vmess', 'vless', 'trojan', 'ss', 'shadowsocks'];

        if (singboxTypes.includes(node.type)) {
            console.log('[ProxyManager] Testing ' + node.name + ' (' + node.type + ') via Clash API node switching...');

            // Use singBoxManager's Clash API-based test method
            const singBoxManager = require('./singBoxManager');
            const result = await singBoxManager.testNodeViaClashAPI(node);

            if (result.error) {
                await db.query(
                    `UPDATE proxy_node SET euler_status = 'blocked', tiktok_status = 'blocked' WHERE id = ?`,
                    [nodeId]
                );
                return result;
            }

            eulerResult = result.euler;
            tiktokResult = result.tiktok;
        } else {
            // For socks5/http nodes, test directly
            const agent = this.createAgent(node);
            if (!agent) {
                await db.query(
                    `UPDATE proxy_node SET euler_status = 'unknown', tiktok_status = 'unknown' WHERE id = ?`,
                    [nodeId]
                );
                return { error: 'Cannot create proxy agent for this node type' };
            }

            console.log('[ProxyManager] Testing ' + node.name + ' (' + node.type + ') directly...');
            eulerResult = await this.testEuler(agent);
            tiktokResult = await this.testTikTok(agent);
        }

        console.log('[ProxyManager] ' + node.name + ': Euler=' + eulerResult.status + '(' + eulerResult.latency + 'ms), TikTok=' + tiktokResult.status + '(' + tiktokResult.latency + 'ms)');

        // Update node status
        await db.query(
            `UPDATE proxy_node SET 
                euler_status = ?, euler_latency = ?, last_euler_test = NOW(),
                tiktok_status = ?, tiktok_latency = ?, last_tiktok_test = NOW()
             WHERE id = ?`,
            [eulerResult.status, eulerResult.latency, tiktokResult.status, tiktokResult.latency, nodeId]
        );

        return { euler: eulerResult, tiktok: tiktokResult };
    }

    async testAllNodes() {
        const nodes = await db.query(`SELECT id FROM proxy_node`);
        const results = [];

        // Test in batches to avoid overwhelming
        const batchSize = 5;
        for (let i = 0; i < nodes.length; i += batchSize) {
            const batch = nodes.slice(i, i + batchSize);
            const batchResults = await Promise.allSettled(
                batch.map(n => this.testNode(n.id))
            );
            results.push(...batchResults.map((r, idx) => ({
                nodeId: batch[idx].id,
                result: r.status === 'fulfilled' ? r.value : { error: r.reason?.message }
            })));
        }

        return results;
    }

    async testEuler(agent) {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const start = Date.now();
            const res = await fetch('https://tiktok.eulerstream.com/webcast/sign_url', {
                agent,
                signal: controller.signal,
                headers: { 'User-Agent': 'TikTok-Live-Connector/1.0' }
            });
            clearTimeout(timeoutId);
            const latency = Date.now() - start;

            // Check if response is valid
            if (res.status === 403 || res.status === 429) {
                return { status: 'blocked', latency: -1 };
            }

            return { status: 'ok', latency };
        } catch (e) {
            if (e.name === 'AbortError') {
                return { status: 'blocked', latency: -1, error: 'Timeout' };
            }
            return { status: 'blocked', latency: -1, error: e.message };
        }
    }

    async testTikTok(agent) {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const start = Date.now();
            const res = await fetch('https://www.tiktok.com/robots.txt', {
                agent,
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            clearTimeout(timeoutId);
            const latency = Date.now() - start;

            if (res.status === 403 || res.status === 429) {
                return { status: 'blocked', latency: -1 };
            }

            return { status: 'ok', latency };
        } catch (e) {
            if (e.name === 'AbortError') {
                return { status: 'blocked', latency: -1, error: 'Timeout' };
            }
            return { status: 'blocked', latency: -1, error: e.message };
        }
    }

    createAgent(node) {
        if (!node.proxyUrl) return null;

        if (node.type === 'socks5' || node.type === 'socks') {
            return new SocksProxyAgent(node.proxyUrl);
        }
        if (node.type === 'http' || node.type === 'https') {
            return new HttpsProxyAgent(node.proxyUrl);
        }
        return null;
    }

    // ==================== Smart Selection ====================

    async getBestProxy(purpose = 'both') {
        let conditions = [`proxy_url IS NOT NULL`];

        if (purpose === 'euler') {
            conditions.push(`euler_status = 'ok'`);
        } else if (purpose === 'tiktok') {
            conditions.push(`tiktok_status = 'ok'`);
        } else {
            conditions.push(`euler_status = 'ok'`);
            conditions.push(`tiktok_status = 'ok'`);
        }

        const nodes = await db.query(`
            SELECT * FROM proxy_node 
            WHERE ${conditions.join(' AND ')}
            ORDER BY 
                (COALESCE(euler_latency, 9999) + COALESCE(tiktok_latency, 9999)) ASC,
                success_count DESC,
                fail_count ASC
            LIMIT 10
        `);

        if (!nodes || nodes.length === 0) {
            // Fallback: return any node with proxy_url
            const fallback = await db.query(`
                SELECT * FROM proxy_node WHERE proxy_url IS NOT NULL ORDER BY RANDOM() LIMIT 1
            `);
            return fallback?.[0] || null;
        }

        // Return random from top 3 to distribute load
        const topNodes = nodes.slice(0, 3);
        return topNodes[Math.floor(Math.random() * topNodes.length)];
    }

    async markSuccess(nodeId) {
        await db.query(
            `UPDATE proxy_node SET success_count = success_count + 1, last_used = NOW() WHERE id = ?`,
            [nodeId]
        );
    }

    async markFailed(nodeId, service = 'both') {
        const updates = [`fail_count = fail_count + 1`];

        // After 3 consecutive failures, mark as blocked
        const node = await db.query(`SELECT fail_count FROM proxy_node WHERE id = ?`, [nodeId]);
        if (node?.[0]?.failCount >= 2) {
            if (service === 'euler' || service === 'both') {
                updates.push(`euler_status = 'blocked'`);
            }
            if (service === 'tiktok' || service === 'both') {
                updates.push(`tiktok_status = 'blocked'`);
            }
        }

        await db.query(`UPDATE proxy_node SET ${updates.join(', ')} WHERE id = ?`, [nodeId]);
    }

    async getProxyUrl() {
        const node = await this.getBestProxy();
        if (node && node.proxyUrl) {
            return { url: node.proxyUrl, nodeId: node.id };
        }
        return null;
    }
}

module.exports = new ProxyManager();
