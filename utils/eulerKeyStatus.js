function isEulerRateLimitMessage(message) {
    const normalized = String(message || '').trim().toLowerCase();
    if (!normalized) return false;

    return normalized.includes('rate limited')
        || normalized.includes('rate limit')
        || normalized.includes('too many requests')
        || normalized.includes('http 429')
        || normalized.includes('(429)')
        || normalized.includes('响应 429')
        || normalized.includes('限流');
}

function normalizeEulerKeyHealthStatus(lastStatus, lastError) {
    if (isEulerRateLimitMessage(lastError)) {
        return 'ok';
    }

    const normalizedStatus = String(lastStatus || 'unknown').trim().toLowerCase();
    if (normalizedStatus === 'ok') return 'ok';
    if (normalizedStatus === 'error') return 'error';
    return 'unknown';
}

module.exports = {
    isEulerRateLimitMessage,
    normalizeEulerKeyHealthStatus,
};
