const crypto = require('crypto');
const db = require('../db');
const { JWT_SECRET } = require('../middleware/auth');
const { generateOrderNo } = require('./balanceService');
const notificationService = require('./notificationService');

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

const BEPUSDT_TRADE_TYPE_OPTIONS = [
    'usdt.trc20',
    'usdt.bep20',
    'usdt.solana'
];

const BEPUSDT_TRADE_TYPE_ALIAS_MAP = {
    'usdt.trc20': 'usdt.trc20',
    'usdt-trc20': 'usdt.trc20',
    'usdt_trc20': 'usdt.trc20',
    usdttrc20: 'usdt.trc20',
    trc20: 'usdt.trc20',
    trc: 'usdt.trc20',
    'usdt.bep20': 'usdt.bep20',
    'usdt-bep20': 'usdt.bep20',
    'usdt_bep20': 'usdt.bep20',
    usdtbep20: 'usdt.bep20',
    bep20: 'usdt.bep20',
    bsc: 'usdt.bep20',
    'usdt.solana': 'usdt.solana',
    'usdt-solana': 'usdt.solana',
    'usdt_solana': 'usdt.solana',
    usdtsolana: 'usdt.solana',
    solana: 'usdt.solana',
    sol: 'usdt.solana'
};


const DEFAULT_RECHARGE_QUICK_AMOUNTS = [50, 100, 200, 500, 1000];
const PAYMENT_FEE_MODES = ['fixed', 'percent'];
const PUSHPLUS_DEFAULT_API_URL = 'https://www.pushplus.plus/batchSend';
const PUSHPLUS_DEFAULT_CHANNEL = 'app';
const MOBILE_REVIEW_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const MOBILE_REVIEW_TOKEN_PURPOSE = 'payment_manual_review';
const MOBILE_REVIEW_PAGE_PATH = 'payment-manual-review.html';
const MOBILE_REVIEW_SIGN_SECRET = crypto
    .createHash('sha256')
    .update(`${JWT_SECRET}:payment-manual-review:v1`)
    .digest();

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

function normalizeExternalUrl(value) {
    const raw = normalizeString(value);
    if (!raw || !/^https?:\/\//i.test(raw)) return raw;
    try {
        const parsed = new URL(raw);
        parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
        return parsed.toString();
    } catch {
        return raw.replace(/(^https?:\/\/[^/]+)\/{2,}/i, '$1/');
    }
}

function roundMoney(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return NaN;
    return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function toSafeAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return NaN;
    return Math.round(amount);
}

function toSafeMoneyAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return NaN;
    return roundMoney(amount);
}

function normalizePositiveAmount(value, fallback = null) {
    const amount = toSafeAmount(value);
    if (!Number.isFinite(amount) || amount <= 0) return fallback;
    return amount;
}

function normalizeFeeMode(value, fallback = 'fixed') {
    const safeFallback = PAYMENT_FEE_MODES.includes(fallback) ? fallback : 'fixed';
    const raw = normalizeString(value).toLowerCase();
    if (raw === 'percent' || raw === 'percentage' || raw === 'rate') return 'percent';
    if (raw === 'fixed' || raw === 'amount' || raw === 'fixed_amount') return 'fixed';
    return safeFallback;
}

function normalizeFeeValue(value, fallback = 0) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return fallback;
    return roundMoney(amount);
}

function normalizeFeeAmount(value, fallback = 0) {
    return normalizeFeeValue(value, fallback);
}

function resolvePaymentFeeConfig(modeValue, valueValue, legacyAmount = 0) {
    const rawMode = normalizeString(modeValue).toLowerCase();
    const rawValue = normalizeString(valueValue);
    const fallbackFixedValue = normalizeFeeValue(legacyAmount, 0);

    if (rawMode === 'percent' || rawMode === 'percentage' || rawMode === 'rate') {
        return {
            feeMode: 'percent',
            feeValue: rawValue ? normalizeFeeValue(valueValue, 0) : 0,
            feeAmount: 0
        };
    }

    return {
        feeMode: 'fixed',
        feeValue: rawValue ? normalizeFeeValue(valueValue, fallbackFixedValue) : fallbackFixedValue,
        feeAmount: rawValue ? normalizeFeeValue(valueValue, fallbackFixedValue) : fallbackFixedValue
    };
}

function calculateRechargeFee(baseAmount, feeMode, feeValue) {
    const safeBaseAmount = Number(baseAmount);
    if (!Number.isFinite(safeBaseAmount) || safeBaseAmount <= 0) return 0;
    const safeFeeMode = normalizeFeeMode(feeMode, 'fixed');
    const safeFeeValue = normalizeFeeValue(feeValue, 0);
    if (safeFeeValue <= 0) return 0;
    if (safeFeeMode === 'percent') {
        return roundMoney((safeBaseAmount * safeFeeValue) / 100);
    }
    return roundMoney(safeFeeValue);
}

function normalizeRechargeQuickAmounts(value, fallback = DEFAULT_RECHARGE_QUICK_AMOUNTS) {
    const rawList = Array.isArray(value)
        ? value
        : normalizeString(value).split(/[，,\s|/]+/).filter(Boolean);

    const uniqueAmounts = [];
    for (const item of rawList) {
        const amount = normalizePositiveAmount(item, null);
        if (!amount || uniqueAmounts.includes(amount)) continue;
        uniqueAmounts.push(amount);
    }

    return uniqueAmounts.length > 0 ? uniqueAmounts : [...fallback];
}

function normalizeAmountRange(minValue, maxValue, fallbackMin = 1) {
    const minAmount = Math.max(1, normalizePositiveAmount(minValue, fallbackMin) || fallbackMin);
    let maxAmount = normalizePositiveAmount(maxValue, null);
    if (maxAmount != null && maxAmount < minAmount) {
        maxAmount = minAmount;
    }
    return { minAmount, maxAmount };
}

function getDefaultPaymentOpenMode(channel = '') {
    return channel === 'bepusdt' ? 'redirect' : 'qrcode';
}

function normalizePaymentOpenMode(value, fallback = 'qrcode') {
    const safeFallback = normalizeString(fallback).toLowerCase() === 'redirect' ? 'redirect' : 'qrcode';
    const raw = normalizeString(value).toLowerCase();
    if (raw === 'redirect') return 'redirect';
    if (raw === 'qrcode') return 'qrcode';
    return safeFallback;
}

function getChannelPaymentOpenMode(config, channel) {
    if (channel === 'futong') {
        return normalizePaymentOpenMode(config?.futong?.openMode, getDefaultPaymentOpenMode(channel));
    }
    if (channel === 'bepusdt') {
        return normalizePaymentOpenMode(config?.bepusdt?.openMode, getDefaultPaymentOpenMode(channel));
    }
    return 'qrcode';
}

function normalizeBepusdtTradeType(value, fallback = 'usdt.bep20') {
    const fallbackValue = BEPUSDT_TRADE_TYPE_OPTIONS.includes(fallback) ? fallback : 'usdt.bep20';
    const raw = normalizeString(value).toLowerCase();
    if (!raw) return fallbackValue;

    const candidates = raw
        .split(/[\n,，|/]+/)
        .map(item => item.trim())
        .filter(Boolean);

    for (const candidate of candidates) {
        const compact = candidate.replace(/\s+/g, '');
        const mapped = BEPUSDT_TRADE_TYPE_ALIAS_MAP[compact] || BEPUSDT_TRADE_TYPE_ALIAS_MAP[compact.replace(/[-_]/g, '.')] || '';
        if (mapped && BEPUSDT_TRADE_TYPE_OPTIONS.includes(mapped)) {
            return mapped;
        }
        if (BEPUSDT_TRADE_TYPE_OPTIONS.includes(compact)) {
            return compact;
        }
    }

    return fallbackValue;
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
    const plain = buildQueryStringForSign(params, ['signature', 'sign']);
    return md5Lowercase(`${plain}${signSecret}`);
}


function parseJsonSafe(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function escapePushplusHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizePushplusChannel(value) {
    return normalizeString(value) || PUSHPLUS_DEFAULT_CHANNEL;
}

function base64UrlEncodeJson(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseBase64UrlJson(value) {
    try {
        return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function signMobileReviewTokenBody(body) {
    return crypto.createHmac('sha256', MOBILE_REVIEW_SIGN_SECRET).update(String(body || ''), 'utf8').digest('base64url');
}

function createMobileReviewToken(orderNo, expiresAt = Date.now() + MOBILE_REVIEW_TOKEN_TTL_MS) {
    const body = base64UrlEncodeJson({
        purpose: MOBILE_REVIEW_TOKEN_PURPOSE,
        orderNo: normalizeString(orderNo),
        exp: Number(expiresAt) || (Date.now() + MOBILE_REVIEW_TOKEN_TTL_MS)
    });
    return `${body}.${signMobileReviewTokenBody(body)}`;
}

function verifyMobileReviewToken(token) {
    const raw = normalizeString(token);
    if (!raw || !raw.includes('.')) return null;
    const [body, signature] = raw.split('.');
    if (!body || !signature) return null;
    const expected = signMobileReviewTokenBody(body);
    const actualBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
        return null;
    }
    const payload = parseBase64UrlJson(body);
    if (!payload || payload.purpose !== MOBILE_REVIEW_TOKEN_PURPOSE) return null;
    const exp = Number(payload.exp || 0);
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;
    const orderNo = normalizeString(payload.orderNo);
    if (!orderNo) return null;
    return { orderNo, exp };
}

function buildMobileReviewLink(baseUrl, token) {
    return `${joinUrl(baseUrl, MOBILE_REVIEW_PAGE_PATH)}?token=${encodeURIComponent(token)}`;
}

function isManualReviewOrder(order, metadata) {
    return order?.type === 'recharge' && metadata?.manualReview === true && metadata?.channel === 'fixed_qr';
}

function serializeManualReviewOrder(row) {
    const { order, metadata, label } = buildSerializedOrderState(row);
    return {
        id: order.id,
        orderNo: order.orderNo,
        username: order.username || order.userNickname || '-',
        amount: Number(order.amount || 0),
        status: order.status,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        itemName: order.itemName,
        label,
        instructions: metadata.instructions || '',
        manualReview: metadata.manualReview === true,
        manualReviewRequestedAt: metadata.manualReviewRequestedAt || '',
        manualReviewNotifiedAt: metadata.manualReviewNotifiedAt || '',
        manualReviewLinkExpiresAt: metadata.manualReviewLinkExpiresAt || ''
    };
}

async function getOrderRowByOrderNo(orderNo) {
    const result = await db.pool.query(
        `SELECT o.*, u.username, u.nickname AS user_nickname
         FROM payment_records o
         LEFT JOIN users u ON o.user_id = u.id
         WHERE o.order_no = $1
         LIMIT 1`,
        [orderNo]
    );
    return result.rows[0] || null;
}

async function getUserOrderRow(userId, orderNo) {
    const result = await db.pool.query(
        `SELECT o.*, u.username, u.nickname AS user_nickname
         FROM payment_records o
         LEFT JOIN users u ON o.user_id = u.id
         WHERE o.order_no = $1 AND o.user_id = $2
         LIMIT 1`,
        [orderNo, userId]
    );
    return result.rows[0] || null;
}

function buildPushplusContent(order, link) {
    const safeLink = normalizeExternalUrl(link) || link;
    const displayLink = escapePushplusHtml(safeLink || '');
    const createdAt = order.createdAt ? new Date(order.createdAt).toLocaleString('zh-CN') : '-';

    return {
        title: '固定码订单待确认',
        template: 'html',
        content: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;padding:0;margin:0;">
  <div style="max-width:560px;margin:0 auto;border:1px solid #dbeafe;border-radius:18px;overflow:hidden;background:#f8fbff;">
    <div style="padding:18px 20px;background:linear-gradient(135deg,#eff6ff,#dbeafe);border-bottom:1px solid #dbeafe;">
      <div style="display:inline-block;padding:4px 10px;border-radius:999px;background:#2563eb;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:.02em;">待确认</div>
      <div style="font-size:20px;font-weight:800;color:#0f172a;margin-top:12px;">固定码订单待处理</div>
      <div style="font-size:13px;color:#475569;margin-top:6px;">请点击下方按钮进入移动处理页。</div>
    </div>
    <div style="padding:18px 20px;line-height:1.75;">
      <div style="margin-bottom:8px;"><strong>订单号：</strong>${escapePushplusHtml(order.orderNo || '-')}</div>
      <div style="margin-bottom:8px;"><strong>用户：</strong>${escapePushplusHtml(order.username || '-')}</div>
      <div style="margin-bottom:8px;"><strong>金额：</strong>¥${Number(order.amount || 0).toFixed(2)}</div>
      <div style="margin-bottom:8px;"><strong>通道：</strong>${escapePushplusHtml(order.label || '-')}</div>
      <div style="margin-bottom:16px;"><strong>时间：</strong>${escapePushplusHtml(createdAt)}</div>
      <div style="margin-bottom:16px;">
        <a href="${safeLink}" style="display:block;width:100%;box-sizing:border-box;text-align:center;padding:13px 16px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#ffffff;text-decoration:none;border-radius:12px;font-weight:800;font-size:15px;">打开处理链接</a>
      </div>
      <div style="padding:12px 14px;border-radius:12px;background:#ffffff;border:1px dashed #93c5fd;">
        <div style="font-size:12px;font-weight:700;color:#64748b;margin-bottom:6px;">备用链接</div>
        <div style="font-size:12px;color:#334155;word-break:break-all;">${displayLink}</div>
      </div>
    </div>
  </div>
</div>`.trim()
    };
}

async function sendPushplusMessage(config, messageInput) {
    const endpoint = normalizeString(config?.pushplus?.apiUrl) || PUSHPLUS_DEFAULT_API_URL;
    const token = normalizeString(config?.pushplus?.token);
    if (!token) {
        throw createGatewayError('PushPlus Token 未配置', { publicMessage: '支付确认提交失败，请联系管理员处理' });
    }

    const message = typeof messageInput === 'object' && messageInput
        ? messageInput
        : { title: '消息通知', template: 'html', content: normalizeString(messageInput) };

    const payload = new URLSearchParams({
        channel: normalizePushplusChannel(config?.pushplus?.channel),
        token,
        title: normalizeString(message.title) || '消息通知',
        template: normalizeString(message.template) || 'html',
        content: normalizeString(message.content)
    });

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: payload.toString()
    });

    const text = await response.text();
    const parsed = parseJsonSafe(text) || { raw: text };
    const code = Number(parsed.code);
    const responseMessage = normalizeString(parsed.msg || parsed.message || parsed.data || '');
    const success = response.ok && (
        !Number.isFinite(code)
        || code === 200
        || code === 0
        || code === 1
        || /成功|success/i.test(responseMessage)
    );

    if (!success) {
        throw createGatewayError(
            responseMessage || `PushPlus 发送失败: HTTP ${response.status}`,
            { responseStatus: response.status, upstreamResponse: parsed, publicMessage: '支付确认提交失败，请联系管理员处理' }
        );
    }

    return {
        responseStatus: response.status,
        raw: parsed
    };
}


function normalizeBepusdtNotifyPayload(payload) {
    const base = payload && typeof payload === 'object' ? { ...payload } : {};
    const nested = typeof base.data === 'string'
        ? parseJsonSafe(base.data)
        : (base.data && typeof base.data === 'object' ? base.data : null);
    const normalized = nested && typeof nested === 'object' && !Array.isArray(nested)
        ? { ...nested, ...base, data: nested }
        : base;

    if (!normalized.signature) {
        normalized.signature = normalizeString(base.signature || base.sign || nested?.signature || nested?.sign);
    }
    if (!normalized.order_id) {
        normalized.order_id = normalizeString(
            base.order_id || base.orderId || base.order_no || base.orderNo || base.out_trade_no || base.outTradeNo ||
            nested?.order_id || nested?.orderId || nested?.order_no || nested?.orderNo || nested?.out_trade_no || nested?.outTradeNo ||
            base.merchant_order_id || base.merchantOrderId || nested?.merchant_order_id || nested?.merchantOrderId
        );
    }
    if (!normalized.transaction_hash) {
        normalized.transaction_hash = normalizeString(
            base.transaction_hash || base.transactionHash || base.txid || base.tx_id ||
            nested?.transaction_hash || nested?.transactionHash || nested?.txid || nested?.tx_id ||
            base.trade_id || base.tradeId || nested?.trade_id || nested?.tradeId ||
            base.block_transaction_id || base.blockTransactionId || nested?.block_transaction_id || nested?.blockTransactionId
        );
    }

    return normalized;
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

function getRechargeOptionExtraConfig(config, channel, method) {
    if (channel === 'fixed_qr') {
        if (method === 'wxpay') {
            return {
                feeMode: normalizeFeeMode(config.fixedQr.wechat.feeMode, 'fixed'),
                feeValue: normalizeFeeValue(config.fixedQr.wechat.feeValue, 0),
                feeAmount: normalizeFeeAmount(config.fixedQr.wechat.feeAmount, 0),
                recommended: config.fixedQr.wechat.recommended === true
            };
        }
        if (method === 'alipay') {
            return {
                feeMode: normalizeFeeMode(config.fixedQr.alipay.feeMode, 'fixed'),
                feeValue: normalizeFeeValue(config.fixedQr.alipay.feeValue, 0),
                feeAmount: normalizeFeeAmount(config.fixedQr.alipay.feeAmount, 0),
                recommended: config.fixedQr.alipay.recommended === true
            };
        }
    }

    if (channel === 'futong') {
        if (method === 'alipay') {
            return {
                feeMode: normalizeFeeMode(config.futong.alipayFeeMode, 'fixed'),
                feeValue: normalizeFeeValue(config.futong.alipayFeeValue, 0),
                feeAmount: normalizeFeeAmount(config.futong.alipayFeeAmount, 0),
                recommended: config.futong.alipayRecommended === true
            };
        }
        if (method === 'wxpay') {
            return {
                feeMode: normalizeFeeMode(config.futong.wxpayFeeMode, 'fixed'),
                feeValue: normalizeFeeValue(config.futong.wxpayFeeValue, 0),
                feeAmount: normalizeFeeAmount(config.futong.wxpayFeeAmount, 0),
                recommended: config.futong.wxpayRecommended === true
            };
        }
    }

    if (channel === 'bepusdt' && method === 'usdt') {
        return {
            feeMode: normalizeFeeMode(config.bepusdt.feeMode, 'fixed'),
            feeValue: normalizeFeeValue(config.bepusdt.feeValue, 0),
            feeAmount: normalizeFeeAmount(config.bepusdt.feeAmount, 0),
            recommended: config.bepusdt.recommended === true
        };
    }

    return { feeMode: 'fixed', feeValue: 0, feeAmount: 0, recommended: false };
}

function getPublicBaseUrl(req) {
    const forwardedProto = normalizeString(req.headers['x-forwarded-proto']).split(',')[0];
    const proto = forwardedProto || req.protocol || 'http';
    const forwardedHost = normalizeString(req.headers['x-forwarded-host']).split(',')[0];
    const host = forwardedHost || req.get('host');
    return `${proto}://${host}`;
}

function normalizeClientIp(value) {
    const raw = normalizeString(value);
    if (!raw) return '127.0.0.1';
    if (raw === '::1') return '127.0.0.1';
    if (raw.startsWith('::ffff:')) return raw.slice(7);
    return raw;
}

function getClientIp(req) {
    const xForwardedFor = normalizeString(req.headers['x-forwarded-for']);
    if (xForwardedFor) {
        return normalizeClientIp(xForwardedFor.split(',')[0].trim());
    }
    return normalizeClientIp(req.ip || req.socket?.remoteAddress || '127.0.0.1');
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
    const quickAmounts = normalizeRechargeQuickAmounts(settings.payment_quick_amounts || settings.paymentQuickAmounts);
    const fixedWechatEnabled = normalizeBoolean(settings.payment_fixed_wechat_enabled);
    const fixedAlipayEnabled = normalizeBoolean(settings.payment_fixed_alipay_enabled);
    const futongEnabled = normalizeBoolean(settings.payment_futong_enabled);
    const futongAlipayEnabled = normalizeBoolean(settings.payment_futong_alipay_enabled);
    const futongWxpayEnabled = normalizeBoolean(settings.payment_futong_wxpay_enabled);
    const bepusdtEnabled = normalizeBoolean(settings.payment_bepusdt_enabled);
    const pushplusEnabled = normalizeBoolean(settings.payment_pushplus_enabled);
    const fixedWechatFeeConfig = resolvePaymentFeeConfig(settings.payment_fixed_wechat_fee_mode, settings.payment_fixed_wechat_fee_value, settings.payment_fixed_wechat_fee_amount);
    const fixedAlipayFeeConfig = resolvePaymentFeeConfig(settings.payment_fixed_alipay_fee_mode, settings.payment_fixed_alipay_fee_value, settings.payment_fixed_alipay_fee_amount);
    const futongAlipayFeeConfig = resolvePaymentFeeConfig(settings.payment_futong_alipay_fee_mode, settings.payment_futong_alipay_fee_value, settings.payment_futong_alipay_fee_amount);
    const futongWxpayFeeConfig = resolvePaymentFeeConfig(settings.payment_futong_wxpay_fee_mode, settings.payment_futong_wxpay_fee_value, settings.payment_futong_wxpay_fee_amount);
    const bepusdtFeeConfig = resolvePaymentFeeConfig(settings.payment_bepusdt_fee_mode, settings.payment_bepusdt_fee_value, settings.payment_bepusdt_fee_amount);
    const fixedWechatRecommended = normalizeBoolean(settings.payment_fixed_wechat_recommended);
    const fixedAlipayRecommended = normalizeBoolean(settings.payment_fixed_alipay_recommended);
    const futongAlipayRecommended = normalizeBoolean(settings.payment_futong_alipay_recommended);
    const futongWxpayRecommended = normalizeBoolean(settings.payment_futong_wxpay_recommended);
    const bepusdtRecommended = normalizeBoolean(settings.payment_bepusdt_recommended);

    const fixedWechatRange = normalizeAmountRange(settings.payment_fixed_wechat_min_amount, settings.payment_fixed_wechat_max_amount, minRechargeAmount);
    const fixedAlipayRange = normalizeAmountRange(settings.payment_fixed_alipay_min_amount, settings.payment_fixed_alipay_max_amount, minRechargeAmount);
    const futongAlipayRange = normalizeAmountRange(settings.payment_futong_alipay_min_amount, settings.payment_futong_alipay_max_amount, minRechargeAmount);
    const futongWxpayRange = normalizeAmountRange(settings.payment_futong_wxpay_min_amount, settings.payment_futong_wxpay_max_amount, minRechargeAmount);
    const bepusdtRange = normalizeAmountRange(settings.payment_bepusdt_min_amount, settings.payment_bepusdt_max_amount, minRechargeAmount);
    const futongOpenMode = normalizePaymentOpenMode(settings.payment_futong_open_mode, getDefaultPaymentOpenMode('futong'));
    const bepusdtOpenMode = normalizePaymentOpenMode(settings.payment_bepusdt_open_mode, getDefaultPaymentOpenMode('bepusdt'));

    const computedNotifyUrls = baseUrl ? {
        futong: joinUrl(baseUrl, '/api/payment/notify/futong'),
        bepusdt: joinUrl(baseUrl, '/api/payment/notify/bepusdt')
    } : { futong: '', bepusdt: '' };
    const computedReturnUrl = baseUrl ? joinUrl(baseUrl, '/user-center.html') : '';
    const customFutongNotifyUrl = normalizeString(settings.payment_futong_notify_url);
    const customBepusdtNotifyUrl = normalizeString(settings.payment_bepusdt_notify_url);
    const customFutongReturnUrl = normalizeString(settings.payment_futong_return_url);

    const config = {
        minRechargeAmount,
        quickAmounts,
        fixedQr: {
            wechat: {
                enabled: fixedWechatEnabled,
                imageData: normalizeString(settings.payment_fixed_wechat_image),
                minAmount: fixedWechatRange.minAmount,
                maxAmount: fixedWechatRange.maxAmount,
                feeMode: fixedWechatFeeConfig.feeMode,
                feeValue: fixedWechatFeeConfig.feeValue,
                feeAmount: fixedWechatFeeConfig.feeAmount,
                recommended: fixedWechatRecommended
            },
            alipay: {
                enabled: fixedAlipayEnabled,
                imageData: normalizeString(settings.payment_fixed_alipay_image),
                minAmount: fixedAlipayRange.minAmount,
                maxAmount: fixedAlipayRange.maxAmount,
                feeMode: fixedAlipayFeeConfig.feeMode,
                feeValue: fixedAlipayFeeConfig.feeValue,
                feeAmount: fixedAlipayFeeConfig.feeAmount,
                recommended: fixedAlipayRecommended
            }
        },
        futong: {
            enabled: futongEnabled,
            apiUrl: normalizeString(settings.payment_futong_api_url),
            pid: normalizeString(settings.payment_futong_pid),
            secretKey: normalizeString(settings.payment_futong_secret_key),
            openMode: futongOpenMode,
            alipayEnabled: futongAlipayEnabled,
            wxpayEnabled: futongWxpayEnabled,
            alipayMinAmount: futongAlipayRange.minAmount,
            alipayMaxAmount: futongAlipayRange.maxAmount,
            wxpayMinAmount: futongWxpayRange.minAmount,
            wxpayMaxAmount: futongWxpayRange.maxAmount,
            alipayFeeMode: futongAlipayFeeConfig.feeMode,
            alipayFeeValue: futongAlipayFeeConfig.feeValue,
            alipayFeeAmount: futongAlipayFeeConfig.feeAmount,
            wxpayFeeMode: futongWxpayFeeConfig.feeMode,
            wxpayFeeValue: futongWxpayFeeConfig.feeValue,
            wxpayFeeAmount: futongWxpayFeeConfig.feeAmount,
            alipayRecommended: futongAlipayRecommended,
            wxpayRecommended: futongWxpayRecommended
        },
        bepusdt: {
            enabled: bepusdtEnabled,
            apiUrl: normalizeString(settings.payment_bepusdt_api_url),
            authToken: normalizeString(settings.payment_bepusdt_auth_token),
            signSecret: normalizeString(settings.payment_bepusdt_sign_secret),
            openMode: bepusdtOpenMode,
            tradeType: normalizeBepusdtTradeType(settings.payment_bepusdt_trade_type),
            minAmount: bepusdtRange.minAmount,
            maxAmount: bepusdtRange.maxAmount,
            feeMode: bepusdtFeeConfig.feeMode,
            feeValue: bepusdtFeeConfig.feeValue,
            feeAmount: bepusdtFeeConfig.feeAmount,
            recommended: bepusdtRecommended
        },
        pushplus: {
            enabled: pushplusEnabled,
            apiUrl: normalizeString(settings.payment_pushplus_api_url) || PUSHPLUS_DEFAULT_API_URL,
            token: normalizeString(settings.payment_pushplus_token),
            channel: normalizePushplusChannel(settings.payment_pushplus_channel)
        },
        notifyUrls: {
            futong: customFutongNotifyUrl || computedNotifyUrls.futong,
            bepusdt: customBepusdtNotifyUrl || computedNotifyUrls.bepusdt
        },
        returnUrls: {
            futong: customFutongReturnUrl || computedReturnUrl,
            bepusdt: computedReturnUrl
        },
        returnUrl: computedReturnUrl
    };

    config.fixedQr.wechat.enabled = config.fixedQr.wechat.enabled && !!config.fixedQr.wechat.imageData;
    config.fixedQr.alipay.enabled = config.fixedQr.alipay.enabled && !!config.fixedQr.alipay.imageData;
    config.futong.enabled = config.futong.enabled && !!config.futong.apiUrl && !!config.futong.pid && !!config.futong.secretKey && (config.futong.alipayEnabled || config.futong.wxpayEnabled);
    config.bepusdt.enabled = config.bepusdt.enabled && !!config.bepusdt.apiUrl && !!config.bepusdt.authToken;
    config.pushplus.ready = config.pushplus.enabled && !!config.pushplus.apiUrl && !!config.pushplus.token;

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
        quickAmounts: config.quickAmounts,
        fixedQr: {
            wechat: {
                enabled: normalizeBoolean(settings.payment_fixed_wechat_enabled),
                imageData: normalizeString(settings.payment_fixed_wechat_image),
                minAmount: config.fixedQr.wechat.minAmount,
                maxAmount: config.fixedQr.wechat.maxAmount,
                feeMode: config.fixedQr.wechat.feeMode,
                feeValue: config.fixedQr.wechat.feeValue,
                feeAmount: config.fixedQr.wechat.feeAmount,
                recommended: config.fixedQr.wechat.recommended === true
            },
            alipay: {
                enabled: normalizeBoolean(settings.payment_fixed_alipay_enabled),
                imageData: normalizeString(settings.payment_fixed_alipay_image),
                minAmount: config.fixedQr.alipay.minAmount,
                maxAmount: config.fixedQr.alipay.maxAmount,
                feeMode: config.fixedQr.alipay.feeMode,
                feeValue: config.fixedQr.alipay.feeValue,
                feeAmount: config.fixedQr.alipay.feeAmount,
                recommended: config.fixedQr.alipay.recommended === true
            }
        },
        futong: {
            enabled: normalizeBoolean(settings.payment_futong_enabled),
            apiUrl: normalizeString(settings.payment_futong_api_url),
            pid: normalizeString(settings.payment_futong_pid),
            secretKey: normalizeString(settings.payment_futong_secret_key),
            secretKeyMasked: maskSecret(settings.payment_futong_secret_key),
            openMode: config.futong.openMode,
            alipayEnabled: normalizeBoolean(settings.payment_futong_alipay_enabled),
            wxpayEnabled: normalizeBoolean(settings.payment_futong_wxpay_enabled),
            alipayMinAmount: config.futong.alipayMinAmount,
            alipayMaxAmount: config.futong.alipayMaxAmount,
            wxpayMinAmount: config.futong.wxpayMinAmount,
            wxpayMaxAmount: config.futong.wxpayMaxAmount,
            alipayFeeMode: config.futong.alipayFeeMode,
            alipayFeeValue: config.futong.alipayFeeValue,
            alipayFeeAmount: config.futong.alipayFeeAmount,
            wxpayFeeMode: config.futong.wxpayFeeMode,
            wxpayFeeValue: config.futong.wxpayFeeValue,
            wxpayFeeAmount: config.futong.wxpayFeeAmount,
            alipayRecommended: config.futong.alipayRecommended === true,
            wxpayRecommended: config.futong.wxpayRecommended === true,
            notifyUrl: config.notifyUrls.futong,
            returnUrl: config.returnUrls.futong,
            ready: config.futong.enabled
        },
        bepusdt: {
            enabled: normalizeBoolean(settings.payment_bepusdt_enabled),
            apiUrl: normalizeString(settings.payment_bepusdt_api_url),
            authToken: normalizeString(settings.payment_bepusdt_auth_token),
            authTokenMasked: maskSecret(settings.payment_bepusdt_auth_token),
            signSecret: normalizeString(settings.payment_bepusdt_sign_secret),
            signSecretMasked: maskSecret(settings.payment_bepusdt_sign_secret),
            openMode: config.bepusdt.openMode,
            tradeType: normalizeBepusdtTradeType(settings.payment_bepusdt_trade_type),
            minAmount: config.bepusdt.minAmount,
            maxAmount: config.bepusdt.maxAmount,
            feeMode: config.bepusdt.feeMode,
            feeValue: config.bepusdt.feeValue,
            feeAmount: config.bepusdt.feeAmount,
            recommended: config.bepusdt.recommended === true,
            notifyUrl: config.notifyUrls.bepusdt,
            redirectUrl: config.returnUrl,
            ready: config.bepusdt.enabled
        },
        pushplus: {
            enabled: normalizeBoolean(settings.payment_pushplus_enabled),
            apiUrl: config.pushplus.apiUrl,
            token: normalizeString(settings.payment_pushplus_token),
            tokenMasked: maskSecret(settings.payment_pushplus_token),
            channel: normalizePushplusChannel(settings.payment_pushplus_channel),
            ready: config.pushplus.ready
        }
    };
}

async function getAdminPushplusConfig(baseUrl = '') {
    const settings = await db.getSystemSettings();
    const config = normalizePaymentConfig(settings, baseUrl);
    return {
        enabled: normalizeBoolean(settings.payment_pushplus_enabled),
        apiUrl: config.pushplus.apiUrl,
        token: normalizeString(settings.payment_pushplus_token),
        tokenMasked: maskSecret(settings.payment_pushplus_token),
        channel: normalizePushplusChannel(settings.payment_pushplus_channel),
        ready: config.pushplus.ready
    };
}

function sanitizePushplusConfigInput(input = {}) {
    return {
        payment_pushplus_enabled: String(normalizeBoolean(input.enabled)),
        payment_pushplus_api_url: normalizeString(input.apiUrl) || PUSHPLUS_DEFAULT_API_URL,
        payment_pushplus_token: normalizeString(input.token),
        payment_pushplus_channel: normalizePushplusChannel(input.channel)
    };
}

function sanitizePaymentConfigInput(input = {}) {
    const minRechargeAmount = Math.max(1, normalizePositiveAmount(input.minRechargeAmount, 1) || 1);
    const quickAmounts = normalizeRechargeQuickAmounts(input.quickAmounts);
    const fixedWechatFeeConfig = resolvePaymentFeeConfig(input.fixedQr?.wechat?.feeMode, input.fixedQr?.wechat?.feeValue ?? input.fixedQr?.wechat?.feeAmount, input.fixedQr?.wechat?.feeAmount);
    const fixedAlipayFeeConfig = resolvePaymentFeeConfig(input.fixedQr?.alipay?.feeMode, input.fixedQr?.alipay?.feeValue ?? input.fixedQr?.alipay?.feeAmount, input.fixedQr?.alipay?.feeAmount);
    const futongAlipayFeeConfig = resolvePaymentFeeConfig(input.futong?.alipayFeeMode, input.futong?.alipayFeeValue ?? input.futong?.alipayFeeAmount, input.futong?.alipayFeeAmount);
    const futongWxpayFeeConfig = resolvePaymentFeeConfig(input.futong?.wxpayFeeMode, input.futong?.wxpayFeeValue ?? input.futong?.wxpayFeeAmount, input.futong?.wxpayFeeAmount);
    const bepusdtFeeConfig = resolvePaymentFeeConfig(input.bepusdt?.feeMode, input.bepusdt?.feeValue ?? input.bepusdt?.feeAmount, input.bepusdt?.feeAmount);
    return {
        min_recharge_amount: String(minRechargeAmount),
        payment_quick_amounts: quickAmounts.join(','),
        payment_fixed_wechat_enabled: String(normalizeBoolean(input.fixedQr?.wechat?.enabled)),
        payment_fixed_wechat_image: normalizeString(input.fixedQr?.wechat?.imageData),
        payment_fixed_wechat_min_amount: serializeAmountSetting(input.fixedQr?.wechat?.minAmount, { fallback: minRechargeAmount }),
        payment_fixed_wechat_max_amount: serializeAmountSetting(input.fixedQr?.wechat?.maxAmount, { allowEmpty: true }),
        payment_fixed_wechat_fee_mode: fixedWechatFeeConfig.feeMode,
        payment_fixed_wechat_fee_value: String(fixedWechatFeeConfig.feeValue),
        payment_fixed_wechat_fee_amount: String(fixedWechatFeeConfig.feeAmount),
        payment_fixed_wechat_recommended: String(normalizeBoolean(input.fixedQr?.wechat?.recommended)),
        payment_fixed_alipay_enabled: String(normalizeBoolean(input.fixedQr?.alipay?.enabled)),
        payment_fixed_alipay_image: normalizeString(input.fixedQr?.alipay?.imageData),
        payment_fixed_alipay_min_amount: serializeAmountSetting(input.fixedQr?.alipay?.minAmount, { fallback: minRechargeAmount }),
        payment_fixed_alipay_max_amount: serializeAmountSetting(input.fixedQr?.alipay?.maxAmount, { allowEmpty: true }),
        payment_fixed_alipay_fee_mode: fixedAlipayFeeConfig.feeMode,
        payment_fixed_alipay_fee_value: String(fixedAlipayFeeConfig.feeValue),
        payment_fixed_alipay_fee_amount: String(fixedAlipayFeeConfig.feeAmount),
        payment_fixed_alipay_recommended: String(normalizeBoolean(input.fixedQr?.alipay?.recommended)),
        payment_futong_enabled: String(normalizeBoolean(input.futong?.enabled)),
        payment_futong_api_url: normalizeString(input.futong?.apiUrl),
        payment_futong_pid: normalizeString(input.futong?.pid),
        payment_futong_secret_key: normalizeString(input.futong?.secretKey),
        payment_futong_open_mode: normalizePaymentOpenMode(input.futong?.openMode, getDefaultPaymentOpenMode('futong')),
        payment_futong_notify_url: normalizeString(input.futong?.notifyUrl),
        payment_futong_return_url: normalizeString(input.futong?.returnUrl),
        payment_futong_alipay_enabled: String(normalizeBoolean(input.futong?.alipayEnabled)),
        payment_futong_wxpay_enabled: String(normalizeBoolean(input.futong?.wxpayEnabled)),
        payment_futong_alipay_min_amount: serializeAmountSetting(input.futong?.alipayMinAmount, { fallback: minRechargeAmount }),
        payment_futong_alipay_max_amount: serializeAmountSetting(input.futong?.alipayMaxAmount, { allowEmpty: true }),
        payment_futong_alipay_fee_mode: futongAlipayFeeConfig.feeMode,
        payment_futong_alipay_fee_value: String(futongAlipayFeeConfig.feeValue),
        payment_futong_alipay_fee_amount: String(futongAlipayFeeConfig.feeAmount),
        payment_futong_alipay_recommended: String(normalizeBoolean(input.futong?.alipayRecommended)),
        payment_futong_wxpay_min_amount: serializeAmountSetting(input.futong?.wxpayMinAmount, { fallback: minRechargeAmount }),
        payment_futong_wxpay_max_amount: serializeAmountSetting(input.futong?.wxpayMaxAmount, { allowEmpty: true }),
        payment_futong_wxpay_fee_mode: futongWxpayFeeConfig.feeMode,
        payment_futong_wxpay_fee_value: String(futongWxpayFeeConfig.feeValue),
        payment_futong_wxpay_fee_amount: String(futongWxpayFeeConfig.feeAmount),
        payment_futong_wxpay_recommended: String(normalizeBoolean(input.futong?.wxpayRecommended)),
        payment_bepusdt_enabled: String(normalizeBoolean(input.bepusdt?.enabled)),
        payment_bepusdt_api_url: normalizeString(input.bepusdt?.apiUrl),
        payment_bepusdt_auth_token: normalizeString(input.bepusdt?.authToken),
        payment_bepusdt_sign_secret: normalizeString(input.bepusdt?.signSecret),
        payment_bepusdt_open_mode: normalizePaymentOpenMode(input.bepusdt?.openMode, getDefaultPaymentOpenMode('bepusdt')),
        payment_bepusdt_notify_url: normalizeString(input.bepusdt?.notifyUrl),
        payment_bepusdt_trade_type: normalizeBepusdtTradeType(input.bepusdt?.tradeType),
        payment_bepusdt_min_amount: serializeAmountSetting(input.bepusdt?.minAmount, { fallback: minRechargeAmount }),
        payment_bepusdt_max_amount: serializeAmountSetting(input.bepusdt?.maxAmount, { allowEmpty: true }),
        payment_bepusdt_fee_mode: bepusdtFeeConfig.feeMode,
        payment_bepusdt_fee_value: String(bepusdtFeeConfig.feeValue),
        payment_bepusdt_fee_amount: String(bepusdtFeeConfig.feeAmount),
        payment_bepusdt_recommended: String(normalizeBoolean(input.bepusdt?.recommended)),
        payment_pushplus_enabled: String(normalizeBoolean(input.pushplus?.enabled)),
        payment_pushplus_api_url: normalizeString(input.pushplus?.apiUrl) || PUSHPLUS_DEFAULT_API_URL,
        payment_pushplus_token: normalizeString(input.pushplus?.token),
        payment_pushplus_channel: normalizePushplusChannel(input.pushplus?.channel)
    };
}

async function savePushplusConfig(input = {}) {
    const entries = Object.entries(sanitizePushplusConfigInput(input));
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
        const extraConfig = getRechargeOptionExtraConfig(config, channel, method);
        options.push({
            key: `${channel}:${method}`,
            channel,
            method,
            openMode: getChannelPaymentOpenMode(config, channel),
            ...getRechargeOptionTitle(channel, method),
            minAmount: range.minAmount,
            maxAmount: range.maxAmount,
            rangeText: formatAmountRangeText(range.minAmount, range.maxAmount),
            feeMode: extraConfig.feeMode,
            feeValue: extraConfig.feeValue,
            feeAmount: extraConfig.feeAmount,
            recommended: extraConfig.recommended === true
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

function normalizeOrderMetadata(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { ...value };
    }
    if (typeof value === 'string') {
        const parsed = parseJsonSafe(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ...parsed };
        }
    }
    return {};
}

function buildSerializedOrderState(row) {
    const order = db.toCamelCase(row);
    const metadata = normalizeOrderMetadata(order.metadata);
    const channel = normalizeString(metadata.channel);
    const method = normalizeString(metadata.method);
    const openMode = normalizePaymentOpenMode(metadata.openMode, getDefaultPaymentOpenMode(channel));
    const label = normalizeString(metadata.label) || createDisplayLabel(channel, method);
    return { order, metadata, channel, method, openMode, label };
}

function buildUserOrderMetadata(metadata, { openMode, label }) {
    return {
        openMode,
        label,
        amount: metadata.amount ?? null,
        creditAmount: metadata.creditAmount ?? metadata.amount ?? null,
        feeMode: normalizeFeeMode(metadata.feeMode, 'fixed'),
        feeValue: normalizeFeeValue(metadata.feeValue ?? metadata.feeAmount, 0),
        feeAmount: metadata.feeAmount ?? 0,
        payableAmount: metadata.payableAmount ?? metadata.amount ?? null,
        minAmount: metadata.minAmount ?? null,
        maxAmount: metadata.maxAmount ?? null,
        amountRangeText: metadata.amountRangeText || '',
        createdAt: metadata.createdAt || '',
        actualAmount: metadata.actualAmount || null,
        tradeType: metadata.tradeType || '',
        instructions: metadata.instructions || '',
        recommended: metadata.recommended === true,
        manualReview: metadata.manualReview === true,
        manualReviewRequestedAt: metadata.manualReviewRequestedAt || '',
        manualReviewNotifiedAt: metadata.manualReviewNotifiedAt || '',
        manualReviewLinkExpiresAt: metadata.manualReviewLinkExpiresAt || ''
    };
}

function serializeUserOrderListItem(row) {
    const { order, label } = buildSerializedOrderState(row);
    return {
        id: order.id,
        orderNo: order.orderNo,
        type: order.type,
        itemName: order.itemName,
        amount: Number(order.amount || 0),
        currency: order.currency,
        status: order.status,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        label,
        metadata: { label }
    };
}

function serializeOrder(row) {
    const { order, metadata, channel, method, openMode, label } = buildSerializedOrderState(row);
    return {
        id: order.id,
        orderNo: order.orderNo,
        type: order.type,
        itemName: order.itemName,
        amount: Number(order.amount || 0),
        creditAmount: Number((metadata.creditAmount ?? order.amount) || 0),
        feeMode: normalizeFeeMode(metadata.feeMode, 'fixed'),
        feeValue: normalizeFeeValue(metadata.feeValue ?? metadata.feeAmount, 0),
        feeAmount: Number(metadata.feeAmount || 0),
        payableAmount: Number((metadata.payableAmount ?? order.amount) || 0),
        currency: order.currency,
        status: order.status,
        paymentMethod: order.paymentMethod,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        channel,
        method,
        openMode,
        label,
        qrImageData: metadata.qrImageData || '',
        qrCodeUrl: metadata.qrCodeUrl || '',
        paymentUrl: metadata.paymentUrl || '',
        actualAmount: metadata.actualAmount || null,
        tradeType: metadata.tradeType || '',
        instructions: metadata.instructions || '',
        manualReview: metadata.manualReview === true,
        manualReviewRequestedAt: metadata.manualReviewRequestedAt || '',
        manualReviewNotifiedAt: metadata.manualReviewNotifiedAt || '',
        manualReviewLinkExpiresAt: metadata.manualReviewLinkExpiresAt || '',
        metadata: {
            ...metadata,
            openMode,
            label
        }
    };
}

function serializeUserOrder(row) {
    const { order, metadata, openMode, label } = buildSerializedOrderState(row);
    return {
        id: order.id,
        orderNo: order.orderNo,
        type: order.type,
        itemName: order.itemName,
        amount: Number(order.amount || 0),
        creditAmount: Number((metadata.creditAmount ?? order.amount) || 0),
        feeMode: normalizeFeeMode(metadata.feeMode, 'fixed'),
        feeValue: normalizeFeeValue(metadata.feeValue ?? metadata.feeAmount, 0),
        feeAmount: Number(metadata.feeAmount || 0),
        payableAmount: Number((metadata.payableAmount ?? order.amount) || 0),
        currency: order.currency,
        status: order.status,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        openMode,
        label,
        qrImageData: metadata.qrImageData || '',
        qrCodeUrl: metadata.qrCodeUrl || '',
        paymentUrl: metadata.paymentUrl || '',
        actualAmount: metadata.actualAmount || null,
        tradeType: metadata.tradeType || '',
        instructions: metadata.instructions || '',
        manualReview: metadata.manualReview === true,
        manualReviewRequestedAt: metadata.manualReviewRequestedAt || '',
        manualReviewNotifiedAt: metadata.manualReviewNotifiedAt || '',
        manualReviewLinkExpiresAt: metadata.manualReviewLinkExpiresAt || '',
        metadata: buildUserOrderMetadata(metadata, { openMode, label })
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

function buildGatewayRequestMeta({ url, method = 'POST', contentType = '', payload = null }) {
    return {
        url: normalizeExternalUrl(url),
        method,
        contentType,
        payload: payload && typeof payload === 'object' ? { ...payload } : payload
    };
}

function createGatewayError(message, context = {}) {
    const error = new Error(message);
    Object.assign(error, context);
    return error;
}

function resolveFutongEndpoint(apiUrl, targetPath = '/mapi.php') {
    const raw = normalizeString(apiUrl);
    if (!raw) return targetPath;
    try {
        const parsed = new URL(raw);
        if (/\/(submit|mapi|api)\.php$/i.test(parsed.pathname)) {
            parsed.pathname = targetPath;
            parsed.search = '';
            parsed.hash = '';
            return parsed.toString();
        }
        return joinUrl(`${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, ''), targetPath);
    } catch {
        return joinUrl(raw, targetPath);
    }
}

function buildGatewayFailureMessage(prefix, parsed, responseStatus) {
    const direct = parsed?.msg || parsed?.message || parsed?.error;
    if (direct) return direct;
    const raw = normalizeString(parsed?.raw || '');
    if (raw) return `${prefix}: ${raw.slice(0, 200)}`;
    return `${prefix}: HTTP ${responseStatus}`;
}

function extractBepusdtSignature(payload) {
    return normalizeString(payload?.signature || payload?.sign || payload?.data?.signature || payload?.data?.sign);
}

function hasBepusdtSignature(payload) {
    return !!extractBepusdtSignature(payload);
}

async function requestFutongPayment({ config, orderNo, amount, method, notifyUrl, returnUrl, clientIp }) {
    const endpoint = resolveFutongEndpoint(config.apiUrl, '/mapi.php');
    const payload = {
        pid: config.pid,
        type: method,
        out_trade_no: orderNo,
        notify_url: notifyUrl,
        return_url: returnUrl,
        name: '余额充值',
        money: Number(amount).toFixed(2),
        param: orderNo,
        clientip: normalizeClientIp(clientIp || '127.0.0.1'),
        device: 'pc',
        sign_type: 'MD5'
    };
    payload.sign = signFutong(payload, config.secretKey);
    const requestMeta = buildGatewayRequestMeta({
        url: endpoint,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        payload
    });

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams(payload)
    });

    const text = await response.text();
    const parsed = parseJsonSafe(text) || { raw: text };
    const success = response.ok && (Number(parsed.code) === 1 || Number(parsed.status) === 1 || parsed.success === true);
    if (!success) {
        throw createGatewayError(
            buildGatewayFailureMessage('富通支付下单失败', parsed, response.status),
            { requestMeta, responseStatus: response.status, upstreamResponse: parsed }
        );
    }

    const paymentUrl = normalizeExternalUrl(parsed.payurl || parsed.payment_url || parsed.url || parsed.urlscheme);
    const qrCodeUrl = normalizeExternalUrl(parsed.qrcode || parsed.qrCode || paymentUrl);
    return {
        raw: parsed,
        requestMeta,
        responseStatus: response.status,
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
        amount: Number(Number(amount).toFixed(2)),
        trade_type: config.tradeType,
        notify_url: notifyUrl,
        redirect_url: redirectUrl,
        timeout: 1200
    };
    payload.signature = signBepusdt(payload, signSecret);
    const requestMeta = buildGatewayRequestMeta({
        url: endpoint,
        method: 'POST',
        contentType: 'application/json',
        payload
    });

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
    const payloadData = parsed && typeof parsed.data === 'object' && parsed.data ? parsed.data : {};
    const success = response.ok && (Number(parsed.status_code || parsed.statusCode || parsed.code) === 200 || parsed.success === true);
    if (!success) {
        throw createGatewayError(
            parsed.msg || parsed.message || parsed.error || `BEPUSDT 下单失败: HTTP ${response.status}`,
            { requestMeta, responseStatus: response.status, upstreamResponse: parsed }
        );
    }

    const paymentUrl = normalizeExternalUrl(payloadData.payment_url || payloadData.paymentUrl || parsed.payment_url || parsed.pay_url || parsed.payurl);
    return {
        raw: parsed,
        requestMeta,
        responseStatus: response.status,
        transactionId: normalizeString(payloadData.trade_id || payloadData.tradeId || parsed.trade_id || parsed.tradeId),
        paymentUrl,
        qrCodeUrl: normalizeExternalUrl(payloadData.qrcode || payloadData.qrCode || paymentUrl),
        actualAmount: payloadData.actual_amount || payloadData.actualAmount || parsed.actual_amount || parsed.actualAmount || null,
        tradeType: normalizeString(payloadData.trade_type || payloadData.tradeType || config.tradeType) || config.tradeType
    };
}

async function queryFutongOrderStatus({ config, orderNo }) {
    const endpoint = resolveFutongEndpoint(config.apiUrl, '/api.php');
    const url = new URL(endpoint);
    url.searchParams.set('act', 'order');
    url.searchParams.set('pid', config.pid);
    url.searchParams.set('key', config.secretKey);
    url.searchParams.set('out_trade_no', orderNo);
    const response = await fetch(url.toString(), { method: 'GET' });
    const text = await response.text();
    const parsed = parseJsonSafe(text) || { raw: text };
    const success = response.ok && Number(parsed.code || 0) === 1;
    if (!success) {
        throw createGatewayError(
            buildGatewayFailureMessage('富通订单查询失败', parsed, response.status),
            {
                requestMeta: buildGatewayRequestMeta({ url: url.toString(), method: 'GET' }),
                responseStatus: response.status,
                upstreamResponse: parsed
            }
        );
    }
    return {
        raw: parsed,
        responseStatus: response.status,
        data: parsed
    };
}

async function queryBepusdtOrderStatus({ config, orderNo }) {
    const endpoint = new URL(`/api/v1/order/order-status/${encodeURIComponent(orderNo)}`, config.apiUrl).toString();
    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${config.authToken}`
        }
    });
    const text = await response.text();
    const parsed = parseJsonSafe(text) || { raw: text };
    const success = response.ok && Number(parsed.status_code || parsed.statusCode || parsed.code || 0) === 200;
    if (!success) {
        throw createGatewayError(
            parsed.msg || parsed.message || parsed.error || `BEPUSDT 订单状态查询失败: HTTP ${response.status}`,
            {
                requestMeta: buildGatewayRequestMeta({ url: endpoint, method: 'GET' }),
                responseStatus: response.status,
                upstreamResponse: parsed
            }
        );
    }
    return {
        raw: parsed,
        responseStatus: response.status,
        data: parsed && typeof parsed.data === 'object' && parsed.data ? parsed.data : {}
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
    const optionExtra = getRechargeOptionExtraConfig(config, channel, method);
    const feeMode = normalizeFeeMode(optionExtra.feeMode, 'fixed');
    const feeValue = normalizeFeeValue(optionExtra.feeValue, 0);
    const feeAmount = calculateRechargeFee(safeAmount, feeMode, feeValue);
    const payableAmount = roundMoney(safeAmount + feeAmount);
    const paymentMethod = `${channel}_${method}`;
    const openMode = getChannelPaymentOpenMode(config, channel);
    const baseMetadata = {
        channel,
        method,
        openMode,
        label: createDisplayLabel(channel, method),
        amount: safeAmount,
        creditAmount: safeAmount,
        feeMode,
        feeValue,
        feeAmount,
        payableAmount,
        recommended: optionExtra.recommended === true,
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
            instructions: feeAmount > 0
                ? `请按 ¥${payableAmount.toFixed(2)} 支付（含手续费 ¥${feeAmount.toFixed(2)}），并保存订单号，支付完成后必须点击完成支付按钮，等待确认入账。`
                : '请扫码支付并保存订单号，支付完成后必须点击完成支付按钮，等待确认入账。'
        });
        return serializeUserOrder(orderRow);
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
                amount: payableAmount,
                method,
                notifyUrl: config.notifyUrls.futong,
                returnUrl: config.returnUrls.futong,
                clientIp: getClientIp(req)
            });
            const updated = await updateOrderAfterCreation(orderRow.id, {
                status: 'pending',
                transactionId: upstream.transactionId,
                metadata: {
                    ...baseMetadata,
                    paymentUrl: upstream.paymentUrl,
                    qrCodeUrl: upstream.qrCodeUrl,
                    channelRequest: upstream.requestMeta,
                    channelResponseStatus: upstream.responseStatus,
                    upstream: upstream.raw,
                    instructions: openMode === 'redirect'
                        ? '支付页已生成，请在新窗口完成支付后返回当前页面查看到账状态。'
                        : '请使用二维码完成支付，支付后返回当前页面查看到账状态。'
                }
            });
            return serializeUserOrder(updated || orderRow);
        } catch (error) {
            await updateOrderAfterCreation(orderRow.id, {
                status: 'failed',
                metadata: {
                    ...baseMetadata,
                    error: error.message,
                    channelRequest: error.requestMeta || null,
                    channelResponseStatus: error.responseStatus || null,
                    upstream: error.upstreamResponse || null
                }
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
                amount: payableAmount,
                notifyUrl: config.notifyUrls.bepusdt,
                redirectUrl: config.returnUrls.bepusdt
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
                    channelRequest: upstream.requestMeta,
                    channelResponseStatus: upstream.responseStatus,
                    upstream: upstream.raw,
                    instructions: openMode === 'redirect'
                        ? '已创建虚拟币支付订单，系统将为你打开支付链接；如未自动跳转，请点击“打开支付页”继续支付。'
                        : '请使用二维码完成虚拟币支付，支付后返回当前页面查看到账状态。'
                }
            });
            return serializeUserOrder(updated || orderRow);
        } catch (error) {
            await updateOrderAfterCreation(orderRow.id, {
                status: 'failed',
                metadata: {
                    ...baseMetadata,
                    error: error.message,
                    channelRequest: error.requestMeta || null,
                    channelResponseStatus: error.responseStatus || null,
                    upstream: error.upstreamResponse || null
                }
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
        quickAmounts: config.quickAmounts,
        options: buildRechargeOptions(config)
    };
}

async function getOrderForUser(userId, orderNo) {
    const result = await db.pool.query(
        `SELECT * FROM payment_records WHERE order_no = $1 AND user_id = $2 LIMIT 1`,
        [orderNo, userId]
    );
    return result.rows[0] ? serializeUserOrder(result.rows[0]) : null;
}

async function requestFixedQrManualReview({ userId, orderNo, baseUrl = '' }) {
    const orderRow = await getUserOrderRow(userId, orderNo);
    if (!orderRow) {
        throw new Error('订单不存在');
    }

    const { order, metadata, label } = buildSerializedOrderState(orderRow);
    if (!isManualReviewOrder(order, metadata)) {
        throw new Error('仅固定码订单支持手动确认');
    }
    if (order.status === 'paid') {
        return serializeUserOrder(orderRow);
    }
    if (order.status !== 'pending') {
        throw new Error('当前订单状态不允许提交支付完成');
    }
    if (metadata.manualReviewRequestedAt) {
        return serializeUserOrder(orderRow);
    }

    const config = await getPaymentConfig(baseUrl);
    if (!config.pushplus?.ready) {
        throw createGatewayError('管理员未配置 PushPlus 通知', { publicMessage: '支付确认提交失败，请联系管理员处理' });
    }

    const expiresAt = Date.now() + MOBILE_REVIEW_TOKEN_TTL_MS;
    const token = createMobileReviewToken(order.orderNo, expiresAt);
    const reviewLink = buildMobileReviewLink(baseUrl, token);
    const message = buildPushplusContent({ ...order, label }, reviewLink);

    try {
        const pushResult = await sendPushplusMessage(config, message);
        const updated = await updateOrderAfterCreation(order.id, {
            status: order.status,
            transactionId: order.transactionId || null,
            metadata: mergeMetadata(metadata, {
                instructions: '请等待确认入账，请勿重复提交。',
                manualReviewRequestedAt: new Date().toISOString(),
                manualReviewNotifiedAt: new Date().toISOString(),
                manualReviewLinkExpiresAt: new Date(expiresAt).toISOString(),
                manualReviewNotice: {
                    channel: 'pushplus',
                    sentAt: new Date().toISOString(),
                    responseStatus: pushResult.responseStatus,
                    response: pushResult.raw
                }
            })
        });
        return serializeUserOrder(updated || orderRow);
    } catch (error) {
        await updateOrderAfterCreation(order.id, {
            status: order.status,
            transactionId: order.transactionId || null,
            metadata: mergeMetadata(metadata, {
                manualReviewLastTriedAt: new Date().toISOString(),
                manualReviewLastError: error.message
            })
        });
        throw new Error(error.publicMessage || '支付确认提交失败，请联系管理员处理');
    }
}

async function getManualReviewOrderByToken(token) {
    const payload = verifyMobileReviewToken(token);
    if (!payload) {
        throw new Error('确认链接无效或已过期');
    }

    const orderRow = await getOrderRowByOrderNo(payload.orderNo);
    if (!orderRow) {
        throw new Error('订单不存在');
    }

    const { order, metadata } = buildSerializedOrderState(orderRow);
    if (!isManualReviewOrder(order, metadata)) {
        throw new Error('该订单不支持移动确认');
    }

    return serializeManualReviewOrder(orderRow);
}

async function markManualReviewOrderPaidByToken(token) {
    const payload = verifyMobileReviewToken(token);
    if (!payload) {
        return { success: false, error: '确认链接无效或已过期' };
    }

    const orderRow = await getOrderRowByOrderNo(payload.orderNo);
    if (!orderRow) {
        return { success: false, error: '订单不存在' };
    }

    const { order, metadata } = buildSerializedOrderState(orderRow);
    if (!isManualReviewOrder(order, metadata)) {
        return { success: false, error: '该订单不支持移动确认' };
    }

    const result = await markRechargeOrderPaid({
        orderId: order.id,
        provider: 'pushplus_mobile',
        verifyResult: 'pushplus_mobile_confirmed'
    });
    if (!result.success) return result;

    return {
        success: true,
        alreadyPaid: result.alreadyPaid === true,
        order: await getManualReviewOrderByToken(token)
    };
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
            const callbackAmount = toSafeMoneyAmount(expectedAmount);
            const orderMetadata = normalizeOrderMetadata(order.metadata);
            const payableAmount = Number.isFinite(Number(orderMetadata.payableAmount))
                ? roundMoney(orderMetadata.payableAmount)
                : roundMoney(order.amount || 0);
            if (Number.isFinite(callbackAmount) && callbackAmount !== payableAmount) {
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

        await notificationService.createUserNotification({
            executor: client,
            userId: order.userId,
            type: 'recharge_paid',
            level: 'success',
            title: '充值已到账',
            content: `您的充值订单 ${order.orderNo} 已完成，余额已增加 ¥${Number(order.amount || 0).toFixed(2)}。`,
            relatedOrderNo: order.orderNo,
            actionTab: 'orders'
        });

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
    const normalized = normalizeBepusdtNotifyPayload(payload);
    const signature = extractBepusdtSignature(normalized).toLowerCase();
    if (!signature) return false;
    if (signBepusdt(normalized, signSecret) === signature) return true;
    if (normalized.data && typeof normalized.data === 'object' && signBepusdt(normalized.data, signSecret) === signature) {
        return true;
    }
    return false;
}

function isFutongPaid(payload) {
    const status = normalizeString(payload.trade_status || payload.tradeStatus).toUpperCase();
    return ['TRADE_SUCCESS', 'SUCCESS', 'PAID'].includes(status);
}

function isBepusdtPaid(payload) {
    const normalized = normalizeBepusdtNotifyPayload(payload);
    const status = normalizeString(
        normalized.status || normalized.trade_status || normalized.tradeStatus ||
        normalized.order_status || normalized.orderStatus || normalized.state
    ).toLowerCase();
    if (['paid', 'success', 'succeeded', 'completed', 'confirmed', '2'].includes(status)) {
        return true;
    }
    const code = Number(normalized.status_code || normalized.statusCode || normalized.code || normalized.errCode || 0);
    if (code === 200 && status === '2') return true;
    const hasSuccessMarkers = !!normalizeString(normalized.order_id || normalized.orderId)
        && !!normalizeString(
            normalized.transaction_hash || normalized.transactionHash || normalized.trade_id || normalized.tradeId ||
            normalized.txid || normalized.block_transaction_id || normalized.blockTransactionId
        );
    if ((!status || status === '2') && hasSuccessMarkers) {
        return true;
    }
    return false;
}

async function handleFutongNotify(payload) {
    const config = await getPaymentConfig();
    const orderNo = normalizeString(payload.out_trade_no || payload.outTradeNo || payload.param);
    if (!config.futong.secretKey) {
        return { success: false, error: '富通支付未配置密钥' };
    }
    if (!orderNo) {
        return { success: false, error: '缺少订单号' };
    }

    let verifiedPayload = payload;
    let verifyResult = 'signature_verified';
    if (!verifyFutongNotify(payload, config.futong.secretKey)) {
        try {
            const queried = await queryFutongOrderStatus({ config: config.futong, orderNo });
            verifiedPayload = { ...payload, ...queried.data };
            verifyResult = 'api_order_verified';
        } catch {
            return { success: false, error: '签名验证失败' };
        }
    }
    if (!isFutongPaid(verifiedPayload)) {
        return { success: true, skipped: true, reason: '支付未完成' };
    }
    return markRechargeOrderPaid({
        orderNo,
        transactionId: normalizeString(verifiedPayload.trade_no || verifiedPayload.tradeNo),
        provider: 'futong',
        notifyPayload: verifiedPayload,
        verifyResult,
        expectedAmount: verifiedPayload.money || verifiedPayload.total_fee || verifiedPayload.amount
    });
}

async function handleBepusdtNotify(payload) {
    const config = await getPaymentConfig();
    const normalized = normalizeBepusdtNotifyPayload(payload);
    const orderNo = normalized.order_id || normalized.orderId || normalized.order_no || normalized.orderNo || normalized.out_trade_no || normalized.outTradeNo || normalized.merchant_order_id || normalized.merchantOrderId;
    if (!orderNo) {
        return { success: false, error: '缺少订单号' };
    }

    const signSecret = config.bepusdt.signSecret || config.bepusdt.authToken;
    const signed = hasBepusdtSignature(normalized);
    const successMarkers = normalizeString(
        normalized.transaction_hash || normalized.transactionHash || normalized.txid || normalized.tx_id ||
        normalized.trade_id || normalized.tradeId || normalized.block_transaction_id || normalized.blockTransactionId
    );
    let verifyResult = 'signature_verified';
    let verifiedPayload = normalized;

    if (signed && signSecret && verifyBepusdtNotify(normalized, signSecret)) {
        verifyResult = 'signature_verified';
    } else if (!signed && isBepusdtPaid(normalized) && successMarkers) {
        verifyResult = 'unsigned_notify_paid_markers';
        verifiedPayload = normalized;
    } else if (signed && isBepusdtPaid(normalized) && successMarkers) {
        verifyResult = 'signature_mismatch_but_paid_markers';
        verifiedPayload = normalized;
    } else {
        try {
            const queried = await queryBepusdtOrderStatus({ config: config.bepusdt, orderNo });
            verifiedPayload = normalizeBepusdtNotifyPayload({
                ...normalized,
                ...queried.raw,
                data: queried.data
            });
            verifyResult = signed ? 'api_status_verified_after_signature_mismatch' : 'api_status_verified';
        } catch (error) {
            return { success: false, error: signed ? '签名验证失败，且订单状态复核失败' : '订单状态复核失败' };
        }
    }

    if (!isBepusdtPaid(verifiedPayload)) {
        return { success: true, skipped: true, reason: '支付未完成' };
    }
    return markRechargeOrderPaid({
        orderNo,
        transactionId: normalizeString(
            verifiedPayload.transaction_hash || verifiedPayload.transactionHash || verifiedPayload.txid || verifiedPayload.tx_id ||
            verifiedPayload.trade_id || verifiedPayload.tradeId || verifiedPayload.block_transaction_id || verifiedPayload.blockTransactionId
        ),
        provider: 'bepusdt',
        notifyPayload: verifiedPayload,
        verifyResult,
        expectedAmount: verifiedPayload.order_amount || verifiedPayload.orderAmount || verifiedPayload.cny_amount || verifiedPayload.cnyAmount || null
    });
}

module.exports = {
    getPaymentConfig,
    getAdminPaymentConfig,
    getAdminPushplusConfig,
    savePaymentConfig,
    savePushplusConfig,
    getRechargeOptions,
    createRechargeOrder,
    getOrderForUser,
    requestFixedQrManualReview,
    getManualReviewOrderByToken,
    markManualReviewOrderPaidByToken,
    serializeUserOrder,
    serializeUserOrderListItem,
    markRechargeOrderPaid,
    cancelRechargeOrder,
    handleFutongNotify,
    handleBepusdtNotify,
    getPublicBaseUrl
};
