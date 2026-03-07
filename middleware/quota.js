const quotaService = require('../services/quotaService');

/**
 * Check user's room quota before allowing room addition
 * room_limit = -1 means unlimited
 */
async function checkRoomQuota(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: '需要登录' });
    }

    try {
        req.quota = await quotaService.getUserQuota(req.user.id);

        if (req.quota.isUnlimited) {
            return next();
        }

        if (!req.quota.hasSubscription && req.quota.limit === 0) {
            return res.status(403).json({
                error: '您还没有有效的订阅套餐，请前往用户中心购买套餐后再使用',
                code: 'NO_SUBSCRIPTION',
                quota: req.quota
            });
        }

        return next();
    } catch (err) {
        console.error('[Quota] Error checking quota:', err.message);
        return res.status(500).json({ error: '配额检查失败' });
    }
}

async function getUserQuota(userId) {
    return quotaService.getUserQuota(userId);
}

module.exports = { checkRoomQuota, getUserQuota };
