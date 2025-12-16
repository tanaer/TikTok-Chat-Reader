const https = require('https');
const dns = require('dns');
const { SocksProxyAgent } = require('socks-proxy-agent');
const url = require('url');
require('dotenv').config();

const EULER_HOST = 'tiktok.eulerstream.com';
// Force remote DNS using socks5h
const PROXY_URL = (process.env.PROXY_URL || 'socks5://127.0.0.1:7891').replace('socks5://', 'socks5h://');

console.log('=== Network Diagnostic Tool ===');
console.log(`Target: ${EULER_HOST}`);
console.log(`Proxy:  ${PROXY_URL}`);

function makeRequest(label, agent) {
    return new Promise((resolve) => {
        console.log(`\n[${label}] Connecting...`);
        const reqOptions = {
            hostname: EULER_HOST,
            path: '/webcast/rate_limits', // Dummy request
            method: 'GET',
            timeout: 10000,
            agent: agent
        };

        const req = https.request(reqOptions, (res) => {
            console.log(`[${label}] Response: ${res.statusCode} ${res.statusMessage}`);
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                // console.log(`[${label}] Body: ${data.slice(0, 50)}...`);
                resolve({ status: res.statusCode, body: data });
            });
        });

        req.on('error', (e) => {
            console.error(`[${label}] Error: ${e.message}`);
            resolve({ error: e.message });
        });

        req.on('timeout', () => {
            req.destroy();
            console.error(`[${label}] Timeout`);
            resolve({ error: 'Timeout' });
        });

        req.end();
    });
}

(async () => {
    // 1. DNS Check
    console.log('\n--- 1. DNS Resolution ---');
    try {
        const addresses = await dns.promises.resolve4(EULER_HOST);
        console.log(`DNS Resolved ${EULER_HOST} -> ${addresses}`);
    } catch (e) {
        console.error(`DNS Failed: ${e.message}`);
        console.log("NOTE: If DNS fails, Direct Connection is impossible unless fixed (e.g. modify hosts).");
    }

    // 2. Direct Connection Check
    // console.log('\n--- 2. Direct Connection (No Proxy) ---');
    // const directResult = await makeRequest('DIRECT', undefined);

    // 3. Proxy Connection Check
    console.log('\n--- 3. Proxy Connection ---');
    // Note: socks-proxy-agent defaults to resolveProxy=false (Local DNS) usually?
    // We try to force remote via socks5h logic or just rely on agent.
    let proxyAgent;
    try {
        proxyAgent = new SocksProxyAgent(PROXY_URL);
    } catch (e) {
        console.error(`Failed to create proxy agent: ${e.message}`);
    }

    // <NEW> Check IP via Proxy
    if (proxyAgent) {
        console.log('[IP Check] Fetching IP via Proxy...');
        const ipReq = new Promise((resolve) => {
            const req = https.get('https://api.myip.com', { agent: proxyAgent, timeout: 10000 }, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => resolve(data));
            });
            req.on('error', (e) => resolve(`Error: ${e.message}`));
            req.on('timeout', () => resolve('Timeout'));
        });
        const ipData = await ipReq;
        console.log(`[IP Check] Result: ${ipData}`);
    }

    let proxyResult;
    if (proxyAgent) {
        proxyResult = await makeRequest('PROXY', proxyAgent);
    }

    console.log('\n=== Summary ===');
    if (proxyResult && (proxyResult.status === 200 || proxyResult.status === 400 || proxyResult.status === 401)) {
        console.log("✅ Proxy Connection: SUCCESS (Workable)");
    } else if (proxyResult && proxyResult.status === 429) {
        console.log("❌ Proxy Connection: FAILED (Rate Limited - 429)");
    } else {
        console.log(`❌ Proxy Connection: FAILED (${proxyResult?.error || proxyResult?.status})`);
    }

    console.log('=======================');

})();
