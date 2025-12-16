/**
 * COMPREHENSIVE DIAGNOSTIC - Find why auto-recorder fails when manual test works
 */
require('dotenv').config();

const { manager } = require('../manager');
const { TikTokConnectionWrapper, getKeyCount } = require('../connectionWrapper');

async function diagnose() {
    console.log('='.repeat(60));
    console.log('COMPREHENSIVE LIVE DETECTION DIAGNOSTIC');
    console.log('='.repeat(60));
    console.log('Time:', new Date().toISOString());
    console.log('');

    // Step 1: Check database for monitored rooms
    console.log('--- STEP 1: Database Check ---');
    const roomsResult = await manager.getRooms({ limit: 100 });
    const rooms = roomsResult.data || [];
    const monitoredRooms = rooms.filter(r => r.is_monitor_enabled === 1 && r.name);
    console.log(`Total rooms: ${rooms.length}`);
    console.log(`Monitored rooms (is_monitor_enabled=1 AND has name): ${monitoredRooms.length}`);

    if (monitoredRooms.length === 0) {
        console.log('❌ NO ROOMS ARE BEING MONITORED!');
        console.log('This is why no connections are made.');
        process.exit(1);
    }

    console.log('\nMonitored rooms:');
    monitoredRooms.slice(0, 10).forEach(r => {
        console.log(`  - ${r.room_id} (${r.name}) [cached_id: ${r.numeric_room_id || 'none'}]`);
    });

    // Step 2: Check settings
    console.log('\n--- STEP 2: Settings Check ---');
    const settings = await manager.getAllSettings();
    console.log('Settings:');
    console.log(`  proxy: ${settings.proxy || 'NOT SET (will use PROXY_URL env)'}`);
    console.log(`  session_id: ${settings.session_id ? '***SET***' : 'NOT SET'}`);
    console.log(`  tt_target_idc: ${settings.tt_target_idc || 'NOT SET'}`);
    console.log(`  euler_api_key: ${settings.euler_api_key ? '***SET***' : 'NOT SET'}`);
    console.log(`  auto_monitor_enabled: ${settings.auto_monitor_enabled ?? 'NOT SET (default true)'}`);
    console.log(`  interval: ${settings.interval || '5'} minutes`);

    if (settings.auto_monitor_enabled === 'false' || settings.auto_monitor_enabled === false) {
        console.log('❌ AUTO MONITOR IS DISABLED IN SETTINGS!');
        console.log('Enable it via the web UI or database.');
        process.exit(1);
    }

    // Step 3: Check environment
    console.log('\n--- STEP 3: Environment Check ---');
    console.log(`PROXY_URL: ${process.env.PROXY_URL || 'NOT SET'}`);
    console.log(`SESSIONID: ${process.env.SESSIONID ? '***SET***' : 'NOT SET'}`);
    console.log(`TT_TARGET_IDC: ${process.env.TT_TARGET_IDC || 'NOT SET'}`);
    console.log(`EULER_API_KEY: ${process.env.EULER_API_KEY ? '***SET***' : 'NOT SET'}`);
    console.log(`EULER_KEYS: ${process.env.EULER_KEYS ? `${getKeyCount()} keys` : 'NOT SET'}`);

    // Step 4: Try to connect to first monitored room
    console.log('\n--- STEP 4: Live Connection Test ---');
    const testRoom = monitoredRooms[0];
    console.log(`Testing connection to: ${testRoom.room_id} (${testRoom.name})`);

    // Build options exactly like auto_recorder does
    const sessionId = settings.session_id || process.env.SESSIONID;
    const options = {
        enableExtendedGiftInfo: true,
        fetchRoomInfoOnConnect: true,
        proxyUrl: settings.proxy || settings.proxy_url,
        eulerApiKey: settings.euler_api_key,
        ...(sessionId ? {
            sessionId: sessionId,
            ttTargetIdc: settings.tt_target_idc || process.env.TT_TARGET_IDC || 'useast2a'
        } : {})
    };

    console.log('Options:', JSON.stringify({
        ...options,
        sessionId: options.sessionId ? '***' : undefined,
        eulerApiKey: options.eulerApiKey ? '***' : undefined
    }, null, 2));

    try {
        console.log('\nCreating wrapper...');
        const wrapper = new TikTokConnectionWrapper(testRoom.room_id, options, true);

        console.log('Connecting (timeout 30s)...');
        const connectPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Test timeout')), 30000);

            wrapper.once('connected', state => {
                clearTimeout(timeout);
                resolve(state);
            });

            wrapper.once('disconnected', reason => {
                clearTimeout(timeout);
                reject(new Error(`Disconnected: ${reason}`));
            });
        });

        // Start connection
        wrapper.connect(false, testRoom.numeric_room_id || null).catch(() => { });

        const state = await connectPromise;
        console.log('\n✅ CONNECTION SUCCESSFUL!');
        console.log(`   Room ID: ${state.roomId}`);
        console.log(`   Status: ${state.roomInfo?.status}`);

        // Wait 5 seconds for events
        console.log('\nWaiting 5s for events...');
        let eventCount = 0;
        wrapper.connection.on('chat', () => eventCount++);
        wrapper.connection.on('gift', () => eventCount++);
        wrapper.connection.on('member', () => eventCount++);

        await new Promise(r => setTimeout(r, 5000));
        console.log(`Received ${eventCount} events`);

        wrapper.disconnect();
        console.log('\n✅ THE CONNECTION MECHANISM WORKS!');
        console.log('The issue must be in the auto-recorder loop logic.');

    } catch (err) {
        console.log('\n❌ CONNECTION FAILED!');
        console.log(`   Error: ${err.message}`);

        if (err.message.includes('tt-target-idc')) {
            console.log('\n⚠️  The sessionId/ttTargetIdc conditional fix is not working.');
        } else if (err.message.includes('timeout') || err.message.includes('Timeout')) {
            console.log('\n⚠️  Connection is timing out. Possible causes:');
            console.log('   - Proxy is slow or blocked');
            console.log('   - Euler API is not responding');
            console.log('   - Room is not actually live');
        } else if (err.message.includes('offline') || err.message.includes('isn\'t online')) {
            console.log('\n⚠️  Room is offline. This is expected if the streamer is not live.');
        }
    }

    console.log('\n' + '='.repeat(60));
    process.exit(0);
}

diagnose().catch(err => {
    console.error('Diagnostic failed:', err);
    process.exit(1);
});
