const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const subscriptionService = require('../services/subscriptionService');
const emailService = require('../services/emailService');
const paymentService = require('../services/paymentService');
const notificationService = require('../services/notificationService');
const { listUserAiWorkJobs, getUserAiWorkJobById } = require('../services/aiWorkService');

const router = express.Router();

/**
 * GET /api/user/profile
 */
router.get('/profile', authenticate, async (req, res) => {
    try {
        const user = await db.get(
            `SELECT id, username, email, nickname, balance, role, status, last_login_at, created_at,
                    ai_credits_monthly, ai_credits_remaining, ai_credits_used
             FROM users WHERE id = ?`,
            [req.user.id]
        );
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const quota = await subscriptionService.getUserQuota(req.user.id);

        res.json({ user, quota });
    } catch (err) {
        console.error('[User] Profile error:', err.message);
        res.status(500).json({ error: '获取用户信息失败' });
    }
});

/**
 * PUT /api/user/profile
 */
router.put('/profile', authenticate, [
    body('nickname').optional().trim().isLength({ min: 1, max: 100 }).withMessage('昵称1-100个字符'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const { nickname, email } = req.body;
        if (email !== undefined) {
            return res.status(400).json({ error: '邮箱请通过验证码流程修改' });
        }

        const updates = [];
        const params = [];
        let paramIdx = 0;

        if (nickname !== undefined) {
            updates.push(`nickname = $${++paramIdx}`);
            params.push(nickname);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: '没有可更新的字段' });
        }

        updates.push(`updated_at = NOW()`);
        params.push(req.user.id);
        await db.pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx + 1}`,
            params
        );

        const user = await db.get(
            'SELECT id, username, email, nickname, balance, role FROM users WHERE id = ?',
            [req.user.id]
        );
        res.json({ user });
    } catch (err) {
        console.error('[User] Update profile error:', err.message);
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * PUT /api/user/email
 */
router.put('/email', authenticate, [
    body('newEmail').isEmail().withMessage('请输入有效的新邮箱地址'),
    body('emailCode').trim().matches(/^\d{6}$/).withMessage('请输入6位邮箱验证码'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    const currentEmail = String(req.user.email || '').trim().toLowerCase();
    if (!currentEmail) {
        return res.status(400).json({ error: '当前账号未绑定邮箱，暂不支持修改邮箱' });
    }

    const newEmail = req.body.newEmail.trim().toLowerCase();
    if (newEmail === currentEmail) {
        return res.status(400).json({ error: '新邮箱不能与当前邮箱相同' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const existing = await client.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2',
            [newEmail, req.user.id]
        );
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: '邮箱已被使用' });
        }

        const verifyResult = await emailService.verifyCode(currentEmail, req.body.emailCode, {
            purpose: 'change_email',
            executor: client,
        });
        if (!verifyResult.ok) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: verifyResult.error });
        }

        const updateResult = await client.query(
            `UPDATE users
             SET email = $1, updated_at = NOW()
             WHERE id = $2
             RETURNING id, username, email, nickname, balance, role`,
            [newEmail, req.user.id]
        );

        await client.query('COMMIT');
        res.json({ user: updateResult.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[User] Change email error:', err.message);
        res.status(500).json({ error: '修改邮箱失败' });
    } finally {
        client.release();
    }
});

/**
 * GET /api/user/subscription
 */
router.get('/subscription', authenticate, async (req, res) => {
    try {
        const quota = await subscriptionService.getUserQuota(req.user.id);
        res.json(quota);
    } catch (err) {
        console.error('[User] Subscription error:', err.message);
        res.status(500).json({ error: '获取订阅信息失败' });
    }
});

/**
 * GET /api/user/rooms
 */
router.get('/rooms', authenticate, async (req, res) => {
    try {
        const rooms = await db.all(
            `SELECT ur.id, ur.room_id, ur.alias, ur.created_at,
                    r.name, r.numeric_room_id, r.is_monitor_enabled, r.language,
                    rs.all_time_gift_value, rs.last_session_time
             FROM user_room ur
             LEFT JOIN room r ON ur.room_id = r.room_id
             LEFT JOIN room_stats rs ON ur.room_id = rs.room_id
             WHERE ur.user_id = ? AND ur.deleted_at IS NULL
             ORDER BY ur.created_at DESC`,
            [req.user.id]
        );
        res.json({ rooms });
    } catch (err) {
        console.error('[User] Rooms error:', err.message);
        res.status(500).json({ error: '获取房间列表失败' });
    }
});

/**
 * GET /api/user/orders
 */
router.get('/orders', authenticate, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const search = (req.query.search || '').trim();

        let whereClause = 'WHERE user_id = ?';
        const params = [req.user.id];

        if (search) {
            whereClause += ' AND order_no ILIKE ?';
            params.push(`%${search}%`);
        }

        const orders = await db.all(
            `SELECT id, order_no, type, item_name, amount, currency, status, created_at, paid_at, metadata
             FROM payment_records ${whereClause}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const countResult = await db.get(
            `SELECT COUNT(*) AS total FROM payment_records ${whereClause}`,
            params
        );

        res.json({
            orders: orders.map(order => paymentService.serializeUserOrderListItem(order)),
            pagination: { page, limit, total: Number(countResult?.total || 0) }
        });
    } catch (err) {
        console.error('[User] Orders error:', err.message);
        res.status(500).json({ error: '获取订单失败' });
    }
});

/**
 * GET /api/user/balance-logs
 */
router.get('/balance-logs', authenticate, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const logs = await db.all(
            `SELECT type, amount, balance_before, balance_after, created_at
             FROM balance_log
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
            [req.user.id, limit, offset]
        );

        const countResult = await db.get(
            'SELECT COUNT(*) AS total FROM balance_log WHERE user_id = ?',
            [req.user.id]
        );

        res.json({
            logs: logs.map(log => ({
                type: log.type,
                amount: Number(log.amount || 0),
                balanceBefore: Number(log.balanceBefore || 0),
                balanceAfter: Number(log.balanceAfter || 0),
                createdAt: log.createdAt,
            })),
            pagination: { page, limit, total: Number(countResult?.total || 0) }
        });
    } catch (err) {
        console.error('[User] Balance logs error:', err.message);
        res.status(500).json({ error: '获取余额记录失败' });
    }
});

/**
 * GET /api/user/notifications
 */
router.get('/notifications', authenticate, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const result = await notificationService.listUserNotifications(req.user.id, { page, limit });
        res.json(result);
    } catch (err) {
        console.error('[User] Notifications error:', err.message);
        res.status(500).json({ error: '获取通知失败' });
    }
});

/**
 * POST /api/user/notifications/read-all
 */
router.post('/notifications/read-all', authenticate, async (req, res) => {
    try {
        const result = await notificationService.markAllUserNotificationsRead(req.user.id);
        res.json({ message: '已全部标记为已读', updated: result.updated, unreadCount: 0 });
    } catch (err) {
        console.error('[User] Mark all notifications read error:', err.message);
        res.status(500).json({ error: '操作失败' });
    }
});

/**
 * POST /api/user/notifications/:id/read
 */
router.post('/notifications/:id/read', authenticate, [
    param('id').isInt({ min: 1 }).withMessage('通知ID无效')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const notification = await notificationService.markUserNotificationRead(req.user.id, Number(req.params.id));
        if (!notification) return res.status(404).json({ error: '通知不存在' });
        res.json({ message: '已标记为已读', notification });
    } catch (err) {
        console.error('[User] Mark notification read error:', err.message);
        res.status(500).json({ error: '操作失败' });
    }
});


/**
 * GET /api/user/ai-work/jobs
 */
router.get('/ai-work/jobs', authenticate, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const status = String(req.query.status || '').trim();
        const jobType = String(req.query.jobType || '').trim();
        const result = await listUserAiWorkJobs(req.user.id, { page, limit, status, jobType });
        res.json(result);
    } catch (err) {
        console.error('[User] AI work jobs error:', err.message);
        res.status(500).json({ error: '获取 AI 工作列表失败' });
    }
});

/**
 * GET /api/user/ai-work/jobs/:id
 */
router.get('/ai-work/jobs/:id', authenticate, [
    param('id').isInt({ min: 1 }).withMessage('任务ID无效')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
        const job = await getUserAiWorkJobById(req.user.id, Number(req.params.id));
        if (!job) return res.status(404).json({ error: '任务不存在' });
        res.json({ job });
    } catch (err) {
        console.error('[User] AI work job detail error:', err.message);
        res.status(500).json({ error: '获取 AI 工作详情失败' });
    }
});

module.exports = router;
