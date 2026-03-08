require('dotenv').config();

const db = require('../db');
const metricsService = require('../services/metricsService');
const { getSchemeAConfig } = require('../services/featureFlagService');
const { getSessionMaintenanceConfig } = require('../services/sessionMaintenanceService');
const {
    runCleanupStaleLiveEventsJob,
    runConsolidateRecentSessionsJob,
    runExpiredRoomCleanupJob,
} = require('../services/maintenanceJobService');

const EXPIRED_ROOM_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EXPIRED_ROOM_CLEANUP_STARTUP_DELAY_MS = 60 * 1000;

class MaintenanceWorker {
    constructor(options = {}) {
        this.schemeAConfig = options.schemeAConfig || getSchemeAConfig();
        this.shuttingDown = false;
        this.shutdownPromise = null;
        this.shutdownResolve = null;
        this.timers = {
            staleCleanup: null,
            consolidation: null,
            expiredRoomInterval: null,
            expiredRoomStartup: null,
        };
    }

    async init() {
        await db.initDb();

        if (!this.schemeAConfig.worker.enableMaintenance) {
            metricsService.emitLog('warn', 'maintenance.worker', {
                status: 'disabled',
                reason: 'feature_flag_off',
            });
            return false;
        }

        metricsService.emitLog('info', 'maintenance.worker', {
            status: 'started',
            expiredRoomCleanupIntervalMs: EXPIRED_ROOM_CLEANUP_INTERVAL_MS,
        });
        return true;
    }

    clearTimer(name) {
        const timerId = this.timers[name];
        if (timerId) {
            clearTimeout(timerId);
            clearInterval(timerId);
            this.timers[name] = null;
        }
    }

    clearTimers() {
        for (const name of Object.keys(this.timers)) {
            this.clearTimer(name);
        }
    }

    async runJobSafely(jobName, runner) {
        if (this.shuttingDown) return;
        try {
            await runner();
        } catch (error) {
            console.error(`[MAINTENANCE_WORKER] ${jobName} failed:`, error.message);
        }
    }

    async scheduleSessionTask(taskName, reason = 'manual') {
        this.clearTimer(taskName);
        if (this.shuttingDown) return;

        const config = await getSessionMaintenanceConfig();
        const intervalMinutes = taskName === 'staleCleanup'
            ? Number(config.staleCleanupIntervalMinutes || 0)
            : Number(config.consolidationIntervalMinutes || 0);

        if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
            return;
        }

        this.timers[taskName] = setTimeout(async () => {
            try {
                const latestConfig = await getSessionMaintenanceConfig();
                if (taskName === 'staleCleanup') {
                    await runCleanupStaleLiveEventsJob('maintenance-worker-interval', {
                        configOverride: latestConfig,
                    });
                } else {
                    await runConsolidateRecentSessionsJob('maintenance-worker-interval', {
                        configOverride: latestConfig,
                    });
                }
            } finally {
                await this.scheduleSessionTask(taskName, 'reschedule');
            }
        }, intervalMinutes * 60 * 1000);

        if (reason !== 'reschedule') {
            console.log(`[MAINTENANCE_WORKER] Scheduled ${taskName} every ${intervalMinutes} minute(s)`);
        }
    }

    scheduleExpiredRoomCleanup() {
        this.clearTimer('expiredRoomStartup');
        this.clearTimer('expiredRoomInterval');
        if (this.shuttingDown) return;

        this.timers.expiredRoomStartup = setTimeout(() => {
            this.runJobSafely('expired_room_cleanup:start', () => runExpiredRoomCleanupJob('maintenance-worker-startup'));
        }, EXPIRED_ROOM_CLEANUP_STARTUP_DELAY_MS);

        this.timers.expiredRoomInterval = setInterval(() => {
            this.runJobSafely('expired_room_cleanup:interval', () => runExpiredRoomCleanupJob('maintenance-worker-interval'));
        }, EXPIRED_ROOM_CLEANUP_INTERVAL_MS);
    }

    async runStartupMaintenance() {
        const config = await getSessionMaintenanceConfig();

        if (config.startupCleanupEnabled) {
            await this.runJobSafely('cleanup_stale_live_events:startup', () => runCleanupStaleLiveEventsJob('maintenance-worker-startup', {
                configOverride: config,
            }));
        }

        if (config.startupConsolidationEnabled) {
            await this.runJobSafely('consolidate_recent_sessions:startup', () => runConsolidateRecentSessionsJob('maintenance-worker-startup', {
                configOverride: config,
            }));
        }
    }

    async run() {
        const enabled = await this.init();
        if (!enabled) {
            return;
        }

        await this.runStartupMaintenance();
        await this.scheduleSessionTask('staleCleanup', 'startup');
        await this.scheduleSessionTask('consolidation', 'startup');
        this.scheduleExpiredRoomCleanup();

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
        metricsService.emitLog('info', 'maintenance.worker', {
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
    MaintenanceWorker,
};
