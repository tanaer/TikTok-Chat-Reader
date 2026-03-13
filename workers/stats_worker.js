require('dotenv').config();

const db = require('../db');
const metricsService = require('../services/metricsService');
const { getSchemeAConfig } = require('../services/featureFlagService');
const {
    STATS_WORKER_SCHEDULE,
    runRoomStatsRefreshJob,
    runDirtyRoomStatsRepairJob,
    runUserStatsRefreshJob,
    runGlobalStatsRefreshJob,
    runIncrementalStatsAggregationJob,
} = require('../services/statsRefreshService');
const {
    JOB_QUEUE_STATS,
    processAvailableAdminAsyncJobs,
} = require('../services/adminAsyncJobService');

const ADMIN_ASYNC_JOB_POLL_INTERVAL_MS = 5000;

class StatsWorker {
    constructor(options = {}) {
        this.schemeAConfig = options.schemeAConfig || getSchemeAConfig();
        this.shuttingDown = false;
        this.shutdownPromise = null;
        this.shutdownResolve = null;
        this.timers = new Set();
    }

    async init() {
        await db.initDb();

        if (!this.schemeAConfig.worker.enableStats) {
            metricsService.emitLog('warn', 'stats.worker', {
                status: 'disabled',
                reason: 'feature_flag_off',
            });
            return false;
        }

        metricsService.emitLog('info', 'stats.worker', {
            status: 'started',
            schedule: STATS_WORKER_SCHEDULE,
            incrementalStatsEnabled: Boolean(this.schemeAConfig.event?.enableIncrementalStats),
        });
        return true;
    }

    trackTimer(timerId) {
        this.timers.add(timerId);
        return timerId;
    }

    clearTimers() {
        for (const timerId of this.timers) {
            clearTimeout(timerId);
            clearInterval(timerId);
        }
        this.timers.clear();
    }

    async runJobSafely(jobName, runner) {
        if (this.shuttingDown) return;
        try {
            await runner();
        } catch (error) {
            console.error(`[STATS_WORKER] ${jobName} failed:`, error.message);
        }
    }

    scheduleJob(jobName, startupDelayMs, intervalMs, runner) {
        this.trackTimer(setTimeout(() => {
            this.runJobSafely(`${jobName}:startup`, runner);
        }, startupDelayMs));

        this.trackTimer(setInterval(() => {
            this.runJobSafely(`${jobName}:interval`, runner);
        }, intervalMs));
    }

    async run() {
        const enabled = await this.init();
        if (!enabled) {
            return;
        }

        this.scheduleJob('room_stats_refresh', STATS_WORKER_SCHEDULE.room.startupDelayMs, STATS_WORKER_SCHEDULE.room.intervalMs, () => runRoomStatsRefreshJob('stats-worker'));
        this.scheduleJob('room_stats_dirty_repair', STATS_WORKER_SCHEDULE.roomDirty.startupDelayMs, STATS_WORKER_SCHEDULE.roomDirty.intervalMs, () => runDirtyRoomStatsRepairJob('stats-worker'));
        this.scheduleJob('user_stats_refresh', STATS_WORKER_SCHEDULE.user.startupDelayMs, STATS_WORKER_SCHEDULE.user.intervalMs, () => runUserStatsRefreshJob('stats-worker'));
        this.scheduleJob('global_stats_refresh', STATS_WORKER_SCHEDULE.global.startupDelayMs, STATS_WORKER_SCHEDULE.global.intervalMs, () => runGlobalStatsRefreshJob('stats-worker'));

        if (this.schemeAConfig.event?.enableIncrementalStats) {
            this.scheduleJob('incremental_stats_aggregation', STATS_WORKER_SCHEDULE.incremental.startupDelayMs, STATS_WORKER_SCHEDULE.incremental.intervalMs, () => runIncrementalStatsAggregationJob('stats-worker'));
        }

        this.trackTimer(setTimeout(() => {
            this.runJobSafely('admin_async_job_poll:startup', () => processAvailableAdminAsyncJobs(JOB_QUEUE_STATS, {
                maxJobs: 2,
                runner: 'stats-worker',
            }));
        }, 2000));
        this.trackTimer(setInterval(() => {
            this.runJobSafely('admin_async_job_poll:interval', () => processAvailableAdminAsyncJobs(JOB_QUEUE_STATS, {
                maxJobs: 2,
                runner: 'stats-worker',
            }));
        }, ADMIN_ASYNC_JOB_POLL_INTERVAL_MS));

        this.shutdownPromise = new Promise((resolve) => {
            this.shutdownResolve = resolve;
        });

        await this.shutdownPromise;
    }

    requestShutdown(signal = 'SIGTERM') {
        if (this.shuttingDown) {
            return;
        }

        this.shuttingDown = true;
        metricsService.emitLog('info', 'stats.worker', {
            status: 'shutdown_requested',
            signal,
        });
        this.clearTimers();

        if (this.shutdownResolve) {
            this.shutdownResolve();
            this.shutdownResolve = null;
        }
    }
}

module.exports = {
    StatsWorker,
};
