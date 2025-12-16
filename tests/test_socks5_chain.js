/**
 * Test SOCKS5 chain with different auth format
 */
require('dotenv').config();
const { SocksClient } = require('socks');
const tls = require('tls');
const { URL } = require('url');

const LOCAL_PROXY = process.env.PROXY_URL || 'socks5://127.0.0.1:7891';
const TUNNEL_PROXY = process.env.DYNAMIC_TUNNEL_PROXY;

if (!TUNNEL_PROXY) {
    console.error('DYNAMIC_TUNNEL_PROXY not set');
    process.exit(1);
}

const localUrl = new URL(LOCAL_PROXY.replace('socks5h://', 'socks5://'));
const tunnelUrl = new URL(TUNNEL_PROXY.startsWith('http') ? TUNNEL_PROXY : 'http://' + TUNNEL_PROXY);

console.log('Testing SOCKS5 Chain:');
console.log(`  Local:  ${localUrl.hostname}:${localUrl.port}`);
console.log(`  Tunnel: ${tunnelUrl.hostname}:${tunnelUrl.port}`);
console.log(`  User:   ${tunnelUrl.username}`);
console.log(`  Target: ipinfo.io:443`);
console.log('');

// Test both auth formats
const proxies = [
    {
        host: localUrl.hostname,
        port: parseInt(localUrl.port),
        type: 5
    },
    {
        host: tunnelUrl.hostname,
        port: parseInt(tunnelUrl.port),
        type: 5,
        // Try different auth format - custom fields
        userId: tunnelUrl.username,
        password: tunnelUrl.password
    }
];

console.log('[DEBUG] Proxy chain config:', JSON.stringify(proxies, null, 2));

(async () => {
    try {
        console.log('\nConnecting through SOCKS5 chain...');
        const info = await SocksClient.createConnectionChain({
            proxies: proxies,
            destination: {
                host: 'ipinfo.io',
                port: 443
            },
            command: 'connect',
            timeout: 30000
        });

        console.log('✅ Chain connected!');

        const socket = info.socket;
        const secureSocket = tls.connect({
            socket: socket,
            servername: 'ipinfo.io',
            rejectUnauthorized: false
        });

        secureSocket.on('secureConnect', () => {
            console.log('✅ TLS OK! Fetching IP...');
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

    } catch (err) {
        console.error('❌ SOCKS5 Chain failed:', err.message);
        console.error('[DEBUG] Full error:', err);
        process.exit(1);
    }
})();
