/**
 * Highlight Extractor - Extract video clips from recordings based on high-value gift events
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./db');
const ffmpegManager = require('./utils/ffmpeg_manager');

// Default configuration
const DEFAULT_MIN_DIAMONDS = 5000;
const DEFAULT_BUFFER_BEFORE = 15; // seconds
const DEFAULT_BUFFER_AFTER = 30;  // seconds
const DEFAULT_MERGE_WINDOW = 60;  // seconds

/**
 * Analyze a recording for potential highlight clips based on gift events
 * @param {number} recordingTaskId - The recording task ID
 * @param {object} options - Configuration options
 * @returns {Promise<Array>} Array of potential clip segments
 */
async function analyzeRecordingForHighlights(recordingTaskId, options = {}) {
    const minDiamonds = options.minDiamonds || DEFAULT_MIN_DIAMONDS;
    const bufferBefore = options.bufferBefore || DEFAULT_BUFFER_BEFORE;
    const bufferAfter = options.bufferAfter || DEFAULT_BUFFER_AFTER;
    const mergeWindow = options.mergeWindow || DEFAULT_MERGE_WINDOW;

    // Get recording task info
    const task = await db.get(`
        SELECT * FROM recording_task WHERE id = $1
    `, [recordingTaskId]);

    if (!task) {
        throw new Error('Recording task not found');
    }

    if (task.status !== 'completed') {
        throw new Error('Recording is not completed yet');
    }

    if (!task.startTime || !task.endTime) {
        throw new Error('Recording has no valid time range');
    }

    const roomId = task.roomId;
    const recordingStart = new Date(task.startTime);
    const recordingEnd = new Date(task.endTime);
    const recordingDurationSec = (recordingEnd - recordingStart) / 1000;

    console.log(`[HighlightExtractor] Analyzing recording ${recordingTaskId} for room ${roomId}`);
    console.log(`[HighlightExtractor] Recording duration: ${recordingDurationSec}s, Min diamonds: ${minDiamonds}`);

    // Query gift events during recording period
    const giftEvents = await db.query(`
        SELECT id, room_id, timestamp, user_id, unique_id, nickname, 
               gift_id, diamond_count, repeat_count,
               (diamond_count * repeat_count) as total_value
        FROM event 
        WHERE room_id = $1 
          AND type = 'gift'
          AND timestamp >= $2 
          AND timestamp <= $3
          AND (diamond_count * repeat_count) >= $4
        ORDER BY timestamp ASC
    `, [roomId, task.startTime, task.endTime, minDiamonds]);

    console.log(`[HighlightExtractor] Found ${giftEvents.length} qualifying gift events`);

    if (giftEvents.length === 0) {
        return [];
    }

    // Calculate offsets and create segments
    const segments = giftEvents.map(event => {
        const eventTime = new Date(event.timestamp);
        const offsetSec = (eventTime - recordingStart) / 1000;

        return {
            eventId: event.id,
            timestamp: event.timestamp,
            offsetSec: offsetSec,
            startSec: Math.max(0, offsetSec - bufferBefore),
            endSec: Math.min(recordingDurationSec, offsetSec + bufferAfter),
            diamondValue: event.totalValue || (event.diamondCount * event.repeatCount),
            userId: event.userId,
            uniqueId: event.uniqueId,
            nickname: event.nickname,
            giftId: event.giftId
        };
    });

    // Merge overlapping segments
    const mergedSegments = mergeOverlappingSegments(segments, mergeWindow);

    console.log(`[HighlightExtractor] After merging: ${mergedSegments.length} clips`);

    return mergedSegments;
}

/**
 * Merge segments that are within the merge window of each other
 * @param {Array} segments - Array of segment objects
 * @param {number} mergeWindow - Seconds within which to merge segments
 * @returns {Array} Merged segments
 */
function mergeOverlappingSegments(segments, mergeWindow) {
    if (segments.length === 0) return [];

    const merged = [];
    let current = { ...segments[0], events: [segments[0]] };

    for (let i = 1; i < segments.length; i++) {
        const seg = segments[i];

        // Check if this segment should be merged with current
        // Merge if the gap between end of current and start of next is <= mergeWindow
        if (seg.startSec <= current.endSec + mergeWindow) {
            // Merge: extend end time and accumulate values
            current.endSec = Math.max(current.endSec, seg.endSec);
            current.diamondValue += seg.diamondValue;
            current.events.push(seg);
        } else {
            // No merge: save current and start new
            merged.push(current);
            current = { ...seg, events: [seg] };
        }
    }
    merged.push(current);

    // Format merged segments
    return merged.map(seg => ({
        startSec: seg.startSec,
        endSec: seg.endSec,
        durationSec: seg.endSec - seg.startSec,
        totalDiamondValue: seg.diamondValue,
        eventCount: seg.events.length,
        events: seg.events,
        // Use first event's timestamp for filename
        firstEventTimestamp: seg.events[0].timestamp,
        firstEventOffsetSec: seg.events[0].offsetSec
    }));
}

/**
 * Generate filename for a highlight clip
 * @param {Date} beijingTime - The Beijing time of the first gift event
 * @param {number} offsetSec - Seconds into the live stream
 * @param {number} totalDiamonds - Total diamond value
 * @returns {string} Formatted filename
 */
function generateClipFilename(beijingTime, offsetSec, totalDiamonds) {
    // Format Beijing time as YYYY-MM-DD
    const date = new Date(beijingTime);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // Format offset as X小时XX分XX秒
    const hours = Math.floor(offsetSec / 3600);
    const minutes = Math.floor((offsetSec % 3600) / 60);
    const seconds = Math.floor(offsetSec % 60);

    let durationStr;
    if (hours > 0) {
        durationStr = `${hours}小时${String(minutes).padStart(2, '0')}分${String(seconds).padStart(2, '0')}秒`;
    } else if (minutes > 0) {
        durationStr = `${minutes}分${String(seconds).padStart(2, '0')}秒`;
    } else {
        durationStr = `${seconds}秒`;
    }

    return `${dateStr}-${durationStr}-${totalDiamonds}.mp4`;
}

/**
 * Build FFmpeg drawtext filter for gift event overlays
 * Each gift event shows a banner at the bottom with sender nickname and diamond value
 * @param {Array} giftEvents - Array of gift event objects with offsetSec, nickname, diamondValue
 * @param {number} clipStartSec - The clip's start time in recording (for relative time calc)
 * @returns {string} FFmpeg filter_complex string
 */
function buildGiftOverlayFilter(giftEvents, clipStartSec) {
    if (!giftEvents || giftEvents.length === 0) return '';

    const filters = [];

    giftEvents.forEach((event, idx) => {
        // Calculate when this event occurs relative to the clip start
        const relativeTime = event.offsetSec - clipStartSec;
        const showStart = Math.max(0, relativeTime - 1); // Show 1s before event
        const showEnd = relativeTime + 5; // Show for 5s after event
        const diamondValue = event.diamondValue || 0;
        // Sanitize text for FFmpeg (escape special chars)
        const nickname = (event.nickname || 'Anonymous').replace(/[':]/g, '').replace(/\\/g, '');
        const text = `${nickname}  ${diamondValue.toLocaleString()} diamonds`;

        // Semi-transparent background banner with white text at bottom
        // Using enable='between(t,start,end)' for timed display
        filters.push(
            `drawtext=text='${text}':fontsize=28:fontcolor=white:` +
            `x=(w-text_w)/2:y=h-60-${idx * 45}:` +
            `box=1:boxcolor=black@0.6:boxborderw=8:` +
            `enable='between(t,${showStart.toFixed(1)},${showEnd.toFixed(1)})'`
        );
    });

    return filters.join(',');
}

/**
 * Extract a clip from a video file using FFmpeg
 * @param {string} inputPath - Path to source video
 * @param {number} startSec - Start time in seconds
 * @param {number} durationSec - Duration in seconds
 * @param {string} outputPath - Path for output video
 * @param {Array} [giftEvents] - Optional gift events for overlay (enables re-encoding)
 * @returns {Promise<object>} Result with success status
 */
async function extractClip(inputPath, startSec, durationSec, outputPath, giftEvents = []) {
    const ffmpegPath = await ffmpegManager.getFFmpegPath();

    if (!ffmpegPath) {
        throw new Error('FFmpeg not available');
    }

    if (!fs.existsSync(inputPath)) {
        throw new Error(`Source video not found: ${inputPath}`);
    }

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
        let args;
        const overlayFilter = buildGiftOverlayFilter(giftEvents, startSec);

        if (overlayFilter) {
            // Re-encode with gift overlay (slower but adds text)
            args = [
                '-y',
                '-ss', startSec.toString(),
                '-i', inputPath,
                '-t', durationSec.toString(),
                '-vf', overlayFilter,
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '23',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart',
                outputPath
            ];
        } else {
            // Fast stream-copy (no re-encoding)
            args = [
                '-y',
                '-ss', startSec.toString(),
                '-i', inputPath,
                '-t', durationSec.toString(),
                '-c', 'copy',
                '-movflags', '+faststart',
                outputPath
            ];
        }

        console.log(`[HighlightExtractor] Running: ffmpeg ${args.join(' ')}`);

        const ffmpeg = spawn(ffmpegPath, args);
        let stderr = '';

        ffmpeg.stderr.on('data', data => {
            stderr += data.toString();
        });

        ffmpeg.on('close', code => {
            if (code === 0) {
                const stats = fs.statSync(outputPath);
                console.log(`[HighlightExtractor] Clip extracted: ${outputPath} (${Math.round(stats.size / 1024)}KB)`);
                resolve({ success: true, filePath: outputPath, fileSize: stats.size });
            } else {
                console.error(`[HighlightExtractor] FFmpeg failed with code ${code}: ${stderr}`);
                reject(new Error(`FFmpeg failed: ${stderr.slice(-500)}`));
            }
        });

        ffmpeg.on('error', err => {
            reject(new Error(`FFmpeg spawn error: ${err.message}`));
        });
    });
}

/**
 * Extract all highlight clips from a recording
 * @param {number} recordingTaskId - Recording task ID
 * @param {object} options - Configuration options
 * @returns {Promise<Array>} Array of extracted clip results
 */
async function extractAllHighlights(recordingTaskId, options = {}) {
    const segments = await analyzeRecordingForHighlights(recordingTaskId, options);

    if (segments.length === 0) {
        console.log(`[HighlightExtractor] No highlights to extract for recording ${recordingTaskId}`);
        return [];
    }

    const task = await db.get(`SELECT * FROM recording_task WHERE id = $1`, [recordingTaskId]);
    if (!task || !task.filePath) {
        throw new Error('Recording file not found');
    }

    const inputPath = task.filePath;
    const outputDir = path.join(path.dirname(inputPath), 'highlights');

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const results = [];

    for (const segment of segments) {
        try {
            // Generate filename
            const filename = generateClipFilename(
                segment.firstEventTimestamp,
                segment.firstEventOffsetSec,
                segment.totalDiamondValue
            );
            const outputPath = path.join(outputDir, filename);

            // Create database record
            const clipRecord = await db.get(`
                INSERT INTO highlight_clip 
                (recording_task_id, room_id, start_offset_sec, end_offset_sec, 
                 gift_events_json, total_diamond_value, file_path, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing')
                RETURNING id
            `, [
                recordingTaskId,
                task.roomId,
                segment.startSec,
                segment.endSec,
                JSON.stringify(segment.events.map(e => e.eventId)),
                segment.totalDiamondValue,
                outputPath
            ]);

            // Extract clip with gift overlay
            const result = await extractClip(inputPath, segment.startSec, segment.durationSec, outputPath, segment.events);

            // Update status to completed
            await db.run(`
                UPDATE highlight_clip SET status = 'completed' WHERE id = $1
            `, [clipRecord.id]);

            results.push({
                clipId: clipRecord.id,
                ...result,
                segment
            });

        } catch (err) {
            console.error(`[HighlightExtractor] Failed to extract segment:`, err.message);
            results.push({
                success: false,
                error: err.message,
                segment
            });
        }
    }

    console.log(`[HighlightExtractor] Extracted ${results.filter(r => r.success).length}/${segments.length} clips`);
    return results;
}

/**
 * Get all highlight clips for a recording
 * @param {number} recordingTaskId - Recording task ID
 * @returns {Promise<Array>} Array of clip records
 */
async function getHighlightClips(recordingTaskId) {
    return await db.query(`
        SELECT * FROM highlight_clip 
        WHERE recording_task_id = $1 
        ORDER BY start_offset_sec ASC
    `, [recordingTaskId]);
}

/**
 * Delete a highlight clip
 * @param {number} clipId - Clip ID
 * @param {boolean} deleteFile - Whether to delete the file too
 */
async function deleteHighlightClip(clipId, deleteFile = true) {
    const clip = await db.get(`SELECT * FROM highlight_clip WHERE id = $1`, [clipId]);

    if (!clip) {
        throw new Error('Clip not found');
    }

    if (deleteFile && clip.filePath && fs.existsSync(clip.filePath)) {
        fs.unlinkSync(clip.filePath);
        console.log(`[HighlightExtractor] Deleted file: ${clip.filePath}`);
    }

    await db.run(`DELETE FROM highlight_clip WHERE id = $1`, [clipId]);
    console.log(`[HighlightExtractor] Deleted clip record: ${clipId}`);
}

module.exports = {
    analyzeRecordingForHighlights,
    extractClip,
    extractAllHighlights,
    generateClipFilename,
    getHighlightClips,
    deleteHighlightClip,
    DEFAULT_MIN_DIAMONDS,
    DEFAULT_BUFFER_BEFORE,
    DEFAULT_BUFFER_AFTER,
    DEFAULT_MERGE_WINDOW
};
