const jwt = require('jsonwebtoken');
const db = require('../db');
const { getUserAdminAccess, hasPermission } = require('../services/rbacService');

const JWT_SECRET = process.env.JWT_SECRET || 'tkmonitor_jwt_secret_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';
const REFRESH_EXPIRES_IN = process.env.REFRESH_EXPIRES_IN || '7d';

function normalizeSessionVersion(value) {
    const num = Number(value);
    return Number.isInteger(num) && num >= 0 ? num : 0;
}

function isSessionRevoked(decoded, user) {
    const tokenSessionVersion = normalizeSessionVersion(decoded?.sessionVersion);
    const userSessionVersion = normalizeSessionVersion(user?.sessionVersion ?? user?.session_version);
    return tokenSessionVersion !== userSessionVersion;
}

/**
 * Authenticate middleware - requires valid access token
 */
async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未提供认证令牌' });
    }

    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await db.get(
            'SELECT id, username, email, nickname, balance, role, status, session_version FROM users WHERE id = ?',
            [decoded.userId]
        );
        if (!user) {
            return res.status(401).json({ error: '用户不存在' });
        }
        if (user.status !== 'active') {
            return res.status(403).json({ error: '账户已被禁用', code: 'ACCOUNT_DISABLED' });
        }
        if (isSessionRevoked(decoded, user)) {
            return res.status(401).json({ error: '账号已在其他地方登录，请重新登录', code: 'SESSION_REVOKED' });
        }
        if (user.role === 'admin') {
            const adminAccess = await getUserAdminAccess(user);
            user.adminAccess = adminAccess;
            user.permissions = adminAccess.permissions;
            user.adminRoleCode = adminAccess.roleCode;
            user.adminRoleName = adminAccess.roleName;
            user.isSuperAdmin = adminAccess.isSuperAdmin;
        }
        req.user = user;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: '令牌已过期', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ error: '无效的认证令牌' });
    }
}

/**
 * Optional auth - sets req.user if valid token provided, otherwise null
 */
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null;
        return next();
    }

    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await db.get(
            'SELECT id, username, email, nickname, balance, role, status, session_version FROM users WHERE id = ?',
            [decoded.userId]
        );
        if (user && user.status === 'active' && !isSessionRevoked(decoded, user)) {
            if (user.role === 'admin') {
                const adminAccess = await getUserAdminAccess(user);
                user.adminAccess = adminAccess;
                user.permissions = adminAccess.permissions;
                user.adminRoleCode = adminAccess.roleCode;
                user.adminRoleName = adminAccess.roleName;
                user.isSuperAdmin = adminAccess.isSuperAdmin;
            }
            req.user = user;
        } else {
            req.user = null;
        }
    } catch {
        req.user = null;
    }
    next();
}

/**
 * Require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    next();
}


function hasAdminPermission(user, permissionKey) {
    if (!user || user.role !== 'admin') return false;
    return hasPermission(user.adminAccess || {
        isAdmin: user.role === 'admin',
        isSuperAdmin: false,
        permissions: Array.isArray(user.permissions) ? user.permissions : [],
    }, permissionKey);
}

function requireAdminPermission(permissionKey) {
    return (req, res, next) => {
        if (hasAdminPermission(req.user, permissionKey)) {
            return next();
        }
        return res.status(403).json({
            error: '缺少后台权限',
            code: 'ADMIN_PERMISSION_DENIED',
            permission: permissionKey,
        });
    };
}

module.exports = {
    authenticate,
    optionalAuth,
    requireAdmin,
    requireAdminPermission,
    hasAdminPermission,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    REFRESH_EXPIRES_IN
};
