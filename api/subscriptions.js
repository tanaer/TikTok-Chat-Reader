/**
 * Subscription API Routes
 * Handles subscription plans, user subscriptions, and upgrades
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, loadSubscription } = require('../auth');

/**
 * GET /api/plans
 * Get all active subscription plans
 */
router.get('/plans', async (req, res) => {
    try {
        const plans = await db.query(`
            SELECT id, name, code, price_monthly, price_quarterly, 
                   price_semiannual, price_annual, room_limit, history_days,
                   api_rate_limit, feature_flags, description
            FROM subscription_plans 
            WHERE is_active = true
            ORDER BY sort_order ASC
        `);

        // Format prices (convert from cents to yuan)
        const formattedPlans = plans.map(p => ({
            id: p.id,
            name: p.name,
            code: p.code,
            prices: {
                monthly: p.price_monthly / 100,
                quarterly: p.price_quarterly / 100,
                semiannual: p.price_semiannual / 100,
                annual: p.price_annual / 100
            },
            limits: {
                rooms: p.room_limit === -1 ? '不限' : p.room_limit,
                historyDays: p.history_days === -1 ? '不限' : p.history_days,
                apiRateLimit: p.api_rate_limit === -1 ? '不限' : p.api_rate_limit
            },
            features: p.feature_flags || {},
            description: p.description
        }));

        res.json(formattedPlans);

    } catch (err) {
        console.error('[Subscription] Get plans error:', err);
        res.status(500).json({ error: '获取订阅方案失败' });
    }
});

/**
 * GET /api/subscription
 * Get current user's subscription status
 */
router.get('/subscription', requireAuth, loadSubscription, async (req, res) => {
    try {
        // Get detailed subscription info
        const subscription = await db.get(`
            SELECT s.*, p.name as plan_name, p.code as plan_code,
                   p.room_limit, p.history_days, p.api_rate_limit, p.feature_flags
            FROM user_subscriptions s
            JOIN subscription_plans p ON s.plan_id = p.id
            WHERE s.user_id = $1 AND s.status = 'active' AND s.end_date > NOW()
            ORDER BY p.sort_order DESC
            LIMIT 1
        `, [req.user.id]);

        if (!subscription) {
            // Return free tier info
            const freePlan = await db.get(`SELECT * FROM subscription_plans WHERE code = 'free'`);
            return res.json({
                planName: '免费版',
                planCode: 'free',
                status: 'active',
                limits: {
                    rooms: freePlan?.room_limit || 1,
                    historyDays: freePlan?.history_days || 7
                },
                features: freePlan?.feature_flags || {},
                endDate: null,
                autoRenew: false
            });
        }

        // Count current room usage
        const roomCount = await db.get(`
            SELECT COUNT(*) as count FROM rooms WHERE user_id = $1
        `, [req.user.id]);

        res.json({
            id: subscription.id,
            planName: subscription.plan_name,
            planCode: subscription.plan_code,
            billingCycle: subscription.billing_cycle,
            startDate: subscription.start_date,
            endDate: subscription.end_date,
            status: subscription.status,
            autoRenew: subscription.auto_renew,
            limits: {
                rooms: subscription.room_limit === -1 ? '不限' : subscription.room_limit,
                historyDays: subscription.history_days === -1 ? '不限' : subscription.history_days,
                apiRateLimit: subscription.api_rate_limit === -1 ? '不限' : subscription.api_rate_limit
            },
            usage: {
                rooms: parseInt(roomCount?.count || 0)
            },
            features: subscription.feature_flags || {}
        });

    } catch (err) {
        console.error('[Subscription] Get subscription error:', err);
        res.status(500).json({ error: '获取订阅信息失败' });
    }
});

/**
 * POST /api/subscription/create
 * Create a new subscription order (returns payment info)
 */
router.post('/subscription/create', requireAuth, async (req, res) => {
    try {
        const { planCode, billingCycle } = req.body;

        if (!planCode || !billingCycle) {
            return res.status(400).json({ error: '请选择订阅方案和计费周期' });
        }

        const validCycles = ['monthly', 'quarterly', 'semiannual', 'annual'];
        if (!validCycles.includes(billingCycle)) {
            return res.status(400).json({ error: '无效的计费周期' });
        }

        // Get plan info
        const plan = await db.get(`
            SELECT * FROM subscription_plans WHERE code = $1 AND is_active = true
        `, [planCode]);

        if (!plan) {
            return res.status(404).json({ error: '订阅方案不存在' });
        }

        if (planCode === 'free') {
            return res.status(400).json({ error: '免费版无需购买' });
        }

        // Calculate price based on billing cycle
        const priceMap = {
            monthly: plan.price_monthly,
            quarterly: plan.price_quarterly,
            semiannual: plan.price_semiannual,
            annual: plan.price_annual
        };
        const amount = priceMap[billingCycle];

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: '该方案不支持此计费周期' });
        }

        // Generate order number
        const orderNo = `SUB${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

        // Calculate subscription dates
        const durationMap = {
            monthly: '1 month',
            quarterly: '3 months',
            semiannual: '6 months',
            annual: '1 year'
        };

        // Create payment record
        await db.run(`
            INSERT INTO payment_records (user_id, order_no, amount, currency, status, metadata)
            VALUES ($1, $2, $3, 'CNY', 'pending', $4)
        `, [
            req.user.id,
            orderNo,
            amount,
            JSON.stringify({
                planId: plan.id,
                planCode: plan.code,
                planName: plan.name,
                billingCycle,
                duration: durationMap[billingCycle]
            })
        ]);

        res.json({
            orderNo,
            planName: plan.name,
            billingCycle,
            amount: amount / 100, // Convert to yuan
            currency: 'CNY',
            expireInMinutes: 30,
            // Payment methods will be added when payment integration is done
            paymentMethods: ['alipay', 'wxpay']
        });

    } catch (err) {
        console.error('[Subscription] Create order error:', err);
        res.status(500).json({ error: '创建订单失败' });
    }
});

/**
 * POST /api/subscription/cancel
 * Cancel auto-renewal for current subscription
 */
router.post('/subscription/cancel', requireAuth, async (req, res) => {
    try {
        const result = await db.run(`
            UPDATE user_subscriptions 
            SET auto_renew = false, cancelled_at = NOW(), updated_at = NOW()
            WHERE user_id = $1 AND status = 'active' AND end_date > NOW()
        `, [req.user.id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: '没有找到活跃的订阅' });
        }

        res.json({
            message: '已取消自动续费，当前订阅将在到期后失效',
            success: true
        });

    } catch (err) {
        console.error('[Subscription] Cancel error:', err);
        res.status(500).json({ error: '取消订阅失败' });
    }
});

/**
 * GET /api/subscription/history
 * Get user's subscription history
 */
router.get('/subscription/history', requireAuth, async (req, res) => {
    try {
        const history = await db.query(`
            SELECT s.*, p.name as plan_name, p.code as plan_code
            FROM user_subscriptions s
            JOIN subscription_plans p ON s.plan_id = p.id
            WHERE s.user_id = $1
            ORDER BY s.created_at DESC
            LIMIT 20
        `, [req.user.id]);

        res.json(history);

    } catch (err) {
        console.error('[Subscription] History error:', err);
        res.status(500).json({ error: '获取订阅历史失败' });
    }
});

module.exports = router;
