const express = require('express');
const authRoutes = require('./auth');
const userRoutes = require('./user');
const subscriptionRoutes = require('./subscription');
const landingRoutes = require('./landing');
const roomsRoutes = require('./rooms');
const adminRoutes = require('./admin');
const paymentRoutes = require('./payment');
const paymentAdminRoutes = require('./paymentAdmin');
const subscriptionService = require('../services/subscriptionService');
const authService = require('../services/authService');

const router = express.Router();

// Auth routes (public)
router.use('/api/auth', authRoutes);

// User center routes (authenticated)
router.use('/api/user', userRoutes);

// Subscription routes (mixed public/authenticated)
router.use('/api/subscription', subscriptionRoutes);

// Landing routes (public)
router.use('/api/landing', landingRoutes);

// Payment routes (recharge + callbacks)
router.use('/api/payment', paymentRoutes);

// User room management (authenticated)
router.use('/api/user/rooms', roomsRoutes);

// Admin payment routes
router.use('/api/admin/payment', paymentAdminRoutes);

// Admin routes (admin only)
router.use('/api/admin', adminRoutes);

/**
 * Start periodic tasks
 */
function startPeriodicTasks() {
    // Expire overdue subscriptions every hour
    setInterval(async () => {
        try {
            await subscriptionService.expireOverdueSubscriptions();
        } catch (err) {
            console.error('[Cron] Expire subscriptions error:', err.message);
        }
    }, 60 * 60 * 1000);

    // Clean expired refresh tokens every 6 hours
    setInterval(async () => {
        try {
            await authService.cleanExpiredTokens();
        } catch (err) {
            console.error('[Cron] Clean tokens error:', err.message);
        }
    }, 6 * 60 * 60 * 1000);

    // Run initial cleanup
    setTimeout(async () => {
        try {
            await subscriptionService.expireOverdueSubscriptions();
            await authService.cleanExpiredTokens();
        } catch (err) {
            console.error('[Cron] Initial cleanup error:', err.message);
        }
    }, 5000);
}

module.exports = { router, startPeriodicTasks };
