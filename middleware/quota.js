const db = require('../db');

/**
 * Check user's room quota before allowing room addition
 * room_limit = -1 means unlimited
 */
async function checkRoomQuota(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: '需要登录' });
    }

    // Admin bypasses quota
    if (req.user.role === 'admin') {
        req.quota = { limit: -1, used: 0, remaining: -1, hasSubscription: true, isUnlimited: true };
        return next();
    }

    try {
        const userId = req.user.id;

        // Get active subscription room limit (JOIN with subscription_plans for room_limit)
        const sub = await db.get(
            `SELECT sp.room_limit, sp.open_room_limit, us.end_date FROM user_subscriptions us
             JOIN subscription_plans sp ON us.plan_id = sp.id
             WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
             ORDER BY us.end_date DESC LIMIT 1`,
            [userId]
        );
        // -1 means unlimited (data is converted to camelCase by db.get)
        let subLimit = sub ? Number(sub.roomLimit) : 0;
        let openRoomLimit = sub ? Number(sub.openRoomLimit ?? -1) : -1;
        const isSubUnlimited = subLimit === -1;
        const hasSubscription = !!sub;

        // Get total addon rooms (JOIN with room_addon_packages for room_count)
        // If subscription is unlimited, skip addon check
        const addonResult = isSubUnlimited ? { total: 0 } : await db.get(
            `SELECT COALESCE(SUM(rap.room_count), 0) AS total
             FROM user_room_addons ura
             JOIN room_addon_packages rap ON ura.package_id = rap.id
             WHERE ura.user_id = ? AND ura.status = 'active' AND ura.end_date > NOW()`,
            [userId]
        );
        const addonRooms = isSubUnlimited ? 0 : Number(addonResult?.total || 0);

        // Get system default room limit
        const settings = await db.getSystemSettings();
        // -1 means unlimited for default too (settings may use snake_case or camelCase)
        let defaultLimit = Number(settings.defaultRoomLimit || settings.default_room_limit || 0);
        const isDefaultUnlimited = defaultLimit === -1;

        // If any source is unlimited, total is unlimited
        const isUnlimited = isSubUnlimited || isDefaultUnlimited;
        const totalLimit = isUnlimited ? -1 : (subLimit + addonRooms + defaultLimit);

        // Count current rooms (exclude soft-deleted copies)
        const countResult = await db.get(
            `SELECT COUNT(*) AS count FROM user_room WHERE user_id = ? AND deleted_at IS NULL`,
            [userId]
        );
        const currentCount = Number(countResult?.count || 0);

        // Count currently enabled (open/monitoring) rooms
        const openCountResult = await db.get(
            `SELECT COUNT(*) AS count FROM user_room WHERE user_id = ? AND deleted_at IS NULL AND is_enabled = true`,
            [userId]
        );
        const openCount = Number(openCountResult?.count || 0);
        const isOpenUnlimited = openRoomLimit === -1;
        const openRemaining = isOpenUnlimited ? -1 : Math.max(0, openRoomLimit - openCount);

        req.quota = {
            limit: totalLimit,
            used: currentCount,
            remaining: isUnlimited ? -1 : (totalLimit - currentCount),
            hasSubscription,
            subscriptionEndDate: sub?.endDate || null,
            subRooms: subLimit,
            addonRooms,
            defaultRooms: defaultLimit,
            isUnlimited,
            openRoomLimit: isOpenUnlimited ? -1 : openRoomLimit,
            openCount,
            openRemaining
        };

        // If unlimited, always allow
        if (isUnlimited) {
            return next();
        }

        // If no subscription and no default rooms, require subscription
        if (!hasSubscription && totalLimit === 0) {
            return res.status(403).json({
                error: '您还没有有效的订阅套餐，请前往用户中心购买套餐后再使用',
                code: 'NO_SUBSCRIPTION',
                quota: req.quota
            });
        }

        next();
    } catch (err) {
        console.error('[Quota] Error checking quota:', err.message);
        res.status(500).json({ error: '配额检查失败' });
    }
}

/**
 * Get user's current quota (utility function for routes)
 * room_limit = -1 means unlimited
 */
async function getUserQuota(userId) {
    // Admin bypasses quota
    const user = await db.get('SELECT role FROM users WHERE id = ?', [userId]);
    if (user && user.role === 'admin') {
        return { limit: -1, used: 0, remaining: -1, hasSubscription: true, isUnlimited: true };
    }

    // Get active subscription room limit
    const sub = await db.get(
        `SELECT sp.room_limit, sp.open_room_limit, us.end_date FROM user_subscriptions us
         JOIN subscription_plans sp ON us.plan_id = sp.id
         WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
         ORDER BY us.end_date DESC LIMIT 1`,
        [userId]
    );
    // -1 means unlimited (data is converted to camelCase by db.get)
    let subLimit = sub ? Number(sub.roomLimit) : 0;
    let openRoomLimit = sub ? Number(sub.openRoomLimit ?? -1) : -1;
    const isSubUnlimited = subLimit === -1;
    const hasSubscription = !!sub;

    // Get total addon rooms
    const addonResult = isSubUnlimited ? { total: 0 } : await db.get(
        `SELECT COALESCE(SUM(rap.room_count), 0) AS total
         FROM user_room_addons ura
         JOIN room_addon_packages rap ON ura.package_id = rap.id
         WHERE ura.user_id = ? AND ura.status = 'active' AND ura.end_date > NOW()`,
        [userId]
    );
    const addonRooms = isSubUnlimited ? 0 : Number(addonResult?.total || 0);

    // Get system default room limit
    const settings = await db.getSystemSettings();
    let defaultLimit = Number(settings.defaultRoomLimit || settings.default_room_limit || 0);
    const isDefaultUnlimited = defaultLimit === -1;

    // If any source is unlimited, total is unlimited
    const isUnlimited = isSubUnlimited || isDefaultUnlimited;
    const totalLimit = isUnlimited ? -1 : (subLimit + addonRooms + defaultLimit);

    // Count current rooms (exclude soft-deleted copies)
    const countResult = await db.get(
        `SELECT COUNT(*) AS count FROM user_room WHERE user_id = ? AND deleted_at IS NULL`,
        [userId]
    );
    const currentCount = Number(countResult?.count || 0);

    // Count currently enabled (open/monitoring) rooms
    const openCountResult = await db.get(
        `SELECT COUNT(*) AS count FROM user_room WHERE user_id = ? AND deleted_at IS NULL AND is_enabled = true`,
        [userId]
    );
    const openCount = Number(openCountResult?.count || 0);
    const isOpenUnlimited = openRoomLimit === -1;
    const openRemaining = isOpenUnlimited ? -1 : Math.max(0, openRoomLimit - openCount);

    return {
        limit: totalLimit,
        used: currentCount,
        remaining: isUnlimited ? -1 : (totalLimit - currentCount),
        hasSubscription,
        subscriptionEndDate: sub?.endDate || null,
        subRooms: subLimit,
        addonRooms,
        defaultRooms: defaultLimit,
        isUnlimited,
        openRoomLimit: isOpenUnlimited ? -1 : openRoomLimit,
        openCount,
        openRemaining
    };
}

module.exports = { checkRoomQuota, getUserQuota };
