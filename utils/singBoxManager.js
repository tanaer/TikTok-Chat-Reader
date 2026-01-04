/**
 * SingBoxManager - Manage sing-box client for proxy tunneling
 * 
 * Features:
 * - Download and install sing-box binary
 * - Generate sing-box config from proxy nodes
 * - Start/stop/restart sing-box process
 * - Expose local SOCKS5 proxy port
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class SingBoxManager {
    constructor() {
        this.process = null;
        this.configPath = path.join(__dirname, '..', 'data', 'singbox-config.json');
        this.binaryPath = this.detectBinaryPath();
        this.localPort = 1090; // Local SOCKS5 port
        this.isRunning = false;
    }

    detectBinaryPath() {
        const platform = os.platform();
        const arch = os.arch();

        // Default paths
        if (platform === 'win32') {
            return path.join(__dirname, '..', 'bin', 'sing-box.exe');
        } else {
            return path.join(__dirname, '..', 'bin', 'sing-box');
        }
    }

    // Check if sing-box binary exists
    isBinaryInstalled() {
        return fs.existsSync(this.binaryPath);
    }

    // Ensure sing-box is installed, download if not
    async ensureBinaryInstalled() {
        if (this.isBinaryInstalled()) {
            console.log('[SingBox] Binary already installed');
            return { success: true, installed: true };
        }

        console.log('[SingBox] Binary not found, downloading...');
        return await this.downloadBinary();
    }

    // Download sing-box binary from GitHub
    async downloadBinary() {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        const { createWriteStream } = require('fs');
        const { pipeline } = require('stream/promises');
        const { createGunzip } = require('zlib');
        const tar = require('tar');
        const { SocksProxyAgent } = require('socks-proxy-agent');
        const { HttpsProxyAgent } = require('https-proxy-agent');

        const platform = os.platform();
        const arch = os.arch();

        // Setup proxy agent if PROXY_URL is configured
        let agent = null;
        const proxyUrl = process.env.PROXY_URL;
        if (proxyUrl) {
            if (proxyUrl.startsWith('socks')) {
                agent = new SocksProxyAgent(proxyUrl);
            } else {
                agent = new HttpsProxyAgent(proxyUrl);
            }
            console.log(`[SingBox] Using proxy: ${proxyUrl}`);
        }

        // Map platform and arch to sing-box release names
        let osName, archName;
        if (platform === 'win32') {
            osName = 'windows';
        } else if (platform === 'linux') {
            osName = 'linux';
        } else if (platform === 'darwin') {
            osName = 'darwin';
        } else {
            return { success: false, error: `Unsupported platform: ${platform}` };
        }

        if (arch === 'x64') {
            archName = 'amd64';
        } else if (arch === 'arm64') {
            archName = 'arm64';
        } else if (arch === 'ia32') {
            archName = '386';
        } else {
            return { success: false, error: `Unsupported architecture: ${arch}` };
        }

        try {
            // Get latest release from GitHub API
            console.log('[SingBox] Fetching latest release info...');
            const releaseRes = await fetch('https://api.github.com/repos/SagerNet/sing-box/releases/latest', {
                headers: { 'User-Agent': 'TikTok-Chat-Reader/1.0' },
                agent
            });
            const release = await releaseRes.json();

            if (!release.assets) {
                return { success: false, error: 'Failed to get release info from GitHub' };
            }

            // Find matching asset
            const ext = platform === 'win32' ? '.zip' : '.tar.gz';
            const pattern = new RegExp(`sing-box-[\\d.]+-${osName}-${archName}${ext.replace('.', '\\.')}$`);
            const asset = release.assets.find(a => pattern.test(a.name));

            if (!asset) {
                console.log('[SingBox] Available assets:', release.assets.map(a => a.name));
                return { success: false, error: `No matching binary found for ${osName}-${archName}` };
            }

            console.log(`[SingBox] Downloading ${asset.name}...`);

            // Create bin directory
            const binDir = path.dirname(this.binaryPath);
            if (!fs.existsSync(binDir)) {
                fs.mkdirSync(binDir, { recursive: true });
            }

            // Download file
            const downloadRes = await fetch(asset.browser_download_url, { agent });
            const tempFile = path.join(binDir, asset.name);

            await pipeline(
                downloadRes.body,
                createWriteStream(tempFile)
            );

            console.log('[SingBox] Extracting...');

            // Extract based on platform
            if (platform === 'win32') {
                // Extract ZIP on Windows
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(tempFile);
                const entries = zip.getEntries();

                for (const entry of entries) {
                    if (entry.entryName.endsWith('sing-box.exe')) {
                        zip.extractEntryTo(entry, binDir, false, true);
                        // Rename if needed
                        const extractedPath = path.join(binDir, 'sing-box.exe');
                        if (extractedPath !== this.binaryPath) {
                            fs.renameSync(extractedPath, this.binaryPath);
                        }
                        break;
                    }
                }
            } else {
                // Extract tar.gz on Linux/macOS
                await tar.x({
                    file: tempFile,
                    cwd: binDir,
                    strip: 1,
                    filter: (p) => p.endsWith('sing-box')
                });

                // Make executable
                fs.chmodSync(this.binaryPath, 0o755);
            }

            // Clean up temp file
            fs.unlinkSync(tempFile);

            console.log(`[SingBox] Successfully installed to ${this.binaryPath}`);
            return { success: true, version: release.tag_name };

        } catch (e) {
            console.error('[SingBox] Download failed:', e.message);
            return { success: false, error: e.message };
        }
    }

    // Generate sing-box config from nodes
    generateConfig(nodes, selectedNodeName = null) {
        // Filter to valid nodes with server info
        const validNodes = nodes.filter(n => n.server && n.port);

        if (validNodes.length === 0) {
            throw new Error('No valid nodes to configure');
        }

        // Build outbounds from nodes
        const outbounds = [];

        // Add proxy outbounds
        validNodes.forEach((node, idx) => {
            const outbound = this.nodeToOutbound(node, idx);
            if (outbound) {
                outbounds.push(outbound);
            }
        });

        // Get all proxy tags
        const proxyTags = outbounds.filter(o => o.tag !== 'direct' && o.tag !== 'block').map(o => o.tag);

        // Add manual selector (for testing individual nodes via Clash API)
        outbounds.push({
            type: 'selector',
            tag: 'manual',
            outbounds: proxyTags,
            default: proxyTags[0] || 'direct'
        });

        // Add auto selector (urltest for automatic best node selection)
        outbounds.push({
            type: 'urltest',
            tag: 'auto',
            outbounds: proxyTags,
            url: 'https://www.gstatic.com/generate_204',
            interval: '5m'
        });

        // Add direct and block
        outbounds.push({ type: 'direct', tag: 'direct' });
        outbounds.push({ type: 'block', tag: 'block' });

        const config = {
            log: {
                level: 'info',
                timestamp: true
            },
            experimental: {
                clash_api: {
                    external_controller: '127.0.0.1:9090',
                    external_ui: '',
                    default_mode: 'rule'
                }
            },
            inbounds: [
                {
                    type: 'socks',
                    tag: 'socks-in',
                    listen: '127.0.0.1',
                    listen_port: this.localPort,
                    sniff: true
                },
                {
                    type: 'http',
                    tag: 'http-in',
                    listen: '127.0.0.1',
                    listen_port: this.localPort + 1,
                    sniff: true
                }
            ],
            outbounds: outbounds,
            route: {
                rules: [
                    { protocol: ['dns'], outbound: 'direct' }
                ],
                final: 'manual',  // Use manual selector for Clash API testing
                auto_detect_interface: true
            }
        };

        return config;
    }

    // Convert proxy node to sing-box outbound format
    nodeToOutbound(node, idx) {
        // Use node ID to ensure unique tag (duplicate names can exist)
        const baseName = node.name || `proxy-${idx}`;
        const tag = node.id ? `${baseName}-${node.id}` : `${baseName}-${idx}`;
        const config = node.configJson ? JSON.parse(node.configJson) : node.config || {};

        switch (node.type) {
            case 'ss':
            case 'shadowsocks':
                return {
                    type: 'shadowsocks',
                    tag,
                    server: node.server,
                    server_port: node.port,
                    method: config.method || config.cipher || 'aes-256-gcm',
                    password: config.password
                };

            case 'vmess':
                return {
                    type: 'vmess',
                    tag,
                    server: node.server,
                    server_port: node.port,
                    uuid: config.id || config.uuid,
                    security: config.security || 'auto',
                    alter_id: config.aid || config.alterId || 0,
                    transport: this.buildTransport(config)
                };

            case 'vless':
                return {
                    type: 'vless',
                    tag,
                    server: node.server,
                    server_port: node.port,
                    uuid: config.uuid || config.id,
                    flow: config.flow || '',
                    tls: config.security === 'tls' || config.tls ? {
                        enabled: true,
                        server_name: config.sni || config.host || node.server
                    } : undefined,
                    transport: this.buildTransport(config)
                };

            case 'trojan':
                return {
                    type: 'trojan',
                    tag,
                    server: node.server,
                    server_port: node.port,
                    password: config.password,
                    tls: {
                        enabled: true,
                        server_name: config.sni || node.server
                    }
                };

            case 'anytls':
                // AnyTLS - newer protocol in sing-box
                return {
                    type: 'anytls',
                    tag,
                    server: node.server,
                    server_port: node.port,
                    password: config.password,
                    tls: {
                        enabled: true,
                        server_name: config.sni || node.server,
                        insecure: config['skip-cert-verify'] === true || config.skipCertVerify === true,
                        alpn: config.alpn || ['h2', 'http/1.1'],
                        utls: {
                            enabled: true,
                            fingerprint: config['client-fingerprint'] || config.clientFingerprint || 'chrome'
                        }
                    }
                };

            case 'socks5':
            case 'socks':
                return {
                    type: 'socks',
                    tag,
                    server: node.server,
                    server_port: node.port,
                    username: config.username,
                    password: config.password
                };

            case 'http':
                return {
                    type: 'http',
                    tag,
                    server: node.server,
                    server_port: node.port,
                    username: config.username,
                    password: config.password
                };

            default:
                console.warn(`[SingBox] Unknown proxy type: ${node.type}`);
                return null;
        }
    }

    buildTransport(config) {
        const network = config.network || config.net || 'tcp';

        if (network === 'ws') {
            return {
                type: 'ws',
                path: config.path || config['ws-path'] || '/',
                headers: config.host ? { Host: config.host } : undefined
            };
        }
        if (network === 'grpc') {
            return {
                type: 'grpc',
                service_name: config['grpc-service-name'] || config.serviceName || ''
            };
        }
        return undefined;
    }

    // Save config to file
    async saveConfig(config) {
        const dir = path.dirname(this.configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
        console.log(`[SingBox] Config saved to ${this.configPath}`);
    }

    // Start sing-box process
    async start() {
        if (this.isRunning) {
            console.log('[SingBox] Already running');
            return { success: true, message: 'Already running' };
        }

        if (!this.isBinaryInstalled()) {
            return { success: false, error: 'sing-box binary not found. Please install it first.' };
        }

        if (!fs.existsSync(this.configPath)) {
            return { success: false, error: 'Config file not found. Generate config first.' };
        }

        return new Promise((resolve) => {
            this.process = spawn(this.binaryPath, ['run', '-c', this.configPath], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            this.process.stdout.on('data', (data) => {
                console.log(`[SingBox] ${data.toString().trim()}`);
            });

            this.process.stderr.on('data', (data) => {
                console.error(`[SingBox] ${data.toString().trim()}`);
            });

            this.process.on('error', (err) => {
                console.error('[SingBox] Process error:', err);
                this.isRunning = false;
                resolve({ success: false, error: err.message });
            });

            this.process.on('exit', (code) => {
                console.log(`[SingBox] Process exited with code ${code}`);
                this.isRunning = false;
            });

            // Give it a moment to start
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.isRunning = true;
                    console.log(`[SingBox] Started on socks5://127.0.0.1:${this.localPort}`);
                    resolve({ success: true, port: this.localPort });
                }
            }, 1000);
        });
    }

    // Stop sing-box process
    async stop() {
        if (!this.isRunning || !this.process) {
            return { success: true, message: 'Not running' };
        }

        return new Promise((resolve) => {
            this.process.on('exit', () => {
                this.isRunning = false;
                this.process = null;
                resolve({ success: true });
            });

            this.process.kill('SIGTERM');

            // Force kill after 5 seconds
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.process.kill('SIGKILL');
                }
            }, 5000);
        });
    }

    // Restart sing-box
    async restart() {
        await this.stop();
        return await this.start();
    }

    // Get local proxy URL
    getProxyUrl() {
        if (!this.isRunning) return null;
        return `socks5://127.0.0.1:${this.localPort}`;
    }

    // Get status
    getStatus() {
        return {
            isRunning: this.isRunning,
            port: this.localPort,
            proxyUrl: this.getProxyUrl(),
            binaryInstalled: this.isBinaryInstalled(),
            configExists: fs.existsSync(this.configPath),
            clashApiUrl: 'http://127.0.0.1:9090'
        };
    }

    // Switch to a specific node via Clash API (no restart needed!)
    async selectNode(nodeTag) {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        try {
            const res = await fetch('http://127.0.0.1:9090/proxies/manual', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: nodeTag })
            });

            if (res.ok) {
                console.log('[SingBox] Switched to node: ' + nodeTag);
                return { success: true };
            } else {
                const text = await res.text();
                console.log('[SingBox] Failed to switch node: ' + text);
                return { success: false, error: text };
            }
        } catch (e) {
            console.log('[SingBox] Clash API error: ' + e.message);
            return { success: false, error: e.message };
        }
    }

    // Test a node by switching to it via Clash API, then testing connectivity
    async testNodeViaClashAPI(node) {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        if (!this.isRunning) {
            return { error: 'sing-box not running' };
        }

        // Step 1: Switch to this node
        const nodeTag = node.name + '-' + node.id;
        console.log('[SingBox Test] Switching to node: ' + nodeTag);

        const switchResult = await this.selectNode(nodeTag);
        if (!switchResult.success) {
            return {
                euler: { status: 'blocked', latency: -1, error: 'Cannot switch to node: ' + (switchResult.error || 'unknown') },
                tiktok: { status: 'blocked', latency: -1 }
            };
        }

        // Wait for connection to stabilize
        await new Promise(r => setTimeout(r, 1000));

        // Step 2: Test via main proxy (which now routes through selected node)
        const { SocksProxyAgent } = require('socks-proxy-agent');
        const agent = new SocksProxyAgent('socks5://127.0.0.1:' + this.localPort);

        // Test connectivity first
        console.log('[SingBox Test] Testing connectivity via cloudflare.com...');
        const connectResult = await this.testEndpoint(agent, 'https://www.cloudflare.com/cdn-cgi/trace', 'Connectivity');

        if (connectResult.status !== 'ok') {
            console.log('[SingBox Test] Connectivity failed: ' + (connectResult.error || 'unknown'));
            return {
                connectivity: connectResult,
                euler: { status: 'blocked', latency: -1, error: 'Node connectivity failed' },
                tiktok: { status: 'blocked', latency: -1, error: 'Node connectivity failed' }
            };
        }
        console.log('[SingBox Test] Connectivity OK, latency=' + connectResult.latency + 'ms');

        // Test Euler
        const eulerResult = await this.testEndpoint(agent, 'https://tiktok.eulerstream.com/webcast/sign_url', 'Euler');

        // Test TikTok
        const tiktokResult = await this.testEndpoint(agent, 'https://www.tiktok.com/robots.txt', 'TikTok');

        console.log('[SingBox Test] Results - Euler: ' + eulerResult.status + ' (' + eulerResult.latency + 'ms), TikTok: ' + tiktokResult.status + ' (' + tiktokResult.latency + 'ms)');

        return { connectivity: connectResult, euler: eulerResult, tiktok: tiktokResult };
    }

    // Test a single node in isolation using temporary sing-box instance
    async testSingleNode(node) {
        if (!this.isBinaryInstalled()) {
            return { error: 'sing-box not installed' };
        }

        const testPort = 1095; // Temp port for testing
        const tempConfigPath = path.join(__dirname, '..', 'data', `singbox-test-${node.id}.json`);
        let tempProcess = null;

        try {
            // Create outbound for this specific node
            const outbound = this.nodeToOutbound(node, 0);
            if (!outbound) {
                console.log(`[SingBox Test] Failed to create outbound for node ${node.name}`);
                return { euler: { status: 'blocked', error: 'Invalid node config' }, tiktok: { status: 'blocked' } };
            }

            // Create minimal config for testing (use 'info' level to see startup messages)
            const testConfig = {
                log: { level: 'info' },
                inbounds: [
                    {
                        type: 'socks',
                        tag: 'test-socks',
                        listen: '127.0.0.1',
                        listen_port: testPort,
                        sniff: true
                    }
                ],
                outbounds: [
                    outbound,
                    { type: 'direct', tag: 'direct' }
                ],
                route: {
                    final: outbound.tag,
                    auto_detect_interface: true
                }
            };

            // Save temp config
            fs.writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2));
            console.log(`[SingBox Test] Config saved for ${node.name}`);

            // Start temp sing-box process
            tempProcess = spawn(this.binaryPath, ['run', '-c', tempConfigPath], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let startupError = null;
            let started = false;

            // Wait for sing-box to start
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.log(`[SingBox Test] Timeout waiting for ${node.name} startup`);
                    resolve();
                }, 4000);

                const checkOutput = (data) => {
                    const msg = data.toString();
                    // console.log(`[SingBox Test] Output: ${msg.slice(0, 100)}`);

                    if (msg.includes('sing-box started') || msg.includes('inbound/socks') || msg.includes('tcp server started')) {
                        started = true;
                        clearTimeout(timeout);
                        setTimeout(resolve, 800); // Wait for stability
                    }
                    if (msg.includes('FATAL') || (msg.includes('error') && !msg.includes('stderr'))) {
                        startupError = msg.slice(0, 200);
                        clearTimeout(timeout);
                        resolve();
                    }
                };

                tempProcess.stdout.on('data', checkOutput);
                tempProcess.stderr.on('data', checkOutput);
            });

            if (startupError) {
                console.log(`[SingBox Test] Startup error for ${node.name}: ${startupError}`);
                return {
                    euler: { status: 'blocked', latency: -1, error: startupError },
                    tiktok: { status: 'blocked', latency: -1 }
                };
            }

            if (!started) {
                console.log('[SingBox Test] ' + node.name + ' may not have started properly, attempting test anyway...');
            } else {
                console.log('[SingBox Test] ' + node.name + ' started on port ' + testPort);
            }

            // Extra wait for sing-box to fully initialize connections
            await new Promise(r => setTimeout(r, 2000));
            console.log('[SingBox Test] Startup delay complete, beginning tests...');

            // Test via temp proxy
            const { SocksProxyAgent } = require('socks-proxy-agent');
            const agent = new SocksProxyAgent('socks5://127.0.0.1:' + testPort);

            // Step 1: Test basic connectivity first (cloudflare.com)
            console.log('[SingBox Test] Testing basic connectivity via cloudflare.com...');
            const connectResult = await this.testEndpoint(agent, 'https://www.cloudflare.com/cdn-cgi/trace', 'Connectivity');

            if (connectResult.status !== 'ok') {
                console.log('[SingBox Test] Basic connectivity failed for ' + node.name + ': ' + (connectResult.error || 'unknown'));
                return {
                    connectivity: connectResult,
                    euler: { status: 'blocked', latency: -1, error: 'Node connectivity failed' },
                    tiktok: { status: 'blocked', latency: -1, error: 'Node connectivity failed' }
                };
            }
            console.log('[SingBox Test] Connectivity OK, latency=' + connectResult.latency + 'ms');

            // Step 2: Test Euler
            const eulerResult = await this.testEndpoint(agent, 'https://tiktok.eulerstream.com/webcast/sign_url', 'Euler');

            // Step 3: Test TikTok
            const tiktokResult = await this.testEndpoint(agent, 'https://www.tiktok.com/robots.txt', 'TikTok');

            return { connectivity: connectResult, euler: eulerResult, tiktok: tiktokResult };

        } catch (e) {
            console.log('[SingBox Test] Exception: ' + e.message);
            return {
                euler: { status: 'blocked', latency: -1, error: e.message },
                tiktok: { status: 'blocked', latency: -1, error: e.message }
            };
        } finally {
            // Kill temp process - wait a bit to ensure tests complete
            await new Promise(r => setTimeout(r, 500));
            if (tempProcess) {
                tempProcess.kill('SIGTERM');
                await new Promise(r => setTimeout(r, 500));
            }
            // Clean up temp config
            try { fs.unlinkSync(tempConfigPath); } catch (e) { }
        }
    }
    // Helper method to test a specific endpoint
    async testEndpoint(agent, url, name) {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            console.log('[SingBox Test] Testing ' + name + ' at ' + url + '...');
            const start = Date.now();
            const res = await fetch(url, {
                agent,
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            clearTimeout(timeoutId);
            const latency = Date.now() - start;

            console.log('[SingBox Test] ' + name + ' response: status=' + res.status + ', latency=' + latency + 'ms');

            if (res.status === 403 || res.status === 429) {
                return { status: 'blocked', latency: -1 };
            }

            return { status: 'ok', latency };
        } catch (e) {
            console.log('[SingBox Test] ' + name + ' error: ' + e.message);
            if (e.name === 'AbortError') {
                return { status: 'blocked', latency: -1, error: 'Timeout' };
            }
            return { status: 'blocked', latency: -1, error: e.message };
        }
    }
}

module.exports = new SingBoxManager();
