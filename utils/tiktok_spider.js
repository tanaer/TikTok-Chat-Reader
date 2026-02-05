const { spawn } = require('child_process');
const { SocksProxyAgent } = require('socks-proxy-agent'); // Kept for compatibility if used elsewhere, but not used here anymore

/**
 * Get TikTok Stream URL
 * @param {string} uniqueId - The uniqueId of the user (e.g. 'username')
 * @param {string} [proxyUrl] - Optional SOCKS5 proxy URL (e.g. 'socks5://user:pass@host:port')
 * @param {string} [cookie] - Optional cookie string
 */
async function getStreamUrl(uniqueId, proxyUrl = null, cookie = null) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000; // 2 seconds

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await _fetchStreamUrl(uniqueId, proxyUrl, cookie);
            return result;
        } catch (err) {
            console.error(`[Spider] Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                console.log(`[Spider] Retrying in ${RETRY_DELAY / 1000}s...`);
                await new Promise(r => setTimeout(r, RETRY_DELAY));
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

        console.log(`[Spider] Fetching ${url} with proxy ${proxyUrl ? 'YES' : 'NO'} via Curl`);

        // Use Curl to fetch HTML (bypasses Node.js TLS issues)
        const html = await new Promise((resolve, reject) => {
            const curlArgs = [
                '-4', // FORCE IPv4
                '-s',
                '-L',
                '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                '-H', 'Referer: https://www.tiktok.com/',
                '-H', 'Cache-Control: max-age=0'
            ];

            if (cookie) {
                curlArgs.push('--cookie', cookie);
            }

            if (proxyUrl) {
                // Force remote DNS resolution
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
            throw new Error(`Page too small (${html.length} chars), likely blocked or anti-bot page`);
        }

        // Check for "Region blocked"
        if (html.includes("We regret to inform you that we have discontinued operating TikTok")) {
            throw new Error("Region blocked");
        }

        // Debug: Check page content indicators
        console.log(`[Spider] Page analysis: SIGI_STATE=${html.includes('SIGI_STATE')}, liveRoom=${html.includes('liveRoom')}`);

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
