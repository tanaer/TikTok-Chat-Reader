/**
 * Stripe Payment Integration
 * Uses Stripe Checkout for subscription payments
 */

// Note: Stripe SDK should be installed: npm install stripe
// For now, we'll use fetch to call the API directly

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * Get Stripe configuration
 */
const getConfig = async () => {
    try {
        const db = require('../db');
        const settings = await db.query(`SELECT key, value FROM settings WHERE key IN ('stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret')`);
        const config = {};
        settings.forEach(s => { config[s.key] = s.value; });
        return {
            secretKey: config.stripe_secret_key || process.env.STRIPE_SECRET_KEY,
            publishableKey: config.stripe_publishable_key || process.env.STRIPE_PUBLISHABLE_KEY,
            webhookSecret: config.stripe_webhook_secret || process.env.STRIPE_WEBHOOK_SECRET,
            successUrl: process.env.STRIPE_SUCCESS_URL || 'http://localhost:8081/landing/payment-success.html',
            cancelUrl: process.env.STRIPE_CANCEL_URL || 'http://localhost:8081/landing/pricing.html'
        };
    } catch (err) {
        return {
            secretKey: process.env.STRIPE_SECRET_KEY,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
            successUrl: process.env.STRIPE_SUCCESS_URL || 'http://localhost:8081/landing/payment-success.html',
            cancelUrl: process.env.STRIPE_CANCEL_URL || 'http://localhost:8081/landing/pricing.html'
        };
    }
};

/**
 * Make authenticated Stripe API request
 */
async function stripeRequest(endpoint, method = 'GET', body = null) {
    const config = await getConfig();

    if (!config.secretKey) {
        throw new Error('Stripe secret key not configured');
    }

    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${config.secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    };

    if (body) {
        options.body = new URLSearchParams(body).toString();
    }

    const response = await fetch(`${STRIPE_API_BASE}${endpoint}`, options);
    const data = await response.json();

    if (data.error) {
        throw new Error(data.error.message);
    }

    return data;
}

/**
 * Create Stripe Checkout Session for subscription
 * @param {object} options
 * @param {string} options.orderNo - Internal order number
 * @param {string} options.planName - Plan display name
 * @param {number} options.amount - Amount in cents
 * @param {string} options.currency - Currency code (usd, cny)
 * @param {string} options.customerEmail - Customer email
 * @param {object} options.metadata - Additional metadata
 */
async function createCheckoutSession(options) {
    const config = await getConfig();

    const params = {
        'mode': 'payment',
        'success_url': `${config.successUrl}?session_id={CHECKOUT_SESSION_ID}&order_no=${options.orderNo}`,
        'cancel_url': config.cancelUrl,
        'line_items[0][price_data][currency]': options.currency || 'cny',
        'line_items[0][price_data][product_data][name]': options.planName,
        'line_items[0][price_data][unit_amount]': options.amount,
        'line_items[0][quantity]': 1,
        'metadata[order_no]': options.orderNo,
        'metadata[user_id]': options.userId || '',
        'metadata[plan_code]': options.planCode || '',
        'metadata[billing_cycle]': options.billingCycle || ''
    };

    if (options.customerEmail) {
        params['customer_email'] = options.customerEmail;
    }

    const session = await stripeRequest('/checkout/sessions', 'POST', params);

    return {
        sessionId: session.id,
        url: session.url,
        orderNo: options.orderNo
    };
}

/**
 * Retrieve Checkout Session
 */
async function getCheckoutSession(sessionId) {
    const session = await stripeRequest(`/checkout/sessions/${sessionId}`);
    return {
        id: session.id,
        status: session.status,
        paymentStatus: session.payment_status,
        customerEmail: session.customer_email,
        amountTotal: session.amount_total,
        currency: session.currency,
        metadata: session.metadata
    };
}

/**
 * Verify webhook signature
 * @param {Buffer} payload - Raw request body
 * @param {string} signature - Stripe-Signature header
 */
async function verifyWebhookSignature(payload, signature) {
    const config = await getConfig();
    const crypto = require('crypto');

    if (!config.webhookSecret) {
        console.warn('[Stripe] Webhook secret not configured, skipping signature verification');
        return true;
    }

    try {
        const elements = signature.split(',');
        const sigData = {};
        elements.forEach(el => {
            const [key, value] = el.split('=');
            sigData[key] = value;
        });

        const timestamp = sigData['t'];
        const signatures = elements.filter(el => el.startsWith('v1=')).map(el => el.split('=')[1]);

        // Create expected signature
        const signedPayload = `${timestamp}.${payload}`;
        const expectedSignature = crypto
            .createHmac('sha256', config.webhookSecret)
            .update(signedPayload, 'utf8')
            .digest('hex');

        // Check if any signature matches
        return signatures.some(sig => sig === expectedSignature);
    } catch (err) {
        console.error('[Stripe] Webhook signature verification failed:', err);
        return false;
    }
}

/**
 * Parse and handle webhook event
 */
async function handleWebhook(payload, signature) {
    // Verify signature
    const isValid = await verifyWebhookSignature(payload, signature);
    if (!isValid) {
        return { valid: false, error: 'Invalid webhook signature' };
    }

    const event = JSON.parse(payload);

    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            return {
                valid: true,
                type: 'checkout_completed',
                sessionId: session.id,
                paymentStatus: session.payment_status,
                orderNo: session.metadata?.order_no,
                userId: session.metadata?.user_id,
                planCode: session.metadata?.plan_code,
                billingCycle: session.metadata?.billing_cycle,
                amountTotal: session.amount_total,
                customerEmail: session.customer_email
            };

        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            return {
                valid: true,
                type: 'payment_succeeded',
                paymentIntentId: paymentIntent.id,
                amount: paymentIntent.amount,
                metadata: paymentIntent.metadata
            };

        default:
            return {
                valid: true,
                type: 'unhandled',
                eventType: event.type
            };
    }
}

/**
 * Get Stripe publishable key for frontend
 */
async function getPublishableKey() {
    const config = await getConfig();
    return config.publishableKey;
}

module.exports = {
    createCheckoutSession,
    getCheckoutSession,
    verifyWebhookSignature,
    handleWebhook,
    getPublishableKey
};
