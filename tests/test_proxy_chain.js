/**
 * Test script to verify HTTP CONNECT chain with improved event handling:
 * Local SOCKS5 (127.0.0.1:7891) -> HTTP Proxy (ipdodo) -> Target (ipinfo.io)
 */
require('dotenv').config();
const { SocksClient } = require('socks');
const tls = require('tls');
const { URL } = require('url');

const LOCAL_PROXY = process.env.PROXY_URL || 'socks5://127.0.0.1:7891';
const TUNNEL_PROXY = process.env.DYNAMIC_TUNNEL_PROXY;

if (!TUNNEL_PROXY) {
    console.error('DYNAMIC_TUNNEL_PROXY not set in .env');
    process.exit(1);
}

const localUrl = new URL(LOCAL_PROXY.replace('socks5h://', 'socks5://'));
const tunnelUrl = new URL(TUNNEL_PROXY.startsWith('http') ? TUNNEL_PROXY : 'http://' + TUNNEL_PROXY);

console.log('Testing HTTP CONNECT Chain:');
console.log(`  Local SOCKS5: ${localUrl.hostname}:${localUrl.port}`);
console.log(`  HTTP Proxy:   ${tunnelUrl.hostname}:${tunnelUrl.port}`);
console.log(`  User:         ${tunnelUrl.username}`);
console.log(`  Target:       ipinfo.io:443`);
console.log('');

(async () => {
    try {
        // Step 1: Connect via Local SOCKS5 to HTTP Proxy
        console.log('Step 1: Connecting to HTTP proxy via local SOCKS5...');
        const info = await SocksClient.createConnection({
            proxy: {
                host: localUrl.hostname,
                port: parseInt(localUrl.port),
                type: 5
            },
            command: 'connect',
            destination: {
                host: tunnelUrl.hostname,
                port: parseInt(tunnelUrl.port)
            },
            timeout: 30000
        });

        console.log('✅ Connected to HTTP proxy!');

        const socket = info.socket;

        // Add debug listeners
        socket.on('close', () => console.log('[DEBUG] Socket closed'));
        socket.on('error', (e) => console.log('[DEBUG] Socket error:', e.message));
        socket.on('end', () => console.log('[DEBUG] Socket ended'));

        // Step 2: Send HTTP CONNECT
        const auth = Buffer.from(`${tunnelUrl.username}:${tunnelUrl.password}`).toString('base64');
        const connectReq =
            `CONNECT ipinfo.io:443 HTTP/1.1\r\n` +
            `Host: ipinfo.io:443\r\n` +
            `Proxy-Authorization: Basic ${auth}\r\n` +
            `Proxy-Connection: keep-alive\r\n` +
            `Connection: keep-alive\r\n\r\n`;

        console.log('Step 2: Sending HTTP CONNECT...');
        console.log('[DEBUG] Request:', connectReq.replace(/\r\n/g, '\\r\\n'));
        socket.write(connectReq);

        // Use continuous data listener
        let responseBuffer = '';
        let headerReceived = false;

        socket.on('data', (data) => {
            const text = data.toString();
            console.log('[DEBUG] Received data chunk:', text.length, 'bytes');

            if (!headerReceived) {
                responseBuffer += text;
                const headerEnd = responseBuffer.indexOf('\r\n\r\n');

                if (headerEnd !== -1) {
                    headerReceived = true;
                    const header = responseBuffer.slice(0, headerEnd);
                    console.log('HTTP Proxy Response:', header.split('\r\n')[0]);

                    if (header.includes('200')) {
                        console.log('✅ Tunnel established!');

                        // Step 3: TLS Handshake
                        console.log('Step 3: TLS handshake...');
                        const secureSocket = tls.connect({
                            socket: socket,
                            servername: 'ipinfo.io',
                            rejectUnauthorized: false
                        });

                        secureSocket.on('secureConnect', () => {
                            console.log('✅ TLS connected! Fetching IP...');
                            secureSocket.write('GET /json HTTP/1.1\r\nHost: ipinfo.io\r\nConnection: close\r\n\r\n');
                        });

                        let result = '';
                        secureSocket.on('data', (d) => result += d.toString());
                        secureSocket.on('end', () => {
                            console.log('\n--- Result ---');
                            console.log(result);
                            process.exit(0);
                        });
                        secureSocket.on('error', (e) => {
                            console.error('❌ TLS Error:', e.message);
                            process.exit(1);
                        });
                    } else {
                        console.error('❌ HTTP CONNECT failed:', header);
                        process.exit(1);
                    }
                }
            }
        });

        // Timeout fallback
        setTimeout(() => {
            console.error('❌ Timeout waiting for proxy response');
            console.log('[DEBUG] responseBuffer so far:', responseBuffer);
            process.exit(1);
        }, 30000);

    } catch (err) {
        console.error('❌ Connection failed:', err.message);
        process.exit(1);
    }
})();
