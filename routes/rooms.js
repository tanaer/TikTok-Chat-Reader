const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { checkRoomQuota } = require('../middleware/quota');

const router = express.Router();

/**
 * POST /api/user/rooms - Add a room (with quota check and sharing)
 */
router.post('/', authenticate, checkRoomQuota, [
    body('roomId').trim().notEmpty().withMessage('请输入房间ID'),
    body('alias').optional().trim().isLength({ max: 100 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { roomId, alias } = req.body;
        const userId = req.user.id;

        // Check quota (admin bypasses)
        if (req.quota.limit !== -1 && req.quota.remaining <= 0) {
            return res.status(403).json({
                error: '房间配额已满',
                quota: req.quota
            });
        }

        // Check if user already has this room
        const existing = await db.get(
            'SELECT id FROM user_room WHERE user_id = ? AND room_id = ?',
            [userId, roomId]
        );
        if (existing) {
            return res.status(409).json({ error: '您已添加过该房间' });
        }

        // Ensure room exists in global room table (reuse if exists)
        const room = await db.get('SELECT room_id FROM room WHERE room_id = ?', [roomId]);
        if (!room) {
            await db.run(
                'INSERT INTO room (room_id, name, is_monitor_enabled) VALUES (?, ?, 1)',
                [roomId, roomId]
            );
        } else {
            // Ensure monitoring is enabled
            await db.run(
                'UPDATE room SET is_monitor_enabled = 1 WHERE room_id = ? AND is_monitor_enabled = 0',
                [roomId]
            );
        }

        // Create user-room association
        await db.run(
            'INSERT INTO user_room (user_id, room_id, alias) VALUES (?, ?, ?)',
            [userId, roomId, alias || null]
        );

        res.status(201).json({
            message: '房间添加成功',
            roomId,
            quota: {
                limit: req.quota.limit,
                used: req.quota.used + 1,
                remaining: req.quota.limit === -1 ? -1 : req.quota.remaining - 1
            }
        });
    } catch (err) {
        console.error('[Rooms] Add room error:', err.message);
        res.status(500).json({ error: '添加房间失败' });
    }
});

/**
 * DELETE /api/user/rooms/:roomId - Remove a room association
 */
router.delete('/:roomId', authenticate, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const userId = req.user.id;

        // Check if association exists
        const assoc = await db.get(
            'SELECT id FROM user_room WHERE user_id = ? AND room_id = ?',
            [userId, roomId]
        );
        if (!assoc) {
            return res.status(404).json({ error: '房间关联不存在' });
        }

        // Remove association
        await db.run(
            'DELETE FROM user_room WHERE user_id = ? AND room_id = ?',
            [userId, roomId]
        );

        // Check if any other users still have this room
        const otherUsers = await db.get(
            'SELECT COUNT(*) AS count FROM user_room WHERE room_id = ?',
            [roomId]
        );

        // If no other users, disable monitoring and record the disable timestamp
        if (Number(otherUsers?.count || 0) === 0) {
            await db.run(
                'UPDATE room SET is_monitor_enabled = 0, updated_at = NOW() WHERE room_id = ?',
                [roomId]
            );
        }

        res.json({ message: '房间已移除，数据将保留7天' });
    } catch (err) {
        console.error('[Rooms] Remove room error:', err.message);
        res.status(500).json({ error: '移除房间失败' });
    }
});

module.exports = router;
