const { manager } = require('../manager');
const { runSessionMaintenanceTask } = require('./sessionMaintenanceService');
const { runJob } = require('./jobRunner');

async function runCleanupStaleLiveEventsJob(trigger = 'manual', options = {}) {
    return runJob({
        jobName: 'maintenance.cleanup_stale_live_events',
        lockKey: 'maintenance.cleanup_stale_live_events',
        trigger,
        handler: async () => runSessionMaintenanceTask('cleanup_stale_live_events', {
            ...options,
            triggerSource: trigger,
        }),
    });
}

async function runConsolidateRecentSessionsJob(trigger = 'manual', options = {}) {
    return runJob({
        jobName: 'maintenance.consolidate_recent_sessions',
        lockKey: 'maintenance.consolidate_recent_sessions',
        trigger,
        handler: async () => runSessionMaintenanceTask('consolidate_recent_sessions', {
            ...options,
            triggerSource: trigger,
        }),
    });
}

async function runExpiredRoomCleanupJob(trigger = 'manual') {
    return runJob({
        jobName: 'maintenance.cleanup_expired_rooms',
        lockKey: 'maintenance.cleanup_expired_rooms',
        trigger,
        handler: async () => manager.cleanupExpiredRoomData(),
    });
}

module.exports = {
    runCleanupStaleLiveEventsJob,
    runConsolidateRecentSessionsJob,
    runExpiredRoomCleanupJob,
};
