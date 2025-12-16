const { TikTokConnectionWrapper } = require('../connectionWrapper');

const targets = [
    'user9999581075200',
    'mz.001__',
    'yy001384',
    'mz.002_',      // Updated from user feedback
    'blooming1881',
    'chire001.2025' // Suspected false positive
];

(async () => {
    console.log('Advanced Diagnosis starting for:', targets);

    for (const uniqueId of targets) {
        console.log(`\n================================`);
        console.log(`Testing: ${uniqueId}`);
        console.log(`================================`);

        const wrapper = new TikTokConnectionWrapper(uniqueId, {}, true);

        try {
            // Step 1: Check fetchIsLive (Logic used by AutoRecorder)
            console.log(`[Step 1] Checking fetchIsLive()...`);
            const startTime = Date.now();
            let isLive = false;
            try {
                // We need to initialize connection object to use fetchIsLive
                // But wrapper.connection is null until connect() called
                // Wait, wrapper.fetchIsLive() doesn't exist? 
                // AutoRecorder uses: wrapper.connection.fetchIsLive()
                // But connection is created in connect().

                // Let's manually create the connection object without connecting
                const { WebcastPushConnection } = require('tiktok-live-connector');
                // We need the same config as wrapper uses
                const config = {
                    processInitialData: false,
                    enableExtendedGiftInfo: true,
                    enableWebsocketUpgrade: true,
                    clientParams: { app_language: 'en-US', device_platform: 'web' },
                    requestOptions: { timeout: 10000 } // Default timeout
                    // Proxy is handled by GlobalProxyAgent
                };

                // Manually instantiate to test the check method
                const tempConn = new WebcastPushConnection(uniqueId, config);
                isLive = await tempConn.fetchIsLive();
                console.log(`   > fetchIsLive result: ${isLive} (took ${Date.now() - startTime}ms)`);

            } catch (e) {
                console.log(`   > fetchIsLive ERROR: ${e.message}`);
            }

            // Step 2: Attempt Connect if Live (or if we want to force check)
            console.log(`[Step 2] Attempting Full Connect...`);
            try {
                await wrapper.connect();

                if (wrapper.connection) {
                    console.log(`   > Connected! RoomId: ${wrapper.connection.roomId}`);
                    console.log(`   > State: ${JSON.stringify(wrapper.connection.state)}`);

                    // Wait a bit
                    await new Promise(r => setTimeout(r, 3000));

                    if (wrapper.connection.state.isConnected) {
                        console.log(`   > Status: STABLE`);
                    } else {
                        console.log(`   > Status: DISCONNECTED immediately`);
                    }
                }
                wrapper.disconnect();
            } catch (e) {
                console.log(`   > Connect Failed: ${e.message}`);
                if (e.response) {
                    console.log(`     Data: ${JSON.stringify(e.response.data)}`);
                }
            }

        } catch (err) {
            console.error(`Unexpected Error:`, err);
        }
    }

    console.log('\nDiagnosis complete. Press Ctrl+C to exit.');
})();
