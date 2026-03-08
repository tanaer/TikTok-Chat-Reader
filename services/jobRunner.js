const metricsService = require('./metricsService');
const { withPgAdvisoryLock } = require('./jobLockService');

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function runJob(options = {}) {
    const jobName = String(options.jobName || '').trim();
    if (!jobName) {
        throw new Error('jobName is required');
    }

    const trigger = String(options.trigger || 'manual').trim() || 'manual';
    const lockKey = String(options.lockKey || jobName).trim();
    const handler = options.handler;
    if (typeof handler !== 'function') {
        throw new Error(`handler is required for job ${jobName}`);
    }

    const startTime = Date.now();

    metricsService.emitLog('info', 'job.runner', {
        jobName,
        trigger,
        status: 'started',
        lockKey,
    });

    try {
        const lockResult = await withPgAdvisoryLock(lockKey, async (context) => {
            return await handler(context);
        }, { jobName });

        const durationMs = Date.now() - startTime;
        if (!lockResult.acquired) {
            metricsService.incrementCounter('job.runner.skipped', 1, { jobName, trigger }, { log: false });
            metricsService.recordTiming('job.runner.duration_ms', durationMs, { jobName, trigger, status: 'skipped' }, { log: false });
            metricsService.emitLog('warn', 'job.runner', {
                jobName,
                trigger,
                status: 'skipped',
                reason: 'lock_not_acquired',
                durationMs,
            });
            return {
                skipped: true,
                reason: 'lock_not_acquired',
                trigger,
                durationMs,
            };
        }

        const payload = isPlainObject(lockResult.result)
            ? lockResult.result
            : { result: lockResult.result };

        metricsService.incrementCounter('job.runner.success', 1, { jobName, trigger }, { log: false });
        metricsService.recordTiming('job.runner.duration_ms', durationMs, { jobName, trigger, status: 'success' }, { log: false });
        metricsService.emitLog('info', 'job.runner', {
            jobName,
            trigger,
            status: 'success',
            durationMs,
        });

        return payload;
    } catch (error) {
        const durationMs = Date.now() - startTime;
        metricsService.incrementCounter('job.runner.failure', 1, { jobName, trigger }, { log: false });
        metricsService.recordTiming('job.runner.duration_ms', durationMs, { jobName, trigger, status: 'error' }, { log: false });
        metricsService.emitLog('error', 'job.runner', {
            jobName,
            trigger,
            status: 'error',
            durationMs,
            error: metricsService.safeErrorMessage(error),
        });
        throw error;
    }
}

module.exports = {
    runJob,
};
