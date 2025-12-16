/**
 * Test connection WITH sessionId to verify if sessionId causes event loss
 */
require('dotenv').config();
const { TikTokLiveConnection, SignConfig } = require('tiktok-live-connector');
const { SocksProxyAgent } = require('socks-proxy-agent');

const keyManager = require('../utils/keyManager');
const TEST_ROOM = process.argv[2] || 'keekeebaby4ever';

async function test() {
    const proxyUrl = process.env.PROXY_URL || 'socks5://127.0.0.1:1099';
    const agent = new SocksProxyAgent(proxyUrl);
    const apiKey = keyManager.getActiveKey();

    if (apiKey) {
        SignConfig.apiKey = apiKey;
        console.log(`Using Euler Key: ${apiKey.slice(0, 10)}...`);
    }
    console.log(`Using Proxy: ${proxyUrl}`);
    console.log(`Using SessionId: ${process.env.SESSIONID ? process.env.SESSIONID.slice(0, 30) + '...' : 'NOT SET'}`);
    console.log('=== Connection Test WITH SESSION ID ===');
    console.log(`Testing room: ${TEST_ROOM}\n`);

    const connection = new TikTokLiveConnection(TEST_ROOM, {
        enableExtendedGiftInfo: true,
        fetchRoomInfoOnConnect: true,
        sessionId: process.env.SESSIONID, // Include sessionId
        ttTargetIdc: process.env.TT_TARGET_IDC || 'useast2a',
        webClientOptions: {
            httpsAgent: agent,
            timeout: 30000
        },
        wsClientOptions: {
            agent: agent,
            timeout: 30000
        }
    });

    connection.on('connected', state => {
        console.log('\n✅ CONNECTED!');
        console.log(`   Room ID: ${state.roomId}`);
    });

    connection.on('websocketConnected', () => {
        console.log('\n✅ WEBSOCKET CONNECTED!');
    });

    connection.on('error', (err) => {
        console.log('\n⚠️ ERROR:', err?.info || err?.message || err);
    });

    try {
        console.log('Connecting (with sessionId)...');
        const state = await connection.connect(undefined);
        console.log('Connected! Listening for 15s...\n');

        let eventCount = 0;
        connection.on('chat', (msg) => {
            eventCount++;
            console.log(`[CHAT] ${msg.user?.uniqueId}: ${msg.comment}`);
        });

        connection.on('member', (msg) => {
            eventCount++;
            if (eventCount <= 5) console.log(`[MEMBER] ${msg.user?.uniqueId} joined`);
        });

        connection.on('gift', (msg) => {
            eventCount++;
            console.log(`[GIFT] ${msg.user?.uniqueId} sent ${msg.gift?.giftName || 'gift'}`);
        });

        await new Promise(r => setTimeout(r, 15000));
        console.log(`\nTotal events received: ${eventCount}`);
        await connection.disconnect();
        process.exit(0);

    } catch (err) {
        console.error('\n❌ Connection error:', err.message || err);
        process.exit(1);
    }
}

test();
