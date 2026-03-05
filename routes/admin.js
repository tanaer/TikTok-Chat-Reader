const express = require('express');
const { body, query: queryValidator, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const authService = require('../services/authService');
const balanceService = require('../services/balanceService');

const router = express.Router();

// All admin routes require authentication + admin role
router.use(authenticate, requireAdmin);

// ==================== Dashboard Stats ====================

/**
 * GET /api/admin/stats
 */
router.get('/stats', async (req, res) => {
    try {
        const [users, todayUsers, activeSubs, monthRevenue, balancePool, totalOrders, activeRooms] = await Promise.all([
            db.get('SELECT COUNT(*) AS count FROM users'),
            db.get(`SELECT COUNT(*) AS count FROM users WHERE created_at >= CURRENT_DATE`),
            db.get(`SELECT COUNT(*) AS count FROM user_subscriptions WHERE status = 'active' AND end_date > NOW()`),
            db.get(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_records WHERE status = 'paid' AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`),
            db.get('SELECT COALESCE(SUM(balance), 0) AS total FROM users'),
            db.get('SELECT COUNT(*) AS count FROM payment_records'),
            db.get('SELECT COUNT(*) AS count FROM room WHERE is_monitor_enabled = 1'),
        ]);

        res.json({
            totalUsers: Number(users?.count || 0),
            todayNewUsers: Number(todayUsers?.count || 0),
            activeSubscriptions: Number(activeSubs?.count || 0),
            monthRevenue: Number(monthRevenue?.total || 0),
            balancePool: Number(balancePool?.total || 0),
            totalOrders: Number(totalOrders?.count || 0),
            activeRooms: Number(activeRooms?.count || 0),
        });
    } catch (err) {
        console.error('[Admin] Stats error:', err.message);
        res.status(500).json({ error: '获取统计失败' });
    }
});

// ==================== User Management ====================

/**
 * GET /api/admin/users
 */
router.get('/users', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const role = req.query.role || '';
        const status = req.query.status || '';

        let where = 'WHERE 1=1';
        const params = [];
        let paramIdx = 0;

        if (search) {
            where += ` AND (username ILIKE $${++paramIdx} OR email ILIKE $${paramIdx} OR nickname ILIKE $${paramIdx})`;
            params.push(`%${search}%`);
        }
        if (role) {
            where += ` AND role = $${++paramIdx}`;
            params.push(role);
        }
        if (status) {
            where += ` AND status = $${++paramIdx}`;
            params.push(status);
        }

        const countResult = await db.pool.query(
            `SELECT COUNT(*) AS count FROM users ${where}`, params
        );

        const usersResult = await db.pool.query(
            `SELECT id, username, email, nickname, balance, role, status, last_login_at, created_at
             FROM users ${where} ORDER BY created_at DESC LIMIT $${++paramIdx} OFFSET $${++paramIdx}`,
            [...params, limit, offset]
        );

        // Get room counts and subscription info for each user
        const users = [];
        for (const u of usersResult.rows) {
            const roomCount = await db.get('SELECT COUNT(*) AS count FROM user_room WHERE user_id = ?', [u.id]);
            const sub = await db.get(
                `SELECT p.name AS plan_name, us.end_date FROM user_subscriptions us
                 JOIN subscription_plans p ON us.plan_id = p.id
                 WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
                 ORDER BY us.end_date DESC LIMIT 1`,
                [u.id]
            );
            users.push({
                ...db.toCamelCase(u),
                roomCount: Number(roomCount?.count || 0),
                planName: sub?.planName || null,
                planEndAt: sub?.endDate || null,
            });
        }

        res.json({
            users,
            pagination: { page, limit, total: parseInt(countResult.rows[0].count) }
        });
    } catch (err) {
        console.error('[Admin] Users list error:', err.message);
        res.status(500).json({ error: '获取用户列表失败' });
    }
});

/**
 * GET /api/admin/users/:id
 */
router.get('/users/:id', async (req, res) => {
    try {
        const user = await db.get(
            'SELECT id, username, email, nickname, balance, role, status, last_login_at, created_at FROM users WHERE id = ?',
            [req.params.id]
        );
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const [subscriptions, rooms, recentOrders, recentBalance] = await Promise.all([
            db.all(`SELECT us.*, p.name AS plan_name FROM user_subscriptions us JOIN subscription_plans p ON us.plan_id = p.id WHERE us.user_id = ? ORDER BY us.created_at DESC LIMIT 10`, [user.id]),
            db.all(`SELECT ur.*, r.name AS room_name FROM user_room ur LEFT JOIN room r ON ur.room_id = r.room_id WHERE ur.user_id = ? ORDER BY ur.created_at DESC`, [user.id]),
            db.all(`SELECT * FROM payment_records WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, [user.id]),
            db.all(`SELECT * FROM balance_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, [user.id]),
        ]);

        res.json({ user, subscriptions, rooms, recentOrders, recentBalance });
    } catch (err) {
        console.error('[Admin] User detail error:', err.message);
        res.status(500).json({ error: '获取用户详情失败' });
    }
});

/**
 * PUT /api/admin/users/:id
 */
router.put('/users/:id', async (req, res) => {
    try {
        const { nickname, email, role } = req.body;
        const userId = req.params.id;

        // Prevent self-demotion
        if (parseInt(userId) === req.user.id && role && role !== 'admin') {
            return res.status(400).json({ error: '不能修改自己的管理员角色' });
        }

        const updates = [];
        const params = [];
        let paramIdx = 0;

        if (nickname !== undefined) { updates.push(`nickname = $${++paramIdx}`); params.push(nickname); }
        if (email !== undefined) { updates.push(`email = $${++paramIdx}`); params.push(email || null); }
        if (role && ['user', 'admin'].includes(role)) { updates.push(`role = $${++paramIdx}`); params.push(role); }

        if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

        updates.push('updated_at = NOW()');
        params.push(userId);
        await db.pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx + 1}`, params
        );

        res.json({ message: '更新成功' });
    } catch (err) {
        console.error('[Admin] Update user error:', err.message);
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * POST /api/admin/users/:id/adjust-balance
 */
router.post('/users/:id/adjust-balance', [
    body('amount').isFloat({ min: -999999, max: 999999 }).withMessage('金额无效'),
    body('remark').trim().notEmpty().withMessage('请填写备注'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const { amount, remark } = req.body;
        const userId = parseInt(req.params.id);

        // Create payment record for recharge
        let refOrderNo = null;
        if (amount > 0) {
            const orderNo = balanceService.generateOrderNo('RCH');
            await db.pool.query(
                `INSERT INTO payment_records (order_no, user_id, type, item_name, amount, status, payment_method, remark)
                 VALUES ($1, $2, 'recharge', '管理员充值', $3, 'paid', 'manual', $4)`,
                [orderNo, userId, Math.round(Math.abs(amount)), remark]
            );
            refOrderNo = orderNo;
        }

        const result = await balanceService.adjustBalance(
            userId, Math.round(parseFloat(amount)), amount > 0 ? 'recharge' : 'admin_adjust',
            remark, refOrderNo, req.user.id
        );

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            message: `余额调整成功: ${amount > 0 ? '+' : ''}${amount}`,
            balanceBefore: result.balanceBefore,
            balanceAfter: result.balanceAfter
        });
    } catch (err) {
        console.error('[Admin] Adjust balance error:', err.message);
        res.status(500).json({ error: '余额调整失败' });
    }
});

/**
 * POST /api/admin/users/:id/toggle-status
 */
router.post('/users/:id/toggle-status', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        if (userId === req.user.id) {
            return res.status(400).json({ error: '不能禁用自己' });
        }

        const user = await db.get('SELECT status FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const newStatus = user.status === 'active' ? 'disabled' : 'active';
        await db.run('UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, userId]);

        // If disabling, revoke all tokens
        if (newStatus === 'disabled') {
            await authService.revokeAllUserTokens(userId);
        }

        res.json({ message: `用户已${newStatus === 'active' ? '启用' : '禁用'}`, status: newStatus });
    } catch (err) {
        console.error('[Admin] Toggle status error:', err.message);
        res.status(500).json({ error: '操作失败' });
    }
});

/**
 * POST /api/admin/users/:id/reset-password
 */
router.post('/users/:id/reset-password', [
    body('newPassword').isLength({ min: 6, max: 100 }).withMessage('密码至少6个字符'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const hash = await authService.hashPassword(req.body.newPassword);
        await db.run('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?', [hash, req.params.id]);
        await authService.revokeAllUserTokens(parseInt(req.params.id));
        res.json({ message: '密码重置成功' });
    } catch (err) {
        console.error('[Admin] Reset password error:', err.message);
        res.status(500).json({ error: '重置失败' });
    }
});

// ==================== Order Management ====================

/**
 * GET /api/admin/orders
 */
router.get('/orders', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const type = req.query.type || '';
        const status = req.query.status || '';
        const search = req.query.search || '';

        let where = 'WHERE 1=1';
        const params = [];
        let paramIdx = 0;

        if (type) { where += ` AND o.type = $${++paramIdx}`; params.push(type); }
        if (status) { where += ` AND o.status = $${++paramIdx}`; params.push(status); }
        if (search) {
            where += ` AND (o.order_no ILIKE $${++paramIdx} OR u.username ILIKE $${paramIdx})`;
            params.push(`%${search}%`);
        }

        const countResult = await db.pool.query(
            `SELECT COUNT(*) AS count FROM payment_records o LEFT JOIN users u ON o.user_id = u.id ${where}`, params
        );

        const ordersResult = await db.pool.query(
            `SELECT o.*, u.username, u.nickname AS user_nickname
             FROM payment_records o LEFT JOIN users u ON o.user_id = u.id
             ${where} ORDER BY o.created_at DESC LIMIT $${++paramIdx} OFFSET $${++paramIdx}`,
            [...params, limit, offset]
        );

        res.json({
            orders: ordersResult.rows.map(db.toCamelCase),
            pagination: { page, limit, total: parseInt(countResult.rows[0].count) }
        });
    } catch (err) {
        console.error('[Admin] Orders error:', err.message);
        res.status(500).json({ error: '获取订单列表失败' });
    }
});

// ==================== Plan Management ====================

/**
 * GET /api/admin/plans
 */
router.get('/plans', async (req, res) => {
    try {
        const plans = await db.all('SELECT * FROM subscription_plans ORDER BY sort_order');
        res.json({ plans });
    } catch (err) {
        res.status(500).json({ error: '获取套餐失败' });
    }
});

/**
 * POST /api/admin/plans
 */
router.post('/plans', [
    body('name').trim().notEmpty(),
    body('code').trim().notEmpty(),
    body('roomLimit').isInt({ min: 1 }),
    body('priceMonthly').isFloat({ min: 0 }),
    body('priceQuarterly').isFloat({ min: 0 }),
    body('priceAnnual').isFloat({ min: 0 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const { name, code, roomLimit, priceMonthly, priceQuarterly, priceAnnual, featureFlags, sortOrder } = req.body;

        const existing = await db.get('SELECT id FROM subscription_plans WHERE code = ?', [code]);
        if (existing) return res.status(409).json({ error: '套餐代码已存在' });

        await db.run(
            `INSERT INTO subscription_plans (name, code, room_limit, price_monthly, price_quarterly, price_annual, feature_flags, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, code, roomLimit, Math.round(priceMonthly), Math.round(priceQuarterly), Math.round(priceAnnual), JSON.stringify(featureFlags || {}), sortOrder || 0]
        );
        res.status(201).json({ message: '套餐创建成功' });
    } catch (err) {
        console.error('[Admin] Create plan error:', err.message);
        res.status(500).json({ error: '创建失败' });
    }
});

/**
 * PUT /api/admin/plans/:id
 */
router.put('/plans/:id', async (req, res) => {
    try {
        const { name, roomLimit, priceMonthly, priceQuarterly, priceAnnual, featureFlags, sortOrder, isActive } = req.body;
        const planId = req.params.id;

        const updates = [];
        const params = [];
        let idx = 0;

        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (roomLimit !== undefined) { updates.push(`room_limit = $${++idx}`); params.push(roomLimit); }
        if (priceMonthly !== undefined) { updates.push(`price_monthly = $${++idx}`); params.push(Math.round(priceMonthly)); }
        if (priceQuarterly !== undefined) { updates.push(`price_quarterly = $${++idx}`); params.push(Math.round(priceQuarterly)); }
        if (priceAnnual !== undefined) { updates.push(`price_annual = $${++idx}`); params.push(Math.round(priceAnnual)); }
        if (featureFlags !== undefined) { updates.push(`feature_flags = $${++idx}`); params.push(JSON.stringify(featureFlags)); }
        if (sortOrder !== undefined) { updates.push(`sort_order = $${++idx}`); params.push(sortOrder); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }

        if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

        updates.push('updated_at = NOW()');
        params.push(planId);
        await db.pool.query(`UPDATE subscription_plans SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);

        res.json({ message: '套餐更新成功' });
    } catch (err) {
        console.error('[Admin] Update plan error:', err.message);
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * DELETE /api/admin/plans/:id
 */
router.delete('/plans/:id', async (req, res) => {
    try {
        // Soft delete - just deactivate
        await db.run('UPDATE subscription_plans SET is_active = false WHERE id = ?', [req.params.id]);
        res.json({ message: '套餐已下架' });
    } catch (err) {
        res.status(500).json({ error: '操作失败' });
    }
});

// ==================== Addon Management ====================

/**
 * GET /api/admin/addons
 */
router.get('/addons', async (req, res) => {
    try {
        const addons = await db.all('SELECT * FROM room_addon_packages ORDER BY room_count');
        res.json({ addons });
    } catch (err) {
        res.status(500).json({ error: '获取扩容包失败' });
    }
});

/**
 * POST /api/admin/addons
 */
router.post('/addons', [
    body('name').trim().notEmpty(),
    body('roomCount').isInt({ min: 1 }),
    body('priceMonthly').isFloat({ min: 0 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const { name, roomCount, priceMonthly, priceQuarterly, priceAnnual } = req.body;
        await db.run(
            'INSERT INTO room_addon_packages (name, room_count, price_monthly, price_quarterly, price_annual) VALUES (?, ?, ?, ?, ?)',
            [name, roomCount, Math.round(priceMonthly), Math.round(priceQuarterly || 0), Math.round(priceAnnual || 0)]
        );
        res.status(201).json({ message: '扩容包创建成功' });
    } catch (err) {
        res.status(500).json({ error: '创建失败' });
    }
});

/**
 * PUT /api/admin/addons/:id
 */
router.put('/addons/:id', async (req, res) => {
    try {
        const { name, roomCount, priceMonthly, priceQuarterly, priceAnnual, isActive } = req.body;
        const updates = [];
        const params = [];
        let idx = 0;

        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (roomCount !== undefined) { updates.push(`room_count = $${++idx}`); params.push(roomCount); }
        if (priceMonthly !== undefined) { updates.push(`price_monthly = $${++idx}`); params.push(Math.round(priceMonthly)); }
        if (priceQuarterly !== undefined) { updates.push(`price_quarterly = $${++idx}`); params.push(Math.round(priceQuarterly)); }
        if (priceAnnual !== undefined) { updates.push(`price_annual = $${++idx}`); params.push(Math.round(priceAnnual)); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }

        if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

        params.push(req.params.id);
        await db.pool.query(`UPDATE room_addon_packages SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);
        res.json({ message: '扩容包更新成功' });
    } catch (err) {
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * DELETE /api/admin/addons/:id
 */
router.delete('/addons/:id', async (req, res) => {
    try {
        await db.run('UPDATE room_addon_packages SET is_active = false WHERE id = ?', [req.params.id]);
        res.json({ message: '扩容包已下架' });
    } catch (err) {
        res.status(500).json({ error: '操作失败' });
    }
});

// ==================== System Settings ====================

/**
 * GET /api/admin/settings
 */
router.get('/settings', async (req, res) => {
    try {
        const settings = await db.getSystemSettings();
        res.json({ settings });
    } catch (err) {
        res.status(500).json({ error: '获取设置失败' });
    }
});

/**
 * PUT /api/admin/settings
 */
router.put('/settings', async (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: '无效的设置数据' });
        }

        for (const [key, value] of Object.entries(settings)) {
            await db.pool.query(
                `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
                [key, String(value)]
            );
        }

        res.json({ message: '设置已保存' });
    } catch (err) {
        console.error('[Admin] Save settings error:', err.message);
        res.status(500).json({ error: '保存失败' });
    }
});

module.exports = router;
