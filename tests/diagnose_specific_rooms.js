const { TikTokConnectionWrapper } = require('../connectionWrapper');

// Targets
const targets = [
    'user9999581075200',
    'mz.001__',
    'yy001384',
    'mz.002'
];

(async () => {
    console.log('Diagnosis starting for:', targets);

    for (const uniqueId of targets) {
        console.log(`\n--- Testing ${uniqueId} ---`);
        const wrapper = new TikTokConnectionWrapper(uniqueId, {}, true); // true = enableLog

        try {
            console.log(` Attempting connect...`);

            // Wait for connection to initialize
            await wrapper.connect();

            // Now wrapper.connection should be available
            if (wrapper.connection) {
                // Hook error event for subsequent errors
                wrapper.connection.on('error', (err) => {
                    console.error(` X Error Event for ${uniqueId}:`);
                    console.error(`   Message: ${err.message}`);
                    if (err.response) {
                        console.error(`   Response Status: ${err.response.status}`);
                        console.error(`   Response Data:`, err.response.data);
                    }
                });

                if (wrapper.connection.roomId) {
                    console.log(` √ Connected! RoomId: ${wrapper.connection.roomId}`);
                } else {
                    console.log(` ? Connected but roomId null? State: ${JSON.stringify(wrapper.connection.state)}`);
                }
            } else {
                console.error(` X wrapper.connection is null even after await connect()`);
            }

            // Wait a bit to verify stable connection
            await new Promise(r => setTimeout(r, 5000));
            wrapper.disconnect();

        } catch (err) {
            console.error(` X Connection Exception for ${uniqueId}:`);
            console.error(`   Message: ${err.message}`);
            // Check if it's an Axios error from Euler API
            if (err.response) {
                console.error(`   API Response Status: ${err.response.status}`);
                console.error(`   API Response Data:`, JSON.stringify(err.response.data, null, 2));
            } else {
                console.error(err);
            }
        }
    }

    console.log('\nDiagnosis complete. Press Ctrl+C to exit.');
})();
