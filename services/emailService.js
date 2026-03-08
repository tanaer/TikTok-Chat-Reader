/**
 * Email Service - SMTP email sending with verification code support
 */
const nodemailer = require('nodemailer');
const db = require('../db');

const SMTP_FAILURE_COOLDOWN_MS = (() => {
    const raw = parseInt(process.env.SMTP_FAILURE_COOLDOWN_MS || `${5 * 60 * 1000}`, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();

const transporterCache = new Map();

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

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function normalizeInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeErrorMessage(error) {
    return String(error?.message || error || '未知错误').trim().slice(0, 200);
}

function getCooldownUntilIso() {
    return new Date(Date.now() + SMTP_FAILURE_COOLDOWN_MS).toISOString();
}

function normalizeSmtpServiceRow(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        name: String(row.name || '').trim() || `SMTP #${row.id}`,
        host: String(row.host || '').trim(),
        port: normalizeInteger(row.port, 465),
        secure: normalizeBoolean(row.secure, true),
        username: String(row.username || '').trim(),
        password: String(row.password || ''),
        fromEmail: String(row.fromEmail || row.from_email || row.username || '').trim(),
        fromName: String(row.fromName || row.from_name || 'TikTok Monitor').trim() || 'TikTok Monitor',
        isActive: normalizeBoolean(row.isActive ?? row.is_active, true),
        isDefault: normalizeBoolean(row.isDefault ?? row.is_default, false),
        callCount: Number(row.callCount || row.call_count || 0),
        successCount: Number(row.successCount || row.success_count || 0),
        failCount: Number(row.failCount || row.fail_count || 0),
        consecutiveFailures: Number(row.consecutiveFailures || row.consecutive_failures || 0),
        avgLatencyMs: Number(row.avgLatencyMs || row.avg_latency_ms || 0),
        lastUsedAt: row.lastUsedAt || row.last_used_at || null,
        cooldownUntil: row.cooldownUntil || row.cooldown_until || null,
        lastError: String(row.lastError || row.last_error || ''),
        lastStatus: String(row.lastStatus || row.last_status || 'unknown'),
        createdAt: row.createdAt || row.created_at || null,
        updatedAt: row.updatedAt || row.updated_at || null,
    };
}

function buildLegacySmtpService(settings) {
    if (!settings?.smtp_host || !settings?.smtp_user || !settings?.smtp_pass) {
        return null;
    }
    return {
        name: '旧版 SMTP 配置（迁移）',
        host: String(settings.smtp_host || '').trim(),
        port: normalizeInteger(settings.smtp_port, 465),
        secure: normalizeBoolean(settings.smtp_secure, true),
        username: String(settings.smtp_user || '').trim(),
        password: String(settings.smtp_pass || ''),
        fromEmail: String(settings.smtp_from || settings.smtp_user || '').trim(),
        fromName: String(settings.smtp_from_name || 'TikTok Monitor').trim() || 'TikTok Monitor',
    };
}

async function ensureLegacySmtpMigration() {
    const existing = await db.get('SELECT id FROM smtp_services LIMIT 1');
    if (existing?.id) return;

    const settings = await db.getSystemSettings();
    if (normalizeBoolean(settings.smtp_legacy_migrated, false)) {
        return;
    }
    const legacy = buildLegacySmtpService(settings);
    if (!legacy) return;

    const result = await db.pool.query(
        `INSERT INTO smtp_services (
            name, host, port, secure, username, password, from_email, from_name,
            is_active, is_default, last_status, created_at, updated_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, true, true, 'migrated', NOW(), NOW()
         WHERE NOT EXISTS (SELECT 1 FROM smtp_services)`,
        [
            legacy.name,
            legacy.host,
            legacy.port,
            legacy.secure,
            legacy.username,
            legacy.password,
            legacy.fromEmail,
            legacy.fromName,
        ]
    );

    if (result.rowCount > 0) {
        await db.pool.query(
            `INSERT INTO settings (key, value, updated_at) VALUES ('smtp_legacy_migrated', 'true', NOW())
             ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`
        );
    }
}

async function listSmtpServices({ includeInactive = true } = {}) {
    await ensureLegacySmtpMigration();

    const sql = includeInactive
        ? `SELECT id, name, host, port, secure, username, password, from_email, from_name,
                  is_active, is_default, call_count, success_count, fail_count,
                  consecutive_failures, avg_latency_ms, last_used_at, cooldown_until,
                  last_error, last_status, created_at, updated_at
           FROM smtp_services
           ORDER BY is_default DESC, is_active DESC, id`
        : `SELECT id, name, host, port, secure, username, password, from_email, from_name,
                  is_active, is_default, call_count, success_count, fail_count,
                  consecutive_failures, avg_latency_ms, last_used_at, cooldown_until,
                  last_error, last_status, created_at, updated_at
           FROM smtp_services
           WHERE is_active = true
           ORDER BY is_default DESC, id`;

    const rows = await db.all(sql);
    return rows.map(normalizeSmtpServiceRow);
}

async function getSmtpServiceById(serviceId) {
    await ensureLegacySmtpMigration();
    const row = await db.get(
        `SELECT id, name, host, port, secure, username, password, from_email, from_name,
                is_active, is_default, call_count, success_count, fail_count,
                consecutive_failures, avg_latency_ms, last_used_at, cooldown_until,
                last_error, last_status, created_at, updated_at
         FROM smtp_services
         WHERE id = ?`,
        [serviceId]
    );
    return normalizeSmtpServiceRow(row);
}

function isServiceCooling(service) {
    if (!service?.cooldownUntil) return false;
    const cooldownUntil = new Date(service.cooldownUntil).getTime();
    return Number.isFinite(cooldownUntil) && cooldownUntil > Date.now();
}

function orderSmtpCandidates(services) {
    return [...services].sort((left, right) => {
        const leftCooling = isServiceCooling(left) ? 1 : 0;
        const rightCooling = isServiceCooling(right) ? 1 : 0;
        if (leftCooling !== rightCooling) return leftCooling - rightCooling;
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
        if (left.successCount !== right.successCount) return right.successCount - left.successCount;
        return left.id - right.id;
    });
}

async function getPreferredSmtpService() {
    const services = await listSmtpServices({ includeInactive: false });
    if (!services.length) return null;
    return orderSmtpCandidates(services)[0] || null;
}

async function getSmtpConfig() {
    return getPreferredSmtpService();
}

function buildTransporterOptions(service) {
    return {
        host: service.host,
        port: service.port,
        secure: service.secure,
        auth: {
            user: service.username,
            pass: service.password,
        },
    };
}

async function getTransporterForService(service) {
    if (!service?.host || !service?.username || !service?.password) {
        return null;
    }

    const configKey = JSON.stringify({
        host: service.host,
        port: service.port,
        secure: service.secure,
        username: service.username,
        password: service.password,
    });
    const cacheKey = String(service.id || `${service.host}:${service.port}:${service.username}`);
    const cached = transporterCache.get(cacheKey);
    if (cached && cached.configKey === configKey) {
        return cached.transporter;
    }

    const transporter = nodemailer.createTransport(buildTransporterOptions(service));
    transporterCache.set(cacheKey, { configKey, transporter });
    return transporter;
}

async function updateSmtpServiceHealth(serviceId, { status, error = '', latencyMs = 0, countAsDelivery = false } = {}) {
    if (!serviceId) return;
    const normalizedLatencyMs = Math.max(0, Number(latencyMs) || 0);

    if (status === 'ok') {
        if (countAsDelivery) {
            await db.pool.query(
                `UPDATE smtp_services
                 SET call_count = COALESCE(call_count, 0) + 1,
                     success_count = COALESCE(success_count, 0) + 1,
                     consecutive_failures = 0,
                     cooldown_until = NULL,
                     last_error = NULL,
                     last_status = 'ok',
                     last_used_at = NOW(),
                     avg_latency_ms = (
                         CASE
                             WHEN COALESCE(success_count, 0) <= 0 THEN $2::numeric
                             ELSE ROUND((((COALESCE(avg_latency_ms, 0) * COALESCE(success_count, 0))::numeric) + $2::numeric) / (COALESCE(success_count, 0) + 1.0))
                         END
                     )::integer,
                     updated_at = NOW()
                 WHERE id = $1`,
                [serviceId, normalizedLatencyMs]
            );
            return;
        }

        await db.pool.query(
            `UPDATE smtp_services
             SET consecutive_failures = 0,
                 cooldown_until = NULL,
                 last_error = NULL,
                 last_status = 'ok',
                 updated_at = NOW()
             WHERE id = $1`,
            [serviceId]
        );
        return;
    }

    const cooldownUntil = getCooldownUntilIso();
    const errorMessage = sanitizeErrorMessage(error);
    if (countAsDelivery) {
        await db.pool.query(
            `UPDATE smtp_services
             SET call_count = COALESCE(call_count, 0) + 1,
                 fail_count = COALESCE(fail_count, 0) + 1,
                 consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
                 cooldown_until = $2,
                 last_error = $3,
                 last_status = 'error',
                 last_used_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [serviceId, cooldownUntil, errorMessage]
        );
        return;
    }

    await db.pool.query(
        `UPDATE smtp_services
         SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
             cooldown_until = $2,
             last_error = $3,
             last_status = 'error',
             updated_at = NOW()
         WHERE id = $1`,
        [serviceId, cooldownUntil, errorMessage]
    );
}

async function sendEmailThroughService(service, { to, subject, html }) {
    const transporter = await getTransporterForService(service);
    if (!transporter) {
        throw new Error('SMTP 服务配置不完整');
    }

    const startedAt = Date.now();
    await transporter.sendMail({
        from: `"${service.fromName}" <${service.fromEmail || service.username}>`,
        to,
        subject,
        html,
    });
    await updateSmtpServiceHealth(service.id, {
        status: 'ok',
        latencyMs: Date.now() - startedAt,
        countAsDelivery: true,
    });

    return {
        serviceId: service.id,
        serviceName: service.name,
    };
}

async function sendEmail(to, subject, html, { serviceId } = {}) {
    if (serviceId) {
        const service = await getSmtpServiceById(serviceId);
        if (!service || !service.isActive) {
            throw new Error('SMTP 服务不存在或已禁用');
        }
        try {
            return await sendEmailThroughService(service, { to, subject, html });
        } catch (error) {
            resetTransporter(service.id);
            await updateSmtpServiceHealth(service.id, {
                status: 'error',
                error,
                countAsDelivery: true,
            });
            throw error;
        }
    }

    const services = await listSmtpServices({ includeInactive: false });
    if (!services.length) {
        throw new Error('SMTP 未配置');
    }

    const candidates = orderSmtpCandidates(services);
    const errors = [];
    for (const service of candidates) {
        try {
            return await sendEmailThroughService(service, { to, subject, html });
        } catch (error) {
            resetTransporter(service.id);
            await updateSmtpServiceHealth(service.id, {
                status: 'error',
                error,
                countAsDelivery: true,
            });
            errors.push(`${service.name}: ${sanitizeErrorMessage(error)}`);
        }
    }

    throw new Error(errors.length ? `所有 SMTP 服务均不可用：${errors.join('；')}` : 'SMTP 未配置');
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

async function getEmailFeatureConfig() {
    const settings = await db.getSystemSettings();
    return {
        emailVerificationEnabled: normalizeBoolean(settings.email_verification_enabled, true),
    };
}

async function saveEmailFeatureConfig({ emailVerificationEnabled }) {
    await db.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('email_verification_enabled', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [String(Boolean(emailVerificationEnabled))]
    );
}

/**
 * Check if SMTP is configured and email verification is enabled
 */
async function isEmailVerificationEnabled() {
    const config = await getEmailFeatureConfig();
    if (!config.emailVerificationEnabled) {
        return false;
    }
    const services = await listSmtpServices({ includeInactive: false });
    return services.length > 0;
}

/**
 * Test SMTP connection
 */
async function testSmtp(serviceId = null) {
    const service = serviceId ? await getSmtpServiceById(serviceId) : await getPreferredSmtpService();
    if (!service || !service.isActive) {
        throw new Error('SMTP 未配置');
    }

    const transporter = await getTransporterForService(service);
    if (!transporter) {
        throw new Error('SMTP 服务配置不完整');
    }

    try {
        await transporter.verify();
        await updateSmtpServiceHealth(service.id, { status: 'ok' });
    } catch (error) {
        resetTransporter(service.id);
        await updateSmtpServiceHealth(service.id, { status: 'error', error });
        throw error;
    }
    return true;
}

function resetTransporter(serviceId = null) {
    if (!serviceId) {
        transporterCache.clear();
        return;
    }
    transporterCache.delete(String(serviceId));
}

module.exports = {
    EMAIL_CODE_PURPOSES,
    SMTP_FAILURE_COOLDOWN_MS,
    sendEmail,
    sendVerificationCode,
    verifyCode,
    hasRecentCodeRequest,
    isEmailVerificationEnabled,
    testSmtp,
    resetTransporter,
    getSmtpConfig,
    listSmtpServices,
    getSmtpServiceById,
    getEmailFeatureConfig,
    saveEmailFeatureConfig,
};
