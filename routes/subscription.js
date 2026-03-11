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
            `SELECT id, name, room_count, price_monthly, price_quarterly, price_annual, per_user_purchase_limit
             FROM room_addon_packages WHERE is_active = true ORDER BY room_count`
        );
        let currentSubscription = null;
        if (req.user?.id) {
            currentSubscription = await subscriptionService.getActiveSubscription(req.user.id);
        }

        const safeAddons = await Promise.all(addons.map(async (addon) => {
            const preview = currentSubscription
                ? await subscriptionService.enrichAddonPurchasePreview(addon, currentSubscription, req.user?.id || null)
                : null;

            return {
                id: addon.id,
                name: addon.name,
                roomCount: addon.roomCount,
                priceMonthly: addon.priceMonthly,
                priceQuarterly: addon.priceQuarterly,
                priceAnnual: addon.priceAnnual,
                perUserPurchaseLimit: addon.perUserPurchaseLimit || null,
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
                            purchaseLimit: preview.purchaseLimit || null,
                            purchaseCount: Number(preview.purchaseCount || 0),
                            remainingPurchases: preview.remainingPurchases ?? null,
                        }
                        : {
                            available: false,
                            message: preview.error,
                            followsSubscription: true,
                            purchaseLimit: preview.purchaseLimit || null,
                            purchaseCount: Number(preview.purchaseCount || 0),
                            remainingPurchases: preview.remainingPurchases ?? null,
                        })
                    : null,
            };
        }));

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
router.get('/ai-credit-packages', optionalAuth, async (req, res) => {
    try {
        const packages = await db.all(
            `SELECT id, name, credits, CAST(ROUND(price_cents / 100.0) AS INTEGER) AS price_yuan, description, per_user_purchase_limit
             FROM ai_credit_packages
             WHERE is_active = true
             ORDER BY credits`
        );
        const packagesWithPreview = await Promise.all(packages.map(async (pkg) => {
            const purchaseLimit = pkg.perUserPurchaseLimit ? Number(pkg.perUserPurchaseLimit) : null;
            let purchaseCount = 0;
            let remainingPurchases = purchaseLimit;

            if (req.user?.id && purchaseLimit) {
                const purchaseCountRow = await db.get(
                    `SELECT COUNT(*) AS total
                     FROM payment_records
                     WHERE user_id = ?
                       AND type = 'ai_credits'
                       AND status = 'paid'
                       AND (
                            (metadata IS NOT NULL AND metadata->>'packageId' = ?)
                            OR item_name = ?
                       )`,
                    [req.user.id, String(pkg.id), pkg.name]
                );
                purchaseCount = Number(purchaseCountRow?.total || 0);
                remainingPurchases = Math.max(0, purchaseLimit - purchaseCount);
            }

            const purchasePreview = purchaseLimit
                ? {
                    available: remainingPurchases > 0,
                    purchaseLimit,
                    purchaseCount,
                    remainingPurchases,
                    message: remainingPurchases > 0
                        ? `当前还可购买 ${remainingPurchases} 次`
                        : `该 AI 点数包单账户最多可购买 ${purchaseLimit} 次`,
                }
                : null;

            return {
                id: pkg.id,
                name: pkg.name,
                credits: Number(pkg.credits || 0),
                priceYuan: Number(pkg.priceYuan || 0),
                description: pkg.description || '',
                perUserPurchaseLimit: purchaseLimit,
                purchasePreview,
            };
        }));
        res.json({ packages: packagesWithPreview });
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
            'SELECT id, name, credits, price_cents, per_user_purchase_limit FROM ai_credit_packages WHERE id = ? AND is_active = true',
            [packageId]
        );
        if (!pkg) return res.status(404).json({ error: '点数包不存在或已下架' });

        const purchaseLimit = pkg.perUserPurchaseLimit ? Number(pkg.perUserPurchaseLimit) : null;
        if (purchaseLimit) {
            const purchaseCountRow = await db.get(
                `SELECT COUNT(*) AS total
                 FROM payment_records
                 WHERE user_id = ?
                   AND type = 'ai_credits'
                   AND status = 'paid'
                   AND (
                        (metadata IS NOT NULL AND metadata->>'packageId' = ?)
                        OR item_name = ?
                   )`,
                [req.user.id, String(pkg.id), pkg.name]
            );
            const purchaseCount = Number(purchaseCountRow?.total || 0);
            if (purchaseCount >= purchaseLimit) {
                return res.status(400).json({ error: `该 AI 点数包单账户最多可购买 ${purchaseLimit} 次` });
            }
        }

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

        await db.run(
            `UPDATE payment_records
             SET metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
                 updated_at = NOW()
             WHERE order_no = ?`,
            [JSON.stringify({ packageId: String(pkg.id) }), purchase.order.orderNo]
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
