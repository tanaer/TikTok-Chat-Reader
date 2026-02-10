const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Rotate User-Agents to avoid fingerprinting on a single one
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Get TikTok Stream URL
 * @param {string} uniqueId - The uniqueId of the user (e.g. 'username')
 * @param {string} [proxyUrl] - Optional SOCKS5 proxy URL (e.g. 'socks5://user:pass@host:port')
 * @param {string} [cookie] - Optional cookie string
 */
async function getStreamUrl(uniqueId, proxyUrl = null, cookie = null) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_BASE = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await _fetchStreamUrl(uniqueId, proxyUrl, cookie);
            return result;
        } catch (err) {
            console.error(`[Spider] Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                // Randomized retry delay to avoid pattern detection
                const delay = RETRY_DELAY_BASE + Math.random() * 2000;
                console.log(`[Spider] Retrying in ${(delay / 1000).toFixed(1)}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
}

async function _fetchStreamUrl(uniqueId, proxyUrl = null, cookie = null) {
    try {
        // Handle @ prefix
        if (uniqueId.startsWith('@')) {
            uniqueId = uniqueId.substring(1);
        }

        const url = `https://www.tiktok.com/@${uniqueId}/live`;
        const ua = getRandomUA();

        console.log(`[Spider] Fetching ${url} with proxy ${proxyUrl ? 'YES' : 'NO'} via Curl`);

        // Use Curl to fetch HTML with FULL browser-like headers
        const html = await new Promise((resolve, reject) => {
            const curlArgs = [
                '-4',                   // Force IPv4
                '-s',                   // Silent mode
                '-S',                   // Show errors
                '-L',                   // Follow redirects
                '--connect-timeout', '15',
                '--max-time', '30',
                // --- TLS Configuration (mimic Chrome's TLS fingerprint) ---
                '--tlsv1.2',            // Minimum TLS 1.2
                '--tls13-ciphers', 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
                '--ciphers', 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305',
                '--http2',              // Use HTTP/2 like Chrome
                // --- Full Chrome Browser Headers ---
                '-H', `User-Agent: ${ua}`,
                '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                '-H', 'Accept-Language: en-US,en;q=0.9',
                '-H', 'Accept-Encoding: gzip, deflate, br',
                '--compressed',         // Handle compressed responses
                '-H', 'Cache-Control: no-cache',
                '-H', 'Pragma: no-cache',
                '-H', 'DNT: 1',
                '-H', 'Referer: https://www.tiktok.com/',
                '-H', 'sec-ch-ua: "Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                '-H', 'sec-ch-ua-mobile: ?0',
                '-H', 'sec-ch-ua-platform: "Windows"',
                '-H', 'sec-fetch-dest: document',
                '-H', 'sec-fetch-mode: navigate',
                '-H', 'sec-fetch-site: same-origin',
                '-H', 'sec-fetch-user: ?1',
                '-H', 'upgrade-insecure-requests: 1',
                '-H', 'Connection: keep-alive',
            ];

            // Add cookie if provided (critical for anti-bot bypass)
            if (cookie) {
                curlArgs.push('--cookie', cookie);
            }

            if (proxyUrl) {
                // Force remote DNS resolution via socks5h
                const curlProxy = proxyUrl.replace('socks5://', 'socks5h://');
                curlArgs.push('-x', curlProxy);
            }

            curlArgs.push(url);

            const curl = spawn('curl', curlArgs);
            let stdoutChunks = [];
            let stderrChunks = [];

            curl.stdout.on('data', chunk => stdoutChunks.push(chunk));
            curl.stderr.on('data', chunk => stderrChunks.push(chunk));

            curl.on('close', (code) => {
                if (code !== 0) {
                    const errorMsg = Buffer.concat(stderrChunks).toString('utf8');
                    reject(new Error(`Curl exited with code ${code}: ${errorMsg}`));
                } else {
                    const body = Buffer.concat(stdoutChunks).toString('utf8');
                    resolve(body);
                }
            });

            curl.on('error', (err) => {
                reject(err);
            });
        });


        console.log(`[Spider] Page fetched, HTML length: ${html.length}`);

        // Check if page is too small (likely anti-bot page or error)
        if (html.length < 10000) {
            // Save blocked page for debugging
            try {
                const debugDir = path.join(__dirname, '..', 'logs');
                if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
                const debugFile = path.join(debugDir, `blocked_page_${Date.now()}.html`);
                fs.writeFileSync(debugFile, html);
                console.warn(`[Spider] Blocked page saved to ${debugFile}`);
            } catch (e) { /* ignore */ }

            // Before throwing, try the API fallback
            console.log(`[Spider] Page too small (${html.length} chars), trying API fallback...`);
            const apiUrl = await _tryApiEndpoint(uniqueId, proxyUrl, cookie);
            if (apiUrl) {
                return apiUrl;
            }

            throw new Error(`Page too small (${html.length} chars), likely blocked or anti-bot page. Try adding a TikTok cookie in System Settings.`);
        }

        // Check for "Region blocked"
        if (html.includes("We regret to inform you that we have discontinued operating TikTok")) {
            throw new Error("Region blocked");
        }

        // Debug: Check page content indicators
        console.log(`[Spider] Page analysis: SIGI_STATE=${html.includes('SIGI_STATE')}, UNIVERSAL_DATA=${html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__')}, liveRoom=${html.includes('liveRoom')}`);

        // Check if user is not live - be more specific
        if (html.includes('"status":4') && html.includes('"liveRoomStatus"')) {
            console.log('[Spider] Detected status:4 (offline)');
            throw new Error("User is not currently live");
        }

        // 1. Try SIGI_STATE
        const sigiStateMatch = html.match(/<script id="SIGI_STATE" type="application\/json">(.*?)<\/script>/);
        if (sigiStateMatch) {
            try {
                const sigiData = JSON.parse(sigiStateMatch[1]);
                console.log(`[Spider] Found SIGI_STATE, LiveRoom exists: ${!!sigiData.LiveRoom}`);
                const streamUrl = extractFromSigiState(sigiData);
                if (streamUrl) {
                    console.log(`[Spider] Stream URL found via SIGI_STATE`);
                    return streamUrl;
                }
            } catch (e) {
                console.warn("[Spider] Failed to parse SIGI_STATE", e.message);
            }
        }

        // 2. Try __UNIVERSAL_DATA_FOR_REHYDRATION__
        const universalDataMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/);
        if (universalDataMatch) {
            try {
                const universalData = JSON.parse(universalDataMatch[1]);
                console.log(`[Spider] Found UNIVERSAL_DATA`);
                // Try to find stream URL in __DEFAULT_SCOPE__
                const liveRoom = universalData?.['__DEFAULT_SCOPE__']?.['webapp.live-room'];
                if (liveRoom?.streamData?.pull_data?.stream_data) {
                    const streamData = JSON.parse(liveRoom.streamData.pull_data.stream_data);
                    const url = extractUrlFromStreamData(streamData);
                    if (url) {
                        console.log(`[Spider] Stream URL found via UNIVERSAL_DATA`);
                        return url;
                    }
                }
            } catch (e) {
                console.warn("[Spider] Failed to parse UNIVERSAL_DATA", e.message);
            }
        }

        // 3. Regex Fallback for "flv_pull_url" or "hls_pull_url" inside JSON string
        const flvMatch = html.match(/\\?"flv_pull_url\\?":\s*({[^}]+})/);
        if (flvMatch) {
            try {
                let jsonStr = flvMatch[1].replace(/\\"/g, '"');
                const flvData = JSON.parse(jsonStr);
                const urls = Object.values(flvData);
                if (urls.length > 0) {
                    console.log(`[Spider] Stream URL found via flv_pull_url regex`);
                    return urls[0];
                }
            } catch (e) {
                console.warn("[Spider] Failed to parse flv_pull_url regex match", e.message);
            }
        }

        // 4. Try direct URL match (for .flv or .m3u8)
        const directUrlMatch = html.match(/(https:\/\/[^"'\s]+\.(?:flv|m3u8)[^"'\s]*)/);
        if (directUrlMatch) {
            console.log(`[Spider] Stream URL found via direct regex`);
            return directUrlMatch[1].replace(/\\\//g, '/');
        }

        throw new Error("Could not find stream URL in page (user may be offline)");

    } catch (err) {
        console.error(`[Spider] ${uniqueId} Error: ${err.message}`);
        throw err;
    }
}

/**
 * Fallback: Try TikTok's webcast room info API
 * This endpoint is less aggressively protected than the live page
 */
async function _tryApiEndpoint(uniqueId, proxyUrl = null, cookie = null) {
    try {
        // First we need to get the room_id from a lightweight request
        // Try the TikTok API endpoint for room info
        console.log(`[Spider] Trying TikTok API fallback for ${uniqueId}...`);

        const ua = getRandomUA();

        // Step 1: Try to get room_id via API
        const apiUrl = `https://www.tiktok.com/api/live/detail/?aid=1988&uniqueId=${uniqueId}`;

        const apiHtml = await new Promise((resolve, reject) => {
            const curlArgs = [
                '-4', '-s', '-S', '-L',
                '--connect-timeout', '15',
                '--max-time', '20',
                '--compressed',
                '-H', `User-Agent: ${ua}`,
                '-H', 'Accept: application/json, text/plain, */*',
                '-H', 'Accept-Language: en-US,en;q=0.9',
                '-H', 'Referer: https://www.tiktok.com/',
                '-H', 'sec-ch-ua: "Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                '-H', 'sec-ch-ua-mobile: ?0',
                '-H', 'sec-ch-ua-platform: "Windows"',
                '-H', 'sec-fetch-dest: empty',
                '-H', 'sec-fetch-mode: cors',
                '-H', 'sec-fetch-site: same-origin',
            ];

            if (cookie) {
                curlArgs.push('--cookie', cookie);
            }

            if (proxyUrl) {
                const curlProxy = proxyUrl.replace('socks5://', 'socks5h://');
                curlArgs.push('-x', curlProxy);
            }

            curlArgs.push(apiUrl);

            const curl = spawn('curl', curlArgs);
            let stdoutChunks = [];
            let stderrChunks = [];

            curl.stdout.on('data', chunk => stdoutChunks.push(chunk));
            curl.stderr.on('data', chunk => stderrChunks.push(chunk));

            curl.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`API curl exited with code ${code}`));
                } else {
                    resolve(Buffer.concat(stdoutChunks).toString('utf8'));
                }
            });

            curl.on('error', reject);
        });

        try {
            const apiData = JSON.parse(apiHtml);
            console.log(`[Spider] API response status: ${apiData?.statusCode || apiData?.status_code || 'unknown'}`);

            // Extract LiveRoomInfo
            const liveRoomInfo = apiData?.LiveRoomInfo || apiData?.data;
            if (liveRoomInfo) {
                // Try to extract stream data
                const streamDataRaw = liveRoomInfo?.liveRoom?.streamData?.pull_data?.stream_data
                    || liveRoomInfo?.streamData?.pull_data?.stream_data;

                if (streamDataRaw) {
                    const streamData = JSON.parse(streamDataRaw);
                    const url = extractUrlFromStreamData(streamData);
                    if (url) {
                        console.log(`[Spider] ✅ Stream URL found via API fallback!`);
                        return url;
                    }
                }

                // Try direct stream URL fields
                const streamUrl = liveRoomInfo?.liveUrl || liveRoomInfo?.streamUrl;
                if (streamUrl) {
                    console.log(`[Spider] ✅ Stream URL found via API liveUrl field!`);
                    return streamUrl;
                }
            }

            console.log(`[Spider] API fallback: no stream data found in response`);
        } catch (e) {
            console.warn(`[Spider] API fallback parse error: ${e.message}`);
        }

    } catch (err) {
        console.warn(`[Spider] API fallback failed: ${err.message}`);
    }

    return null;
}

function extractFromSigiState(sigiData) {
    try {
        const liveRoomUserInfo = sigiData.LiveRoom?.liveRoomUserInfo;
        if (!liveRoomUserInfo) return null;

        const streamDataRaw = liveRoomUserInfo.liveRoom?.streamData?.pull_data?.stream_data;
        if (streamDataRaw) {
            const streamData = JSON.parse(streamDataRaw);
            return extractUrlFromStreamData(streamData);
        }
    } catch (e) {
        console.warn("[Spider] Error exploring SIGI_STATE", e.message);
    }
    return null;
}

function extractUrlFromStreamData(streamDataJson) {
    const data = streamDataJson.data;
    if (!data) {
        console.log('[Spider] streamData.data is empty');
        return null;
    }

    console.log(`[Spider] Stream quality keys available: ${Object.keys(data).join(', ')}`);

    // Prefer higher quality in this order
    const qualityPreference = ['origin', 'uhd_60', 'hd_60', 'hd', 'sd', 'ld'];

    for (const quality of qualityPreference) {
        if (data[quality]?.main?.flv) {
            console.log(`[Spider] Using quality: ${quality}`);
            return data[quality].main.flv;
        }
    }

    // Fallback: try any available quality
    for (const key of Object.keys(data)) {
        const value = data[key];
        if (value?.main?.flv) {
            console.log(`[Spider] Using fallback quality: ${key}`);
            return value.main.flv;
        }
    }

    console.log('[Spider] No FLV URL found in any quality');
    return null;
}

module.exports = { getStreamUrl };
