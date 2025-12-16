/**
 * Test connection WITH proxy but without ANY cached room ID
 * Forces completely fresh fetch from Euler API
 */
require('dotenv').config();

const { TikTokLiveConnection, SignConfig } = require('tiktok-live-connector');
const { SocksProxyAgent } = require('socks-proxy-agent');

const TEST_ROOM = process.argv[2] || 'suc.girlsvibe';

// Set API key
const keyManager = require('../utils/keyManager');
const apiKey = keyManager.getActiveKey();
if (apiKey) {
    SignConfig.apiKey = apiKey;
    console.log(`Using Euler Key: ${apiKey.slice(0, 10)}...`);
}

const proxyUrl = process.env.PROXY_URL || 'socks5://127.0.0.1:1099';
console.log(`Using Proxy: ${proxyUrl}`);

async function main() {
    console.log('=== Fresh Connection Test (WITH PROXY, NO CACHE) ===');
    console.log(`Testing room: ${TEST_ROOM}`);
    console.log('');

    const agent = new SocksProxyAgent(proxyUrl);

    const connection = new TikTokLiveConnection(TEST_ROOM, {
        enableExtendedGiftInfo: true,
        fetchRoomInfoOnConnect: true,
        // NO sessionId (anonymous connection)
        webClientOptions: {
            httpsAgent: agent,
            timeout: 30000  // Longer timeout
        },
        wsClientOptions: {
            agent: agent,
            timeout: 30000
        }
    });

    connection.on('connected', state => {
        console.log('\n✅ CONNECTED!');
        console.log(`   Room ID: ${state.roomId}`);
        console.log(`   Status: ${state.roomInfo?.status}`);
        console.log(`   Owner: ${state.roomInfo?.owner?.nickname}`);
    });

    connection.on('disconnected', () => {
        console.log('\n❌ DISCONNECTED');
    });

    connection.on('error', (err) => {
        console.log('\n⚠️ ERROR EVENT:', err?.info || err?.message || err);
        if (err?.exception) {
            console.log('   Exception:', err.exception?.message || err.exception);
        }
    });

    connection.on('websocketConnected', (ws) => {
        console.log('\n✅ WEBSOCKET CONNECTED!');
    });

    try {
        console.log('Connecting (with proxy, NO cached room ID)...');
        // Pass undefined to force fresh Room ID fetch
        const state = await connection.connect(undefined);
        console.log('Connected! Room is LIVE. Listening for 10s...');

        let eventCount = 0;
        connection.on('chat', (msg) => {
            eventCount++;
            console.log(`[CHAT] ${msg.user?.uniqueId}: ${msg.comment}`);
        });

        connection.on('gift', (msg) => {
            eventCount++;
            console.log(`[GIFT] ${msg.user?.uniqueId} sent gift`);
        });

        connection.on('member', (msg) => {
            eventCount++;
            if (eventCount <= 5) console.log(`[MEMBER] ${msg.user?.uniqueId} joined`);
        });

        await new Promise(r => setTimeout(r, 10000));
        console.log(`\nTotal events received: ${eventCount}`);
        connection.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('\n❌ FAILED');
        console.error('   Error Name:', err?.constructor?.name || 'Unknown');
        console.error('   Message:', err?.message);

        if (err?.exception) {
            console.error('   Exception:', err.exception);
        }

        if (err?.requestErr) {
            console.error('   Request Error Code:', err.requestErr.code);
            console.error('   Request URL:', err.requestErr.config?.url?.slice(0, 100));
        }

        process.exit(1);
    }
}

main();
