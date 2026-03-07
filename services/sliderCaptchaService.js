const crypto = require('crypto');
const { JWT_SECRET } = require('../middleware/auth');

const SLIDER_CAPTCHA_PURPOSES = new Set(['login']);
const SLIDER_PASS_EXPIRES_MS = 5 * 60 * 1000;
const SLIDER_MAX_DURATION_MS = 20 * 1000;
const SLIDER_MIN_DURATION_MS = 300;
const SLIDER_MIN_TRAIL_LENGTH = 12;
const SLIDER_MAX_TRAIL_LENGTH = 256;
const SLIDER_PASS_KEY = crypto.createHash('sha256').update(`${JWT_SECRET}:slider:pass:v1`).digest();
const sliderPassUsage = new Map();

function cleanupUsage(now = Date.now()) {
    for (const [key, usage] of sliderPassUsage.entries()) {
        if (!usage || usage.expiresAt <= now || usage.consumed) {
            sliderPassUsage.delete(key);
        }
    }
}

function base64UrlEncode(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
}

function encryptPayload(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', SLIDER_PASS_KEY, iv);
    const encrypted = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return [base64UrlEncode(iv), base64UrlEncode(tag), base64UrlEncode(encrypted)].join('.');
}

function decryptPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
        throw new Error('invalid token');
    }

    const [ivPart, tagPart, encryptedPart] = parts;
    const iv = base64UrlDecode(ivPart);
    const tag = base64UrlDecode(tagPart);
    const encrypted = base64UrlDecode(encryptedPart);
    const decipher = crypto.createDecipheriv('aes-256-gcm', SLIDER_PASS_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
}

function usageKey(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeUserAgent(userAgent) {
    return String(userAgent || '').trim().toLowerCase();
}

function normalizeIp(ip) {
    const raw = Array.isArray(ip) ? ip[0] : String(ip || '');
    return raw.split(',')[0].trim();
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function analyzeTrail(trail, durationMs) {
    if (!Array.isArray(trail)) {
        return { ok: false, error: '滑块验证数据无效' };
    }

    const normalizedTrail = trail
        .map(value => Number(value))
        .filter(value => Number.isFinite(value))
        .slice(0, SLIDER_MAX_TRAIL_LENGTH)
        .map(value => Math.round(value));

    if (normalizedTrail.length < SLIDER_MIN_TRAIL_LENGTH) {
        return { ok: false, error: '滑块轨迹过短，请重试' };
    }

    const normalizedDuration = Number(durationMs || 0);
    if (!Number.isFinite(normalizedDuration) || normalizedDuration < SLIDER_MIN_DURATION_MS || normalizedDuration > SLIDER_MAX_DURATION_MS) {
        return { ok: false, error: '滑块验证超时或过快，请重试' };
    }

    const uniqueValues = new Set(normalizedTrail);
    if (uniqueValues.size < 2) {
        return { ok: false, error: '滑块轨迹异常，请重试' };
    }

    const nonZeroMoves = normalizedTrail.filter(value => value !== 0).length;
    if (nonZeroMoves < 2) {
        return { ok: false, error: '滑块轨迹过于机械，请重试' };
    }

    const sum = normalizedTrail.reduce((acc, value) => acc + value, 0);
    const average = sum / normalizedTrail.length;
    const variance = normalizedTrail.reduce((acc, value) => acc + Math.pow(value - average, 2), 0) / normalizedTrail.length;
    if (!Number.isFinite(variance) || variance <= 0) {
        return { ok: false, error: '滑块轨迹校验失败，请重试' };
    }

    return { ok: true };
}

function issuePassToken({ purpose, ip, userAgent }) {
    if (!SLIDER_CAPTCHA_PURPOSES.has(purpose)) {
        return { ok: false, error: '不支持的滑块用途' };
    }

    cleanupUsage();

    const expiresAt = Date.now() + SLIDER_PASS_EXPIRES_MS;
    const token = encryptPayload({
        purpose,
        expiresAt,
        nonce: crypto.randomBytes(10).toString('hex')
    });

    sliderPassUsage.set(usageKey(token), {
        purpose,
        expiresAt,
        consumed: false,
        ipFingerprint: fingerprint(normalizeIp(ip)),
        userAgentFingerprint: fingerprint(normalizeUserAgent(userAgent))
    });

    return {
        ok: true,
        passToken: token,
        expiresIn: Math.floor(SLIDER_PASS_EXPIRES_MS / 1000)
    };
}

function consumePassToken({ purpose, passToken, ip, userAgent }) {
    try {
        cleanupUsage();

        const payload = decryptPayload(passToken);
        const key = usageKey(passToken);
        const usage = sliderPassUsage.get(key);
        if (!usage) {
            return { ok: false, error: '滑块验证已失效，请重新验证' };
        }

        if (usage.consumed) {
            sliderPassUsage.delete(key);
            return { ok: false, error: '滑块验证已失效，请重新验证' };
        }

        if (Date.now() > Number(payload.expiresAt || 0) || Date.now() > Number(usage.expiresAt || 0)) {
            sliderPassUsage.delete(key);
            return { ok: false, error: '滑块验证已过期，请重新验证' };
        }

        if (payload.purpose !== purpose || usage.purpose !== purpose) {
            sliderPassUsage.delete(key);
            return { ok: false, error: '滑块验证用途不匹配，请重新验证' };
        }

        const currentIpFingerprint = fingerprint(normalizeIp(ip));
        const currentUserAgentFingerprint = fingerprint(normalizeUserAgent(userAgent));
        if (usage.ipFingerprint !== currentIpFingerprint || usage.userAgentFingerprint !== currentUserAgentFingerprint) {
            sliderPassUsage.delete(key);
            return { ok: false, error: '滑块验证环境已变化，请重新验证' };
        }

        usage.consumed = true;
        sliderPassUsage.set(key, usage);
        return { ok: true };
    } catch {
        return { ok: false, error: '滑块验证已失效，请重新验证' };
    }
}

module.exports = {
    analyzeTrail,
    issuePassToken,
    consumePassToken,
    SLIDER_CAPTCHA_PURPOSES,
};
