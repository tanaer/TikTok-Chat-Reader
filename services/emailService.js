/**
 * Email Service - SMTP email sending with verification code support
 */
const nodemailer = require('nodemailer');
const db = require('../db');

let cachedTransporter = null;
let cachedConfig = null;

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

/**
 * Generate a 6-digit verification code and store it
 */
async function sendVerificationCode(email) {
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Store in DB (upsert) - use NOW() + INTERVAL to avoid JS/PG timezone mismatch
    await db.pool.query(
        `INSERT INTO email_verification (email, code, expires_at, created_at)
         VALUES ($1, $2, NOW() + INTERVAL '10 minutes', NOW())
         ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = NOW() + INTERVAL '10 minutes', attempts = 0, created_at = NOW()`,
        [email.toLowerCase(), code]
    );

    await sendEmail(email, '验证码 - TikTok Monitor', `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #6366f1;">TikTok Monitor</h2>
            <p>您的邮箱验证码为：</p>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #6366f1; margin: 20px 0; text-align: center;">
                ${code}
            </div>
            <p style="color: #666; font-size: 14px;">验证码 10 分钟内有效，请勿泄露给他人。</p>
        </div>
    `);

    return true;
}

/**
 * Verify a code for the given email
 */
async function verifyCode(email, code) {
    const row = await db.get(
        `SELECT * FROM email_verification WHERE email = ? AND code = ? AND expires_at > NOW() AND attempts < 5`,
        [email.toLowerCase(), code]
    );
    if (!row) {
        // Increment attempts to prevent brute force
        await db.run(
            `UPDATE email_verification SET attempts = attempts + 1 WHERE email = ?`,
            [email.toLowerCase()]
        );
        return false;
    }

    // Delete after successful verification
    await db.run(`DELETE FROM email_verification WHERE email = ?`, [email.toLowerCase()]);
    return true;
}

/**
 * Check if SMTP is configured and email verification is enabled
 */
async function isEmailVerificationEnabled() {
    const settings = await db.getSystemSettings();
    if (settings.email_verification_enabled === false || settings.email_verification_enabled === 'false') {
        return false;
    }
    // Enabled if SMTP is configured
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

// Reset cached transporter when config changes
function resetTransporter() {
    cachedTransporter = null;
    cachedConfig = null;
}

module.exports = {
    sendEmail,
    sendVerificationCode,
    verifyCode,
    isEmailVerificationEnabled,
    testSmtp,
    resetTransporter,
    getSmtpConfig,
};
