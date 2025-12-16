/**
 * Direct test of room connection for suc.girlsvibe
 * Run while the room is LIVE to verify the entire flow works
 */
require('dotenv').config();

const { TikTokConnectionWrapper, getKeyCount } = require('../connectionWrapper');
const { manager } = require('../manager');

const TEST_ROOM = process.argv[2] || 'suc.girlsvibe';

async function main() {
    console.log('=== Direct Connection Test ===');
    console.log(`Testing room: ${TEST_ROOM}`);
    console.log(`Keys available: ${getKeyCount()}`);
    console.log('');

    // Get settings
    const dbSettings = await manager.getAllSettings();
    console.log('Settings loaded:', {
        proxy: dbSettings.proxy,
        sessionId: dbSettings.session_id ? '***set***' : 'not set',
        ttTargetIdc: dbSettings.tt_target_idc || process.env.TT_TARGET_IDC || 'useast2a'
    });

    const options = {
        enableExtendedGiftInfo: true,
        fetchRoomInfoOnConnect: true,
        sessionId: dbSettings.session_id || process.env.SESSIONID,
        ttTargetIdc: dbSettings.tt_target_idc || process.env.TT_TARGET_IDC || 'useast2a',
        proxyUrl: dbSettings.proxy,
        eulerApiKey: dbSettings.euler_api_key
    };

    console.log('\nCreating wrapper...');
    const wrapper = new TikTokConnectionWrapper(TEST_ROOM, options, true);

    // Set up event handlers
    wrapper.once('connected', state => {
        console.log('\n✅ CONNECTED EVENT RECEIVED!');
        console.log(`   Room ID: ${state.roomId}`);
        console.log(`   Status: ${state.roomInfo?.status}`);
        console.log(`   Is Live: ${state.roomInfo?.status === 2}`);
    });

    wrapper.once('disconnected', reason => {
        console.log('\n❌ DISCONNECTED EVENT RECEIVED:', reason);
    });

    // Try to get cached room ID
    let cachedRoomId = null;
    try {
        cachedRoomId = await manager.getCachedRoomId(TEST_ROOM);
        console.log(`Cached Room ID: ${cachedRoomId || 'none'}`);
    } catch (e) {
        console.log('No cached room ID');
    }

    // Attempt connection
    console.log('\nAttempting connection...');
    console.log(`  Using cached ID: ${cachedRoomId ? 'YES' : 'NO'}`);

    try {
        const startTime = Date.now();
        const state = await wrapper.connect(false, cachedRoomId);
        const elapsed = Date.now() - startTime;

        console.log(`\n✅ CONNECTION SUCCESSFUL in ${elapsed}ms`);
        console.log(`   Room ID: ${state.roomId}`);
        console.log(`   Status: ${state.roomInfo?.status}`);

        // Wait for some events
        console.log('\nListening for events for 10 seconds...');

        wrapper.connection.on('chat', (msg) => {
            console.log(`[CHAT] ${msg.user?.uniqueId}: ${msg.comment}`);
        });

        wrapper.connection.on('gift', (msg) => {
            console.log(`[GIFT] ${msg.user?.uniqueId} sent ${msg.giftId}`);
        });

        wrapper.connection.on('member', (msg) => {
            console.log(`[MEMBER] ${msg.user?.uniqueId} joined`);
        });

        await new Promise(r => setTimeout(r, 10000));

        console.log('\n--- Test complete ---');
        wrapper.disconnect();
        process.exit(0);

    } catch (err) {
        const elapsed = Date.now() - Date.now();
        console.error(`\n❌ CONNECTION FAILED`);
        console.error(`   Error Type: ${err?.constructor?.name || 'Error'}`);
        console.error(`   Message: ${err?.message}`);
        console.error(`   Info: ${err?.info}`);

        if (err?.exception) {
            console.error(`   Exception: ${err.exception?.constructor?.name}: ${err.exception?.message}`);
        }

        // Try retry without cached ID
        if (cachedRoomId) {
            console.log('\n--- Retrying without cached Room ID ---');
            try {
                // Clear cache
                await manager.setNumericRoomId(TEST_ROOM, null);

                // Need NEW wrapper since old one may be in bad state
                const wrapper2 = new TikTokConnectionWrapper(TEST_ROOM, options, true);

                wrapper2.once('connected', state => {
                    console.log('\n✅ RETRY CONNECTED!');
                    console.log(`   Room ID: ${state.roomId}`);
                });

                wrapper2.once('disconnected', reason => {
                    console.log('\n❌ RETRY DISCONNECTED:', reason);
                });

                const state = await wrapper2.connect(false, null);
                console.log(`\n✅ RETRY SUCCESSFUL`);
                console.log(`   Room ID: ${state.roomId}`);
                console.log(`   Status: ${state.roomInfo?.status}`);

                await new Promise(r => setTimeout(r, 5000));
                wrapper2.disconnect();

            } catch (err2) {
                console.error(`\n❌ RETRY ALSO FAILED`);
                console.error(`   Error: ${err2?.message}`);
            }
        }

        process.exit(1);
    }
}

main().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
