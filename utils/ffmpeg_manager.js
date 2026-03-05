const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const PLATFORM = process.platform;
const ARCH = process.arch;
const IS_WINDOWS = PLATFORM === 'win32';

// FFmpeg Release Essentials (Windows) from Gyan.dev
const WINDOWS_FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
// Linux static builds from BtbN (primary) and John Van Sickle (fallback)
const LINUX_FFMPEG_URLS = {
    x64: [
        'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz',
        'https://johnvansickle.com/ffmpeg/builds/ffmpeg-release-amd64-static.tar.xz',
        'https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz'
    ],
    arm64: [
        'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linuxarm64-gpl.tar.xz',
        'https://johnvansickle.com/ffmpeg/builds/ffmpeg-release-arm64-static.tar.xz',
        'https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-arm64-static.tar.xz'
    ]
};

const BIN_DIR = path.join(__dirname, '..', 'bin');
const TEMP_DIR = path.join(__dirname, '..', 'temp');
const FFMPEG_BIN_NAME = IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg';
const FFMPEG_PATH = path.join(BIN_DIR, FFMPEG_BIN_NAME);

function getDownloadConfig() {
    if (IS_WINDOWS) {
        return {
            urls: [WINDOWS_FFMPEG_URL],
            type: 'zip',
            archiveName: 'ffmpeg.zip',
            binaryName: 'ffmpeg.exe'
        };
    }

    if (PLATFORM === 'linux') {
        const urls = LINUX_FFMPEG_URLS[ARCH];
        if (!urls || urls.length === 0) return null;
        return {
            urls,
            type: 'tar.xz',
            archiveName: 'ffmpeg.tar.xz',
            binaryName: 'ffmpeg'
        };
    }

    return null;
}

function findFileRecursive(startDir, fileName) {
    const entries = fs.readdirSync(startDir, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(startDir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileRecursive(entryPath, fileName);
            if (found) return found;
        } else if (entry.isFile() && entry.name === fileName) {
            return entryPath;
        }
    }
    return null;
}

class FFmpegManager {
    constructor() {
        if (!fs.existsSync(BIN_DIR)) {
            fs.mkdirSync(BIN_DIR, { recursive: true });
        }
        if (!fs.existsSync(TEMP_DIR)) {
            fs.mkdirSync(TEMP_DIR, { recursive: true });
        }

        this.installState = {
            status: 'idle',
            message: null,
            error: null,
            startedAt: null,
            finishedAt: null
        };
        this._installPromise = null;
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

    getInstallStatus() {
        return { ...this.installState };
    }

    startInstall(force = false) {
        if (!force && fs.existsSync(FFMPEG_PATH)) {
            const now = new Date().toISOString();
            this.installState = {
                status: 'success',
                message: 'Already installed',
                error: null,
                startedAt: now,
                finishedAt: now
            };
            return { started: false, message: 'Already installed', status: this.getInstallStatus() };
        }

        if (this._installPromise) {
            return { started: false, message: 'Installation already running', status: this.getInstallStatus() };
        }

        this._installPromise = this._installFFmpeg(force).catch(() => {});
        return { started: true, status: this.getInstallStatus() };
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
        if (this._installPromise) {
            return { success: false, message: 'Installation already running', status: this.getInstallStatus() };
        }

        this._installPromise = this._installFFmpeg(force);
        return await this._installPromise;
    }

    async _installFFmpeg(force = false) {
        const startTime = new Date().toISOString();
        this.installState = {
            status: 'running',
            message: 'Downloading',
            error: null,
            startedAt: startTime,
            finishedAt: null
        };

        if (!force && fs.existsSync(FFMPEG_PATH)) {
            console.log('[FFmpegManager] Local FFmpeg already exists.');
            const now = new Date().toISOString();
            this.installState = {
                status: 'success',
                message: 'Already installed',
                error: null,
                startedAt: startTime,
                finishedAt: now
            };
            this._installPromise = null;
            return { success: true, message: 'Already installed' };
        }

        const downloadConfig = getDownloadConfig();
        if (!downloadConfig) {
            const now = new Date().toISOString();
            this.installState = {
                status: 'error',
                message: null,
                error: `Auto-install not supported on ${PLATFORM}/${ARCH}. Please install ffmpeg and ensure it is on PATH.`,
                startedAt: startTime,
                finishedAt: now
            };
            this._installPromise = null;
            return {
                success: false,
                error: `Auto-install not supported on ${PLATFORM}/${ARCH}. Please install ffmpeg and ensure it is on PATH.`
            };
        }

        let downloadUrl = null;

        const archivePath = path.join(TEMP_DIR, downloadConfig.archiveName);

        try {
            const { default: fetch } = await import('node-fetch');
            let lastError = null;

            for (let i = 0; i < downloadConfig.urls.length; i++) {
                const url = downloadConfig.urls[i];
                this.installState.message = `Downloading (${i + 1}/${downloadConfig.urls.length})`;
                console.log(`[FFmpegManager] Downloading FFmpeg from ${url}...`);
                try {
                    const res = await fetch(url);
                    if (!res.ok) throw new Error(`Failed to download FFmpeg: ${res.status} ${res.statusText}`);

                    // Write to file
                    const fileStream = fs.createWriteStream(archivePath);
                    await new Promise((resolve, reject) => {
                        res.body.pipe(fileStream);
                        res.body.on('error', reject);
                        fileStream.on('finish', resolve);
                    });

                    downloadUrl = url;
                    break;
                } catch (err) {
                    lastError = err;
                    console.warn(`[FFmpegManager] Download failed for ${url}: ${err.message}`);
                    try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch (e) { }
                }
            }

            if (!downloadUrl) {
                throw lastError || new Error('Failed to download FFmpeg');
            }

            console.log('[FFmpegManager] Download complete. Extracting...');

            if (downloadConfig.type === 'zip') {
                const zip = new AdmZip(archivePath);
                const zipEntries = zip.getEntries(); // array of ZipEntry records
                let foundEntry = null;

                for (const entry of zipEntries) {
                    if (entry.entryName.endsWith(`bin/${downloadConfig.binaryName}`) || entry.entryName.endsWith(downloadConfig.binaryName)) {
                        foundEntry = entry;
                        break;
                    }
                }

                if (!foundEntry) {
                    throw new Error(`${downloadConfig.binaryName} not found in downloaded archive`);
                }

                const buffer = foundEntry.getData();
                fs.writeFileSync(FFMPEG_PATH, buffer);
            } else if (downloadConfig.type === 'tar.xz') {
                const extractDir = path.join(TEMP_DIR, 'ffmpeg_extract');
                fs.rmSync(extractDir, { recursive: true, force: true });
                fs.mkdirSync(extractDir, { recursive: true });

                execSync(`tar -xf "${archivePath}" -C "${extractDir}"`);

                const foundPath = findFileRecursive(extractDir, downloadConfig.binaryName);
                if (!foundPath) {
                    throw new Error(`${downloadConfig.binaryName} not found in downloaded archive`);
                }

                fs.copyFileSync(foundPath, FFMPEG_PATH);
                if (!IS_WINDOWS) {
                    fs.chmodSync(FFMPEG_PATH, 0o755);
                }

                fs.rmSync(extractDir, { recursive: true, force: true });
            } else {
                throw new Error(`Unsupported archive type: ${downloadConfig.type}`);
            }

            console.log('[FFmpegManager] Installation complete.');

            // Clean up
            try { fs.unlinkSync(archivePath); } catch (e) { }

            const now = new Date().toISOString();
            this.installState = {
                status: 'success',
                message: 'Installation successful',
                error: null,
                startedAt: startTime,
                finishedAt: now
            };
            this._installPromise = null;
            return { success: true, message: 'Installation successful' };

        } catch (err) {
            console.error('[FFmpegManager] Installation failed:', err);
            // Clean up zip if exists
            try {
                if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
            } catch (e) { }

            const now = new Date().toISOString();
            this.installState = {
                status: 'error',
                message: null,
                error: err.message,
                startedAt: startTime,
                finishedAt: now
            };
            this._installPromise = null;
            return { success: false, error: err.message };
        }
    }
}

module.exports = new FFmpegManager();
