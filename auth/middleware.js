/**
 * Auth Middleware - JWT Authentication & Role-based Access Control
 */
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'tiktok-monitor-jwt-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';
const REFRESH_EXPIRES_IN = process.env.REFRESH_EXPIRES_IN || '30d';

/**
 * requireAuth - Verify JWT access token
 * Sets req.user = { id, email, role, nickname }
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未登录，请先登录' });
    }

    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
            id: decoded.id,
            email: decoded.email,
            role: decoded.role,
            nickname: decoded.nickname
        };
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: '登录已过期，请重新登录', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ error: '无效的认证令牌' });
    }
}

/**
 * optionalAuth - If token present, decode it; otherwise continue without user
 */
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null;
        return next();
    }

    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
            id: decoded.id,
            email: decoded.email,
            role: decoded.role,
            nickname: decoded.nickname
        };
    } catch {
        req.user = null;
    }
    next();
}

/**
 * requireAdmin - Check admin role (must be used after requireAuth)
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    next();
}

/**
 * loadSubscription - Load current user's active subscription into req.subscription
 * Must be used after requireAuth
 */
async function loadSubscription(req, res, next) {
    try {
        console.log(`[Auth] Loading subscription for user ${req.user.id}`);
        
        const sub = await db.get(`
            SELECT us.*, sp.code as plan_code, sp.name as plan_name, 
                   sp.room_limit as plan_room_limit, sp.history_days,
                   sp.feature_flags, sp.ai_credits_monthly
            FROM user_subscriptions us
            JOIN subscription_plans sp ON us.plan_id = sp.id
            WHERE us.user_id = $1 AND us.status = 'active' AND us.end_date > NOW()
            ORDER BY us.end_date DESC
            LIMIT 1
        `, [req.user.id]);

        if (sub) {
            console.log(`[Auth] Found active subscription for user ${req.user.id}: plan=${sub.plan_code}, end_date=${sub.end_date}`);
            // Also calculate addon room count
            const addonResult = await db.get(`
                SELECT COALESCE(SUM(rap.room_count), 0) as addon_rooms
                FROM user_room_addons ura
                JOIN room_addon_packages rap ON ura.package_id = rap.id
                WHERE ura.user_id = $1 AND ura.status = 'active' AND ura.end_date > NOW()
            `, [req.user.id]);

            req.subscription = {
                ...sub,
                addonRooms: parseInt(addonResult?.addon_rooms || 0),
                totalRoomLimit: sub.plan_room_limit === -1 ? -1 : sub.plan_room_limit + parseInt(addonResult?.addon_rooms || 0)
            };
        } else {
            // Check if there's any subscription record at all (for debugging)
            const anySub = await db.get(`
                SELECT us.*, sp.code as plan_code, us.end_date, us.status
                FROM user_subscriptions us
                LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
                WHERE us.user_id = $1
                ORDER BY us.created_at DESC
                LIMIT 1
            `, [req.user.id]);
            
            if (anySub) {
                console.log(`[Auth] User ${req.user.id} has subscription but not active: status=${anySub.status}, end_date=${anySub.end_date}, plan_code=${anySub.plan_code}`);
            } else {
                console.log(`[Auth] User ${req.user.id} has no subscription record`);
            }
            
            // No active subscription - user must purchase to use
            req.subscription = {
                plan_code: 'none',
                plan_name: '未订阅',
                plan_room_limit: 0,
                history_days: 0,
                feature_flags: {},
                ai_credits_monthly: 0,
                addonRooms: 0,
                totalRoomLimit: 0
            };
        }
        next();
    } catch (err) {
        console.error('[Auth] Error loading subscription:', err);
        // Don't block the request, just set default
        req.subscription = {
            plan_code: 'free',
            plan_name: '免费版',
            plan_room_limit: 1,
            totalRoomLimit: 1,
            addonRooms: 0
        };
        next();
    }
}

/**
 * checkRoomLimit - Check if user can add more rooms
 * Must be used after requireAuth and loadSubscription
 */
async function checkRoomLimit(req, res, next) {
    try {
        // Admin bypass
        if (req.user.role === 'admin') return next();

        const limit = req.subscription?.totalRoomLimit;
        if (limit === -1) return next(); // Unlimited

        // Count current rooms
        const result = await db.get(
            'SELECT COUNT(*) as cnt FROM user_room WHERE user_id = $1',
            [req.user.id]
        );
        const currentCount = parseInt(result?.cnt || 0);

        if (currentCount >= limit) {
            return res.status(403).json({
                error: `房间数已达上限 (${currentCount}/${limit})，请升级套餐或购买加购包`,
                code: 'ROOM_LIMIT_REACHED',
                current: currentCount,
                limit
            });
        }
        next();
    } catch (err) {
        console.error('[Auth] Error checking room limit:', err);
        next(); // Don't block on error
    }
}

/**
 * Sign a JWT access token
 */
function signAccessToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, nickname: user.nickname },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Sign a JWT refresh token
 */
function signRefreshToken(user) {
    return jwt.sign(
        { id: user.id, type: 'refresh' },
        JWT_SECRET,
        { expiresIn: REFRESH_EXPIRES_IN }
    );
}

module.exports = {
    JWT_SECRET,
    JWT_EXPIRES_IN,
    REFRESH_EXPIRES_IN,
    requireAuth,
    optionalAuth,
    requireAdmin,
    loadSubscription,
    checkRoomLimit,
    signAccessToken,
    signRefreshToken
};
