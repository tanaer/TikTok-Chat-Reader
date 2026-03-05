const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const authService = require('../services/authService');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/register
 */
router.post('/register', [
    body('username').trim().isLength({ min: 3, max: 50 }).withMessage('用户名3-50个字符'),
    body('password').isLength({ min: 6, max: 100 }).withMessage('密码至少6个字符'),
    body('nickname').optional().trim().isLength({ max: 100 }),
    body('email').isEmail().withMessage('请输入有效的邮箱地址'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { username, password, nickname, email } = req.body;

        // Check username uniqueness
        const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
        if (existing) {
            return res.status(409).json({ error: '用户名已被注册' });
        }

        // Check email uniqueness
        const emailExists = await db.get('SELECT id FROM users WHERE email = ?', [email]);
        if (emailExists) {
            return res.status(409).json({ error: '邮箱已被注册' });
        }

        const passwordHash = await authService.hashPassword(password);
        await db.run(
            `INSERT INTO users (username, email, password_hash, nickname) VALUES (?, ?, ?, ?)`,
            [username, email, passwordHash, nickname || username]
        );

        const user = await db.get('SELECT id, username, nickname, email, balance, role FROM users WHERE username = ?', [username]);

        const accessToken = authService.generateAccessToken(user);
        const refreshToken = await authService.generateRefreshToken(user.id);

        res.status(201).json({
            accessToken,
            refreshToken,
            user: { id: user.id, username: user.username, nickname: user.nickname, email: user.email, role: user.role, balance: user.balance }
        });
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
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { username, password } = req.body;

        // Support login by username or email
        const result = await db.pool.query(
            `SELECT id, username, email, nickname, balance, role, status, password_hash FROM users WHERE username = $1 OR email = $1`,
            [username]
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
