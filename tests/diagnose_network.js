const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const url = require('url');
require('dotenv').config();

// Define the Smart Agent exactly as in connectionWrapper.js
// BUT adding httpbin for test purpose
class SmartSocksProxyAgent extends SocksProxyAgent {
    addRequest(req, options) {
        const host = options.host || options.hostname;
        if (host && (host.includes('eulerstream') || host.includes('httpbin'))) {
            // console.log(`[SmartAgent] 🔥 Bypassing proxy for ${host}`);
            return https.globalAgent.addRequest(req, options);
        }
        return super.addRequest(req, options);
    }
}

const proxyUrl = process.env.PROXY_URL || 'socks5://127.0.0.1:7891';
const smartAgent = new SmartSocksProxyAgent(proxyUrl);
const normalAgent = new SocksProxyAgent(proxyUrl);

function doRequest(requestUrl, agent) {
    return new Promise((resolve, reject) => {
        const parsedUrl = url.parse(requestUrl);
        const options = {
            ...parsedUrl,
            agent: agent,
            timeout: 5000,
            headers: {
                // Add key for Euler test if needed, though mostly checking status
            }
        };

        // Add Header for Euler
        if (requestUrl.includes('eulerstream')) {
            const key = (process.env.EULER_KEYS || '').split(',')[0].trim();
            options.headers = { 'x-access-key': key };
        }

        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({ status: res.statusCode, data: data });
            });
        });

        req.on('error', (e) => resolve({ error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    });
}

async function checkIP(agent, name) {
    console.log(`\n--- Testing ${name} ---`);
    const res = await doRequest('https://httpbin.org/ip', agent);
    if (res.error) {
        console.log(`${name} Error:`, res.error);
        return null;
    }
    try {
        const json = JSON.parse(res.data);
        console.log(`${name} IP:`, json.origin);
        return json.origin;
    } catch (e) {
        console.log(`${name} Invalid JSON response.`);
        return null;
    }
}

async function checkEuler(agent, name) {
    const key = (process.env.EULER_KEYS || '').split(',')[0].trim();
    if (!key) {
        console.log("No key to test Euler.");
        return;
    }

    console.log(`\n--- Testing Euler Connection (${name}) ---`);
    // Invalid params but checks connectivity to API
    const reqUrl = `https://tiktok.eulerstream.com/v1/sign/webcast/fetch?client=ttlive-node&roomId=12345`;

    const res = await doRequest(reqUrl, agent);
    if (res.error) {
        console.log(`❌ Error: ${res.error}`);
        return;
    }

    console.log(`Status: ${res.status}`);
    if (res.status === 429) {
        console.log("❌ Result: 429 Rate Limited (Blocked)");
    } else if (res.status === 200) {
        console.log("✅ Result: 200 OK (Sign Successful)");
    } else {
        console.log(`✅ Result: ${res.status} (Connected)`);
        // console.log("Response:", res.data.slice(0, 100));
    }
}

(async () => {
    console.log(`Proxy Config: ${proxyUrl}`);

    // 1. Check Local IP (No Agent - Direct)
    const localIP = await checkIP(undefined, "Direct (Local)");

    // 2. Check Proxy IP (Normal Agent)
    const proxyIP = await checkIP(normalAgent, "Proxy (Normal)");

    // 3. Check Smart Agent IP (Should align with Local)
    const smartIP = await checkIP(smartAgent, "Smart Agent (Bypass)");

    console.log('\n--- Analysis ---');
    if (smartIP && localIP && smartIP === localIP) {
        console.log("✅ SmartAgent Bypass Logic: WORKING (Uses Local IP)");
    } else if (smartIP && proxyIP && smartIP === proxyIP) {
        console.log("❌ SmartAgent Bypass Logic: FAILED (Still uses Proxy IP)");
        console.log("   -> Check if 'https.globalAgent.addRequest' is supported or intercept logic.");
    } else {
        console.log("❓ SmartAgent Result Unclear or Error.");
    }

    // 4. Real Euler Test
    // await checkEuler(undefined, "Direct"); 
    await checkEuler(normalAgent, "Proxy");
    await checkEuler(smartAgent, "SmartProxy");

})();
