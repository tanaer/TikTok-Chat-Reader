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
            `SELECT id, name, code, room_limit, price_monthly, price_quarterly, price_annual, feature_flags, sort_order
             FROM subscription_plans WHERE is_active = true ORDER BY sort_order`
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
router.get('/addons', async (req, res) => {
    try {
        const addons = await db.all(
            `SELECT id, name, room_count, price_monthly, price_quarterly, price_annual
             FROM room_addon_packages WHERE is_active = true ORDER BY room_count`
        );
        res.json({ addons });
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
    body('billingCycle').optional().isIn(['monthly', 'quarterly', 'yearly']).withMessage('请选择计费周期'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { addonId, billingCycle } = req.body;
        const result = await subscriptionService.purchaseAddon(req.user.id, addonId, billingCycle || 'monthly');

        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (err) {
        console.error('[Sub] Addon purchase error:', err.message);
        res.status(500).json({ error: '购买失败' });
    }
});

module.exports = router;
