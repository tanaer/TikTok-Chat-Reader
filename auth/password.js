/**
 * Password utilities - hashing and verification
 */
const crypto = require('crypto');

// Use native crypto for password hashing (no external dependency)
const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const ITERATIONS = 100000;
const DIGEST = 'sha512';

/**
 * Hash a password using PBKDF2
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Hashed password in format: salt:hash
 */
async function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
        crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, DIGEST, (err, derivedKey) => {
            if (err) reject(err);
            resolve(`${salt}:${derivedKey.toString('hex')}`);
        });
    });
}

/**
 * Verify a password against a hash
 * @param {string} password - Plain text password to verify
 * @param {string} storedHash - Stored hash in format: salt:hash
 * @returns {Promise<boolean>} - True if password matches
 */
async function verifyPassword(password, storedHash) {
    return new Promise((resolve, reject) => {
        const [salt, hash] = storedHash.split(':');
        if (!salt || !hash) {
            return resolve(false);
        }
        crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, DIGEST, (err, derivedKey) => {
            if (err) reject(err);
            resolve(derivedKey.toString('hex') === hash);
        });
    });
}

/**
 * Generate a random token (for password reset, email verification, etc.)
 * @param {number} length - Token length in bytes (default 32)
 * @returns {string} - Random hex token
 */
function generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
}

/**
 * Hash a token for storage (one-way hash)
 * @param {string} token - Plain token
 * @returns {string} - SHA256 hash of token
 */
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
    hashPassword,
    verifyPassword,
    generateToken,
    hashToken
};
