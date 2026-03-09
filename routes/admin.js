const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { body, query: queryValidator, validationResult } = require('express-validator');
const db = require('../db');
const { manager } = require('../manager');
const { authenticate, requireAdmin, hasAdminPermission } = require('../middleware/auth');
const authService = require('../services/authService');
const balanceService = require('../services/balanceService');
const emailService = require('../services/emailService');
const {
    listPromptTemplates,
    getPromptTemplateDefinition,
    savePromptTemplate,
    resetPromptTemplate,
} = require('../services/aiPromptService');
const quotaService = require('../services/quotaService');
const { listAdminAiWorkJobs, getAdminAiWorkJobDetail } = require('../services/aiWorkService');
const keyManager = require('../utils/keyManager');
const { isEulerRateLimitMessage, normalizeEulerKeyHealthStatus } = require('../utils/eulerKeyStatus');
const {
    PREMIUM_ROOM_LOOKUP_LEVELS,
    normalizePremiumRoomLookupLevel,
    getPremiumRoomLookupState,
    getPremiumRoomLookupLevel,
} = require('../utils/eulerKeyCapability');
const {
    isSessionMaintenanceSettingKey,
    saveSessionMaintenanceConfig,
    getSessionMaintenanceOverview,
    listSessionMaintenanceLogs,
    SESSION_MAINTENANCE_ACTION_ALIASES,
} = require('../services/sessionMaintenanceService');
const {
    enqueueSessionMaintenanceJob,
} = require('../services/adminAsyncJobService');
const {
    ADMIN_PERMISSION_GROUPS,
    ALL_ADMIN_PERMISSION_KEYS,
    listAdminRoles,
    listAdminUsers,
    searchAdminCandidates,
    upsertAdminUserRole,
    revokeAdminUser,
    createAdminRole,
    updateAdminRole,
    deleteAdminRole,
} = require('../services/rbacService');
const {
    buildAdminSettingsResponse,
    sanitizeAdminSettingsPayload,
    shouldPreserveSecretSetting,
    SCHEME_A_RUNTIME_SETTING_KEYS,
} = require('../services/adminSettingsService');
const { testRedisConnection } = require('../services/redisClient');

const router = express.Router();

// All admin routes require authentication + admin role
router.use(authenticate, requireAdmin);


function resolveAdminRoutePermission(req) {
    const routePath = String(req.path || '');
    if (routePath === '/admin-access/me') return null;
    if (routePath.startsWith('/admin-access')) return 'admins.manage';
    if (routePath === '/stats') return 'overview.view';
    if (routePath.startsWith('/docs')) return 'docs.manage';
    if (routePath.startsWith('/users')) return 'users.manage';
    if (routePath.startsWith('/orders')) return 'orders.manage';
    if (routePath.startsWith('/plans') || routePath.startsWith('/addons') || routePath.startsWith('/ai-credit-packages')) return 'plans.manage';
    if (routePath.startsWith('/gifts')) return 'gifts.manage';
    if (routePath.startsWith('/settings')) return 'settings.manage';
    if (routePath.startsWith('/session-maintenance')) return 'session_maintenance.manage';
    if (routePath.startsWith('/prompt-templates')) return 'prompts.manage';
    if (routePath.startsWith('/ai-work')) return 'ai_work.manage';
    if (routePath.startsWith('/euler-keys')) return 'euler_keys.manage';
    if (routePath.startsWith('/ai-channels') || routePath.startsWith('/ai-models')) return 'ai_channels.manage';
    if (routePath.startsWith('/smtp')) return 'smtp.manage';
    return null;
}

router.use((req, res, next) => {
    const permission = resolveAdminRoutePermission(req);
    if (!permission || hasAdminPermission(req.user, permission)) {
        return next();
    }
    return res.status(403).json({
        error: '缺少后台权限',
        code: 'ADMIN_PERMISSION_DENIED',
        permission,
    });
});

const DOCS_ROOT = path.resolve(__dirname, '..', 'docs');
const AI_MODEL_FAILURE_COOLDOWN_MS = (() => {
    const raw = parseInt(process.env.AI_MODEL_FAILURE_COOLDOWN_MS || `${5 * 60 * 1000}`, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();

function normalizeDocRelativePath(input) {
    return String(input || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .trim();
}

function resolveDocPath(relativePath) {
    const normalized = normalizeDocRelativePath(relativePath);
    if (!normalized) return null;
    const fullPath = path.resolve(DOCS_ROOT, normalized);
    const docsPrefix = `${DOCS_ROOT}${path.sep}`;
    if (fullPath !== DOCS_ROOT && !fullPath.startsWith(docsPrefix)) {
        return null;
    }
    return { normalized, fullPath };
}

function extractDocTitle(markdown, fallbackName) {
    const match = String(markdown || '').match(/^#\s+(.+)$/m);
    if (match && match[1]) return match[1].trim();
    return fallbackName;
}

function getAiModelCooldownMeta(row) {
    const raw = row?.cooldownUntil;
    if (!raw) return { cooldownUntil: null, isCooling: false, cooldownRemainingSeconds: 0 };
    const cooldownUntil = new Date(raw);
    if (Number.isNaN(cooldownUntil.getTime())) {
        return { cooldownUntil: null, isCooling: false, cooldownRemainingSeconds: 0 };
    }
    const remainingMs = cooldownUntil.getTime() - Date.now();
    if (remainingMs <= 0) {
        return { cooldownUntil: cooldownUntil.toISOString(), isCooling: false, cooldownRemainingSeconds: 0 };
    }
    return {
        cooldownUntil: cooldownUntil.toISOString(),
        isCooling: true,
        cooldownRemainingSeconds: Math.ceil(remainingMs / 1000)
    };
}

function serializeAdminAiModel(row) {
    const cooldown = getAiModelCooldownMeta(row);
    return {
        id: row.id,
        channelId: row.channelId,
        name: row.name,
        modelId: row.modelId,
        isActive: Boolean(row.isActive),
        isDefault: Boolean(row.isDefault),
        callCount: Number(row.callCount || 0),
        successCount: Number(row.successCount || 0),
        failCount: Number(row.failCount || 0),
        consecutiveFailures: Number(row.consecutiveFailures || 0),
        avgLatencyMs: Number(row.avgLatencyMs || 0),
        lastUsedAt: row.lastUsedAt || null,
        lastError: row.lastError || '',
        lastStatus: row.lastStatus || 'unknown',
        cooldownUntil: cooldown.cooldownUntil,
        isCooling: cooldown.isCooling,
        cooldownRemainingSeconds: cooldown.cooldownRemainingSeconds,
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null
    };
}

function serializeAdminSmtpService(row) {
    const cooldown = getAiModelCooldownMeta(row);
    return {
        id: row.id,
        name: row.name,
        host: row.host,
        port: Number(row.port || 0),
        secure: Boolean(row.secure),
        username: row.username,
        password: row.password,
        fromEmail: row.fromEmail || '',
        fromName: row.fromName || '',
        isActive: Boolean(row.isActive),
        isDefault: Boolean(row.isDefault),
        callCount: Number(row.callCount || 0),
        successCount: Number(row.successCount || 0),
        failCount: Number(row.failCount || 0),
        consecutiveFailures: Number(row.consecutiveFailures || 0),
        avgLatencyMs: Number(row.avgLatencyMs || 0),
        lastUsedAt: row.lastUsedAt || null,
        lastError: row.lastError || '',
        lastStatus: row.lastStatus || 'unknown',
        cooldownUntil: cooldown.cooldownUntil,
        isCooling: cooldown.isCooling,
        cooldownRemainingSeconds: cooldown.cooldownRemainingSeconds,
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null,
    };
}

function isEulerRoomLookupNoise(message) {
    const normalized = String(message || '').trim().toLowerCase();
    if (!normalized) return false;
    return normalized.includes('euler room lookup')
        || normalized.includes('euler live status lookup')
        || normalized.includes('premium room lookup');
}

function derivePremiumRoomLookupStateFromLevel(level) {
    if (level === PREMIUM_ROOM_LOOKUP_LEVELS.PREMIUM) return 'enabled';
    if (level === PREMIUM_ROOM_LOOKUP_LEVELS.BASIC) return 'disabled';
    return 'unknown';
}

function serializeAdminEulerKey(row) {
    const keyValue = row?.keyValue || row?.key_value || '';
    const premiumRoomLookupLevel = getPremiumRoomLookupLevel(row);
    const rawLastError = row?.lastError || row?.last_error || '';
    const rawLastStatus = row?.lastStatus || row?.last_status || 'unknown';
    const hideRoomLookupNoise = premiumRoomLookupLevel !== PREMIUM_ROOM_LOOKUP_LEVELS.PREMIUM && isEulerRoomLookupNoise(rawLastError);
    const lastError = hideRoomLookupNoise ? '' : rawLastError;
    const lastStatus = hideRoomLookupNoise && rawLastStatus === 'error' ? 'ok' : rawLastStatus;
    const premiumRoomLookupState = derivePremiumRoomLookupStateFromLevel(premiumRoomLookupLevel);

    return {
        id: row?.id,
        name: row?.name || '',
        keyValue,
        isActive: Boolean(row?.isActive ?? row?.is_active),
        callCount: Number(row?.callCount ?? row?.call_count ?? 0),
        lastUsedAt: row?.lastUsedAt || row?.last_used_at || null,
        lastError,
        lastStatus,
        effectiveStatus: normalizeEulerKeyHealthStatus(lastStatus, lastError),
        hasRateLimitError: isEulerRateLimitMessage(lastError),
        premiumRoomLookupLevel,
        premiumRoomLookupState,
        premiumRoomLookupEnabled: premiumRoomLookupLevel === PREMIUM_ROOM_LOOKUP_LEVELS.PREMIUM,
        premiumRoomLookupCheckedAt: row?.premiumRoomLookupCheckedAt || row?.premium_room_lookup_checked_at || null,
        premiumRoomLookupLastStatus: Number(row?.premiumRoomLookupLastStatus ?? row?.premium_room_lookup_last_status ?? 0),
        premiumRoomLookupLastError: '',
        premiumRoomLookupProbeUniqueId: '',
        createdAt: row?.createdAt || row?.created_at || null,
    };
}

async function promoteNextDefaultSmtpService(client, excludeId = null) {
    const params = [];
    let sql = `SELECT id FROM smtp_services WHERE is_active = true`;
    if (excludeId !== null && excludeId !== undefined) {
        params.push(excludeId);
        sql += ` AND id <> $1`;
    }
    sql += ` ORDER BY id LIMIT 1`;

    const nextDefault = await client.query(sql, params);
    await client.query(`UPDATE smtp_services SET is_default = false, updated_at = NOW() WHERE is_default = true`);
    if (nextDefault.rows[0]?.id) {
        await client.query(`UPDATE smtp_services SET is_default = true, updated_at = NOW() WHERE id = $1`, [nextDefault.rows[0].id]);
    }
}

async function collectMarkdownFiles(dirPath, prefix = '') {
    let entries = [];
    try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }

    const files = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectMarkdownFiles(fullPath, relativePath));
            continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

        const [content, stat] = await Promise.all([
            fs.readFile(fullPath, 'utf8'),
            fs.stat(fullPath),
        ]);
        files.push({
            path: relativePath.replace(/\\/g, '/'),
            title: extractDocTitle(content, path.basename(entry.name, path.extname(entry.name))),
            updatedAt: stat.mtime.toISOString(),
            size: stat.size,
        });
    }

    return files;
}

// ==================== Dashboard Stats ====================

/**
 * GET /api/admin/stats
 */
router.get('/stats', async (req, res) => {
    try {
        const [users, todayUsers, activeSubs, monthRevenue, balancePool, totalOrders, activeRooms] = await Promise.all([
            db.get('SELECT COUNT(*) AS count FROM users'),
            db.get(`SELECT COUNT(*) AS count FROM users WHERE created_at >= CURRENT_DATE`),
            db.get(`SELECT COUNT(*) AS count FROM user_subscriptions WHERE status = 'active' AND end_date > NOW()`),
            db.get(`SELECT COALESCE(SUM(amount), 0) AS total FROM payment_records WHERE status = 'paid' AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`),
            db.get('SELECT COALESCE(SUM(balance), 0) AS total FROM users'),
            db.get('SELECT COUNT(*) AS count FROM payment_records'),
            db.get('SELECT COUNT(*) AS count FROM room WHERE is_monitor_enabled = 1'),
        ]);

        res.json({
            totalUsers: Number(users?.count || 0),
            todayNewUsers: Number(todayUsers?.count || 0),
            activeSubscriptions: Number(activeSubs?.count || 0),
            monthRevenue: Number(monthRevenue?.total || 0),
            balancePool: Number(balancePool?.total || 0),
            totalOrders: Number(totalOrders?.count || 0),
            activeRooms: Number(activeRooms?.count || 0),
        });
    } catch (err) {
        console.error('[Admin] Stats error:', err.message);
        res.status(500).json({ error: '获取统计失败' });
    }
});

router.get('/docs', async (req, res) => {
    try {
        const docs = await collectMarkdownFiles(DOCS_ROOT);
        res.json({ docs });
    } catch (err) {
        console.error('[Admin] Docs list error:', err.message);
        res.status(500).json({ error: '获取文档列表失败' });
    }
});

router.get('/docs/content', async (req, res) => {
    try {
        const resolved = resolveDocPath(req.query.path);
        if (!resolved) {
            return res.status(400).json({ error: '文档路径无效' });
        }

        const stat = await fs.stat(resolved.fullPath).catch(() => null);
        if (!stat || !stat.isFile()) {
            return res.status(404).json({ error: '文档不存在' });
        }
        if (!resolved.fullPath.toLowerCase().endsWith('.md')) {
            return res.status(400).json({ error: '仅支持 Markdown 文档' });
        }

        const content = await fs.readFile(resolved.fullPath, 'utf8');
        res.json({
            path: resolved.normalized,
            title: extractDocTitle(content, path.basename(resolved.normalized, path.extname(resolved.normalized))),
            updatedAt: stat.mtime.toISOString(),
            size: stat.size,
            content,
        });
    } catch (err) {
        console.error('[Admin] Docs content error:', err.message);
        res.status(500).json({ error: '获取文档内容失败' });
    }
});

// ==================== User Management ====================

/**
 * GET /api/admin/users
 */
router.get('/users', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const role = req.query.role || '';
        const status = req.query.status || '';

        let where = 'WHERE 1=1';
        const params = [];
        let paramIdx = 0;

        if (search) {
            where += ` AND (username ILIKE $${++paramIdx} OR email ILIKE $${paramIdx} OR nickname ILIKE $${paramIdx})`;
            params.push(`%${search}%`);
        }
        if (role) {
            where += ` AND role = $${++paramIdx}`;
            params.push(role);
        }
        if (status) {
            where += ` AND status = $${++paramIdx}`;
            params.push(status);
        }

        const countResult = await db.pool.query(
            `SELECT COUNT(*) AS count FROM users ${where}`, params
        );

        const usersResult = await db.pool.query(
            `SELECT id, username, email, nickname, balance, role, status, last_login_at, created_at
             FROM users ${where} ORDER BY created_at DESC LIMIT $${++paramIdx} OFFSET $${++paramIdx}`,
            [...params, limit, offset]
        );

        // Get room counts and subscription info for each user
        const users = [];
        for (const u of usersResult.rows) {
            const roomCount = await db.get('SELECT COUNT(*) AS count FROM user_room WHERE user_id = ? AND deleted_at IS NULL', [u.id]);
            const sub = await db.get(
                `SELECT p.name AS plan_name, us.end_date FROM user_subscriptions us
                 JOIN subscription_plans p ON us.plan_id = p.id
                 WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
                 ORDER BY us.end_date DESC LIMIT 1`,
                [u.id]
            );
            users.push({
                ...db.toCamelCase(u),
                roomCount: Number(roomCount?.count || 0),
                planName: sub?.planName || null,
                planEndAt: sub?.endDate || null,
            });
        }

        res.json({
            users,
            pagination: { page, limit, total: parseInt(countResult.rows[0].count) }
        });
    } catch (err) {
        console.error('[Admin] Users list error:', err.message);
        res.status(500).json({ error: '获取用户列表失败' });
    }
});

/**
 * GET /api/admin/users/:id
 */
router.get('/users/:id', async (req, res) => {
    try {
        const user = await db.get(
            'SELECT id, username, email, nickname, balance, role, status, last_login_at, created_at FROM users WHERE id = ?',
            [req.params.id]
        );
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const [subscriptions, rooms, recentBalance, quota] = await Promise.all([
            db.all(`SELECT us.*, p.name AS plan_name FROM user_subscriptions us JOIN subscription_plans p ON us.plan_id = p.id WHERE us.user_id = ? ORDER BY us.created_at DESC LIMIT 10`, [user.id]),
            db.all(`SELECT ur.*, r.name AS room_name
                    FROM user_room ur
                    LEFT JOIN room r ON ur.room_id = r.room_id
                    WHERE ur.user_id = ? AND ur.deleted_at IS NULL
                    ORDER BY ur.created_at DESC`, [user.id]),
            db.all(`SELECT * FROM balance_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, [user.id]),
            quotaService.getUserQuota(user.id),
        ]);

        res.json({ user, subscriptions, rooms, recentBalance, quota });
    } catch (err) {
        console.error('[Admin] User detail error:', err.message);
        res.status(500).json({ error: '获取用户详情失败' });
    }
});

/**
 * PUT /api/admin/users/:id
 */
router.put('/users/:id', async (req, res) => {
    try {
        const { nickname, email, role } = req.body;
        const userId = req.params.id;

        // Prevent self-demotion
        if (parseInt(userId) === req.user.id && role && role !== 'admin') {
            return res.status(400).json({ error: '不能修改自己的管理员角色' });
        }

        const updates = [];
        const params = [];
        let paramIdx = 0;

        if (nickname !== undefined) { updates.push(`nickname = $${++paramIdx}`); params.push(nickname); }
        if (email !== undefined) { updates.push(`email = $${++paramIdx}`); params.push(email || null); }
        if (role && ['user', 'admin'].includes(role)) { updates.push(`role = $${++paramIdx}`); params.push(role); }

        if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

        updates.push('updated_at = NOW()');
        params.push(userId);
        await db.pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx + 1}`, params
        );

        res.json({ message: '更新成功' });
    } catch (err) {
        console.error('[Admin] Update user error:', err.message);
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * PUT /api/admin/users/:id/quota-overrides
 */
router.put('/users/:id/quota-overrides', async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ error: '用户ID无效' });
        }

        const user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const hasOwn = (key) => Object.prototype.hasOwnProperty.call(req.body || {}, key);
        const supportedKeys = [
            'roomLimitPermanent',
            'roomLimitTemporary',
            'roomLimitTemporaryExpiresAt',
            'dailyRoomCreateLimitPermanent',
            'dailyRoomCreateLimitTemporary',
            'dailyRoomCreateLimitTemporaryExpiresAt'
        ];
        if (!supportedKeys.some(hasOwn)) {
            return res.status(400).json({ error: '没有可保存的配额字段' });
        }

        const parseLimit = (value, fieldLabel) => {
            if (value === '' || value === null || value === undefined) return null;
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed < -1) {
                throw new Error(`${fieldLabel}必须是大于等于 -1 的整数`);
            }
            return parsed;
        };
        const parseDate = (value, fieldLabel) => {
            if (value === '' || value === null || value === undefined) return null;
            const dt = new Date(value);
            if (Number.isNaN(dt.getTime())) {
                throw new Error(`${fieldLabel}无效`);
            }
            return dt.toISOString();
        };

        let payload;
        try {
            payload = {};
            if (hasOwn('roomLimitPermanent')) payload.room_limit_permanent = parseLimit(req.body.roomLimitPermanent, '永久可建房间数');
            if (hasOwn('roomLimitTemporary')) payload.room_limit_temporary = parseLimit(req.body.roomLimitTemporary, '临时可建房间数');
            if (hasOwn('roomLimitTemporaryExpiresAt')) payload.room_limit_temporary_expires_at = parseDate(req.body.roomLimitTemporaryExpiresAt, '可建房间数临时到期时间');
            if (hasOwn('dailyRoomCreateLimitPermanent')) payload.daily_room_create_limit_permanent = parseLimit(req.body.dailyRoomCreateLimitPermanent, '永久每日可添加次数');
            if (hasOwn('dailyRoomCreateLimitTemporary')) payload.daily_room_create_limit_temporary = parseLimit(req.body.dailyRoomCreateLimitTemporary, '临时每日可添加次数');
            if (hasOwn('dailyRoomCreateLimitTemporaryExpiresAt')) payload.daily_room_create_limit_temporary_expires_at = parseDate(req.body.dailyRoomCreateLimitTemporaryExpiresAt, '每日可添加次数临时到期时间');
        } catch (parseErr) {
            return res.status(400).json({ error: parseErr.message });
        }

        const insertCols = ['user_id', ...Object.keys(payload), 'updated_at'];
        const insertParams = [userId, ...Object.values(payload)];
        const insertVals = ['$1'];
        for (let i = 0; i < Object.keys(payload).length; i += 1) {
            insertVals.push(`$${i + 2}`);
        }
        insertVals.push('NOW()');

        const updateCols = Object.keys(payload).map(column => `${column} = EXCLUDED.${column}`);
        updateCols.push('updated_at = NOW()');

        await db.pool.query(
            `INSERT INTO user_quota_overrides (${insertCols.join(', ')})
             VALUES (${insertVals.join(', ')})
             ON CONFLICT (user_id) DO UPDATE
             SET ${updateCols.join(', ')}`,
            insertParams
        );

        const quota = await quotaService.getUserQuota(userId);
        return res.json({ message: '配额调整已保存', quota });
    } catch (err) {
        console.error('[Admin] Update quota overrides error:', err.message);
        return res.status(500).json({ error: '保存配额调整失败' });
    }
});

/**
 * POST /api/admin/users/:id/adjust-balance
 */
router.post('/users/:id/adjust-balance', [
    body('amount').isFloat().withMessage('金额无效'),
    body('remark').optional().trim(),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const { amount, remark } = req.body;
        const userId = parseInt(req.params.id);
        const finalRemark = remark || '管理员调整余额';

        if (isNaN(amount)) {
            return res.status(400).json({ error: '金额无效' });
        }

        // Create payment record for recharge
        let refOrderNo = null;
        if (amount > 0) {
            const orderNo = balanceService.generateOrderNo('RCH');
            await db.pool.query(
                `INSERT INTO payment_records (order_no, user_id, type, item_name, amount, status, payment_method, remark)
                 VALUES ($1, $2, 'recharge', '管理员充值', $3, 'paid', 'manual', $4)`,
                [orderNo, userId, Math.round(Math.abs(amount)), finalRemark]
            );
            refOrderNo = orderNo;
        }

        const result = await balanceService.adjustBalance(
            userId, Math.round(parseFloat(amount)), amount > 0 ? 'recharge' : 'admin_adjust',
            finalRemark, refOrderNo, req.user.id
        );

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            message: `余额调整成功: ${amount > 0 ? '+' : ''}${amount}`,
            balanceBefore: result.balanceBefore,
            balanceAfter: result.balanceAfter
        });
    } catch (err) {
        console.error('[Admin] Adjust balance error:', err.message);
        res.status(500).json({ error: '余额调整失败' });
    }
});

/**
 * POST /api/admin/users/:id/toggle-status
 */
router.post('/users/:id/toggle-status', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        if (userId === req.user.id) {
            return res.status(400).json({ error: '不能禁用自己' });
        }

        const user = await db.get('SELECT status FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: '用户不存在' });

        const newStatus = user.status === 'active' ? 'disabled' : 'active';
        await db.run('UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, userId]);

        // If disabling, revoke all tokens
        if (newStatus === 'disabled') {
            await authService.revokeAllUserTokens(userId);
        }

        res.json({ message: `用户已${newStatus === 'active' ? '启用' : '禁用'}`, status: newStatus });
    } catch (err) {
        console.error('[Admin] Toggle status error:', err.message);
        res.status(500).json({ error: '操作失败' });
    }
});

/**
 * POST /api/admin/users/:id/reset-password
 */
router.post('/users/:id/reset-password', [
    body('newPassword').isLength({ min: 6, max: 100 }).withMessage('密码至少6个字符'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const hash = await authService.hashPassword(req.body.newPassword);
        await db.run('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?', [hash, req.params.id]);
        await authService.revokeAllUserTokens(parseInt(req.params.id));
        res.json({ message: '密码重置成功' });
    } catch (err) {
        console.error('[Admin] Reset password error:', err.message);
        res.status(500).json({ error: '重置失败' });
    }
});

// ==================== Order Management ====================

/**
 * GET /api/admin/orders
 */
router.get('/orders', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const type = req.query.type || '';
        const status = req.query.status || '';
        const search = req.query.search || '';

        let where = 'WHERE 1=1';
        const params = [];
        let paramIdx = 0;

        if (type) { where += ` AND o.type = $${++paramIdx}`; params.push(type); }
        if (status) { where += ` AND o.status = $${++paramIdx}`; params.push(status); }
        if (search) {
            where += ` AND (o.order_no ILIKE $${++paramIdx} OR u.username ILIKE $${paramIdx})`;
            params.push(`%${search}%`);
        }

        const countResult = await db.pool.query(
            `SELECT COUNT(*) AS count FROM payment_records o LEFT JOIN users u ON o.user_id = u.id ${where}`, params
        );

        const ordersResult = await db.pool.query(
            `SELECT o.*, u.username, u.nickname AS user_nickname
             FROM payment_records o LEFT JOIN users u ON o.user_id = u.id
             ${where} ORDER BY o.created_at DESC LIMIT $${++paramIdx} OFFSET $${++paramIdx}`,
            [...params, limit, offset]
        );

        res.json({
            orders: ordersResult.rows.map(db.toCamelCase),
            pagination: { page, limit, total: parseInt(countResult.rows[0].count) }
        });
    } catch (err) {
        console.error('[Admin] Orders error:', err.message);
        res.status(500).json({ error: '获取订单列表失败' });
    }
});

// ==================== Plan Management ====================

/**
 * GET /api/admin/plans
 */
router.get('/plans', async (req, res) => {
    try {
        const plans = await db.all(
            `SELECT id, name, code, room_limit, price_monthly, price_quarterly, price_annual,
                    feature_flags, sort_order, is_active, daily_room_create_limit, ai_credits_monthly
             FROM subscription_plans
             ORDER BY sort_order`
        );
        res.json({ plans });
    } catch (err) {
        res.status(500).json({ error: '获取套餐失败' });
    }
});

/**
 * POST /api/admin/plans
 */
router.post('/plans', [
    body('name').trim().notEmpty(),
    body('code').trim().notEmpty(),
    body('roomLimit').isInt({ min: -1 }).withMessage('房间上限必须 >= -1 (-1表示无限)'),
    body('priceMonthly').isFloat({ min: 0 }),
    body('priceQuarterly').isFloat({ min: 0 }),
    body('priceAnnual').isFloat({ min: 0 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const { name, code, roomLimit, priceMonthly, priceQuarterly, priceAnnual, featureFlags, sortOrder, dailyRoomCreateLimit, aiCreditsMonthly } = req.body;

        const existing = await db.get('SELECT id FROM subscription_plans WHERE code = ?', [code]);
        if (existing) return res.status(409).json({ error: '套餐代码已存在' });

        await db.run(
            `INSERT INTO subscription_plans (name, code, room_limit, price_monthly, price_quarterly, price_annual, feature_flags, sort_order, daily_room_create_limit, ai_credits_monthly)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, code, roomLimit, Math.round(priceMonthly), Math.round(priceQuarterly), Math.round(priceAnnual), JSON.stringify(featureFlags || {}), sortOrder || 0, dailyRoomCreateLimit !== undefined ? dailyRoomCreateLimit : -1, aiCreditsMonthly || 0]
        );
        res.status(201).json({ message: '套餐创建成功' });
    } catch (err) {
        console.error('[Admin] Create plan error:', err.message);
        res.status(500).json({ error: '创建失败' });
    }
});

/**
 * PUT /api/admin/plans/:id
 */
router.put('/plans/:id', async (req, res) => {
    try {
        const { name, roomLimit, priceMonthly, priceQuarterly, priceAnnual, featureFlags, sortOrder, isActive, dailyRoomCreateLimit } = req.body;
        const planId = req.params.id;

        const updates = [];
        const params = [];
        let idx = 0;

        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (roomLimit !== undefined) { updates.push(`room_limit = $${++idx}`); params.push(roomLimit); }
        if (priceMonthly !== undefined) { updates.push(`price_monthly = $${++idx}`); params.push(Math.round(priceMonthly)); }
        if (priceQuarterly !== undefined) { updates.push(`price_quarterly = $${++idx}`); params.push(Math.round(priceQuarterly)); }
        if (priceAnnual !== undefined) { updates.push(`price_annual = $${++idx}`); params.push(Math.round(priceAnnual)); }
        if (featureFlags !== undefined) { updates.push(`feature_flags = $${++idx}`); params.push(JSON.stringify(featureFlags)); }
        if (sortOrder !== undefined) { updates.push(`sort_order = $${++idx}`); params.push(sortOrder); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }
        if (dailyRoomCreateLimit !== undefined) { updates.push(`daily_room_create_limit = $${++idx}`); params.push(dailyRoomCreateLimit); }
        if (req.body.aiCreditsMonthly !== undefined) { updates.push(`ai_credits_monthly = $${++idx}`); params.push(req.body.aiCreditsMonthly); }

        if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

        updates.push('updated_at = NOW()');
        params.push(planId);
        await db.pool.query(`UPDATE subscription_plans SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);

        res.json({ message: '套餐更新成功' });
    } catch (err) {
        console.error('[Admin] Update plan error:', err.message);
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * DELETE /api/admin/plans/:id - Toggle active status (下架/上架)
 */
router.delete('/plans/:id', async (req, res) => {
    try {
        const plan = await db.get('SELECT is_active FROM subscription_plans WHERE id = ?', [req.params.id]);
        if (!plan) return res.status(404).json({ error: '套餐不存在' });

        const newStatus = !plan.isActive;
        await db.run('UPDATE subscription_plans SET is_active = ?, updated_at = NOW() WHERE id = ?', [newStatus, req.params.id]);
        res.json({ message: newStatus ? '套餐已上架' : '套餐已下架', isActive: newStatus });
    } catch (err) {
        res.status(500).json({ error: '操作失败' });
    }
});

// ==================== Addon Management ====================

/**
 * GET /api/admin/addons
 */
router.get('/addons', async (req, res) => {
    try {
        const addons = await db.all('SELECT * FROM room_addon_packages ORDER BY room_count');
        res.json({ addons });
    } catch (err) {
        res.status(500).json({ error: '获取扩容包失败' });
    }
});

/**
 * POST /api/admin/addons
 */
router.post('/addons', [
    body('name').trim().notEmpty(),
    body('roomCount').isInt({ min: 1 }),
    body('priceMonthly').isFloat({ min: 0 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const { name, roomCount, priceMonthly, priceQuarterly, priceAnnual } = req.body;
        await db.run(
            'INSERT INTO room_addon_packages (name, room_count, price_monthly, price_quarterly, price_annual) VALUES (?, ?, ?, ?, ?)',
            [name, roomCount, Math.round(priceMonthly), Math.round(priceQuarterly || 0), Math.round(priceAnnual || 0)]
        );
        res.status(201).json({ message: '扩容包创建成功' });
    } catch (err) {
        res.status(500).json({ error: '创建失败' });
    }
});

/**
 * PUT /api/admin/addons/:id
 */
router.put('/addons/:id', async (req, res) => {
    try {
        const { name, roomCount, priceMonthly, priceQuarterly, priceAnnual, isActive } = req.body;
        const updates = [];
        const params = [];
        let idx = 0;

        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (roomCount !== undefined) { updates.push(`room_count = $${++idx}`); params.push(roomCount); }
        if (priceMonthly !== undefined) { updates.push(`price_monthly = $${++idx}`); params.push(Math.round(priceMonthly)); }
        if (priceQuarterly !== undefined) { updates.push(`price_quarterly = $${++idx}`); params.push(Math.round(priceQuarterly)); }
        if (priceAnnual !== undefined) { updates.push(`price_annual = $${++idx}`); params.push(Math.round(priceAnnual)); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }

        if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

        params.push(req.params.id);
        await db.pool.query(`UPDATE room_addon_packages SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);
        res.json({ message: '扩容包更新成功' });
    } catch (err) {
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * DELETE /api/admin/addons/:id
 */
router.delete('/addons/:id', async (req, res) => {
    try {
        await db.run('UPDATE room_addon_packages SET is_active = false WHERE id = ?', [req.params.id]);
        res.json({ message: '扩容包已下架' });
    } catch (err) {
        res.status(500).json({ error: '操作失败' });
    }
});

// ==================== System Settings ====================

/**
 * GET /api/admin/settings
 */
router.get('/settings', async (req, res) => {
    try {
        const settings = await db.getSystemSettings();
        res.json(buildAdminSettingsResponse(settings));
    } catch (err) {
        res.status(500).json({ error: '获取设置失败' });
    }
});

/**
 * PUT /api/admin/settings
 */
router.put('/settings', async (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: '无效的设置数据' });
        }

        const normalizedSettings = sanitizeAdminSettingsPayload(settings);
        const incomingKeys = Object.keys(normalizedSettings);
        const savedKeys = [];

        for (const [key, value] of Object.entries(normalizedSettings)) {
            if (shouldPreserveSecretSetting(key, value)) {
                continue;
            }
            await manager.saveSetting(key, typeof value === 'boolean' ? String(value) : value);
            savedKeys.push(key);
        }

        if (savedKeys.some(key => String(key).startsWith('smtp_'))) {
            await db.pool.query(
                `INSERT INTO settings (key, value, updated_at) VALUES ('smtp_legacy_migrated', 'false', NOW())
                 ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW()`
            );
            emailService.resetTransporter();
        }

        if (savedKeys.some(isSessionMaintenanceSettingKey)) {
            try {
                await req.app.locals.autoRecorder?.refreshSessionMaintenanceConfig?.('admin-settings-save');
            } catch (refreshErr) {
                console.error('[Admin] Refresh session maintenance config error:', refreshErr.message);
            }
        }

        let warning = '';
        if (savedKeys.some(key => SCHEME_A_RUNTIME_SETTING_KEYS.includes(key))) {
            try {
                await req.app.locals.refreshSchemeARuntimeConfig?.('admin-settings-save');
            } catch (refreshErr) {
                console.error('[Admin] Refresh scheme A runtime config error:', refreshErr.message);
                warning = '设置已保存，但方案A运行时刷新失败，建议重启服务后再检查。';
            }
        }

        res.json({
            message: '设置已保存',
            savedKeys,
            preservedSecretKeys: incomingKeys.filter(key => shouldPreserveSecretSetting(key, normalizedSettings[key])),
            ...(warning ? { warning } : {}),
        });
    } catch (err) {
        console.error('[Admin] Save settings error:', err.message);
        res.status(500).json({ error: '保存失败' });
    }
});

router.post('/settings/redis/test', async (req, res) => {
    try {
        const redisUrl = String(req.body?.redisUrl || '').trim();
        const result = await testRedisConnection(redisUrl);
        if (!result.success) {
            return res.status(400).json(result);
        }
        return res.json({
            message: `Redis 可用，延迟 ${result.latencyMs}ms`,
            ...result,
        });
    } catch (err) {
        console.error('[Admin] Test Redis error:', err.message);
        return res.status(500).json({ error: 'Redis 测试失败' });
    }
});


router.get('/admin-access/me', async (req, res) => {
    try {
        res.json({
            access: {
                userId: Number(req.user.id || 0),
                role: req.user.role,
                adminRoleCode: req.user.adminRoleCode || '',
                adminRoleName: req.user.adminRoleName || '',
                isSuperAdmin: Boolean(req.user.isSuperAdmin),
                permissions: Array.isArray(req.user.permissions) ? req.user.permissions : [],
            },
            permissionGroups: ADMIN_PERMISSION_GROUPS,
            allPermissions: ALL_ADMIN_PERMISSION_KEYS,
        });
    } catch (err) {
        console.error('[Admin] Load RBAC profile error:', err.message);
        res.status(500).json({ error: '获取管理员权限信息失败' });
    }
});

router.get('/admin-access/roles', async (req, res) => {
    try {
        const roles = await listAdminRoles();
        res.json({ roles, permissionGroups: ADMIN_PERMISSION_GROUPS, allPermissions: ALL_ADMIN_PERMISSION_KEYS });
    } catch (err) {
        console.error('[Admin] Load admin roles error:', err.message);
        res.status(500).json({ error: '获取管理员角色失败' });
    }
});

router.post('/admin-access/roles', async (req, res) => {
    try {
        const role = await createAdminRole(req.body || {});
        res.json({ message: '管理员角色已创建', role });
    } catch (err) {
        console.error('[Admin] Create admin role error:', err.message);
        res.status(500).json({ error: err.message || '创建管理员角色失败' });
    }
});

router.put('/admin-access/roles/:id', async (req, res) => {
    try {
        const roleId = parseInt(req.params.id, 10);
        if (!Number.isInteger(roleId) || roleId <= 0) {
            return res.status(400).json({ error: '角色ID无效' });
        }
        const role = await updateAdminRole(roleId, req.body || {});
        res.json({ message: '管理员角色已更新', role });
    } catch (err) {
        console.error('[Admin] Update admin role error:', err.message);
        res.status(500).json({ error: err.message || '更新管理员角色失败' });
    }
});

router.delete('/admin-access/roles/:id', async (req, res) => {
    try {
        const roleId = parseInt(req.params.id, 10);
        if (!Number.isInteger(roleId) || roleId <= 0) {
            return res.status(400).json({ error: '角色ID无效' });
        }
        await deleteAdminRole(roleId);
        res.json({ message: '管理员角色已删除' });
    } catch (err) {
        console.error('[Admin] Delete admin role error:', err.message);
        res.status(500).json({ error: err.message || '删除管理员角色失败' });
    }
});

router.get('/admin-access/admins', async (req, res) => {
    try {
        const admins = await listAdminUsers();
        res.json({ admins });
    } catch (err) {
        console.error('[Admin] Load admin users error:', err.message);
        res.status(500).json({ error: '获取管理员列表失败' });
    }
});

router.get('/admin-access/candidates', async (req, res) => {
    try {
        const candidates = await searchAdminCandidates(req.query.keyword || req.query.q || '', req.query.limit || 10);
        res.json({ candidates });
    } catch (err) {
        console.error('[Admin] Search admin candidates error:', err.message);
        res.status(500).json({ error: '搜索候选用户失败' });
    }
});

router.put('/admin-access/admins/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        const roleId = parseInt(req.body?.roleId, 10);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ error: '用户ID无效' });
        }
        if (!Number.isInteger(roleId) || roleId <= 0) {
            return res.status(400).json({ error: '角色ID无效' });
        }
        if (userId === Number(req.user.id)) {
            return res.status(400).json({ error: '暂不支持修改自己的管理员角色，请让其他超级管理员处理' });
        }
        const role = await upsertAdminUserRole({ userId, roleId, actorId: req.user.id });
        res.json({ message: '管理员角色已分配', role });
    } catch (err) {
        console.error('[Admin] Assign admin role error:', err.message);
        res.status(500).json({ error: err.message || '分配管理员角色失败' });
    }
});

router.delete('/admin-access/admins/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ error: '用户ID无效' });
        }
        if (userId === Number(req.user.id)) {
            return res.status(400).json({ error: '不能移除自己的管理员权限' });
        }
        await revokeAdminUser({ userId, actorId: req.user.id });
        res.json({ message: '管理员权限已移除' });
    } catch (err) {
        console.error('[Admin] Revoke admin role error:', err.message);
        res.status(500).json({ error: err.message || '移除管理员权限失败' });
    }
});

router.get('/session-maintenance/config', async (req, res) => {
    try {
        const overview = await getSessionMaintenanceOverview();
        res.json({
            config: overview.config,
            defaults: overview.defaults,
            settingDefs: overview.settingDefs,
        });
    } catch (err) {
        console.error('[Admin] Load session maintenance config error:', err.message);
        res.status(500).json({ error: '获取场次运维配置失败' });
    }
});

router.put('/session-maintenance/config', async (req, res) => {
    try {
        const settings = req.body?.config || req.body?.settings;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: '无效的配置数据' });
        }

        const config = await saveSessionMaintenanceConfig(settings);

        try {
            await req.app.locals.autoRecorder?.refreshSessionMaintenanceConfig?.('admin-session-maintenance-save');
        } catch (refreshErr) {
            console.error('[Admin] Refresh session maintenance config error:', refreshErr.message);
        }

        res.json({ message: '场次运维配置已保存', config });
    } catch (err) {
        console.error('[Admin] Save session maintenance config error:', err.message);
        res.status(500).json({ error: '保存场次运维配置失败' });
    }
});

router.get('/session-maintenance/overview', async (req, res) => {
    try {
        const overview = await getSessionMaintenanceOverview();
        const runtime = req.app.locals.autoRecorder?.getSessionMaintenanceRuntimeSnapshot?.() || {};
        res.json({
            ...overview,
            runtime,
            pendingArchives: runtime.pendingArchives ?? 0,
            scheduler: runtime.scheduler || {},
            latestRuns: overview.latestRuns || overview.latestLogs || [],
        });
    } catch (err) {
        console.error('[Admin] Load session maintenance overview error:', err.message);
        res.status(500).json({ error: '获取场次运维概览失败' });
    }
});

router.get('/session-maintenance/logs', async (req, res) => {
    try {
        const logs = await listSessionMaintenanceLogs({
            limit: req.query.limit,
            taskKey: req.query.taskKey,
            status: req.query.status,
            roomId: req.query.roomId,
        });
        res.json({ logs });
    } catch (err) {
        console.error('[Admin] Load session maintenance logs error:', err.message);
        res.status(500).json({ error: '获取场次运维日志失败' });
    }
});

router.post('/session-maintenance/actions/:action', async (req, res) => {
    try {
        const taskKey = SESSION_MAINTENANCE_ACTION_ALIASES[req.params.action];
        if (!taskKey) {
            return res.status(404).json({ error: '未知的场次运维动作' });
        }

        const queuedJob = await enqueueSessionMaintenanceJob(taskKey, {
            source: 'admin-panel-manual',
            createdByUserId: req.user?.id,
            roomId: req.body?.roomId,
            gapMinutes: req.body?.gapMinutes,
            lookbackHours: req.body?.lookbackHours,
        });

        return res.status(202).json({
            success: true,
            accepted: true,
            queued: queuedJob.queued,
            processing: queuedJob.processing,
            reused: queuedJob.reused,
            taskKey,
            job: queuedJob.job,
            message: queuedJob.reused
                ? '已有同类场次运维任务在后台执行，请稍后刷新运维日志查看结果。'
                : '场次运维任务已加入后台队列，请稍后刷新运维日志查看结果。',
        });
    } catch (err) {
        console.error('[Admin] Run session maintenance action error:', err.message);
        res.status(500).json({ error: err.message || '执行场次运维动作失败' });
    }
});

router.get('/prompt-templates', async (req, res) => {
    try {
        const templates = await listPromptTemplates();
        res.json({ templates });
    } catch (err) {
        console.error('[Admin] Load prompt templates error:', err.message);
        res.status(500).json({ error: '获取提示词失败' });
    }
});

router.put('/prompt-templates/:key', [
    body('content').isString().isLength({ min: 20, max: 30000 }).withMessage('提示词内容长度需在 20-30000 字符之间')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const templateKey = String(req.params.key || '').trim();
        if (!getPromptTemplateDefinition(templateKey)) {
            return res.status(404).json({ error: '提示词不存在' });
        }

        const template = await savePromptTemplate(templateKey, req.body.content);
        res.json({ message: '提示词已保存', template });
    } catch (err) {
        console.error('[Admin] Save prompt template error:', err.message);
        res.status(500).json({ error: '保存提示词失败' });
    }
});

router.post('/prompt-templates/:key/reset', async (req, res) => {
    try {
        const templateKey = String(req.params.key || '').trim();
        if (!getPromptTemplateDefinition(templateKey)) {
            return res.status(404).json({ error: '提示词不存在' });
        }

        const template = await resetPromptTemplate(templateKey);
        res.json({ message: '已恢复默认提示词', template });
    } catch (err) {
        console.error('[Admin] Reset prompt template error:', err.message);
        res.status(500).json({ error: '恢复默认失败' });
    }
});


// ==================== AI Work Center ====================

router.get('/ai-work/jobs', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const status = String(req.query.status || '').trim();
        const jobType = String(req.query.jobType || '').trim();
        const search = String(req.query.search || '').trim();
        const userId = req.query.userId ? Number(req.query.userId) : null;
        const result = await listAdminAiWorkJobs({ page, limit, status, jobType, search, userId });
        res.json(result);
    } catch (err) {
        console.error('[Admin] Load AI work jobs error:', err.message);
        res.status(500).json({ error: '获取 AI 工作列表失败' });
    }
});

router.get('/ai-work/jobs/:id', async (req, res) => {
    try {
        const jobId = Number(req.params.id || 0);
        if (!jobId) return res.status(400).json({ error: '任务ID无效' });
        const detail = await getAdminAiWorkJobDetail(jobId);
        if (!detail) return res.status(404).json({ error: '任务不存在' });
        res.json(detail);
    } catch (err) {
        console.error('[Admin] Load AI work job detail error:', err.message);
        res.status(500).json({ error: '获取 AI 工作详情失败' });
    }
});

// ==================== Euler API Keys ====================

/**
 * GET /api/admin/euler-keys
 */
router.get('/euler-keys', async (req, res) => {
    try {
        const rows = await db.all('SELECT id, name, key_value, is_active, call_count, last_used_at, last_error, last_status, created_at, premium_room_lookup_level, premium_room_lookup_state, premium_room_lookup_checked_at, premium_room_lookup_last_status, premium_room_lookup_last_error, premium_room_lookup_probe_unique_id FROM euler_api_keys ORDER BY id');
        const keys = rows.map(serializeAdminEulerKey);
        const settings = await manager.getAllSettings();
        const baseRuntimeStatus = keyManager.getStatus();
        const runtimeStatus = {
            ...baseRuntimeStatus,
            lastEvaluatedAt: new Date().toISOString(),
            settingsListConfigured: Boolean(String(settings?.euler_keys || '').trim()),
            legacySingleKeyConfigured: Boolean(String(settings?.euler_api_key || '').trim()),
            envListConfigured: Boolean(String(process.env.EULER_KEYS || '').trim()),
            envSingleKeyConfigured: Boolean(String(process.env.EULER_API_KEY || '').trim()),
            premiumRoomLookupManagementMode: 'manual',
            premiumRoomLookupDisabledByEnv: String(process.env.EULER_DISABLE_PREMIUM_ROOM_LOOKUP || '').trim().toLowerCase() === 'true',
        };
        res.json({ keys, runtimeStatus });
    } catch (err) {
        console.error('[Admin] Euler keys error:', err.message);
        res.status(500).json({ error: '获取 Euler Keys 失败' });
    }
});

/**
 * POST /api/admin/euler-keys
 */
router.post('/euler-keys', [
    body('keyValue').trim().notEmpty().withMessage('API Key 不能为空'),
    body('name').optional().trim(),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        const { keyValue, name } = req.body;
        const premiumRoomLookupLevel = normalizePremiumRoomLookupLevel(req.body?.premiumRoomLookupLevel || PREMIUM_ROOM_LOOKUP_LEVELS.BASIC);
        // Check duplicate
        const existing = await db.get('SELECT id FROM euler_api_keys WHERE key_value = ?', [keyValue.trim()]);
        if (existing) return res.status(409).json({ error: '该 Key 已存在' });

        await db.run(
            'INSERT INTO euler_api_keys (key_value, name, is_active, premium_room_lookup_level, premium_room_lookup_state) VALUES (?, ?, ?, ?, ?)',
            [keyValue.trim(), name || '', req.body?.isActive !== false, premiumRoomLookupLevel, derivePremiumRoomLookupStateFromLevel(premiumRoomLookupLevel)]
        );
        await keyManager.refreshKeys({});
        res.status(201).json({ message: 'Key 添加成功' });
    } catch (err) {
        console.error('[Admin] Add Euler key error:', err.message);
        res.status(500).json({ error: '添加失败' });
    }
});

/**
 * PUT /api/admin/euler-keys/:id
 */
router.put('/euler-keys/:id', async (req, res) => {
    try {
        const { name, isActive } = req.body;
        const premiumRoomLookupLevel = req.body?.premiumRoomLookupLevel !== undefined
            ? normalizePremiumRoomLookupLevel(req.body?.premiumRoomLookupLevel)
            : null;
        const updates = [];
        const params = [];
        let idx = 0;

        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }
        if (premiumRoomLookupLevel !== null) {
            updates.push(`premium_room_lookup_level = $${++idx}`);
            params.push(premiumRoomLookupLevel);
            updates.push(`premium_room_lookup_state = $${++idx}`);
            params.push(derivePremiumRoomLookupStateFromLevel(premiumRoomLookupLevel));
            updates.push(`premium_room_lookup_checked_at = NULL`);
            updates.push(`premium_room_lookup_last_status = NULL`);
            updates.push(`premium_room_lookup_last_error = NULL`);
            updates.push(`premium_room_lookup_probe_unique_id = NULL`);
        }

        if (updates.length === 0) return res.status(400).json({ error: '无更新' });

        updates.push('updated_at = NOW()');
        params.push(req.params.id);
        await db.pool.query(`UPDATE euler_api_keys SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);

        if (premiumRoomLookupLevel !== null && premiumRoomLookupLevel !== PREMIUM_ROOM_LOOKUP_LEVELS.PREMIUM) {
            await db.pool.query(
                `UPDATE euler_api_keys
                    SET last_error = NULL,
                        last_status = CASE WHEN COALESCE(last_status, 'unknown') = 'error' THEN 'ok' ELSE last_status END,
                        updated_at = NOW()
                  WHERE id = $1
                    AND (
                        LOWER(COALESCE(last_error, '')) LIKE '%euler room lookup%'
                        OR LOWER(COALESCE(last_error, '')) LIKE '%euler live status lookup%'
                        OR LOWER(COALESCE(last_error, '')) LIKE '%premium room lookup%'
                    )`,
                [req.params.id]
            ).catch(() => {});
        }

        await keyManager.refreshKeys({});
        res.json({ message: '更新成功' });
    } catch (err) {
        res.status(500).json({ error: '更新失败' });
    }
});

/**
 * DELETE /api/admin/euler-keys/:id
 */
router.delete('/euler-keys/:id', async (req, res) => {
    try {
        await db.run('DELETE FROM euler_api_keys WHERE id = ?', [req.params.id]);
        await keyManager.refreshKeys({});
        res.json({ message: '已删除' });
    } catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});

/**
 * POST /api/admin/euler-keys/:id/test - Test a specific key
 */
router.post('/euler-keys/:id/test', async (req, res) => {
    try {
        const key = await db.get('SELECT * FROM euler_api_keys WHERE id = ?', [req.params.id]);
        if (!key) return res.status(404).json({ error: 'Key 不存在' });

        // Test: call Euler sign API with a dummy request to verify key validity
        const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
        const startTime = Date.now();
        // Use the actual Euler sign API endpoint (tiktok.eulerstream.com)
        const response = await fetch('https://tiktok.eulerstream.com/webcast/rate_limits', {
            headers: { 'apiKey': key.keyValue },
            signal: AbortSignal.timeout(10000),
        });
        const latency = Date.now() - startTime;
        const bodyText = await response.text().catch(() => '');

        // Euler API returns various status codes:
        // 200 = key valid, 401/403 = key invalid, others = network issue
        if (response.status === 200 || response.status === 404) {
            // 200 or 404 both mean the API server responded, key is accepted
            await db.run(
                `UPDATE euler_api_keys SET last_status = 'ok', last_error = NULL, last_used_at = NOW(), updated_at = NOW() WHERE id = ?`,
                [req.params.id]
            );
            res.json({ success: true, latency, status: response.status });
        } else if (response.status === 401 || response.status === 403) {
            await db.run(
                `UPDATE euler_api_keys SET last_status = 'error', last_error = 'Key 无效或已过期', last_used_at = NOW(), updated_at = NOW() WHERE id = ?`,
                [req.params.id]
            );
            res.json({ success: false, latency, status: response.status, error: 'Key 无效或已过期' });
        } else if (response.status === 429) {
            await db.run(
                `UPDATE euler_api_keys SET last_status = 'ok', last_error = ?, last_used_at = NOW(), updated_at = NOW() WHERE id = ?`,
                ['Key 当前被限流 (429)', req.params.id]
            );
            res.json({ success: false, transient: true, latency, status: response.status, error: 'Key 有效，但当前接口被限流 (429)' });
        } else {
            await db.run(
                `UPDATE euler_api_keys SET last_status = 'error', last_error = ?, last_used_at = NOW(), updated_at = NOW() WHERE id = ?`,
                [`HTTP ${response.status}: ${bodyText.slice(0, 200)}`, req.params.id]
            );
            res.json({ success: false, latency, status: response.status, error: `HTTP ${response.status}` });
        }
    } catch (err) {
        await db.run(
            `UPDATE euler_api_keys SET last_status = 'error', last_error = ?, updated_at = NOW() WHERE id = ?`,
            [err.message.slice(0, 200), req.params.id]
        );
        res.json({ success: false, error: err.message });
    }
});


/**
 * POST /api/admin/euler-keys/:id/test-room-lookup - Probe premium room lookup capability for a specific key
 */
router.post('/euler-keys/:id/test-room-lookup', async (req, res) => {
    return res.status(410).json({
        success: false,
        error: 'Premium 自动探测已停用，请直接在后台编辑该 Key 的等级。',
    });
});

// ==================== AI Channels & Models ====================

/**
 * GET /api/admin/ai-channels - list channels with their models
 */
router.get('/ai-channels', async (req, res) => {
    try {
        const channels = await db.all(
            `SELECT id, name, api_url, api_key, is_active, created_at, updated_at
             FROM ai_channels
             ORDER BY id`
        );
        const models = await db.all(
            `SELECT id, channel_id, name, model_id, is_active, is_default,
                    call_count, success_count, fail_count, consecutive_failures,
                    avg_latency_ms, last_used_at, cooldown_until, last_error,
                    last_status, created_at, updated_at
             FROM ai_models
             ORDER BY channel_id, is_default DESC, id`
        );
        // Group models under channels
        const result = channels.map(ch => ({
            ...ch,
            models: models.filter(m => m.channelId === ch.id).map(serializeAdminAiModel)
        }));
        res.json({
            channels: result,
            fallbackPolicy: {
                strategy: 'recent_failure_cooldown',
                cooldownMs: AI_MODEL_FAILURE_COOLDOWN_MS
            }
        });
    } catch (err) {
        console.error('[Admin] AI channels error:', err.message);
        res.status(500).json({ error: '获取 AI 通道列表失败' });
    }
});

/** POST /api/admin/ai-channels - create channel */
router.post('/ai-channels', [
    body('name').trim().notEmpty().withMessage('名称不能为空'),
    body('apiUrl').trim().notEmpty().withMessage('API地址不能为空'),
    body('apiKey').trim().notEmpty().withMessage('API Key不能为空'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
        const { name, apiUrl, apiKey } = req.body;
        await db.run('INSERT INTO ai_channels (name, api_url, api_key) VALUES (?, ?, ?)', [name, apiUrl, apiKey]);
        res.status(201).json({ message: '通道创建成功' });
    } catch (err) {
        res.status(500).json({ error: '创建失败' });
    }
});

/** PUT /api/admin/ai-channels/:id */
router.put('/ai-channels/:id', async (req, res) => {
    try {
        const { name, apiUrl, apiKey, isActive } = req.body;
        const updates = []; const params = []; let idx = 0;
        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (apiUrl !== undefined) { updates.push(`api_url = $${++idx}`); params.push(apiUrl); }
        if (apiKey !== undefined) { updates.push(`api_key = $${++idx}`); params.push(apiKey); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }
        if (updates.length === 0) return res.status(400).json({ error: '无更新' });
        updates.push('updated_at = NOW()');
        params.push(req.params.id);
        await db.pool.query(`UPDATE ai_channels SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);
        res.json({ message: '更新成功' });
    } catch (err) { res.status(500).json({ error: '更新失败' }); }
});

/** DELETE /api/admin/ai-channels/:id */
router.delete('/ai-channels/:id', async (req, res) => {
    try {
        await db.run('DELETE FROM ai_channels WHERE id = ?', [req.params.id]);
        res.json({ message: '通道已删除（包含其下所有模型）' });
    } catch (err) { res.status(500).json({ error: '删除失败' }); }
});

/** POST /api/admin/ai-channels/:channelId/models - add model to channel */
router.post('/ai-channels/:channelId/models', [
    body('name').trim().notEmpty().withMessage('名称不能为空'),
    body('modelId').trim().notEmpty().withMessage('模型ID不能为空'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
        const { name, modelId, isDefault } = req.body;
        // If setting as default, unset other defaults
        if (isDefault) {
            await db.run('UPDATE ai_models SET is_default = false WHERE is_default = true');
        }
        await db.run(
            'INSERT INTO ai_models (channel_id, name, model_id, is_default) VALUES (?, ?, ?, ?)',
            [req.params.channelId, name, modelId, isDefault || false]
        );
        res.status(201).json({ message: '模型添加成功' });
    } catch (err) { res.status(500).json({ error: '添加失败' }); }
});

/** PUT /api/admin/ai-models/:id */
router.put('/ai-models/:id', async (req, res) => {
    try {
        const { name, modelId, isActive, isDefault } = req.body;
        const updates = []; const params = []; let idx = 0;
        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (modelId !== undefined) { updates.push(`model_id = $${++idx}`); params.push(modelId); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }
        if (isDefault !== undefined) {
            if (isDefault) await db.run('UPDATE ai_models SET is_default = false WHERE is_default = true');
            updates.push(`is_default = $${++idx}`); params.push(isDefault);
        }
        if (updates.length === 0) return res.status(400).json({ error: '无更新' });
        updates.push('updated_at = NOW()');
        params.push(req.params.id);
        await db.pool.query(`UPDATE ai_models SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);
        res.json({ message: '更新成功' });
    } catch (err) { res.status(500).json({ error: '更新失败' }); }
});

/** POST /api/admin/ai-models/:id/set-default */
router.post('/ai-models/:id/set-default', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const model = await db.get(
            `SELECT m.id, m.is_active, c.is_active AS channel_is_active
             FROM ai_models m
             JOIN ai_channels c ON c.id = m.channel_id
             WHERE m.id = ?`,
            [req.params.id]
        );
        if (!model) return res.status(404).json({ error: '模型不存在' });
        if (!model.isActive) return res.status(400).json({ error: '请先启用该模型，再设为默认' });
        if (!model.channelIsActive) return res.status(400).json({ error: '该模型所属通道已禁用，请先启用通道' });

        await client.query('BEGIN');
        await client.query(`UPDATE ai_models SET is_default = false, updated_at = NOW() WHERE is_default = true`);
        await client.query(`UPDATE ai_models SET is_default = true, updated_at = NOW() WHERE id = $1`, [req.params.id]);
        await client.query('COMMIT');

        res.json({ message: '默认模型已更新' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: '设置默认模型失败' });
    } finally {
        client.release();
    }
});

/** DELETE /api/admin/ai-models/:id */
router.delete('/ai-models/:id', async (req, res) => {
    try {
        await db.run('DELETE FROM ai_models WHERE id = ?', [req.params.id]);
        res.json({ message: '模型已删除' });
    } catch (err) { res.status(500).json({ error: '删除失败' }); }
});

/** POST /api/admin/ai-models/:id/test - Test model via its channel */
router.post('/ai-models/:id/test', async (req, res) => {
    try {
        const model = await db.get(
            `SELECT m.*, c.api_url, c.api_key FROM ai_models m JOIN ai_channels c ON m.channel_id = c.id WHERE m.id = ?`,
            [req.params.id]
        );
        if (!model) return res.status(404).json({ error: '模型不存在' });

        const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
        const startTime = Date.now();
        const baseUrl = model.apiUrl.endsWith('/') ? model.apiUrl : model.apiUrl + '/';
        const response = await fetch(`${baseUrl}chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${model.apiKey}` },
            body: JSON.stringify({
                model: model.modelId,
                messages: [{ role: 'user', content: 'Hi, respond with just "ok".' }],
                max_tokens: 10, stream: false,
            }),
            timeout: 30000,
        });
        const latency = Date.now() - startTime;

        if (response.ok) {
            const data = await response.json();
            const reply = data.choices?.[0]?.message?.content || '';
            await db.run(
                `UPDATE ai_models
                 SET last_status = 'ok', last_error = NULL, last_used_at = NOW(),
                     avg_latency_ms = ?, consecutive_failures = 0, cooldown_until = NULL, updated_at = NOW()
                 WHERE id = ?`,
                [latency, req.params.id]
            );
            res.json({ success: true, latency, reply: reply.slice(0, 100) });
        } else {
            const errText = await response.text().catch(() => '');
            const cooldownUntil = new Date(Date.now() + AI_MODEL_FAILURE_COOLDOWN_MS).toISOString();
            await db.run(
                `UPDATE ai_models
                 SET last_status = 'error', last_error = ?, last_used_at = NOW(),
                     consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
                     cooldown_until = ?, updated_at = NOW()
                 WHERE id = ?`,
                [`HTTP ${response.status}: ${errText.slice(0, 200)}`, cooldownUntil, req.params.id]
            );
            res.json({ success: false, latency, status: response.status, error: errText.slice(0, 200) });
        }
    } catch (err) {
        const cooldownUntil = new Date(Date.now() + AI_MODEL_FAILURE_COOLDOWN_MS).toISOString();
        await db.run(
            `UPDATE ai_models
             SET last_status = 'error', last_error = ?,
                 consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
                 cooldown_until = ?, updated_at = NOW()
             WHERE id = ?`,
            [err.message.slice(0, 200), cooldownUntil, req.params.id]
        );
        res.json({ success: false, error: err.message });
    }
});

// ==================== AI Credit Packages ====================

function serializeAiCreditPackage(row) {
    const priceYuan = Math.round(Number(row?.priceCents || 0) / 100);
    return {
        id: row.id,
        name: row.name,
        credits: Number(row.credits || 0),
        priceYuan,
        description: row.description || '',
        isActive: Boolean(row.isActive),
        createdAt: row.createdAt || null
    };
}

/** GET /api/admin/ai-credit-packages */
router.get('/ai-credit-packages', async (req, res) => {
    try {
        const packages = await db.all(
            'SELECT id, name, credits, price_cents, description, is_active, created_at FROM ai_credit_packages ORDER BY credits'
        );
        res.json({ packages: packages.map(serializeAiCreditPackage) });
    } catch (err) { res.status(500).json({ error: '获取失败' }); }
});

/** POST /api/admin/ai-credit-packages */
router.post('/ai-credit-packages', [
    body('name').trim().notEmpty(),
    body('credits').isInt({ min: 1 }),
    body('priceYuan').isInt({ min: 0 }).withMessage('价格必须是非负整数元'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    try {
        const { name, credits, priceYuan, description } = req.body;
        await db.run(
            'INSERT INTO ai_credit_packages (name, credits, price_cents, description) VALUES (?, ?, ?, ?)',
            [name, credits, Number(priceYuan) * 100, description || '']
        );
        res.status(201).json({ message: '创建成功' });
    } catch (err) { res.status(500).json({ error: '创建失败' }); }
});

/** PUT /api/admin/ai-credit-packages/:id */
router.put('/ai-credit-packages/:id', async (req, res) => {
    try {
        const { name, credits, priceYuan, description, isActive } = req.body;
        const updates = []; const params = []; let idx = 0;
        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (credits !== undefined) { updates.push(`credits = $${++idx}`); params.push(credits); }
        if (priceYuan !== undefined) {
            const normalizedPriceYuan = Number(priceYuan);
            if (!Number.isInteger(normalizedPriceYuan) || normalizedPriceYuan < 0) {
                return res.status(400).json({ error: '价格必须是非负整数元' });
            }
            updates.push(`price_cents = $${++idx}`);
            params.push(normalizedPriceYuan * 100);
        }
        if (description !== undefined) { updates.push(`description = $${++idx}`); params.push(description); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }
        if (updates.length === 0) return res.status(400).json({ error: '无更新' });
        params.push(req.params.id);
        await db.pool.query(`UPDATE ai_credit_packages SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);
        res.json({ message: '更新成功' });
    } catch (err) { res.status(500).json({ error: '更新失败' }); }
});

/** DELETE /api/admin/ai-credit-packages/:id */
router.delete('/ai-credit-packages/:id', async (req, res) => {
    try {
        await db.run('UPDATE ai_credit_packages SET is_active = false WHERE id = ?', [req.params.id]);
        res.json({ message: '已下架' });
    } catch (err) { res.status(500).json({ error: '操作失败' }); }
});

// ==================== SMTP Configuration ====================

function smtpValidationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function parseSmtpServicePayload(payload = {}, { requireAll = false } = {}) {
    const result = {};

    if (requireAll || Object.prototype.hasOwnProperty.call(payload, 'name')) {
        const name = String(payload.name || '').trim();
        if (!name) throw smtpValidationError('服务名称不能为空');
        result.name = name;
    }
    if (requireAll || Object.prototype.hasOwnProperty.call(payload, 'host')) {
        const host = String(payload.host || '').trim();
        if (!host) throw smtpValidationError('SMTP 服务器不能为空');
        result.host = host;
    }
    if (requireAll || Object.prototype.hasOwnProperty.call(payload, 'port')) {
        const port = parseInt(payload.port, 10);
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
            throw smtpValidationError('SMTP 端口无效');
        }
        result.port = port;
    }
    if (requireAll || Object.prototype.hasOwnProperty.call(payload, 'secure')) {
        result.secure = payload.secure === undefined
            ? true
            : payload.secure === true || payload.secure === 'true' || payload.secure === 1 || payload.secure === '1';
    }
    if (requireAll || Object.prototype.hasOwnProperty.call(payload, 'username')) {
        const username = String(payload.username || '').trim();
        if (!username) throw smtpValidationError('SMTP 用户名不能为空');
        result.username = username;
    }
    if (requireAll || Object.prototype.hasOwnProperty.call(payload, 'password')) {
        const password = String(payload.password || '');
        if (!password) throw smtpValidationError('SMTP 密码/授权码不能为空');
        result.password = password;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'fromEmail')) {
        result.fromEmail = String(payload.fromEmail || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'fromName')) {
        result.fromName = String(payload.fromName || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'isActive')) {
        result.isActive = payload.isActive === true || payload.isActive === 'true' || payload.isActive === 1 || payload.isActive === '1';
    }

    return result;
}

router.get('/smtp/services', async (req, res) => {
    try {
        const [services, emailSettings] = await Promise.all([
            emailService.listSmtpServices(),
            emailService.getEmailFeatureConfig(),
        ]);
        res.json({
            services: services.map(serializeAdminSmtpService),
            emailSettings,
            fallbackPolicy: {
                strategy: 'default_then_failover',
                cooldownMs: emailService.SMTP_FAILURE_COOLDOWN_MS,
            },
        });
    } catch (err) {
        console.error('[Admin] SMTP services error:', err.message);
        res.status(500).json({ error: '获取邮箱服务失败' });
    }
});

router.put('/smtp/settings', async (req, res) => {
    try {
        if (typeof req.body?.emailVerificationEnabled !== 'boolean') {
            return res.status(400).json({ error: '邮箱验证开关参数无效' });
        }

        await emailService.saveEmailFeatureConfig({
            emailVerificationEnabled: req.body.emailVerificationEnabled,
        });

        res.json({ message: '邮件策略已保存' });
    } catch (err) {
        console.error('[Admin] Save SMTP settings error:', err.message);
        res.status(500).json({ error: '保存邮件策略失败' });
    }
});

router.post('/smtp/services', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const payload = parseSmtpServicePayload(req.body, { requireAll: true });
        const requestedDefault = req.body?.setAsDefault === true || req.body?.setAsDefault === 'true';
        const isActive = payload.isActive !== false;

        if (requestedDefault && !isActive) {
            return res.status(400).json({ error: '禁用服务不能设为默认' });
        }

        await client.query('BEGIN');
        const defaultRow = await client.query(`SELECT id FROM smtp_services WHERE is_default = true LIMIT 1`);
        const shouldSetDefault = requestedDefault || (!defaultRow.rows.length && isActive);
        if (shouldSetDefault) {
            await client.query(`UPDATE smtp_services SET is_default = false, updated_at = NOW() WHERE is_default = true`);
        }

        const insertRes = await client.query(
            `INSERT INTO smtp_services (
                name, host, port, secure, username, password, from_email, from_name, is_active, is_default, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             RETURNING id`,
            [
                payload.name,
                payload.host,
                payload.port,
                payload.secure,
                payload.username,
                payload.password,
                payload.fromEmail || payload.username,
                payload.fromName || 'TikTok Monitor',
                isActive,
                shouldSetDefault,
            ]
        );

        await client.query('COMMIT');
        emailService.resetTransporter();
        res.status(201).json({ message: '邮箱服务创建成功', id: insertRes.rows[0].id });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Admin] Create SMTP service error:', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || '创建邮箱服务失败' });
    } finally {
        client.release();
    }
});

router.put('/smtp/services/:id', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const existing = await client.query(`SELECT id, is_default, is_active FROM smtp_services WHERE id = $1`, [req.params.id]);
        if (!existing.rows[0]) {
            return res.status(404).json({ error: '邮箱服务不存在' });
        }

        const payload = parseSmtpServicePayload(req.body, { requireAll: false });
        const updates = [];
        const params = [];
        let index = 0;

        if (payload.name !== undefined) { updates.push(`name = $${++index}`); params.push(payload.name); }
        if (payload.host !== undefined) { updates.push(`host = $${++index}`); params.push(payload.host); }
        if (payload.port !== undefined) { updates.push(`port = $${++index}`); params.push(payload.port); }
        if (payload.secure !== undefined) { updates.push(`secure = $${++index}`); params.push(payload.secure); }
        if (payload.username !== undefined) { updates.push(`username = $${++index}`); params.push(payload.username); }
        if (payload.password !== undefined) { updates.push(`password = $${++index}`); params.push(payload.password); }
        if (payload.fromEmail !== undefined) { updates.push(`from_email = $${++index}`); params.push(payload.fromEmail || payload.username || null); }
        if (payload.fromName !== undefined) { updates.push(`from_name = $${++index}`); params.push(payload.fromName || 'TikTok Monitor'); }
        if (payload.isActive !== undefined) { updates.push(`is_active = $${++index}`); params.push(payload.isActive); }
        if (!updates.length) {
            return res.status(400).json({ error: '没有可更新的字段' });
        }

        await client.query('BEGIN');
        updates.push('updated_at = NOW()');
        params.push(req.params.id);
        await client.query(`UPDATE smtp_services SET ${updates.join(', ')} WHERE id = $${index + 1}`, params);

        if (payload.isActive === false && existing.rows[0].is_default) {
            await promoteNextDefaultSmtpService(client, Number(req.params.id));
        }

        await client.query('COMMIT');
        emailService.resetTransporter(req.params.id);
        res.json({ message: '邮箱服务已更新' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Admin] Update SMTP service error:', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || '更新邮箱服务失败' });
    } finally {
        client.release();
    }
});

router.post('/smtp/services/:id/set-default', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const service = await client.query(
            `SELECT id, is_active FROM smtp_services WHERE id = $1`,
            [req.params.id]
        );
        if (!service.rows[0]) return res.status(404).json({ error: '邮箱服务不存在' });
        if (!service.rows[0].is_active) return res.status(400).json({ error: '请先启用该邮箱服务，再设为默认' });

        await client.query('BEGIN');
        await client.query(`UPDATE smtp_services SET is_default = false, updated_at = NOW() WHERE is_default = true`);
        await client.query(`UPDATE smtp_services SET is_default = true, updated_at = NOW() WHERE id = $1`, [req.params.id]);
        await client.query('COMMIT');

        emailService.resetTransporter();
        res.json({ message: '默认邮箱服务已更新' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Admin] Set default SMTP service error:', err.message);
        res.status(500).json({ error: '设置默认邮箱服务失败' });
    } finally {
        client.release();
    }
});

router.delete('/smtp/services/:id', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const existing = await client.query(`SELECT id, is_default FROM smtp_services WHERE id = $1`, [req.params.id]);
        if (!existing.rows[0]) {
            return res.status(404).json({ error: '邮箱服务不存在' });
        }

        await client.query('BEGIN');
        await client.query(`DELETE FROM smtp_services WHERE id = $1`, [req.params.id]);
        if (existing.rows[0].is_default) {
            await promoteNextDefaultSmtpService(client, Number(req.params.id));
        }
        await client.query('COMMIT');

        emailService.resetTransporter(req.params.id);
        res.json({ message: '邮箱服务已删除' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Admin] Delete SMTP service error:', err.message);
        res.status(500).json({ error: '删除邮箱服务失败' });
    } finally {
        client.release();
    }
});

router.post('/smtp/services/:id/test', async (req, res) => {
    try {
        emailService.resetTransporter(req.params.id);
        await emailService.testSmtp(req.params.id);
        res.json({ success: true, message: 'SMTP 连接成功' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

router.post('/smtp/services/:id/test-send', [
    body('email').isEmail().withMessage('请输入有效的邮箱地址'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        emailService.resetTransporter(req.params.id);
        await emailService.sendEmail(
            req.body.email,
            '测试邮件 - TikTok Monitor',
            '<h2>SMTP 配置测试成功</h2><p>如果您收到此邮件，说明该 SMTP 服务可正常发送邮件。</p>',
            { serviceId: req.params.id }
        );
        res.json({ success: true, message: '测试邮件已发送' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/smtp/test - Test current default SMTP connection
 */
router.post('/smtp/test', async (req, res) => {
    try {
        emailService.resetTransporter();
        await emailService.testSmtp();
        res.json({ success: true, message: 'SMTP 连接成功' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * POST /api/admin/smtp/test-send - Send test email with current default SMTP
 */
router.post('/smtp/test-send', [
    body('email').isEmail().withMessage('请输入有效的邮箱地址'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
        emailService.resetTransporter();
        await emailService.sendEmail(
            req.body.email,
            '测试邮件 - TikTok Monitor',
            '<h2>SMTP 配置测试成功</h2><p>如果您收到此邮件，说明当前默认 SMTP 服务可正常发送邮件。</p>'
        );
        res.json({ success: true, message: '测试邮件已发送' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

module.exports = router;
