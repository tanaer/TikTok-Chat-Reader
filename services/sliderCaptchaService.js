const crypto = require('crypto');
const { JWT_SECRET } = require('../middleware/auth');

const SLIDER_CAPTCHA_PURPOSES = new Set(['login']);
const SLIDER_PASS_EXPIRES_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_THRESHOLD = 3;
const LOGIN_FAILURE_WINDOW_MS = 30 * 60 * 1000;
const SLIDER_PASS_KEY = crypto.createHash('sha256').update(`${JWT_SECRET}:login-captcha:pass:v2`).digest();
const sliderPassUsage = new Map();
const loginFailureUsage = new Map();

function cleanupPassUsage(now = Date.now()) {
    for (const [key, usage] of sliderPassUsage.entries()) {
        if (!usage || usage.expiresAt <= now || usage.consumed) {
            sliderPassUsage.delete(key);
        }
    }
}

function cleanupFailureUsage(now = Date.now()) {
    for (const [key, usage] of loginFailureUsage.entries()) {
        if (!usage || now - Number(usage.lastFailedAt || 0) > LOGIN_FAILURE_WINDOW_MS) {
            loginFailureUsage.delete(key);
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
    let normalized = raw.split(',')[0].trim().toLowerCase() || '127.0.0.1';
    if (normalized === '::1') return '127.0.0.1';
    if (normalized.startsWith('::ffff:')) normalized = normalized.slice(7);
    return normalized || '127.0.0.1';
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function getFailureState({ ip }) {
    cleanupFailureUsage();
    const key = normalizeIp(ip);
    const usage = loginFailureUsage.get(key);
    const count = usage ? Number(usage.count || 0) : 0;
    return {
        count,
        captchaRequired: count >= LOGIN_FAILURE_THRESHOLD,
        remainingBeforeCaptcha: Math.max(0, LOGIN_FAILURE_THRESHOLD - count),
    };
}

function isCaptchaRequired({ ip }) {
    return getFailureState({ ip }).captchaRequired;
}

function recordFailedAttempt({ ip }) {
    cleanupFailureUsage();
    const key = normalizeIp(ip);
    const current = loginFailureUsage.get(key) || { count: 0, lastFailedAt: 0 };
    const next = {
        count: Number(current.count || 0) + 1,
        lastFailedAt: Date.now(),
    };
    loginFailureUsage.set(key, next);
    return {
        count: next.count,
        captchaRequired: next.count >= LOGIN_FAILURE_THRESHOLD,
        remainingBeforeCaptcha: Math.max(0, LOGIN_FAILURE_THRESHOLD - next.count),
    };
}

function clearFailedAttempts({ ip }) {
    loginFailureUsage.delete(normalizeIp(ip));
}

function issuePassToken({ purpose, ip, userAgent }) {
    if (!SLIDER_CAPTCHA_PURPOSES.has(purpose)) {
        return { ok: false, error: '不支持的验证码用途' };
    }

    cleanupPassUsage();

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
        cleanupPassUsage();

        const payload = decryptPayload(passToken);
        const key = usageKey(passToken);
        const usage = sliderPassUsage.get(key);
        if (!usage) {
            return { ok: false, error: '验证码已失效，请重新验证' };
        }

        if (usage.consumed) {
            sliderPassUsage.delete(key);
            return { ok: false, error: '验证码已失效，请重新验证' };
        }

        if (Date.now() > Number(payload.expiresAt || 0) || Date.now() > Number(usage.expiresAt || 0)) {
            sliderPassUsage.delete(key);
            return { ok: false, error: '验证码已过期，请重新验证' };
        }

        if (payload.purpose !== purpose || usage.purpose !== purpose) {
            sliderPassUsage.delete(key);
            return { ok: false, error: '验证码用途不匹配，请重新验证' };
        }

        const currentIpFingerprint = fingerprint(normalizeIp(ip));
        const currentUserAgentFingerprint = fingerprint(normalizeUserAgent(userAgent));
        if (usage.ipFingerprint !== currentIpFingerprint || usage.userAgentFingerprint !== currentUserAgentFingerprint) {
            sliderPassUsage.delete(key);
            return { ok: false, error: '验证码环境已变化，请重新验证' };
        }

        usage.consumed = true;
        sliderPassUsage.set(key, usage);
        return { ok: true };
    } catch {
        return { ok: false, error: '验证码已失效，请重新验证' };
    }
}

module.exports = {
    SLIDER_CAPTCHA_PURPOSES,
    LOGIN_FAILURE_THRESHOLD,
    getFailureState,
    isCaptchaRequired,
    recordFailedAttempt,
    clearFailedAttempts,
    issuePassToken,
    consumePassToken,
};
