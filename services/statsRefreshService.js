const { manager } = require('../manager');
const { runJob } = require('./jobRunner');

const STATS_WORKER_SCHEDULE = {
    room: {
        startupDelayMs: 10000,
        intervalMs: 30 * 60 * 1000,
    },
    user: {
        startupDelayMs: 15000,
        intervalMs: 30 * 60 * 1000,
    },
    global: {
        startupDelayMs: 20000,
        intervalMs: 30 * 60 * 1000,
    },
};

async function runRoomStatsRefreshJob(trigger = 'manual') {
    return runJob({
        jobName: 'stats.room_refresh',
        lockKey: 'stats.room_refresh',
        trigger,
        handler: async () => manager.refreshRoomStats(),
    });
}

async function runUserStatsRefreshJob(trigger = 'manual') {
    return runJob({
        jobName: 'stats.user_refresh',
        lockKey: 'stats.user_refresh',
        trigger,
        handler: async () => manager.refreshUserStats(),
    });
}

async function runGlobalStatsRefreshJob(trigger = 'manual') {
    return runJob({
        jobName: 'stats.global_refresh',
        lockKey: 'stats.global_refresh',
        trigger,
        handler: async () => manager.refreshGlobalStats(),
    });
}

module.exports = {
    STATS_WORKER_SCHEDULE,
    runRoomStatsRefreshJob,
    runUserStatsRefreshJob,
    runGlobalStatsRefreshJob,
};
