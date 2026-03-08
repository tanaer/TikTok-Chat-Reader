#!/usr/bin/env node
require('dotenv').config();

const db = require('../db');
const { refreshRuntimeSettingsFromDb } = require('../services/featureFlagService');
const { MaintenanceWorker } = require('../workers/maintenance_worker');

async function main() {
    process.title = 'tiktok-monitor-maintenance-worker';
    await db.initDb();
    await refreshRuntimeSettingsFromDb(db);

    const worker = new MaintenanceWorker();

    process.on('SIGINT', () => worker.requestShutdown('SIGINT'));
    process.on('SIGTERM', () => worker.requestShutdown('SIGTERM'));

    try {
        await worker.run();
    } finally {
        await db.pool.end().catch(() => {});
    }
}

main().catch((error) => {
    console.error('[MAINTENANCE_WORKER_BOOT] Fatal error:', error);
    process.exitCode = 1;
});
