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

            // Format filename: {Title}_{Nickname}_{YYYYMMDD_HHmmss}.mp4
            // Since we don't have title/nickname readily available here without extra query/params, 
            // we use uniqueId and timestamp for now, or we can fetch room details from DB?
            // Existing logic checked outputDir/roomId previously?
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `${uniqueId}_${timestamp}.mp4`;

            // Allow user provided filename format if we had title info...
            // For now, keeping simple safe filename.

            const filePath = path.join(outputDir, fileName);

            console.log(`[Recorder] Stream URL obtained: ${streamUrl}`);

            // Use curl to download stream (bypasses Node.js TLS fingerprinting/IPv6 issues)
            const curlArgs = [
                '-4', // FORCE IPv4 to avoid proxy IPv6 issues
                '-s', // Silent mode
                '-L', // Follow redirects
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

            // Prepare FFmpeg
            const args = [
                '-y',
                '-v', 'error',
                '-f', 'flv',        // Specify input format (FLV stream from curl)
                '-i', '-',          // Read from pipe
                '-c', 'copy',       // Copy streams without re-encoding
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

            const ffmpeg = spawn(ffmpegPath, args);

            // Pipe Curl -> FFmpeg
            curlProcess.stdout.pipe(ffmpeg.stdin);

            // Track process
            this.activeRecordings.set(roomId, {
                process: ffmpeg,
                curlProcess: curlProcess,
                filePath: filePath,
                startTime: new Date(),
                accountId: accountId
            });

            // DB Update
            console.log(`[Recorder] Saving to DB: roomId="${roomId}", filePath="${filePath}"`);
            db.run(`INSERT INTO recording_task (room_id, account_id, start_time, status, file_path) VALUES ($1, $2, $3, $4, $5)`,
                [roomId, accountId || null, getBeijingTime(), 'recording', filePath]);

            console.log(`[Recorder] FFmpeg started for ${roomId}, PID: ${ffmpeg.pid}`);

            ffmpeg.stderr.on('data', (data) => {
                console.log(`[FFmpeg] stderr: ${data}`);
            });

            // Wait for FFmpeg exit (which happens when curl stops stream or error)
            ffmpeg.on('close', async (code) => {
                console.log(`[Recorder] FFmpeg exited with code ${code}`);

                // Retrieve recording state before deleting
                const recordingState = this.activeRecordings.get(roomId);
                this.activeRecordings.delete(roomId);

                // Ensure curl is killed
                try { curlProcess.kill(); } catch (e) { }

                // Determine Status: Success if code 0, 255 (kill), or manualStop flag is set
                const isSuccess = (code === 0 || code === 255 || (recordingState && recordingState.manualStop));
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

    async stopRecording(roomId) {
        const recording = this.activeRecordings.get(roomId);
        if (recording) {
            console.log(`[Recorder] Stopping recording for ${roomId}...`);

            // Mark as manual stop to ensure "completed" status
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
        // Note: danmu_gift timestamp might be in ms or ISO? Usually ms in 'timestamp' column.
        // startTime / endTime are Date objects.
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
        // Group gifts that are close together (within 60s) to avoid overlapping clips?
        // For simplicity, just clip -30s +30s for each gift (or first of cluster).

        // output folder: downloads/highlights
        const highlightDir = path.join(path.dirname(filePath), 'highlights');
        if (!fs.existsSync(highlightDir)) {
            fs.mkdirSync(highlightDir, { recursive: true });
        }

        // Logic: Iterate gifts, creating clip.
        // We use ffmpeg -ss (start - relative) -t 60 -c copy
        // Need to calculate relative start time in seconds.

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

                // Save to DB? separate highlights table or just log?
                // User asked to "try clip".
                console.log(`[Highlights] Clip created: ${clipPath}`);

            } catch (err) {
                console.error(`[Highlights] Failed to clip gift ${gift.id}: ${err.message}`);
            }
        }
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
