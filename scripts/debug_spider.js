// Debug script to test TikTok page fetching
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs');
const db = require('../db');

async function debugFetch() {
    const uniqueId = 'e6ckfu7g39zt85k';
    const url = `https://www.tiktok.com/@${uniqueId}/live`;

    // Get proxy from database
    const proxy = await db.get('SELECT * FROM socks5_proxy LIMIT 1');
    let proxyUrl = null;
    if (proxy) {
        proxyUrl = `socks5://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
        console.log(`Using proxy: ${proxy.host}:${proxy.port}`);
    }

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.tiktok.com/',
        'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
    };

    const options = { headers, timeout: 30000 };
    if (proxyUrl) {
        options.agent = new SocksProxyAgent(proxyUrl, {
            rejectUnauthorized: false,
            timeout: 30000,
            keepAlive: true
        });
    }

    console.log(`Fetching: ${url}`);
    console.log('---');

    try {
        const response = await fetch(url, options);
        console.log(`Status: ${response.status} ${response.statusText}`);
        console.log(`Content-Type: ${response.headers.get('content-type')}`);

        const html = await response.text();
        console.log(`HTML Length: ${html.length} characters`);

        // Save to file for inspection
        fs.writeFileSync('debug_tiktok_page.html', html);
        console.log('Saved to debug_tiktok_page.html');

        // Check for key indicators
        console.log('\n--- Page Analysis ---');
        console.log(`Contains SIGI_STATE: ${html.includes('SIGI_STATE')}`);
        console.log(`Contains UNIVERSAL_DATA: ${html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__')}`);
        console.log(`Contains flv_pull_url: ${html.includes('flv_pull_url')}`);
        console.log(`Contains liveRoom: ${html.includes('liveRoom') || html.includes('LiveRoom')}`);
        console.log(`Contains status:4 (offline): ${html.includes('"status":4')}`);
        console.log(`Contains "We regret" (region block): ${html.includes('We regret')}`);

        // Try to extract stream info
        const sigiMatch = html.match(/<script id="SIGI_STATE" type="application\/json">(.*?)<\/script>/);
        if (sigiMatch) {
            console.log('\n--- SIGI_STATE Found ---');
            try {
                const data = JSON.parse(sigiMatch[1]);
                console.log(`Keys: ${Object.keys(data).join(', ')}`);
                if (data.LiveRoom) {
                    console.log(`LiveRoom keys: ${Object.keys(data.LiveRoom).join(', ')}`);
                    const lrui = data.LiveRoom?.liveRoomUserInfo;
                    if (lrui) {
                        console.log(`liveRoomUserInfo keys: ${Object.keys(lrui).join(', ')}`);
                        if (lrui.liveRoom) {
                            console.log(`liveRoom keys: ${Object.keys(lrui.liveRoom).join(', ')}`);
                        }
                    }
                }
            } catch (e) {
                console.log(`Parse error: ${e.message}`);
            }
        }

        const universalMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/);
        if (universalMatch) {
            console.log('\n--- UNIVERSAL_DATA Found ---');
            try {
                const data = JSON.parse(universalMatch[1]);
                console.log(`Top keys: ${Object.keys(data).join(', ')}`);
                if (data['__DEFAULT_SCOPE__']) {
                    console.log(`DEFAULT_SCOPE keys: ${Object.keys(data['__DEFAULT_SCOPE__']).join(', ')}`);
                }
            } catch (e) {
                console.log(`Parse error: ${e.message}`);
            }
        }

    } catch (err) {
        console.error('Fetch Error:', err.message);
    }

    process.exit(0);
}

debugFetch();
