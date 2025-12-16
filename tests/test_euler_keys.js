require('dotenv').config();
const { TikTokLiveConnection, SignConfig } = require('tiktok-live-connector');

// 1. Parse Keys
const keysStr = process.env.EULER_KEYS || process.env.EULER_API_KEY || '';
const keys = keysStr.split(/[,;]/).map(k => k.trim()).filter(k => k);

console.log(`\n=== Euler Key Availability Test (Direct Connection) ===`);
console.log(`Found ${keys.length} keys in configuration.\n`);

const testTargets = ['tiktok', 'nasa', 'billieeilish'];

(async () => {
    if (keys.length === 0) {
        console.error("❌ No keys found in .env (EULER_KEYS or EULER_API_KEY)");
        process.exit(1);
    }

    for (const [index, key] of keys.entries()) {
        const maskedKey = key.slice(0, 8) + '...' + key.slice(-4);
        console.log(`Testing Key #${index + 1}: ${maskedKey}`);

        // Set the global key
        SignConfig.apiKey = key;

        let success = false;
        let lastError = null;

        // Try a few targets until we get a definitive result or fail all
        for (const target of testTargets) {
            // console.log(`  > Attempting connection to ${target}...`);
            const connection = new TikTokLiveConnection(target);

            try {
                // Set a timeout
                const connectPromise = connection.connect();
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000));

                await Promise.race([connectPromise, timeoutPromise]);

                // If we get here, we connected! Key is definitely working.
                console.log(`  ✅ SUCCESS: Connected to ${target}`);
                success = true;
                connection.disconnect();
                break; // Stop testing this key, it works.

            } catch (err) {
                const msg = (err.message || err.toString()).toLowerCase();
                const info = (err.info || '').toString().toLowerCase();
                const fullErr = msg + " " + info;
                lastError = fullErr;

                if (fullErr.includes('rate limit') || fullErr.includes('429')) {
                    console.log(`  ❌ FAILED: Rate Limited (429)`);
                    console.log(`     Details: ${err.message}`);
                    success = false; // Definitely failed
                    break; // Stop testing this key, it's limited.
                } else if (fullErr.includes('offline') || fullErr.includes('not online')) {
                    // console.log(`  ⚠️  User ${target} is offline. Trying next target...`);
                    continue;
                } else {
                    // console.log(`  ❓ Error on ${target}: ${msg.slice(0, 50)}...`);
                }
            }
        }

        if (!success) {
            if (lastError && (lastError.includes('offline') || lastError.includes('not online'))) {
                console.log(`  ⚠️  INCONCLUSIVE: All test targets were offline. Key is likely VALID.`);
            } else if (lastError) {
                console.log(`  ❌ ERROR: ${lastError.slice(0, 100)}`);
            } else {
                console.log(`  ❌ ERROR: Unknown.`);
            }
        }

        console.log('-'.repeat(40));
        // Small delay
        await new Promise(r => setTimeout(r, 1000));
    }
})();
