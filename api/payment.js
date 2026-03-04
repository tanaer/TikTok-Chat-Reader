/**
 * Payment API Routes
 * Balance recharge: users top up account balance, then use balance to buy
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../auth/middleware');
const futongpay = require('./futongpay');
const stripe = require('./stripe');

/**
 * GET /api/payment/balance
 * Get user's balance and recent balance changes
 */
router.get('/balance', requireAuth, async (req, res) => {
    try {
        const user = await db.get('SELECT balance FROM users WHERE id = $1', [req.user.id]);

        const logs = await db.query(`
            SELECT id, type, amount, balance_after, description, ref_order_no, created_at
            FROM balance_log
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 20
        `, [req.user.id]);

        res.json({
            balance: user?.balance || 0,
            logs
        });
    } catch (err) {
        console.error('[Payment] Balance error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/payment/recharge
 * Create a recharge order to top up balance
 * Body: { amount (in cents), paymentMethod: 'alipay'|'wxpay'|'stripe' }
 */
router.post('/recharge', requireAuth, async (req, res) => {
    try {
        const { amount, paymentMethod } = req.body;
        const userId = req.user.id;

        if (!amount || amount < 100) {
            return res.status(400).json({ error: '最低充值1元' });
        }

        if (!paymentMethod) {
            return res.status(400).json({ error: '请选择支付方式' });
        }

        const orderNo = `RC-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        const amountYuan = amount / 100;

        // Create pending payment record
        await db.run(
            `INSERT INTO payment_records (user_id, order_no, amount, currency, payment_method, status, metadata)
             VALUES ($1, $2, $3, 'CNY', $4, 'pending', $5)`,
            [userId, orderNo, amount, paymentMethod, JSON.stringify({ type: 'recharge' })]
        );

        let paymentResult;

        if (paymentMethod === 'stripe') {
            paymentResult = await stripe.createCheckoutSession({
                orderNo,
                planName: `余额充值 ¥${amountYuan}`,
                amount,
                currency: 'cny',
                customerEmail: req.user.email,
                userId: String(userId)
            });

            res.json({
                success: true,
                orderNo,
                paymentMethod: 'stripe',
                payUrl: paymentResult.url,
                sessionId: paymentResult.sessionId
            });
        } else {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
            paymentResult = await futongpay.createPayment({
                orderNo,
                amount: amountYuan,
                name: `余额充值 ¥${amountYuan}`,
                payType: paymentMethod,
                clientIp: clientIp.split(',')[0].trim(),
                device: req.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'pc',
                param: JSON.stringify({ userId, type: 'recharge' })
            });

            res.json({
                success: true,
                orderNo,
                paymentMethod,
                payUrl: paymentResult.payUrl,
                qrCode: paymentResult.qrCode,
                tradeNo: paymentResult.tradeNo
            });
        }
    } catch (err) {
        console.error('[Payment] Recharge error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/payment/futong/notify
 * Futongpay payment callback — adds balance on successful recharge
 */
router.post('/futong/notify', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        console.log('[Payment] Futong notify received:', req.body);

        const result = await futongpay.handleNotify(req.body);

        if (!result.valid) {
            console.error('[Payment] Invalid futong notification:', result.error);
            return res.send('fail');
        }

        if (result.status === 'paid') {
            await processRecharge(result.orderNo, result.tradeNo, 'futongpay');
        }

        res.send('success');
    } catch (err) {
        console.error('[Payment] Futong notify error:', err);
        res.send('fail');
    }
});

/**
 * POST /api/payment/stripe/webhook
 * Stripe webhook — adds balance on successful recharge
 */
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['stripe-signature'];
        const result = await stripe.handleWebhook(req.body.toString(), signature);

        if (!result.valid) {
            return res.status(400).json({ error: result.error });
        }

        if (result.type === 'checkout_completed' && result.paymentStatus === 'paid') {
            await processRecharge(result.orderNo, result.sessionId, 'stripe');
        }

        res.json({ received: true });
    } catch (err) {
        console.error('[Payment] Stripe webhook error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/payment/status/:orderNo
 * Query payment order status
 */
router.get('/status/:orderNo', requireAuth, async (req, res) => {
    try {
        const payment = await db.get(
            `SELECT order_no, amount, currency, payment_method, status, paid_at, created_at, metadata
             FROM payment_records WHERE order_no = $1 AND user_id = $2`,
            [req.params.orderNo, req.user.id]
        );

        if (!payment) {
            return res.status(404).json({ error: '订单不存在' });
        }

        res.json(payment);
    } catch (err) {
        console.error('[Payment] Status query error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Process a successful recharge — add balance to user account
 */
async function processRecharge(orderNo, transactionId, paymentMethod) {
    try {
        const payment = await db.get(
            `SELECT * FROM payment_records WHERE order_no = $1 AND status = 'pending'`,
            [orderNo]
        );

        if (!payment) {
            console.warn(`[Payment] Recharge order ${orderNo} not found or already processed`);
            return;
        }

        // Mark payment as paid
        await db.run(
            `UPDATE payment_records SET status = 'paid', transaction_id = $1, paid_at = NOW(), 
             payment_method = $2, updated_at = NOW() WHERE id = $3`,
            [transactionId, paymentMethod, payment.id]
        );

        // Add balance to user
        const user = await db.get('SELECT balance FROM users WHERE id = $1', [payment.user_id]);
        const oldBalance = user?.balance || 0;
        const newBalance = oldBalance + payment.amount;

        await db.run('UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
            [newBalance, payment.user_id]);

        // Log balance change
        await db.run(
            `INSERT INTO balance_log (user_id, type, amount, balance_after, description, ref_order_no)
             VALUES ($1, 'recharge', $2, $3, $4, $5)`,
            [payment.user_id, payment.amount, newBalance,
            `充值 ¥${(payment.amount / 100).toFixed(2)}`, orderNo]
        );

        console.log(`[Payment] Recharge successful: user=${payment.user_id}, amount=${payment.amount}, newBalance=${newBalance}`);

    } catch (err) {
        console.error(`[Payment] Failed to process recharge ${orderNo}:`, err);
    }
}

module.exports = router;
