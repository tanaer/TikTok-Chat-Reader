/**
 * Subscription API Routes
 * Balance-based purchasing: users pay from account balance
 * Supports monthly/quarterly/annual billing cycles with tiered discounts
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, loadSubscription } = require('../auth/middleware');

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/subscription
 * Get current user's subscription details + balance
 */
router.get('/', loadSubscription, async (req, res) => {
    try {
        const userId = req.user.id;
        const sub = req.subscription;

        // Get user balance
        const user = await db.get('SELECT balance FROM users WHERE id = $1', [userId]);

        // Count current rooms
        const roomCount = await db.get(
            'SELECT COUNT(*) as cnt FROM user_room WHERE user_id = $1',
            [userId]
        );

        // Get active addons
        const addons = await db.query(`
            SELECT ura.id, ura.billing_cycle, ura.start_date, ura.end_date, ura.status,
                   rap.name as package_name, rap.room_count
            FROM user_room_addons ura
            JOIN room_addon_packages rap ON ura.package_id = rap.id
            WHERE ura.user_id = $1 AND ura.status = 'active' AND ura.end_date > NOW()
            ORDER BY ura.created_at DESC
        `, [userId]);

        // Get subscription record details
        const subRecord = await db.get(`
            SELECT us.id, us.billing_cycle, us.start_date, us.end_date, us.auto_renew, us.status,
                   us.ai_credits_remaining, us.ai_credits_used
            FROM user_subscriptions us
            WHERE us.user_id = $1 AND us.status = 'active'
            ORDER BY us.end_date DESC LIMIT 1
        `, [userId]);

        const endDate = subRecord?.end_date || null;
        const daysRemaining = endDate ? Math.ceil((new Date(endDate) - new Date()) / (1000 * 60 * 60 * 24)) : -1;

        res.json({
            balance: user?.balance || 0,
            plan: {
                code: sub.plan_code,
                name: sub.plan_name,
                roomLimit: sub.plan_room_limit,
                historyDays: sub.history_days,
                featureFlags: sub.feature_flags
            },
            billingCycle: subRecord?.billing_cycle || 'free',
            startDate: subRecord?.start_date || null,
            endDate,
            daysRemaining,
            autoRenew: subRecord?.auto_renew || false,
            aiCreditsRemaining: subRecord?.ai_credits_remaining || 0,
            aiCreditsUsed: subRecord?.ai_credits_used || 0,
            roomUsage: {
                current: parseInt(roomCount?.cnt || 0),
                planLimit: sub.plan_room_limit,
                addonRooms: sub.addonRooms,
                totalLimit: sub.totalRoomLimit
            },
            addons: addons || []
        });
    } catch (err) {
        console.error('[Subscription] Error getting subscription:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/subscription/plans
 * Get all available subscription plans and addon packages (with 3 pricing tiers)
 */
router.get('/plans', async (req, res) => {
    try {
        const plans = await db.query(
            `SELECT id, name, code, price_monthly, price_quarterly, price_annual, room_limit, 
                    history_days, api_rate_limit, feature_flags, ai_credits_monthly, description
             FROM subscription_plans 
             WHERE is_active = true 
             ORDER BY sort_order`
        );

        const addons = await db.query(
            `SELECT id, name, room_count, price_monthly, price_quarterly, price_annual
             FROM room_addon_packages 
             WHERE is_active = true 
             ORDER BY sort_order`
        );

        // Get current user balance
        const user = await db.get('SELECT balance FROM users WHERE id = $1', [req.user.id]);

        res.json({ plans, addons, balance: user?.balance || 0 });
    } catch (err) {
        console.error('[Subscription] Error getting plans:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/subscription/purchase
 * Purchase or upgrade a subscription using account balance
 * Includes proration: refunds remaining value of old subscription
 * Body: { planCode, billingCycle: 'monthly'|'quarterly'|'annual' }
 */
router.post('/purchase', loadSubscription, async (req, res) => {
    try {
        const { planCode, billingCycle } = req.body;
        const userId = req.user.id;

        if (!planCode || !billingCycle) {
            return res.status(400).json({ error: '请选择套餐和付费周期' });
        }

        if (!['monthly', 'quarterly', 'annual'].includes(billingCycle)) {
            return res.status(400).json({ error: '无效的付费周期' });
        }

        // Get plan details
        const plan = await db.get(
            'SELECT * FROM subscription_plans WHERE code = $1 AND is_active = true',
            [planCode]
        );
        if (!plan) {
            return res.status(404).json({ error: '套餐不存在' });
        }

        // Determine price by cycle
        let price;
        if (billingCycle === 'monthly') price = plan.price_monthly;
        else if (billingCycle === 'quarterly') price = plan.price_quarterly;
        else price = plan.price_annual;

        if (price === 0) {
            return res.status(400).json({ error: '该套餐暂不可购买' });
        }

        // --- Proration: calculate refund for existing subscription ---
        let prorationRefund = 0;
        const existingSub = await db.get(`
            SELECT us.id, us.start_date, us.end_date, us.billing_cycle,
                   sp.price_monthly as old_price_monthly, sp.price_quarterly as old_price_quarterly,
                   sp.price_annual as old_price_annual, sp.name as old_plan_name, sp.code as old_plan_code
            FROM user_subscriptions us
            JOIN subscription_plans sp ON us.plan_id = sp.id
            WHERE us.user_id = $1 AND us.status = 'active' AND us.end_date > NOW()
            ORDER BY us.end_date DESC LIMIT 1
        `, [userId]);

        if (existingSub && existingSub.oldPlanCode !== 'free') {
            // Calculate remaining value
            const now = new Date();
            const endDate = new Date(existingSub.endDate);
            const startDate = existingSub.startDate ? new Date(existingSub.startDate) : now;

            // Ensure valid numbers
            const totalDays = Math.max(1, (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
            const remainingDays = Math.max(0, (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

            // Get original price paid
            let oldPrice = 0;
            const oldCycle = existingSub.billingCycle;
            if (oldCycle === 'monthly') oldPrice = Number(existingSub.oldPriceMonthly) || 0;
            else if (oldCycle === 'quarterly') oldPrice = Number(existingSub.oldPriceQuarterly) || 0;
            else if (oldCycle === 'annual') oldPrice = Number(existingSub.oldPriceAnnual) || 0;

            if (oldPrice > 0 && remainingDays > 0) {
                prorationRefund = Math.floor(oldPrice * (remainingDays / totalDays)) || 0;
            }
        }

        // Calculate net cost
        const netCost = Math.max(0, price - prorationRefund);

        // Check balance against net cost
        const user = await db.get('SELECT balance FROM users WHERE id = $1', [userId]);
        const balance = user?.balance || 0;

        if (balance < netCost) {
            return res.status(400).json({
                error: '余额不足，请先充值',
                code: 'INSUFFICIENT_BALANCE',
                balance,
                required: netCost,
                shortfall: netCost - balance,
                prorationRefund,
                originalPrice: price
            });
        }

        const intervalMap = { monthly: '1 month', quarterly: '3 months', annual: '1 year' };
        const intervalStr = intervalMap[billingCycle];
        const orderNo = `SUB-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        const cycleNames = { monthly: '月付', quarterly: '季付', annual: '年付' };

        let currentBalance = balance;

        // Step 1: If proration refund, credit it first
        if (prorationRefund > 0) {
            currentBalance += prorationRefund;
            await db.run('UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2', [currentBalance, userId]);
            await db.run(
                `INSERT INTO balance_log (user_id, type, amount, balance_after, description, ref_order_no)
                 VALUES ($1, 'refund', $2, $3, $4, $5)`,
                [userId, prorationRefund, currentBalance,
                    `套餐变更退款(${existingSub.oldPlanName}剩余天数折算)`, orderNo]
            );
        }

        // Step 2: Deduct new plan price
        currentBalance -= price;
        await db.run('UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2', [currentBalance, userId]);

        await db.run(
            `INSERT INTO balance_log (user_id, type, amount, balance_after, description, ref_order_no)
             VALUES ($1, 'purchase', $2, $3, $4, $5)`,
            [userId, -price, currentBalance, `购买${plan.name}(${cycleNames[billingCycle]})`, orderNo]
        );

        // Create payment record (records net amount)
        await db.run(
            `INSERT INTO payment_records (user_id, order_no, amount, currency, payment_method, status, paid_at, metadata)
             VALUES ($1, $2, $3, 'CNY', 'balance', 'paid', NOW(), $4)`,
            [userId, orderNo, netCost, JSON.stringify({
                type: 'subscription', plan_code: planCode, plan_name: plan.name,
                billing_cycle: billingCycle, proration_refund: prorationRefund, original_price: price
            })]
        );

        // Cancel existing active subscription
        await db.run(
            `UPDATE user_subscriptions SET status = 'expired', updated_at = NOW()
             WHERE user_id = $1 AND status = 'active'`,
            [userId]
        );

        // Create new subscription
        await db.run(
            `INSERT INTO user_subscriptions (user_id, plan_id, billing_cycle, start_date, end_date, status, auto_renew, ai_credits_remaining)
             VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '${intervalStr}', 'active', false, $4)`,
            [userId, plan.id, billingCycle, plan.ai_credits_monthly || 0]
        );

        const prorationMsg = prorationRefund > 0
            ? `（原套餐退款 ¥${(prorationRefund / 100).toFixed(2)}，实付 ¥${(netCost / 100).toFixed(2)}）`
            : '';

        console.log(`[Subscription] Purchased: user=${userId}, plan=${planCode}, cycle=${billingCycle}, price=${price}, refund=${prorationRefund}, net=${netCost}`);

        res.json({
            success: true,
            message: `已成功开通${plan.name}(${cycleNames[billingCycle]})${prorationMsg}`,
            orderNo,
            amount: netCost,
            prorationRefund,
            newBalance: currentBalance
        });
    } catch (err) {
        console.error('[Subscription] Purchase error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/subscription/cancel
 * Cancel auto-renewal
 */
router.post('/cancel', async (req, res) => {
    try {
        await db.run(
            `UPDATE user_subscriptions SET auto_renew = false, cancelled_at = NOW(), updated_at = NOW()
             WHERE user_id = $1 AND status = 'active'`,
            [req.user.id]
        );
        res.json({ success: true, message: '已取消自动续费' });
    } catch (err) {
        console.error('[Subscription] Cancel error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/subscription/addon/purchase
 * Purchase a room addon package using balance
 * Body: { packageId, billingCycle: 'monthly'|'quarterly'|'annual' }
 */
router.post('/addon/purchase', loadSubscription, async (req, res) => {
    try {
        const { packageId, billingCycle } = req.body;
        const userId = req.user.id;

        if (!packageId || !billingCycle) {
            return res.status(400).json({ error: '请选择加购包和付费周期' });
        }

        if (!['monthly', 'quarterly', 'annual'].includes(billingCycle)) {
            return res.status(400).json({ error: '无效的付费周期' });
        }

        const pkg = await db.get(
            'SELECT * FROM room_addon_packages WHERE id = $1 AND is_active = true',
            [packageId]
        );
        if (!pkg) {
            return res.status(404).json({ error: '加购包不存在' });
        }

        let price;
        if (billingCycle === 'monthly') price = pkg.price_monthly;
        else if (billingCycle === 'quarterly') price = pkg.price_quarterly;
        else price = pkg.price_annual;

        // Check balance
        const user = await db.get('SELECT balance FROM users WHERE id = $1', [userId]);
        const balance = user?.balance || 0;

        if (balance < price) {
            return res.status(400).json({
                error: '余额不足，请先充值',
                code: 'INSUFFICIENT_BALANCE',
                balance,
                required: price,
                shortfall: price - balance
            });
        }

        const intervalMap = { monthly: '1 month', quarterly: '3 months', annual: '1 year' };
        const intervalStr = intervalMap[billingCycle];
        const cycleNames = { monthly: '月付', quarterly: '季付', annual: '年付' };
        const orderNo = `ADDON-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        // Deduct balance
        const newBalance = balance - price;
        await db.run('UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, userId]);

        // Log balance change
        await db.run(
            `INSERT INTO balance_log (user_id, type, amount, balance_after, description, ref_order_no)
             VALUES ($1, 'purchase', $2, $3, $4, $5)`,
            [userId, -price, newBalance, `购买${pkg.name}(${cycleNames[billingCycle]})`, orderNo]
        );

        // Create payment record
        await db.run(
            `INSERT INTO payment_records (user_id, order_no, amount, currency, payment_method, status, paid_at, metadata)
             VALUES ($1, $2, $3, 'CNY', 'balance', 'paid', NOW(), $4)`,
            [userId, orderNo, price, JSON.stringify({
                type: 'room_addon', package_id: packageId, package_name: pkg.name,
                room_count: pkg.room_count, billing_cycle: billingCycle
            })]
        );

        // Activate addon
        await db.run(
            `INSERT INTO user_room_addons (user_id, package_id, order_no, billing_cycle, start_date, end_date, status)
             VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '${intervalStr}', 'active')`,
            [userId, packageId, orderNo, billingCycle]
        );

        console.log(`[Subscription] Addon purchased: user=${userId}, pkg=${pkg.name}, cycle=${billingCycle}`);

        res.json({
            success: true,
            message: `已成功购买${pkg.name}(${cycleNames[billingCycle]})`,
            orderNo,
            amount: price,
            newBalance
        });
    } catch (err) {
        console.error('[Subscription] Addon purchase error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/subscription/addon
 * Get current user's room addons (all, including expired)
 */
router.get('/addon', async (req, res) => {
    try {
        const addons = await db.query(`
            SELECT ura.id, ura.billing_cycle, ura.start_date, ura.end_date, ura.status,
                   rap.name as package_name, rap.room_count
            FROM user_room_addons ura
            JOIN room_addon_packages rap ON ura.package_id = rap.id
            WHERE ura.user_id = $1
            ORDER BY ura.created_at DESC
        `, [req.user.id]);

        res.json({ addons });
    } catch (err) {
        console.error('[Subscription] Addon list error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/subscription/orders
 * Get current user's order history
 */
router.get('/orders', async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const orders = await db.query(`
            SELECT order_no, amount, currency, payment_method, status, paid_at, created_at, metadata
            FROM payment_records
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
        `, [req.user.id, parseInt(limit), offset]);

        const countResult = await db.get(
            'SELECT COUNT(*) as total FROM payment_records WHERE user_id = $1',
            [req.user.id]
        );

        res.json({
            orders,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(countResult?.total || 0)
            }
        });
    } catch (err) {
        console.error('[Subscription] Orders error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
