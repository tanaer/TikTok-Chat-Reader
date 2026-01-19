/**
 * Payment API Routes
 * Handles payment creation, callbacks, and history
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../auth');

/**
 * POST /api/payment/create
 * Create payment for an order (mock implementation - replace with real payment gateway)
 */
router.post('/create', requireAuth, async (req, res) => {
    try {
        const { orderNo, paymentMethod } = req.body;

        if (!orderNo || !paymentMethod) {
            return res.status(400).json({ error: '订单号和支付方式为必填项' });
        }

        // Get order
        const order = await db.get(`
            SELECT * FROM payment_records 
            WHERE order_no = $1 AND user_id = $2 AND status = 'pending'
        `, [orderNo, req.user.id]);

        if (!order) {
            return res.status(404).json({ error: '订单不存在或已过期' });
        }

        // Update payment method
        await db.run(`
            UPDATE payment_records SET payment_method = $1, updated_at = NOW()
            WHERE id = $2
        `, [paymentMethod, order.id]);

        // TODO: Integrate with actual payment gateway
        // For now, return mock payment info

        if (paymentMethod === 'alipay') {
            res.json({
                orderNo,
                paymentMethod: 'alipay',
                payUrl: `https://mock-alipay.com/pay?out_trade_no=${orderNo}`,
                qrCode: null, // Would be base64 QR code
                expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString()
            });
        } else if (paymentMethod === 'wxpay') {
            res.json({
                orderNo,
                paymentMethod: 'wxpay',
                payUrl: null,
                qrCode: `weixin://wxpay/bizpayurl?pr=${orderNo}`, // Mock code_url
                expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString()
            });
        } else {
            return res.status(400).json({ error: '不支持的支付方式' });
        }

    } catch (err) {
        console.error('[Payment] Create error:', err);
        res.status(500).json({ error: '创建支付失败' });
    }
});

/**
 * POST /api/payment/notify/alipay
 * Alipay payment callback (webhook)
 */
router.post('/notify/alipay', async (req, res) => {
    try {
        // TODO: Verify Alipay signature
        const { out_trade_no, trade_no, trade_status } = req.body;

        console.log(`[Payment] Alipay notify: order=${out_trade_no}, status=${trade_status}`);

        if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
            await processSuccessfulPayment(out_trade_no, trade_no, 'alipay');
            res.send('success');
        } else {
            res.send('success'); // Acknowledge receipt
        }

    } catch (err) {
        console.error('[Payment] Alipay notify error:', err);
        res.status(500).send('fail');
    }
});

/**
 * POST /api/payment/notify/wxpay
 * WeChat pay callback (webhook)
 */
router.post('/notify/wxpay', async (req, res) => {
    try {
        // TODO: Verify WeChat signature and decrypt message
        const { out_trade_no, transaction_id, trade_state } = req.body;

        console.log(`[Payment] WxPay notify: order=${out_trade_no}, status=${trade_state}`);

        if (trade_state === 'SUCCESS') {
            await processSuccessfulPayment(out_trade_no, transaction_id, 'wxpay');
            res.json({ code: 'SUCCESS', message: '成功' });
        } else {
            res.json({ code: 'SUCCESS', message: '成功' });
        }

    } catch (err) {
        console.error('[Payment] WxPay notify error:', err);
        res.status(500).json({ code: 'FAIL', message: err.message });
    }
});

/**
 * POST /api/payment/simulate
 * Simulate successful payment (for testing only - remove in production)
 */
router.post('/simulate', requireAuth, async (req, res) => {
    try {
        const { orderNo } = req.body;

        if (!orderNo) {
            return res.status(400).json({ error: '订单号为必填项' });
        }

        // Verify order belongs to user
        const order = await db.get(`
            SELECT * FROM payment_records 
            WHERE order_no = $1 AND user_id = $2 AND status = 'pending'
        `, [orderNo, req.user.id]);

        if (!order) {
            return res.status(404).json({ error: '订单不存在' });
        }

        // Process as successful payment
        await processSuccessfulPayment(orderNo, `SIM_${Date.now()}`, 'manual');

        res.json({
            success: true,
            message: '模拟支付成功，订阅已激活'
        });

    } catch (err) {
        console.error('[Payment] Simulate error:', err);
        res.status(500).json({ error: '模拟支付失败' });
    }
});

/**
 * Process successful payment - create/extend subscription
 */
async function processSuccessfulPayment(orderNo, transactionId, paymentMethod) {
    // Get order
    const order = await db.get(`
        SELECT * FROM payment_records WHERE order_no = $1 AND status = 'pending'
    `, [orderNo]);

    if (!order) {
        console.log(`[Payment] Order ${orderNo} not found or already processed`);
        return;
    }

    const metadata = order.metadata || {};

    // Update payment status
    await db.run(`
        UPDATE payment_records 
        SET status = 'paid', transaction_id = $1, payment_method = $2,
            paid_at = NOW(), updated_at = NOW()
        WHERE id = $3
    `, [transactionId, paymentMethod, order.id]);

    // Calculate subscription end date
    const durationMap = {
        'monthly': '1 month',
        'quarterly': '3 months',
        'semiannual': '6 months',
        'annual': '1 year'
    };
    const duration = durationMap[metadata.billingCycle] || '1 month';

    // Check for existing subscription
    const existingSub = await db.get(`
        SELECT * FROM user_subscriptions 
        WHERE user_id = $1 AND status = 'active' AND end_date > NOW()
        ORDER BY end_date DESC LIMIT 1
    `, [order.user_id]);

    let startDate, endDate;
    if (existingSub) {
        // Extend from current end date
        startDate = existingSub.end_date;
        const result = await db.get(`SELECT ($1::timestamp + INTERVAL '${duration}') as end_date`, [startDate]);
        endDate = result.end_date;
    } else {
        // Start from now
        startDate = new Date();
        const result = await db.get(`SELECT (NOW() + INTERVAL '${duration}') as end_date`);
        endDate = result.end_date;
    }

    // Create subscription record
    const subResult = await db.query(`
        INSERT INTO user_subscriptions 
        (user_id, plan_id, billing_cycle, start_date, end_date, status, auto_renew)
        VALUES ($1, $2, $3, $4, $5, 'active', true)
        RETURNING id
    `, [order.user_id, metadata.planId, metadata.billingCycle, startDate, endDate]);

    // Update payment record with subscription id
    await db.run(`
        UPDATE payment_records SET subscription_id = $1 WHERE id = $2
    `, [subResult[0].id, order.id]);

    console.log(`[Payment] Order ${orderNo} processed. Subscription ${subResult[0].id} created/extended until ${endDate}`);
}

/**
 * GET /api/payment/status/:orderNo
 * Check payment status
 */
router.get('/status/:orderNo', requireAuth, async (req, res) => {
    try {
        const order = await db.get(`
            SELECT status, paid_at FROM payment_records 
            WHERE order_no = $1 AND user_id = $2
        `, [req.params.orderNo, req.user.id]);

        if (!order) {
            return res.status(404).json({ error: '订单不存在' });
        }

        res.json({
            status: order.status,
            paidAt: order.paid_at
        });

    } catch (err) {
        console.error('[Payment] Status check error:', err);
        res.status(500).json({ error: '查询支付状态失败' });
    }
});

/**
 * GET /api/payment/history
 * Get payment history
 */
router.get('/history', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;

        const payments = await db.query(`
            SELECT order_no, amount, currency, payment_method, status, 
                   paid_at, created_at, metadata
            FROM payment_records 
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
        `, [req.user.id, limit, offset]);

        // Format response
        const formatted = payments.map(p => ({
            orderNo: p.order_no,
            amount: p.amount / 100,
            currency: p.currency,
            paymentMethod: p.payment_method,
            status: p.status,
            planName: p.metadata?.planName,
            billingCycle: p.metadata?.billingCycle,
            paidAt: p.paid_at,
            createdAt: p.created_at
        }));

        res.json(formatted);

    } catch (err) {
        console.error('[Payment] History error:', err);
        res.status(500).json({ error: '获取支付历史失败' });
    }
});

module.exports = router;
