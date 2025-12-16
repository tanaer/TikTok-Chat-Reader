const { TikTokLiveConnection } = require('tiktok-live-connector');
const KeyManager = require('../key_manager');
const { SocksProxyAgent } = require('socks-proxy-agent');
require('dotenv').config();

const keysStr = process.env.EULER_KEYS || process.env.EULER_API_KEY || '';
if (!keysStr) {
    console.error('No EULER_KEYS or EULER_API_KEY found in .env');
    process.exit(1);
}

const keyManager = new KeyManager(keysStr);
const target = 'tiktok'; // Using 'tiktok' as a stable target
const proxyUrl = (process.env.PROXY_URL || 'socks5://127.0.0.1:7891').replace('socks5://', 'socks5h://');

console.log(`Loaded ${keyManager.keys.length} keys.`);
console.log(`Proxy: ${proxyUrl}`);

(async () => {
    for (let i = 0; i < keyManager.keys.length; i++) {
        const keyData = keyManager.keys[i];
        const key = keyData.key;
        const label = `Key #${i + 1} (${key.slice(0, 8)}...)`;

        console.log(`\n[${label}] Testing...`);

        // Create connection with THIS specific key
        const connection = new TikTokLiveConnection(target, {
            processInitialData: false,
            enableExtendedGiftInfo: false,
            requestOptions: {
                timeout: 10000,
                agent: new SocksProxyAgent(proxyUrl)
            },
            websocketOptions: {
                timeout: 10000,
                agent: new SocksProxyAgent(proxyUrl)
            },
            signApiKey: key
        });

        try {
            await connection.connect();
            console.log(`✅ [${label}] SUCCESS - Connected!`);
            connection.disconnect();
        } catch (err) {
            const msg = err.message || err.toString();

            if (msg.includes('Rate Limited') || msg.includes('429')) {
                console.log(`❌ [${label}] FAILED - Rate Limited (429)`);
            } else if (msg.includes("isn't online")) {
                console.log(`✅ [${label}] SUCCESS - Signed OK (User Offline)`);
            } else if (msg.includes("Signature") || msg.includes("Sign Error")) {
                console.log(`❌ [${label}] FAILED - Sign Error: ${msg}`);
            } else {
                console.log(`⚠️ [${label}] ERROR - ${msg}`);
            }
        }

        // Small delay
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log('\nDone.');
})();
