const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// FFmpeg Release Essentials (Windows) from Gyan.dev
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const BIN_DIR = path.join(__dirname, '..', 'bin');
const TEMP_DIR = path.join(__dirname, '..', 'temp');
const FFMPEG_PATH = path.join(BIN_DIR, 'ffmpeg.exe');

class FFmpegManager {
    constructor() {
        if (!fs.existsSync(BIN_DIR)) {
            fs.mkdirSync(BIN_DIR, { recursive: true });
        }
        if (!fs.existsSync(TEMP_DIR)) {
            fs.mkdirSync(TEMP_DIR, { recursive: true });
        }
    }

    getFFmpegPath() {
        if (fs.existsSync(FFMPEG_PATH)) {
            return FFMPEG_PATH;
        }
        // Fallback to system path if not found locally
        try {
            execSync('ffmpeg -version', { stdio: 'ignore' });
            return 'ffmpeg';
        } catch (e) {
            return null;
        }
    }

    async checkFFmpegStatus() {
        const localExists = fs.existsSync(FFMPEG_PATH);
        let version = 'Not Installed';
        let pathStr = 'None';
        let isLocal = false;

        if (localExists) {
            pathStr = FFMPEG_PATH;
            isLocal = true;
            version = this.getVersion(FFMPEG_PATH);
        } else {
            try {
                execSync('ffmpeg -version', { stdio: 'ignore' });
                pathStr = 'System PATH';
                version = this.getVersion('ffmpeg');
            } catch (e) {
                // Not found
            }
        }

        return { installed: version !== 'Not Installed', version, path: pathStr, isLocal };
    }

    getVersion(ffmpegCmd) {
        try {
            // Get first line of version output
            const output = execSync(`"${ffmpegCmd}" -version`).toString();
            const firstLine = output.split('\n')[0];
            return firstLine.split('version')[1]?.trim().split(' ')[0] || 'Unknown';
            // Often looks like "ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright ..."
            // Extract "6.1.1-essentials_build-www.gyan.dev" ideally
        } catch (e) {
            return 'Error getting version';
        }
    }

    async installFFmpeg(force = false) {
        if (!force && fs.existsSync(FFMPEG_PATH)) {
            console.log('[FFmpegManager] Local FFmpeg already exists.');
            return { success: true, message: 'Already installed' };
        }

        console.log(`[FFmpegManager] Downloading FFmpeg from ${FFMPEG_URL}...`);

        const zipPath = path.join(TEMP_DIR, 'ffmpeg.zip');

        try {
            const { default: fetch } = await import('node-fetch');
            const res = await fetch(FFMPEG_URL);
            if (!res.ok) throw new Error(`Failed to download FFmpeg: ${res.statusText}`);

            // Write to file
            const fileStream = fs.createWriteStream(zipPath);
            await new Promise((resolve, reject) => {
                res.body.pipe(fileStream);
                res.body.on('error', reject);
                fileStream.on('finish', resolve);
            });

            console.log('[FFmpegManager] Download complete. Extracting...');

            const zip = new AdmZip(zipPath);
            const zipEntries = zip.getEntries(); // array of ZipEntry records
            let found = false;

            // Find ffmpeg.exe inside the zip (it's usually in a nested folder like ffmpeg-6.1.1-essentials_build/bin/ffmpeg.exe)
            for (const entry of zipEntries) {
                if (entry.entryName.endsWith('bin/ffmpeg.exe')) {
                    console.log(`[FFmpegManager] Found binary: ${entry.entryName}`);

                    // Extract specifically this file to BIN_DIR
                    // adm-zip extractEntryTo(entryName, targetPath, maintainEntryPath, overwrite)
                    // If maintainEntryPath is false, it puts it directly in targetPath
                    // wait, extractEntryTo extracts to directory. We want file.
                    // Let's use getData() and writeFileSync for precision.

                    const buffer = entry.getData();
                    fs.writeFileSync(FFMPEG_PATH, buffer);
                    found = true;
                    break;
                }
            }

            if (!found) {
                throw new Error('ffmpeg.exe not found in downloaded archive');
            }

            console.log('[FFmpegManager] Installation complete.');

            // Clean up
            try { fs.unlinkSync(zipPath); } catch (e) { }

            return { success: true, message: 'Installation successful' };

        } catch (err) {
            console.error('[FFmpegManager] Installation failed:', err);
            // Clean up zip if exists
            try {
                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            } catch (e) { }

            return { success: false, error: err.message };
        }
    }
}

module.exports = new FFmpegManager();
