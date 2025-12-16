/**
 * Test connection WITHOUT proxy to isolate network issues
 */
require('dotenv').config();

const { TikTokLiveConnection, SignConfig } = require('tiktok-live-connector');

const TEST_ROOM = process.argv[2] || 'suc.girlsvibe';

// Set API key
const keyManager = require('../utils/keyManager');
const apiKey = keyManager.getActiveKey();
if (apiKey) {
    SignConfig.apiKey = apiKey;
    console.log(`Using Euler Key: ${apiKey.slice(0, 10)}...`);
}

async function main() {
    console.log('=== Direct Connection Test (NO PROXY) ===');
    console.log(`Testing room: ${TEST_ROOM}`);
    console.log('');

    const connection = new TikTokLiveConnection(TEST_ROOM, {
        enableExtendedGiftInfo: true,
        fetchRoomInfoOnConnect: true,
        // NO sessionId, NO proxy
    });

    connection.on('connected', state => {
        console.log('\n✅ CONNECTED!');
        console.log(`   Room ID: ${state.roomId}`);
        console.log(`   Status: ${state.roomInfo?.status}`);
    });

    connection.on('disconnected', () => {
        console.log('\n❌ DISCONNECTED');
    });

    connection.on('error', (err) => {
        console.log('\n❌ ERROR:', err?.info || err?.message || err);
    });

    try {
        console.log('Connecting (no proxy)...');
        const state = await connection.connect();
        console.log('Connected! Listening for 10s...');

        connection.on('chat', (msg) => {
            console.log(`[CHAT] ${msg.user?.uniqueId}: ${msg.comment}`);
        });

        await new Promise(r => setTimeout(r, 10000));
        connection.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('\n❌ FAILED:', err?.message || err);
        console.error('Full error:', JSON.stringify(err, null, 2));
        process.exit(1);
    }
}

main();
