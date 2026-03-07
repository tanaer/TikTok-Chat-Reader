const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const { JWT_SECRET, JWT_EXPIRES_IN, REFRESH_EXPIRES_IN } = require('../middleware/auth');

const SALT_ROUNDS = 10;

function normalizeBooleanSetting(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeSessionVersion(value) {
    const num = Number(value);
    return Number.isInteger(num) && num >= 0 ? num : 0;
}

/**
 * Hash a password
 */
async function hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare password with hash
 */
async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}

/**
 * Generate access token
 */
function generateAccessToken(user) {
    return jwt.sign(
        {
            userId: user.id,
            username: user.username,
            role: user.role,
            sessionVersion: normalizeSessionVersion(user.sessionVersion ?? user.session_version)
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Generate refresh token and store hash in DB
 */
async function generateRefreshToken(userId, options = {}, executor = db.pool) {
    const sessionVersion = normalizeSessionVersion(options.sessionVersion);
    const token = crypto.randomBytes(40).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Parse refresh expiry for DB
    const match = REFRESH_EXPIRES_IN.match(/^(\d+)([dhms])$/);
    let expiresMs = 7 * 24 * 3600 * 1000; // default 7 days
    if (match) {
        const num = parseInt(match[1]);
        const unit = match[2];
        if (unit === 'd') expiresMs = num * 24 * 3600 * 1000;
        else if (unit === 'h') expiresMs = num * 3600 * 1000;
        else if (unit === 'm') expiresMs = num * 60 * 1000;
        else if (unit === 's') expiresMs = num * 1000;
    }

    const expiresAt = new Date(Date.now() + expiresMs);

    await executor.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, session_version, expires_at) VALUES ($1, $2, $3, $4)`,
        [userId, tokenHash, sessionVersion, expiresAt.toISOString()]
    );

    return token;
}

/**
 * Verify refresh token
 * Returns userId if valid, null otherwise
 */
async function verifyRefreshToken(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await db.get(
        `SELECT user_id, session_version FROM refresh_tokens WHERE token_hash = ? AND expires_at > NOW() AND revoked = false`,
        [tokenHash]
    );
    if (!row) {
        return null;
    }

    return {
        userId: row.userId,
        sessionVersion: normalizeSessionVersion(row.sessionVersion)
    };
}

async function isSingleSessionEnabled(executor = db) {
    const row = await executor.get
        ? await executor.get('SELECT value FROM settings WHERE key = ?', ['single_session_login_enabled'])
        : (await executor.query('SELECT value FROM settings WHERE key = $1', ['single_session_login_enabled'])).rows[0] || null;
    return normalizeBooleanSetting(row?.value);
}

/**
 * Revoke a refresh token
 */
async function revokeRefreshToken(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.run(`UPDATE refresh_tokens SET revoked = true WHERE token_hash = ?`, [tokenHash]);
}

/**
 * Revoke all refresh tokens for a user
 */
async function revokeAllUserTokens(userId) {
    await db.run(`UPDATE refresh_tokens SET revoked = true WHERE user_id = ?`, [userId]);
}

/**
 * Clean up expired tokens (call periodically)
 */
async function cleanExpiredTokens() {
    await db.run(`UPDATE refresh_tokens SET revoked = true WHERE revoked = false AND expires_at < NOW()`);
}

module.exports = {
    hashPassword,
    comparePassword,
    generateAccessToken,
    generateRefreshToken,
    verifyRefreshToken,
    revokeRefreshToken,
    revokeAllUserTokens,
    cleanExpiredTokens,
    isSingleSessionEnabled,
    normalizeSessionVersion
};
