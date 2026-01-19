/**
 * JWT Token utilities
 * Simple JWT implementation using native crypto
 */
const crypto = require('crypto');

// JWT secret from environment or generate a random one
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ACCESS_TOKEN_EXPIRY = 15 * 60; // 15 minutes in seconds
const REFRESH_TOKEN_EXPIRY = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Base64URL encode
 */
function base64UrlEncode(str) {
    return Buffer.from(str)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/**
 * Base64URL decode
 */
function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString();
}

/**
 * Create HMAC signature
 */
function createSignature(data, secret) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Generate an access token
 * @param {object} payload - Token payload (user data)
 * @returns {string} - JWT token
 */
function generateAccessToken(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);

    const tokenPayload = {
        ...payload,
        iat: now,
        exp: now + ACCESS_TOKEN_EXPIRY
    };

    const headerEncoded = base64UrlEncode(JSON.stringify(header));
    const payloadEncoded = base64UrlEncode(JSON.stringify(tokenPayload));
    const signature = createSignature(`${headerEncoded}.${payloadEncoded}`, JWT_SECRET);

    return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

/**
 * Generate a refresh token
 * @param {object} payload - Minimal payload (just user id)
 * @returns {string} - JWT refresh token
 */
function generateRefreshToken(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);

    const tokenPayload = {
        sub: payload.userId,
        type: 'refresh',
        iat: now,
        exp: now + REFRESH_TOKEN_EXPIRY
    };

    const headerEncoded = base64UrlEncode(JSON.stringify(header));
    const payloadEncoded = base64UrlEncode(JSON.stringify(tokenPayload));
    const signature = createSignature(`${headerEncoded}.${payloadEncoded}`, JWT_SECRET);

    return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

/**
 * Verify and decode a token
 * @param {string} token - JWT token to verify
 * @returns {object|null} - Decoded payload or null if invalid
 */
function verifyToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const [headerEncoded, payloadEncoded, signature] = parts;

        // Verify signature
        const expectedSignature = createSignature(`${headerEncoded}.${payloadEncoded}`, JWT_SECRET);
        if (signature !== expectedSignature) return null;

        // Decode payload
        const payload = JSON.parse(base64UrlDecode(payloadEncoded));

        // Check expiration
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) return null;

        return payload;
    } catch (err) {
        return null;
    }
}

/**
 * Extract token from Authorization header
 * @param {string} authHeader - Authorization header value
 * @returns {string|null} - Token or null
 */
function extractToken(authHeader) {
    if (!authHeader) return null;
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
    return parts[1];
}

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    verifyToken,
    extractToken,
    ACCESS_TOKEN_EXPIRY,
    REFRESH_TOKEN_EXPIRY
};
