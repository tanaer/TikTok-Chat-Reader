/**
 * User Room API Routes
 * Multi-tenant room management - users can only see their own rooms
 */
const express = require('express');
const router = express.Router();
const { manager } = require('../manager');
const { requireAuth, loadSubscription, checkRoomLimit } = require('../auth/middleware');

// All routes require authentication
router.use(requireAuth);
router.use(loadSubscription);

/**
 * GET /api/user/rooms/stats
 * Get current user's rooms with statistics (for room list display)
 */
router.get('/rooms/stats', async (req, res) => {
    try {
        const { page = 1, limit = 50, search = '', sort = 'default' } = req.query;

        // Note: Live status is not tracked per-user; users see aggregated stats
        // The isLive field will be set based on the full room status
        const result = await manager.getUserRoomStats(req.user.id, [], {
            page: parseInt(page),
            limit: parseInt(limit),
            search,
            sort
        });
        res.json(result);
    } catch (err) {
        console.error('[UserRooms] Error getting room stats:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/user/rooms
 * Get current user's rooms (with subscription info)
 */
router.get('/rooms', async (req, res) => {
    try {
        const { page = 1, limit = 50, search = '' } = req.query;
        const result = await manager.getUserRooms(req.user.id, {
            page: parseInt(page),
            limit: parseInt(limit),
            search
        });
        res.json(result);
    } catch (err) {
        console.error('[UserRooms] Error getting rooms:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/user/rooms
 * Subscribe to a new room
 */
router.post('/rooms', checkRoomLimit, async (req, res) => {
    try {
        const { roomId, alias } = req.body;

        if (!roomId || !roomId.trim()) {
            return res.status(400).json({ error: '请输入房间ID (TikTok用户名)' });
        }

        const cleanRoomId = roomId.trim().toLowerCase();

        // Check if already subscribed
        const hasAccess = await manager.userHasRoomAccess(req.user.id, cleanRoomId);
        if (hasAccess) {
            return res.status(400).json({ error: '您已添加过此房间' });
        }

        const result = await manager.subscribeUserToRoom(req.user.id, cleanRoomId, alias);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('[UserRooms] Error adding room:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/user/rooms/:roomId
 * Get details of a specific room (must be subscribed)
 */
router.get('/rooms/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;

        // Check access
        const hasAccess = await manager.userHasRoomAccess(req.user.id, roomId);
        if (!hasAccess) {
            return res.status(403).json({ error: '您没有权限访问此房间' });
        }

        // Get room details with user subscription info
        const rooms = await manager.getUserRooms(req.user.id, { search: roomId, limit: 1 });
        if (rooms.data.length === 0) {
            return res.status(404).json({ error: '房间不存在' });
        }

        res.json(rooms.data[0]);
    } catch (err) {
        console.error('[UserRooms] Error getting room:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/user/rooms/:roomId
 * Update room subscription settings (alias, enabled, etc.)
 */
router.put('/rooms/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;
        const { alias, isEnabled, notes } = req.body;

        // Check access
        const hasAccess = await manager.userHasRoomAccess(req.user.id, roomId);
        if (!hasAccess) {
            return res.status(403).json({ error: '您没有权限访问此房间' });
        }

        await manager.updateUserRoom(req.user.id, roomId, { alias, isEnabled, notes });
        res.json({ success: true });
    } catch (err) {
        console.error('[UserRooms] Error updating room:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/user/rooms/:roomId
 * Unsubscribe from a room
 */
router.delete('/rooms/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;

        // Check access
        const hasAccess = await manager.userHasRoomAccess(req.user.id, roomId);
        if (!hasAccess) {
            return res.status(403).json({ error: '您没有权限访问此房间' });
        }

        await manager.unsubscribeUserFromRoom(req.user.id, roomId);
        res.json({ success: true, message: '房间已移除' });
    } catch (err) {
        console.error('[UserRooms] Error removing room:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/user/rooms/:roomId/stats
 * Get room statistics (only for subscribed rooms)
 */
router.get('/rooms/:roomId/stats', async (req, res) => {
    try {
        const { roomId } = req.params;

        // Check access
        const hasAccess = await manager.userHasRoomAccess(req.user.id, roomId);
        if (!hasAccess) {
            return res.status(403).json({ error: '您没有权限访问此房间' });
        }

        // Get room stats (existing function)
        const stats = await manager.getRoomStats(roomId);
        res.json(stats);
    } catch (err) {
        console.error('[UserRooms] Error getting room stats:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/user/rooms/:roomId/sessions
 * Get sessions for a room (only for subscribed rooms)
 */
router.get('/rooms/:roomId/sessions', async (req, res) => {
    try {
        const { roomId } = req.params;

        // Check access
        const hasAccess = await manager.userHasRoomAccess(req.user.id, roomId);
        if (!hasAccess) {
            return res.status(403).json({ error: '您没有权限访问此房间' });
        }

        const sessions = await manager.getSessions(roomId);
        res.json(sessions);
    } catch (err) {
        console.error('[UserRooms] Error getting sessions:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
