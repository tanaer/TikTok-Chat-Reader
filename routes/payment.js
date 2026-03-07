const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const paymentService = require('../services/paymentService');

const router = express.Router();
router.use(express.json({ limit: '10mb' }));
router.use(express.urlencoded({ extended: false, limit: '10mb' }));

router.get('/recharge/options', authenticate, async (req, res) => {
    try {
        const data = await paymentService.getRechargeOptions(paymentService.getPublicBaseUrl(req));
        res.json(data);
    } catch (error) {
        console.error('[Payment] options error:', error.message);
        res.status(500).json({ error: '获取支付通道失败' });
    }
});

router.post('/recharge/create', authenticate, [
    body('amount').notEmpty().withMessage('请输入充值金额'),
    body('optionKey').trim().notEmpty().withMessage('请选择支付方式')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const order = await paymentService.createRechargeOrder({
            userId: req.user.id,
            amount: req.body.amount,
            optionKey: req.body.optionKey,
            req
        });
        res.json({ order });
    } catch (error) {
        console.error('[Payment] create recharge order error:', error.message);
        res.status(400).json({ error: error.message || '创建充值订单失败' });
    }
});

router.get('/orders/:orderNo', authenticate, [
    param('orderNo').trim().notEmpty().withMessage('订单号不能为空')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const order = await paymentService.getOrderForUser(req.user.id, req.params.orderNo);
        if (!order) return res.status(404).json({ error: '订单不存在' });
        res.json({ order });
    } catch (error) {
        console.error('[Payment] get order error:', error.message);
        res.status(500).json({ error: '获取订单状态失败' });
    }
});

router.post('/notify/futong', async (req, res) => {
    try {
        const result = await paymentService.handleFutongNotify(req.body || {});
        if (!result.success && !result.skipped) {
            console.error('[Payment] futong notify failed:', result.error);
            return res.status(400).send('fail');
        }
        return res.send('success');
    } catch (error) {
        console.error('[Payment] futong notify error:', error.message);
        return res.status(500).send('fail');
    }
});

router.post('/notify/bepusdt', async (req, res) => {
    try {
        const result = await paymentService.handleBepusdtNotify(req.body || {});
        if (!result.success && !result.skipped) {
            console.error('[Payment] bepusdt notify failed:', result.error);
            return res.status(400).json({ status_code: 400, message: 'fail' });
        }
        return res.json({ status_code: 200, message: 'success' });
    } catch (error) {
        console.error('[Payment] bepusdt notify error:', error.message);
        return res.status(500).json({ status_code: 500, message: 'fail' });
    }
});

module.exports = router;
