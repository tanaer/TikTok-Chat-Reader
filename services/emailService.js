/**
 * Email Service - SMTP email sending with verification code support
 */
const nodemailer = require('nodemailer');
const db = require('../db');

let cachedTransporter = null;
let cachedConfig = null;

const EMAIL_CODE_PURPOSES = {
    register: {
        subject: '注册验证码 - TikTok Monitor',
        title: '注册验证码',
        intro: '您正在注册账号，验证码为：',
        footer: '验证码 10 分钟内有效，请勿泄露给他人。'
    },
    reset_password: {
        subject: '找回密码验证码 - TikTok Monitor',
        title: '找回密码',
        intro: '您正在重置登录密码，验证码为：',
        footer: '如非本人操作，请忽略本邮件。'
    },
    change_email: {
        subject: '修改邮箱验证码 - TikTok Monitor',
        title: '修改邮箱',
        intro: '您正在修改账户邮箱，验证码为：',
        footer: '该验证码用于验证当前邮箱所有权，请勿泄露给他人。'
    }
};

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function normalizePurpose(purpose = 'register') {
    return EMAIL_CODE_PURPOSES[purpose] ? purpose : 'register';
}

/**
 * Get SMTP config from database settings
 */
async function getSmtpConfig() {
    const settings = await db.getSystemSettings();
    return {
        host: settings.smtp_host || '',
        port: Number(settings.smtp_port || 465),
        secure: settings.smtp_secure !== false && settings.smtp_secure !== 'false',
        user: settings.smtp_user || '',
        pass: settings.smtp_pass || '',
        from: settings.smtp_from || settings.smtp_user || '',
        fromName: settings.smtp_from_name || 'TikTok Monitor',
    };
}

/**
 * Create or reuse nodemailer transporter
 */
async function getTransporter() {
    const config = await getSmtpConfig();
    const configKey = JSON.stringify(config);

    if (cachedTransporter && cachedConfig === configKey) {
        return cachedTransporter;
    }

    if (!config.host || !config.user || !config.pass) {
        return null;
    }

    cachedTransporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
    });
    cachedConfig = configKey;
    return cachedTransporter;
}

/**
 * Send email
 */
async function sendEmail(to, subject, html) {
    const config = await getSmtpConfig();
    const transporter = await getTransporter();
    if (!transporter) {
        throw new Error('SMTP 未配置');
    }

    return transporter.sendMail({
        from: `"${config.fromName}" <${config.from}>`,
        to,
        subject,
        html,
    });
}

async function hasRecentCodeRequest(email, { purpose = 'register', withinSeconds = 60, executor = db.pool } = {}) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedPurpose = normalizePurpose(purpose);
    const result = await executor.query(
        `SELECT created_at
         FROM email_verification
         WHERE email = $1 AND purpose = $2 AND created_at > NOW() - ($3 * INTERVAL '1 second')
         LIMIT 1`,
        [normalizedEmail, normalizedPurpose, Number(withinSeconds)]
    );
    return result.rows.length > 0;
}

/**
 * Generate a 6-digit verification code and store it
 */
async function sendVerificationCode(email, { purpose = 'register', executor = db.pool } = {}) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedPurpose = normalizePurpose(purpose);
    const template = EMAIL_CODE_PURPOSES[normalizedPurpose];
    const code = String(Math.floor(100000 + Math.random() * 900000));

    await executor.query(
        `INSERT INTO email_verification (email, purpose, code, expires_at, attempts, created_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', 0, NOW())
         ON CONFLICT (email, purpose)
         DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = NOW()`,
        [normalizedEmail, normalizedPurpose, code]
    );

    await sendEmail(normalizedEmail, template.subject, `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #6366f1;">TikTok Monitor</h2>
            <p>${template.intro}</p>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #6366f1; margin: 20px 0; text-align: center;">
                ${code}
            </div>
            <p style="color: #666; font-size: 14px;">${template.footer}</p>
        </div>
    `);

    return true;
}

/**
 * Verify a code for the given email and purpose
 */
async function verifyCode(email, code, { purpose = 'register', executor = db.pool, consume = true } = {}) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedPurpose = normalizePurpose(purpose);
    const normalizedCode = String(code || '').trim();

    const result = await executor.query(
        `SELECT code, expires_at, attempts
         FROM email_verification
         WHERE email = $1 AND purpose = $2
         FOR UPDATE`,
        [normalizedEmail, normalizedPurpose]
    );

    if (result.rows.length === 0) {
        return { ok: false, error: '验证码错误或已过期' };
    }

    const verification = result.rows[0];
    const expired = new Date(verification.expires_at).getTime() <= Date.now();
    const attemptsExceeded = Number(verification.attempts || 0) >= 5;
    if (expired || attemptsExceeded) {
        return { ok: false, error: '验证码错误或已过期' };
    }

    if (verification.code !== normalizedCode) {
        await executor.query(
            'UPDATE email_verification SET attempts = attempts + 1 WHERE email = $1 AND purpose = $2',
            [normalizedEmail, normalizedPurpose]
        );
        return { ok: false, error: '验证码错误或已过期' };
    }

    if (consume) {
        await executor.query(
            'DELETE FROM email_verification WHERE email = $1 AND purpose = $2',
            [normalizedEmail, normalizedPurpose]
        );
    }

    return { ok: true };
}

/**
 * Check if SMTP is configured and email verification is enabled
 */
async function isEmailVerificationEnabled() {
    const settings = await db.getSystemSettings();
    if (settings.email_verification_enabled === false || settings.email_verification_enabled === 'false') {
        return false;
    }
    return !!(settings.smtp_host && settings.smtp_user && settings.smtp_pass);
}

/**
 * Test SMTP connection
 */
async function testSmtp() {
    const transporter = await getTransporter();
    if (!transporter) {
        throw new Error('SMTP 未配置');
    }
    await transporter.verify();
    return true;
}

function resetTransporter() {
    cachedTransporter = null;
    cachedConfig = null;
}

module.exports = {
    EMAIL_CODE_PURPOSES,
    sendEmail,
    sendVerificationCode,
    verifyCode,
    hasRecentCodeRequest,
    isEmailVerificationEnabled,
    testSmtp,
    resetTransporter,
    getSmtpConfig,
};
