const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { body, query: queryValidator, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const authService = require('../services/authService');
const balanceService = require('../services/balanceService');
const emailService = require('../services/emailService');
const quotaService = require('../services/quotaService');
const keyManager = require('../utils/keyManager');

const router = express.Router();

// All admin routes require authentication + admin role
router.use(authenticate, requireAdmin);

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
            'openRoomLimitPermanent',
            'openRoomLimitTemporary',
            'openRoomLimitTemporaryExpiresAt',
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
            if (hasOwn('openRoomLimitPermanent')) payload.open_room_limit_permanent = parseLimit(req.body.openRoomLimitPermanent, '永久可打开房间数');
            if (hasOwn('openRoomLimitTemporary')) payload.open_room_limit_temporary = parseLimit(req.body.openRoomLimitTemporary, '临时可打开房间数');
            if (hasOwn('openRoomLimitTemporaryExpiresAt')) payload.open_room_limit_temporary_expires_at = parseDate(req.body.openRoomLimitTemporaryExpiresAt, '可打开房间数临时到期时间');
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
        const plans = await db.all('SELECT * FROM subscription_plans ORDER BY sort_order');
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
        const { name, code, roomLimit, openRoomLimit, priceMonthly, priceQuarterly, priceAnnual, featureFlags, sortOrder, dailyRoomCreateLimit, aiCreditsMonthly } = req.body;

        const existing = await db.get('SELECT id FROM subscription_plans WHERE code = ?', [code]);
        if (existing) return res.status(409).json({ error: '套餐代码已存在' });

        await db.run(
            `INSERT INTO subscription_plans (name, code, room_limit, open_room_limit, price_monthly, price_quarterly, price_annual, feature_flags, sort_order, daily_room_create_limit, ai_credits_monthly)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, code, roomLimit, openRoomLimit !== undefined ? openRoomLimit : -1, Math.round(priceMonthly), Math.round(priceQuarterly), Math.round(priceAnnual), JSON.stringify(featureFlags || {}), sortOrder || 0, dailyRoomCreateLimit !== undefined ? dailyRoomCreateLimit : -1, aiCreditsMonthly || 0]
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
        const { name, roomLimit, openRoomLimit, priceMonthly, priceQuarterly, priceAnnual, featureFlags, sortOrder, isActive, dailyRoomCreateLimit } = req.body;
        const planId = req.params.id;

        const updates = [];
        const params = [];
        let idx = 0;

        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (roomLimit !== undefined) { updates.push(`room_limit = $${++idx}`); params.push(roomLimit); }
        if (openRoomLimit !== undefined) { updates.push(`open_room_limit = $${++idx}`); params.push(openRoomLimit); }
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
        res.json({ settings });
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

        for (const [key, value] of Object.entries(settings)) {
            await db.pool.query(
                `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
                [key, String(value)]
            );
        }

        res.json({ message: '设置已保存' });
    } catch (err) {
        console.error('[Admin] Save settings error:', err.message);
        res.status(500).json({ error: '保存失败' });
    }
});

// ==================== Euler API Keys ====================

/**
 * GET /api/admin/euler-keys
 */
router.get('/euler-keys', async (req, res) => {
    try {
        const keys = await db.all('SELECT id, name, key_value, is_active, call_count, last_used_at, last_error, last_status, created_at FROM euler_api_keys ORDER BY id');
        const runtimeStatus = keyManager.getStatus();
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
        // Check duplicate
        const existing = await db.get('SELECT id FROM euler_api_keys WHERE key_value = ?', [keyValue.trim()]);
        if (existing) return res.status(409).json({ error: '该 Key 已存在' });

        await db.run(
            'INSERT INTO euler_api_keys (key_value, name) VALUES (?, ?)',
            [keyValue.trim(), name || '']
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
        const updates = [];
        const params = [];
        let idx = 0;

        if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(name); }
        if (isActive !== undefined) { updates.push(`is_active = $${++idx}`); params.push(isActive); }

        if (updates.length === 0) return res.status(400).json({ error: '无更新' });

        updates.push('updated_at = NOW()');
        params.push(req.params.id);
        await db.pool.query(`UPDATE euler_api_keys SET ${updates.join(', ')} WHERE id = $${idx + 1}`, params);
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

/**
 * POST /api/admin/smtp/test - Test SMTP connection
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
 * POST /api/admin/smtp/test-send - Send a test email
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
            '<h2>SMTP 配置测试成功</h2><p>如果您收到此邮件，说明 SMTP 配置正确。</p>'
        );
        res.json({ success: true, message: '测试邮件已发送' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

module.exports = router;
