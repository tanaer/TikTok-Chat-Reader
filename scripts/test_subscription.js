// Debug script to test subscription parsing
require('dotenv').config();
const yaml = require('yaml');

async function testSubscription(url) {
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

    console.log('Fetching:', url);

    const res = await fetch(url, {
        timeout: 30000,
        headers: { 'User-Agent': 'ClashForWindows/0.20.0' }
    });
    const text = await res.text();

    console.log('Response length:', text.length);
    console.log('First 500 chars:', text.slice(0, 500));
    console.log('---');

    // Try YAML parse
    try {
        const parsed = yaml.parse(text);
        console.log('YAML keys:', Object.keys(parsed));
        console.log('proxies type:', typeof parsed.proxies);
        console.log('proxies isArray:', Array.isArray(parsed.proxies));
        console.log('proxies length:', parsed.proxies?.length || 0);

        if (parsed.proxies && parsed.proxies.length > 0) {
            console.log('First 3 proxies:');
            parsed.proxies.slice(0, 3).forEach((p, i) => {
                console.log(`  ${i + 1}. ${p.name} (${p.type}) - ${p.server}:${p.port}`);
            });
        }
    } catch (e) {
        console.log('YAML parse error:', e.message);
    }
}

const url = process.argv[2] || 'https://sub01.sh-cloudflare.sbs:8443/api/v1/client/subscribe?token=d69ae2ca696de434f4535ffad3f7a71f';
testSubscription(url).catch(console.error);
