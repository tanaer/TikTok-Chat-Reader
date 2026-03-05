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

        console.log(`[Admin] Setting subscription for user ${id}: planCode=${planCode}, durationDays=${durationDays}, by admin ${req.user.id}`);

        const plan = await db.get('SELECT * FROM subscription_plans WHERE code = $1', [planCode]);
        if (!plan) {
            console.log(`[Admin] Plan not found: ${planCode}`);
            return res.status(404).json({ error: '套餐不存在' });
        }

        console.log(`[Admin] Found plan: id=${plan.id}, name=${plan.name}`);

        // Cancel existing
        const cancelResult = await db.run(
            `UPDATE user_subscriptions SET status = 'expired', updated_at = NOW()
             WHERE user_id = $1 AND status = 'active'`,
            [parseInt(id)]
        );
        console.log(`[Admin] Cancelled ${cancelResult.rowCount || 0} existing subscriptions for user ${id}`);

        // Create new subscription
        const insertResult = await db.run(
            `INSERT INTO user_subscriptions (user_id, plan_id, billing_cycle, start_date, end_date, status, ai_credits_remaining)
             VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '${parseInt(durationDays)} days', 'active', $4) RETURNING id, end_date`,
            [parseInt(id), plan.id, billingCycle, plan.ai_credits_monthly || 0]
        );
        
        console.log(`[Admin] Created new subscription for user ${id}: plan=${planCode}, days=${durationDays}, end_date will be calculated from NOW()`);
        
        // Verify the insertion
        const verifySub = await db.get(
            `SELECT us.id, us.status, us.end_date, sp.code as plan_code 
             FROM user_subscriptions us 
             JOIN subscription_plans sp ON us.plan_id = sp.id 
             WHERE us.user_id = $1 AND us.status = 'active' 
             ORDER BY us.id DESC LIMIT 1`,
            [parseInt(id)]
        );
        
        if (verifySub) {
            console.log(`[Admin] Verification passed: id=${verifySub.id}, status=${verifySub.status}, end_date=${verifySub.end_date}, plan_code=${verifySub.plan_code}`);
        } else {
            console.error(`[Admin] Verification FAILED: No active subscription found after insertion for user ${id}`);
        }

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

        // Invalidate settings cache
        manager.settingsCache = null;
        console.log('[Admin] Settings saved and cache invalidated.');

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

/**
 * POST /api/admin/plans
 * Create a new subscription plan (e.g. for promotions)
 */
router.post('/plans', async (req, res) => {
    try {
        const { name, code, description, room_limit, history_days, ai_credits, price_monthly, price_quarterly, price_annual, is_active, plan_type, duration_days } = req.body;

        // Basic validation
        if (!name || !code) return res.status(400).json({ error: '套餐名称和代号是必填项' });

        const newPlan = await db.query(
            `INSERT INTO subscription_plans 
            (name, code, description, room_limit, history_days, ai_credits, price_monthly, price_quarterly, price_annual, is_active, plan_type, duration_days, features, sort_order) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 99) RETURNING *`,
            [
                name, code, description || '', parseInt(room_limit) || 1, parseInt(history_days) || 30, parseInt(ai_credits) || 0,
                parseFloat(price_monthly) || 0, parseFloat(price_quarterly) || 0, parseFloat(price_annual) || 0,
                is_active !== false, plan_type || 'recurring', parseInt(duration_days) || 0, '[]'
            ]
        );
        res.json(newPlan[0]);
    } catch (err) {
        console.error('[Admin] Error creating plan:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/plans/:id
 * Update existing plan details
 */
router.put('/plans/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, code, description, room_limit, history_days, ai_credits, price_monthly, price_quarterly, price_annual, is_active, plan_type, duration_days } = req.body;

        await db.run(
            `UPDATE subscription_plans SET 
                name = $1, code = $2, description = $3, room_limit = $4, 
                history_days = $5, ai_credits = $6, price_monthly = $7,
                price_quarterly = $8, price_annual = $9, is_active = $10,
                plan_type = $11, duration_days = $12, updated_at = NOW() 
            WHERE id = $13`,
            [
                name, code, description || '', parseInt(room_limit) || 1, parseInt(history_days) || 30, parseInt(ai_credits) || 0,
                parseFloat(price_monthly) || 0, parseFloat(price_quarterly) || 0, parseFloat(price_annual) || 0,
                is_active !== false, plan_type || 'recurring', parseInt(duration_days) || 0, parseInt(id)
            ]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error updating plan:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/admin/plans/:id
 * Delete a plan (hard delete, careful if orders linked)
 */
router.delete('/plans/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // Optional: Pre-flight check if users have active subscriptions using this plan
        await db.run('DELETE FROM subscription_plans WHERE id = $1', [parseInt(id)]);
        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error deleting plan:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========================
// Addons (Issue 8)
// ========================

/**
 * GET /api/admin/addons
 * Get all subscription addons
 */
router.get('/addons', async (req, res) => {
    try {
        const addons = await db.query('SELECT * FROM room_addon_packages ORDER BY sort_order');
        res.json(addons);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/addons
 * Create a new addon
 */
router.post('/addons', async (req, res) => {
    try {
        const { name, roomCount, priceMonthly, priceQuarterly, priceAnnual } = req.body;

        if (!name || !roomCount) return res.status(400).json({ error: '缺少必填字段' });

        const newAddon = await db.query(
            `INSERT INTO room_addon_packages
            (name, room_count, price_monthly, price_quarterly, price_annual, sort_order)
            VALUES ($1, $2, $3, $4, $5, 99) RETURNING *`,
            [name, parseInt(roomCount), parseFloat(priceMonthly) || 0, parseFloat(priceQuarterly) || 0, parseFloat(priceAnnual) || 0]
        );
        res.json(newAddon[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/addons/:id
 * Update an addon
 */
router.put('/addons/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, roomCount, priceMonthly, priceQuarterly, priceAnnual } = req.body;

        await db.run(
            `UPDATE room_addon_packages SET
                name = $1, room_count = $2,
                price_monthly = $3, price_quarterly = $4, price_annual = $5
            WHERE id = $6`,
            [name, parseInt(roomCount), parseFloat(priceMonthly) || 0, parseFloat(priceQuarterly) || 0, parseFloat(priceAnnual) || 0, parseInt(id)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/admin/addons/:id
 * Delete an addon
 */
router.delete('/addons/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.run('DELETE FROM room_addon_packages WHERE id = $1', [parseInt(id)]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================
// Payment QR Codes (Fixed Code Payment)
// ========================

/**
 * GET /api/admin/payment/qr-codes
 * Get all payment QR codes
 */
router.get('/payment/qr-codes', async (req, res) => {
    try {
        const qrCodes = await db.query(
            'SELECT id, name, image_data, image_url, payment_type, is_active, sort_order, created_at FROM payment_qr_codes ORDER BY sort_order, id'
        );
        res.json(qrCodes);
    } catch (err) {
        console.error('[Admin] Error getting QR codes:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/payment/qr-codes
 * Add a new payment QR code
 * Body: { name, imageData (base64), paymentType }
 */
router.post('/payment/qr-codes', async (req, res) => {
    try {
        const { name, imageData, imageUrl, paymentType = 'fixed_qr' } = req.body;

        if (!name) {
            return res.status(400).json({ error: '请输入二维码名称' });
        }
        if (!imageData && !imageUrl) {
            return res.status(400).json({ error: '请上传二维码图片' });
        }

        // Get max sort_order
        const maxOrder = await db.get('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM payment_qr_codes');
        const sortOrder = (maxOrder?.maxOrder || 0) + 1;

        const result = await db.query(
            `INSERT INTO payment_qr_codes (name, image_data, image_url, payment_type, is_active, sort_order)
             VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
            [name, imageData || null, imageUrl || null, paymentType, sortOrder]
        );

        console.log(`[Admin] QR code added: ${name}, type=${paymentType}, by admin ${req.user.id}`);
        res.json({ success: true, id: result[0]?.id });
    } catch (err) {
        console.error('[Admin] Error adding QR code:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/payment/qr-codes/:id
 * Update a payment QR code
 */
router.put('/payment/qr-codes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, imageData, imageUrl, paymentType, isActive } = req.body;

        const updates = [];
        const params = [];
        let idx = 1;

        if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name); }
        if (imageData !== undefined) { updates.push(`image_data = $${idx++}`); params.push(imageData); }
        if (imageUrl !== undefined) { updates.push(`image_url = $${idx++}`); params.push(imageUrl); }
        if (paymentType !== undefined) { updates.push(`payment_type = $${idx++}`); params.push(paymentType); }
        if (isActive !== undefined) { updates.push(`is_active = $${idx++}`); params.push(isActive); }

        if (updates.length === 0) {
            return res.status(400).json({ error: '没有要更新的字段' });
        }

        updates.push(`updated_at = NOW()`);
        params.push(parseInt(id));

        await db.run(
            `UPDATE payment_qr_codes SET ${updates.join(', ')} WHERE id = $${idx}`,
            params
        );

        console.log(`[Admin] QR code ${id} updated by admin ${req.user.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error updating QR code:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/admin/payment/qr-codes/:id
 * Delete a payment QR code
 */
router.delete('/payment/qr-codes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.run('DELETE FROM payment_qr_codes WHERE id = $1', [parseInt(id)]);
        console.log(`[Admin] QR code ${id} deleted by admin ${req.user.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error deleting QR code:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/payment/qr-codes/public
 * Get active QR codes for frontend display (no admin required, but needs auth)
 */
router.get('/payment/qr-codes/public', async (req, res) => {
    try {
        const qrCodes = await db.query(
            `SELECT id, name, image_data, image_url, payment_type 
             FROM payment_qr_codes 
             WHERE is_active = true 
             ORDER BY sort_order, id`
        );
        res.json(qrCodes);
    } catch (err) {
        console.error('[Admin] Error getting public QR codes:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
