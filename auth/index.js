/**
 * Authentication Module Index
 * Exports all auth-related modules
 */

const { requireAuth, optionalAuth, loadSubscription, requireFeature, checkRoomLimit } = require('./middleware');
const { hashPassword, verifyPassword, generateToken, hashToken } = require('./password');
const { generateAccessToken, generateRefreshToken, verifyToken, extractToken } = require('./jwt');
const authRoutes = require('./routes');

module.exports = {
    // Middleware
    requireAuth,
    optionalAuth,
    loadSubscription,
    requireFeature,
    checkRoomLimit,

    // Password utilities
    hashPassword,
    verifyPassword,
    generateToken,
    hashToken,

    // JWT utilities
    generateAccessToken,
    generateRefreshToken,
    verifyToken,
    extractToken,

    // Routes
    authRoutes
};
