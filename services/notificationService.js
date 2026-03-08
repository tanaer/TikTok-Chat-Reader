const db = require('../db');

function normalizeNotificationLevel(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (['success', 'warning', 'error', 'info'].includes(raw)) return raw;
    return 'info';
}

function normalizeNotificationType(value) {
    const raw = String(value || '').trim().toLowerCase();
    return raw || 'system';
}

function normalizeNotificationActionTab(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (['overview', 'orders', 'balance', 'subscription', 'settings', 'notifications', 'ai_work'].includes(raw)) return raw;
    return 'notifications';
}

function normalizeNotificationActionUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (!raw.startsWith('/')) return '';
    if (raw.startsWith('//')) return '';
    if (/^\/?javascript:/i.test(raw)) return '';
    return raw.slice(0, 500);
}

function serializeUserNotification(row) {
    const item = db.toCamelCase(row || {});
    return {
        id: Number(item.id || 0),
        type: normalizeNotificationType(item.type),
        level: normalizeNotificationLevel(item.level),
        title: String(item.title || ''),
        content: String(item.content || ''),
        relatedOrderNo: String(item.relatedOrderNo || ''),
        actionTab: normalizeNotificationActionTab(item.actionTab),
        actionUrl: normalizeNotificationActionUrl(item.actionUrl),
        isRead: item.isRead === true,
        createdAt: item.createdAt || '',
        readAt: item.readAt || ''
    };
}

async function createUserNotification({ executor = db.pool, userId, type = 'system', level = 'info', title, content = '', relatedOrderNo = '', actionTab = 'notifications', actionUrl = '' }) {
    const safeUserId = Number(userId || 0);
    if (!safeUserId) throw new Error('缺少通知用户');
    const safeTitle = String(title || '').trim();
    if (!safeTitle) throw new Error('缺少通知标题');

    const result = await executor.query(
        `INSERT INTO user_notifications (user_id, type, level, title, content, related_order_no, action_tab, action_url, is_read, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, NOW())
         RETURNING id, type, level, title, content, related_order_no, action_tab, action_url, is_read, created_at, read_at`,
        [
            safeUserId,
            normalizeNotificationType(type),
            normalizeNotificationLevel(level),
            safeTitle,
            String(content || '').trim(),
            String(relatedOrderNo || '').trim(),
            normalizeNotificationActionTab(actionTab),
            normalizeNotificationActionUrl(actionUrl)
        ]
    );

    return serializeUserNotification(result.rows[0]);
}

async function listUserNotifications(userId, { page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (safePage - 1) * safeLimit;

    const [rowsResult, countResult, unreadResult] = await Promise.all([
        db.pool.query(
            `SELECT id, type, level, title, content, related_order_no, action_tab, action_url, is_read, created_at, read_at
             FROM user_notifications
             WHERE user_id = $1
             ORDER BY is_read ASC, created_at DESC, id DESC
             LIMIT $2 OFFSET $3`,
            [userId, safeLimit, offset]
        ),
        db.pool.query('SELECT COUNT(*) AS total FROM user_notifications WHERE user_id = $1', [userId]),
        db.pool.query('SELECT COUNT(*) AS total FROM user_notifications WHERE user_id = $1 AND is_read = FALSE', [userId])
    ]);

    return {
        notifications: rowsResult.rows.map(serializeUserNotification),
        unreadCount: Number(unreadResult.rows[0]?.total || 0),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total: Number(countResult.rows[0]?.total || 0)
        }
    };
}

async function markUserNotificationRead(userId, notificationId) {
    const result = await db.pool.query(
        `UPDATE user_notifications
         SET is_read = TRUE,
             read_at = COALESCE(read_at, NOW())
         WHERE id = $1 AND user_id = $2
         RETURNING id, type, level, title, content, related_order_no, action_tab, action_url, is_read, created_at, read_at`,
        [notificationId, userId]
    );

    return result.rows[0] ? serializeUserNotification(result.rows[0]) : null;
}

async function markAllUserNotificationsRead(userId) {
    const result = await db.pool.query(
        `UPDATE user_notifications
         SET is_read = TRUE,
             read_at = COALESCE(read_at, NOW())
         WHERE user_id = $1 AND is_read = FALSE`,
        [userId]
    );

    return { updated: Number(result.rowCount || 0) };
}

module.exports = {
    createUserNotification,
    listUserNotifications,
    markUserNotificationRead,
    markAllUserNotificationsRead,
    serializeUserNotification
};
