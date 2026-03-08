const { getSchemeAConfig } = require('./featureFlagService');

const counters = new Map();
const timings = new Map();

function isObservabilityEnabled() {
    return getSchemeAConfig().observability.enabled;
}

function normalizeTags(tags = {}) {
    return Object.fromEntries(
        Object.entries(tags).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );
}

function buildMetricKey(name, tags = {}) {
    const normalizedTags = normalizeTags(tags);
    return JSON.stringify({ name, tags: normalizedTags });
}

function safeErrorMessage(error) {
    if (!error) return null;
    if (typeof error === 'string') return error;
    return error.message || String(error);
}

function emitLog(level, event, fields = {}) {
    if (!isObservabilityEnabled()) return;

    const payload = {
        ts: new Date().toISOString(),
        scope: 'scheme_a',
        level,
        event,
        ...fields,
    };
    const line = `[OBS] ${JSON.stringify(payload)}`;

    if (level === 'error') {
        console.error(line);
        return;
    }
    if (level === 'warn') {
        console.warn(line);
        return;
    }
    console.log(line);
}

function incrementCounter(name, value = 1, tags = {}, options = {}) {
    if (!isObservabilityEnabled()) return 0;

    const key = buildMetricKey(name, tags);
    const nextValue = (counters.get(key) || 0) + value;
    counters.set(key, nextValue);

    if (options.log === true) {
        emitLog('info', 'metric.counter', {
            metric: name,
            value,
            total: nextValue,
            tags: normalizeTags(tags),
        });
    }

    return nextValue;
}

function recordTiming(name, durationMs, tags = {}, options = {}) {
    if (!isObservabilityEnabled()) return null;

    const safeDurationMs = Math.max(0, Number(durationMs) || 0);
    const key = buildMetricKey(name, tags);
    const current = timings.get(key) || {
        count: 0,
        totalMs: 0,
        maxMs: 0,
    };

    const next = {
        count: current.count + 1,
        totalMs: current.totalMs + safeDurationMs,
        maxMs: Math.max(current.maxMs, safeDurationMs),
    };
    timings.set(key, next);

    if (options.log === true) {
        emitLog('info', 'metric.timing', {
            metric: name,
            durationMs: safeDurationMs,
            avgMs: Number((next.totalMs / next.count).toFixed(2)),
            maxMs: next.maxMs,
            count: next.count,
            tags: normalizeTags(tags),
        });
    }

    return next;
}

function recordGauge(name, value, tags = {}, options = {}) {
    if (!isObservabilityEnabled()) return value;

    if (options.log === true) {
        emitLog('info', 'metric.gauge', {
            metric: name,
            value,
            tags: normalizeTags(tags),
        });
    }

    return value;
}

async function trackAsyncOperation(event, fields = {}, task) {
    const startTime = Date.now();

    try {
        const result = await task();
        const durationMs = Date.now() - startTime;
        recordTiming(event, durationMs, { ...fields, status: 'success' }, { log: false });
        emitLog('info', event, {
            ...fields,
            status: 'success',
            durationMs,
        });
        return result;
    } catch (error) {
        const durationMs = Date.now() - startTime;
        incrementCounter(`${event}.error`, 1, fields, { log: false });
        recordTiming(event, durationMs, { ...fields, status: 'error' }, { log: false });
        emitLog('error', event, {
            ...fields,
            status: 'error',
            durationMs,
            error: safeErrorMessage(error),
        });
        throw error;
    }
}

function getMetricsSnapshot() {
    return {
        counters: Array.from(counters.entries()).map(([key, value]) => ({ key: JSON.parse(key), value })),
        timings: Array.from(timings.entries()).map(([key, value]) => ({ key: JSON.parse(key), value })),
    };
}

module.exports = {
    isObservabilityEnabled,
    emitLog,
    incrementCounter,
    recordTiming,
    recordGauge,
    trackAsyncOperation,
    getMetricsSnapshot,
    safeErrorMessage,
};
