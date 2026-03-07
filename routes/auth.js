const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../db');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const captchaService = require('../services/captchaService');
const sliderCaptchaService = require('../services/sliderCaptchaService');
const { authenticate, optionalAuth } = require('../middleware/auth');

const router = express.Router();

const SUPPORTED_EMAIL_CODE_PURPOSES = ['register', 'reset_password', 'change_email'];
const SUPPORTED_SLIDER_CAPTCHA_PURPOSES = Array.from(sliderCaptchaService.SLIDER_CAPTCHA_PURPOSES);

function normalizeEmailInput(email) {
    return String(email || '').trim().toLowerCase();
}

function resolveEmailCodeTarget(req, purpose) {
    let normalizedEmail = req.body.email ? normalizeEmailInput(req.body.email) : '';

    if (purpose === 'change_email') {
        if (!req.user) {
            return { ok: false, status: 401, error: '请先登录' };
        }
        if (!req.user.email) {
            return { ok: false, status: 400, error: '当前账号未绑定邮箱，暂不支持修改邮箱' };
        }
        normalizedEmail = normalizeEmailInput(req.user.email);
    }

    if (!normalizedEmail) {
        return { ok: false, status: 400, error: '请输入有效的邮箱地址' };
    }

    return { ok: true, email: normalizedEmail };
}

async function validateEmailCodeTarget({ purpose, email }) {
    const normalizedEmail = normalizeEmailInput(email);

    if (purpose === 'register') {
        const existing = await db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (existing) {
            return { ok: false, status: 409, error: '该邮箱已被注册' };
        }
    } else if (purpose === 'reset_password') {
        const user = await db.get('SELECT id, status FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
        if (!user) {
            return { ok: false, status: 404, error: '该邮箱未注册' };
        }
        if (user.status !== 'active') {
            return { ok: false, status: 403, error: '账户已被禁用' };
        }
    }

    return { ok: true, email: normalizedEmail };
}

/**
 * GET /api/auth/email-verification-status
 * Check if email verification is required
 */
router.get('/email-verification-status', async (req, res) => {
    try {
        const required = await emailService.isEmailVerificationEnabled();
        res.json({ required });
    } catch (err) {
        res.json({ required: false });
    }
});

/**
 * GET /api/auth/captcha
 * Create captcha for public auth flows
 */
router.get('/captcha', [
    query('purpose').equals('send-code').withMessage('不支持的验证码用途'),
    query('email').isEmail().withMessage('请输入有效的邮箱地址'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { purpose, email } = req.query;
        const captcha = captchaService.createCaptcha({ purpose, email });
        res.set('Cache-Control', 'no-store');
        return res.json(captcha);
    } catch (err) {
        console.error('[Auth] Captcha create error:', err.message);
        return res.status(500).json({ error: '验证码生成失败，请稍后重试' });
    }
});

/**
 * POST /api/auth/check-code-target
 * Validate email eligibility before captcha / sending code
 */
router.post('/check-code-target', optionalAuth, [
    body('purpose').optional().isIn(SUPPORTED_EMAIL_CODE_PURPOSES).withMessage('不支持的验证码用途'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('请输入有效的邮箱地址'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const purpose = req.body.purpose || 'register';
        const target = resolveEmailCodeTarget(req, purpose);
        if (!target.ok) {
            return res.status(target.status).json({ error: target.error });
        }

        const validation = await validateEmailCodeTarget({ purpose, email: target.email });
        if (!validation.ok) {
            return res.status(validation.status).json({ error: validation.error });
        }

        return res.json({ ok: true, email: validation.email });
    } catch (err) {
        console.error('[Auth] Check code target error:', err.message);
        return res.status(500).json({ error: '校验邮箱失败，请稍后重试' });
    }
});

/**
 * POST /api/auth/register-availability
 * Check register username/email availability
 */
router.post('/register-availability', [
    body('username').optional({ values: 'falsy' }).trim().isLength({ min: 3, max: 50 }).withMessage('用户名3-50个字符'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('请输入有效的邮箱地址'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const username = String(req.body.username || '').trim();
        const normalizedEmail = req.body.email ? normalizeEmailInput(req.body.email) : '';

        if (!username && !normalizedEmail) {
            return res.status(400).json({ error: '请提供用户名或邮箱' });
        }

        const result = {};

        if (username) {
            const existingUser = await db.get('SELECT id FROM users WHERE username = ?', [username]);
            result.username = {
                checked: true,
                available: !existingUser,
                message: existingUser ? '用户名已被注册' : '用户名可用'
            };
        }

        if (normalizedEmail) {
            const existingEmail = await db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [normalizedEmail]);
            result.email = {
                checked: true,
                available: !existingEmail,
                message: existingEmail ? '邮箱已被注册' : '邮箱可用'
            };
        }

        return res.json(result);
    } catch (err) {
        console.error('[Auth] Register availability error:', err.message);
        return res.status(500).json({ error: '检查注册信息失败，请稍后重试' });
    }
});

/**
 * POST /api/auth/slider-captcha/verify
 * Verify slider captcha trail and issue short-lived pass token
 */
router.post('/slider-captcha/verify', [
    body('purpose').optional().isIn(SUPPORTED_SLIDER_CAPTCHA_PURPOSES).withMessage('不支持的滑块验证用途'),
    body('trail').isArray({ min: 1 }).withMessage('缺少滑块轨迹'),
    body('trail.*').optional().isInt({ min: -200, max: 200 }).withMessage('滑块轨迹数据无效'),
    body('durationMs').isInt({ min: 1, max: 30000 }).withMessage('滑块验证时长无效'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const purpose = req.body.purpose || 'login';
        const trailCheck = sliderCaptchaService.analyzeTrail(req.body.trail, req.body.durationMs);
        if (!trailCheck.ok) {
            return res.status(400).json({ error: trailCheck.error });
        }

        const issued = sliderCaptchaService.issuePassToken({
            purpose,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || ''
        });
        if (!issued.ok) {
            return res.status(400).json({ error: issued.error });
        }

        return res.json({
            passToken: issued.passToken,
            expiresIn: issued.expiresIn
        });
    } catch (err) {
        console.error('[Auth] Slider captcha verify error:', err.message);
        return res.status(500).json({ error: '滑块验证失败，请稍后重试' });
    }
});

/**
 * POST /api/auth/send-code
 * Send email verification code
 */
router.post('/send-code', optionalAuth, [
    body('purpose').optional().isIn(SUPPORTED_EMAIL_CODE_PURPOSES).withMessage('不支持的验证码用途'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('请输入有效的邮箱地址'),
    body('captchaToken').trim().notEmpty().withMessage('请先获取图形验证码'),
    body('captchaAnswer').trim().matches(/^\d{5}$/).withMessage('请输入5位图形验证码'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const purpose = req.body.purpose || 'register';
        const target = resolveEmailCodeTarget(req, purpose);
        if (!target.ok) {
            return res.status(target.status).json({ error: target.error });
        }

        const normalizedEmail = target.email;
        const validation = await validateEmailCodeTarget({ purpose, email: normalizedEmail });
        if (!validation.ok) {
            return res.status(validation.status).json({ error: validation.error });
        }

        const captchaResult = captchaService.verifyCaptcha({
            purpose: 'send-code',
            email: normalizedEmail,
            answer: req.body.captchaAnswer,
            captchaToken: req.body.captchaToken,
        });
        if (!captchaResult.ok) {
            return res.status(captchaResult.status).json({ error: captchaResult.error });
        }

        const recent = await emailService.hasRecentCodeRequest(normalizedEmail, { purpose, withinSeconds: 60 });
        if (recent) {
            return res.status(429).json({ error: '请60秒后再试' });
        }

        await emailService.sendVerificationCode(normalizedEmail, { purpose });
        res.json({ message: '验证码已发送' });
    } catch (err) {
        console.error('[Auth] Send code error:', err.message);
        res.status(500).json({ error: '发送验证码失败，请检查邮箱地址' });
    }
});

/**
 * POST /api/auth/register
 */
router.post('/register', [
    body('username').trim().isLength({ min: 3, max: 50 }).withMessage('用户名3-50个字符'),
    body('password').isLength({ min: 6, max: 100 }).withMessage('密码至少6个字符'),
    body('nickname').optional().trim().isLength({ max: 100 }),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('请输入有效的邮箱地址'),
    body('emailCode').optional().trim(),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { username, password, nickname, email, emailCode } = req.body;
        const normalizedEmail = email ? email.trim().toLowerCase() : null;

        // Check if email verification is required
        const emailRequired = await emailService.isEmailVerificationEnabled();
        if (emailRequired) {
            if (!normalizedEmail) {
                return res.status(400).json({ error: '开启邮箱验证后，邮箱为必填项' });
            }
            if (!emailCode) {
                return res.status(400).json({ error: '请输入邮箱验证码' });
            }
        }

        const settings = await db.getSystemSettings();
        const giftRoomLimit = Number(settings.gift_room_limit || 0);
        const giftDurationDays = Number(settings.gift_duration_days || 0);
        const giftOpenRoomLimit = Number(settings.gift_open_room_limit || giftRoomLimit || -1);

        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const existingUser = await client.query('SELECT id FROM users WHERE username = $1', [username]);
            if (existingUser.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: '用户名已被注册' });
            }

            if (normalizedEmail) {
                const emailExists = await client.query(
                    'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
                    [normalizedEmail]
                );
                if (emailExists.rows.length > 0) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ error: '邮箱已被注册' });
                }
            }

            if (emailRequired) {
                const verifyResult = await emailService.verifyCode(normalizedEmail, emailCode, {
                    purpose: 'register',
                    executor: client,
                });
                if (!verifyResult.ok) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: verifyResult.error });
                }
            }

            const passwordHash = await authService.hashPassword(password);
            const userResult = await client.query(
                `INSERT INTO users (username, email, password_hash, nickname)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, username, nickname, email, balance, role`,
                [username, normalizedEmail, passwordHash, nickname || username]
            );
            const user = userResult.rows[0];

            if (giftRoomLimit > 0 && giftDurationDays > 0) {
                const giftPlanResult = await client.query(
                    `INSERT INTO subscription_plans (name, code, room_limit, open_room_limit, price_monthly, price_quarterly, price_annual, is_active, sort_order)
                     VALUES ('注册赠送', 'gift', $1, $2, 0, 0, 0, true, 0)
                     ON CONFLICT (code) DO UPDATE
                     SET name = EXCLUDED.name,
                         room_limit = EXCLUDED.room_limit,
                         open_room_limit = EXCLUDED.open_room_limit,
                         price_monthly = EXCLUDED.price_monthly,
                         price_quarterly = EXCLUDED.price_quarterly,
                         price_annual = EXCLUDED.price_annual,
                         is_active = EXCLUDED.is_active,
                         sort_order = EXCLUDED.sort_order
                     RETURNING id`,
                    [giftRoomLimit, giftOpenRoomLimit]
                );

                const startDate = new Date();
                const endDate = new Date(startDate.getTime() + giftDurationDays * 24 * 3600 * 1000);

                await client.query(
                    `INSERT INTO user_subscriptions (user_id, plan_id, billing_cycle, start_date, end_date, status)
                     VALUES ($1, $2, 'gift', $3, $4, 'active')`,
                    [user.id, giftPlanResult.rows[0].id, startDate.toISOString(), endDate.toISOString()]
                );

                console.log(`[Auth] Created gift subscription for user ${username}: ${giftRoomLimit} rooms (open: ${giftOpenRoomLimit}), ${giftDurationDays} days`);
            }

            const accessToken = authService.generateAccessToken(user);
            const refreshToken = await authService.generateRefreshToken(user.id, client);

            await client.query('COMMIT');

            return res.status(201).json({
                accessToken,
                refreshToken,
                user: {
                    id: user.id,
                    username: user.username,
                    nickname: user.nickname,
                    email: user.email,
                    role: user.role,
                    balance: Number(user.balance || 0)
                }
            });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});

            if (err.code === '23505') {
                const conflictField = `${err.constraint || ''} ${err.detail || ''}`.toLowerCase();
                if (conflictField.includes('username')) {
                    return res.status(409).json({ error: '用户名已被注册' });
                }
                if (conflictField.includes('email')) {
                    return res.status(409).json({ error: '邮箱已被注册' });
                }
                return res.status(409).json({ error: '账户信息已存在' });
            }

            console.error('[Auth] Register error:', err.message);
            return res.status(500).json({ error: '注册失败' });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('[Auth] Register error:', err.message);
        res.status(500).json({ error: '注册失败' });
    }
});

/**
 * POST /api/auth/login
 */
router.post('/login', [
    body('username').trim().notEmpty().withMessage('请输入用户名或邮箱'),
    body('password').notEmpty().withMessage('请输入密码'),
    body('sliderPassToken').trim().notEmpty().withMessage('请先完成滑块验证'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { username, password, sliderPassToken } = req.body;
        const sliderCheck = sliderCaptchaService.consumePassToken({
            purpose: 'login',
            passToken: sliderPassToken,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || ''
        });
        if (!sliderCheck.ok) {
            return res.status(400).json({ error: sliderCheck.error });
        }

        const loginInput = String(username || '').trim();
        const normalizedLoginInput = loginInput.toLowerCase();

        const result = await db.pool.query(
            `SELECT id, username, email, nickname, balance, role, status, password_hash
             FROM users
             WHERE username = $1 OR LOWER(email) = $2`,
            [loginInput, normalizedLoginInput]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        const user = result.rows[0];
        if (user.status !== 'active') {
            return res.status(403).json({ error: '账户已被禁用' });
        }

        const valid = await authService.comparePassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        // Update last login
        await db.run(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [user.id]);

        const accessToken = authService.generateAccessToken(user);
        const refreshToken = await authService.generateRefreshToken(user.id);

        res.json({
            accessToken,
            refreshToken,
            user: { id: user.id, username: user.username, nickname: user.nickname, email: user.email, role: user.role, balance: Number(user.balance) }
        });
    } catch (err) {
        console.error('[Auth] Login error:', err.message);
        res.status(500).json({ error: '登录失败' });
    }
});

/**
 * POST /api/auth/refresh
 */
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({ error: '缺少刷新令牌' });
        }

        const userId = await authService.verifyRefreshToken(refreshToken);
        if (!userId) {
            return res.status(401).json({ error: '无效或已过期的刷新令牌' });
        }

        const user = await db.get(
            'SELECT id, username, email, nickname, balance, role, status FROM users WHERE id = ?',
            [userId]
        );
        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: '用户不存在或已被禁用' });
        }

        // Revoke old refresh token and issue new one (token rotation)
        await authService.revokeRefreshToken(refreshToken);
        const newAccessToken = authService.generateAccessToken(user);
        const newRefreshToken = await authService.generateRefreshToken(user.id);

        res.json({
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            user: { id: user.id, username: user.username, nickname: user.nickname, email: user.email, role: user.role, balance: user.balance }
        });
    } catch (err) {
        console.error('[Auth] Refresh error:', err.message);
        res.status(500).json({ error: '令牌刷新失败' });
    }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (refreshToken) {
            await authService.revokeRefreshToken(refreshToken);
        }
        res.json({ message: '已退出登录' });
    } catch (err) {
        console.error('[Auth] Logout error:', err.message);
        res.json({ message: '已退出登录' });
    }
});

/**
 * PUT /api/auth/change-password
 */
router.put('/change-password', authenticate, [
    body('oldPassword').notEmpty().withMessage('请输入旧密码'),
    body('newPassword').isLength({ min: 6, max: 100 }).withMessage('新密码至少6个字符'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { oldPassword, newPassword } = req.body;

        // Get current password hash
        const result = await db.pool.query(
            `SELECT password_hash FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const valid = await authService.comparePassword(oldPassword, result.rows[0].password_hash);
        if (!valid) {
            return res.status(400).json({ error: '旧密码不正确' });
        }

        const newHash = await authService.hashPassword(newPassword);
        await db.run(`UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [newHash, req.user.id]);

        // Revoke all refresh tokens (force re-login)
        await authService.revokeAllUserTokens(req.user.id);

        res.json({ message: '密码修改成功，请重新登录' });
    } catch (err) {
        console.error('[Auth] Change password error:', err.message);
        res.status(500).json({ error: '密码修改失败' });
    }
});

/**
 * POST /api/auth/reset-password
 */
router.post('/reset-password', [
    body('email').isEmail().withMessage('请输入有效的邮箱地址'),
    body('emailCode').trim().matches(/^\d{6}$/).withMessage('请输入6位邮箱验证码'),
    body('newPassword').isLength({ min: 6, max: 100 }).withMessage('新密码至少6个字符'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const normalizedEmail = req.body.email.trim().toLowerCase();
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const userResult = await client.query(
            'SELECT id, status FROM users WHERE LOWER(email) = LOWER($1) FOR UPDATE',
            [normalizedEmail]
        );
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: '该邮箱未注册' });
        }
        if (userResult.rows[0].status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: '账户已被禁用' });
        }

        const verifyResult = await emailService.verifyCode(normalizedEmail, req.body.emailCode, {
            purpose: 'reset_password',
            executor: client,
        });
        if (!verifyResult.ok) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: verifyResult.error });
        }

        const newHash = await authService.hashPassword(req.body.newPassword);
        await client.query(
            'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
            [newHash, userResult.rows[0].id]
        );
        await client.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [userResult.rows[0].id]);

        await client.query('COMMIT');
        res.json({ message: '密码已重置，请使用新密码登录' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Auth] Reset password error:', err.message);
        res.status(500).json({ error: '重置密码失败' });
    } finally {
        client.release();
    }
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticate, (req, res) => {
    res.json({
        user: {
            id: req.user.id,
            username: req.user.username,
            nickname: req.user.nickname,
            email: req.user.email,
            role: req.user.role,
            balance: req.user.balance
        }
    });
});

module.exports = router;
