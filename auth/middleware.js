/**
 * Authentication Middleware
 */
const { verifyToken, extractToken } = require('./jwt');
const db = require('../db');

/**
 * Require authentication middleware
 * Extracts and validates JWT from Authorization header
 * Attaches user info to req.user
 */
async function requireAuth(req, res, next) {
    try {
        const token = extractToken(req.headers.authorization);

        if (!token) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: '请登录后访问'
            });
        }

        const payload = verifyToken(token);

        if (!payload) {
            return res.status(401).json({
                error: 'Invalid token',
                message: 'Token 已过期或无效，请重新登录'
            });
        }

        // Attach user info to request
        req.user = {
            id: payload.userId,
            email: payload.email,
            nickname: payload.nickname
        };

        next();
    } catch (err) {
        console.error('[Auth] Middleware error:', err);
        return res.status(500).json({ error: 'Authentication error' });
    }
}

/**
 * Optional authentication middleware
 * Same as requireAuth but doesn't reject unauthenticated requests
 * Just attaches user info if token is valid
 */
async function optionalAuth(req, res, next) {
    try {
        const token = extractToken(req.headers.authorization);

        if (token) {
            const payload = verifyToken(token);
            if (payload) {
                req.user = {
                    id: payload.userId,
                    email: payload.email,
                    nickname: payload.nickname
                };
            }
        }

        next();
    } catch (err) {
        // Ignore auth errors for optional auth
        next();
    }
}

/**
 * Get current user's subscription info
 * Attaches subscription details to req.subscription
 */
async function loadSubscription(req, res, next) {
    try {
        if (!req.user) {
            // No user, use free tier defaults
            req.subscription = {
                planCode: 'free',
                roomLimit: 1,
                historyDays: 7,
                apiRateLimit: 30,
                features: { export: false, ai_analysis: false, api_access: false }
            };
            return next();
        }

        const result = await db.get(`
            SELECT s.*, p.code as plan_code, p.room_limit, p.history_days, 
                   p.api_rate_limit, p.feature_flags
            FROM user_subscriptions s
            JOIN subscription_plans p ON s.plan_id = p.id
            WHERE s.user_id = $1 
              AND s.status = 'active' 
              AND s.end_date > NOW()
            ORDER BY p.sort_order DESC
            LIMIT 1
        `, [req.user.id]);

        if (result) {
            req.subscription = {
                id: result.id,
                planCode: result.plan_code,
                roomLimit: result.room_limit,
                historyDays: result.history_days,
                apiRateLimit: result.api_rate_limit,
                features: result.feature_flags || {},
                endDate: result.end_date,
                autoRenew: result.auto_renew
            };
        } else {
            // No active subscription, use free tier
            req.subscription = {
                planCode: 'free',
                roomLimit: 1,
                historyDays: 7,
                apiRateLimit: 30,
                features: { export: false, ai_analysis: false, api_access: false }
            };
        }

        next();
    } catch (err) {
        console.error('[Auth] Load subscription error:', err);
        next(); // Continue without subscription info
    }
}

/**
 * Check if user has a specific feature enabled
 * @param {string} featureName - Feature to check
 */
function requireFeature(featureName) {
    return async (req, res, next) => {
        if (!req.subscription) {
            await loadSubscription(req, res, () => { });
        }

        if (!req.subscription.features[featureName]) {
            return res.status(403).json({
                error: 'Feature not available',
                message: `此功能需要升级订阅才能使用`,
                requiredFeature: featureName
            });
        }

        next();
    };
}

/**
 * Check room limit for adding new rooms
 */
async function checkRoomLimit(req, res, next) {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!req.subscription) {
            await loadSubscription(req, res, () => { });
        }

        const limit = req.subscription.roomLimit;

        if (limit === -1) {
            // Unlimited
            return next();
        }

        const countResult = await db.get(`
            SELECT COUNT(*) as count FROM rooms WHERE user_id = $1
        `, [req.user.id]);

        const currentCount = parseInt(countResult?.count || 0);

        if (currentCount >= limit) {
            return res.status(403).json({
                error: 'Room limit reached',
                message: `当前方案最多可监控 ${limit} 个房间，请升级订阅`,
                limit,
                current: currentCount
            });
        }

        next();
    } catch (err) {
        console.error('[Auth] Check room limit error:', err);
        next();
    }
}

module.exports = {
    requireAuth,
    optionalAuth,
    loadSubscription,
    requireFeature,
    checkRoomLimit
};
