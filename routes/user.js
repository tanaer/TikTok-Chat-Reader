const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const subscriptionService = require('../services/subscriptionService');

const router = express.Router();

/**
 * GET /api/user/profile
 */
router.get('/profile', authenticate, async (req, res) => {
    try {
        const user = await db.get(
            `SELECT id, username, email, nickname, balance, role, status, last_login_at, created_at
             FROM users WHERE id = ?`,
            [req.user.id]
        );
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const quota = await subscriptionService.getUserQuota(req.user.id);

        res.json({ user, quota });
    } catch (err) {
        console.error('[User] Profile error:', err.message);
        res.status(500).json({ error: '获取用户信息失败' });
    }
});

/**
 * PUT /api/user/profile
 */
router.put('/profile', authenticate, [
    body('nickname').optional().trim().isLength({ min: 1, max: 100 }).withMessage('昵称1-100个字符'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('邮箱格式不正确'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { nickname, email } = req.body;
        const updates = [];
        const params = [];
        let paramIdx = 0;

        if (nickname !== undefined) {
            updates.push(`nickname = $${++paramIdx}`);
            params.push(nickname);
        }
        if (email !== undefined) {
            // Check email uniqueness
            if (email) {
                const existing = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
                if (existing) {
                    return res.status(409).json({ error: '邮箱已被使用' });
                }
            }
            updates.push(`email = $${++paramIdx}`);
            params.push(email || null);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: '没有可更新的字段' });
        }

        updates.push(`updated_at = NOW()`);
        params.push(req.user.id);
        await db.pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx + 1}`,
            params
        );

        const user = await db.get(
            'SELECT id, username, email, nickname, balance, role FROM users WHERE id = ?',
            [req.user.id]
        );
        res.json({ user });
    } catch (err) {
        console.error('[User] Update profile error:', err.message);
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * GET /api/user/subscription
 */
router.get('/subscription', authenticate, async (req, res) => {
    try {
        const quota = await subscriptionService.getUserQuota(req.user.id);
        res.json(quota);
    } catch (err) {
        console.error('[User] Subscription error:', err.message);
        res.status(500).json({ error: '获取订阅信息失败' });
    }
});

/**
 * GET /api/user/rooms
 */
router.get('/rooms', authenticate, async (req, res) => {
    try {
        const rooms = await db.all(
            `SELECT ur.id, ur.room_id, ur.alias, ur.created_at,
                    r.name, r.numeric_room_id, r.is_monitor_enabled, r.language,
                    rs.all_time_gift_value, rs.last_session_time
             FROM user_room ur
             LEFT JOIN room r ON ur.room_id = r.room_id
             LEFT JOIN room_stats rs ON ur.room_id = rs.room_id
             WHERE ur.user_id = ?
             ORDER BY ur.created_at DESC`,
            [req.user.id]
        );
        res.json({ rooms });
    } catch (err) {
        console.error('[User] Rooms error:', err.message);
        res.status(500).json({ error: '获取房间列表失败' });
    }
});

/**
 * GET /api/user/orders
 */
router.get('/orders', authenticate, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const orders = await db.all(
            `SELECT * FROM payment_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [req.user.id, limit, offset]
        );

        const countResult = await db.get(
            'SELECT COUNT(*) AS total FROM payment_records WHERE user_id = ?',
            [req.user.id]
        );

        res.json({
            orders,
            pagination: { page, limit, total: Number(countResult?.total || 0) }
        });
    } catch (err) {
        console.error('[User] Orders error:', err.message);
        res.status(500).json({ error: '获取订单失败' });
    }
});

/**
 * GET /api/user/balance-logs
 */
router.get('/balance-logs', authenticate, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const logs = await db.all(
            `SELECT * FROM balance_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [req.user.id, limit, offset]
        );

        const countResult = await db.get(
            'SELECT COUNT(*) AS total FROM balance_log WHERE user_id = ?',
            [req.user.id]
        );

        res.json({
            logs,
            pagination: { page, limit, total: Number(countResult?.total || 0) }
        });
    } catch (err) {
        console.error('[User] Balance logs error:', err.message);
        res.status(500).json({ error: '获取余额记录失败' });
    }
});

module.exports = router;
