const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const db = require('./db');
const { getStreamUrl } = require('./utils/tiktok_spider');
const ffmpegManager = require('./utils/ffmpeg_manager');


class RecordingManager {
    constructor() {
        this.activeRecordings = new Map(); // roomId -> { process, filePath, startTime, request }
        this.checkInterval = null;
    }

    startMonitoring() {
        if (this.checkInterval) return;
        this.checkInterval = setInterval(() => this.checkRecordings(), 60000);
    }

    async startRecording(roomId, uniqueId, accountId) {
        // Validate inputs
        if (!roomId || roomId === 'undefined') {
            console.error(`[Recorder] Invalid roomId: ${roomId}`);
            return { success: false, error: 'Invalid roomId' };
        }
        if (!uniqueId || uniqueId === 'undefined') {
            console.error(`[Recorder] Invalid uniqueId: ${uniqueId}`);
            return { success: false, error: 'Invalid uniqueId' };
        }

        if (this.activeRecordings.has(roomId)) {
            console.log(`[Recorder] Room ${roomId} already recording.`);
            return { success: false, error: `Room ${roomId} already recording.` };
        }

        console.log(`[Recorder] Starting recording for ${roomId} (${uniqueId})...`);

        try {
            // Get Account & Proxy
            let proxyUrl = null;
            let cookie = null;

            if (accountId) {
                const account = await db.get('SELECT * FROM tiktok_account WHERE id = $1', [accountId]);
                if (account) {
                    cookie = account.cookie;
                    if (account.proxyId) {
                        const proxy = await db.get('SELECT * FROM socks5_proxy WHERE id = $1', [account.proxyId]);
                        if (proxy) {
                            proxyUrl = `socks5://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
                        }
                    }
                }
            }

            // Get Stream URL
            const streamUrl = await getStreamUrl(uniqueId, proxyUrl, cookie);
            if (!streamUrl) {
                throw new Error("Stream URL not found");
            }

            // Prepare Output Path - Use UTC+8 (Beijing time) for filename
            const now = new Date();
            now.setHours(now.getHours() + 8); // Add 8 hours for UTC+8
            const dateStr = now.toISOString().replace(/T/, '-').replace(/:/g, '-').split('.')[0];
            const fileName = `${uniqueId}_${dateStr}.mp4`;
            const outputDir = path.join(__dirname, 'downloads');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir);
            }
            const filePath = path.join(outputDir, fileName);

            // Prepare HTTPS Request Options
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.tiktok.com/'
            };

            console.log(`[Recorder] Stream URL obtained: ${streamUrl.substring(0, 80)}...`);

            const options = { headers, timeout: 20000 };
            if (proxyUrl) {
                console.log(`[Recorder] Using proxy for stream download`);
                options.agent = new SocksProxyAgent(proxyUrl, {
                    rejectUnauthorized: false,
                    timeout: 20000,
                    keepAlive: true
                });
            }

            // Start Request
            const req = https.get(streamUrl, options, (res) => {
                if (res.statusCode >= 400) {
                    console.error(`[Recorder] Stream fetch failed: ${res.statusCode}`);
                    db.run(`INSERT INTO recording_task (room_id, account_id, start_time, status, error_msg) VALUES ($1, $2, $3, $4, $5)`,
                        [roomId, accountId || null, new Date().toISOString(), 'failed', `HTTP ${res.statusCode}`]);
                    return;
                }

                // Spawn FFmpeg reading from stdin (FLV stream)
                // Use fragmented MP4 for reliable playback even if recording is interrupted
                const args = [
                    '-y',
                    '-v', 'error',
                    '-f', 'flv',        // Specify input format
                    '-i', '-',          // Read from pipe
                    '-c', 'copy',       // Copy streams without re-encoding
                    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Fragmented MP4
                    '-f', 'mp4',
                    filePath
                ];

                const ffmpegPath = ffmpegManager.getFFmpegPath();
                if (!ffmpegPath) {
                    console.error("FFmpeg not found");
                    db.run(`INSERT INTO recording_task (room_id, account_id, start_time, status, error_msg) VALUES ($1, $2, $3, $4, $5)`,
                        [roomId, accountId || null, new Date().toISOString(), 'failed', "FFmpeg not found"]);
                    return;
                }

                const ffmpeg = spawn(ffmpegPath, args);

                // Pipe stream
                res.pipe(ffmpeg.stdin);

                // Track process
                this.activeRecordings.set(roomId, {
                    process: ffmpeg,
                    filePath: filePath,
                    startTime: new Date(),
                    accountId: accountId,
                    request: req // Store request to abort if needed
                });

                // DB Update
                console.log(`[Recorder] Saving to DB: roomId="${roomId}", filePath="${filePath}"`);
                db.run(`INSERT INTO recording_task (room_id, account_id, start_time, status, file_path) VALUES ($1, $2, $3, $4, $5)`,
                    [roomId, accountId || null, new Date().toISOString(), 'recording', filePath]);

                console.log(`[Recorder] FFmpeg started for ${roomId}, PID: ${ffmpeg.pid}`);

                ffmpeg.stderr.on('data', (data) => {
                    console.error(`[FFmpeg] stderr: ${data}`);
                });

                ffmpeg.on('close', async (code) => {
                    console.log(`[Recorder] FFmpeg exited with code ${code}`);
                    this.activeRecordings.delete(roomId);
                    req.destroy(); // Ensure request is closed

                    const status = code === 0 || code === 255 ? 'completed' : 'failed';
                    await db.run(`UPDATE recording_task SET status = $1, end_time = $2 WHERE room_id = $3 AND status = 'recording'`,
                        [status, new Date().toISOString(), roomId]);
                });
            });

            req.on('error', (e) => {
                console.error(`[Recorder] Request error: ${e.message}`);
                // Don't create task record for connection failures
            });

        } catch (err) {
            console.error(`[Recorder] Failed to start: ${err.message}`);
            // Don't create task record for connection failures
            return { success: false, error: err.message };
        }

        return { success: true };
    }

    async stopRecording(roomId) {
        const recording = this.activeRecordings.get(roomId);
        if (recording) {
            console.log(`[Recorder] Stopping recording for ${roomId}...`);
            recording.process.kill('SIGINT');
            if (recording.request) {
                try { recording.request.destroy(); } catch (e) { }
            }
            return { success: true };
        }
        return { success: false, error: 'Recording not found' };
    }

    checkRecordings() {
        const now = Date.now();
        const STALL_THRESHOLD_MS = 60000; // 60 seconds with no file growth = stalled

        for (const [roomId, recording] of this.activeRecordings.entries()) {
            try {
                const stats = fs.statSync(recording.filePath);
                const currentSize = stats.size;

                // Initialize lastSize and lastSizeChange if not set
                if (!recording.lastSize) {
                    recording.lastSize = currentSize;
                    recording.lastSizeChange = now;
                } else if (currentSize > recording.lastSize) {
                    // File is growing, update tracking
                    recording.lastSize = currentSize;
                    recording.lastSizeChange = now;
                } else if (now - recording.lastSizeChange > STALL_THRESHOLD_MS) {
                    // File hasn't grown in 60+ seconds, recording is stalled
                    console.warn(`[Recorder] Recording for ${roomId} stalled (no growth in ${Math.round((now - recording.lastSizeChange) / 1000)}s). Auto-stopping.`);
                    this.stopRecording(roomId);
                }
            } catch (e) {
                // File may not exist yet or other issue
            }
        }
    }

    isRecording(roomId) {
        return this.activeRecordings.has(roomId);
    }
}

module.exports = new RecordingManager();
