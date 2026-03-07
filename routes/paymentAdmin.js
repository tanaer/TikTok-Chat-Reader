const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticate, requireAdmin } = require('../middleware/auth');
const paymentService = require('../services/paymentService');

const router = express.Router();
router.use(authenticate, requireAdmin);

router.get('/config', async (req, res) => {
    try {
        const config = await paymentService.getAdminPaymentConfig(paymentService.getPublicBaseUrl(req));
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.json({ config });
    } catch (error) {
        console.error('[AdminPayment] config load error:', error.message);
        res.status(500).json({ error: '获取支付配置失败' });
    }
});

router.put('/config', [
    body('config').isObject().withMessage('无效的支付配置')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        await paymentService.savePaymentConfig(req.body.config);
        res.json({ message: '支付配置保存成功' });
    } catch (error) {
        console.error('[AdminPayment] config save error:', error.message);
        res.status(500).json({ error: '保存支付配置失败' });
    }
});

router.post('/orders/:id/mark-paid', [
    param('id').isInt({ min: 1 }).withMessage('订单ID无效')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const result = await paymentService.markRechargeOrderPaid({
        orderId: Number(req.params.id),
        provider: 'admin_manual',
        verifyResult: 'admin_manual_confirmed',
        operatorId: req.user.id
    });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ message: result.alreadyPaid ? '订单已是支付状态' : '订单已标记为支付成功', order: result.order });
});

router.post('/orders/:id/cancel', [
    param('id').isInt({ min: 1 }).withMessage('订单ID无效')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const result = await paymentService.cancelRechargeOrder({
        orderId: Number(req.params.id),
        operatorId: req.user.id,
        reason: '管理员取消订单'
    });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ message: result.alreadyCancelled ? '订单已取消' : '订单已取消', order: result.order });
});

module.exports = router;
