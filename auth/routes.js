/**
 * Authentication Routes
 * Handles user registration, login, logout, password reset
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword, generateToken, hashToken } = require('./password');
const { generateAccessToken, generateRefreshToken, verifyToken, REFRESH_TOKEN_EXPIRY } = require('./jwt');
const { requireAuth } = require('./middleware');

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', async (req, res) => {
    try {
        const { email, password, nickname } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({ error: '邮箱和密码为必填项' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: '密码至少需要6个字符' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: '邮箱格式不正确' });
        }

        // Check if email already exists
        const existing = await db.get('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing) {
            return res.status(409).json({ error: '该邮箱已被注册' });
        }

        // Hash password
        const passwordHash = await hashPassword(password);

        // Create user
        const result = await db.query(`
            INSERT INTO users (email, password_hash, nickname, created_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING id, email, nickname, created_at
        `, [email.toLowerCase(), passwordHash, nickname || email.split('@')[0]]);

        const user = result[0];

        // Create free subscription for new user
        const freePlan = await db.get(`SELECT id FROM subscription_plans WHERE code = 'free' LIMIT 1`);
        if (freePlan) {
            await db.run(`
                INSERT INTO user_subscriptions (user_id, plan_id, billing_cycle, start_date, end_date, status)
                VALUES ($1, $2, 'free', NOW(), NOW() + INTERVAL '100 years', 'active')
            `, [user.id, freePlan.id]);
        }

        // Generate tokens
        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            nickname: user.nickname
        });
        const refreshToken = generateRefreshToken({ userId: user.id });

        // Store refresh token hash
        await db.run(`
            INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
            VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TOKEN_EXPIRY} seconds')
        `, [user.id, hashToken(refreshToken)]);

        res.status(201).json({
            message: '注册成功',
            user: {
                id: user.id,
                email: user.email,
                nickname: user.nickname
            },
            accessToken,
            refreshToken
        });

    } catch (err) {
        console.error('[Auth] Register error:', err);
        res.status(500).json({ error: '注册失败，请稍后重试' });
    }
});

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: '邮箱和密码为必填项' });
        }

        // Find user
        const user = await db.get(`
            SELECT id, email, password_hash, nickname, status
            FROM users WHERE email = $1
        `, [email.toLowerCase()]);

        if (!user) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }

        if (user.status !== 'active') {
            return res.status(403).json({ error: '账号已被禁用，请联系客服' });
        }

        // Verify password
        const isValid = await verifyPassword(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }

        // Update last login time
        await db.run(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

        // Generate tokens
        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            nickname: user.nickname
        });
        const refreshToken = generateRefreshToken({ userId: user.id });

        // Store refresh token hash
        await db.run(`
            INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
            VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TOKEN_EXPIRY} seconds')
        `, [user.id, hashToken(refreshToken)]);

        res.json({
            message: '登录成功',
            user: {
                id: user.id,
                email: user.email,
                nickname: user.nickname
            },
            accessToken,
            refreshToken
        });

    } catch (err) {
        console.error('[Auth] Login error:', err);
        res.status(500).json({ error: '登录失败，请稍后重试' });
    }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token 为必填项' });
        }

        // Verify refresh token
        const payload = verifyToken(refreshToken);
        if (!payload || payload.type !== 'refresh') {
            return res.status(401).json({ error: 'Invalid refresh token' });
        }

        // Check if token is in database and not revoked
        const tokenRecord = await db.get(`
            SELECT id FROM refresh_tokens 
            WHERE user_id = $1 AND token_hash = $2 AND revoked = false AND expires_at > NOW()
        `, [payload.sub, hashToken(refreshToken)]);

        if (!tokenRecord) {
            return res.status(401).json({ error: 'Refresh token 已失效' });
        }

        // Get user info
        const user = await db.get(`
            SELECT id, email, nickname, status FROM users WHERE id = $1
        `, [payload.sub]);

        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: '用户不存在或已被禁用' });
        }

        // Generate new access token
        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            nickname: user.nickname
        });

        res.json({ accessToken });

    } catch (err) {
        console.error('[Auth] Refresh error:', err);
        res.status(500).json({ error: '刷新 token 失败' });
    }
});

/**
 * POST /api/auth/logout
 * Logout and invalidate refresh token
 */
router.post('/logout', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (refreshToken) {
            // Revoke the refresh token
            await db.run(`
                UPDATE refresh_tokens SET revoked = true 
                WHERE token_hash = $1
            `, [hashToken(refreshToken)]);
        }

        res.json({ message: '已退出登录' });

    } catch (err) {
        console.error('[Auth] Logout error:', err);
        res.status(500).json({ error: '退出登录失败' });
    }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await db.get(`
            SELECT u.id, u.email, u.nickname, u.avatar_url, u.created_at,
                   p.name as plan_name, p.code as plan_code, 
                   s.end_date as subscription_end, s.auto_renew
            FROM users u
            LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.end_date > NOW()
            LEFT JOIN subscription_plans p ON s.plan_id = p.id
            WHERE u.id = $1
            ORDER BY p.sort_order DESC
            LIMIT 1
        `, [req.user.id]);

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        res.json({
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            avatarUrl: user.avatar_url,
            createdAt: user.created_at,
            subscription: {
                planName: user.plan_name || '免费版',
                planCode: user.plan_code || 'free',
                endDate: user.subscription_end,
                autoRenew: user.auto_renew
            }
        });

    } catch (err) {
        console.error('[Auth] Get me error:', err);
        res.status(500).json({ error: '获取用户信息失败' });
    }
});

/**
 * PUT /api/auth/profile
 * Update user profile
 */
router.put('/profile', requireAuth, async (req, res) => {
    try {
        const { nickname, avatarUrl } = req.body;

        const updates = [];
        const values = [];
        let paramIndex = 1;

        if (nickname !== undefined) {
            updates.push(`nickname = $${paramIndex++}`);
            values.push(nickname);
        }
        if (avatarUrl !== undefined) {
            updates.push(`avatar_url = $${paramIndex++}`);
            values.push(avatarUrl);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: '没有需要更新的字段' });
        }

        updates.push(`updated_at = NOW()`);
        values.push(req.user.id);

        await db.run(`
            UPDATE users SET ${updates.join(', ')}
            WHERE id = $${paramIndex}
        `, values);

        res.json({ message: '资料更新成功' });

    } catch (err) {
        console.error('[Auth] Update profile error:', err);
        res.status(500).json({ error: '更新资料失败' });
    }
});

/**
 * PUT /api/auth/password
 * Change password
 */
router.put('/password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: '当前密码和新密码为必填项' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: '新密码至少需要6个字符' });
        }

        // Get current password hash
        const user = await db.get('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);

        // Verify current password
        const isValid = await verifyPassword(currentPassword, user.password_hash);
        if (!isValid) {
            return res.status(400).json({ error: '当前密码错误' });
        }

        // Hash new password and update
        const newHash = await hashPassword(newPassword);
        await db.run(`
            UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2
        `, [newHash, req.user.id]);

        // Revoke all refresh tokens (force re-login)
        await db.run(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [req.user.id]);

        res.json({ message: '密码修改成功，请重新登录' });

    } catch (err) {
        console.error('[Auth] Change password error:', err);
        res.status(500).json({ error: '修改密码失败' });
    }
});

module.exports = router;
