/**
 * Auth Routes - Register, Login, Change Password, Refresh, Logout
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, signAccessToken, signRefreshToken, JWT_SECRET } = require('./middleware');

const SALT_ROUNDS = 12;

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', async (req, res) => {
    try {
        const { email, password, nickname } = req.body;

        // Validate
        if (!email || !password) {
            return res.status(400).json({ error: '邮箱和密码不能为空' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: '密码长度至少6位' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: '邮箱格式不正确' });
        }

        // Check if email already exists
        const existing = await db.get('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing) {
            return res.status(400).json({ error: '该邮箱已被注册' });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        // Create user
        const result = await db.get(
            `INSERT INTO users (email, password_hash, nickname, status, email_verified)
             VALUES ($1, $2, $3, 'active', false)
             RETURNING id, email, nickname, role, status, created_at`,
            [email.toLowerCase(), passwordHash, nickname || email.split('@')[0]]
        );

        // Note: No free subscription auto-created. Users must purchase a plan to use the system.

        // Generate tokens
        const accessToken = signAccessToken(result);
        const refreshToken = signRefreshToken(result);

        // Store refresh token hash
        const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await db.run(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
            [result.id, tokenHash]
        );

        // Update last login
        await db.run('UPDATE users SET last_login_at = NOW() WHERE id = $1', [result.id]);

        console.log(`[Auth] New user registered: ${email}`);

        res.json({
            success: true,
            accessToken,
            refreshToken,
            user: {
                id: result.id,
                email: result.email,
                nickname: result.nickname,
                role: result.role || 'user'
            }
        });
    } catch (err) {
        console.error('[Auth] Register error:', err);
        res.status(500).json({ error: '注册失败，请稍后再试' });
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
            return res.status(400).json({ error: '邮箱和密码不能为空' });
        }

        // Find user
        const user = await db.get(
            'SELECT id, email, password_hash, nickname, role, status FROM users WHERE email = $1',
            [email.toLowerCase()]
        );

        if (!user) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }

        if (user.status === 'suspended') {
            return res.status(403).json({ error: '账户已被停用，请联系管理员' });
        }

        // Verify password
        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
            return res.status(401).json({ error: '邮箱或密码错误' });
        }

        // Generate tokens
        const accessToken = signAccessToken(user);
        const refreshToken = signRefreshToken(user);

        // Store refresh token hash
        const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await db.run(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
            [user.id, tokenHash]
        );

        // Update last login
        await db.run('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

        console.log(`[Auth] User logged in: ${email}`);

        res.json({
            success: true,
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                nickname: user.nickname,
                role: user.role
            }
        });
    } catch (err) {
        console.error('[Auth] Login error:', err);
        res.status(500).json({ error: '登录失败，请稍后再试' });
    }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await db.get(
            `SELECT id, email, nickname, role, status, avatar_url, phone, email_verified, balance, last_login_at, created_at
             FROM users WHERE id = $1`,
            [req.user.id]
        );

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        // Get unread notification count
        const notifResult = await db.get(
            'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = $1 AND is_read = FALSE',
            [req.user.id]
        );

        res.json({
            ...user,
            unreadNotifications: parseInt(notifResult?.cnt || 0)
        });
    } catch (err) {
        console.error('[Auth] Me error:', err);
        res.status(500).json({ error: '获取用户信息失败' });
    }
});

/**
 * PUT /api/auth/profile
 * Update user profile (nickname)
 */
router.put('/profile', requireAuth, async (req, res) => {
    try {
        const { nickname } = req.body;

        if (nickname !== undefined) {
            await db.run(
                'UPDATE users SET nickname = $1, updated_at = NOW() WHERE id = $2',
                [nickname.trim(), req.user.id]
            );
        }

        res.json({ success: true, message: '资料已更新' });
    } catch (err) {
        console.error('[Auth] Profile update error:', err);
        res.status(500).json({ error: '更新失败' });
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
            return res.status(400).json({ error: '缺少刷新令牌' });
        }

        // Verify token
        let decoded;
        try {
            decoded = require('jsonwebtoken').verify(refreshToken, JWT_SECRET);
        } catch {
            return res.status(401).json({ error: '刷新令牌无效或已过期' });
        }

        if (decoded.type !== 'refresh') {
            return res.status(401).json({ error: '无效的令牌类型' });
        }

        // Check token hash in database
        const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const storedToken = await db.get(
            `SELECT id FROM refresh_tokens 
             WHERE user_id = $1 AND token_hash = $2 AND revoked = false AND expires_at > NOW()`,
            [decoded.id, tokenHash]
        );

        if (!storedToken) {
            return res.status(401).json({ error: '刷新令牌已失效' });
        }

        // Get current user info
        const user = await db.get(
            'SELECT id, email, nickname, role, status FROM users WHERE id = $1',
            [decoded.id]
        );

        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: '用户不存在或已停用' });
        }

        // Revoke old refresh token
        await db.run('UPDATE refresh_tokens SET revoked = true WHERE id = $1', [storedToken.id]);

        // Generate new tokens
        const newAccessToken = signAccessToken(user);
        const newRefreshToken = signRefreshToken(user);

        // Store new refresh token
        const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
        await db.run(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
            [user.id, newTokenHash]
        );

        res.json({
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            user: {
                id: user.id,
                email: user.email,
                nickname: user.nickname,
                role: user.role
            }
        });
    } catch (err) {
        console.error('[Auth] Refresh error:', err);
        res.status(500).json({ error: '令牌刷新失败' });
    }
});

/**
 * POST /api/auth/logout
 * Revoke refresh token
 */
router.post('/logout', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (refreshToken) {
            const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
            await db.run(
                'UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1',
                [tokenHash]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Auth] Logout error:', err);
        res.json({ success: true }); // Always succeed logout
    }
});

/**
 * PUT /api/auth/password
 * Change password (requires old password) — frontend alias
 */
router.put('/password', requireAuth, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;

        if (!oldPassword || !newPassword) {
            return res.status(400).json({ error: '旧密码和新密码不能为空' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: '新密码长度至少6位' });
        }

        const user = await db.get(
            'SELECT password_hash FROM users WHERE id = $1',
            [req.user.id]
        );

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
        if (!isValid) {
            return res.status(401).json({ error: '旧密码不正确' });
        }

        const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await db.run(
            'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
            [newHash, req.user.id]
        );

        await db.run(
            'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1',
            [req.user.id]
        );

        console.log(`[Auth] Password changed for user: ${req.user.email}`);

        res.json({ success: true, message: '密码修改成功，请重新登录' });
    } catch (err) {
        console.error('[Auth] Change password error:', err);
        res.status(500).json({ error: '密码修改失败' });
    }
});

/**
 * POST /api/auth/change-password
 * Change password (requires old password)
 */
router.post('/change-password', requireAuth, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;

        if (!oldPassword || !newPassword) {
            return res.status(400).json({ error: '旧密码和新密码不能为空' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: '新密码长度至少6位' });
        }

        // Get current password hash
        const user = await db.get(
            'SELECT password_hash FROM users WHERE id = $1',
            [req.user.id]
        );

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        // Verify old password
        const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
        if (!isValid) {
            return res.status(401).json({ error: '旧密码不正确' });
        }

        // Update password
        const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await db.run(
            'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
            [newHash, req.user.id]
        );

        // Revoke all existing refresh tokens (force re-login on all devices)
        await db.run(
            'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1',
            [req.user.id]
        );

        console.log(`[Auth] Password changed for user: ${req.user.email}`);

        res.json({ success: true, message: '密码修改成功，请重新登录' });
    } catch (err) {
        console.error('[Auth] Change password error:', err);
        res.status(500).json({ error: '密码修改失败' });
    }
});

// ========================
// Notification API
// ========================

/**
 * GET /api/auth/notifications
 * Get user's notifications (paginated)
 */
router.get('/notifications', requireAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const notifications = await db.query(
            `SELECT id, type, title, content, is_read, created_at
             FROM notifications WHERE user_id = $1
             ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            [req.user.id, limit, offset]
        );

        const countResult = await db.get(
            'SELECT COUNT(*) as total FROM notifications WHERE user_id = $1',
            [req.user.id]
        );

        res.json({
            data: notifications,
            pagination: { page, limit, total: parseInt(countResult?.total || 0) }
        });
    } catch (err) {
        console.error('[Auth] Notifications error:', err);
        res.status(500).json({ error: '获取通知失败' });
    }
});

/**
 * PUT /api/auth/notifications/:id/read
 * Mark a notification as read
 */
router.put('/notifications/:id/read', requireAuth, async (req, res) => {
    try {
        await db.run(
            'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/auth/notifications/read-all
 * Mark all notifications as read
 */
router.put('/notifications/read-all', requireAuth, async (req, res) => {
    try {
        await db.run(
            'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
            [req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
