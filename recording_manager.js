const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const db = require('./db');
const { getStreamUrl } = require('./utils/tiktok_spider');
const ffmpegManager = require('./utils/ffmpeg_manager');


// Helper for Beijing Time
function getBeijingTime() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const date = new Date(utc + (3600000 * 8));
    const pad = n => n < 10 ? '0' + n : n;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

class RecordingManager {
    constructor() {
        this.activeRecordings = new Map(); // roomId -> { process, filePath, startTime, request }
        this.checkInterval = null;
        this.MAX_RECONNECT_ATTEMPTS = 5;       // Max auto-reconnect attempts per recording
        this.RECONNECT_DELAY_MS = 10000;        // Wait 10s before reconnecting
        this.STALL_THRESHOLD_MS = 180000;       // 3 minutes no file growth = stalled (was 60s)
        console.log('[Recorder] Initialized (Timezone: Asia/Shanghai)');
    }

    startMonitoring() {
        if (this.checkInterval) return;

        // Cleanup invalid tasks from previous bugs
        db.run("DELETE FROM recording_task WHERE room_id = 'undefined' OR room_id IS NULL")
            .then(() => console.log('[Recorder] Cleaned up invalid recording tasks'))
            .catch(e => console.error('[Recorder] Cleanup failed:', e.message));

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
            return { success: false, error: 'Already recording' };
        }

        console.log(`[Recorder] Starting recording for ${uniqueId} (${roomId})...`);

        try {
            // Get Stream URL via Spider (Curl-based)
            const settings = await db.getSystemSettings();
            const proxyUrl = settings.proxyEnabled ? settings.proxyUrl : null;
            // TODO: Retrieve cookie from settings if needed
            const cookie = null;

            const streamUrl = await getStreamUrl(uniqueId, proxyUrl, cookie);

            if (!streamUrl) {
                console.error(`[Recorder] Failed to get stream URL for ${uniqueId}`);
                await db.run(`INSERT INTO recording_task (room_id, account_id, start_time, status, error_msg) VALUES ($1, $2, $3, $4, $5)`,
                    [roomId, accountId || null, getBeijingTime(), 'failed', 'Stream URL not found']);
                return { success: false, error: 'Stream URL not found' };
            }

            // Prepare Output
            const outputDir = path.join(__dirname, 'downloads');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `${uniqueId}_${timestamp}.mp4`;
            const filePath = path.join(outputDir, fileName);

            console.log(`[Recorder] Stream URL obtained: ${streamUrl}`);

            // --- Start the curl -> ffmpeg pipeline ---
            const result = this._spawnRecordingPipeline(roomId, uniqueId, accountId, streamUrl, filePath, proxyUrl, cookie);

            if (!result.success) {
                return result;
            }

            // DB Update
            console.log(`[Recorder] Saving to DB: roomId="${roomId}", filePath="${filePath}"`);
            db.run(`INSERT INTO recording_task (room_id, account_id, start_time, status, file_path) VALUES ($1, $2, $3, $4, $5)`,
                [roomId, accountId || null, getBeijingTime(), 'recording', filePath]);

            return { success: true };

        } catch (err) {
            console.error(`[Recorder] Failed to start: ${err.message}`);

            let errorMsg = err.message;
            if (errorMsg.includes('code 35') || errorMsg.includes('SSL') || errorMsg.includes('Connection refused')) {
                const settings = await db.getSystemSettings();
                if (!settings.proxyEnabled) {
                    errorMsg += "\n[Hint] Proxy is disabled. Please enable Proxy in System Config if you are in a blocked region.";
                } else {
                    errorMsg += "\n[Hint] SSL/Proxy Error. Check your proxy connectivity.";
                }
            }

            return { success: false, error: errorMsg };
        }
    }

    /**
     * Spawn the curl -> ffmpeg pipeline for recording.
     * Extracted so it can be re-used for auto-reconnect.
     */
    _spawnRecordingPipeline(roomId, uniqueId, accountId, streamUrl, filePath, proxyUrl, cookie) {
        // Use curl to download stream (bypasses Node.js TLS fingerprinting/IPv6 issues)
        const curlArgs = [
            '-4',                   // FORCE IPv4 to avoid proxy IPv6 issues
            '-s',                   // Silent mode
            '-S',                   // Show errors even in silent mode
            '-L',                   // Follow redirects
            '--tcp-keepalive',      // Enable TCP keep-alive
            '--keepalive-time', '30', // Send keep-alive probe every 30s
            '--connect-timeout', '30', // Connection timeout: 30s
            '--max-time', '0',      // No overall time limit (stream indefinitely)
            '--speed-limit', '1',   // Minimum bytes/sec (detect stalled connections)
            '--speed-time', '120',  // Allow 120s below speed-limit before aborting
            '--retry', '3',         // Retry up to 3 times on transient errors
            '--retry-delay', '5',   // Wait 5s between retries
            '--retry-connrefused',  // Retry on connection refused
            '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            '-H', `Referer: https://www.tiktok.com/@${uniqueId}/live`,
            '-H', 'Connection: keep-alive'
        ];

        if (cookie) {
            curlArgs.push('--cookie', cookie);
        }

        if (proxyUrl) {
            console.log(`[Recorder] Using proxy for stream download: ${proxyUrl}`);
            // Use socks5h to force remote DNS resolution
            const curlProxy = proxyUrl.replace('socks5://', 'socks5h://');
            curlArgs.push('-x', curlProxy);
        }

        curlArgs.push(streamUrl);

        // Spawn Curl
        const curlProcess = spawn('curl', curlArgs);

        // Handle Curl Errors (initial startup)
        curlProcess.on('error', (err) => {
            console.error(`[Recorder] Curl failed to start: ${err.message}`);
            db.run(`INSERT INTO recording_task (room_id, account_id, start_time, status, error_msg) VALUES ($1, $2, $3, $4, $5)`,
                [roomId, accountId || null, getBeijingTime(), 'failed', `Curl Error: ${err.message}`]);
        });

        // Log curl stderr for debugging
        curlProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                console.log(`[Curl:${roomId}] ${msg}`);
            }
        });

        // Track curl exit for debugging
        curlProcess.on('close', (code) => {
            if (code !== 0 && code !== null) {
                const curlErrors = {
                    7: 'Connection refused',
                    18: 'Partial transfer (server closed connection)',
                    28: 'Timeout (--connect-timeout or --speed-time exceeded)',
                    35: 'SSL/TLS handshake failed',
                    52: 'Server returned empty response',
                    56: 'Network recv error (connection reset)',
                };
                const reason = curlErrors[code] || 'Unknown error';
                console.warn(`[Recorder] Curl for ${roomId} exited with code ${code}: ${reason}`);
            }
        });

        // Prepare FFmpeg
        const ffmpegArgs = [
            '-y',
            '-v', 'warning',       // Show warnings too (was 'error' - helps debug)
            '-f', 'flv',           // Specify input format (FLV stream from curl)
            '-i', '-',             // Read from pipe
            '-c', 'copy',          // Copy streams without re-encoding
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Fragmented MP4
            '-f', 'mp4',
            filePath
        ];

        const ffmpegPath = ffmpegManager.getFFmpegPath();
        if (!ffmpegPath) {
            console.error("FFmpeg not found");
            curlProcess.kill();
            return { success: false, error: 'FFmpeg not found' };
        }

        const ffmpeg = spawn(ffmpegPath, ffmpegArgs);

        // Pipe Curl -> FFmpeg
        curlProcess.stdout.pipe(ffmpeg.stdin);

        // Handle pipe errors (prevent crash on broken pipe)
        curlProcess.stdout.on('error', (err) => {
            console.warn(`[Recorder] Curl stdout error for ${roomId}: ${err.message}`);
        });
        ffmpeg.stdin.on('error', (err) => {
            console.warn(`[Recorder] FFmpeg stdin error for ${roomId}: ${err.message}`);
        });

        // Track process
        this.activeRecordings.set(roomId, {
            process: ffmpeg,
            curlProcess: curlProcess,
            filePath: filePath,
            startTime: new Date(),
            accountId: accountId,
            uniqueId: uniqueId,
            streamUrl: streamUrl,
            proxyUrl: proxyUrl,
            cookie: cookie,
            reconnectAttempts: 0,
            lastSize: 0,
            lastSizeChange: Date.now()
        });

        console.log(`[Recorder] FFmpeg started for ${roomId}, PID: ${ffmpeg.pid}`);

        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                console.log(`[FFmpeg:${roomId}] ${msg}`);
            }
        });

        // Wait for FFmpeg exit (which happens when curl stops stream or error)
        ffmpeg.on('close', async (code) => {
            console.log(`[Recorder] FFmpeg exited for ${roomId} with code ${code}`);

            // Retrieve recording state before deleting
            const recordingState = this.activeRecordings.get(roomId);

            if (!recordingState) {
                return; // Already cleaned up
            }

            // If manual stop, don't reconnect
            if (recordingState.manualStop) {
                this.activeRecordings.delete(roomId);
                const endTime = getBeijingTime();
                await db.run(`UPDATE recording_task SET status = $1, end_time = $2 WHERE room_id = $3 AND status = 'recording'`,
                    ['completed', endTime, roomId]);

                // Process Highlights if completed
                this.checkAndClipHighlights(roomId, recordingState.startTime, new Date(), filePath).catch(e =>
                    console.error(`[Recorder] Highlight processing failed: ${e.message}`)
                );
                return;
            }

            // --- AUTO-RECONNECT LOGIC ---
            // If ffmpeg exited unexpectedly and we haven't exhausted reconnect attempts, try again
            const attempts = recordingState.reconnectAttempts || 0;

            if (attempts < this.MAX_RECONNECT_ATTEMPTS) {
                console.log(`[Recorder] ⚡ Auto-reconnect for ${roomId} (attempt ${attempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})...`);

                // Kill old curl just in case
                try { curlProcess.kill(); } catch (e) { }

                // Remove from active recordings before reconnecting
                this.activeRecordings.delete(roomId);

                // Wait before reconnecting
                await new Promise(resolve => setTimeout(resolve, this.RECONNECT_DELAY_MS));

                // Try to get a fresh stream URL
                try {
                    const settings = await db.getSystemSettings();
                    const newProxyUrl = settings.proxyEnabled ? settings.proxyUrl : null;
                    const newStreamUrl = await getStreamUrl(recordingState.uniqueId, newProxyUrl, recordingState.cookie);

                    if (newStreamUrl) {
                        // Use a new filename for the reconnected segment
                        const newTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const newFileName = `${recordingState.uniqueId}_${newTimestamp}_r${attempts + 1}.mp4`;
                        const newFilePath = path.join(path.dirname(filePath), newFileName);

                        console.log(`[Recorder] ✅ Got new stream URL, reconnecting ${roomId} -> ${newFileName}`);

                        const result = this._spawnRecordingPipeline(
                            roomId, recordingState.uniqueId, recordingState.accountId,
                            newStreamUrl, newFilePath, newProxyUrl, recordingState.cookie
                        );

                        if (result.success) {
                            // Update reconnect counter
                            const newRecording = this.activeRecordings.get(roomId);
                            if (newRecording) {
                                newRecording.reconnectAttempts = attempts + 1;
                                newRecording.startTime = recordingState.startTime; // Keep original start time
                            }

                            // Update DB
                            await db.run(`UPDATE recording_task SET file_path = $1 WHERE room_id = $2 AND status = 'recording'`,
                                [newFilePath, roomId]);

                            return; // Successfully reconnected
                        }
                    } else {
                        console.warn(`[Recorder] ❌ No stream URL for ${roomId} - streamer may have gone offline`);
                    }
                } catch (reconnectErr) {
                    console.error(`[Recorder] ❌ Reconnect failed for ${roomId}: ${reconnectErr.message}`);
                }
            } else {
                console.warn(`[Recorder] ❌ Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached for ${roomId}`);
            }

            // --- FINAL CLEANUP (no more reconnect) ---
            this.activeRecordings.delete(roomId);

            // Ensure curl is killed
            try { curlProcess.kill(); } catch (e) { }

            // Determine Status: Success if code 0, 255 (kill)
            const isSuccess = (code === 0 || code === 255);
            const status = isSuccess ? 'completed' : 'failed';
            const endTime = getBeijingTime();

            await db.run(`UPDATE recording_task SET status = $1, end_time = $2 WHERE room_id = $3 AND status = 'recording'`,
                [status, endTime, roomId]);

            // Process Highlights if completed
            if (isSuccess && recordingState) {
                this.checkAndClipHighlights(roomId, recordingState.startTime, new Date(), filePath).catch(e =>
                    console.error(`[Recorder] Highlight processing failed: ${e.message}`)
                );
            }
        });

        return { success: true };
    }

    async stopRecording(roomId) {
        const recording = this.activeRecordings.get(roomId);
        if (recording) {
            console.log(`[Recorder] Stopping recording for ${roomId}...`);

            // Mark as manual stop to ensure "completed" status and prevent reconnect
            recording.manualStop = true;

            // Kill FFmpeg
            try { recording.process.kill('SIGINT'); } catch (e) { }

            // Kill Curl
            if (recording.curlProcess) {
                try { recording.curlProcess.kill(); } catch (e) { }
            }
            if (recording.request) {
                try { recording.request.destroy(); } catch (e) { } // Legacy
            }

            return { success: true };
        }
        return { success: false, error: 'Recording not found' };
    }

    async checkAndClipHighlights(roomId, startTime, endTime, filePath) {
        console.log(`[Highlights] Checking for gifts in ${roomId} between ${startTime.toISOString()} and ${endTime.toISOString()}`);

        // 1. Get High Value Gifts
        // Threshold: default 100 or from settings
        const settings = await db.getSystemSettings();
        const minPrice = settings.highlightMinPrice || 100;

        // Query gifts
        const startMs = startTime.getTime();
        const endMs = endTime.getTime();

        const gifts = await db.all(`SELECT * FROM danmu_gift WHERE room_id = $1 AND timestamp >= $2 AND timestamp <= $3 AND diamond_count >= $4`,
            [roomId, startMs, endMs, minPrice]);

        if (!gifts || gifts.length === 0) {
            console.log(`[Highlights] No high-value gifts found (min ${minPrice}). Skipping.`);
            return;
        }

        console.log(`[Highlights] Found ${gifts.length} highlight moments.`);

        // 2. Generate Clips
        const highlightDir = path.join(path.dirname(filePath), 'highlights');
        if (!fs.existsSync(highlightDir)) {
            fs.mkdirSync(highlightDir, { recursive: true });
        }

        for (const gift of gifts) {
            try {
                const giftTime = gift.timestamp;
                const relativeTimeMs = giftTime - startMs;
                const relativeTimeSec = Math.max(0, (relativeTimeMs / 1000) - 30); // 30s before
                const duration = 60; // 60s clip

                const safeName = (gift.gift_name || 'gift').replace(/[^a-z0-9]/gi, '_');
                const clipName = `${path.basename(filePath, '.mp4')}_${safeName}_${giftTime}.mp4`;
                const clipPath = path.join(highlightDir, clipName);

                console.log(`[Highlights] Creating clip at ${relativeTimeSec}s for ${gift.gift_name}`);

                await new Promise((resolve, reject) => {
                    const args = [
                        '-ss', relativeTimeSec.toString(),
                        '-i', filePath,
                        '-t', duration.toString(),
                        '-c', 'copy',
                        '-y',
                        clipPath
                    ];

                    const ffmpegPath = ffmpegManager.getFFmpegPath();
                    const process = spawn(ffmpegPath, args);

                    process.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`FFmpeg exited with ${code}`));
                    });
                });

                console.log(`[Highlights] Clip created: ${clipPath}`);

            } catch (err) {
                console.error(`[Highlights] Failed to clip gift ${gift.id}: ${err.message}`);
            }
        }
    }

    checkRecordings() {
        const now = Date.now();

        for (const [roomId, recording] of this.activeRecordings.entries()) {
            try {
                const stats = fs.statSync(recording.filePath);
                const currentSize = stats.size;
                const durationMin = Math.round((now - recording.startTime.getTime()) / 60000);

                // Initialize lastSize and lastSizeChange if not set
                if (!recording.lastSize || recording.lastSize === 0) {
                    recording.lastSize = currentSize;
                    recording.lastSizeChange = now;
                } else if (currentSize > recording.lastSize) {
                    // File is growing, update tracking & reset reconnect counter
                    recording.lastSize = currentSize;
                    recording.lastSizeChange = now;
                    recording.reconnectAttempts = 0; // Reset on healthy growth
                } else if (now - recording.lastSizeChange > this.STALL_THRESHOLD_MS) {
                    // File hasn't grown in STALL_THRESHOLD_MS, recording is stalled
                    const stallSecs = Math.round((now - recording.lastSizeChange) / 1000);
                    const sizeMB = (currentSize / (1024 * 1024)).toFixed(2);
                    console.warn(`[Recorder] Recording for ${roomId} stalled (no growth in ${stallSecs}s, ${sizeMB}MB, ${durationMin}min). Triggering reconnect...`);

                    // Don't call stopRecording (which sets manualStop) - instead kill processes
                    // to trigger the auto-reconnect in ffmpeg.on('close')
                    try { recording.curlProcess.kill(); } catch (e) { }
                    // FFmpeg will exit when its stdin closes (curl killed)
                }

                // Periodic status log (every ~5 minutes based on 60s interval)
                if (durationMin > 0 && durationMin % 5 === 0) {
                    const sizeMB = (currentSize / (1024 * 1024)).toFixed(2);
                    console.log(`[Recorder] 📊 ${roomId}: recording ${durationMin}min, ${sizeMB}MB, reconnects: ${recording.reconnectAttempts || 0}`);
                }
            } catch (e) {
                // File may not exist yet or other issue - don't stall-kill if file doesn't exist yet
                if (e.code !== 'ENOENT') {
                    console.warn(`[Recorder] Check error for ${roomId}: ${e.message}`);
                }
            }
        }
    }

    isRecording(roomId) {
        return this.activeRecordings.has(roomId);
    }

    /**
     * Stop all active recordings gracefully (called on server shutdown)
     */
    async stopAllRecordings() {
        const activeRooms = Array.from(this.activeRecordings.keys());
        console.log(`[Recorder] Stopping ${activeRooms.length} active recordings...`);

        const endTime = getBeijingTime();

        for (const roomId of activeRooms) {
            try {
                const recording = this.activeRecordings.get(roomId);
                if (recording) {
                    // Mark as manual stop for clean exit
                    recording.manualStop = true;

                    // Kill processes
                    try { recording.process?.kill('SIGINT'); } catch (e) { }
                    try { recording.curlProcess?.kill(); } catch (e) { }

                    // Update DB
                    await db.run(
                        `UPDATE recording_task SET status = $1, end_time = $2 WHERE room_id = $3 AND status = 'recording'`,
                        ['completed', endTime, roomId]
                    );

                    console.log(`[Recorder] Saved recording for ${roomId}`);
                }
            } catch (e) {
                console.error(`[Recorder] Failed to stop ${roomId}:`, e.message);
            }
        }

        this.activeRecordings.clear();
        console.log(`[Recorder] All recordings stopped and saved.`);
    }

    /**
     * Cleanup orphaned tasks on startup (tasks stuck in "recording" status from previous crash)
     */
    async cleanupOrphanedTasks() {
        try {
            const result = await db.run(
                `UPDATE recording_task SET status = 'interrupted', end_time = $1 WHERE status = 'recording'`,
                [getBeijingTime()]
            );

            // Get affected count (PostgreSQL returns rowCount, SQLite returns changes)
            const count = result?.rowCount || result?.changes || 0;

            if (count > 0) {
                console.log(`[Recorder] Cleaned up ${count} orphaned recording task(s) from previous session.`);
            }
        } catch (e) {
            console.error('[Recorder] Failed to cleanup orphaned tasks:', e.message);
        }
    }
}

module.exports = new RecordingManager();
