const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, optionalAuth } = require('../middleware/auth');
const subscriptionService = require('../services/subscriptionService');

const router = express.Router();

/**
 * GET /api/subscription/plans - public
 */
router.get('/plans', async (req, res) => {
    try {
        const plans = await db.all(
            `SELECT id, name, code, room_limit, price_monthly, price_quarterly, price_annual, feature_flags, sort_order, daily_room_create_limit, ai_credits_monthly
             FROM subscription_plans
             WHERE is_active = true
               AND code <> 'gift'
               AND (price_monthly > 0 OR price_quarterly > 0 OR price_annual > 0)
             ORDER BY sort_order`
        );
        res.json({ plans });
    } catch (err) {
        console.error('[Sub] Plans error:', err.message);
        res.status(500).json({ error: '获取套餐列表失败' });
    }
});

/**
 * GET /api/subscription/addons - public
 */
router.get('/addons', optionalAuth, async (req, res) => {
    try {
        const addons = await db.all(
            `SELECT id, name, room_count, price_monthly, price_quarterly, price_annual
             FROM room_addon_packages WHERE is_active = true ORDER BY room_count`
        );
        let currentSubscription = null;
        if (req.user?.id) {
            currentSubscription = await subscriptionService.getActiveSubscription(req.user.id);
        }

        const safeAddons = addons.map((addon) => {
            const preview = currentSubscription
                ? subscriptionService.previewAddonPurchase(addon, currentSubscription)
                : null;

            return {
                id: addon.id,
                name: addon.name,
                roomCount: addon.roomCount,
                priceMonthly: addon.priceMonthly,
                priceQuarterly: addon.priceQuarterly,
                priceAnnual: addon.priceAnnual,
                followsSubscription: true,
                requiredPlanCode: 'enterprise',
                purchasePreview: preview
                    ? (preview.ok
                        ? {
                            available: true,
                            price: preview.price,
                            remainingDays: preview.remainingDays,
                            endDate: preview.endDate,
                            billingCycle: preview.billingCycle,
                            billingCycleLabel: preview.billingCycleLabel,
                            followsSubscription: true,
                        }
                        : {
                            available: false,
                            message: preview.error,
                            followsSubscription: true,
                        })
                    : null,
            };
        });

        res.json({ addons: safeAddons });
    } catch (err) {
        console.error('[Sub] Addons error:', err.message);
        res.status(500).json({ error: '获取扩容包列表失败' });
    }
});

/**
 * POST /api/subscription/purchase - buy a plan
 */
router.post('/purchase', authenticate, [
    body('planId').isInt({ min: 1 }).withMessage('请选择套餐'),
    body('billingCycle').isIn(['monthly', 'quarterly', 'yearly']).withMessage('请选择计费周期'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { planId, billingCycle } = req.body;
        const result = await subscriptionService.purchasePlan(req.user.id, planId, billingCycle);

        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (err) {
        console.error('[Sub] Purchase error:', err.message);
        res.status(500).json({ error: '购买失败' });
    }
});

/**
 * POST /api/subscription/purchase-addon - buy an addon
 */
router.post('/purchase-addon', authenticate, [
    body('addonId').isInt({ min: 1 }).withMessage('请选择扩容包'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { addonId } = req.body;
        const result = await subscriptionService.purchaseAddon(req.user.id, addonId);

        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (err) {
        console.error('[Sub] Addon purchase error:', err.message);
        res.status(500).json({ error: '购买失败' });
    }
});

/**
 * GET /api/subscription/ai-credit-packages - public list
 */
router.get('/ai-credit-packages', async (req, res) => {
    try {
        const packages = await db.all(
            `SELECT id, name, credits, CAST(ROUND(price_cents / 100.0) AS INTEGER) AS price_yuan, description
             FROM ai_credit_packages
             WHERE is_active = true
             ORDER BY credits`
        );
        res.json({ packages });
    } catch (err) {
        res.status(500).json({ error: '获取AI额度包失败' });
    }
});

/**
 * POST /api/subscription/purchase-ai-credits - buy AI credit package
 */
router.post('/purchase-ai-credits', authenticate, [
    body('packageId').isInt({ min: 1 }).withMessage('请选择点数包'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const { packageId } = req.body;
        const pkg = await db.get(
            'SELECT id, name, credits, price_cents FROM ai_credit_packages WHERE id = ? AND is_active = true',
            [packageId]
        );
        if (!pkg) return res.status(404).json({ error: '点数包不存在或已下架' });

        const priceYuan = Math.round(Number(pkg.priceCents || 0) / 100);
        const balanceService = require('../services/balanceService');
        const purchase = await balanceService.purchaseWithBalance(
            req.user.id, priceYuan, 'ai_credits', pkg.name,
            `AI点数: ${pkg.name}, ${pkg.credits}点`
        );
        if (!purchase.success) return res.status(400).json(purchase);

        // Add credits to user
        await db.run(
            'UPDATE users SET ai_credits_remaining = ai_credits_remaining + ? WHERE id = ?',
            [pkg.credits, req.user.id]
        );

        res.json({
            success: true,
            credits: pkg.credits,
            order: purchase.order
        });
    } catch (err) {
        console.error('[Sub] AI credits purchase error:', err.message);
        res.status(500).json({ error: '购买失败' });
    }
});

module.exports = router;
