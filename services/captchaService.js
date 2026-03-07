const crypto = require('crypto');
const { JWT_SECRET } = require('../middleware/auth');

const CAPTCHA_EXPIRES_MS = 5 * 60 * 1000;
const CAPTCHA_LENGTH = 5;
const CAPTCHA_MAX_ATTEMPTS = 5;
const CAPTCHA_PURPOSES = new Set(['send-code']);
const CAPTCHA_TOKEN_KEY = crypto.createHash('sha256').update(`${JWT_SECRET}:captcha:v1`).digest();
const captchaUsage = new Map();

const DIGIT_SEGMENTS = {
    '0': ['a', 'b', 'c', 'd', 'e', 'f'],
    '1': ['b', 'c'],
    '2': ['a', 'b', 'g', 'e', 'd'],
    '3': ['a', 'b', 'g', 'c', 'd'],
    '4': ['f', 'g', 'b', 'c'],
    '5': ['a', 'f', 'g', 'c', 'd'],
    '6': ['a', 'f', 'g', 'e', 'c', 'd'],
    '7': ['a', 'b', 'c'],
    '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    '9': ['a', 'b', 'c', 'd', 'f', 'g'],
};

function base64UrlEncode(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function cleanupUsage(now = Date.now()) {
    for (const [key, value] of captchaUsage.entries()) {
        if (!value || value.expiresAt <= now) {
            captchaUsage.delete(key);
        }
    }
}

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

function generateCode(length = CAPTCHA_LENGTH) {
    let code = '';
    while (code.length < length) {
        code += String(crypto.randomInt(0, 10));
    }
    return code;
}

function segmentRect(segment) {
    const horizontal = { width: 14, height: 4, radius: 1.6 };
    const vertical = { width: 4, height: 14, radius: 1.6 };

    switch (segment) {
        case 'a': return { x: 5, y: 0, ...horizontal };
        case 'b': return { x: 19, y: 3, ...vertical };
        case 'c': return { x: 19, y: 19, ...vertical };
        case 'd': return { x: 5, y: 33, ...horizontal };
        case 'e': return { x: 1, y: 19, ...vertical };
        case 'f': return { x: 1, y: 3, ...vertical };
        case 'g': return { x: 5, y: 16, ...horizontal };
        default: return null;
    }
}

function renderDigit(digit, index) {
    const segments = DIGIT_SEGMENTS[digit] || [];
    const offsetX = 8 + index * 26 + randomBetween(-1.8, 1.8);
    const offsetY = 8 + randomBetween(-1.2, 1.2);
    const rotation = randomBetween(-10, 10).toFixed(2);
    const group = [];

    for (const segment of segments) {
        const rect = segmentRect(segment);
        if (!rect) continue;
        const fill = index % 2 === 0 ? '#1f2937' : '#111827';
        group.push(
            `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="${rect.radius}" fill="${fill}" opacity="0.92" />`
        );
    }

    return `<g transform="translate(${offsetX} ${offsetY}) rotate(${rotation})">${group.join('')}</g>`;
}

function buildSvg(code) {
    const width = 160;
    const height = 56;
    const noise = [];

    for (let i = 0; i < 7; i++) {
        noise.push(
            `<path d="M ${randomBetween(0, width).toFixed(1)} ${randomBetween(0, height).toFixed(1)} Q ${randomBetween(0, width).toFixed(1)} ${randomBetween(0, height).toFixed(1)} ${randomBetween(0, width).toFixed(1)} ${randomBetween(0, height).toFixed(1)}" stroke="rgba(99,102,241,0.28)" stroke-width="${randomBetween(1, 2.3).toFixed(1)}" fill="none" />`
        );
    }

    for (let i = 0; i < 24; i++) {
        noise.push(
            `<circle cx="${randomBetween(0, width).toFixed(1)}" cy="${randomBetween(0, height).toFixed(1)}" r="${randomBetween(0.6, 1.8).toFixed(1)}" fill="rgba(14,165,233,0.22)" />`
        );
    }

    const digits = code.split('').map(renderDigit).join('');

    return `
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="captcha">
            <rect width="100%" height="100%" rx="10" fill="#f8fafc" />
            <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="9" fill="none" stroke="rgba(99,102,241,0.28)" />
            ${noise.join('')}
            ${digits}
        </svg>
    `.trim();
}

function encryptPayload(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', CAPTCHA_TOKEN_KEY, iv);
    const encrypted = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return [base64UrlEncode(iv), base64UrlEncode(tag), base64UrlEncode(encrypted)].join('.');
}

function decryptToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
        throw new Error('invalid token');
    }

    const [ivPart, tagPart, encryptedPart] = parts;
    const iv = base64UrlDecode(ivPart);
    const tag = base64UrlDecode(tagPart);
    const encrypted = base64UrlDecode(encryptedPart);
    const decipher = crypto.createDecipheriv('aes-256-gcm', CAPTCHA_TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
}

function usageKey(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createCaptcha({ purpose, email }) {
    if (!CAPTCHA_PURPOSES.has(purpose)) {
        throw new Error('unsupported captcha purpose');
    }

    const normalizedEmail = normalizeEmail(email);
    const answer = generateCode();
    const expiresAt = Date.now() + CAPTCHA_EXPIRES_MS;
    const token = encryptPayload({
        answer,
        purpose,
        email: normalizedEmail,
        expiresAt,
        nonce: crypto.randomBytes(8).toString('hex')
    });

    captchaUsage.set(usageKey(token), { attempts: 0, consumed: false, expiresAt });
    cleanupUsage();

    return {
        captchaToken: token,
        svg: buildSvg(answer),
        expiresIn: Math.floor(CAPTCHA_EXPIRES_MS / 1000)
    };
}

function verifyCaptcha({ purpose, email, answer, captchaToken }) {
    try {
        cleanupUsage();

        const payload = decryptToken(captchaToken);
        const normalizedEmail = normalizeEmail(email);
        const normalizedAnswer = String(answer || '').trim();
        const key = usageKey(captchaToken);
        const usage = captchaUsage.get(key) || { attempts: 0, consumed: false, expiresAt: Number(payload.expiresAt || 0) };

        if (usage.consumed) {
            return { ok: false, status: 400, error: '图形验证码已失效，请刷新后重试' };
        }

        if (Date.now() > Number(payload.expiresAt || 0) || Date.now() > Number(usage.expiresAt || 0)) {
            captchaUsage.delete(key);
            return { ok: false, status: 400, error: '图形验证码已过期，请刷新后重试' };
        }

        if (usage.attempts >= CAPTCHA_MAX_ATTEMPTS) {
            captchaUsage.delete(key);
            return { ok: false, status: 429, error: '图形验证码尝试次数过多，请刷新后重试' };
        }

        if (payload.purpose !== purpose || payload.email !== normalizedEmail) {
            return { ok: false, status: 400, error: '图形验证码与当前邮箱不匹配，请刷新后重试' };
        }

        if (!/^\d{5}$/.test(normalizedAnswer)) {
            return { ok: false, status: 400, error: '请输入5位图形验证码' };
        }

        const expected = Buffer.from(String(payload.answer));
        const actual = Buffer.from(normalizedAnswer);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
            usage.attempts += 1;
            captchaUsage.set(key, usage);
            return { ok: false, status: 400, error: '图形验证码错误' };
        }

        usage.consumed = true;
        captchaUsage.set(key, usage);
        return { ok: true };
    } catch {
        return { ok: false, status: 400, error: '图形验证码已失效，请刷新后重试' };
    }
}

module.exports = {
    createCaptcha,
    verifyCaptcha,
    decryptToken,
};
