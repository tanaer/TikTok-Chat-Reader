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
            'SELECT id FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NULL',
            [userId, roomId]
        );
        if (existing) {
            return res.status(409).json({ error: '您已添加过该房间' });
        }

        const deletedAssoc = await db.get(
            'SELECT id FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1',
            [userId, roomId]
        );

        // Ensure room exists in global room table (reuse if exists)
        const room = await db.get('SELECT room_id, owner_user_id, is_admin_room FROM room WHERE room_id = ?', [roomId]);
        if (!room) {
            await db.run(
                'INSERT INTO room (room_id, name, is_monitor_enabled, owner_user_id, is_admin_room) VALUES (?, ?, 1, ?, ?)',
                [roomId, roomId, req.user.role === 'admin' ? null : userId, req.user.role === 'admin' ? 1 : 0]
            );
        } else {
            await db.run(
                'UPDATE room SET is_monitor_enabled = 1 WHERE room_id = ? AND is_monitor_enabled = 0',
                [roomId]
            );
        }

        // Create or restore user-room association
        if (deletedAssoc) {
            await db.run(
                'UPDATE user_room SET alias = ?, deleted_at = NULL, is_enabled = true, updated_at = NOW() WHERE id = ?',
                [alias || null, deletedAssoc.id]
            );
        } else {
            await db.run(
                'INSERT INTO user_room (user_id, room_id, alias) VALUES (?, ?, ?)',
                [userId, roomId, alias || null]
            );
        }

        const autoRecorder = req.app?.locals?.autoRecorder;
        if (autoRecorder?.requestImmediateCheck) {
            autoRecorder.requestImmediateCheck({
                roomId,
                name: alias || roomId,
                isMonitorEnabled: 1,
            }, deletedAssoc ? 'user-room-restore' : 'user-room-create');
        }

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
        res.status(500).json({ error: '添加直播间失败' });
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
            'SELECT id FROM user_room WHERE user_id = ? AND room_id = ? AND deleted_at IS NULL',
            [userId, roomId]
        );
        if (!assoc) {
            return res.status(404).json({ error: '房间关联不存在' });
        }

        // Soft delete association
        await db.run(
            'UPDATE user_room SET deleted_at = NOW(), is_enabled = false, updated_at = NOW() WHERE id = ?',
            [assoc.id]
        );

        const otherUsers = await db.get(
            'SELECT COUNT(*) AS count FROM user_room WHERE room_id = ? AND deleted_at IS NULL',
            [roomId]
        );

        const roomRecord = await db.get(
            `SELECT r.room_id, r.owner_user_id, r.is_admin_room, u.role AS owner_role
             FROM room r
             LEFT JOIN users u ON u.id = r.owner_user_id
             WHERE r.room_id = ?
             LIMIT 1`,
            [roomId]
        );

        let shouldDisableMonitoring = false;
        if (Number(otherUsers?.count || 0) === 0) {
            if (Number(roomRecord?.isAdminRoom || 0) === 1) {
                shouldDisableMonitoring = false;
            } else if (roomRecord?.ownerUserId) {
                shouldDisableMonitoring = roomRecord.ownerRole !== 'admin';
            } else {
                const creatorAssoc = await db.get(
                    `SELECT ur.user_id, u.role
                     FROM user_room ur
                     LEFT JOIN users u ON u.id = ur.user_id
                     WHERE ur.room_id = ?
                     ORDER BY COALESCE(ur.first_added_at, ur.created_at) ASC, ur.id ASC
                     LIMIT 1`,
                    [roomId]
                );
                const isAdminCreatedRoom = !!creatorAssoc && creatorAssoc.role === 'admin';
                shouldDisableMonitoring = !!creatorAssoc && creatorAssoc.role !== 'admin';

                if (isAdminCreatedRoom) {
                    await db.run(
                        'UPDATE room SET is_admin_room = 1, updated_at = NOW() WHERE room_id = ? AND COALESCE(is_admin_room, 0) = 0',
                        [roomId]
                    );
                } else if (shouldDisableMonitoring && creatorAssoc?.userId) {
                    await db.run(
                        'UPDATE room SET owner_user_id = ?, updated_at = NOW() WHERE room_id = ? AND owner_user_id IS NULL',
                        [creatorAssoc.userId, roomId]
                    );
                }
            }
        }

        if (shouldDisableMonitoring) {
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
