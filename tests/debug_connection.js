/**
 * Debug test for TikTokConnectionWrapper
 */
require('dotenv').config();

console.log('=== Test Script Started ===');
console.log('Step 1: Loading modules...');

const { TikTokConnectionWrapper, getKeyCount } = require('../connectionWrapper');

console.log('Step 2: Modules loaded. Key count:', getKeyCount());

console.log('Step 3: Creating wrapper for suc.girlsvibe with proxy...');
console.log('PROXY_URL:', process.env.PROXY_URL);

const wrapper = new TikTokConnectionWrapper('suc.girlsvibe', {
    proxyUrl: process.env.PROXY_URL || 'socks5://127.0.0.1:1099'
}, true);

console.log('Step 4: Wrapper created, calling connect()...');

wrapper.connect(false, null)
    .then(state => {
        console.log('Step 5: Connected!', state?.roomId, state?.roomInfo?.status);
    })
    .catch(err => {
        console.error('Step 5: Connection error:', err.message);
    })
    .finally(() => {
        console.log('Step 6: Test complete, exiting...');
        setTimeout(() => process.exit(0), 2000);
    });

console.log('Step 4b: Connect called, waiting for resolution...');
