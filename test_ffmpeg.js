const ffmpegManager = require('./utils/ffmpeg_manager');
const fs = require('fs');
const path = require('path');

async function runTest() {
    console.log('--- FFmpeg Manager Test ---');

    // 1. Check Initial Status
    console.log('\n[1] Checking Status...');
    const status1 = await ffmpegManager.checkFFmpegStatus();
    console.log('Status:', status1);

    if (status1.isLocal) {
        console.log('Local FFmpeg already exists. Skipping install test or force reinstalling?');
        // Let's force reinstall to verify download logic if user wants deep test, 
        // but for now let's just checking version is enough.
        // Actually, let's try to run version check explicitly
    } else {
        console.log('Local FFmpeg not found.');
    }

    // 2. Install (if not local, or force)
    // We will force install to test the download/extract logic
    console.log('\n[2] Testing Installation (Force)...');
    try {
        const installResult = await ffmpegManager.installFFmpeg(true);
        console.log('Install Result:', installResult);
    } catch (e) {
        console.error('Install Failed:', e);
        process.exit(1);
    }

    // 3. Verify File
    console.log('\n[3] Verifying File...');
    const binPath = path.join(__dirname, 'bin', 'ffmpeg.exe');
    if (fs.existsSync(binPath)) {
        console.log('SUCCESS: ffmpeg.exe found at', binPath);

        // 4. Final Status Check
        const status2 = await ffmpegManager.checkFFmpegStatus();
        console.log('Final Status:', status2);

        if (status2.installed && status2.isLocal) {
            console.log('TEST PASSED: FFmpeg is installed and recognized locally.');
        } else {
            console.error('TEST FAILED: Status verification failed.');
            process.exit(1);
        }

    } else {
        console.error('TEST FAILED: ffmpeg.exe not found after install.');
        process.exit(1);
    }
}

runTest();
