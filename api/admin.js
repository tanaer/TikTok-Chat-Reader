/**
 * Admin API Routes
 * System administration - user management, order management, manual operations
 * Only accessible by admin users
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { manager } = require('../manager');
const { requireAuth, requireAdmin } = require('../auth/middleware');

const SALT_ROUNDS = 12;

// All routes require admin role
router.use(requireAuth);
router.use(requireAdmin);

// ========================
// System Stats
// ========================

/**
 * GET /api/admin/stats
 * Dashboard statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const [userCount, roomCount, activeRooms, orderCount, revenueResult] = await Promise.all([
            db.get('SELECT COUNT(*) as cnt FROM users'),
            db.get('SELECT COUNT(*) as cnt FROM room'),
            db.get('SELECT COUNT(DISTINCT room_id) as cnt FROM user_room WHERE is_enabled = TRUE'),
            db.get('SELECT COUNT(*) as cnt FROM payment_records WHERE status = $1', ['paid']),
            db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM payment_records WHERE status = 'paid'`)
        ]);

        res.json({
            totalUsers: parseInt(userCount?.cnt || 0),
            totalRooms: parseInt(roomCount?.cnt || 0),
            activeRooms: parseInt(activeRooms?.cnt || 0),
            totalOrders: parseInt(orderCount?.cnt || 0),
            totalRevenue: parseInt(revenueResult?.total || 0)
        });
    } catch (err) {
        console.error('[Admin] Error getting stats:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========================
// User Management
// ========================

/**
 * GET /api/admin/users
 * List all users with balance, subscription info
 */
router.get('/users', async (req, res) => {
    try {
        const { page = 1, limit = 50, search = '' } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = '';
        const params = [];

        if (search) {
            whereClause = `WHERE u.email ILIKE $1 OR u.nickname ILIKE $1`;
            params.push(`%${search}%`);
        }

        const users = await db.query(`
            SELECT u.id, u.email, u.nickname, u.role, u.status, u.balance, u.last_login_at, u.created_at,
                   (SELECT COUNT(*) FROM user_room WHERE user_id = u.id) as room_count,
                   sp.name as plan_name, sp.code as plan_code,
                   us.billing_cycle, us.end_date as subscription_end, us.status as sub_status
            FROM users u
            LEFT JOIN user_subscriptions us ON u.id = us.user_id AND us.status = 'active'
            LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
            ${whereClause}
            ORDER BY u.created_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, parseInt(limit), offset]);

        const countParams = search ? [`%${search}%`] : [];
        const countResult = await db.get(
            `SELECT COUNT(*) as total FROM users u ${whereClause}`,
            countParams
        );

        res.json({
            data: users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(countResult?.total || 0),
                totalPages: Math.ceil((parseInt(countResult?.total || 0)) / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('[Admin] Error getting users:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/users/:id
 * Update user (role, status, nickname)
 */
router.put('/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { role, status, nickname } = req.body;

        const updates = [];
        const params = [];
        let idx = 1;

        if (role) { updates.push(`role = $${idx++}`); params.push(role); }
        if (status) { updates.push(`status = $${idx++}`); params.push(status); }
        if (nickname !== undefined) { updates.push(`nickname = $${idx++}`); params.push(nickname); }

        if (updates.length === 0) {
            return res.status(400).json({ error: '没有要更新的字段' });
        }

        updates.push(`updated_at = NOW()`);
        params.push(parseInt(id));
        await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);

        console.log(`[Admin] User ${id} updated by admin ${req.user.id}: ${JSON.stringify(req.body)}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error updating user:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/users/:id/reset-password
 * Reset a user's password
 */
router.post('/users/:id/reset-password', async (req, res) => {
    try {
        const { id } = req.params;
        const { newPassword } = req.body;

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: '密码长度至少6位' });
        }

        const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await db.run('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, parseInt(id)]);

        // Revoke all refresh tokens
        await db.run('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [parseInt(id)]);

        console.log(`[Admin] Password reset for user ${id} by admin ${req.user.id}`);
        res.json({ success: true, message: '密码已重置' });
    } catch (err) {
        console.error('[Admin] Error resetting password:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/users/:id/adjust-balance
 * Manually adjust a user's balance
 * Body: { amount (in cents, can be negative), reason }
 */
router.post('/users/:id/adjust-balance', async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, reason } = req.body;

        if (!amount || amount === 0) {
            return res.status(400).json({ error: '调整金额不能为0' });
        }

        const user = await db.get('SELECT balance FROM users WHERE id = $1', [parseInt(id)]);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const newBalance = (user.balance || 0) + parseInt(amount);
        if (newBalance < 0) {
            return res.status(400).json({ error: '调整后余额不能为负数' });
        }

        await db.run('UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
            [newBalance, parseInt(id)]);

        // Log the adjustment
        await db.run(
            `INSERT INTO balance_log (user_id, type, amount, balance_after, description, operator_id)
             VALUES ($1, 'admin_adjust', $2, $3, $4, $5)`,
            [parseInt(id), parseInt(amount), newBalance,
            reason || `管理员手动调整`, req.user.id]
        );

        console.log(`[Admin] Balance adjusted for user ${id}: ${amount}, reason: ${reason}, by admin ${req.user.id}`);
        res.json({ success: true, newBalance });
    } catch (err) {
        console.error('[Admin] Error adjusting balance:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/users/:id/set-subscription
 * Manually set a user's subscription
 * Body: { planCode, billingCycle, durationDays }
 */
router.post('/users/:id/set-subscription', async (req, res) => {
    try {
        const { id } = req.params;
        const { planCode, billingCycle = 'admin', durationDays = 30 } = req.body;

        const plan = await db.get('SELECT * FROM subscription_plans WHERE code = $1', [planCode]);
        if (!plan) {
            return res.status(404).json({ error: '套餐不存在' });
        }

        // Cancel existing
        await db.run(
            `UPDATE user_subscriptions SET status = 'expired', updated_at = NOW()
             WHERE user_id = $1 AND status = 'active'`,
            [parseInt(id)]
        );

        // Create new subscription
        await db.run(
            `INSERT INTO user_subscriptions (user_id, plan_id, billing_cycle, start_date, end_date, status, ai_credits_remaining)
             VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '${parseInt(durationDays)} days', 'active', $4)`,
            [parseInt(id), plan.id, billingCycle, plan.ai_credits_monthly || 0]
        );

        console.log(`[Admin] Subscription set for user ${id}: plan=${planCode}, days=${durationDays}, by admin ${req.user.id}`);
        res.json({ success: true, message: `已为用户设置${plan.name}，有效期${durationDays}天` });
    } catch (err) {
        console.error('[Admin] Error setting subscription:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/plans/:id
 * Update a subscription plan's pricing, limits, and status
 */
router.put('/plans/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { price_monthly, price_quarterly, price_annual, room_limit, is_active } = req.body;

        const plan = await db.get('SELECT * FROM subscription_plans WHERE id = $1', [parseInt(id)]);
        if (!plan) return res.status(404).json({ error: '套餐不存在' });

        await db.run(
            `UPDATE subscription_plans SET 
                price_monthly = $1, 
                price_quarterly = $2, 
                price_annual = $3, 
                room_limit = $4, 
                is_active = $5,
                updated_at = NOW() 
             WHERE id = $6`,
            [
                parseInt(price_monthly),
                parseInt(price_quarterly),
                parseInt(price_annual),
                parseInt(room_limit),
                is_active,
                parseInt(id)
            ]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error updating plan:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========================
// Order Management
// ========================

/**
 * GET /api/admin/orders
 * List all orders with pagination and filtering
 */
router.get('/orders', async (req, res) => {
    try {
        const { page = 1, limit = 50, status = '', search = '' } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const conditions = [];
        const params = [];
        let idx = 1;

        if (status) {
            conditions.push(`pr.status = $${idx++}`);
            params.push(status);
        }
        if (search) {
            conditions.push(`(pr.order_no ILIKE $${idx} OR u.email ILIKE $${idx})`);
            params.push(`%${search}%`);
            idx++;
        }

        const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const orders = await db.query(`
            SELECT pr.id, pr.order_no, pr.user_id, pr.amount, pr.currency, pr.payment_method,
                   pr.status, pr.paid_at, pr.created_at, pr.metadata,
                   u.email as user_email, u.nickname as user_nickname
            FROM payment_records pr
            LEFT JOIN users u ON pr.user_id = u.id
            ${whereClause}
            ORDER BY pr.created_at DESC
            LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, parseInt(limit), offset]);

        const countResult = await db.get(
            `SELECT COUNT(*) as total FROM payment_records pr LEFT JOIN users u ON pr.user_id = u.id ${whereClause}`,
            params
        );

        res.json({
            data: orders,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(countResult?.total || 0),
                totalPages: Math.ceil((parseInt(countResult?.total || 0)) / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('[Admin] Error getting orders:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/orders/:id
 * Update order status
 */
router.put('/orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['pending', 'paid', 'failed', 'refunded'].includes(status)) {
            return res.status(400).json({ error: '无效的订单状态' });
        }

        await db.run(
            'UPDATE payment_records SET status = $1, updated_at = NOW() WHERE id = $2',
            [status, parseInt(id)]
        );

        console.log(`[Admin] Order ${id} status changed to ${status} by admin ${req.user.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error updating order:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========================
// Rooms (existing)
// ========================

/**
 * GET /api/admin/rooms
 * Get all rooms in the system
 */
router.get('/rooms', async (req, res) => {
    try {
        const { page = 1, limit = 50, search = '' } = req.query;
        const result = await manager.getRooms({
            page: parseInt(page),
            limit: parseInt(limit),
            search
        });
        res.json(result);
    } catch (err) {
        console.error('[Admin] Error getting rooms:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========================
// Settings (existing)
// ========================

router.get('/settings', async (req, res) => {
    try {
        const settings = await manager.getAllSettings();
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/settings', async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/plans
 * Get subscription plans for admin dropdown
 */
router.get('/plans', async (req, res) => {
    try {
        const plans = await db.query(
            'SELECT id, name, code, room_limit, price_monthly FROM subscription_plans WHERE is_active = true ORDER BY sort_order'
        );
        res.json(plans);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
