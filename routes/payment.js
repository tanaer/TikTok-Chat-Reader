const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const paymentService = require('../services/paymentService');

const router = express.Router();

function parseNotifyBody(body, fallback = {}) {
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    if (typeof body === 'string') {
        const raw = body.trim();
        if (!raw) return fallback;
        try {
            return JSON.parse(raw);
        } catch {
            try {
                const params = new URLSearchParams(raw);
                const parsed = Object.fromEntries(params.entries());
                return Object.keys(parsed).length > 0 ? parsed : fallback;
            } catch {
                return fallback;
            }
        }
    }
    return fallback;
}

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

router.post('/orders/:orderNo/manual-review-request', authenticate, [
    param('orderNo').trim().notEmpty().withMessage('订单号不能为空')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const order = await paymentService.requestFixedQrManualReview({
            userId: req.user.id,
            orderNo: req.params.orderNo,
            baseUrl: paymentService.getPublicBaseUrl(req)
        });
        res.json({ message: '请等待确认入账', order });
    } catch (error) {
        console.error('[Payment] manual review request error:', error.message);
        res.status(400).json({ error: error.publicMessage || error.message || '提交失败，请联系管理员处理' });
    }
});

router.get('/manual-review', [
    query('token').trim().notEmpty().withMessage('缺少确认令牌')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const order = await paymentService.getManualReviewOrderByToken(req.query.token);
        res.json({ order });
    } catch (error) {
        console.error('[Payment] get manual review order error:', error.message);
        res.status(400).json({ error: error.message || '获取订单详情失败' });
    }
});

router.post('/manual-review/mark-paid', [
    body('token').trim().notEmpty().withMessage('缺少确认令牌')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const result = await paymentService.markManualReviewOrderPaidByToken(req.body.token);
        if (!result.success) return res.status(400).json({ error: result.error || '处理失败' });
        res.json({
            message: result.alreadyPaid ? '订单已是支付状态' : '订单已标记为支付成功',
            order: result.order,
            alreadyPaid: result.alreadyPaid === true
        });
    } catch (error) {
        console.error('[Payment] mark manual review order paid error:', error.message);
        res.status(500).json({ error: '移动确认入账失败' });
    }
});

router.all('/notify/futong', express.text({ type: ['text/plain', 'text/*'], limit: '1mb' }), async (req, res) => {
    try {
        const payload = parseNotifyBody(req.body, req.query || {});
        const result = await paymentService.handleFutongNotify(payload);
        if (!result.success && !result.skipped) {
            console.error('[Payment] futong notify failed:', result.error);
            return res.status(400).type('text/plain').send('fail');
        }
        return res.type('text/plain').send('success');
    } catch (error) {
        console.error('[Payment] futong notify error:', error.message);
        return res.status(500).type('text/plain').send('fail');
    }
});

router.all('/notify/bepusdt', express.text({ type: ['text/plain', 'text/*'], limit: '1mb' }), async (req, res) => {
    try {
        const payload = parseNotifyBody(req.body, req.query || {});
        const result = await paymentService.handleBepusdtNotify(payload);
        if (!result.success && !result.skipped) {
            console.error('[Payment] bepusdt notify failed:', result.error);
            return res.status(400).type('text/plain').send('fail');
        }
        return res.type('text/plain').send('success');
    } catch (error) {
        console.error('[Payment] bepusdt notify error:', error.message);
        return res.status(500).type('text/plain').send('fail');
    }
});

module.exports = router;
