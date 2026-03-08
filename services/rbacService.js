const db = require('../db');

const ADMIN_PERMISSION_GROUPS = Object.freeze([
    {
        key: 'overview',
        label: '总览与经营',
        permissions: [
            { key: 'overview.view', label: '系统概览', description: '查看后台总览数据与核心统计卡片' },
            { key: 'users.manage', label: '用户管理', description: '查看和修改用户资料、余额、状态与配额' },
            { key: 'orders.manage', label: '订单管理', description: '查看订单与执行订单侧管理动作' },
            { key: 'plans.manage', label: '套餐与点数包', description: '维护套餐、扩容包与 AI 点数包' },
            { key: 'gifts.manage', label: '礼物配置', description: '维护礼物名称、价格与相关配置' },
        ],
    },
    {
        key: 'payments',
        label: '支付与通知',
        permissions: [
            { key: 'payments.manage', label: '支付管理', description: '维护支付通道、回调处理与订单人工处理' },
            { key: 'notifications.manage', label: '通知系统', description: '维护 PushPlus 等支付通知配置' },
        ],
    },
    {
        key: 'ai',
        label: 'AI 与通道',
        permissions: [
            { key: 'ai_work.manage', label: 'AI 工作中心', description: '查看 AI 工作任务、日志与执行状态' },
            { key: 'prompts.manage', label: '提示词管理', description: '维护 AI 提示词模板' },
            { key: 'ai_channels.manage', label: 'AI 通道配置', description: '维护 AI 通道、模型与测试能力' },
            { key: 'euler_keys.manage', label: 'Euler API Keys', description: '维护 Euler Key 池与测试状态' },
        ],
    },
    {
        key: 'system',
        label: '系统与运维',
        permissions: [
            { key: 'session_maintenance.manage', label: '场次运维', description: '执行场次修复、清理、合并与相关维护任务' },
            { key: 'settings.manage', label: '系统设置', description: '维护系统级基础配置' },
            { key: 'smtp.manage', label: '邮箱服务', description: '维护 SMTP 服务与发送策略' },
            { key: 'docs.manage', label: '系统文档', description: '查看后台文档中心与机制说明' },
            { key: 'admins.manage', label: '管理员管理', description: '管理后台管理员账号、角色与权限边界' },
        ],
    },
]);

const ALL_ADMIN_PERMISSION_KEYS = Object.freeze(
    ADMIN_PERMISSION_GROUPS.flatMap((group) => group.permissions.map((permission) => permission.key))
);

const DEFAULT_ADMIN_ROLES = Object.freeze([
    {
        code: 'super_admin',
        name: '超级管理员',
        description: '拥有后台全部权限，可管理管理员账号与 RBAC。',
        permissions: ['*'],
        isSystem: true,
    },
    {
        code: 'ops_admin',
        name: '运营管理员',
        description: '负责用户、订单、套餐、礼物与基础运营数据。',
        permissions: ['overview.view', 'users.manage', 'orders.manage', 'plans.manage', 'gifts.manage', 'docs.manage'],
        isSystem: true,
    },
    {
        code: 'finance_admin',
        name: '财务管理员',
        description: '负责支付配置、订单处理与通知链路。',
        permissions: ['overview.view', 'orders.manage', 'plans.manage', 'payments.manage', 'notifications.manage', 'docs.manage'],
        isSystem: true,
    },
    {
        code: 'ai_admin',
        name: 'AI 运维管理员',
        description: '负责 AI 工作中心、提示词与 AI 通道。',
        permissions: ['overview.view', 'ai_work.manage', 'prompts.manage', 'ai_channels.manage', 'euler_keys.manage', 'session_maintenance.manage', 'docs.manage'],
        isSystem: true,
    },
]);

let seedPromise = null;

function normalizePermissionList(input = []) {
    const list = Array.isArray(input) ? input : [input];
    const normalized = list
        .map((item) => String(item || '').trim())
        .filter(Boolean);

    if (normalized.includes('*')) return ['*'];
    return Array.from(new Set(normalized.filter((key) => ALL_ADMIN_PERMISSION_KEYS.includes(key))));
}

function expandPermissionList(input = []) {
    const normalized = normalizePermissionList(input);
    if (normalized.includes('*')) return [...ALL_ADMIN_PERMISSION_KEYS];
    return normalized;
}

function parsePermissionsJson(value) {
    if (!value) return [];
    if (Array.isArray(value)) return normalizePermissionList(value);
    try {
        return normalizePermissionList(JSON.parse(value));
    } catch {
        return [];
    }
}

function serializeRole(row) {
    const normalized = db.toCamelCase(row || {});
    const storedPermissions = parsePermissionsJson(normalized.permissionsJson);
    return {
        id: Number(normalized.id || 0),
        code: normalized.code || '',
        name: normalized.name || '',
        description: normalized.description || '',
        permissions: storedPermissions.includes('*') ? ['*'] : expandPermissionList(storedPermissions),
        rawPermissions: storedPermissions,
        isSystem: Boolean(normalized.isSystem),
        createdAt: normalized.createdAt || null,
        updatedAt: normalized.updatedAt || null,
    };
}

function buildLegacySuperAdminProfile(user = {}) {
    return {
        userId: Number(user.id || 0),
        isAdmin: true,
        isSuperAdmin: true,
        roleId: null,
        roleCode: 'legacy_super_admin',
        roleName: '历史管理员',
        roleDescription: '未绑定 RBAC 角色的历史管理员，默认拥有全部权限。',
        permissions: [...ALL_ADMIN_PERMISSION_KEYS],
        rawPermissions: ['*'],
        source: 'legacy_fallback',
    };
}

async function ensureRbacSeedData() {
    if (seedPromise) return seedPromise;
    seedPromise = (async () => {
        for (const role of DEFAULT_ADMIN_ROLES) {
            await db.pool.query(
                `INSERT INTO admin_role (code, name, description, permissions_json, is_system, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                 ON CONFLICT (code) DO UPDATE SET
                    name = EXCLUDED.name,
                    description = EXCLUDED.description,
                    permissions_json = EXCLUDED.permissions_json,
                    is_system = EXCLUDED.is_system,
                    updated_at = NOW()`,
                [role.code, role.name, role.description, JSON.stringify(role.permissions), role.isSystem]
            );
        }
    })().catch((error) => {
        seedPromise = null;
        throw error;
    });
    return seedPromise;
}

async function listAdminRoles() {
    await ensureRbacSeedData();
    const res = await db.pool.query(`SELECT id, code, name, description, permissions_json, is_system, created_at, updated_at FROM admin_role ORDER BY is_system DESC, name ASC`);
    return res.rows.map(serializeRole);
}

async function getAdminRoleById(roleId) {
    await ensureRbacSeedData();
    const res = await db.pool.query(
        `SELECT id, code, name, description, permissions_json, is_system, created_at, updated_at
         FROM admin_role WHERE id = $1 LIMIT 1`,
        [roleId]
    );
    return res.rows[0] ? serializeRole(res.rows[0]) : null;
}

async function getUserAdminAccess(user) {
    if (!user || user.role !== 'admin') {
        return {
            userId: Number(user?.id || 0),
            isAdmin: false,
            isSuperAdmin: false,
            roleId: null,
            roleCode: '',
            roleName: '',
            roleDescription: '',
            permissions: [],
            rawPermissions: [],
            source: 'not_admin',
        };
    }

    await ensureRbacSeedData();
    const res = await db.pool.query(
        `SELECT ar.id, ar.code, ar.name, ar.description, ar.permissions_json, ar.is_system, ar.created_at, ar.updated_at
         FROM user_admin_role uar
         JOIN admin_role ar ON ar.id = uar.role_id
         WHERE uar.user_id = $1
         LIMIT 1`,
        [user.id]
    );

    if (res.rows.length === 0) {
        return buildLegacySuperAdminProfile(user);
    }

    const role = serializeRole(res.rows[0]);
    const expandedPermissions = role.rawPermissions.includes('*') ? [...ALL_ADMIN_PERMISSION_KEYS] : expandPermissionList(role.rawPermissions);
    return {
        userId: Number(user.id || 0),
        isAdmin: true,
        isSuperAdmin: role.rawPermissions.includes('*') || role.code === 'super_admin',
        roleId: role.id,
        roleCode: role.code,
        roleName: role.name,
        roleDescription: role.description,
        permissions: expandedPermissions,
        rawPermissions: role.rawPermissions,
        source: 'assigned_role',
    };
}

function hasPermission(accessProfile, permissionKey) {
    if (!permissionKey) return true;
    if (!accessProfile || !accessProfile.isAdmin) return false;
    if (accessProfile.isSuperAdmin) return true;
    return Array.isArray(accessProfile.permissions) && accessProfile.permissions.includes(permissionKey);
}

async function listAdminUsers() {
    await ensureRbacSeedData();
    const res = await db.pool.query(
        `SELECT u.id, u.username, u.nickname, u.email, u.status, u.last_login_at, u.created_at,
                ar.id AS role_id, ar.code AS role_code, ar.name AS role_name, ar.description AS role_description,
                ar.permissions_json, ar.is_system
         FROM users u
         LEFT JOIN user_admin_role uar ON u.id = uar.user_id
         LEFT JOIN admin_role ar ON ar.id = uar.role_id
         WHERE u.role = 'admin'
         ORDER BY u.created_at ASC, u.id ASC`
    );

    return res.rows.map((row) => {
        const normalized = db.toCamelCase(row);
        if (!normalized.roleId) {
            const legacy = buildLegacySuperAdminProfile(normalized);
            return {
                id: Number(normalized.id || 0),
                username: normalized.username || '',
                nickname: normalized.nickname || '',
                email: normalized.email || '',
                status: normalized.status || 'active',
                lastLoginAt: normalized.lastLoginAt || null,
                createdAt: normalized.createdAt || null,
                roleId: null,
                roleCode: legacy.roleCode,
                roleName: legacy.roleName,
                roleDescription: legacy.roleDescription,
                permissions: legacy.permissions,
                isSystemRole: true,
                source: legacy.source,
            };
        }

        const role = serializeRole(row);
        return {
            id: Number(normalized.id || 0),
            username: normalized.username || '',
            nickname: normalized.nickname || '',
            email: normalized.email || '',
            status: normalized.status || 'active',
            lastLoginAt: normalized.lastLoginAt || null,
            createdAt: normalized.createdAt || null,
            roleId: role.id,
            roleCode: role.code,
            roleName: role.name,
            roleDescription: role.description,
            permissions: role.rawPermissions.includes('*') ? [...ALL_ADMIN_PERMISSION_KEYS] : expandPermissionList(role.rawPermissions),
            isSystemRole: role.isSystem,
            source: 'assigned_role',
        };
    });
}

async function searchAdminCandidates(keyword, limit = 10) {
    const text = String(keyword || '').trim();
    if (!text) return [];

    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 20));
    const queryText = `%${text}%`;
    const res = await db.pool.query(
        `SELECT u.id, u.username, u.nickname, u.email, u.role, u.status,
                ar.name AS role_name, ar.code AS role_code
         FROM users u
         LEFT JOIN user_admin_role uar ON u.id = uar.user_id
         LEFT JOIN admin_role ar ON ar.id = uar.role_id
         WHERE u.username ILIKE $1 OR COALESCE(u.nickname, '') ILIKE $1 OR COALESCE(u.email, '') ILIKE $1
         ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at DESC
         LIMIT $2`,
        [queryText, safeLimit]
    );

    return res.rows.map((row) => {
        const normalized = db.toCamelCase(row);
        return {
            id: Number(normalized.id || 0),
            username: normalized.username || '',
            nickname: normalized.nickname || '',
            email: normalized.email || '',
            role: normalized.role || 'user',
            status: normalized.status || 'active',
            adminRoleName: normalized.roleName || '',
            adminRoleCode: normalized.roleCode || '',
        };
    });
}

async function upsertAdminUserRole({ userId, roleId, actorId = null }) {
    await ensureRbacSeedData();
    const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);
    if (!user) throw new Error('用户不存在');

    const role = await getAdminRoleById(roleId);
    if (!role) throw new Error('管理员角色不存在');

    await db.pool.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2', ['admin', userId]);
    await db.pool.query(
        `INSERT INTO user_admin_role (user_id, role_id, assigned_by, assigned_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET role_id = EXCLUDED.role_id, assigned_by = EXCLUDED.assigned_by, updated_at = NOW()`,
        [userId, role.id, actorId]
    );

    return role;
}

async function revokeAdminUser({ userId, actorId = null }) {
    const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);
    if (!user) throw new Error('用户不存在');
    await db.pool.query('DELETE FROM user_admin_role WHERE user_id = $1', [userId]);
    await db.pool.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2', ['user', userId]);
    return { userId: Number(userId), revokedBy: actorId ? Number(actorId) : null };
}

async function createAdminRole({ code, name, description = '', permissions = [] }) {
    await ensureRbacSeedData();
    const normalizedCode = String(code || '').trim();
    const normalizedName = String(name || '').trim();
    if (!normalizedCode || !/^[a-z][a-z0-9_]{2,31}$/i.test(normalizedCode)) {
        throw new Error('角色编码格式无效，仅支持字母开头的字母数字下划线，长度 3-32');
    }
    if (!normalizedName) {
        throw new Error('角色名称不能为空');
    }

    const finalPermissions = normalizePermissionList(permissions);
    if (finalPermissions.length === 0) {
        throw new Error('至少选择一个权限');
    }

    const res = await db.pool.query(
        `INSERT INTO admin_role (code, name, description, permissions_json, is_system, created_at, updated_at)
         VALUES ($1, $2, $3, $4, FALSE, NOW(), NOW())
         RETURNING id, code, name, description, permissions_json, is_system, created_at, updated_at`,
        [normalizedCode, normalizedName, description || '', JSON.stringify(finalPermissions)]
    );
    return serializeRole(res.rows[0]);
}

async function updateAdminRole(roleId, { name, description = '', permissions = [] }) {
    await ensureRbacSeedData();
    const existing = await getAdminRoleById(roleId);
    if (!existing) throw new Error('管理员角色不存在');
    if (existing.isSystem) throw new Error('系统角色不允许修改');

    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
        throw new Error('角色名称不能为空');
    }
    const finalPermissions = normalizePermissionList(permissions);
    if (finalPermissions.length === 0) {
        throw new Error('至少选择一个权限');
    }

    const res = await db.pool.query(
        `UPDATE admin_role
         SET name = $2,
             description = $3,
             permissions_json = $4,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, code, name, description, permissions_json, is_system, created_at, updated_at`,
        [roleId, normalizedName, description || '', JSON.stringify(finalPermissions)]
    );
    return serializeRole(res.rows[0]);
}

async function deleteAdminRole(roleId) {
    await ensureRbacSeedData();
    const existing = await getAdminRoleById(roleId);
    if (!existing) throw new Error('管理员角色不存在');
    if (existing.isSystem) throw new Error('系统角色不允许删除');

    const assigned = await db.get('SELECT COUNT(*) AS count FROM user_admin_role WHERE role_id = ?', [roleId]);
    if (Number(assigned?.count || 0) > 0) {
        throw new Error('该角色仍有管理员在使用，无法删除');
    }

    await db.pool.query('DELETE FROM admin_role WHERE id = $1', [roleId]);
    return { deleted: true, roleId: Number(roleId) };
}

module.exports = {
    ADMIN_PERMISSION_GROUPS,
    ALL_ADMIN_PERMISSION_KEYS,
    DEFAULT_ADMIN_ROLES,
    normalizePermissionList,
    expandPermissionList,
    ensureRbacSeedData,
    listAdminRoles,
    getAdminRoleById,
    getUserAdminAccess,
    hasPermission,
    listAdminUsers,
    searchAdminCandidates,
    upsertAdminUserRole,
    revokeAdminUser,
    createAdminRole,
    updateAdminRole,
    deleteAdminRole,
};
