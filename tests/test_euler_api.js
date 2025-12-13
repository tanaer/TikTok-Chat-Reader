// Test if Euler API Key is working
const { manager } = require('../manager');
const { SignConfig } = require('tiktok-live-connector');

(async () => {
    console.log('=== Euler API Key Diagnostic ===\n');

    // 1. Check database setting
    const dbSettings = await manager.getAllSettings();
    const apiKey = dbSettings.euler_api_key || process.env.EULER_API_KEY;

    if (!apiKey) {
        console.error('❌ No Euler API Key configured!');
        console.log('   Configure it in Settings or .env file');
        process.exit(1);
    }

    console.log('✅ API Key found in config:', apiKey.substring(0, 10) + '...');

    // 2. Set it globally
    SignConfig.apiKey = apiKey;
    console.log('✅ API Key set in SignConfig');

    // 3. Test connection to a known live stream
    const { TikTokLiveConnection } = require('tiktok-live-connector');

    console.log('\n🔍 Testing connection to a test stream...');
    console.log('   (This will test if the API Key works)\n');

    const testConnection = new TikTokLiveConnection('hot_s002', {
        connectWithUniqueId: true,
        fetchRoomInfoOnConnect: false  // Just test signing
    });

    try {
        await testConnection.connect();
        console.log('✅ API Key is VALID and working!');
        console.log('   Room ID:', testConnection.roomId);
        testConnection.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ Connection failed:', err.message);

        if (err.message.includes('504') || err.message.includes('500')) {
            console.log('\n💡 Possible causes:');
            console.log('   1. API Key quota exceeded');
            console.log('   2. Signing server overloaded');
            console.log('   3. TikTok temporarily blocking the region');
            console.log('   4. The stream just ended');
        }

        process.exit(1);
    }
})();
