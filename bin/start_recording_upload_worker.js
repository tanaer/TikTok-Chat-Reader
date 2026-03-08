#!/usr/bin/env node
require('dotenv').config();

const db = require('../db');
const { refreshRuntimeSettingsFromDb } = require('../services/featureFlagService');
const { RecordingUploadWorker } = require('../workers/recording_upload_worker');

async function main() {
    process.title = 'tiktok-monitor-recording-upload-worker';
    await db.initDb();
    await refreshRuntimeSettingsFromDb(db);

    const worker = new RecordingUploadWorker();

    process.on('SIGINT', () => worker.requestShutdown('SIGINT'));
    process.on('SIGTERM', () => worker.requestShutdown('SIGTERM'));

    await worker.run();
}

main().catch((error) => {
    console.error('[RECORDING_UPLOAD_WORKER_BOOT] Fatal error:', error);
    process.exitCode = 1;
});
