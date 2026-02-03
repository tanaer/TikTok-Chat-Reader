// Test the fixed spider
const { getStreamUrl } = require('../utils/tiktok_spider');
const db = require('../db');

async function test() {
    const proxy = await db.get('SELECT * FROM socks5_proxy LIMIT 1');
    let proxyUrl = null;
    if (proxy) {
        proxyUrl = `socks5://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
    }

    console.log('Testing getStreamUrl...');
    try {
        const url = await getStreamUrl('e6ckfu7g39zt85k', proxyUrl);
        console.log('\n=== SUCCESS ===');
        console.log('Stream URL:', url.substring(0, 100) + '...');
    } catch (err) {
        console.error('\n=== FAILED ===');
        console.error(err.message);
    }
    process.exit(0);
}

test();
