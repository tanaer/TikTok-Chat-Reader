const db = require('../db');
const { EulerSigner } = require('tiktok-live-connector');

const PREMIUM_ROOM_LOOKUP_LEVELS = {
    UNSET: 'unset',
    BASIC: 'basic',
    PREMIUM: 'premium',
};

const PREMIUM_ROOM_LOOKUP_STATES = {
    UNKNOWN: 'unknown',
    ENABLED: 'enabled',
    DISABLED: 'disabled',
    RATE_LIMITED: 'rate_limited',
};

const SUCCESS_RECHECK_MS = 24 * 60 * 60 * 1000;
const FAILURE_RECHECK_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_RECHECK_MS = 2 * 60 * 60 * 1000;

function normalizePremiumRoomLookupLevel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return PREMIUM_ROOM_LOOKUP_LEVELS.UNSET;
    if (['premium', 'enabled', 'business'].includes(normalized)) return PREMIUM_ROOM_LOOKUP_LEVELS.PREMIUM;
    if (['basic', 'community', 'disabled', 'free'].includes(normalized)) return PREMIUM_ROOM_LOOKUP_LEVELS.BASIC;
    return PREMIUM_ROOM_LOOKUP_LEVELS.UNSET;
}

async function probeEulerKeyQuotaStatus(apiKey) {
    try {
        const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
        const response = await fetch('https://tiktok.eulerstream.com/webcast/rate_limits', {
            headers: { apiKey },
            signal: AbortSignal.timeout(8000),
        });
        return { status: Number(response.status || 0), ok: response.ok };
    } catch (err) {
        return { status: 0, ok: false, error: err.message };
    }
}

function isEulerQuotaProbeHealthy(status) {
    return [200, 404, 429].includes(Number(status || 0));
}

function isEulerQuotaProbeInvalid(status) {
    return [401, 403].includes(Number(status || 0));
}

function getPremiumRoomLookupState(row = {}) {
    const raw = String(row?.premiumRoomLookupState || row?.premium_room_lookup_state || 'unknown').trim().toLowerCase();
    if (Object.values(PREMIUM_ROOM_LOOKUP_STATES).includes(raw)) return raw;
    return PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN;
}

function getPremiumRoomLookupLevel(row = {}) {
    const manualLevel = normalizePremiumRoomLookupLevel(row?.premiumRoomLookupLevel || row?.premium_room_lookup_level || '');
    if (manualLevel !== PREMIUM_ROOM_LOOKUP_LEVELS.UNSET) {
        return manualLevel;
    }

    const legacyState = getPremiumRoomLookupState(row);
    if (legacyState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED) return PREMIUM_ROOM_LOOKUP_LEVELS.PREMIUM;
    if (legacyState === PREMIUM_ROOM_LOOKUP_STATES.DISABLED) return PREMIUM_ROOM_LOOKUP_LEVELS.BASIC;
    return PREMIUM_ROOM_LOOKUP_LEVELS.UNSET;
}

function supportsPremiumRoomLookup(row = {}) {
    return getPremiumRoomLookupLevel(row) === PREMIUM_ROOM_LOOKUP_LEVELS.PREMIUM;
}

function getPremiumRoomLookupCheckedAt(row = {}) {
    return row?.premiumRoomLookupCheckedAt || row?.premium_room_lookup_checked_at || null;
}

function getPremiumRoomLookupNextCheckMs(row = {}) {
    const checkedAt = getPremiumRoomLookupCheckedAt(row);
    if (!checkedAt) return 0;

    const checkedTime = new Date(checkedAt).getTime();
    if (!Number.isFinite(checkedTime) || checkedTime <= 0) return 0;

    const state = getPremiumRoomLookupState(row);
    if (state === PREMIUM_ROOM_LOOKUP_STATES.ENABLED) return checkedTime + SUCCESS_RECHECK_MS;
    if (state === PREMIUM_ROOM_LOOKUP_STATES.RATE_LIMITED) return checkedTime + RATE_LIMIT_RECHECK_MS;
    return checkedTime + FAILURE_RECHECK_MS;
}

function isPremiumRoomLookupProbeDue(row = {}, now = Date.now()) {
    return getPremiumRoomLookupNextCheckMs(row) <= now;
}

async function resolvePremiumProbeUniqueId(preferredUniqueId = '') {
    const normalizedPreferred = String(preferredUniqueId || process.env.EULER_PREMIUM_PROBE_UNIQUE_ID || '').trim().replace(/^@+/, '');
    if (normalizedPreferred) return normalizedPreferred;

    const liveRoom = await db.get(`SELECT room_id FROM room WHERE is_monitor_enabled = 1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`);
    if (liveRoom?.roomId) return String(liveRoom.roomId).trim().replace(/^@+/, '');

    const anyRoom = await db.get(`SELECT room_id FROM room ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`);
    if (anyRoom?.roomId) return String(anyRoom.roomId).trim().replace(/^@+/, '');

    return '';
}

async function persistPremiumRoomLookupProbeResult(keyId, result = {}) {
    if (!keyId) return;
    await db.run(
        `UPDATE euler_api_keys
            SET premium_room_lookup_state = ?,
                premium_room_lookup_checked_at = NOW(),
                premium_room_lookup_last_status = ?,
                premium_room_lookup_last_error = ?,
                premium_room_lookup_probe_unique_id = ?,
                updated_at = NOW()
          WHERE id = ?`,
        [
            result.state || PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN,
            Number(result.status || 0) || null,
            result.error || null,
            result.uniqueId || null,
            keyId,
        ]
    );
}

async function buildPremium401Result({ keyValue = '', currentState = PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN, status = 401, checkedUniqueId = '' } = {}) {
    const quotaProbe = await probeEulerKeyQuotaStatus(keyValue);
    if (isEulerQuotaProbeHealthy(quotaProbe.status)) {
        return {
            state: currentState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED
                ? PREMIUM_ROOM_LOOKUP_STATES.ENABLED
                : PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN,
            status,
            quotaProbeStatus: quotaProbe.status,
            uniqueId: checkedUniqueId,
            error: '额度探针正常，但 Premium room lookup 返回 401，暂不判定为无权限',
            supported: currentState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED,
            transient: true,
        };
    }

    if (isEulerQuotaProbeInvalid(quotaProbe.status)) {
        return {
            state: PREMIUM_ROOM_LOOKUP_STATES.DISABLED,
            status,
            quotaProbeStatus: quotaProbe.status,
            uniqueId: checkedUniqueId,
            error: 'Key 无效或已过期',
            supported: false,
            transient: false,
        };
    }

    return {
        state: currentState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED
            ? PREMIUM_ROOM_LOOKUP_STATES.ENABLED
            : PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN,
        status,
        quotaProbeStatus: quotaProbe.status || null,
        uniqueId: checkedUniqueId,
        error: 'Premium room lookup 返回 401，且额度探针未能确认 Key 状态，建议稍后重试',
        supported: currentState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED,
        transient: true,
    };
}

async function probePremiumRoomLookupCapability({ keyId = null, keyValue = '', currentState = PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN, uniqueId = '' } = {}) {
    const checkedUniqueId = await resolvePremiumProbeUniqueId(uniqueId);
    if (!checkedUniqueId) {
        return {
            state: PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN,
            status: 0,
            uniqueId: '',
            error: '暂无可用于 Premium 路由探测的房间 uniqueId',
            supported: false,
            transient: true,
        };
    }

    const signer = new EulerSigner({ apiKey: keyValue });

    try {
        const response = await signer.webcast.retrieveRoomId(checkedUniqueId);
        const payload = response?.data || {};
        const status = Number(payload?.code || response?.status || 0);
        const roomId = payload?.room_id ? String(payload.room_id) : null;
        const isLive = typeof payload?.is_live === 'boolean' ? payload.is_live : null;

        if (status === 200 && roomId) {
            return {
                state: PREMIUM_ROOM_LOOKUP_STATES.ENABLED,
                status,
                uniqueId: checkedUniqueId,
                roomId,
                isLive,
                error: null,
                supported: true,
                transient: false,
            };
        }

        if (status === 402 || status === 403) {
            return {
                state: PREMIUM_ROOM_LOOKUP_STATES.DISABLED,
                status,
                uniqueId: checkedUniqueId,
                error: status === 402
                    ? '当前套餐或额度不支持 Premium room lookup'
                    : '当前 Key 无权使用 Premium room lookup',
                supported: false,
                transient: false,
            };
        }

        if (status === 429) {
            return {
                state: currentState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED
                    ? PREMIUM_ROOM_LOOKUP_STATES.ENABLED
                    : PREMIUM_ROOM_LOOKUP_STATES.RATE_LIMITED,
                status,
                uniqueId: checkedUniqueId,
                error: 'Premium room lookup 当前被限流 (429)',
                supported: currentState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED,
                transient: true,
            };
        }

        if (status === 401) {
            return buildPremium401Result({
                keyValue,
                currentState,
                status,
                checkedUniqueId,
            });
        }

        return {
            state: PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN,
            status: status || 500,
            uniqueId: checkedUniqueId,
            error: String(payload?.message || 'Premium room lookup 探测失败').slice(0, 200),
            supported: false,
            transient: true,
        };
    } catch (err) {
        const responseStatus = Number(err?.response?.status || err?.statusCode || 0);
        const payload = err?.response?.data || {};
        const status = Number(payload?.code || responseStatus || 0);

        if (status === 429) {
            return {
                state: currentState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED
                    ? PREMIUM_ROOM_LOOKUP_STATES.ENABLED
                    : PREMIUM_ROOM_LOOKUP_STATES.RATE_LIMITED,
                status,
                uniqueId: checkedUniqueId,
                error: 'Premium room lookup 当前被限流 (429)',
                supported: currentState === PREMIUM_ROOM_LOOKUP_STATES.ENABLED,
                transient: true,
            };
        }

        if (status === 402 || status === 403) {
            return {
                state: PREMIUM_ROOM_LOOKUP_STATES.DISABLED,
                status,
                uniqueId: checkedUniqueId,
                error: status === 402
                    ? '当前套餐或额度不支持 Premium room lookup'
                    : '当前 Key 无权使用 Premium room lookup',
                supported: false,
                transient: false,
            };
        }

        if (status === 401) {
            return buildPremium401Result({
                keyValue,
                currentState,
                status,
                checkedUniqueId,
            });
        }

        return {
            state: PREMIUM_ROOM_LOOKUP_STATES.UNKNOWN,
            status: status || 500,
            uniqueId: checkedUniqueId,
            error: String(payload?.message || err?.message || 'Premium room lookup 探测失败').slice(0, 200),
            supported: false,
            transient: true,
        };
    }
}

module.exports = {
    PREMIUM_ROOM_LOOKUP_LEVELS,
    PREMIUM_ROOM_LOOKUP_STATES,
    normalizePremiumRoomLookupLevel,
    probeEulerKeyQuotaStatus,
    isEulerQuotaProbeHealthy,
    getPremiumRoomLookupState,
    getPremiumRoomLookupLevel,
    getPremiumRoomLookupCheckedAt,
    getPremiumRoomLookupNextCheckMs,
    isPremiumRoomLookupProbeDue,
    supportsPremiumRoomLookup,
    resolvePremiumProbeUniqueId,
    probePremiumRoomLookupCapability,
    persistPremiumRoomLookupProbeResult,
};
