const crypto = require('crypto');
const db = require('../db');
const { generateOrderNo } = require('./balanceService');

const GENERIC_CHANNEL_LABELS = {
    fixed_qr: '固定码',
    futong: '三方支付',
    bepusdt: '虚拟币支付'
};

const GENERIC_METHOD_LABELS = {
    alipay: '支付宝',
    wxpay: '微信',
    usdt: 'USDT'
};

function md5Lowercase(input) {
    return crypto.createHash('md5').update(String(input), 'utf8').digest('hex');
}

function normalizeBoolean(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeString(value) {
    if (value == null) return '';
    return String(value).trim();
}

function toSafeAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return NaN;
    return Math.round(amount);
}

function normalizePositiveAmount(value, fallback = null) {
    const amount = toSafeAmount(value);
    if (!Number.isFinite(amount) || amount <= 0) return fallback;
    return amount;
}

function normalizeAmountRange(minValue, maxValue, fallbackMin = 1) {
    const minAmount = Math.max(1, normalizePositiveAmount(minValue, fallbackMin) || fallbackMin);
    let maxAmount = normalizePositiveAmount(maxValue, null);
    if (maxAmount != null && maxAmount < minAmount) {
        maxAmount = minAmount;
    }
    return { minAmount, maxAmount };
}

function serializeAmountSetting(value, { allowEmpty = false, fallback = '' } = {}) {
    const raw = normalizeString(value);
    if (!raw) return allowEmpty ? '' : String(fallback);
    const amount = normalizePositiveAmount(value, null);
    if (amount == null) return allowEmpty ? '' : String(fallback);
    return String(amount);
}

function formatAmountRangeText(minAmount, maxAmount = null) {
    return maxAmount != null ? `¥${minAmount} - ¥${maxAmount}` : `最低 ¥${minAmount}`;
}

function buildAmountRangeError(minAmount, maxAmount = null) {
    return maxAmount != null
        ? `该支付方式充值金额范围为 ¥${minAmount} - ¥${maxAmount}`
        : `该支付方式最低充值金额为 ¥${minAmount}`;
}

function buildQueryStringForSign(params, excludedKeys = []) {
    const excluded = new Set(excludedKeys.map(key => key.toLowerCase()));
    return Object.keys(params)
        .filter(key => !excluded.has(key.toLowerCase()))
        .filter(key => params[key] !== '' && params[key] !== null && params[key] !== undefined)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
}

function signFutong(params, secretKey) {
    const plain = buildQueryStringForSign(params, ['sign', 'sign_type']);
    return md5Lowercase(`${plain}${secretKey}`);
}

function signBepusdt(params, signSecret) {
    const plain = buildQueryStringForSign(params, ['signature']);
    return md5Lowercase(`${plain}${signSecret}`);
}

function parseJsonSafe(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function createDisplayLabel(channel, method) {
    const channelLabel = GENERIC_CHANNEL_LABELS[channel] || channel;
    const methodLabel = GENERIC_METHOD_LABELS[method] || method;
    return methodLabel && method !== 'usdt' ? `${channelLabel} · ${methodLabel}` : channelLabel;
}

function getRechargeOptionTitle(channel, method) {
    return {
        channel,
        method,
        label: createDisplayLabel(channel, method)
    };
}

function getPublicBaseUrl(req) {
    const forwardedProto = normalizeString(req.headers['x-forwarded-proto']).split(',')[0];
    const proto = forwardedProto || req.protocol || 'http';
    const forwardedHost = normalizeString(req.headers['x-forwarded-host']).split(',')[0];
    const host = forwardedHost || req.get('host');
    return `${proto}://${host}`;
}

function getClientIp(req) {
    const xForwardedFor = normalizeString(req.headers['x-forwarded-for']);
    if (xForwardedFor) {
        return xForwardedFor.split(',')[0].trim();
    }
    return normalizeString(req.ip || req.socket?.remoteAddress || '127.0.0.1') || '127.0.0.1';
}

function joinUrl(baseUrl, pathname) {
    return `${normalizeString(baseUrl).replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

function maskSecret(secret, keepStart = 4, keepEnd = 4) {
    const value = normalizeString(secret);
    if (!value) return '';
    if (value.length <= keepStart + keepEnd) return '*'.repeat(value.length);
    return `${value.slice(0, keepStart)}${'*'.repeat(Math.max(4, value.length - keepStart - keepEnd))}${value.slice(-keepEnd)}`;
}

function normalizePaymentConfig(settings = {}, baseUrl = '') {
    const minRechargeAmount = Math.max(1, normalizePositiveAmount(settings.min_recharge_amount || settings.minRechargeAmount, 1) || 1);
    const fixedWechatEnabled = normalizeBoolean(settings.payment_fixed_wechat_enabled);
    const fixedAlipayEnabled = normalizeBoolean(settings.payment_fixed_alipay_enabled);
    const futongEnabled = normalizeBoolean(settings.payment_futong_enabled);
    const futongAlipayEnabled = normalizeBoolean(settings.payment_futong_alipay_enabled);
    const futongWxpayEnabled = normalizeBoolean(settings.payment_futong_wxpay_enabled);
    const bepusdtEnabled = normalizeBoolean(settings.payment_bepusdt_enabled);

    const fixedWechatRange = normalizeAmountRange(settings.payment_fixed_wechat_min_amount, settings.payment_fixed_wechat_max_amount, minRechargeAmount);
    const fixedAlipayRange = normalizeAmountRange(settings.payment_fixed_alipay_min_amount, settings.payment_fixed_alipay_max_amount, minRechargeAmount);
    const futongAlipayRange = normalizeAmountRange(settings.payment_futong_alipay_min_amount, settings.payment_futong_alipay_max_amount, minRechargeAmount);
    const futongWxpayRange = normalizeAmountRange(settings.payment_futong_wxpay_min_amount, settings.payment_futong_wxpay_max_amount, minRechargeAmount);
    const bepusdtRange = normalizeAmountRange(settings.payment_bepusdt_min_amount, settings.payment_bepusdt_max_amount, minRechargeAmount);

    const computedNotifyUrls = baseUrl ? {
        futong: joinUrl(baseUrl, '/api/payment/notify/futong'),
        bepusdt: joinUrl(baseUrl, '/api/payment/notify/bepusdt')
    } : { futong: '', bepusdt: '' };
    const customFutongNotifyUrl = normalizeString(settings.payment_futong_notify_url);
    const customBepusdtNotifyUrl = normalizeString(settings.payment_bepusdt_notify_url);

    const config = {
        minRechargeAmount,
        fixedQr: {
            wechat: {
                enabled: fixedWechatEnabled,
                imageData: normalizeString(settings.payment_fixed_wechat_image),
                minAmount: fixedWechatRange.minAmount,
                maxAmount: fixedWechatRange.maxAmount
            },
            alipay: {
                enabled: fixedAlipayEnabled,
                imageData: normalizeString(settings.payment_fixed_alipay_image),
                minAmount: fixedAlipayRange.minAmount,
                maxAmount: fixedAlipayRange.maxAmount
            }
        },
        futong: {
            enabled: futongEnabled,
            apiUrl: normalizeString(settings.payment_futong_api_url),
            pid: normalizeString(settings.payment_futong_pid),
            secretKey: normalizeString(settings.payment_futong_secret_key),
            alipayEnabled: futongAlipayEnabled,
            wxpayEnabled: futongWxpayEnabled,
            alipayMinAmount: futongAlipayRange.minAmount,
            alipayMaxAmount: futongAlipayRange.maxAmount,
            wxpayMinAmount: futongWxpayRange.minAmount,
            wxpayMaxAmount: futongWxpayRange.maxAmount
        },
        bepusdt: {
            enabled: bepusdtEnabled,
            apiUrl: normalizeString(settings.payment_bepusdt_api_url),
            authToken: normalizeString(settings.payment_bepusdt_auth_token),
            signSecret: normalizeString(settings.payment_bepusdt_sign_secret),
            tradeType: normalizeString(settings.payment_bepusdt_trade_type) || 'usdt.bep20',
            minAmount: bepusdtRange.minAmount,
            maxAmount: bepusdtRange.maxAmount
        },
        notifyUrls: {
            futong: customFutongNotifyUrl || computedNotifyUrls.futong,
            bepusdt: customBepusdtNotifyUrl || computedNotifyUrls.bepusdt
        },
        returnUrl: baseUrl ? joinUrl(baseUrl, '/user-center.html') : ''
    };

    config.fixedQr.wechat.enabled = config.fixedQr.wechat.enabled && !!config.fixedQr.wechat.imageData;
    config.fixedQr.alipay.enabled = config.fixedQr.alipay.enabled && !!config.fixedQr.alipay.imageData;
    config.futong.enabled = config.futong.enabled && !!config.futong.apiUrl && !!config.futong.pid && !!config.futong.secretKey && (config.futong.alipayEnabled || config.futong.wxpayEnabled);
    config.bepusdt.enabled = config.bepusdt.enabled && !!config.bepusdt.apiUrl && !!config.bepusdt.authToken;

    return config;
}

async function getPaymentConfig(baseUrl = '') {
    const settings = await db.getSystemSettings();
    return normalizePaymentConfig(settings, baseUrl);
}

async function getAdminPaymentConfig(baseUrl = '') {
    const settings = await db.getSystemSettings();
    const config = normalizePaymentConfig(settings, baseUrl);
    return {
        minRechargeAmount: config.minRechargeAmount,
        fixedQr: {
            wechat: {
                enabled: normalizeBoolean(settings.payment_fixed_wechat_enabled),
                imageData: normalizeString(settings.payment_fixed_wechat_image),
                minAmount: config.fixedQr.wechat.minAmount,
                maxAmount: config.fixedQr.wechat.maxAmount
            },
            alipay: {
                enabled: normalizeBoolean(settings.payment_fixed_alipay_enabled),
                imageData: normalizeString(settings.payment_fixed_alipay_image),
                minAmount: config.fixedQr.alipay.minAmount,
                maxAmount: config.fixedQr.alipay.maxAmount
            }
        },
        futong: {
            enabled: normalizeBoolean(settings.payment_futong_enabled),
            apiUrl: normalizeString(settings.payment_futong_api_url),
            pid: normalizeString(settings.payment_futong_pid),
            secretKey: normalizeString(settings.payment_futong_secret_key),
            secretKeyMasked: maskSecret(settings.payment_futong_secret_key),
            alipayEnabled: normalizeBoolean(settings.payment_futong_alipay_enabled),
            wxpayEnabled: normalizeBoolean(settings.payment_futong_wxpay_enabled),
            alipayMinAmount: config.futong.alipayMinAmount,
            alipayMaxAmount: config.futong.alipayMaxAmount,
            wxpayMinAmount: config.futong.wxpayMinAmount,
            wxpayMaxAmount: config.futong.wxpayMaxAmount,
            notifyUrl: config.notifyUrls.futong,
            returnUrl: config.returnUrl,
            ready: config.futong.enabled
        },
        bepusdt: {
            enabled: normalizeBoolean(settings.payment_bepusdt_enabled),
            apiUrl: normalizeString(settings.payment_bepusdt_api_url),
            authToken: normalizeString(settings.payment_bepusdt_auth_token),
            authTokenMasked: maskSecret(settings.payment_bepusdt_auth_token),
            signSecret: normalizeString(settings.payment_bepusdt_sign_secret),
            signSecretMasked: maskSecret(settings.payment_bepusdt_sign_secret),
            tradeType: normalizeString(settings.payment_bepusdt_trade_type) || 'usdt.bep20',
            minAmount: config.bepusdt.minAmount,
            maxAmount: config.bepusdt.maxAmount,
            notifyUrl: config.notifyUrls.bepusdt,
            redirectUrl: config.returnUrl,
            ready: config.bepusdt.enabled
        }
    };
}

function sanitizePaymentConfigInput(input = {}) {
    const minRechargeAmount = Math.max(1, normalizePositiveAmount(input.minRechargeAmount, 1) || 1);
    return {
        min_recharge_amount: String(minRechargeAmount),
        payment_fixed_wechat_enabled: String(normalizeBoolean(input.fixedQr?.wechat?.enabled)),
        payment_fixed_wechat_image: normalizeString(input.fixedQr?.wechat?.imageData),
        payment_fixed_wechat_min_amount: serializeAmountSetting(input.fixedQr?.wechat?.minAmount, { fallback: minRechargeAmount }),
        payment_fixed_wechat_max_amount: serializeAmountSetting(input.fixedQr?.wechat?.maxAmount, { allowEmpty: true }),
        payment_fixed_alipay_enabled: String(normalizeBoolean(input.fixedQr?.alipay?.enabled)),
        payment_fixed_alipay_image: normalizeString(input.fixedQr?.alipay?.imageData),
        payment_fixed_alipay_min_amount: serializeAmountSetting(input.fixedQr?.alipay?.minAmount, { fallback: minRechargeAmount }),
        payment_fixed_alipay_max_amount: serializeAmountSetting(input.fixedQr?.alipay?.maxAmount, { allowEmpty: true }),
        payment_futong_enabled: String(normalizeBoolean(input.futong?.enabled)),
        payment_futong_api_url: normalizeString(input.futong?.apiUrl),
        payment_futong_pid: normalizeString(input.futong?.pid),
        payment_futong_secret_key: normalizeString(input.futong?.secretKey),
        payment_futong_notify_url: normalizeString(input.futong?.notifyUrl),
        payment_futong_alipay_enabled: String(normalizeBoolean(input.futong?.alipayEnabled)),
        payment_futong_wxpay_enabled: String(normalizeBoolean(input.futong?.wxpayEnabled)),
        payment_futong_alipay_min_amount: serializeAmountSetting(input.futong?.alipayMinAmount, { fallback: minRechargeAmount }),
        payment_futong_alipay_max_amount: serializeAmountSetting(input.futong?.alipayMaxAmount, { allowEmpty: true }),
        payment_futong_wxpay_min_amount: serializeAmountSetting(input.futong?.wxpayMinAmount, { fallback: minRechargeAmount }),
        payment_futong_wxpay_max_amount: serializeAmountSetting(input.futong?.wxpayMaxAmount, { allowEmpty: true }),
        payment_bepusdt_enabled: String(normalizeBoolean(input.bepusdt?.enabled)),
        payment_bepusdt_api_url: normalizeString(input.bepusdt?.apiUrl),
        payment_bepusdt_auth_token: normalizeString(input.bepusdt?.authToken),
        payment_bepusdt_sign_secret: normalizeString(input.bepusdt?.signSecret),
        payment_bepusdt_notify_url: normalizeString(input.bepusdt?.notifyUrl),
        payment_bepusdt_trade_type: normalizeString(input.bepusdt?.tradeType) || 'usdt.bep20',
        payment_bepusdt_min_amount: serializeAmountSetting(input.bepusdt?.minAmount, { fallback: minRechargeAmount }),
        payment_bepusdt_max_amount: serializeAmountSetting(input.bepusdt?.maxAmount, { allowEmpty: true })
    };
}

async function savePaymentConfig(input = {}) {
    const entries = Object.entries(sanitizePaymentConfigInput(input));
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        for (const [key, value] of entries) {
            await client.query(
                `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [key, value]
            );
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}


function getOptionAmountRange(config, channel, method) {
    if (channel === 'fixed_qr') {
        if (method === 'wxpay') {
            return { minAmount: config.fixedQr.wechat.minAmount, maxAmount: config.fixedQr.wechat.maxAmount };
        }
        if (method === 'alipay') {
            return { minAmount: config.fixedQr.alipay.minAmount, maxAmount: config.fixedQr.alipay.maxAmount };
        }
    }

    if (channel === 'futong') {
        if (method === 'alipay') {
            return { minAmount: config.futong.alipayMinAmount, maxAmount: config.futong.alipayMaxAmount };
        }
        if (method === 'wxpay') {
            return { minAmount: config.futong.wxpayMinAmount, maxAmount: config.futong.wxpayMaxAmount };
        }
    }

    if (channel === 'bepusdt' && method === 'usdt') {
        return { minAmount: config.bepusdt.minAmount, maxAmount: config.bepusdt.maxAmount };
    }

    throw new Error('无效的支付方式');
}

function assertAmountWithinRange(amount, range) {
    if (amount < range.minAmount) {
        throw new Error(buildAmountRangeError(range.minAmount, range.maxAmount));
    }
    if (range.maxAmount != null && amount > range.maxAmount) {
        throw new Error(buildAmountRangeError(range.minAmount, range.maxAmount));
    }
}

function buildRechargeOptions(config) {
    const options = [];
    const pushOption = (channel, method) => {
        const range = getOptionAmountRange(config, channel, method);
        options.push({
            key: `${channel}:${method}`,
            channel,
            method,
            ...getRechargeOptionTitle(channel, method),
            minAmount: range.minAmount,
            maxAmount: range.maxAmount,
            rangeText: formatAmountRangeText(range.minAmount, range.maxAmount)
        });
    };

    if (config.fixedQr.wechat.enabled) {
        pushOption('fixed_qr', 'wxpay');
    }
    if (config.fixedQr.alipay.enabled) {
        pushOption('fixed_qr', 'alipay');
    }
    if (config.futong.enabled && config.futong.alipayEnabled) {
        pushOption('futong', 'alipay');
    }
    if (config.futong.enabled && config.futong.wxpayEnabled) {
        pushOption('futong', 'wxpay');
    }
    if (config.bepusdt.enabled) {
        pushOption('bepusdt', 'usdt');
    }

    return options;
}

function serializeOrder(row) {
    const order = db.toCamelCase(row);
    const metadata = order.metadata || {};
    return {
        id: order.id,
        orderNo: order.orderNo,
        amount: Number(order.amount || 0),
        status: order.status,
        paymentMethod: order.paymentMethod,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        channel: metadata.channel || '',
        method: metadata.method || '',
        label: createDisplayLabel(metadata.channel || '', metadata.method || ''),
        qrImageData: metadata.qrImageData || '',
        qrCodeUrl: metadata.qrCodeUrl || '',
        paymentUrl: metadata.paymentUrl || '',
        actualAmount: metadata.actualAmount || null,
        tradeType: metadata.tradeType || '',
        instructions: metadata.instructions || '',
        manualReview: metadata.manualReview === true,
        metadata
    };
}

async function insertRechargeOrder(userId, amount, paymentMethod, metadata) {
    const orderNo = generateOrderNo('RCH');
    const result = await db.pool.query(
        `INSERT INTO payment_records (order_no, user_id, amount, currency, payment_method, status, type, item_name, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, 'CNY', $4, 'pending', 'recharge', '余额充值', $5, NOW(), NOW())
         RETURNING *`,
        [orderNo, userId, amount, paymentMethod, metadata]
    );
    return result.rows[0];
}

async function updateOrderAfterCreation(orderId, { status = 'pending', transactionId = null, metadata = null }) {
    const result = await db.pool.query(
        `UPDATE payment_records
         SET status = $1,
             transaction_id = COALESCE($2, transaction_id),
             metadata = COALESCE($3, metadata),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [status, transactionId, metadata, orderId]
    );
    return result.rows[0] || null;
}

async function requestFutongPayment({ config, orderNo, amount, method, notifyUrl, returnUrl, clientIp }) {
    const endpoint = config.apiUrl.endsWith('/mapi.php') ? config.apiUrl : joinUrl(config.apiUrl, '/mapi.php');
    const payload = {
        pid: config.pid,
        type: method,
        out_trade_no: orderNo,
        notify_url: notifyUrl,
        return_url: returnUrl,
        name: '余额充值',
        money: Number(amount).toFixed(2),
        clientip: clientIp || '127.0.0.1',
        device: 'pc',
        sign_type: 'MD5'
    };
    payload.sign = signFutong(payload, config.secretKey);

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload)
    });

    const text = await response.text();
    const parsed = parseJsonSafe(text) || { raw: text };
    const success = response.ok && (Number(parsed.code) === 1 || Number(parsed.status) === 1 || parsed.success === true);
    if (!success) {
        throw new Error(parsed.msg || parsed.message || parsed.error || `富通支付下单失败: HTTP ${response.status}`);
    }

    const paymentUrl = normalizeString(parsed.payurl || parsed.payment_url || parsed.url);
    const qrCodeUrl = normalizeString(parsed.qrcode || parsed.qrCode || paymentUrl);
    return {
        raw: parsed,
        transactionId: normalizeString(parsed.trade_no || parsed.tradeNo),
        paymentUrl,
        qrCodeUrl
    };
}

async function requestBepusdtPayment({ config, orderNo, amount, notifyUrl, redirectUrl }) {
    const endpoint = config.apiUrl.includes('create-transaction')
        ? config.apiUrl
        : joinUrl(config.apiUrl, '/api/v1/order/create-transaction');
    const signSecret = config.signSecret || config.authToken;
    const payload = {
        order_id: orderNo,
        amount: Number(amount).toFixed(2),
        trade_type: config.tradeType,
        notify_url: notifyUrl,
        redirect_url: redirectUrl,
        timeout: 1200
    };
    payload.signature = signBepusdt(payload, signSecret);

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.authToken}`
        },
        body: JSON.stringify(payload)
    });

    const text = await response.text();
    const parsed = parseJsonSafe(text) || { raw: text };
    const success = response.ok && (Number(parsed.status_code || parsed.statusCode || parsed.code) === 200 || parsed.success === true);
    if (!success) {
        throw new Error(parsed.msg || parsed.message || parsed.error || `BEPUSDT 下单失败: HTTP ${response.status}`);
    }

    return {
        raw: parsed,
        transactionId: normalizeString(parsed.trade_id || parsed.tradeId),
        paymentUrl: normalizeString(parsed.payment_url || parsed.pay_url || parsed.payurl),
        qrCodeUrl: normalizeString(parsed.qrcode || parsed.qrCode || parsed.payment_url || parsed.pay_url || parsed.payurl),
        actualAmount: parsed.actual_amount || parsed.actualAmount || null,
        tradeType: config.tradeType
    };
}

async function createRechargeOrder({ userId, amount, optionKey, req }) {
    const safeAmount = toSafeAmount(amount);
    if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
        throw new Error('请输入正确的充值金额');
    }

    const baseUrl = getPublicBaseUrl(req);
    const config = await getPaymentConfig(baseUrl);

    const [channel, method] = String(optionKey || '').split(':');
    if (!channel || !method) {
        throw new Error('无效的支付方式');
    }

    const optionRange = getOptionAmountRange(config, channel, method);
    const paymentMethod = `${channel}_${method}`;
    const baseMetadata = {
        channel,
        method,
        label: createDisplayLabel(channel, method),
        amount: safeAmount,
        minAmount: optionRange.minAmount,
        maxAmount: optionRange.maxAmount,
        amountRangeText: formatAmountRangeText(optionRange.minAmount, optionRange.maxAmount),
        createdAt: new Date().toISOString()
    };

    if (channel === 'fixed_qr') {
        const imageData = method === 'wxpay' ? config.fixedQr.wechat.imageData : config.fixedQr.alipay.imageData;
        const enabled = method === 'wxpay' ? config.fixedQr.wechat.enabled : config.fixedQr.alipay.enabled;
        if (!enabled || !imageData) {
            throw new Error('该支付方式未开启');
        }
        assertAmountWithinRange(safeAmount, optionRange);

        const orderRow = await insertRechargeOrder(userId, safeAmount, paymentMethod, {
            ...baseMetadata,
            qrImageData: imageData,
            manualReview: true,
            instructions: '请扫码支付并保存订单号，支付后等待管理员确认入账。'
        });
        return serializeOrder(orderRow);
    }

    if (channel === 'futong') {
        const methodEnabled = method === 'alipay' ? config.futong.alipayEnabled : config.futong.wxpayEnabled;
        if (!config.futong.enabled || !methodEnabled) {
            throw new Error('该支付方式未开启');
        }
        assertAmountWithinRange(safeAmount, optionRange);

        const orderRow = await insertRechargeOrder(userId, safeAmount, paymentMethod, baseMetadata);
        try {
            const upstream = await requestFutongPayment({
                config: config.futong,
                orderNo: orderRow.order_no,
                amount: safeAmount,
                method,
                notifyUrl: config.notifyUrls.futong,
                returnUrl: config.returnUrl,
                clientIp: getClientIp(req)
            });
            const updated = await updateOrderAfterCreation(orderRow.id, {
                status: 'pending',
                transactionId: upstream.transactionId,
                metadata: {
                    ...baseMetadata,
                    paymentUrl: upstream.paymentUrl,
                    qrCodeUrl: upstream.qrCodeUrl,
                    upstream: upstream.raw,
                    instructions: '请在支付完成后返回当前页面查看到账状态。'
                }
            });
            return serializeOrder(updated || orderRow);
        } catch (error) {
            await updateOrderAfterCreation(orderRow.id, {
                status: 'failed',
                metadata: { ...baseMetadata, error: error.message }
            });
            throw error;
        }
    }

    if (channel === 'bepusdt') {
        if (!config.bepusdt.enabled) {
            throw new Error('该支付方式未开启');
        }
        assertAmountWithinRange(safeAmount, optionRange);
        const orderRow = await insertRechargeOrder(userId, safeAmount, paymentMethod, baseMetadata);
        try {
            const upstream = await requestBepusdtPayment({
                config: config.bepusdt,
                orderNo: orderRow.order_no,
                amount: safeAmount,
                notifyUrl: config.notifyUrls.bepusdt,
                redirectUrl: config.returnUrl
            });
            const updated = await updateOrderAfterCreation(orderRow.id, {
                status: 'pending',
                transactionId: upstream.transactionId,
                metadata: {
                    ...baseMetadata,
                    paymentUrl: upstream.paymentUrl,
                    qrCodeUrl: upstream.qrCodeUrl,
                    actualAmount: upstream.actualAmount,
                    tradeType: upstream.tradeType,
                    upstream: upstream.raw,
                    instructions: '请在支付完成后返回当前页面查看到账状态。'
                }
            });
            return serializeOrder(updated || orderRow);
        } catch (error) {
            await updateOrderAfterCreation(orderRow.id, {
                status: 'failed',
                metadata: { ...baseMetadata, error: error.message }
            });
            throw error;
        }
    }

    throw new Error('不支持的支付方式');
}

async function getRechargeOptions(baseUrl = '') {
    const config = await getPaymentConfig(baseUrl);
    return {
        minRechargeAmount: config.minRechargeAmount,
        options: buildRechargeOptions(config)
    };
}

async function getOrderForUser(userId, orderNo) {
    const result = await db.pool.query(
        `SELECT * FROM payment_records WHERE order_no = $1 AND user_id = $2 LIMIT 1`,
        [orderNo, userId]
    );
    return result.rows[0] ? serializeOrder(result.rows[0]) : null;
}

function mergeMetadata(existing, patch) {
    return {
        ...(existing || {}),
        ...(patch || {})
    };
}

async function markRechargeOrderPaid({ orderNo = null, orderId = null, transactionId = null, provider = '', notifyPayload = null, verifyResult = 'verified', operatorId = null, expectedAmount = null }) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const lookupSql = orderId
            ? 'SELECT * FROM payment_records WHERE id = $1 FOR UPDATE'
            : 'SELECT * FROM payment_records WHERE order_no = $1 FOR UPDATE';
        const lookupVal = orderId || orderNo;
        const orderResult = await client.query(lookupSql, [lookupVal]);
        if (orderResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: '订单不存在' };
        }

        const order = db.toCamelCase(orderResult.rows[0]);
        if (order.type !== 'recharge') {
            await client.query('ROLLBACK');
            return { success: false, error: '仅支持充值订单入账' };
        }

        if (order.status === 'paid') {
            await client.query('COMMIT');
            return { success: true, alreadyPaid: true, order: serializeOrder(orderResult.rows[0]) };
        }

        if (order.status === 'cancelled' || order.status === 'refunded') {
            await client.query('ROLLBACK');
            return { success: false, error: '当前订单状态不允许入账' };
        }

        if (expectedAmount !== null && expectedAmount !== undefined) {
            const callbackAmount = toSafeAmount(expectedAmount);
            if (Number.isFinite(callbackAmount) && callbackAmount !== Number(order.amount || 0)) {
                await client.query('ROLLBACK');
                return { success: false, error: '回调金额校验失败' };
            }
        }

        const userResult = await client.query('SELECT id, balance FROM users WHERE id = $1 FOR UPDATE', [order.userId]);
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: '用户不存在' };
        }

        const balanceBefore = Number(userResult.rows[0].balance || 0);
        const balanceAfter = balanceBefore + Number(order.amount || 0);
        await client.query('UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2', [balanceAfter, order.userId]);

        const nextMetadata = mergeMetadata(order.metadata, {
            verifyResult,
            paidBy: provider || order.paymentMethod,
            paidAt: new Date().toISOString(),
            notifyPayload: notifyPayload || order.metadata?.notifyPayload || null,
            operatorId: operatorId || order.metadata?.operatorId || null
        });

        await client.query(
            `UPDATE payment_records
             SET status = 'paid',
                 paid_at = NOW(),
                 transaction_id = COALESCE($1, transaction_id),
                 metadata = $2,
                 updated_at = NOW()
             WHERE id = $3`,
            [transactionId, nextMetadata, order.id]
        );

        await client.query(
            `INSERT INTO balance_log (user_id, type, amount, balance_before, balance_after, ref_order_no, description, operator_id)
             VALUES ($1, 'recharge', $2, $3, $4, $5, $6, $7)`,
            [order.userId, Number(order.amount || 0), balanceBefore, balanceAfter, order.orderNo, `在线充值 (${provider || order.paymentMethod})`, operatorId]
        );

        await client.query('COMMIT');
        const updated = await db.pool.query('SELECT * FROM payment_records WHERE id = $1', [order.id]);
        return { success: true, order: serializeOrder(updated.rows[0]) };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Payment] markRechargeOrderPaid error:', error.message);
        return { success: false, error: '充值入账失败' };
    } finally {
        client.release();
    }
}

async function cancelRechargeOrder({ orderId, operatorId = null, reason = '管理员取消' }) {
    const result = await db.pool.query('SELECT * FROM payment_records WHERE id = $1 LIMIT 1', [orderId]);
    if (result.rows.length === 0) {
        return { success: false, error: '订单不存在' };
    }
    const order = db.toCamelCase(result.rows[0]);
    if (order.type !== 'recharge') {
        return { success: false, error: '仅支持充值订单取消' };
    }
    if (order.status === 'paid') {
        return { success: false, error: '已支付订单不能取消' };
    }
    if (order.status === 'cancelled') {
        return { success: true, alreadyCancelled: true, order: serializeOrder(result.rows[0]) };
    }

    const nextMetadata = mergeMetadata(order.metadata, {
        cancelReason: reason,
        cancelledAt: new Date().toISOString(),
        operatorId
    });
    const updated = await db.pool.query(
        `UPDATE payment_records SET status = 'cancelled', metadata = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [nextMetadata, orderId]
    );
    return { success: true, order: serializeOrder(updated.rows[0]) };
}

function verifyFutongNotify(payload, secretKey) {
    const sign = normalizeString(payload.sign).toLowerCase();
    if (!sign) return false;
    return signFutong(payload, secretKey) === sign;
}

function verifyBepusdtNotify(payload, signSecret) {
    const signature = normalizeString(payload.signature).toLowerCase();
    if (!signature) return false;
    return signBepusdt(payload, signSecret) === signature;
}

function isFutongPaid(payload) {
    const status = normalizeString(payload.trade_status || payload.tradeStatus).toUpperCase();
    return ['TRADE_SUCCESS', 'SUCCESS', 'PAID'].includes(status);
}

function isBepusdtPaid(payload) {
    const status = normalizeString(payload.status || payload.trade_status || payload.tradeStatus).toLowerCase();
    if (['paid', 'success', 'succeeded', 'completed', 'confirmed'].includes(status)) {
        return true;
    }
    return !status && Number(payload.status_code || payload.statusCode) === 200;
}

async function handleFutongNotify(payload) {
    const config = await getPaymentConfig();
    if (!config.futong.secretKey) {
        return { success: false, error: '富通支付未配置密钥' };
    }
    if (!verifyFutongNotify(payload, config.futong.secretKey)) {
        return { success: false, error: '签名验证失败' };
    }
    if (!isFutongPaid(payload)) {
        return { success: true, skipped: true, reason: '支付未完成' };
    }
    return markRechargeOrderPaid({
        orderNo: payload.out_trade_no,
        transactionId: normalizeString(payload.trade_no),
        provider: 'futong',
        notifyPayload: payload,
        verifyResult: 'signature_verified',
        expectedAmount: payload.money || payload.total_fee || payload.amount
    });
}

async function handleBepusdtNotify(payload) {
    const config = await getPaymentConfig();
    const signSecret = config.bepusdt.signSecret || config.bepusdt.authToken;
    if (!signSecret) {
        return { success: false, error: 'BEPUSDT 未配置签名密钥' };
    }
    if (!verifyBepusdtNotify(payload, signSecret)) {
        return { success: false, error: '签名验证失败' };
    }
    if (!isBepusdtPaid(payload)) {
        return { success: true, skipped: true, reason: '支付未完成' };
    }
    return markRechargeOrderPaid({
        orderNo: payload.order_id || payload.orderId,
        transactionId: normalizeString(payload.transaction_hash || payload.trade_id || payload.tradeId),
        provider: 'bepusdt',
        notifyPayload: payload,
        verifyResult: 'signature_verified',
        expectedAmount: payload.money || payload.total_fee || payload.amount
    });
}

module.exports = {
    getPaymentConfig,
    getAdminPaymentConfig,
    savePaymentConfig,
    getRechargeOptions,
    createRechargeOrder,
    getOrderForUser,
    markRechargeOrderPaid,
    cancelRechargeOrder,
    handleFutongNotify,
    handleBepusdtNotify,
    getPublicBaseUrl
};
