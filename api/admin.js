/**
 * Admin API Routes
 * System administration - only accessible by admin users
 */
const express = require('express');
const router = express.Router();
const { manager } = require('../manager');
const { requireAuth, requireAdmin } = require('../auth/middleware');

// All routes require admin role
router.use(requireAuth);
router.use(requireAdmin);

/**
 * GET /api/admin/rooms
 * Get all rooms in the system (admin view)
 */
router.get('/rooms', async (req, res) => {
    try {
        const { page = 1, limit = 50, search = '' } = req.query;
        const result = await manager.getRooms({
            page: parseInt(page),
            limit: parseInt(limit),
            search
        });
        res.json(result);
    } catch (err) {
        console.error('[Admin] Error getting rooms:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/users
 * Get all users
 */
router.get('/users', async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const users = await manager.query(`
            SELECT u.id, u.email, u.nickname, u.role, u.status, u.created_at,
                   (SELECT COUNT(*) FROM user_room WHERE user_id = u.id) as room_count,
                   sp.name as plan_name, us.end_date as subscription_end
            FROM users u
            LEFT JOIN user_subscriptions us ON u.id = us.user_id AND us.status = 'active'
            LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
            ORDER BY u.created_at DESC
            LIMIT ? OFFSET ?
        `, [parseInt(limit), offset]);

        const countResult = await manager.get('SELECT COUNT(*) as total FROM users');

        res.json({
            data: users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult?.total || 0,
                totalPages: Math.ceil((countResult?.total || 0) / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('[Admin] Error getting users:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/admin/users/:id
 * Update user (role, status, etc.)
 */
router.put('/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { role, status } = req.body;

        const updates = [];
        const params = [];

        if (role) {
            updates.push('role = ?');
            params.push(role);
        }
        if (status) {
            updates.push('status = ?');
            params.push(status);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: '没有要更新的字段' });
        }

        params.push(id);
        await manager.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error updating user:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/stats
 * Get system statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const [
            userCount,
            roomCount,
            activeRooms,
            eventCount
        ] = await Promise.all([
            manager.get('SELECT COUNT(*) as cnt FROM users'),
            manager.get('SELECT COUNT(*) as cnt FROM room'),
            manager.get('SELECT COUNT(DISTINCT room_id) as cnt FROM user_room WHERE is_enabled = TRUE'),
            manager.get('SELECT COUNT(*) as cnt FROM event WHERE timestamp > NOW() - INTERVAL \'24 hours\'')
        ]);

        res.json({
            totalUsers: userCount?.cnt || 0,
            totalRooms: roomCount?.cnt || 0,
            activeRooms: activeRooms?.cnt || 0,
            eventsLast24h: eventCount?.cnt || 0
        });
    } catch (err) {
        console.error('[Admin] Error getting stats:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/admin/settings
 * Get all system settings
 */
router.get('/settings', async (req, res) => {
    try {
        const settings = await manager.getAllSettings();
        res.json(settings);
    } catch (err) {
        console.error('[Admin] Error getting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/admin/settings
 * Update system settings
 */
router.post('/settings', async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Admin] Error saving settings:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
