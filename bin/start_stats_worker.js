#!/usr/bin/env node
require('dotenv').config();

const db = require('../db');
const { refreshRuntimeSettingsFromDb } = require('../services/featureFlagService');
const { StatsWorker } = require('../workers/stats_worker');

async function main() {
    process.title = 'tiktok-monitor-stats-worker';
    await db.initDb();
    await refreshRuntimeSettingsFromDb(db);

    const worker = new StatsWorker();

    process.on('SIGINT', () => worker.requestShutdown('SIGINT'));
    process.on('SIGTERM', () => worker.requestShutdown('SIGTERM'));

    try {
        await worker.run();
    } finally {
        await db.pool.end().catch(() => {});
    }
}

main().catch((error) => {
    console.error('[STATS_WORKER_BOOT] Fatal error:', error);
    process.exitCode = 1;
});
