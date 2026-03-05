const db = require('../db');

/**
 * Check user's room quota before allowing room addition
 */
async function checkRoomQuota(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: '需要登录' });
    }

    // Admin bypasses quota
    if (req.user.role === 'admin') {
        req.quota = { limit: -1, used: 0, remaining: -1 };
        return next();
    }

    try {
        const userId = req.user.id;

        // Get active subscription room limit (JOIN with subscription_plans for room_limit)
        const sub = await db.get(
            `SELECT sp.room_limit FROM user_subscriptions us
             JOIN subscription_plans sp ON us.plan_id = sp.id
             WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
             ORDER BY us.end_date DESC LIMIT 1`,
            [userId]
        );
        const subLimit = sub ? Number(sub.roomLimit) : 0;

        // Get total addon rooms (JOIN with room_addon_packages for room_count)
        const addonResult = await db.get(
            `SELECT COALESCE(SUM(rap.room_count), 0) AS total
             FROM user_room_addons ura
             JOIN room_addon_packages rap ON ura.package_id = rap.id
             WHERE ura.user_id = ? AND ura.status = 'active' AND ura.end_date > NOW()`,
            [userId]
        );
        const addonRooms = Number(addonResult?.total || 0);

        // Get system default room limit
        const settings = await db.getSystemSettings();
        const defaultLimit = Number(settings.default_room_limit || 0);

        const totalLimit = subLimit + addonRooms + defaultLimit;

        // Count current rooms
        const countResult = await db.get(
            `SELECT COUNT(*) AS count FROM user_room WHERE user_id = ?`,
            [userId]
        );
        const currentCount = Number(countResult?.count || 0);

        req.quota = {
            limit: totalLimit,
            used: currentCount,
            remaining: totalLimit - currentCount
        };

        next();
    } catch (err) {
        console.error('[Quota] Error checking quota:', err.message);
        res.status(500).json({ error: '配额检查失败' });
    }
}

module.exports = { checkRoomQuota };
