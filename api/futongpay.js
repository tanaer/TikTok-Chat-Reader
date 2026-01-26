/**
 * Futongpay (富通支付) Integration
 * API Documentation: https://cdn2.futooncdn.com/doc.html
 */
const crypto = require('crypto');

// Configuration from environment or database
const getConfig = async () => {
    // Try to get from database first, fall back to env
    try {
        const db = require('../db');
        const settings = await db.query(`SELECT key, value FROM settings WHERE key IN ('futong_pid', 'futong_key', 'futong_notify_url')`);
        const config = {};
        settings.forEach(s => { config[s.key] = s.value; });
        return {
            pid: config.futong_pid || process.env.FUTONG_PID,
            key: config.futong_key || process.env.FUTONG_KEY,
            notifyUrl: config.futong_notify_url || process.env.FUTONG_NOTIFY_URL || 'http://localhost:8081/api/payment/futong/notify',
            returnUrl: config.futong_return_url || process.env.FUTONG_RETURN_URL || 'http://localhost:8081/landing/payment-success.html',
            apiUrl: 'https://cdn2.futooncdn.com/mapi.php',
            submitUrl: 'https://cdn2.futooncdn.com/submit.php'
        };
    } catch (err) {
        return {
            pid: process.env.FUTONG_PID,
            key: process.env.FUTONG_KEY,
            notifyUrl: process.env.FUTONG_NOTIFY_URL || 'http://localhost:8081/api/payment/futong/notify',
            returnUrl: process.env.FUTONG_RETURN_URL || 'http://localhost:8081/landing/payment-success.html',
            apiUrl: 'https://cdn2.futooncdn.com/mapi.php',
            submitUrl: 'https://cdn2.futooncdn.com/submit.php'
        };
    }
};

/**
 * Generate MD5 signature for Futongpay API
 * Algorithm: 
 * 1. Sort params by key (ASCII order)
 * 2. Build query string: key1=value1&key2=value2
 * 3. Append merchant key
 * 4. MD5 hash (lowercase)
 */
function generateSign(params, key) {
    // Filter out empty values, sign, and sign_type
    const filtered = Object.entries(params)
        .filter(([k, v]) => v !== '' && v !== null && v !== undefined && k !== 'sign' && k !== 'sign_type')
        .sort(([a], [b]) => a.localeCompare(b));

    // Build query string
    const queryString = filtered.map(([k, v]) => `${k}=${v}`).join('&');

    // Append key and hash
    const signString = queryString + key;
    return crypto.createHash('md5').update(signString, 'utf8').digest('hex').toLowerCase();
}

/**
 * Verify notification signature
 */
function verifySign(params, key) {
    const receivedSign = params.sign;
    if (!receivedSign) return false;

    const calculatedSign = generateSign(params, key);
    return receivedSign.toLowerCase() === calculatedSign;
}

/**
 * Create payment via API (returns QR code or redirect URL)
 * @param {object} options - Payment options
 * @param {string} options.orderNo - Merchant order number
 * @param {number} options.amount - Amount in yuan (e.g., 29.00)
 * @param {string} options.name - Product name
 * @param {string} options.payType - 'alipay' or 'wxpay'
 * @param {string} options.clientIp - User's IP address
 * @param {string} options.device - 'pc' or 'mobile'
 * @returns {object} - { code, payurl, qrcode, trade_no }
 */
async function createPayment(options) {
    const config = await getConfig();

    if (!config.pid || !config.key) {
        throw new Error('Futongpay configuration missing (pid or key)');
    }

    const params = {
        pid: config.pid,
        type: options.payType || 'alipay',
        out_trade_no: options.orderNo,
        notify_url: config.notifyUrl,
        return_url: config.returnUrl,
        name: options.name || '订阅服务',
        money: options.amount.toFixed(2),
        clientip: options.clientIp || '127.0.0.1',
        device: options.device || 'pc',
        param: options.param || ''
    };

    // Generate signature
    params.sign = generateSign(params, config.key);
    params.sign_type = 'MD5';

    // Make API request
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

    const formData = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => formData.append(k, v));

    const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
    });

    const result = await response.json();

    if (result.code !== 1) {
        throw new Error(result.msg || 'Futongpay API error');
    }

    return {
        code: result.code,
        tradeNo: result.trade_no,
        payUrl: result.payurl || null,
        qrCode: result.qrcode || null,
        urlScheme: result.urlscheme || null
    };
}

/**
 * Generate page redirect payment URL (for form submit)
 */
async function getPaymentUrl(options) {
    const config = await getConfig();

    const params = {
        pid: config.pid,
        type: options.payType || '',  // Empty = show cashier
        out_trade_no: options.orderNo,
        notify_url: config.notifyUrl,
        return_url: config.returnUrl,
        name: options.name || '订阅服务',
        money: options.amount.toFixed(2),
        param: options.param || ''
    };

    params.sign = generateSign(params, config.key);
    params.sign_type = 'MD5';

    // Build URL
    const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

    return `${config.submitUrl}?${queryString}`;
}

/**
 * Query order status
 */
async function queryOrder(orderNo) {
    const config = await getConfig();

    const url = `https://cdn2.futooncdn.com/api.php?act=order&pid=${config.pid}&key=${config.key}&out_trade_no=${orderNo}`;

    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const response = await fetch(url);
    const result = await response.json();

    if (result.code !== 1) {
        throw new Error(result.msg || 'Order query failed');
    }

    return {
        tradeNo: result.trade_no,
        orderNo: result.out_trade_no,
        status: result.status === 1 ? 'paid' : 'pending',
        amount: parseFloat(result.money),
        name: result.name,
        payType: result.type,
        addTime: result.addtime,
        endTime: result.endtime
    };
}

/**
 * Handle payment notification callback
 * Returns { valid: boolean, orderNo, tradeNo, amount, status }
 */
async function handleNotify(params) {
    const config = await getConfig();

    // Verify signature
    if (!verifySign(params, config.key)) {
        return { valid: false, error: 'Invalid signature' };
    }

    // Check payment status
    if (params.trade_status !== 'TRADE_SUCCESS') {
        return { valid: true, status: 'pending', orderNo: params.out_trade_no };
    }

    return {
        valid: true,
        status: 'paid',
        orderNo: params.out_trade_no,
        tradeNo: params.trade_no,
        amount: parseFloat(params.money),
        payType: params.type,
        name: params.name,
        param: params.param || ''
    };
}

module.exports = {
    generateSign,
    verifySign,
    createPayment,
    getPaymentUrl,
    queryOrder,
    handleNotify
};
