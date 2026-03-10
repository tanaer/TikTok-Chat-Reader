// admin.js - Admin panel logic

const ADMIN_SECTION_META = Object.freeze({
    overview: { title: '系统概览', permission: 'overview.view' },
    users: { title: '用户管理', permission: 'users.manage' },
    orders: { title: '订单管理', permission: 'orders.manage' },
    plans: { title: '套餐设置', permission: 'plans.manage' },
    gifts: { title: '礼物配置', permission: 'gifts.manage' },
    payment: { title: '支付管理', permission: 'payments.manage' },
    notifications: { title: '通知系统', permission: 'notifications.manage' },
    aiWork: { title: 'AI工作中心', permission: 'ai_work.manage' },
    prompts: { title: '提示词管理', permission: 'prompts.manage' },
    structuredSources: { title: '结构化数据源', permission: 'ai_channels.manage' },
    aiModels: { title: 'AI 通道配置', permission: 'ai_channels.manage' },
    eulerKeys: { title: 'Euler API Keys', permission: 'euler_keys.manage' },
    sessionMaintenance: { title: '场次运维', permission: 'session_maintenance.manage' },
    settings: { title: '系统设置', permission: 'settings.manage' },
    schemeASettings: { title: '性能优化', permission: 'settings.manage' },
    smtpServices: { title: '邮箱服务', permission: 'smtp.manage' },
    adminAccess: { title: '管理员管理', permission: 'admins.manage' },
    docs: { title: '系统文档', permission: 'docs.manage' }
});
const ADMIN_SIDEBAR_SECTION_STORAGE_KEY = 'admin:sidebar:activeSection';
const ADMIN_SIDEBAR_GROUP_STORAGE_KEY = 'admin:sidebar:groupState';
const ADMIN_READ_METHODS = new Set(['GET', 'HEAD']);
const ADMIN_REQUEST_TARGET_HINTS = Object.freeze([
    ['admin-access', '管理员管理'],
    ['session-maintenance', '场次运维'],
    ['smtp', '邮箱服务'],
    ['/docs', '系统文档'],
    ['prompt-templates', '提示词管理'],
    ['structured-sources', '结构化数据源'],
    ['ai-work', 'AI工作中心'],
    ['ai-models', 'AI 通道配置'],
    ['ai-channels', 'AI 通道配置'],
    ['euler-keys', 'Euler API Keys'],
    ['/api/admin/payment/pushplus-config', '通知配置'],
    ['/api/admin/payment/config', '支付配置'],
    ['ai-credit-packages', 'AI 点数包'],
    ['/addons', '扩容包配置'],
    ['/plans', '套餐配置'],
    ['/orders', '订单数据'],
    ['/users', '用户数据'],
    ['/api/gifts', '礼物配置'],
    ['/api/settings', '系统设置'],
    ['/api/config', '系统设置'],
    ['/stats', '系统概览'],
]);

let adminOriginalApiFetch = null;
let adminReadRequestCount = 0;
let adminWriteRequestCount = 0;
let adminLatestRequestMessage = '';
let adminRequestHideTimer = null;

function getAdminCurrentSectionTitle() {
    return ADMIN_SECTION_META[currentSection]?.title || '后台数据';
}

function inferAdminRequestTarget(url) {
    const normalizedUrl = String(url || '');
    for (const [pattern, label] of ADMIN_REQUEST_TARGET_HINTS) {
        if (normalizedUrl.includes(pattern)) return label;
    }
    return getAdminCurrentSectionTitle();
}

function inferAdminRequestMessage(url, method) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const target = inferAdminRequestTarget(url);
    if (ADMIN_READ_METHODS.has(normalizedMethod)) return `正在加载${target}...`;
    if (normalizedMethod === 'DELETE') return `正在删除${target}...`;
    if (normalizedMethod === 'PATCH' || normalizedMethod === 'PUT') return `正在保存${target}...`;
    return `正在提交${target}...`;
}

function inferAdminButtonBusyText(url, method) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const target = inferAdminRequestTarget(url);
    if (ADMIN_READ_METHODS.has(normalizedMethod)) return `加载${target}...`;
    if (normalizedMethod === 'DELETE') return '删除中...';
    if (String(url || '').includes('/test')) return '测试中...';
    if (normalizedMethod === 'PATCH' || normalizedMethod === 'PUT') return '保存中...';
    return '提交中...';
}

function getAdminRequestUiRefs() {
    return {
        overlay: document.getElementById('admin-content-loading-overlay'),
        overlayText: document.getElementById('admin-content-loading-text'),
    };
}

function renderAdminRequestUi() {
    const { overlay, overlayText } = getAdminRequestUiRefs();
    const total = adminReadRequestCount + adminWriteRequestCount;
    if (adminRequestHideTimer) {
        clearTimeout(adminRequestHideTimer);
        adminRequestHideTimer = null;
    }

    if (total <= 0) {
        if (overlay) overlay.classList.add('hidden');
        return;
    }

    const activeKind = adminWriteRequestCount > 0 ? 'write' : 'read';
    const activeCount = activeKind === 'write' ? adminWriteRequestCount : adminReadRequestCount;
    const baseMessage = adminLatestRequestMessage || (activeKind === 'write' ? '正在提交后台数据...' : '正在加载后台数据...');
    const message = activeCount > 1 ? `${baseMessage}（${activeCount} 项请求）` : baseMessage;

    if (overlay) {
        overlay.classList.toggle('hidden', adminReadRequestCount <= 0);
    }
    if (overlayText) {
        overlayText.textContent = adminReadRequestCount > 0 ? message : '正在同步当前页面数据，请稍候...';
    }
}

function scheduleAdminRequestUiHide() {
    if (adminRequestHideTimer) {
        clearTimeout(adminRequestHideTimer);
    }
    adminRequestHideTimer = setTimeout(() => {
        renderAdminRequestUi();
    }, 180);
}

function resolveAdminRequestButton(explicitButton = null) {
    const candidate = explicitButton || document.activeElement;
    if (!candidate || typeof candidate.closest !== 'function') return null;
    const button = candidate.closest('button, .btn');
    return button || null;
}

function setAdminRequestButtonBusy(button, busy, busyText = '处理中...') {
    if (!button) return;

    const currentCount = Math.max(0, parseInt(button.dataset.adminBusyCount || '0', 10) || 0);

    if (busy) {
        if (currentCount === 0) {
            button.dataset.adminOriginalHtml = button.innerHTML;
            button.dataset.adminOriginalDisabled = button.disabled ? 'true' : 'false';
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.classList.add('pointer-events-none');
            button.innerHTML = `<span class="loading loading-spinner loading-xs"></span><span>${busyText}</span>`;
        }
        button.dataset.adminBusy = 'true';
        button.dataset.adminBusyCount = String(currentCount + 1);
        return;
    }

    const nextCount = Math.max(0, currentCount - 1);
    if (nextCount > 0) {
        button.dataset.adminBusyCount = String(nextCount);
        return;
    }

    if (button.dataset.adminOriginalHtml) {
        button.innerHTML = button.dataset.adminOriginalHtml;
    }
    button.disabled = button.dataset.adminOriginalDisabled === 'true';
    button.removeAttribute('aria-busy');
    button.classList.remove('pointer-events-none');
    delete button.dataset.adminOriginalHtml;
    delete button.dataset.adminOriginalDisabled;
    delete button.dataset.adminBusy;
    delete button.dataset.adminBusyCount;
}

function installAdminApiFetchHooks() {
    if (adminOriginalApiFetch || !window.Auth || typeof Auth.apiFetch !== 'function') return;

    adminOriginalApiFetch = Auth.apiFetch.bind(Auth);
    Auth.apiFetch = async function adminManagedApiFetch(url, options = {}) {
        const normalizedMethod = String(options.method || 'GET').toUpperCase();
        const normalizedUrl = String(url || '');
        const isSilentRequest = options.adminSilent === true || normalizedUrl.startsWith('/api/auth/');
        if (isSilentRequest) {
            return adminOriginalApiFetch(url, options);
        }

        const isReadRequest = ADMIN_READ_METHODS.has(normalizedMethod);
        const button = resolveAdminRequestButton(options.adminButton || null);
        const message = options.adminMessage || inferAdminRequestMessage(url, normalizedMethod);
        const busyText = options.adminBusyText || inferAdminButtonBusyText(url, normalizedMethod);

        adminLatestRequestMessage = message;
        if (isReadRequest) adminReadRequestCount += 1;
        else adminWriteRequestCount += 1;

        if (button) {
            setAdminRequestButtonBusy(button, true, busyText);
        }
        renderAdminRequestUi();

        try {
            return await adminOriginalApiFetch(url, options);
        } finally {
            if (button) {
                setAdminRequestButtonBusy(button, false);
            }
            if (isReadRequest) adminReadRequestCount = Math.max(0, adminReadRequestCount - 1);
            else adminWriteRequestCount = Math.max(0, adminWriteRequestCount - 1);

            if (adminReadRequestCount + adminWriteRequestCount > 0) {
                renderAdminRequestUi();
            } else {
                scheduleAdminRequestUiHide();
            }
        }
    };
}

document.addEventListener('DOMContentLoaded', async () => {
    installAdminApiFetchHooks();
    if (!Auth.requireAdmin()) return;
    Auth.updateNavbar();
    try {
        await loadAdminAccessProfile();
    } catch (err) {
        console.error('Load admin access profile error:', err);
        alert(err.message || '加载管理员权限失败');
        return;
    }
    initSidebarMenu();
    initAdminAiWorkFilters();
    const preferredSection = localStorage.getItem(ADMIN_SIDEBAR_SECTION_STORAGE_KEY) || 'overview';
    showSection(preferredSection);
});

let currentSection = 'overview';
let eulerKeysAutoRefreshTimer = null;

function stopEulerKeysAutoRefresh() {
    if (!eulerKeysAutoRefreshTimer) return;
    clearInterval(eulerKeysAutoRefreshTimer);
    eulerKeysAutoRefreshTimer = null;
}

function startEulerKeysAutoRefresh() {
    stopEulerKeysAutoRefresh();
    if (currentSection !== 'eulerKeys') return;
    eulerKeysAutoRefreshTimer = setInterval(() => {
        if (currentSection !== 'eulerKeys') {
            stopEulerKeysAutoRefresh();
            return;
        }
        loadEulerKeys();
    }, 15000);
}
let currentAdminUserDetailId = null;
let adminDocsLoadedOnce = false;
let adminDocsListCache = [];
let currentAdminDocPath = '';
let currentPlanFeatureFlags = {};
let smtpServicesCache = [];
let smtpFallbackPolicy = null;
let smtpEmailSettings = { emailVerificationEnabled: false };
let smtpServiceEditorId = null;
let aiWorkAdminPage = 1;
let currentAdminAiWorkDetailId = null;
let sessionMaintenanceOverviewCache = null;
let sessionMaintenanceConfigCache = null;
let sessionMaintenanceLogsCache = [];
let adminAccessProfile = null;
let adminPermissionGroups = [];
let allAdminPermissions = [];
let adminPermissionsSet = new Set();
let adminRolesCache = [];
let adminAdminsCache = [];
let adminCandidatesCache = [];
let adminRoleEditingSnapshot = null;
let adminRoleEditorId = null;
let structuredSourcesCache = [];
let currentStructuredSourceKey = '';

const PLAN_PRICE_FIELD_META = Object.freeze({
    monthly: { inputId: 'pf-pm', label: '月价' },
    quarterly: { inputId: 'pf-pq', label: '季价' },
    yearly: { inputId: 'pf-py', label: '年价' },
});

function getDefaultMenuPermissions() {
    return [...new Set(Object.values(ADMIN_SECTION_META).map((item) => item.permission).filter(Boolean))];
}

function loadSidebarGroupState() {
    try {
        const parsed = JSON.parse(localStorage.getItem(ADMIN_SIDEBAR_GROUP_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function persistSidebarGroupState() {
    const groupState = {};
    document.querySelectorAll('#sidebar-menu details[data-admin-group]').forEach((detailsEl) => {
        groupState[detailsEl.dataset.adminGroup] = Boolean(detailsEl.open);
    });
    localStorage.setItem(ADMIN_SIDEBAR_GROUP_STORAGE_KEY, JSON.stringify(groupState));
}

function hasSectionPermission(permissionKey) {
    if (!permissionKey) return true;
    if (adminAccessProfile?.isSuperAdmin) return true;
    return adminPermissionsSet.has(permissionKey);
}

function canAccessSection(name) {
    const meta = ADMIN_SECTION_META[name];
    if (!meta) return false;
    return hasSectionPermission(meta.permission);
}

function resolveAccessibleSection(sectionName) {
    const preferred = String(sectionName || '').trim();
    if (preferred && canAccessSection(preferred) && document.getElementById(`sec-${preferred}`)) {
        return preferred;
    }
    const firstAllowed = Object.keys(ADMIN_SECTION_META).find(
        (key) => canAccessSection(key) && document.getElementById(`sec-${key}`)
    );
    return firstAllowed || 'overview';
}

function initSidebarMenu() {
    const sidebar = document.getElementById('sidebar-menu');
    if (!sidebar) return;

    const groupState = loadSidebarGroupState();
    sidebar.querySelectorAll('details[data-admin-group]').forEach((detailsEl) => {
        const groupKey = detailsEl.dataset.adminGroup;
        if (Object.prototype.hasOwnProperty.call(groupState, groupKey)) {
            detailsEl.open = Boolean(groupState[groupKey]);
        }
        detailsEl.addEventListener('toggle', persistSidebarGroupState);
    });

    sidebar.querySelectorAll('a[data-admin-section]').forEach((link) => {
        const sectionName = link.dataset.adminSection;
        const visible = canAccessSection(sectionName);
        const item = link.closest('li');
        link.classList.toggle('hidden', !visible);
        if (item) item.classList.toggle('hidden', !visible);
    });

    sidebar.querySelectorAll('[data-admin-group-wrapper]').forEach((wrapper) => {
        const hasVisibleChild = wrapper.querySelector('a[data-admin-section]:not(.hidden)');
        wrapper.classList.toggle('hidden', !hasVisibleChild);
    });

    persistSidebarGroupState();
}

function runSectionLoader(name) {
    if (name === 'overview') loadOverviewStats();
    else if (name === 'users') loadUsers(1);
    else if (name === 'orders') loadAdminOrders(1);
    else if (name === 'payment') loadPaymentConfig();
    else if (name === 'notifications') loadNotificationConfig();
    else if (name === 'plans') { loadPlans(); loadAddons(); loadAiCreditPackages(); }
    else if (name === 'gifts') loadAdminGiftConfig();
    else if (name === 'settings') loadSettingsForm();
    else if (name === 'schemeASettings') loadSettingsForm();
    else if (name === 'sessionMaintenance') loadSessionMaintenanceSection();
    else if (name === 'smtpServices') loadSmtpServices();
    else if (name === 'aiWork') loadAdminAiWorkJobs(1);
    else if (name === 'prompts') loadPromptTemplates();
    else if (name === 'structuredSources') loadStructuredSources();
    else if (name === 'docs') loadAdminDocs();
    else if (name === 'eulerKeys') loadEulerKeys();
    else if (name === 'aiModels') loadAiModels();
    else if (name === 'adminAccess') loadAdminAccessSection();
}

function showSection(name, event) {
    const resolvedName = resolveAccessibleSection(name);
    if (resolvedName !== name && event) {
        alert('当前账号没有该菜单权限');
        return false;
    }

    currentSection = resolvedName;
    document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
    document.getElementById(`sec-${resolvedName}`)?.classList.remove('hidden');
    document.querySelectorAll('#sidebar-menu a[data-admin-section]').forEach((link) => link.classList.remove('active'));

    const activeLink = document.querySelector(`#sidebar-menu a[data-admin-section="${resolvedName}"]`);
    if (activeLink) {
        activeLink.classList.add('active');
        const detailsEl = activeLink.closest('details[data-admin-group]');
        if (detailsEl && !detailsEl.open) {
            detailsEl.open = true;
            persistSidebarGroupState();
        }
    }

    localStorage.setItem(ADMIN_SIDEBAR_SECTION_STORAGE_KEY, resolvedName);
    document.getElementById('section-title').textContent = ADMIN_SECTION_META[resolvedName]?.title || resolvedName;
    runSectionLoader(resolvedName);
    if (resolvedName === 'eulerKeys') startEulerKeysAutoRefresh();
    else stopEulerKeysAutoRefresh();
    return false;
}

// ==================== Overview ====================
async function loadOverviewStats() {
    try {
        const res = await Auth.apiFetch('/api/admin/stats');
        const d = await res.json();
        document.getElementById('s-users').textContent = d.totalUsers;
        document.getElementById('s-users-today').textContent = `今日新增 ${d.todayNewUsers}`;
        document.getElementById('s-subs').textContent = d.activeSubscriptions;
        document.getElementById('s-revenue').textContent = `¥${d.monthRevenue.toFixed(2)}`;
        document.getElementById('s-orders-total').textContent = `总订单 ${d.totalOrders}`;
        document.getElementById('s-balance').textContent = `¥${d.balancePool.toFixed(2)}`;
        document.getElementById('s-rooms').textContent = d.activeRooms;
    } catch (err) { console.error('Stats error:', err); }
}

// ==================== Users ====================
async function loadUsers(page) {
    try {
        const search = document.getElementById('user-search').value;
        const role = document.getElementById('user-role-filter').value;
        const status = document.getElementById('user-status-filter').value;
        const params = new URLSearchParams({ page, limit: 20, search, role, status });
        const res = await Auth.apiFetch(`/api/admin/users?${params}`);
        const data = await res.json();
        const tbody = document.getElementById('users-tbody');

        if (!data.users || data.users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="text-center text-base-content/60">暂无数据</td></tr>';
            return;
        }

        tbody.innerHTML = data.users.map(u => `<tr>
            <td>${u.id}</td>
            <td>${u.username}</td>
            <td>${u.nickname || '-'}</td>
            <td class="font-mono">¥${parseFloat(u.balance).toFixed(2)}</td>
            <td>${u.planName ? `<span class="badge badge-primary badge-sm">${u.planName}</span>` : '<span class="text-base-content/40">-</span>'}</td>
            <td>${u.roomCount}</td>
            <td><span class="badge badge-sm ${u.status === 'active' ? 'badge-success' : 'badge-error'}">${u.status === 'active' ? '正常' : '禁用'}</span></td>
            <td class="text-xs">${new Date(u.createdAt).toLocaleDateString('zh-CN')}</td>
            <td class="flex gap-1 flex-wrap">
                <button class="btn btn-xs btn-ghost" onclick="showUserDetail(${u.id})">详情</button>
                <button class="btn btn-xs btn-info btn-outline" onclick="showBalanceModal(${u.id}, '${u.username}', ${u.balance})">余额</button>
                <button class="btn btn-xs ${u.status === 'active' ? 'btn-warning' : 'btn-success'} btn-outline" onclick="toggleUserStatus(${u.id})">${u.status === 'active' ? '禁用' : '启用'}</button>
            </td>
        </tr>`).join('');

        renderPagination('users-pagination', data.pagination, 'loadUsers');
    } catch (err) { console.error('Load users error:', err); }
}

function formatAdminQuotaLimit(value, fallback = '-') {
    const parsed = Number(value);
    if (parsed === -1) return '不限';
    if (!Number.isFinite(parsed)) return fallback;
    return String(parsed);
}

function formatDateTimeLocalInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getAdminQuotaSourceText(overrideMeta) {
    if (!overrideMeta) return '默认';
    if (overrideMeta.source === 'temporary') {
        return `临时${overrideMeta.temporaryExpiresAt ? ` · 至 ${new Date(overrideMeta.temporaryExpiresAt).toLocaleString('zh-CN')}` : ''}`;
    }
    if (overrideMeta.source === 'permanent') return '永久';
    return '默认';
}

async function saveUserQuotaOverrides(userId) {
    const roomLimitTemporary = document.getElementById('ud-room-limit-temporary')?.value ?? '';
    const roomLimitTemporaryExpiresAt = document.getElementById('ud-room-limit-temporary-expires')?.value ?? '';
    const dailyRoomCreateLimitTemporary = document.getElementById('ud-daily-limit-temporary')?.value ?? '';
    const dailyRoomCreateLimitTemporaryExpiresAt = document.getElementById('ud-daily-limit-temporary-expires')?.value ?? '';

    if (roomLimitTemporary !== '' && !roomLimitTemporaryExpiresAt) {
        alert('请填写临时可建房间数的到期时间');
        return;
    }
    if (dailyRoomCreateLimitTemporary !== '' && !dailyRoomCreateLimitTemporaryExpiresAt) {
        alert('请填写临时每日可添加次数的到期时间');
        return;
    }

    const body = {
        roomLimitPermanent: document.getElementById('ud-room-limit-permanent')?.value ?? '',
        roomLimitTemporary,
        roomLimitTemporaryExpiresAt,
        dailyRoomCreateLimitPermanent: document.getElementById('ud-daily-limit-permanent')?.value ?? '',
        dailyRoomCreateLimitTemporary,
        dailyRoomCreateLimitTemporaryExpiresAt,
    };

    const res = await Auth.apiFetch(`/api/admin/users/${userId}/quota-overrides`, {
        method: 'PUT',
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || '保存配额失败');
        return;
    }

    alert(data.message || '配额已保存');
    await showUserDetail(userId);
}

function formatAdminBillingCycle(value) {
    const labels = {
        monthly: '月付',
        quarterly: '季付',
        yearly: '年付',
        gift: '赠送',
        manual: '手工调整',
    };
    return labels[String(value || '').trim()] || String(value || '-');
}

function formatAdminSubscriptionStatus(value) {
    const labels = {
        active: '生效中',
        expired: '已过期',
        cancelled: '已取消',
    };
    return labels[String(value || '').trim()] || String(value || '-');
}

async function saveUserSubscription(userId) {
    const planId = document.getElementById('ud-subscription-plan')?.value ?? '';
    const endDate = document.getElementById('ud-subscription-end')?.value ?? '';

    if (!planId) {
        alert('请选择会员套餐');
        return;
    }
    if (!endDate) {
        alert('请选择会员到期时间');
        return;
    }

    const parsedEndDate = new Date(endDate);
    if (Number.isNaN(parsedEndDate.getTime())) {
        alert('会员到期时间无效');
        return;
    }

    const res = await Auth.apiFetch(`/api/admin/users/${userId}/subscription`, {
        method: 'PUT',
        body: JSON.stringify({
            planId: Number(planId),
            endDate,
        })
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || '保存会员调整失败');
        return;
    }

    alert(data.message || '会员调整已保存');
    await loadUsers(1);
    await showUserDetail(userId);
}

async function showUserDetail(userId) {
    try {
        currentAdminUserDetailId = userId;
        const [detailRes, plansRes] = await Promise.all([
            Auth.apiFetch(`/api/admin/users/${userId}`),
            Auth.apiFetch('/api/admin/plans')
        ]);
        const [detailData, plansData] = await Promise.all([
            detailRes.json(),
            plansRes.json()
        ]);

        if (!detailRes.ok) {
            alert(detailData.error || '获取用户详情失败');
            return;
        }
        if (!plansRes.ok) {
            alert(plansData.error || '获取套餐列表失败');
            return;
        }

        const u = detailData.user;
        const quota = detailData.quota || {};
        const subscriptions = Array.isArray(detailData.subscriptions) ? detailData.subscriptions : [];
        const rooms = Array.isArray(detailData.rooms) ? detailData.rooms : [];
        const roomOverride = quota.quotaOverrides?.roomLimit || {};
        const dailyOverride = quota.quotaOverrides?.dailyCreateLimit || {};
        const currentSubscription = quota.subscription || null;
        const plans = Array.isArray(plansData.plans)
            ? [...plansData.plans].sort((a, b) => {
                if (Boolean(a.isActive) !== Boolean(b.isActive)) return a.isActive ? -1 : 1;
                return Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
            })
            : [];
        const currentPlanId = currentSubscription?.planId ? Number(currentSubscription.planId) : null;
        const currentEndDateText = currentSubscription?.endDate
            ? new Date(currentSubscription.endDate).toLocaleString('zh-CN')
            : '未开通';
        const planOptionsHtml = plans.length > 0
            ? plans.map((plan) => {
                const isSelected = Number(plan.id) === currentPlanId;
                const roomText = formatAdminQuotaLimit(plan.roomLimit, '0');
                const dailyText = formatAdminQuotaLimit(plan.dailyRoomCreateLimit, '0');
                return `<option value="${plan.id}" ${isSelected ? 'selected' : ''}>${escapeHtml(plan.name)}（${escapeHtml(plan.code)}） · 房间 ${roomText} · 每日 ${dailyText}${plan.isActive ? '' : ' · 已下架'}</option>`;
            }).join('')
            : '<option value="">暂无可选套餐</option>';
        const content = document.getElementById('user-detail-content');

        content.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div><strong>用户名:</strong> ${escapeHtml(u.username)}</div>
                <div><strong>昵称:</strong> ${escapeHtml(u.nickname || '-')}</div>
                <div><strong>邮箱:</strong> ${escapeHtml(u.email || '-')}</div>
                <div><strong>余额:</strong> ¥${parseFloat(u.balance).toFixed(2)}</div>
                <div><strong>角色:</strong> ${escapeHtml(u.role)}</div>
                <div><strong>状态:</strong> ${escapeHtml(u.status)}</div>
                <div><strong>最后登录:</strong> ${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未'}</div>
                <div><strong>注册时间:</strong> ${new Date(u.createdAt).toLocaleString('zh-CN')}</div>
            </div>
            <div class="divider">会员</div>
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
                <div class="rounded-box bg-base-200 p-4 space-y-2">
                    <div class="text-sm text-base-content/60">当前生效会员</div>
                    <div class="text-xl font-bold">${escapeHtml(currentSubscription?.planName || '无生效会员')}</div>
                    <div class="text-sm text-base-content/80">周期：${escapeHtml(formatAdminBillingCycle(currentSubscription?.billingCycle || '-'))}</div>
                    <div class="text-sm text-base-content/80">状态：${escapeHtml(currentSubscription ? formatAdminSubscriptionStatus(currentSubscription.status) : '未开通')}</div>
                    <div class="text-sm text-base-content/80">到期：${escapeHtml(currentEndDateText)}</div>
                    <div class="text-xs text-base-content/60">保存后会立即刷新该用户的套餐配额。若只是调整同一套餐的到期时间，会直接修改当前生效记录；若切换到其他套餐，会立即停用旧套餐并新建一条新的生效记录。</div>
                </div>
                <div class="rounded-box border border-base-300 p-4 space-y-3">
                    <div class="font-semibold">会员计划调整</div>
                    <label class="form-control">
                        <span class="label-text text-sm">选择套餐</span>
                        <select id="ud-subscription-plan" class="select select-bordered select-sm">${planOptionsHtml}</select>
                    </label>
                    <label class="form-control">
                        <span class="label-text text-sm">到期时间</span>
                        <input id="ud-subscription-end" type="datetime-local" class="input input-bordered input-sm" value="${formatDateTimeLocalInput(currentSubscription?.endDate)}">
                    </label>
                    <div class="text-xs text-base-content/60">支持直接延长、缩短或切换套餐。若填写过去时间，系统会把该会员视为立即过期。</div>
                    <button class="btn btn-sm btn-secondary" ${plans.length > 0 ? '' : 'disabled'} onclick="saveUserSubscription(${u.id})">保存会员调整</button>
                </div>
            </div>
            <div class="divider">配额</div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div class="rounded-box bg-base-200 p-4">
                    <div class="text-sm text-base-content/60">可建房间数</div>
                    <div class="text-xl font-bold mt-1">剩余 ${formatAdminQuotaLimit(quota.remaining, '0')} / 总 ${formatAdminQuotaLimit(quota.limit, '0')}</div>
                    <div class="text-xs text-base-content/60 mt-2">已用 ${Number(quota.used || 0)} · 基础 ${formatAdminQuotaLimit(quota.baseTotalLimit, '0')} · 当前来源 ${getAdminQuotaSourceText(roomOverride)}</div>
                </div>
                <div class="rounded-box bg-base-200 p-4">
                    <div class="text-sm text-base-content/60">每日可添加次数</div>
                    <div class="text-xl font-bold mt-1">已添加 ${Number(quota.dailyUsed || 0)} / 可添加 ${formatAdminQuotaLimit(quota.dailyLimit, '0')}</div>
                    <div class="text-xs text-base-content/60 mt-2">剩余 ${formatAdminQuotaLimit(quota.dailyRemaining, '0')} · 基础 ${formatAdminQuotaLimit(quota.baseDailyRoomCreateLimit, '0')} · 当前来源 ${getAdminQuotaSourceText(dailyOverride)}</div>
                </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div class="rounded-box border border-base-300 p-4 space-y-3">
                    <div class="font-semibold">可建房间数调整</div>
                    <label class="form-control">
                        <span class="label-text text-sm">永久值</span>
                        <input id="ud-room-limit-permanent" type="number" min="-1" class="input input-bordered input-sm" value="${roomOverride.permanent ?? ''}" placeholder="留空=跟随默认/清除永久值">
                    </label>
                    <label class="form-control">
                        <span class="label-text text-sm">临时值</span>
                        <input id="ud-room-limit-temporary" type="number" min="-1" class="input input-bordered input-sm" value="${roomOverride.temporary ?? ''}" placeholder="留空=清除临时值">
                    </label>
                    <label class="form-control">
                        <span class="label-text text-sm">临时到期</span>
                        <input id="ud-room-limit-temporary-expires" type="datetime-local" class="input input-bordered input-sm" value="${formatDateTimeLocalInput(roomOverride.temporaryExpiresAt)}">
                    </label>
                    <div class="text-xs text-base-content/60">支持填 -1 表示不限；留空后保存可清除对应覆盖值。</div>
                </div>
                <div class="rounded-box border border-base-300 p-4 space-y-3">
                    <div class="font-semibold">每日可添加次数调整</div>
                    <label class="form-control">
                        <span class="label-text text-sm">永久值</span>
                        <input id="ud-daily-limit-permanent" type="number" min="-1" class="input input-bordered input-sm" value="${dailyOverride.permanent ?? ''}" placeholder="留空=跟随默认/清除永久值">
                    </label>
                    <label class="form-control">
                        <span class="label-text text-sm">临时值</span>
                        <input id="ud-daily-limit-temporary" type="number" min="-1" class="input input-bordered input-sm" value="${dailyOverride.temporary ?? ''}" placeholder="留空=清除临时值">
                    </label>
                    <label class="form-control">
                        <span class="label-text text-sm">临时到期</span>
                        <input id="ud-daily-limit-temporary-expires" type="datetime-local" class="input input-bordered input-sm" value="${formatDateTimeLocalInput(dailyOverride.temporaryExpiresAt)}">
                    </label>
                    <div class="text-xs text-base-content/60">支持填 -1 表示不限；留空后保存可清除对应覆盖值。</div>
                </div>
            </div>
            <div class="mb-4 flex gap-2 flex-wrap">
                <button class="btn btn-sm btn-primary" onclick="saveUserQuotaOverrides(${u.id})">保存配额调整</button>
                <button class="btn btn-sm btn-warning" onclick="resetPassword(${u.id})">重置密码</button>
            </div>
            <div class="divider">订阅记录</div>
            <div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>套餐</th><th>周期</th><th>开始</th><th>结束</th><th>状态</th></tr></thead><tbody>
            ${subscriptions.map(s => `<tr><td>${escapeHtml(s.planName)}</td><td>${escapeHtml(formatAdminBillingCycle(s.billingCycle))}</td><td>${new Date(s.startAt).toLocaleDateString('zh-CN')}</td><td>${new Date(s.endAt).toLocaleDateString('zh-CN')}</td><td><span class="badge badge-xs ${s.status === 'active' ? 'badge-success' : 'badge-ghost'}">${escapeHtml(formatAdminSubscriptionStatus(s.status))}</span></td></tr>`).join('') || '<tr><td colspan="5" class="text-center">无</td></tr>'}
            </tbody></table></div>
            <div class="divider">房间</div>
            <div class="flex flex-wrap gap-2">
            ${rooms.map(r => `<span class="badge badge-outline">${escapeHtml(r.roomName || r.roomId)}</span>`).join('') || '<span class="text-base-content/60">无</span>'}
            </div>`;

        document.getElementById('userDetailModal').showModal();
    } catch (err) {
        console.error('User detail error:', err);
        alert('获取用户详情失败');
    }
}

function showBalanceModal(userId, username, balance) {
    document.getElementById('bal-user-id').value = userId;
    document.getElementById('bal-user-info').textContent = `${username} - 当前余额: ¥${parseFloat(balance).toFixed(2)}`;
    document.getElementById('bal-amount').value = '';
    document.getElementById('bal-remark').value = '';
    document.getElementById('balanceModal').showModal();
}

async function submitBalanceAdjust() {
    const userId = document.getElementById('bal-user-id').value;
    const amount = parseFloat(document.getElementById('bal-amount').value);
    const remark = document.getElementById('bal-remark').value.trim();

    if (!amount || isNaN(amount)) { alert('请输入有效金额'); return; }
    if (!remark) { alert('请填写备注'); return; }

    const res = await Auth.apiFetch(`/api/admin/users/${userId}/adjust-balance`, {
        method: 'POST', body: JSON.stringify({ amount, remark })
    });
    const data = await res.json();
    document.getElementById('balanceModal').close();
    if (res.ok) { alert(data.message); loadUsers(1); }
    else alert(data.error || '操作失败');
}

async function toggleUserStatus(userId) {
    if (!confirm('确定要切换该用户的状态吗？')) return;
    const res = await Auth.apiFetch(`/api/admin/users/${userId}/toggle-status`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) { alert(data.message); loadUsers(1); }
    else alert(data.error || '操作失败');
}

async function resetPassword(userId) {
    const pwd = prompt('请输入新密码（至少6位）:');
    if (!pwd || pwd.length < 6) { if (pwd !== null) alert('密码至少6位'); return; }
    const res = await Auth.apiFetch(`/api/admin/users/${userId}/reset-password`, {
        method: 'POST', body: JSON.stringify({ newPassword: pwd })
    });
    const data = await res.json();
    if (res.ok) alert(data.message);
    else alert(data.error || '操作失败');
}

// ==================== Orders ====================
const typeLabels = { plan: '套餐', addon: '扩容包', recharge: '充值' };
const statusLabels = { paid: '已支付', pending: '待支付', cancelled: '已取消', refunded: '已退款', failed: '失败' };
const adminOrderCache = new Map();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseOrderMetadata(order) {
    if (!order) return {};
    const raw = order.metadata;
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }
    return {};
}

function formatJsonBlock(value, fallback = '暂无') {
    if (value == null || value === '') return fallback;
    if (typeof value === 'string') {
        try {
            return JSON.stringify(JSON.parse(value), null, 2);
        } catch {
            return value;
        }
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function getAdminRechargeChannelLabel(order) {
    const metadata = parseOrderMetadata(order);
    if (metadata.label) return String(metadata.label);
    const paymentMethod = String(order?.paymentMethod || '').trim();
    if (!paymentMethod) return '';
    const [channel, ...rest] = paymentMethod.split('_');
    const method = rest.join('_');
    const channelMap = { fixed_qr: '固定码', futong: '三方支付', bepusdt: '虚拟币支付' };
    const methodMap = { wxpay: '微信', alipay: '支付宝', usdt: 'USDT' };
    const channelLabel = channelMap[channel] || channel;
    const methodLabel = methodMap[method] || method || '';
    return methodLabel && method !== 'usdt' ? `${channelLabel} · ${methodLabel}` : channelLabel;
}

function showOrderRequestDetail(orderId) {
    const order = adminOrderCache.get(Number(orderId));
    if (!order) {
        alert('订单数据不存在，请刷新后重试');
        return;
    }
    const metadata = parseOrderMetadata(order);
    const request = metadata.channelRequest || null;
    const upstream = metadata.upstream || null;
    document.getElementById('order-detail-title').textContent = `订单详情 · ${order.orderNo || '-'}`;
    document.getElementById('order-detail-channel').textContent = getAdminRechargeChannelLabel(order) || '暂无';
    document.getElementById('order-detail-url').textContent = request?.url || '暂无';
    document.getElementById('order-detail-request').textContent = formatJsonBlock(request?.payload || null);
    document.getElementById('order-detail-response').textContent = formatJsonBlock(upstream || metadata.notifyPayload || null);
    document.getElementById('orderRequestModal').showModal();
}

function formatAdminOrderContent(order) {
    const metadata = parseOrderMetadata(order);
    const responseStatus = metadata.channelResponseStatus;
    const channelLabel = order?.type === 'recharge' ? getAdminRechargeChannelLabel(order) : '';
    const info = [];

    if (channelLabel) {
        info.push(`<div class="text-[11px] leading-5 text-base-content/60"><span class="font-semibold text-base-content/70">充值通道：</span>${escapeHtml(channelLabel)}</div>`);
    }
    if (responseStatus) {
        info.push(`<div class="text-[11px] leading-5 text-base-content/60"><span class="font-semibold text-base-content/70">响应状态：</span>${escapeHtml(responseStatus)}</div>`);
    }

    return `<div class="space-y-1"><div>${escapeHtml(order.itemName || '-')}</div>${info.join('')}</div>`;
}

async function loadAdminOrders(page) {
    try {
        const search = document.getElementById('order-search').value;
        const type = document.getElementById('order-type-filter').value;
        const params = new URLSearchParams({ page, limit: 20, search, type });
        const res = await Auth.apiFetch(`/api/admin/orders?${params}`);
        const data = await res.json();
        const tbody = document.getElementById('admin-orders-tbody');

        if (!data.orders || data.orders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-base-content/60">暂无数据</td></tr>';
            return;
        }

        adminOrderCache.clear();
        tbody.innerHTML = data.orders.map(o => {
            adminOrderCache.set(Number(o.id), o);
            const isPendingRecharge = o.type === 'recharge' && o.status === 'pending';
            const badgeClass = o.status === 'paid'
                ? 'badge-success'
                : (o.status === 'failed' ? 'badge-error' : 'badge-ghost');
            const viewButton = `<button class="btn btn-xs btn-ghost" onclick="showOrderRequestDetail(${o.id})">查看</button>`;
            const actionHtml = isPendingRecharge
                ? `<div class="flex gap-1 flex-wrap justify-end">${viewButton}
                    <button class="btn btn-xs btn-success btn-outline" onclick="markRechargeOrderPaid(${o.id})">标记已支付</button>
                    <button class="btn btn-xs btn-error btn-outline" onclick="cancelRechargeOrder(${o.id})">取消</button>
                </div>`
                : `<div class="flex gap-1 flex-wrap justify-end">${viewButton}</div>`;
            return `<tr>
                <td class="text-xs align-top">${escapeHtml(o.orderNo || '-')}</td>
                <td class="align-top">${escapeHtml(o.username || '-')}</td>
                <td class="align-top">${escapeHtml(typeLabels[o.type] || o.type || '-')}</td>
                <td class="align-top min-w-[360px]">${formatAdminOrderContent(o)}</td>
                <td class="font-mono align-top">¥${parseFloat(o.amount).toFixed(2)}</td>
                <td class="align-top"><span class="badge badge-sm ${badgeClass}">${escapeHtml(statusLabels[o.status] || o.status || '-')}</span></td>
                <td class="text-xs align-top">${new Date(o.createdAt).toLocaleString('zh-CN')}</td>
                <td class="align-top">${actionHtml}</td>
            </tr>`;
        }).join('');

        renderPagination('admin-orders-pagination', data.pagination, 'loadAdminOrders');
    } catch (err) { console.error('Load orders error:', err); }
}

// ==================== Plans ====================
async function loadPlans() {
    const res = await Auth.apiFetch('/api/admin/plans');
    const data = await res.json();
    const container = document.getElementById('plans-list');
    if (!data.plans || data.plans.length === 0) {
        container.innerHTML = '<p class="text-base-content/60">暂无套餐</p>';
        return;
    }
    container.innerHTML = data.plans.map(p => {
        const roomText = p.roomLimit === -1 ? '无限' : p.roomLimit;
        const dailyText = p.dailyRoomCreateLimit === -1 ? '无限' : (p.dailyRoomCreateLimit || '无限');
        const priceBadges = [
            Number(p.priceMonthly || 0) > 0 ? `月¥${p.priceMonthly}` : '月已删',
            Number(p.priceQuarterly || 0) > 0 ? `季¥${p.priceQuarterly}` : '季已删',
            Number(p.priceAnnual || 0) > 0 ? `年¥${p.priceAnnual}` : '年已删',
        ].join(' / ');
        return `
        <div class="card bg-base-100 border ${p.isActive ? 'border-base-300' : 'border-error opacity-60'}">
            <div class="card-body p-4">
                <div class="flex justify-between items-start">
                    <div>
                        <h4 class="font-bold">${p.name} <span class="text-xs text-base-content/60">(${p.code})</span></h4>
                        <p class="text-sm">房间: ${roomText} | 每日新建: ${dailyText} | AI: ${p.aiCreditsMonthly || 0}点/月 | ${priceBadges}</p>
                        ${!p.isActive ? '<span class="badge badge-error badge-sm">已下架</span>' : ''}
                    </div>
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="editPlan(${JSON.stringify(p).replace(/"/g, '&quot;')})">编辑</button>
                        <button class="btn btn-xs ${p.isActive ? 'btn-error' : 'btn-success'} btn-outline" onclick="togglePlanStatus(${p.id})">${p.isActive ? '下架' : '上架'}</button>
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}

function normalizePlanFeatureFlags(rawFlags) {
    if (!rawFlags) return {};
    if (typeof rawFlags === 'string') {
        try {
            return JSON.parse(rawFlags);
        } catch (err) {
            console.warn('Parse plan feature flags error:', err);
            return {};
        }
    }
    return rawFlags;
}

function showPlanForm(plan) {
    const featureFlags = normalizePlanFeatureFlags(plan?.featureFlags);
    currentPlanFeatureFlags = { ...featureFlags };
    document.getElementById('plan-form-title').textContent = plan ? '编辑套餐' : '新增套餐';
    document.getElementById('pf-id').value = plan?.id || '';
    document.getElementById('pf-name').value = plan?.name || '';
    document.getElementById('pf-code').value = plan?.code || '';
    document.getElementById('pf-code').disabled = !!plan;
    document.getElementById('pf-room').value = plan?.roomLimit ?? '';
    document.getElementById('pf-daily').value = plan?.dailyRoomCreateLimit ?? -1;
    document.getElementById('pf-ai').value = plan?.aiCreditsMonthly ?? 0;
    document.getElementById('pf-pm').value = plan?.priceMonthly ?? '';
    document.getElementById('pf-pq').value = plan?.priceQuarterly ?? '';
    document.getElementById('pf-py').value = plan?.priceAnnual ?? '';
    document.getElementById('pf-sort').value = plan?.sortOrder ?? 0;
    document.getElementById('pf-feature-export').checked = Boolean(featureFlags.export || featureFlags.data_export);
    document.getElementById('pf-feature-ai-live-recap').checked = Boolean(featureFlags.ai_live_recap || featureFlags.aiLiveRecap);
    document.getElementById('pf-feature-priority-support').checked = Boolean(featureFlags.priority_support || featureFlags.prioritySupport);
    document.getElementById('planFormModal').showModal();
}

function editPlan(plan) { showPlanForm(plan); }

function confirmDeletePlanPrice(periodKey) {
    const meta = PLAN_PRICE_FIELD_META[periodKey];
    if (!meta) return;

    const input = document.getElementById(meta.inputId);
    if (!input) return;

    const otherPeriods = Object.entries(PLAN_PRICE_FIELD_META).filter(([key]) => key !== periodKey);
    const hasOtherActivePrice = otherPeriods.some(([, item]) => {
        const otherInput = document.getElementById(item.inputId);
        return Number.parseFloat(otherInput?.value || '0') > 0;
    });

    if (!hasOtherActivePrice) {
        alert('套餐至少要保留一个大于 0 的价格周期，不能把最后一个价格也删除。');
        return;
    }

    const planName = document.getElementById('pf-name').value.trim() || '当前套餐';
    const currentValue = Number.parseFloat(input.value || '0');
    if (currentValue <= 0) {
        alert(`${meta.label}当前已经是 0，无需重复删除。`);
        return;
    }

    const confirmed = confirm(`确认删除「${planName}」的${meta.label}吗？\n\n删除后该计费周期会从前台下线，用户将无法再购买这个周期。`);
    if (!confirmed) return;

    input.value = '0';
}

async function submitPlanForm() {
    const id = document.getElementById('pf-id').value;
    const parseIntOr = (elementId, fallback) => {
        const value = parseInt(document.getElementById(elementId).value, 10);
        return Number.isFinite(value) ? value : fallback;
    };
    const parseFloatOr = (elementId, fallback = 0) => {
        const value = parseFloat(document.getElementById(elementId).value);
        return Number.isFinite(value) ? value : fallback;
    };
    const featureFlags = {
        ...currentPlanFeatureFlags,
        export: document.getElementById('pf-feature-export').checked,
        ai_live_recap: document.getElementById('pf-feature-ai-live-recap').checked,
        priority_support: document.getElementById('pf-feature-priority-support').checked,
    };
    delete featureFlags.data_export;
    delete featureFlags.aiLiveRecap;
    delete featureFlags.prioritySupport;

    const body = {
        name: document.getElementById('pf-name').value,
        code: document.getElementById('pf-code').value,
        roomLimit: parseIntOr('pf-room', -1),
        dailyRoomCreateLimit: parseIntOr('pf-daily', -1),
        aiCreditsMonthly: parseIntOr('pf-ai', 0),
        priceMonthly: parseFloatOr('pf-pm', 0),
        priceQuarterly: parseFloatOr('pf-pq', 0),
        priceAnnual: parseFloatOr('pf-py', 0),
        sortOrder: parseIntOr('pf-sort', 0),
        featureFlags,
    };

    if (![body.priceMonthly, body.priceQuarterly, body.priceAnnual].some(price => Number(price) > 0)) {
        alert('套餐至少要保留一个大于 0 的价格周期。');
        return;
    }

    const url = id ? `/api/admin/plans/${id}` : '/api/admin/plans';
    const method = id ? 'PUT' : 'POST';
    const res = await Auth.apiFetch(url, { method, body: JSON.stringify(body) });
    const data = await res.json();
    document.getElementById('planFormModal').close();
    if (res.ok) { alert(data.message); loadPlans(); }
    else alert(data.error || '操作失败');
}

async function togglePlanStatus(id) {
    const res = await Auth.apiFetch(`/api/admin/plans/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) { alert(data.message); loadPlans(); }
    else alert(data.error || '操作失败');
}

// ==================== Addons ====================
async function loadAddons() {
    const res = await Auth.apiFetch('/api/admin/addons');
    const data = await res.json();
    const container = document.getElementById('addons-list');
    if (!data.addons || data.addons.length === 0) {
        container.innerHTML = '<p class="text-base-content/60">暂无扩容包</p>';
        return;
    }
    container.innerHTML = data.addons.map(a => `
        <div class="card bg-base-100 border ${a.isActive ? 'border-base-300' : 'border-error opacity-60'}">
            <div class="card-body p-4">
                <div class="flex justify-between items-center">
                    <div>
                        <h4 class="font-bold">${a.name}</h4>
                        <p class="text-sm">+${a.roomCount}房间 | 月¥${a.priceMonthly || 0} / 季¥${a.priceQuarterly || 0} / 年¥${a.priceAnnual || 0}</p>
                        <p class="text-xs text-base-content/60 mt-1">购买时会跟随当前企业版会员有效期，并按剩余天数折算本期价格。</p>
                    </div>
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="editAddon(${JSON.stringify(a).replace(/"/g, '&quot;')})">编辑</button>
                        <button class="btn btn-xs btn-error btn-outline" onclick="deleteAddon(${a.id})">下架</button>
                    </div>
                </div>
            </div>
        </div>`).join('');
}

function showAddonForm(addon) {
    document.getElementById('addon-form-title').textContent = addon ? '编辑扩容包' : '新增扩容包';
    document.getElementById('af-id').value = addon?.id || '';
    document.getElementById('af-name').value = addon?.name || '';
    document.getElementById('af-count').value = addon?.roomCount || '';
    document.getElementById('af-price-monthly').value = addon?.priceMonthly ?? '';
    document.getElementById('af-price-quarterly').value = addon?.priceQuarterly ?? '';
    document.getElementById('af-price-annual').value = addon?.priceAnnual ?? '';
    document.getElementById('af-desc').value = addon?.description || '';
    document.getElementById('addonFormModal').showModal();
}

function editAddon(addon) { showAddonForm(addon); }

async function submitAddonForm() {
    const id = document.getElementById('af-id').value;
    const body = {
        name: document.getElementById('af-name').value,
        roomCount: parseInt(document.getElementById('af-count').value),
        priceMonthly: parseFloat(document.getElementById('af-price-monthly').value || '0'),
        priceQuarterly: parseFloat(document.getElementById('af-price-quarterly').value || '0'),
        priceAnnual: parseFloat(document.getElementById('af-price-annual').value || '0'),
        description: document.getElementById('af-desc').value,
    };

    if (body.priceMonthly <= 0 && body.priceQuarterly <= 0 && body.priceAnnual <= 0) {
        alert('扩容包至少要保留一个大于 0 的基准价格。');
        return;
    }

    const url = id ? `/api/admin/addons/${id}` : '/api/admin/addons';
    const method = id ? 'PUT' : 'POST';
    const res = await Auth.apiFetch(url, { method, body: JSON.stringify(body) });
    const data = await res.json();
    document.getElementById('addonFormModal').close();
    if (res.ok) { alert(data.message); loadAddons(); }
    else alert(data.error || '操作失败');
}

async function deleteAddon(id) {
    if (!confirm('确定要下架此扩容包？')) return;
    const res = await Auth.apiFetch(`/api/admin/addons/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) { alert(data.message); loadAddons(); }
    else alert(data.error || '操作失败');
}

// ==================== Settings ====================
let adminSettingsGroups = [];
let adminSettingsSecretConfigured = {};
let adminSettingsActiveGroupByContainer = {};

function renderAdminSettingHelpIcon(detailText) {
    if (!detailText) return '';
    return `
        <span
            class="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-warning/40 bg-warning/10 text-[11px] font-bold text-warning cursor-help align-middle"
            title="${escapeHtml(detailText)}"
            aria-label="功能说明"
        >!</span>
    `;
}

function renderAdminSettingLabel(label, detailText, className = 'font-medium') {
    return `<span class="${escapeHtml(className)}">${escapeHtml(label)}${renderAdminSettingHelpIcon(detailText)}</span>`;
}

function renderAdminSettingDescription(hintText = '', detailText = '') {
    const normalizedHint = String(hintText || '').trim();
    const normalizedDetail = String(detailText || '').trim();
    const detailOnly = normalizedDetail && normalizedDetail !== normalizedHint ? normalizedDetail : '';

    if (!normalizedHint && !detailOnly) {
        return '';
    }

    return `
        <div class="mt-2 space-y-1.5">
            ${normalizedHint ? `<div class="text-xs text-base-content/60 leading-6">${escapeHtml(normalizedHint)}</div>` : ''}
            ${detailOnly ? `<div class="rounded-xl border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-base-content/75 leading-6">${escapeHtml(detailOnly)}</div>` : ''}
        </div>
    `;
}

function renderAdminSettingActions(field) {
    if (field.key !== 'REDIS_URL') return '';
    return `
        <div class="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" class="btn btn-xs btn-outline btn-info" onclick="testRedisSettingsConnection(this)">测试 Redis 是否可用</button>
            <span class="text-xs text-base-content/60 leading-6" data-redis-test-result>未测试</span>
        </div>
    `;
}

function isSchemeASettingsGroup(group) {
    return String(group?.key || '').startsWith('schemeA');
}

function getAdminSettingsGroupsByScope(scope = 'core') {
    return (Array.isArray(adminSettingsGroups) ? adminSettingsGroups : []).filter(group => (
        scope === 'schemeA' ? isSchemeASettingsGroup(group) : !isSchemeASettingsGroup(group)
    ));
}

function switchAdminSettingsTab(containerId, groupKey) {
    const normalizedContainerId = String(containerId || '').trim();
    const normalizedGroupKey = String(groupKey || '').trim();
    if (!normalizedContainerId || !normalizedGroupKey) return false;

    adminSettingsActiveGroupByContainer[normalizedContainerId] = normalizedGroupKey;
    const container = document.getElementById(normalizedContainerId);
    if (!container) return false;

    container.querySelectorAll('[data-settings-tab-button]').forEach(button => {
        const isActive = button.dataset.settingsTabButton === normalizedGroupKey;
        button.classList.toggle('tab-active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    container.querySelectorAll('[data-settings-tab-panel]').forEach(panel => {
        panel.classList.toggle('hidden', panel.dataset.settingsTabPanel !== normalizedGroupKey);
    });

    return false;
}

function renderAdminSettingField(field, settings) {
    const rawValue = settings[field.key] !== undefined ? settings[field.key] : '';
    const value = rawValue === null || rawValue === undefined ? '' : rawValue;
    const hintText = [field.hint || '', field.restartRequired ? '保存后通常需要重启主服务或重拉子 worker。' : '']
        .filter(Boolean)
        .join(' ');
    const detailText = field.tooltip || hintText;

    if (field.type === 'toggle') {
        const checked = value === true || value === 'true' || value === 1 || value === '1';
        return `
            <label class="label cursor-pointer justify-start gap-4 rounded-2xl border border-base-300 bg-base-100 px-4 py-3 items-start">
                <input type="checkbox" class="toggle toggle-primary mt-1" data-key="${escapeHtml(field.key)}" ${checked ? 'checked' : ''}>
                <div class="flex-1 min-w-0">
                    <span class="block">${renderAdminSettingLabel(field.label, detailText)}</span>
                    ${renderAdminSettingDescription(hintText, detailText)}
                </div>
            </label>
        `;
    }

    if (field.type === 'select') {
        const options = Array.isArray(field.options) ? field.options : [];
        return `
            <label class="form-control rounded-2xl border border-base-300 bg-base-100 px-4 py-3">
                <span class="label-text">${renderAdminSettingLabel(field.label, detailText, 'label-text font-medium')}</span>
                <select class="select select-bordered mt-2" data-key="${escapeHtml(field.key)}">
                    ${options.map(option => `<option value="${escapeHtml(option.value)}" ${String(value) === String(option.value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                </select>
                ${renderAdminSettingDescription(hintText, detailText)}
            </label>
        `;
    }

    const isSecret = field.secret === true;
    const hasSecret = adminSettingsSecretConfigured[field.key] === true;
    const inputType = field.type === 'number' ? 'number' : (field.type === 'password' || isSecret ? 'password' : 'text');
    const placeholder = isSecret && hasSecret && `${value}` === ''
        ? '已配置，留空表示保持现有值'
        : (field.placeholder || '');
    const displayValue = isSecret ? '' : `${value}`;

    return `
        <label class="form-control rounded-2xl border border-base-300 bg-base-100 px-4 py-3">
            <span class="label-text">${renderAdminSettingLabel(field.label, detailText, 'label-text font-medium')}</span>
            <input
                type="${escapeHtml(inputType)}"
                class="input input-bordered mt-2"
                data-key="${escapeHtml(field.key)}"
                value="${escapeHtml(displayValue)}"
                placeholder="${escapeHtml(placeholder)}"
            >
            ${renderAdminSettingActions(field)}
            ${renderAdminSettingDescription(hintText, detailText)}
        </label>
    `;
}

function renderAdminSettingsForm(groups, settings, containerId = 'settings-form') {
    const form = document.getElementById(containerId);
    if (!form) return;

    const normalizedGroups = Array.isArray(groups) ? groups : [];
    if (normalizedGroups.length === 0) {
        form.innerHTML = '<div class="rounded-box bg-base-200/80 px-4 py-4 text-sm text-base-content/60">当前分组暂无可配置项。</div>';
        return;
    }

    const activeGroupKey = adminSettingsActiveGroupByContainer[containerId] && normalizedGroups.some(group => group.key === adminSettingsActiveGroupByContainer[containerId])
        ? adminSettingsActiveGroupByContainer[containerId]
        : String(normalizedGroups[0]?.key || '');
    adminSettingsActiveGroupByContainer[containerId] = activeGroupKey;

    const tabBar = normalizedGroups.length > 1 ? `
        <div class="tabs tabs-boxed flex flex-wrap gap-2 bg-base-200/80 p-2 mb-4 rounded-2xl">
            ${normalizedGroups.map(group => `
                <button
                    type="button"
                    class="tab ${group.key === activeGroupKey ? 'tab-active' : ''}"
                    data-settings-tab-button="${escapeHtml(group.key)}"
                    aria-selected="${group.key === activeGroupKey ? 'true' : 'false'}"
                    onclick="return switchAdminSettingsTab('${escapeHtml(containerId)}', '${escapeHtml(group.key)}')"
                >${escapeHtml(group.title || '')}</button>
            `).join('')}
        </div>
    ` : '';

    const panels = normalizedGroups.map(group => `
        <div data-settings-tab-panel="${escapeHtml(group.key)}" class="${group.key === activeGroupKey ? '' : 'hidden'}">
            <div class="rounded-[1.25rem] border border-base-300 bg-base-200/50 p-4">
                <div class="mb-4">
                    <h4 class="font-semibold">${escapeHtml(group.title || '')}</h4>
                    <p class="text-xs text-base-content/60 mt-1 leading-6">${escapeHtml(group.description || '')}</p>
                </div>
                <div class="space-y-4">
                    ${(Array.isArray(group.fields) ? group.fields : []).map(field => renderAdminSettingField(field, settings)).join('')}
                </div>
            </div>
        </div>
    `).join('');

    form.innerHTML = `${tabBar}<div class="space-y-4">${panels}</div>`;
}

function renderAllAdminSettingsForms(settings) {
    renderAdminSettingsForm(getAdminSettingsGroupsByScope('core'), settings, 'settings-form');
    renderAdminSettingsForm(getAdminSettingsGroupsByScope('schemeA'), settings, 'schemea-settings-form');
}

async function loadSettingsForm() {
    const res = await Auth.apiFetch('/api/admin/settings');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载系统设置失败');

    adminSettingsGroups = Array.isArray(data.groups) ? data.groups : [];
    adminSettingsSecretConfigured = data.secretConfigured || {};
    renderAllAdminSettingsForms(data.settings || {});
}

async function saveSettings(formSelector = '#settings-form') {
    const normalizedSelector = String(formSelector || '#settings-form').startsWith('#')
        ? String(formSelector || '#settings-form')
        : `#${String(formSelector || 'settings-form')}`;
    const settings = {};
    document.querySelectorAll(`${normalizedSelector} [data-key]`).forEach(el => {
        const key = el.dataset.key;
        if (el.type === 'checkbox') settings[key] = el.checked;
        else settings[key] = el.value;
    });

    const res = await Auth.apiFetch('/api/admin/settings', {
        method: 'PUT', body: JSON.stringify({ settings })
    });
    const data = await res.json();
    if (res.ok) {
        alert(data.warning ? `${data.message}

${data.warning}` : data.message);
        await loadSettingsForm();
        return;
    }
    alert(data.error || '保存失败');
}

async function testRedisSettingsConnection(button) {
    const wrapper = button?.closest('.form-control');
    const input = wrapper?.querySelector('[data-key="REDIS_URL"]') || document.querySelector('#schemea-settings-form [data-key="REDIS_URL"]');
    const resultEl = wrapper?.querySelector('[data-redis-test-result]');
    const redisUrl = String(input?.value || '').trim();

    if (!redisUrl) {
        if (resultEl) {
            resultEl.className = 'text-xs text-error leading-6';
            resultEl.textContent = '请先填写 Redis URL';
        }
        return false;
    }

    if (button) {
        button.disabled = true;
        button.classList.add('loading');
    }
    if (resultEl) {
        resultEl.className = 'text-xs text-base-content/60 leading-6';
        resultEl.textContent = '测试中...';
    }

    try {
        const res = await Auth.apiFetch('/api/admin/settings/redis/test', {
            method: 'POST',
            body: JSON.stringify({ redisUrl }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || 'Redis 测试失败');
        }
        if (resultEl) {
            resultEl.className = 'text-xs text-success leading-6';
            resultEl.textContent = data.message || `Redis 可用，延迟 ${data.latencyMs}ms`;
        }
    } catch (error) {
        if (resultEl) {
            resultEl.className = 'text-xs text-error leading-6';
            resultEl.textContent = error.message || 'Redis 测试失败';
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.classList.remove('loading');
        }
    }

    return false;
}

// ==================== Session Maintenance ====================
const SESSION_MAINTENANCE_TASK_LABELS = {
    'cleanup-stale-live': '陈旧 LIVE 清理',
    cleanup_stale_live_events: '陈旧 LIVE 清理',
    'archive-room-stale': '单房间陈旧 LIVE 归档',
    archive_stale_live_events_room: '单房间陈旧 LIVE 归档',
    'consolidate-recent': '最近碎片场次扫描',
    consolidate_recent_sessions: '最近碎片场次扫描',
    'merge-continuity': '同日连续场次合并',
    merge_continuity_sessions: '同日连续场次合并',
    'fix-orphaned': '孤儿事件修复',
    fix_orphaned_events: '孤儿事件修复',
    'delete-empty': '空场次清理',
    delete_empty_sessions: '空场次清理',
    'rebuild-missing': '缺失场次重建',
    rebuild_missing_sessions: '缺失场次重建',
    'disconnect-pending-archive': '断线待归档',
    pending_archive_scheduled: '断线待归档',
    pending_archive_cancelled: '断线待归档已取消',
    'disconnect-resume': '断线续场',
    reconnect_resume_session: '断线续场',
    'archive-session': '自动归档',
    execute_archive_session: '自动归档',
    preconnect_stale_archive: '开播前遗留事件清理',
};

const SESSION_MAINTENANCE_STATUS_META = {
    running: { label: '执行中', cls: 'badge-info' },
    success: { label: '成功', cls: 'badge-success' },
    failed: { label: '失败', cls: 'badge-error' },
    scheduled: { label: '已计划', cls: 'badge-warning' },
    skipped: { label: '跳过', cls: 'badge-ghost' },
    cancelled: { label: '已取消', cls: 'badge-ghost' },
};

const sessionMaintenanceConfigGroups = [
    {
        title: '断线续场与归档',
        description: '控制断线后保留多久继续视为同一场，以及多久后才真正归档。',
        fields: [
            { key: 'resumeWindowMinutes', type: 'number', label: '断线保留窗口（分钟）', min: 0, step: 1, hint: '在这个时间内重连，会继续沿用上一场；填 0 表示关闭续场。' },
            { key: 'archiveDelayMinutes', type: 'number', label: '断线延迟归档（分钟）', min: 0, step: 1, hint: '断线后延迟多久再创建 session，避免短抖动切成多场。' },
        ],
    },
    {
        title: '陈旧 LIVE 清理',
        description: '处理漏掉下播事件、长时间未归档、跨场污染等问题。',
        fields: [
            { key: 'startupCleanupEnabled', type: 'toggle', label: '启动时执行陈旧 LIVE 清理', hint: '服务启动后先扫一轮，防止上次异常退出遗留脏数据。' },
            { key: 'staleCleanupIntervalMinutes', type: 'number', label: '陈旧 LIVE 定时清理间隔（分钟）', min: 0, step: 1, hint: '填 0 可暂停定时任务，仅保留手动执行。' },
            { key: 'staleGapThresholdMinutes', type: 'number', label: '大时间断点阈值（分钟）', min: 1, step: 1, hint: '两条事件之间超过该阈值，就视为应该拆成新场次。' },
            { key: 'staleSplitAgeMinutes', type: 'number', label: '强制切分老事件年龄（分钟）', min: 1, step: 1, hint: '当前 LIVE 中存在特别老的事件时，会先切出去归档。' },
            { key: 'staleArchiveAllAgeMinutes', type: 'number', label: '全部陈旧事件直接归档阈值（分钟）', min: 1, step: 1, hint: '如果整段 LIVE 都已经很久没有新事件，可整体归档。' },
        ],
    },
    {
        title: '碎片场次扫描与合并',
        description: '自动扫描最近若干小时场次，合并同一天内间隔很短的碎片场次。',
        fields: [
            { key: 'startupConsolidationEnabled', type: 'toggle', label: '启动时执行碎片场次扫描', hint: '适合在服务重启后快速补一轮碎片整合。' },
            { key: 'consolidationIntervalMinutes', type: 'number', label: '碎片场次扫描间隔（分钟）', min: 0, step: 1, hint: '填 0 可暂停自动扫描，仅保留手动合并。' },
            { key: 'consolidationLookbackHours', type: 'number', label: '扫描最近碎片场次（小时）', min: 1, step: 1, hint: '定时任务只扫描这个时间窗口内的场次。' },
            { key: 'consolidationGapMinutes', type: 'number', label: '自动合并间隔阈值（分钟）', min: 1, step: 1, hint: '同一天内，小于该间隔的碎片场次会被自动合并。' },
            { key: 'manualMergeGapMinutes', type: 'number', label: '手动合并间隔阈值（分钟）', min: 1, step: 1, hint: '点击“执行同日连续场次合并”时使用的阈值。' },
        ],
    },
    {
        title: '日志保留',
        description: '控制运维日志保留时长，避免记录无限增长。',
        fields: [
            { key: 'logRetentionDays', type: 'number', label: '运维日志保留天数', min: 1, step: 1, hint: '后台可按该时长清理旧日志。' },
        ],
    },
];

function getSessionMaintenanceRawValue(source, keys, fallback) {
    for (const key of keys) {
        if (source && source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
    return fallback;
}

function coerceSessionMaintenanceBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function coerceSessionMaintenanceNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSessionMaintenanceConfig(raw = {}) {
    return {
        resumeWindowMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['resumeWindowMinutes', 'resume_window_minutes', 'session_maintenance_resume_window_minutes'], 30), 30),
        archiveDelayMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['archiveDelayMinutes', 'archive_delay_minutes', 'session_maintenance_archive_delay_minutes'], 30), 30),
        startupCleanupEnabled: coerceSessionMaintenanceBoolean(getSessionMaintenanceRawValue(raw, ['startupCleanupEnabled', 'startup_cleanup_enabled', 'session_maintenance_startup_cleanup_enabled'], true), true),
        staleCleanupIntervalMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['staleCleanupIntervalMinutes', 'stale_cleanup_interval_minutes', 'session_maintenance_stale_cleanup_interval_minutes'], 30), 30),
        staleGapThresholdMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['staleGapThresholdMinutes', 'stale_gap_threshold_minutes', 'session_maintenance_stale_gap_threshold_minutes'], 60), 60),
        staleSplitAgeMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['staleSplitAgeMinutes', 'stale_split_age_minutes', 'session_maintenance_stale_split_age_minutes'], 120), 120),
        staleArchiveAllAgeMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['staleArchiveAllAgeMinutes', 'stale_archive_all_age_minutes', 'session_maintenance_stale_archive_all_age_minutes'], 30), 30),
        startupConsolidationEnabled: coerceSessionMaintenanceBoolean(getSessionMaintenanceRawValue(raw, ['startupConsolidationEnabled', 'startup_consolidation_enabled', 'session_maintenance_startup_consolidation_enabled'], true), true),
        consolidationIntervalMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['consolidationIntervalMinutes', 'consolidation_interval_minutes', 'session_maintenance_consolidation_interval_minutes'], 60), 60),
        consolidationLookbackHours: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['consolidationLookbackHours', 'consolidation_lookback_hours', 'session_maintenance_consolidation_lookback_hours'], 48), 48),
        consolidationGapMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['consolidationGapMinutes', 'consolidation_gap_minutes', 'session_maintenance_consolidation_gap_minutes'], 60), 60),
        manualMergeGapMinutes: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['manualMergeGapMinutes', 'manual_merge_gap_minutes', 'session_maintenance_manual_merge_gap_minutes'], 10), 10),
        logRetentionDays: coerceSessionMaintenanceNumber(getSessionMaintenanceRawValue(raw, ['logRetentionDays', 'log_retention_days', 'session_maintenance_log_retention_days'], 30), 30),
    };
}

function formatSessionMaintenanceTaskLabel(taskKey) {
    return SESSION_MAINTENANCE_TASK_LABELS[taskKey] || taskKey || '未命名任务';
}

function formatSessionMaintenanceStatusBadge(status) {
    const meta = SESSION_MAINTENANCE_STATUS_META[status] || { label: status || '未知', cls: 'badge-ghost' };
    return `<span class="badge badge-sm ${meta.cls}">${escapeHtml(meta.label)}</span>`;
}

function formatSessionMaintenanceDateTime(value, fallback = '—') {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return date.toLocaleString('zh-CN');
}

function formatSessionMaintenanceDuration(value, fallback = '—') {
    const durationMs = Number(value);
    if (!Number.isFinite(durationMs) || durationMs < 0) return fallback;
    if (durationMs < 1000) return `${durationMs}ms`;
    if (durationMs < 60 * 1000) return `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 0 : 1)}s`;
    return `${(durationMs / 60000).toFixed(durationMs >= 10 * 60000 ? 0 : 1)}m`;
}

function summarizeSessionMaintenanceObject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
    const preferredKeys = [
        'archived', 'mergedCount', 'deletedCount', 'sessionsCreated', 'eventsFixed',
        'collisionsFixed', 'groupsProcessed', 'roomId', 'sessionId', 'logId'
    ];
    const picked = [];
    for (const key of preferredKeys) {
        if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
            picked.push(`${key}=${input[key]}`);
        }
    }
    if (picked.length > 0) return picked.join(' · ');
    const entries = Object.entries(input).slice(0, 4).map(([key, value]) => `${key}=${typeof value === 'object' ? '[对象]' : value}`);
    return entries.join(' · ');
}

function setSessionMaintenanceActionResult(message, tone = 'info') {
    const element = document.getElementById('session-maintenance-action-result');
    if (!element) return;
    const classMap = {
        info: 'border-base-300 bg-base-200/80 text-base-content/70',
        success: 'border-success/30 bg-success/10 text-success-content',
        error: 'border-error/30 bg-error/10 text-error-content',
        warning: 'border-warning/30 bg-warning/10 text-warning-content',
    };
    element.className = `mt-4 rounded-2xl border px-4 py-4 text-sm leading-7 ${classMap[tone] || classMap.info}`;
    element.innerHTML = `<div class="font-semibold mb-1">最近动作</div><div>${escapeHtml(message || '暂无')}</div>`;
}

function renderSessionMaintenanceHeroMeta() {
    const element = document.getElementById('session-maintenance-hero-meta');
    if (!element) return;
    const config = sessionMaintenanceConfigCache || normalizeSessionMaintenanceConfig({});
    const overview = sessionMaintenanceOverviewCache || {};
    const pendingArchives = overview.pendingArchives ?? overview.pendingArchiveCount ?? overview.stats?.pendingArchives;
    const tags = [
        `断线保留 ${config.resumeWindowMinutes} 分钟`,
        `延迟归档 ${config.archiveDelayMinutes} 分钟`,
        `清理间隔 ${config.staleCleanupIntervalMinutes} 分钟`,
        `碎片扫描 ${config.consolidationLookbackHours} 小时`,
    ];
    if (pendingArchives !== undefined && pendingArchives !== null && pendingArchives !== '') {
        tags.push(`待归档 ${pendingArchives} 场`);
    }
    element.innerHTML = tags.map(tag => `<span class="badge badge-ghost badge-sm">${escapeHtml(tag)}</span>`).join('');
}

function renderSessionMaintenanceConfigForm() {
    const form = document.getElementById('session-maintenance-config-form');
    if (!form) return;
    const config = sessionMaintenanceConfigCache || normalizeSessionMaintenanceConfig({});
    form.innerHTML = sessionMaintenanceConfigGroups.map(group => `
        <div class="rounded-[1.25rem] border border-base-300 bg-base-200/50 p-4">
            <div class="mb-4">
                <h4 class="font-semibold">${escapeHtml(group.title)}</h4>
                <p class="text-xs text-base-content/60 mt-1 leading-6">${escapeHtml(group.description)}</p>
            </div>
            <div class="space-y-4">
                ${group.fields.map(field => {
        const value = config[field.key];
        if (field.type === 'toggle') {
            return `
                            <label class="label cursor-pointer justify-start gap-4 rounded-2xl border border-base-300 bg-base-100 px-4 py-3 items-start">
                                <input type="checkbox" class="toggle toggle-primary mt-1" data-session-maintenance-key="${field.key}" ${value ? 'checked' : ''}>
                                <div class="flex-1 min-w-0">
                                    <span class="block">${renderAdminSettingLabel(field.label, field.tooltip || field.hint || '', 'font-medium')}</span>
                                    ${renderAdminSettingDescription(field.hint || '', field.tooltip || field.hint || '')}
                                </div>
                            </label>
                        `;
        }
        return `
                        <label class="form-control rounded-2xl border border-base-300 bg-base-100 px-4 py-3">
                            <span class="label-text">${renderAdminSettingLabel(field.label, field.tooltip || field.hint || '', 'label-text font-medium')}</span>
                            <input
                                type="number"
                                class="input input-bordered mt-2"
                                data-session-maintenance-key="${field.key}"
                                min="${field.min ?? ''}"
                                step="${field.step ?? 1}"
                                value="${escapeHtml(value)}"
                            >
                            ${renderAdminSettingDescription(field.hint || '', field.tooltip || field.hint || '')}
                        </label>
                    `;
    }).join('')}
            </div>
        </div>
    `).join('');
}

function renderSessionMaintenanceOverview() {
    const statsWrap = document.getElementById('session-maintenance-overview-stats');
    const overviewPanel = document.getElementById('session-maintenance-overview-panel');
    const schedulerPanel = document.getElementById('session-maintenance-scheduler-panel');
    const overview = sessionMaintenanceOverviewCache || {};
    const config = sessionMaintenanceConfigCache || normalizeSessionMaintenanceConfig({});
    const stats = overview.stats || overview.summary || {};
    const latestRuns = Array.isArray(overview.latestRuns) ? overview.latestRuns : (Array.isArray(overview.recentRuns) ? overview.recentRuns : []);
    const totalRuns24h = stats.totalRuns24h ?? stats.total24h ?? latestRuns.length;
    const successCount24h = stats.successCount24h ?? stats.success24h ?? latestRuns.filter(item => item.status === 'success').length;
    const failedCount24h = stats.failedCount24h ?? stats.failed24h ?? latestRuns.filter(item => item.status === 'failed').length;
    const runningCount = stats.runningCount ?? latestRuns.filter(item => item.status === 'running').length;
    const pendingArchives = overview.pendingArchives ?? overview.pendingArchiveCount ?? stats.pendingArchives ?? '—';
    const successRate = totalRuns24h > 0 ? `${Math.round((successCount24h / totalRuns24h) * 100)}%` : '—';
    const cards = [
        { title: '最近 24h 任务数', value: totalRuns24h ?? '—', desc: `${successCount24h || 0} 成功 / ${failedCount24h || 0} 失败` },
        { title: '成功率', value: successRate, desc: runningCount > 0 ? `${runningCount} 个任务执行中` : '当前无运行中的任务' },
        { title: '待归档断线会话', value: pendingArchives, desc: `保留窗口 ${config.resumeWindowMinutes} 分钟` },
        { title: '碎片扫描窗口', value: `${config.consolidationLookbackHours}h`, desc: `每 ${config.consolidationIntervalMinutes} 分钟扫描一次` },
    ];

    if (statsWrap) {
        statsWrap.innerHTML = cards.map(card => `
            <div class="rounded-[1.4rem] border border-base-300 bg-base-100 px-5 py-5 shadow-sm">
                <div class="text-sm text-base-content/60">${escapeHtml(String(card.title))}</div>
                <div class="text-3xl font-bold mt-3">${escapeHtml(String(card.value))}</div>
                <div class="text-xs text-base-content/55 mt-2 leading-6">${escapeHtml(String(card.desc))}</div>
            </div>
        `).join('');
    }

    if (overviewPanel) {
        if (!latestRuns.length) {
            overviewPanel.innerHTML = '<div class="rounded-box bg-base-200/80 px-4 py-4 text-sm text-base-content/60">最近还没有可展示的任务记录。</div>';
        } else {
            overviewPanel.innerHTML = latestRuns.slice(0, 5).map(item => {
                const taskLabel = formatSessionMaintenanceTaskLabel(item.taskKey || item.task || item.action);
                const summaryText = item.message || summarizeSessionMaintenanceObject(item.summary || item.result || item.payload || null) || '暂无摘要';
                return `
                    <div class="rounded-2xl border border-base-300 bg-base-200/60 px-4 py-4">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div class="font-medium">${escapeHtml(taskLabel)}</div>
                            <div class="flex items-center gap-2">
                                ${formatSessionMaintenanceStatusBadge(item.status)}
                                <span class="text-xs text-base-content/50">${escapeHtml(formatSessionMaintenanceDateTime(item.finishedAt || item.updatedAt || item.startedAt))}</span>
                            </div>
                        </div>
                        <div class="text-sm text-base-content/70 mt-2 leading-7">${escapeHtml(summaryText)}</div>
                        <div class="text-xs text-base-content/50 mt-2">来源：${escapeHtml(String(item.triggerSource || item.trigger || '未知'))}${item.durationMs != null ? ` · 耗时 ${escapeHtml(formatSessionMaintenanceDuration(item.durationMs))}` : ''}</div>
                    </div>
                `;
            }).join('');
        }
    }

    if (schedulerPanel) {
        const schedulerItems = [
            {
                title: '启动任务',
                value: `${config.startupCleanupEnabled ? '清理' : '跳过'} / ${config.startupConsolidationEnabled ? '扫描' : '跳过'}`,
                desc: '控制服务启动后是否先执行一轮补偿任务。'
            },
            {
                title: '陈旧 LIVE 清理',
                value: config.staleCleanupIntervalMinutes > 0 ? `每 ${config.staleCleanupIntervalMinutes} 分钟` : '已暂停',
                desc: `大间隔 ${config.staleGapThresholdMinutes} 分钟 · 老事件 ${config.staleSplitAgeMinutes} 分钟`
            },
            {
                title: '碎片场次扫描',
                value: config.consolidationIntervalMinutes > 0 ? `每 ${config.consolidationIntervalMinutes} 分钟` : '已暂停',
                desc: `最近 ${config.consolidationLookbackHours} 小时 · 自动阈值 ${config.consolidationGapMinutes} 分钟`
            },
            {
                title: '手动合并阈值',
                value: `${config.manualMergeGapMinutes} 分钟`,
                desc: `日志保留 ${config.logRetentionDays} 天 · 自动归档延迟 ${config.archiveDelayMinutes} 分钟`
            },
        ];
        schedulerPanel.innerHTML = schedulerItems.map(item => `
            <div class="rounded-2xl border border-base-300 bg-base-200/60 px-4 py-4">
                <div class="text-sm text-base-content/60">${escapeHtml(item.title)}</div>
                <div class="text-lg font-semibold mt-2">${escapeHtml(item.value)}</div>
                <div class="text-xs text-base-content/55 mt-2 leading-6">${escapeHtml(item.desc)}</div>
            </div>
        `).join('');
    }

    renderSessionMaintenanceHeroMeta();
}

function renderSessionMaintenanceLogs(logs) {
    const wrap = document.getElementById('session-maintenance-logs-wrap');
    if (!wrap) return;
    if (!logs || logs.length === 0) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200/80 px-4 py-5 text-sm text-base-content/60">暂无符合筛选条件的运行日志。</div>';
        return;
    }
    wrap.innerHTML = `
        <table class="table table-sm md:table-md">
            <thead>
                <tr>
                    <th>时间</th>
                    <th>任务</th>
                    <th>来源</th>
                    <th>房间</th>
                    <th>状态</th>
                    <th>摘要</th>
                </tr>
            </thead>
            <tbody>
                ${logs.map(item => {
        const summaryText = item.message || summarizeSessionMaintenanceObject(item.summary || item.result || item.payload || null) || (item.errorMessage ? `失败：${item.errorMessage}` : '暂无摘要');
        return `
                        <tr>
                            <td class="text-xs align-top whitespace-nowrap">
                                <div>${escapeHtml(formatSessionMaintenanceDateTime(item.startedAt || item.createdAt))}</div>
                                <div class="text-base-content/45 mt-1">${escapeHtml(formatSessionMaintenanceDuration(item.durationMs, '—'))}</div>
                            </td>
                            <td class="align-top min-w-[10rem]">
                                <div class="font-medium">${escapeHtml(formatSessionMaintenanceTaskLabel(item.taskKey || item.task || item.action))}</div>
                                <div class="text-xs text-base-content/50 mt-1">ID ${escapeHtml(String(item.id ?? '-'))}</div>
                            </td>
                            <td class="text-xs align-top min-w-[7rem]">${escapeHtml(String(item.triggerSource || item.trigger || '未知'))}</td>
                            <td class="text-xs align-top min-w-[7rem]">${escapeHtml(String(item.roomId || item.room_id || '—'))}</td>
                            <td class="align-top">${formatSessionMaintenanceStatusBadge(item.status)}</td>
                            <td class="text-xs align-top min-w-[18rem] leading-6">${escapeHtml(summaryText)}</td>
                        </tr>
                    `;
    }).join('')}
            </tbody>
        </table>
    `;
}

async function loadSessionMaintenanceOverview() {
    const overviewPanel = document.getElementById('session-maintenance-overview-panel');
    if (overviewPanel && !sessionMaintenanceOverviewCache) {
        overviewPanel.innerHTML = '<div class="rounded-box bg-base-200/80 px-4 py-4 text-sm text-base-content/60">正在同步运行状态...</div>';
    }
    try {
        const res = await Auth.apiFetch('/api/admin/session-maintenance/overview');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '获取场次运维概览失败');
        sessionMaintenanceOverviewCache = data.overview || data;
        renderSessionMaintenanceOverview();
    } catch (err) {
        console.error('Load session maintenance overview error:', err);
        if (overviewPanel) {
            overviewPanel.innerHTML = `<div class="rounded-box border border-error/30 bg-error/10 px-4 py-4 text-sm text-error">${escapeHtml(err.message || '获取概览失败')}</div>`;
        }
    }
}

async function loadSessionMaintenanceConfig() {
    const form = document.getElementById('session-maintenance-config-form');
    if (form && !sessionMaintenanceConfigCache) {
        form.innerHTML = '<div class="rounded-box bg-base-200/80 px-4 py-4 text-sm text-base-content/60">正在读取配置...</div>';
    }
    try {
        const res = await Auth.apiFetch('/api/admin/session-maintenance/config');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '获取场次运维配置失败');
        sessionMaintenanceConfigCache = normalizeSessionMaintenanceConfig(data.config || data.settings || data);
        renderSessionMaintenanceConfigForm();
        renderSessionMaintenanceOverview();
    } catch (err) {
        console.error('Load session maintenance config error:', err);
        if (form) {
            form.innerHTML = `<div class="rounded-box border border-error/30 bg-error/10 px-4 py-4 text-sm text-error">${escapeHtml(err.message || '获取配置失败')}</div>`;
        }
    }
}

async function saveSessionMaintenanceConfig() {
    const payload = {};
    document.querySelectorAll('[data-session-maintenance-key]').forEach(element => {
        const key = element.dataset.sessionMaintenanceKey;
        payload[key] = element.type === 'checkbox' ? element.checked : element.value;
    });

    const res = await Auth.apiFetch('/api/admin/session-maintenance/config', {
        method: 'PUT',
        body: JSON.stringify({ config: payload })
    });
    const data = await res.json();
    if (!res.ok) {
        setSessionMaintenanceActionResult(data.error || '保存场次运维配置失败', 'error');
        return;
    }

    sessionMaintenanceConfigCache = normalizeSessionMaintenanceConfig(payload);
    renderSessionMaintenanceOverview();
    setSessionMaintenanceActionResult(data.message || '场次运维配置已保存并等待下一轮任务生效。', 'success');
    await Promise.allSettled([loadSessionMaintenanceOverview(), loadSessionMaintenanceLogs()]);
}

async function loadSessionMaintenanceLogs() {
    const wrap = document.getElementById('session-maintenance-logs-wrap');
    if (wrap && sessionMaintenanceLogsCache.length === 0) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200/80 px-4 py-5 text-sm text-base-content/60">正在加载日志...</div>';
    }
    try {
        const limit = document.getElementById('session-maintenance-log-limit')?.value || '30';
        const taskKey = document.getElementById('session-maintenance-log-task')?.value || '';
        const status = document.getElementById('session-maintenance-log-status')?.value || '';
        const params = new URLSearchParams({ limit, taskKey, status });
        const res = await Auth.apiFetch(`/api/admin/session-maintenance/logs?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '获取场次运维日志失败');
        sessionMaintenanceLogsCache = data.logs || data.items || data.runs || [];
        renderSessionMaintenanceLogs(sessionMaintenanceLogsCache);
    } catch (err) {
        console.error('Load session maintenance logs error:', err);
        if (wrap) {
            wrap.innerHTML = `<div class="rounded-box border border-error/30 bg-error/10 px-4 py-5 text-sm text-error">${escapeHtml(err.message || '获取日志失败')}</div>`;
        }
    }
}

async function runSessionMaintenanceAction(action) {
    const label = formatSessionMaintenanceTaskLabel(action);
    const body = {};
    if (action === 'archive-room-stale') {
        const roomId = document.getElementById('session-maintenance-room-id')?.value?.trim();
        if (!roomId) {
            setSessionMaintenanceActionResult('请先填写要处理的 room_id。', 'warning');
            return;
        }
        body.roomId = roomId;
    }

    setSessionMaintenanceActionResult(`正在执行：${label}...`, 'info');
    try {
        const res = await Auth.apiFetch(`/api/admin/session-maintenance/actions/${action}`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `${label} 执行失败`);
        const resultText = data.message || summarizeSessionMaintenanceObject(data.result || data.summary || data) || `${label} 已执行`;
        setSessionMaintenanceActionResult(resultText, 'success');
        await Promise.allSettled([loadSessionMaintenanceOverview(), loadSessionMaintenanceLogs()]);
    } catch (err) {
        console.error('Run session maintenance action error:', err);
        setSessionMaintenanceActionResult(err.message || `${label} 执行失败`, 'error');
    }
}

async function loadSessionMaintenanceSection() {
    renderSessionMaintenanceHeroMeta();
    await Promise.allSettled([
        loadSessionMaintenanceOverview(),
        loadSessionMaintenanceConfig(),
        loadSessionMaintenanceLogs(),
    ]);
}

// ==================== SMTP Services ====================
const smtpServiceFieldDefs = [
    { key: 'name', label: '服务名称', type: 'text', placeholder: '主邮箱服务 / QQ 邮箱', hint: '后台识别该 SMTP 服务的备注名称。', tooltip: '仅用于后台识别和运维，不会直接暴露给普通用户。建议填写便于区分的名称，例如“腾讯企业邮主节点”或“QQ 邮箱备用”。' },
    { key: 'host', label: 'SMTP 服务器', type: 'text', placeholder: 'smtp.qq.com', hint: 'SMTP 服务商提供的主机地址。', tooltip: '填写邮件服务商提供的 SMTP Host，例如 smtp.qq.com、smtp.exmail.qq.com 或 smtp.gmail.com。系统会据此建立发送连接。' },
    { key: 'port', label: 'SMTP 端口', type: 'number', placeholder: '465', hint: 'SMTP 连接端口。', tooltip: '常见 SSL/TLS 端口为 465，STARTTLS 常用 587。端口需要与“SSL/TLS”开关和服务商要求匹配，否则测试连接会失败。' },
    { key: 'secure', label: 'SSL/TLS', type: 'toggle', hint: '决定是否使用加密连接直连 SMTP。', tooltip: '开启时通常表示使用 SMTPS/SSL 直连模式（常配合 465 端口）；关闭时通常走普通连接或 STARTTLS 升级模式，具体以服务商要求为准。' },
    { key: 'username', label: 'SMTP 用户名', type: 'text', placeholder: 'your@email.com', hint: 'SMTP 登录账号。', tooltip: '一般填写完整邮箱地址，也有少数服务商要求填写单独的账号名。该值用于 SMTP 登录认证，不一定等于最终发件人显示名称。' },
    { key: 'password', label: 'SMTP 密码/授权码', type: 'password', placeholder: '授权码', hint: 'SMTP 登录密码或服务商签发的授权码。', tooltip: '很多邮箱服务不允许直接使用登录密码，而是要求单独生成 SMTP 授权码。请优先按服务商文档填写授权码。' },
    { key: 'fromEmail', label: '发件人地址', type: 'text', placeholder: '留空则使用 SMTP 用户名', hint: '邮件头中显示的发件邮箱地址。', tooltip: '留空时默认使用 SMTP 用户名。若服务商允许代发或自定义发件地址，可在这里单独指定，但必须满足服务商的发信校验规则。' },
    { key: 'fromName', label: '发件人名称', type: 'text', placeholder: 'TikTok Monitor', hint: '用户在邮箱中看到的发件人名称。', tooltip: '这是收件箱里展示的“发件人昵称”，例如“TikTok Monitor”或“系统通知中心”。不影响 SMTP 登录，只影响收件人看到的展示文案。' },
    { key: 'isActive', label: '启用该邮箱服务', type: 'toggle', hint: '控制该 SMTP 节点是否参与发送与故障切换。', tooltip: '关闭后该服务会保留在后台，但不会参与正常发送、默认选择或故障切换；适合临时下线异常节点。' },
    { key: 'setAsDefault', label: '保存后设为默认', type: 'toggle', createOnly: true, hint: '新增时可直接把该节点设为默认发信服务。', tooltip: '开启后，新增完成即把当前服务设为默认 SMTP 节点。默认服务会优先承担注册验证、找回密码等邮件发送任务。' },
];

function formatSmtpStatusBadge(service) {
    if (!service?.isActive) return '<span class="badge badge-error badge-sm">已禁用</span>';
    if (service.isCooling) return '<span class="badge badge-warning badge-sm">冷却中</span>';
    if (service.lastStatus === 'ok') return '<span class="badge badge-success badge-sm">可用</span>';
    if (service.lastStatus === 'error') return '<span class="badge badge-error badge-sm">异常</span>';
    return '<span class="badge badge-ghost badge-sm">未检测</span>';
}

function getSmtpServiceById(id) {
    return smtpServicesCache.find(item => Number(item.id) === Number(id)) || null;
}

function renderSmtpServiceOverview() {
    const wrap = document.getElementById('smtp-services-overview');
    if (!wrap) return;

    const totalCount = smtpServicesCache.length;
    const activeCount = smtpServicesCache.filter(item => item.isActive).length;
    const availableCount = smtpServicesCache.filter(item => item.isActive && !item.isCooling).length;

    wrap.innerHTML = [
        { title: '服务总数', value: totalCount, desc: `${activeCount} 个启用中` },
        { title: '当前可切换', value: availableCount, desc: smtpFallbackPolicy ? `冷却时长 ${Math.round((smtpFallbackPolicy.cooldownMs || 0) / 1000)} 秒` : '自动故障切换' },
        { title: '邮箱验证', value: smtpEmailSettings.emailVerificationEnabled ? '开启' : '关闭', desc: smtpEmailSettings.emailVerificationEnabled ? '注册流程需要邮箱验证码' : '注册流程不强制邮箱验证码' },
    ].map(item => `
        <div class="rounded-box border border-base-300 bg-base-200/60 px-4 py-4">
            <div class="text-sm text-base-content/60">${escapeHtml(item.title)}</div>
            <div class="text-2xl font-bold mt-1">${escapeHtml(item.value)}</div>
            <div class="text-xs text-base-content/50 mt-2">${escapeHtml(item.desc)}</div>
        </div>
    `).join('');
}

function renderSmtpPolicySummary() {
    const summaryEl = document.getElementById('smtp-policy-summary');
    const formEl = document.getElementById('smtp-email-settings-form');
    if (!summaryEl || !formEl) return;

    const defaultService = smtpServicesCache.find(item => item.isDefault);
    const activeServices = smtpServicesCache.filter(item => item.isActive);

    summaryEl.innerHTML = `
        <div class="rounded-box bg-base-200/70 px-4 py-3 leading-7">
            <div><span class="font-semibold">默认服务：</span>${escapeHtml(defaultService?.name || '未设置')}</div>
            <div><span class="font-semibold">启用服务：</span>${activeServices.length} 个</div>
            <div><span class="font-semibold">切换策略：</span>默认优先，失败后自动跳过异常/冷却节点</div>
        </div>
    `;

    const emailVerificationHint = '关闭后，注册流程不再要求邮箱验证码；邮件服务仍可用于找回密码和改绑邮箱。';
    const emailVerificationTooltip = '开启后，新用户注册需要先完成邮箱验证码校验，适合提高注册账号质量；关闭后，注册流程不再强制邮箱验证，但找回密码、改绑邮箱等能力仍可继续使用邮件服务。';

    formEl.innerHTML = `
        <div class="form-control">
            <label class="label cursor-pointer justify-start gap-4">
                <span class="label-text w-44">${renderAdminSettingLabel('注册邮箱验证', emailVerificationTooltip, 'label-text font-medium')}</span>
                <input type="checkbox" id="smtp-email-verification-enabled" class="toggle toggle-primary" ${smtpEmailSettings.emailVerificationEnabled ? 'checked' : ''}>
            </label>
            ${renderAdminSettingDescription(emailVerificationHint, emailVerificationTooltip)}
        </div>
    `;
}

function renderSmtpServicesList() {
    const wrap = document.getElementById('smtp-services-list');
    if (!wrap) return;

    if (!smtpServicesCache.length) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">还没有邮箱服务，先在右侧新增一个 SMTP 服务。</div>';
        return;
    }

    wrap.innerHTML = smtpServicesCache.map(service => {
        const usedAt = service.lastUsedAt ? new Date(service.lastUsedAt).toLocaleString('zh-CN') : '从未发送';
        const cooldownText = service.isCooling && service.cooldownRemainingSeconds
            ? ` · 冷却剩余 ${service.cooldownRemainingSeconds} 秒`
            : '';

        return `
            <div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                            <h4 class="text-lg font-bold">${escapeHtml(service.name)}</h4>
                            ${service.isDefault ? '<span class="badge badge-primary badge-sm">默认</span>' : ''}
                            ${formatSmtpStatusBadge(service)}
                        </div>
                        <div class="text-sm text-base-content/65 mt-2 leading-7">
                            <div><span class="font-semibold text-base-content/75">连接：</span>${escapeHtml(service.host)}:${escapeHtml(service.port)}</div>
                            <div><span class="font-semibold text-base-content/75">账号：</span>${escapeHtml(service.username)}</div>
                            <div><span class="font-semibold text-base-content/75">发件：</span>${escapeHtml(service.fromName || 'TikTok Monitor')} &lt;${escapeHtml(service.fromEmail || service.username)}&gt;</div>
                        </div>
                        <div class="flex flex-wrap gap-4 mt-3 text-xs text-base-content/55">
                            <span>调用 ${service.callCount || 0}</span>
                            <span>成功 ${service.successCount || 0}</span>
                            <span>失败 ${service.failCount || 0}</span>
                            <span>平均延迟 ${service.avgLatencyMs || 0}ms</span>
                            <span>最后发送 ${escapeHtml(usedAt)}</span>
                        </div>
                        ${service.lastError ? `<div class="text-xs text-error mt-2 break-all">最近错误：${escapeHtml(service.lastError)}${escapeHtml(cooldownText)}</div>` : ''}
                    </div>
                    <div class="flex flex-wrap gap-2 justify-end">
                        <button class="btn btn-xs btn-ghost" onclick="editSmtpService(${service.id})">编辑</button>
                        ${service.isDefault ? '' : '<button class="btn btn-xs btn-primary btn-outline" onclick="setDefaultSmtpService(' + service.id + ')">设为默认</button>'}
                        <button class="btn btn-xs btn-info btn-outline" onclick="testSmtpServiceConnection(${service.id})">测试连接</button>
                        <button class="btn btn-xs btn-secondary btn-outline" onclick="testSmtpServiceSend(${service.id})">测试发信</button>
                        <button class="btn btn-xs ${service.isActive ? 'btn-warning' : 'btn-success'} btn-outline" onclick="toggleSmtpServiceActive(${service.id}, ${service.isActive ? 'false' : 'true'})">${service.isActive ? '禁用' : '启用'}</button>
                        <button class="btn btn-xs btn-error btn-outline" onclick="deleteSmtpService(${service.id})">删除</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderSmtpServiceEditor() {
    const wrap = document.getElementById('smtp-service-editor');
    const titleEl = document.getElementById('smtp-editor-title');
    const resultEl = document.getElementById('smtp-editor-result');
    if (!wrap || !titleEl || !resultEl) return;

    const editingService = smtpServiceEditorId ? getSmtpServiceById(smtpServiceEditorId) : null;
    const values = editingService || {
        port: 465,
        secure: true,
        fromName: 'TikTok Monitor',
        isActive: true,
        setAsDefault: smtpServicesCache.length === 0,
    };

    titleEl.textContent = editingService ? `编辑邮箱服务 · ${editingService.name}` : '新增邮箱服务';
    resultEl.className = 'mt-3 text-sm text-base-content/60';
    resultEl.textContent = editingService
        ? '保存后会立即更新该服务配置。'
        : '新增后可立即参与自动故障切换。';

    wrap.innerHTML = smtpServiceFieldDefs
        .filter(field => !field.createOnly || !editingService)
        .map(field => {
            const value = values[field.key] ?? '';
            if (field.type === 'toggle') {
                const checked = value === true || value === 'true' || value === 1;
                return `
                    <div class="form-control">
                        <label class="label cursor-pointer justify-start gap-4 rounded-box border border-base-300 px-4 py-3">
                            <span class="label-text flex-1">${renderAdminSettingLabel(field.label, field.tooltip || field.hint || '', 'label-text font-medium')}</span>
                            <input type="checkbox" class="toggle toggle-primary" data-key="${escapeHtml(field.key)}" ${checked ? 'checked' : ''}>
                        </label>
                        ${renderAdminSettingDescription(field.hint || '', field.tooltip || field.hint || '')}
                    </div>
                `;
            }

            return `
                <div class="form-control">
                    <label class="label"><span class="label-text">${renderAdminSettingLabel(field.label, field.tooltip || field.hint || '', 'label-text font-medium')}</span></label>
                    <input
                        type="${field.type === 'password' ? 'password' : (field.type === 'number' ? 'number' : 'text')}"
                        class="input input-bordered"
                        data-key="${escapeHtml(field.key)}"
                        value="${escapeHtml(value)}"
                        placeholder="${escapeHtml(field.placeholder || '')}"
                    >
                    <label class="label pt-2">
                        <span class="label-text-alt text-base-content/55">${escapeHtml(field.hint || '')}</span>
                    </label>
                </div>
            `;
        }).join('');
}

function redrawSmtpSection() {
    renderSmtpServiceOverview();
    renderSmtpPolicySummary();
    renderSmtpServicesList();
    renderSmtpServiceEditor();
}

async function loadSmtpServices() {
    const listEl = document.getElementById('smtp-services-list');
    if (listEl) {
        listEl.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">正在加载邮箱服务...</div>';
    }

    try {
        const res = await Auth.apiFetch('/api/admin/smtp/services');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载邮箱服务失败');

        smtpServicesCache = Array.isArray(data.services) ? data.services : [];
        smtpFallbackPolicy = data.fallbackPolicy || null;
        smtpEmailSettings = data.emailSettings || { emailVerificationEnabled: false };

        if (smtpServiceEditorId && !getSmtpServiceById(smtpServiceEditorId)) {
            smtpServiceEditorId = null;
        }

        redrawSmtpSection();
    } catch (err) {
        console.error('Load SMTP services error:', err);
        if (listEl) {
            listEl.innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-5 py-8 text-sm text-error">${escapeHtml(err.message || '加载邮箱服务失败')}</div>`;
        }
    }
}

function editSmtpService(id = null) {
    smtpServiceEditorId = id ? Number(id) : null;
    renderSmtpServiceEditor();
    document.getElementById('smtp-service-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetSmtpServiceEditor() {
    smtpServiceEditorId = null;
    renderSmtpServiceEditor();
}

function collectSmtpServiceFormData() {
    const payload = {};
    document.querySelectorAll('#smtp-service-editor [data-key]').forEach(el => {
        const key = el.dataset.key;
        payload[key] = el.type === 'checkbox' ? el.checked : el.value.trim();
    });
    return payload;
}

async function submitSmtpServiceForm() {
    const payload = collectSmtpServiceFormData();
    const resultEl = document.getElementById('smtp-editor-result');
    if (resultEl) resultEl.textContent = '正在保存...';

    try {
        const editing = smtpServiceEditorId ? getSmtpServiceById(smtpServiceEditorId) : null;
        const url = editing ? `/api/admin/smtp/services/${editing.id}` : '/api/admin/smtp/services';
        const method = editing ? 'PUT' : 'POST';
        const res = await Auth.apiFetch(url, {
            method,
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '保存邮箱服务失败');

        if (resultEl) {
            resultEl.className = 'mt-3 text-sm text-success';
            resultEl.textContent = data.message || '保存成功';
        }

        smtpServiceEditorId = null;
        await loadSmtpServices();
    } catch (err) {
        if (resultEl) {
            resultEl.className = 'mt-3 text-sm text-error';
            resultEl.textContent = err.message || '保存邮箱服务失败';
        }
    }
}

async function saveSmtpEmailSettings() {
    const enabled = !!document.getElementById('smtp-email-verification-enabled')?.checked;
    const res = await Auth.apiFetch('/api/admin/smtp/settings', {
        method: 'PUT',
        body: JSON.stringify({ emailVerificationEnabled: enabled })
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || '保存邮件策略失败');
        return;
    }

    smtpEmailSettings.emailVerificationEnabled = enabled;
    renderSmtpServiceOverview();
    alert(data.message || '邮件策略已保存');
}

async function setDefaultSmtpService(id) {
    const res = await Auth.apiFetch(`/api/admin/smtp/services/${id}/set-default`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || '设置默认邮箱服务失败');
        return;
    }
    await loadSmtpServices();
}

async function toggleSmtpServiceActive(id, nextActive) {
    const res = await Auth.apiFetch(`/api/admin/smtp/services/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: nextActive === true || nextActive === 'true' })
    });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || '更新邮箱服务状态失败');
        return;
    }
    await loadSmtpServices();
}

async function testSmtpServiceConnection(id) {
    const service = getSmtpServiceById(id);
    if (!service) return;

    const res = await Auth.apiFetch(`/api/admin/smtp/services/${id}/test`, { method: 'POST' });
    const data = await res.json();
    alert(data.success ? `「${service.name}」连接成功` : `连接失败：${data.error || '未知错误'}`);
    await loadSmtpServices();
}

async function testSmtpServiceSend(id) {
    const service = getSmtpServiceById(id);
    if (!service) return;

    const email = prompt(`请输入用于测试「${service.name}」的收件邮箱地址：`);
    if (!email) return;

    const res = await Auth.apiFetch(`/api/admin/smtp/services/${id}/test-send`, {
        method: 'POST',
        body: JSON.stringify({ email })
    });
    const data = await res.json();
    alert(data.success ? '测试邮件已发送' : `发送失败：${data.error || '未知错误'}`);
    await loadSmtpServices();
}

async function deleteSmtpService(id) {
    const service = getSmtpServiceById(id);
    if (!service) return;
    if (!confirm(`确定删除邮箱服务「${service.name}」吗？`)) return;

    const res = await Auth.apiFetch(`/api/admin/smtp/services/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || '删除邮箱服务失败');
        return;
    }

    if (smtpServiceEditorId === Number(id)) smtpServiceEditorId = null;
    await loadSmtpServices();
}

function formatAdminAiWorkStatusBadge(status) {
    const raw = String(status || 'queued');
    if (raw === 'processing') return '<span class="badge badge-primary badge-sm">处理中</span>';
    if (raw === 'completed') return '<span class="badge badge-success badge-sm">已完成</span>';
    if (raw === 'failed') return '<span class="badge badge-error badge-sm">失败</span>';
    return '<span class="badge badge-warning badge-sm">排队中</span>';
}

function formatAdminAiWorkTypeBadge(jobType) {
    const raw = String(jobType || '').toLowerCase();
    if (raw === 'customer_analysis') return '<span class="badge badge-secondary badge-sm">用户</span>';
    if (raw === 'session_recap') return '<span class="badge badge-accent badge-sm">房间</span>';
    return '<span class="badge badge-ghost badge-sm">其他</span>';
}

function formatAdminAiWorkDateTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(String(value));
    return date.toLocaleString('zh-CN');
}

function initAdminAiWorkFilters() {
    const statusSelect = document.getElementById('admin-ai-work-status');
    const typeSelect = document.getElementById('admin-ai-work-job-type');
    const searchInput = document.getElementById('admin-ai-work-search');
    if (statusSelect && !statusSelect.dataset.bound) {
        statusSelect.addEventListener('change', () => loadAdminAiWorkJobs(1));
        statusSelect.dataset.bound = 'true';
    }
    if (typeSelect && !typeSelect.dataset.bound) {
        typeSelect.addEventListener('change', () => loadAdminAiWorkJobs(1));
        typeSelect.dataset.bound = 'true';
    }
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                loadAdminAiWorkJobs(1);
            }
        });
        searchInput.dataset.bound = 'true';
    }
}

async function loadAdminAiWorkJobs(page = 1) {
    aiWorkAdminPage = page;
    const tbody = document.getElementById('admin-ai-work-tbody');
    if (!tbody) return;

    const status = document.getElementById('admin-ai-work-status')?.value || '';
    const jobType = document.getElementById('admin-ai-work-job-type')?.value || '';
    const search = document.getElementById('admin-ai-work-search')?.value?.trim() || '';
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-base-content/60">正在加载 AI 工作任务...</td></tr>';

    try {
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (status) params.set('status', status);
        if (jobType) params.set('jobType', jobType);
        if (search) params.set('search', search);
        const res = await Auth.apiFetch(`/api/admin/ai-work/jobs?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载 AI 工作任务失败');

        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        if (!jobs.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-base-content/60">暂无 AI 工作任务</td></tr>';
        } else {
            tbody.innerHTML = jobs.map(job => {
                const subjectMain = job.jobType === 'customer_analysis'
                    ? (job.targetNickname || job.targetUserId || '-')
                    : (job.roomId || '-');
                const subjectSub = job.jobType === 'customer_analysis'
                    ? `${job.targetUserId || '-'}${job.roomId ? ' · 房间 ' + job.roomId : ''}`
                    : (job.sessionId || '-');
                return `
                <tr>
                    <td>${formatAdminAiWorkStatusBadge(job.status)}</td>
                    <td>${escapeHtml(job.nickname || job.username || '-')}</td>
                    <td>
                        <div class="flex flex-wrap items-center gap-2">
                            ${formatAdminAiWorkTypeBadge(job.jobType)}
                            <span class="font-semibold">${escapeHtml(subjectMain)}</span>
                        </div>
                        <div class="text-xs text-base-content/55 mt-1">${escapeHtml(subjectSub)}</div>
                    </td>
                    <td>
                        <div>${escapeHtml(job.currentStep || '-')}</div>
                        <div class="text-xs text-base-content/55 mt-1">进度 ${Number(job.progressPercent || 0)}%</div>
                    </td>
                    <td>${escapeHtml(job.modelName || '-')}</td>
                    <td class="text-xs">${formatAdminAiWorkDateTime(job.createdAt)}</td>
                    <td><button class="btn btn-xs btn-outline" onclick="loadAdminAiWorkJobDetail(${Number(job.id || 0)})">详情</button></td>
                </tr>
            `;
            }).join('');
        }

        renderPagination('admin-ai-work-pagination', data.pagination || { page: 1, limit: 20, total: 0 }, 'loadAdminAiWorkJobs');
        if (currentAdminAiWorkDetailId) {
            const exists = jobs.some(job => Number(job.id) === Number(currentAdminAiWorkDetailId));
            if (exists) loadAdminAiWorkJobDetail(currentAdminAiWorkDetailId);
        }
    } catch (err) {
        console.error('Load admin AI work jobs error:', err);
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-error">${escapeHtml(err.message || '加载失败')}</td></tr>`;
    }
}

async function loadAdminAiWorkJobDetail(jobId) {
    currentAdminAiWorkDetailId = Number(jobId || 0);
    const wrap = document.getElementById('admin-ai-work-detail');
    if (!wrap || !currentAdminAiWorkDetailId) return;
    wrap.innerHTML = '<div class="rounded-box bg-base-200 px-4 py-8 text-base-content/60">正在加载任务详情...</div>';

    try {
        const res = await Auth.apiFetch(`/api/admin/ai-work/jobs/${encodeURIComponent(currentAdminAiWorkDetailId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载任务详情失败');

        const job = data.job || {};
        const logs = Array.isArray(data.logs) ? data.logs : [];
        wrap.innerHTML = `
            <div class="space-y-3">
                <div class="flex flex-wrap items-center gap-2">
                    ${formatAdminAiWorkStatusBadge(job.status)}
                    <span class="badge badge-outline">任务 #${Number(job.id || 0)}</span>
                    <span class="badge badge-ghost">用户 ${escapeHtml(job.nickname || job.username || '-')}</span>
                    ${formatAdminAiWorkTypeBadge(job.jobType)}
                    <span class="badge badge-ghost">通知 ${job.notificationSent ? '已发送' : '未发送'}</span>
                </div>
                <div class="rounded-box bg-base-200/70 p-4 text-sm leading-7">
                    <div><span class="font-semibold">标题：</span>${escapeHtml(job.title || '-')}</div>
                    <div><span class="font-semibold">分类：</span>${escapeHtml(job.jobTypeLabel || '-')}</div>
                    <div><span class="font-semibold">对象：</span>${escapeHtml(job.jobType === 'customer_analysis' ? (job.targetNickname || job.targetUserId || '-') : (job.roomId || '-'))}</div>
                    <div><span class="font-semibold">房间 / 场次：</span>${escapeHtml(job.roomId || '-')} / ${escapeHtml(job.sessionId || '-')}</div>
                    <div><span class="font-semibold">当前步骤：</span>${escapeHtml(job.currentStep || '-')} · ${Number(job.progressPercent || 0)}%</div>
                    <div><span class="font-semibold">创建：</span>${formatAdminAiWorkDateTime(job.createdAt)}</div>
                    <div><span class="font-semibold">开始：</span>${formatAdminAiWorkDateTime(job.startedAt)}</div>
                    <div><span class="font-semibold">完成：</span>${formatAdminAiWorkDateTime(job.finishedAt)}</div>
                    <div><span class="font-semibold">模型：</span>${escapeHtml(job.modelName || '-')}</div>
                    <div><span class="font-semibold">错误：</span>${escapeHtml(job.errorMessage || '-')}</div>
                </div>
                <div>
                    <div class="font-semibold mb-2">请求参数</div>
                    <pre class="rounded-box bg-base-200 p-4 text-xs overflow-x-auto">${escapeHtml(JSON.stringify(job.requestPayload || null, null, 2))}</pre>
                </div>
                <div>
                    <div class="font-semibold mb-2">结果数据</div>
                    <pre class="rounded-box bg-base-200 p-4 text-xs overflow-x-auto">${escapeHtml(JSON.stringify(job.resultPayload || null, null, 2))}</pre>
                </div>
                <div>
                    <div class="font-semibold mb-2">处理日志</div>
                    ${logs.length ? logs.map(log => `
                        <div class="rounded-box border border-base-300 bg-base-100 p-4 mb-3">
                            <div class="flex flex-wrap items-center gap-2 text-xs">
                                <span class="badge badge-outline">${escapeHtml(log.phase || 'log')}</span>
                                <span class="badge badge-ghost">${escapeHtml(log.level || 'info')}</span>
                                <span class="text-base-content/55">${formatAdminAiWorkDateTime(log.createdAt)}</span>
                            </div>
                            <div class="mt-3 font-medium leading-6">${escapeHtml(log.message || '')}</div>
                            ${log.payload ? `<pre class="rounded-box bg-base-200 p-3 text-xs overflow-x-auto mt-3">${escapeHtml(JSON.stringify(log.payload, null, 2))}</pre>` : ''}
                        </div>
                    `).join('') : '<div class="rounded-box bg-base-200 px-4 py-6 text-base-content/60">暂无日志。</div>'}
                </div>
            </div>
        `;
    } catch (err) {
        console.error('Load admin AI work job detail error:', err);
        wrap.innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-4 py-6 text-error">${escapeHtml(err.message || '加载详情失败')}</div>`;
    }
}

async function loadPromptTemplates(force = false) {
    const wrap = document.getElementById('prompt-templates-list');
    if (!wrap) return;
    if (force || !wrap.dataset.loaded) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">正在加载提示词...</div>';
    }

    try {
        const res = await Auth.apiFetch('/api/admin/prompt-templates');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载提示词失败');

        const templates = Array.isArray(data.templates) ? data.templates : [];
        if (!templates.length) {
            wrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">当前没有可用提示词。</div>';
            return;
        }

        wrap.dataset.loaded = 'true';
        wrap.innerHTML = templates.map(item => {
            const structuredSources = Array.isArray(item.structuredSources) ? item.structuredSources : [];
            return `
            <div class="rounded-box border border-base-300 bg-base-100 p-5 shadow-sm">
                <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
                    <div>
                        <div class="text-lg font-bold">${escapeHtml(item.title || item.key)}</div>
                        <div class="text-sm text-base-content/60 mt-1">${escapeHtml(item.description || '')}</div>
                    </div>
                    <div class="flex flex-wrap items-center gap-2 text-xs">
                        <span class="badge badge-outline">Key: ${escapeHtml(item.key)}</span>
                        <span class="badge ${item.isCustomized ? 'badge-primary' : 'badge-ghost'}">${item.isCustomized ? '已自定义' : '默认模板'}</span>
                        <span class="badge badge-ghost">${item.updatedAt ? `更新于 ${escapeHtml(new Date(item.updatedAt).toLocaleString('zh-CN'))}` : '使用内置默认值'}</span>
                    </div>
                </div>
                <div class="rounded-box border border-base-300 bg-base-200/60 px-4 py-3 text-xs leading-6 text-base-content/70 mb-3">
                    <div class="flex flex-wrap items-center justify-between gap-3 mb-2">
                        <div class="font-semibold text-base-content/80">可用变量 / 数据源</div>
                        <button class="btn btn-xs btn-outline" onclick="showSection('structuredSources')">打开结构化数据源</button>
                    </div>
                    <div class="space-y-2">
                        ${(Array.isArray(item.variableSourceMappings) ? item.variableSourceMappings : []).map(mapping => `
                            <div>
                                <code>${escapeHtml(`{{${mapping.variable}}}`)}</code>
                                ${mapping.isStructuredSource ? `
                                    <span class="text-base-content/80"> · ${escapeHtml(mapping.sourceTitle || mapping.sourceKey || '结构化数据源')}</span>
                                    ${mapping.sourceDescription ? `<span class="text-base-content/55"> · ${escapeHtml(mapping.sourceDescription)}</span>` : ''}
                                ` : `
                                    <span class="text-base-content/55"> · 普通模板变量</span>
                                `}
                            </div>
                        `).join('') || '<div>无</div>'}
                    </div>
                </div>
                ${item.key === 'customer_analysis_review' ? `
                    <div class="rounded-box border border-base-300 bg-base-200/80 px-4 py-3 text-xs leading-6 text-base-content/70 mb-3">
                        该模板用于「房间详情 / 历史排行榜 / AI客户分析」。系统已经提前计算好客户数值、时间、排行与模型标签；编辑时请让 AI 只负责输出直接结论、重点结论、下一步动作和主播话术，不要直出英文键名，也不要让 AI 自己重算事实。涉及贡献占比时，请明确写成“该客户近30天总贡献里投向本房/其他房间的占比”，避免歧义。
                    </div>
                ` : ''}
                <textarea id="prompt-template-${escapeHtml(item.key)}" class="textarea textarea-bordered w-full min-h-[22rem] font-mono text-xs leading-6">${escapeHtml(item.content || '')}</textarea>
                <div class="flex flex-wrap items-center gap-3 mt-4">
                    <button class="btn btn-primary btn-sm" onclick="savePromptTemplate('${escapeHtml(item.key)}')">保存提示词</button>
                    <button class="btn btn-outline btn-sm" onclick="resetPromptTemplate('${escapeHtml(item.key)}')">恢复默认</button>
                    <button class="btn btn-outline btn-sm" onclick="loadPromptPreviewPreset('${escapeHtml(item.key)}')">加载测试参数</button>
                    <button class="btn btn-outline btn-sm" onclick="previewPromptTemplate('${escapeHtml(item.key)}')">渲染预览</button>
                </div>
                <div class="rounded-box border border-base-300 bg-base-200/60 px-4 py-4 mt-4">
                    <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <div>
                            <div class="font-semibold text-sm">Prompt 渲染预览</div>
                            <div class="text-xs text-base-content/55 mt-1">可在保存前测试结构化数据注入、手动变量覆盖和最终渲染结果。</div>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                            <button id="prompt-preview-copy-${escapeHtml(item.key)}" class="btn btn-xs btn-outline btn-disabled" onclick="copyPromptPreviewResult('${escapeHtml(item.key)}')" disabled>复制结果</button>
                            <button id="prompt-preview-download-${escapeHtml(item.key)}" class="btn btn-xs btn-outline btn-disabled" onclick="downloadPromptPreviewResult('${escapeHtml(item.key)}')" disabled>下载TXT</button>
                            <div id="prompt-preview-meta-${escapeHtml(item.key)}" class="text-xs text-base-content/55">尚未渲染预览</div>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        <div class="space-y-2">
                            <div class="text-xs font-semibold text-base-content/70">结构化输入（JSON）</div>
                            <textarea id="prompt-preview-input-${escapeHtml(item.key)}" class="textarea textarea-bordered w-full min-h-[10rem] font-mono text-xs leading-6" spellcheck="false">{}</textarea>
                        </div>
                        <div class="space-y-2">
                            <div class="text-xs font-semibold text-base-content/70">手动变量覆盖（JSON）</div>
                            <textarea id="prompt-preview-vars-${escapeHtml(item.key)}" class="textarea textarea-bordered w-full min-h-[10rem] font-mono text-xs leading-6" spellcheck="false">{}</textarea>
                        </div>
                    </div>
                    <div id="prompt-preview-status-${escapeHtml(item.key)}" class="text-xs text-base-content/55 mt-3">未加载测试参数</div>
                    <div id="prompt-preview-token-notes-${escapeHtml(item.key)}" class="hidden rounded-box border border-base-300 bg-base-100/80 px-3 py-3 text-xs leading-6 text-base-content/70 mt-3"></div>
                    <div class="collapse collapse-arrow border border-base-300 bg-base-100/80 mt-3">
                        <input type="checkbox" />
                        <div class="collapse-title min-h-0 py-3 text-sm font-semibold">查看模板对比</div>
                        <div class="collapse-content pt-0">
                            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                <div class="space-y-2">
                                    <div class="text-xs font-semibold text-base-content/70">当前模板内容</div>
                                    <pre id="prompt-preview-raw-${escapeHtml(item.key)}" class="rounded-box border border-base-300 bg-base-200 px-4 py-4 text-xs leading-6 whitespace-pre-wrap break-all">尚未渲染预览</pre>
                                </div>
                                <div class="space-y-2">
                                    <div class="text-xs font-semibold text-base-content/70">系统补入后的有效模板</div>
                                    <pre id="prompt-preview-effective-${escapeHtml(item.key)}" class="rounded-box border border-base-300 bg-base-200 px-4 py-4 text-xs leading-6 whitespace-pre-wrap break-all">尚未渲染预览</pre>
                                </div>
                            </div>
                        </div>
                    </div>
                    <pre id="prompt-preview-result-${escapeHtml(item.key)}" class="rounded-box border border-base-300 bg-base-100 px-4 py-4 text-xs leading-6 whitespace-pre-wrap break-all mt-3">尚未渲染预览</pre>
                </div>
            </div>
        `;
        }).join('');
    } catch (err) {
        wrap.innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-5 py-8 text-sm text-error">${escapeHtml(err.message || '加载提示词失败')}</div>`;
    }
}

async function savePromptTemplate(key) {
    const input = document.getElementById(`prompt-template-${key}`);
    if (!input) return;

    const res = await Auth.apiFetch(`/api/admin/prompt-templates/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: input.value })
    });
    const data = await res.json();
    if (res.ok) {
        alert(data.message || '提示词已保存');
        await loadPromptTemplates(true);
        return;
    }
    alert(data.error || '保存提示词失败');
}

async function resetPromptTemplate(key) {
    if (!confirm('确定要恢复该提示词的默认内容吗？')) return;

    const res = await Auth.apiFetch(`/api/admin/prompt-templates/${encodeURIComponent(key)}/reset`, {
        method: 'POST'
    });
    const data = await res.json();
    if (res.ok) {
        alert(data.message || '已恢复默认提示词');
        await loadPromptTemplates(true);
        return;
    }
    alert(data.error || '恢复默认失败');
}

function getPromptPreviewElements(key) {
    return {
        templateEl: document.getElementById(`prompt-template-${key}`),
        inputEl: document.getElementById(`prompt-preview-input-${key}`),
        varsEl: document.getElementById(`prompt-preview-vars-${key}`),
        resultEl: document.getElementById(`prompt-preview-result-${key}`),
        rawEl: document.getElementById(`prompt-preview-raw-${key}`),
        effectiveEl: document.getElementById(`prompt-preview-effective-${key}`),
        metaEl: document.getElementById(`prompt-preview-meta-${key}`),
        statusEl: document.getElementById(`prompt-preview-status-${key}`),
        tokenNotesEl: document.getElementById(`prompt-preview-token-notes-${key}`),
        copyBtn: document.getElementById(`prompt-preview-copy-${key}`),
        downloadBtn: document.getElementById(`prompt-preview-download-${key}`)
    };
}

function setPromptPreviewActionState(key, { ready = false, copyLabel = '复制结果' } = {}) {
    const { copyBtn, downloadBtn } = getPromptPreviewElements(key);
    [copyBtn, downloadBtn].forEach((btn) => {
        if (!btn) return;
        btn.disabled = !ready;
        btn.classList.toggle('btn-disabled', !ready);
    });
    if (copyBtn) copyBtn.textContent = copyLabel;
}

function renderPromptPreviewTokenNotes(key, preview = {}) {
    const { tokenNotesEl } = getPromptPreviewElements(key);
    if (!tokenNotesEl) return;

    const autoAppendedTokens = Array.isArray(preview.autoAppendedTokens) ? preview.autoAppendedTokens : [];
    const unresolvedTokens = Array.isArray(preview.unresolvedTokens) ? preview.unresolvedTokens : [];
    const skippedSources = Array.isArray(preview.skippedSources) ? preview.skippedSources : [];

    const segments = [];
    if (autoAppendedTokens.length) {
        segments.push(`
            <div>
                <div class="font-semibold text-base-content/80 mb-1">系统自动补入</div>
                <div class="flex flex-wrap gap-2">
                    ${autoAppendedTokens.map(token => `<span class="badge badge-outline badge-sm">${escapeHtml(`{{${token}}}`)}</span>`).join('')}
                </div>
            </div>
        `);
    }
    if (unresolvedTokens.length) {
        segments.push(`
            <div>
                <div class="font-semibold text-warning mb-1">仍未替换的占位符</div>
                <div class="flex flex-wrap gap-2">
                    ${unresolvedTokens.map(token => `<span class="badge badge-warning badge-sm">${escapeHtml(`{{${token}}}`)}</span>`).join('')}
                </div>
            </div>
        `);
    }
    if (skippedSources.length) {
        segments.push(`
            <div>
                <div class="font-semibold text-base-content/80 mb-1">本次跳过的数据源</div>
                <div class="space-y-1">
                    ${skippedSources.map(item => `
                        <div>
                            <code>${escapeHtml(`{{${item.token}}}`)}</code>
                            <span> · ${escapeHtml(item.reason || '已跳过')}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `);
    }

    if (!segments.length) {
        tokenNotesEl.classList.add('hidden');
        tokenNotesEl.innerHTML = '';
        return;
    }

    tokenNotesEl.classList.remove('hidden');
    tokenNotesEl.innerHTML = segments.join('');
}

async function copyTextWithFallback(text) {
    const normalized = String(text || '');
    if (!normalized) return false;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(normalized);
            return true;
        }
    } catch {
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = normalized;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        return copied;
    } catch {
        return false;
    }
}

function downloadTextAsFile(text, filename) {
    const blob = new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildPromptPreviewFileName(key) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    return `Prompt预览_${String(key || 'template').trim() || 'template'}_${stamp}.txt`.replace(/[\/:*?"<>|\s]+/g, '_');
}

async function loadPromptPreviewPreset(key) {
    const { inputEl, varsEl, statusEl, metaEl, resultEl, rawEl, effectiveEl } = getPromptPreviewElements(key);
    if (!inputEl || !varsEl) return;

    if (statusEl) statusEl.textContent = '正在加载测试参数...';
    if (metaEl) metaEl.textContent = '正在加载';
    setPromptPreviewActionState(key, { ready: false });
    renderPromptPreviewTokenNotes(key, {});

    try {
        const res = await Auth.apiFetch(`/api/admin/prompt-templates/${encodeURIComponent(key)}/preview-preset`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载预览预设失败');

        inputEl.value = formatJsonBlock(data.preset?.input || {}, '{}');
        varsEl.value = formatJsonBlock(data.preset?.variables || {}, '{}');
        if (statusEl) statusEl.textContent = '测试参数已加载，可直接点“渲染预览”';
        if (metaEl) metaEl.textContent = '预设已加载';
        if (resultEl) resultEl.textContent = '尚未渲染预览';
        if (rawEl) rawEl.textContent = '尚未渲染预览';
        if (effectiveEl) effectiveEl.textContent = '尚未渲染预览';
    } catch (err) {
        if (statusEl) statusEl.textContent = `加载失败：${err.message || '预设加载失败'}`;
        if (metaEl) metaEl.textContent = '预设加载失败';
    }
}

async function previewPromptTemplate(key) {
    const { templateEl, inputEl, varsEl, resultEl, rawEl, effectiveEl, metaEl, statusEl } = getPromptPreviewElements(key);
    if (!templateEl || !inputEl || !varsEl || !resultEl || !metaEl) return;

    let input = {};
    let variables = {};

    try {
        input = JSON.parse(String(inputEl.value || '{}').trim() || '{}');
    } catch {
        alert('结构化输入必须是合法 JSON');
        return;
    }

    try {
        variables = JSON.parse(String(varsEl.value || '{}').trim() || '{}');
    } catch {
        alert('手动变量覆盖必须是合法 JSON');
        return;
    }

    if (statusEl) statusEl.textContent = '正在渲染预览...';
    resultEl.textContent = '正在渲染预览...';
    if (rawEl) rawEl.textContent = '正在渲染预览...';
    if (effectiveEl) effectiveEl.textContent = '正在渲染预览...';
    metaEl.textContent = '正在渲染';
    setPromptPreviewActionState(key, { ready: false });
    renderPromptPreviewTokenNotes(key, {});

    try {
        const res = await Auth.apiFetch(`/api/admin/prompt-templates/${encodeURIComponent(key)}/preview`, {
            method: 'POST',
            body: JSON.stringify({
                content: templateEl.value,
                input,
                variables
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '渲染预览失败');

        const preview = data.preview || {};
        const summaryParts = [];
        summaryParts.push(`长度 ${Number(preview.promptLength || 0)} 字`);
        if (Array.isArray(preview.autoAppendedTokens) && preview.autoAppendedTokens.length) {
            summaryParts.push(`自动补全 ${preview.autoAppendedTokens.map(item => `{{${item}}}`).join('、')}`);
        }
        if (Array.isArray(preview.unresolvedTokens) && preview.unresolvedTokens.length) {
            summaryParts.push(`未替换 ${preview.unresolvedTokens.map(item => `{{${item}}}`).join('、')}`);
        }
        if (statusEl) {
            const resolvedText = Array.isArray(preview.resolvedSources) && preview.resolvedSources.length
                ? `已注入：${preview.resolvedSources.map(item => `{{${item.token}}}`).join('、')}`
                : '本次没有注入结构化数据源';
            const skippedText = Array.isArray(preview.skippedSources) && preview.skippedSources.length
                ? `；跳过：${preview.skippedSources.map(item => `{{${item.token}}}（${item.reason}）`).join('、')}`
                : '';
            statusEl.textContent = `${resolvedText}${skippedText}`;
        }
        metaEl.textContent = summaryParts.join(' · ') || '渲染完成';
        if (rawEl) rawEl.textContent = String(preview.rawContent || '').trim() || '模板为空';
        if (effectiveEl) effectiveEl.textContent = String(preview.effectiveContent || '').trim() || '有效模板为空';
        resultEl.textContent = String(preview.renderedPrompt || '').trim() || '渲染结果为空';
        resultEl.dataset.renderedPrompt = String(preview.renderedPrompt || '').trim();
        setPromptPreviewActionState(key, { ready: Boolean(resultEl.dataset.renderedPrompt) });
        renderPromptPreviewTokenNotes(key, preview);
    } catch (err) {
        resultEl.textContent = `错误：${err.message || '渲染失败'}`;
        if (rawEl) rawEl.textContent = '渲染失败';
        if (effectiveEl) effectiveEl.textContent = '渲染失败';
        resultEl.dataset.renderedPrompt = '';
        metaEl.textContent = '渲染失败';
        if (statusEl) statusEl.textContent = '渲染失败';
        setPromptPreviewActionState(key, { ready: false });
        renderPromptPreviewTokenNotes(key, {});
    }
}

async function copyPromptPreviewResult(key) {
    const { resultEl } = getPromptPreviewElements(key);
    const promptText = String(resultEl?.dataset?.renderedPrompt || resultEl?.textContent || '').trim();
    if (!promptText || promptText === '尚未渲染预览') return;

    const copied = await copyTextWithFallback(promptText);
    setPromptPreviewActionState(key, {
        ready: true,
        copyLabel: copied ? '✓ 已复制' : '复制失败'
    });
    window.setTimeout(() => {
        setPromptPreviewActionState(key, { ready: true });
    }, 1200);
}

function downloadPromptPreviewResult(key) {
    const { resultEl } = getPromptPreviewElements(key);
    const promptText = String(resultEl?.dataset?.renderedPrompt || resultEl?.textContent || '').trim();
    if (!promptText || promptText === '尚未渲染预览') return;
    downloadTextAsFile(promptText, buildPromptPreviewFileName(key));
}

function getStructuredSourceByKey(key) {
    const normalizedKey = String(key || '').trim();
    return structuredSourcesCache.find(item => item.key === normalizedKey) || null;
}

function getStructuredSourceFieldConfigs(source) {
    const schema = source?.inputSchema || {};
    const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const rememberedValues = getStructuredSourceRememberedDefaults();

    return Object.entries(properties).map(([key, config]) => ({
        key,
        type: String(config?.type || 'string').trim() || 'string',
        label: String(config?.label || key).trim() || key,
        description: String(config?.description || '').trim(),
        required: requiredSet.has(key),
        defaultValue: rememberedValues[key] ?? source?.defaultTestInput?.[key] ?? ''
    }));
}

function getStructuredSourceMemoryStorageKey() {
    return 'admin.structured_sources.last_input';
}

function getStructuredSourceRememberedDefaults() {
    try {
        const raw = window.localStorage?.getItem(getStructuredSourceMemoryStorageKey()) || '';
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
    } catch {
        return {};
    }
}

function saveStructuredSourceRememberedDefaults(input = {}) {
    try {
        const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
        const normalized = {};
        ['roomId', 'sessionId'].forEach((key) => {
            const value = String(source[key] || '').trim();
            if (value) normalized[key] = value;
        });
        window.localStorage?.setItem(getStructuredSourceMemoryStorageKey(), JSON.stringify(normalized));
    } catch {
    }
}

function renderStructuredSourceForm(source) {
    const wrap = document.getElementById('structured-source-form-fields');
    const hintEl = document.getElementById('structured-source-form-hint');
    if (!wrap || !hintEl) return;

    if (!source) {
        wrap.innerHTML = '<div class="text-xs text-base-content/60">请选择数据源后填写参数。</div>';
        hintEl.textContent = '必填项会在这里直接展示，无需编辑左侧输入结构。';
        return;
    }

    const fields = getStructuredSourceFieldConfigs(source);
    if (!fields.length) {
        wrap.innerHTML = '<div class="text-xs text-base-content/60">该数据源当前无需额外输入参数。</div>';
        hintEl.textContent = '可直接点击“测试数据源”。';
        return;
    }

    wrap.innerHTML = fields.map(field => `
        <label class="form-control w-full">
            <div class="label pb-1">
                <span class="label-text text-sm font-medium">
                    ${escapeHtml(field.label)}
                    ${field.required ? '<span class="text-error ml-1">*</span>' : ''}
                </span>
            </div>
            <input
                id="structured-source-field-${escapeHtml(field.key)}"
                data-structured-source-field="true"
                data-field-key="${escapeHtml(field.key)}"
                data-field-type="${escapeHtml(field.type)}"
                class="input input-bordered w-full"
                type="text"
                value="${escapeHtml(field.defaultValue == null ? '' : String(field.defaultValue))}"
                placeholder="${escapeHtml(field.description || field.label)}"
                oninput="syncStructuredSourceFormToJson()"
            >
            ${field.description ? `<div class="label pt-1"><span class="label-text-alt text-base-content/55">${escapeHtml(field.description)}</span></div>` : ''}
        </label>
    `).join('');

    const requiredLabels = fields.filter(field => field.required).map(field => field.label);
    hintEl.textContent = requiredLabels.length
        ? `请先填写必填项：${requiredLabels.join('、')}。右侧 JSON 会自动同步。`
        : '可选参数可直接填写，右侧 JSON 会自动同步。';
}

function collectStructuredSourceFormInput() {
    const inputs = Array.from(document.querySelectorAll('[data-structured-source-field="true"]'));
    return inputs.reduce((acc, input) => {
        const key = String(input.dataset.fieldKey || '').trim();
        if (!key) return acc;
        const rawValue = String(input.value || '');
        acc[key] = rawValue;
        return acc;
    }, {});
}

function normalizeStructuredSourceInputValue(rawValue, type = 'string') {
    if (type === 'number' || type === 'integer') {
        const trimmed = String(rawValue || '').trim();
        if (!trimmed) return '';
        const numeric = Number(trimmed);
        return Number.isFinite(numeric) ? numeric : trimmed;
    }
    if (type === 'boolean') {
        const normalized = String(rawValue || '').trim().toLowerCase();
        if (!normalized) return '';
        if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    }
    return String(rawValue || '');
}

function syncStructuredSourceFormToJson() {
    const source = getStructuredSourceByKey(currentStructuredSourceKey);
    const inputEl = document.getElementById('structured-source-test-input');
    if (!source || !inputEl) return;

    const fields = getStructuredSourceFieldConfigs(source);
    const rawForm = collectStructuredSourceFormInput();
    const payload = {};

    fields.forEach(field => {
        const normalizedValue = normalizeStructuredSourceInputValue(rawForm[field.key], field.type);
        if (normalizedValue === '') return;
        payload[field.key] = normalizedValue;
    });

    inputEl.value = formatJsonBlock(payload, '{}');
    saveStructuredSourceRememberedDefaults(payload);
}

function validateStructuredSourceRequiredInput(source, parsedInput = {}) {
    const fields = getStructuredSourceFieldConfigs(source);
    const missingLabels = fields
        .filter(field => field.required)
        .filter(field => {
            const value = parsedInput?.[field.key];
            if (typeof value === 'string') return !value.trim();
            return value == null;
        })
        .map(field => field.label);

    return {
        valid: missingLabels.length === 0,
        missingLabels
    };
}

function renderStructuredSourceList() {
    const wrap = document.getElementById('structured-sources-list');
    if (!wrap) return;

    if (!structuredSourcesCache.length) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-4 py-6 text-sm text-base-content/60">当前没有可用结构化数据源。</div>';
        return;
    }

    wrap.innerHTML = structuredSourcesCache.map(item => {
        const isActive = item.key === currentStructuredSourceKey;
        return `
            <button class="w-full text-left rounded-box border px-4 py-4 transition ${isActive ? 'border-primary bg-primary/10 shadow-sm' : 'border-base-300 bg-base-100 hover:bg-base-200/70'}"
                onclick="selectStructuredSource('${escapeHtml(item.key)}')">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="font-semibold text-sm text-base-content/90">${escapeHtml(item.title || item.key)}</div>
                        <div class="text-xs text-base-content/55 mt-1">${escapeHtml(item.description || '')}</div>
                    </div>
                    <span class="badge badge-outline badge-sm">${escapeHtml(item.category || '未分类')}</span>
                </div>
                <div class="text-[11px] text-base-content/50 mt-3 flex flex-wrap gap-2">
                    <span>Token: <code>${escapeHtml(`{{${item.token}}}`)}</code></span>
                    <span>场景: ${escapeHtml(item.sceneLabel || item.scene || '-')}</span>
                </div>
            </button>
        `;
    }).join('');
}

function renderStructuredSourceDetail(source) {
    const emptyEl = document.getElementById('structured-source-empty');
    const detailEl = document.getElementById('structured-source-detail');
    const titleEl = document.getElementById('structured-source-title');
    const subtitleEl = document.getElementById('structured-source-subtitle');
    const badgesEl = document.getElementById('structured-source-badges');
    const descEl = document.getElementById('structured-source-description');
    const schemaEl = document.getElementById('structured-source-schema');
    const inputEl = document.getElementById('structured-source-test-input');
    const resultEl = document.getElementById('structured-source-test-result');
    const metaEl = document.getElementById('structured-source-test-meta');

    if (!source) {
        currentStructuredSourceKey = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (detailEl) detailEl.classList.add('hidden');
        if (titleEl) titleEl.textContent = '请选择左侧数据源';
        if (subtitleEl) subtitleEl.textContent = '支持查看 token、输入参数、场景说明与测试结果。';
        if (badgesEl) badgesEl.innerHTML = '';
        if (descEl) descEl.textContent = '';
        if (schemaEl) schemaEl.textContent = '暂无';
        if (inputEl) inputEl.value = '';
        renderStructuredSourceForm(null);
        if (resultEl) resultEl.textContent = '尚未执行测试';
        if (metaEl) metaEl.textContent = '尚未执行测试';
        return;
    }

    currentStructuredSourceKey = source.key;
    if (emptyEl) emptyEl.classList.add('hidden');
    if (detailEl) detailEl.classList.remove('hidden');
    if (titleEl) titleEl.textContent = source.title || source.key;
    if (subtitleEl) subtitleEl.textContent = `Token：{{${source.token}}} · 场景：${source.sceneLabel || source.scene || '-'}`;
    if (badgesEl) {
        badgesEl.innerHTML = `
            <span class="badge badge-outline">Key: ${escapeHtml(source.key || '-')}</span>
            <span class="badge badge-primary badge-outline">Token: ${escapeHtml(`{{${source.token}}}`)}</span>
            <span class="badge badge-ghost">${escapeHtml(source.category || '未分类')}</span>
        `;
    }
    if (descEl) descEl.textContent = source.description || '暂无说明';
    if (schemaEl) schemaEl.textContent = formatJsonBlock(source.inputSchema || {});
    renderStructuredSourceForm(source);
    if (inputEl) {
        const remembered = getStructuredSourceRememberedDefaults();
        inputEl.value = formatJsonBlock({
            ...(source.defaultTestInput || {}),
            ...remembered
        });
    }
    if (resultEl) resultEl.textContent = '尚未执行测试';
    if (metaEl) metaEl.textContent = '尚未执行测试';
}

function selectStructuredSource(key) {
    renderStructuredSourceDetail(getStructuredSourceByKey(key));
    renderStructuredSourceList();
}

async function loadStructuredSources(force = false) {
    const wrap = document.getElementById('structured-sources-list');
    if (!wrap) return;
    if (force || !wrap.dataset.loaded) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-4 py-6 text-sm text-base-content/60">正在加载结构化数据源...</div>';
    }

    try {
        const res = await Auth.apiFetch('/api/admin/structured-sources');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载结构化数据源失败');

        structuredSourcesCache = Array.isArray(data.sources) ? data.sources : [];
        wrap.dataset.loaded = 'true';
        const nextKey = getStructuredSourceByKey(currentStructuredSourceKey)?.key || structuredSourcesCache[0]?.key || '';
        renderStructuredSourceDetail(getStructuredSourceByKey(nextKey));
        renderStructuredSourceList();
    } catch (err) {
        wrap.innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-4 py-6 text-sm text-error">${escapeHtml(err.message || '加载结构化数据源失败')}</div>`;
        renderStructuredSourceDetail(null);
    }
}

async function testStructuredSource(explicitKey = '') {
    const source = getStructuredSourceByKey(explicitKey || currentStructuredSourceKey);
    if (!source) {
        alert('请先选择一个结构化数据源');
        return;
    }

    const inputEl = document.getElementById('structured-source-test-input');
    const resultEl = document.getElementById('structured-source-test-result');
    const metaEl = document.getElementById('structured-source-test-meta');
    if (!inputEl || !resultEl || !metaEl) return;

    let parsedInput = {};
    const rawInput = String(inputEl.value || '').trim();
    if (rawInput) {
        try {
            parsedInput = JSON.parse(rawInput);
        } catch {
            alert('测试参数必须是合法 JSON');
            return;
        }
    }

    const validation = validateStructuredSourceRequiredInput(source, parsedInput);
    if (!validation.valid) {
        alert(`请先填写必填参数：${validation.missingLabels.join('、')}`);
        return;
    }

    saveStructuredSourceRememberedDefaults(parsedInput);

    resultEl.textContent = '正在测试数据源...';
    metaEl.textContent = '正在执行测试';

    try {
        const res = await Auth.apiFetch(`/api/admin/structured-sources/${encodeURIComponent(source.key)}/test`, {
            method: 'POST',
            body: JSON.stringify({ input: parsedInput })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '测试结构化数据源失败');

        resultEl.textContent = formatJsonBlock(data.output ?? data.renderedValue ?? {});
        metaEl.textContent = `测试成功 · 耗时 ${Number(data.durationMs || 0)} ms · 输出版本 ${data.version || '-'}`;
    } catch (err) {
        resultEl.textContent = `错误：${err.message || '测试失败'}`;
        metaEl.textContent = '测试失败';
    }
}

// ==================== Utility ====================
function renderPagination(containerId, pagination, fnName) {
    const container = document.getElementById(containerId);
    if (!pagination || pagination.total <= pagination.limit) { container.innerHTML = ''; return; }
    const totalPages = Math.ceil(pagination.total / pagination.limit);
    let html = '<div class="join">';
    for (let i = 1; i <= totalPages && i <= 10; i++) {
        html += `<button class="join-item btn btn-sm ${i === pagination.page ? 'btn-active' : ''}" onclick="${fnName}(${i})">${i}</button>`;
    }
    html += '</div>';
    container.innerHTML = html;
}

// ==================== Gift Config ====================
async function loadAdminGiftConfig() {
    try {
        const res = await Auth.apiFetch('/api/gifts');
        const gifts = await res.json();
        const tbody = document.querySelector('#adminGiftConfigTable tbody');
        document.getElementById('admin-giftCount').textContent = gifts.length;

        if (!gifts || gifts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center opacity-50">暂无礼物数据，开启直播监控后会自动采集</td></tr>';
            return;
        }

        tbody.innerHTML = gifts.map(g => {
            const icon = g.iconUrl
                ? `<img src="${g.iconUrl}" class="w-8 h-8 rounded" alt="${g.nameEn}" onerror="this.src=''">`
                : '🎁';
            return `<tr>
                <td class="text-center">${icon}</td>
                <td class="font-mono text-sm">${g.nameEn || '-'}</td>
                <td><input type="text" class="input input-bordered input-sm w-full max-w-xs admin-gift-input" data-gift-id="${g.giftId}" value="${g.nameCn || ''}" placeholder="输入中文名..."></td>
                <td class="text-right font-mono text-warning">💎 ${(g.diamondCount || 0).toLocaleString()}</td>
            </tr>`;
        }).join('');

        // Bind save events
        document.querySelectorAll('.admin-gift-input').forEach(input => {
            input.addEventListener('blur', saveAdminGiftName);
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); saveAdminGiftName.call(this); }
            });
        });
    } catch (err) {
        console.error('Failed to load gift config:', err);
        document.querySelector('#adminGiftConfigTable tbody').innerHTML = '<tr><td colspan="4" class="text-center text-error">加载失败</td></tr>';
    }
}

async function saveAdminGiftName() {
    const input = this;
    const giftId = input.dataset.giftId;
    const nameCn = input.value.trim();
    try {
        const res = await Auth.apiFetch(`/api/gifts/${encodeURIComponent(giftId)}`, {
            method: 'PUT',
            body: JSON.stringify({ nameCn })
        });
        if (res.ok) {
            input.classList.add('input-success');
            setTimeout(() => input.classList.remove('input-success'), 1000);
        }
    } catch (err) {
        input.classList.add('input-error');
        setTimeout(() => input.classList.remove('input-error'), 2000);
    }
}

// ==================== Euler API Keys ====================
function formatEulerTime(value, fallback = '从未') {
    if (!value) return fallback;
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return fallback;
    return time.toLocaleString('zh-CN');
}

function getEulerStatusBadge(key) {
    const effectiveStatus = String(key?.effectiveStatus || key?.lastStatus || 'unknown').toLowerCase();
    if (effectiveStatus === 'ok') {
        return '<span class="badge badge-success badge-xs">正常</span>';
    }
    if (effectiveStatus === 'error') {
        return '<span class="badge badge-error badge-xs">异常</span>';
    }
    return '<span class="badge badge-ghost badge-xs">未测试</span>';
}

function getEulerPoolStatusMeta(status) {
    const normalized = String(status || 'unknown').toLowerCase();
    if (normalized === 'healthy') return { label: '池状态正常', badge: 'badge-success' };
    if (normalized === 'degraded') return { label: '池状态降级', badge: 'badge-warning' };
    if (normalized === 'exhausted') return { label: '全池冷却', badge: 'badge-error' };
    if (normalized === 'empty') return { label: '未配置 Key', badge: 'badge-ghost' };
    return { label: '池状态未知', badge: 'badge-ghost' };
}

function getEulerConnectivityModeMeta(mode) {
    const normalized = String(mode || 'unknown').toLowerCase();
    if (normalized === 'euler_available') return { label: 'Euler 可直接参与建连', badge: 'badge-success' };
    if (normalized === 'fallback_active') return { label: '当前已有回退链路成功（HTML / API / Euler兜底）', badge: 'badge-warning' };
    if (normalized === 'fallback_possible') return { label: 'Euler 池不可用，系统可能退化到 HTML / API / Euler兜底链路', badge: 'badge-warning' };
    return { label: '系统建连能力待确认', badge: 'badge-ghost' };
}

function formatEulerPathLabel(path) {
    const normalized = String(path || 'unknown').toLowerCase();
    if (normalized === 'euler_room_lookup') return 'Euler 直连解析';
    if (normalized === 'euler_room_lookup_fallback') return 'Euler 兜底解析';
    if (normalized === 'tiktok_html') return 'TikTok HTML 解析';
    if (normalized === 'tiktok_api') return 'TikTok API 解析';
    if (normalized === 'tiktok_fallback') return 'TikTok HTML/API 回退链';
    return '未知';
}

function formatEulerConfigSource(runtimeStatus = {}) {
    const source = String(runtimeStatus?.configSource || 'unknown').toLowerCase();
    if (source === 'db_table') return '后台 Key 表';
    if (source === 'settings') return '系统设置 euler_keys';
    if (source === 'env') return '环境变量';
    if (source === 'none') return '未配置';
    return '未知';
}


function getPremiumRoomLookupLevelMeta(level) {
    const normalized = String(level || 'unset').toLowerCase();
    if (normalized === 'premium') {
        return {
            label: 'Premium / Business',
            badge: 'badge-success',
            description: '这把 Key 已手工标记为 Premium，可在 HTML / API 失败时启用 Euler /webcast/room_id 兜底。',
        };
    }
    if (normalized === 'basic') {
        return {
            label: '基础 / Community',
            badge: 'badge-neutral',
            description: '这把 Key 按基础等级处理，不会使用 Euler /webcast/room_id。',
        };
    }
    return {
        label: '未设置等级',
        badge: 'badge-ghost',
        description: '这把 Key 尚未手工设置等级；默认不启用 Euler /webcast/room_id。',
    };
}

function renderEulerRuntimeSummary(runtimeStatus, keys) {
    const container = document.getElementById('euler-keys-runtime');
    if (!container) return;

    const total = Number(runtimeStatus?.total || 0);
    const active = Number(runtimeStatus?.active || 0);
    const disabled = Number(runtimeStatus?.disabled || 0);
    const selectionCount = Number(runtimeStatus?.selectionCount || 0);
    const rotationCount = Number(runtimeStatus?.rotationCount || 0);
    const rateLimitCount = Number(runtimeStatus?.rateLimitCount || 0);
    const disabledCount = Number(runtimeStatus?.disabledCount || 0);
    const reenabledCount = Number(runtimeStatus?.reenabledCount || 0);
    const allKeysDisabledCount = Number(runtimeStatus?.allKeysDisabledCount || 0);
    const roomLookupRequestCount = Number(runtimeStatus?.roomLookupRequestCount || 0);
    const liveCheckRequestCount = Number(runtimeStatus?.liveCheckRequestCount || 0);
    const connectSuccessCount = Number(runtimeStatus?.connectSuccessCount || 0);
    const fallbackConnectCount = Number(runtimeStatus?.fallbackConnectCount || 0);
    const permissionDeniedCount = Number(runtimeStatus?.permissionDeniedCount || 0);
    const premiumRoomLookupPremiumCount = Number(runtimeStatus?.premiumRoomLookupPremiumCount || 0);
    const premiumRoomLookupBasicCount = Number(runtimeStatus?.premiumRoomLookupBasicCount || 0);
    const premiumRoomLookupUnsetCount = Number(runtimeStatus?.premiumRoomLookupUnsetCount || 0);
    const poolStatus = getEulerPoolStatusMeta(runtimeStatus?.poolStatus);
    const connectivityMode = getEulerConnectivityModeMeta(runtimeStatus?.connectivityMode);
    const configSource = formatEulerConfigSource(runtimeStatus);
    const lastConnectPath = formatEulerPathLabel(runtimeStatus?.lastConnectPath);
    const sourceHints = [];
    if (keys.length === 0 && total > 0) {
        sourceHints.push('数据库中暂无 Euler Key，当前展示的是运行时加载的系统设置 / 环境变量 Key 状态。');
    }
    if (runtimeStatus?.legacySingleKeyConfigured) {
        sourceHints.push('系统设置中的单 Key（euler_api_key）仍可参与兜底，但不会像后台 Key 表那样逐条展示运行时统计。');
    }
    if (runtimeStatus?.envSingleKeyConfigured) {
        sourceHints.push('环境变量中的单 Key（EULER_API_KEY）更适合作为临时兜底；如需长期运营，建议迁移到后台 Key 表统一管理。');
    }
    if (runtimeStatus?.premiumRoomLookupDisabledByEnv) {
        sourceHints.push('你已通过环境变量显式禁用 Premium room lookup；当前系统即使把某把 Key 手工设为 Premium，也不会启用 Euler `/webcast/room_id`。');
    } else {
        sourceHints.push('当前系统改为“手工等级”模式：默认先走 TikTok HTML / API；只有被你手工设为 Premium 的 Key，才允许在 HTML / API 失败时启用 Euler `/webcast/room_id` 兜底。');
    }
    if (premiumRoomLookupPremiumCount === 0) {
        sourceHints.push('如果你长期使用的是 Community 套餐，但直播间监测一直正常，这是正常现象：系统主链路依赖的是 TikTok HTML / API 与 Euler 基础签名 / 建连能力，而不是 `/webcast/room_id`。');
    }
    sourceHints.push('系统不再自动探测 Premium 能力；如果你后续升级了某把 Key，请直接编辑该 Key 的等级。');
    const sourceHint = sourceHints.map((message) => `<div class="alert alert-info py-2 text-xs mt-3">${message}</div>`).join('');

    if (total === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="card bg-base-100 border border-base-300">
            <div class="card-body p-4">
                <div class="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                        <h4 class="font-semibold">运行态总览</h4>
                        <p class="text-xs text-base-content/60 mt-1">展示当前进程里的 Euler Key 池状态、真实请求消耗与最近连接路径；不等同于系统绝对不可连接。</p>
                    </div>
                    <div class="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
                        <span class="badge badge-sm ${poolStatus.badge}">${poolStatus.label}</span>
                        <span class="badge badge-sm ${connectivityMode.badge}">${connectivityMode.label}</span>
                    </div>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mt-4 text-sm">
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">总 Key</div><div class="font-semibold mt-1">${total}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">Euler Key 池可用 / 冷却</div><div class="font-semibold mt-1">${active} / ${disabled}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">被选中次数</div><div class="font-semibold mt-1">${selectionCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">轮换次数</div><div class="font-semibold mt-1">${rotationCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">房间查询请求</div><div class="font-semibold mt-1">${roomLookupRequestCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">直播探活请求</div><div class="font-semibold mt-1">${liveCheckRequestCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">限流次数</div><div class="font-semibold mt-1">${rateLimitCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">禁用次数</div><div class="font-semibold mt-1">${disabledCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">恢复次数</div><div class="font-semibold mt-1">${reenabledCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">全 Key 冷却</div><div class="font-semibold mt-1">${allKeysDisabledCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">成功建连</div><div class="font-semibold mt-1">${connectSuccessCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">Fallback 建连</div><div class="font-semibold mt-1">${fallbackConnectCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">权限拒绝</div><div class="font-semibold mt-1">${permissionDeniedCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">Premium 等级</div><div class="font-semibold mt-1">${premiumRoomLookupPremiumCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">基础 / Community</div><div class="font-semibold mt-1">${premiumRoomLookupBasicCount}</div></div>
                    <div class="rounded-box bg-base-200 px-3 py-2"><div class="text-xs text-base-content/60">未设置等级</div><div class="font-semibold mt-1">${premiumRoomLookupUnsetCount}</div></div>
                </div>
                <div class="flex flex-wrap gap-x-4 gap-y-1 mt-4 text-xs text-base-content/60">
                    <span>配置来源：${configSource}</span>
                    <span>上次选择：${formatEulerTime(runtimeStatus?.lastSelectedAt)}</span>
                    <span>上次禁用：${formatEulerTime(runtimeStatus?.lastDisabledAt)}</span>
                    <span>最近连接路径：${lastConnectPath}</span>
                    <span>最近连接：${formatEulerTime(runtimeStatus?.lastConnectAt)}</span>
                    <span>当前 Key：${runtimeStatus?.currentKeyMasked || '-'}</span>
                    <span>禁用原因：${runtimeStatus?.lastDisableReason || '-'}</span>
                    <span>最近刷新：${formatEulerTime(runtimeStatus?.lastEvaluatedAt)}</span>
                </div>
                <div class="text-xs text-base-content/50 mt-3">说明：当 Euler Key 池全部进入冷却时，系统仍可能通过 TikTok HTML、TikTok API 或 Euler 兜底链路建立连接；因此“全池冷却”不等于“系统绝对不可连接”。</div>
                ${sourceHint}
            </div>
        </div>`;
}

async function loadEulerKeys() {
    try {
        const res = await Auth.apiFetch('/api/admin/euler-keys');
        const data = await res.json();
        const keys = data.keys || [];
        const runtimeStatus = data.runtimeStatus || {};
        const container = document.getElementById('euler-keys-list');
        const runtimeKeyMap = new Map((runtimeStatus.keys || []).map(item => [item.id ?? item.keyMasked, item]));

        renderEulerRuntimeSummary(runtimeStatus, keys);

        if (keys.length === 0) {
            container.innerHTML = runtimeStatus.total > 0
                ? '<p class="text-base-content/60">数据库中暂无 Euler API Key，当前进程已加载环境变量 Key。</p>'
                : '<p class="text-base-content/60">暂无 Euler API Key，点击右上方添加</p>';
            return;
        }

        container.innerHTML = keys.map(k => {
            const runtime = runtimeKeyMap.get(k.id ?? (k.keyValue ? `${k.keyValue.slice(0, 10)}...` : null)) || {};
            const masked = k.keyValue ? k.keyValue.slice(0, 12) + '...' + k.keyValue.slice(-4) : '-';
            const safeName = escapeHtml(k.name || '未命名');
            const safeMasked = escapeHtml(masked);
            const statusBadge = getEulerStatusBadge(k);
            const premiumRoomLookupMeta = getPremiumRoomLookupLevelMeta(k.premiumRoomLookupLevel || runtime.premiumRoomLookupLevel);
            const runtimeBadge = !k.isActive
                ? '<span class="badge badge-neutral badge-xs">未纳入运行池</span>'
                : runtime.isDisabled
                    ? '<span class="badge badge-warning badge-xs">冷却中</span>'
                    : '<span class="badge badge-info badge-xs">可选中</span>';
            const rateLimitBadge = !runtime.isDisabled && k.hasRateLimitError
                ? '<span class="badge badge-warning badge-xs">上次限流</span>'
                : '';
            const lastUsed = formatEulerTime(k.lastUsedAt);
            const lastSelectedAt = formatEulerTime(runtime.lastSelectedAt);
            const disabledUntil = formatEulerTime(runtime.disabledUntil, '-');
            const lastConnectedAt = formatEulerTime(runtime.lastConnectAt, '-');
            const lastConnectPath = formatEulerPathLabel(runtime.lastConnectPath);
            const safeDisableReason = escapeHtml(runtime.lastDisableReason || '-');
            return `
            <div class="card bg-base-100 border ${k.isActive ? 'border-base-300' : 'border-error opacity-60'}">
                <div class="card-body p-4">
                    <div class="flex justify-between items-start flex-wrap gap-2">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                                <h4 class="font-bold">${safeName}</h4>
                                ${statusBadge}
                                ${runtimeBadge}
                                ${rateLimitBadge}
                                <span class="badge ${premiumRoomLookupMeta.badge} badge-xs" title="${escapeHtml(premiumRoomLookupMeta.description)}">${premiumRoomLookupMeta.label}</span>
                                ${!k.isActive ? '<span class="badge badge-error badge-xs">已禁用</span>' : ''}
                            </div>
                            <p class="text-sm font-mono text-base-content/60 mt-1">${safeMasked}</p>
                            <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 mt-3 text-xs text-base-content/60">
                                <div class="rounded-box bg-base-200 px-3 py-2"><span>累计选中</span><div class="text-base-content font-semibold mt-1">${k.callCount || 0}</div></div>
                                <div class="rounded-box bg-base-200 px-3 py-2"><span>运行选中</span><div class="text-base-content font-semibold mt-1">${runtime.selectedCount || 0}</div></div>
                                <div class="rounded-box bg-base-200 px-3 py-2"><span>房间查询</span><div class="text-base-content font-semibold mt-1">${runtime.roomLookupRequestCount || 0}</div></div>
                                <div class="rounded-box bg-base-200 px-3 py-2"><span>直播探活</span><div class="text-base-content font-semibold mt-1">${runtime.liveCheckRequestCount || 0}</div></div>
                                <div class="rounded-box bg-base-200 px-3 py-2"><span>成功建连</span><div class="text-base-content font-semibold mt-1">${runtime.successCount || 0}</div></div>
                                <div class="rounded-box bg-base-200 px-3 py-2"><span>限流次数</span><div class="text-base-content font-semibold mt-1">${runtime.rateLimitCount || 0}</div></div>
                                <div class="rounded-box bg-base-200 px-3 py-2"><span>权限拒绝</span><div class="text-base-content font-semibold mt-1">${runtime.permissionDeniedCount || 0}</div></div>
                            </div>
                            <div class="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-base-content/50">
                                <span>最后使用：${lastUsed}</span>
                                <span>上次选中：${lastSelectedAt}</span>
                                <span>冷却至：${disabledUntil}</span>
                                <span>最近连接：${lastConnectedAt}</span>
                                <span>连接路径：${lastConnectPath}</span>
                                <span>Key等级：${premiumRoomLookupMeta.label}</span>
                                <span>禁用原因：${safeDisableReason}</span>
                            </div>
                        </div>
                        <div class="flex gap-1 flex-shrink-0">
                            <button class="btn btn-xs btn-outline btn-info" title="检查该 Key 的基础额度接口是否可达" onclick="testEulerKey(event, ${k.id})">额度</button>
                            <button class="btn btn-xs btn-ghost" onclick='editEulerKey(${k.id}, ${JSON.stringify(k.name || '')}, ${k.isActive}, ${JSON.stringify(k.premiumRoomLookupLevel || 'basic')})'>编辑</button>
                            <button class="btn btn-xs btn-error btn-outline" onclick="deleteEulerKey(${k.id})">删除</button>
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        console.error('Load euler keys error:', err);
    }
}

function showAddEulerKey() {
    document.getElementById('ek-id').value = '';
    document.getElementById('ek-name').value = '';
    document.getElementById('ek-key').value = '';
    document.getElementById('ek-premium-level').value = 'basic';
    document.getElementById('ek-active').checked = true;
    document.getElementById('euler-key-modal-title').textContent = '添加 Euler API Key';
    document.getElementById('euler-key-modal-submit').textContent = '添加';
    document.getElementById('ek-key-group').classList.remove('hidden');
    document.getElementById('eulerKeyModal').showModal();
}

async function submitEulerKey() {
    const id = document.getElementById('ek-id').value.trim();
    const keyValue = document.getElementById('ek-key').value.trim();
    const name = document.getElementById('ek-name').value.trim();
    const premiumRoomLookupLevel = document.getElementById('ek-premium-level').value;
    const isActive = document.getElementById('ek-active').checked;

    if (!id && !keyValue) {
        alert('请输入 API Key');
        return;
    }

    const url = id ? `/api/admin/euler-keys/${id}` : '/api/admin/euler-keys';
    const method = id ? 'PUT' : 'POST';
    const payload = id
        ? { name, isActive, premiumRoomLookupLevel }
        : { keyValue, name, isActive, premiumRoomLookupLevel };

    const res = await Auth.apiFetch(url, {
        method,
        body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
        document.getElementById('eulerKeyModal').close();
        loadEulerKeys();
        return;
    }
    alert(data.error || (id ? '保存失败' : '添加失败'));
}

async function testEulerKey(event, id) {
    const btn = event?.currentTarget || event?.target;
    if (btn) btn.classList.add('loading');
    try {
        const res = await Auth.apiFetch(`/api/admin/euler-keys/${id}/test`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert(`额度测试成功
延迟: ${data.latency}ms`);
        } else if (data.transient) {
            alert(`额度测试结果
${data.error || `HTTP ${data.status}`}`);
        } else {
            alert(`额度测试失败
${data.error || `HTTP ${data.status}`}`);
        }
        loadEulerKeys();
    } catch (err) {
        alert('额度测试请求失败: ' + err.message);
    } finally {
        if (btn) btn.classList.remove('loading');
    }
}

async function testEulerKeyRoomLookup() {
    alert('Premium 自动探测已停用，请直接在“编辑”里手工设置该 Key 的等级。');
}

function editEulerKey(id, name, isActive, premiumRoomLookupLevel = 'basic') {
    document.getElementById('ek-id').value = String(id || '');
    document.getElementById('ek-name').value = String(name || '');
    document.getElementById('ek-key').value = '';
    document.getElementById('ek-premium-level').value = String(premiumRoomLookupLevel || 'basic');
    document.getElementById('ek-active').checked = Boolean(isActive);
    document.getElementById('euler-key-modal-title').textContent = '编辑 Euler API Key';
    document.getElementById('euler-key-modal-submit').textContent = '保存';
    document.getElementById('ek-key-group').classList.add('hidden');
    document.getElementById('eulerKeyModal').showModal();
}

async function deleteEulerKey(id) {
    if (!confirm('确定要删除此 Key？')) return;
    await Auth.apiFetch(`/api/admin/euler-keys/${id}`, { method: 'DELETE' });
    loadEulerKeys();
}

// ==================== AI Channels & Models ====================
function formatAiCooldown(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins > 0) return `${mins}分${secs}秒`;
    return `${secs}秒`;
}

async function loadAiModels() {
    try {
        const res = await Auth.apiFetch('/api/admin/ai-channels');
        const data = await res.json();
        const channels = data.channels || [];
        const container = document.getElementById('ai-models-list');
        const cooldownMinutes = Math.max(1, Math.round(Number(data.fallbackPolicy?.cooldownMs || 0) / 60000) || 5);
        const strategyHtml = `<div class="alert bg-base-200 border border-base-300 text-sm mb-3">
            <span>策略：默认模型优先；最近失败的模型会自动冷却约 ${cooldownMinutes} 分钟并临时后置，减少重复撞到坏模型的额外延迟。</span>
        </div>`;

        if (channels.length === 0) {
            container.innerHTML = `${strategyHtml}<p class="text-base-content/60">暂无 AI 通道，点击右上方添加</p>`;
            return;
        }

        container.innerHTML = strategyHtml + channels.map(ch => {
            const maskedKey = ch.apiKey ? ch.apiKey.slice(0, 8) + '...' + ch.apiKey.slice(-4) : '-';
            const modelsHtml = (ch.models || []).map(m => {
                const statusBadge = m.lastStatus === 'ok' ? '<span class="badge badge-success badge-xs">正常</span>'
                    : m.lastStatus === 'error' ? '<span class="badge badge-error badge-xs">异常</span>'
                        : '<span class="badge badge-ghost badge-xs">未测试</span>';
                const successRate = m.callCount > 0 ? Math.round((m.successCount / m.callCount) * 100) : '-';
                const coolingBadge = m.isCooling ? `<span class="badge badge-warning badge-xs">冷却中 ${formatAiCooldown(m.cooldownRemainingSeconds)}</span>` : '';
                const failBadge = m.consecutiveFailures > 0 ? `<span class="badge badge-outline badge-xs">连败 ${m.consecutiveFailures}</span>` : '';
                return `<div class="flex items-center justify-between py-2 px-3 bg-base-200 rounded ${!m.isActive ? 'opacity-50' : ''}">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="font-mono text-sm">${m.name}</span>
                            ${statusBadge}
                            ${m.isDefault ? '<span class="badge badge-primary badge-xs">默认</span>' : ''}
                            ${coolingBadge}
                            ${failBadge}
                            ${!m.isActive ? '<span class="badge badge-error badge-xs">禁用</span>' : ''}
                        </div>
                        <div class="text-xs text-base-content/50 mt-0.5">ID: ${m.modelId} | 调用: ${m.callCount || 0} | 成功率: ${successRate}% | 延迟: ${m.avgLatencyMs || '-'}ms</div>
                        ${m.lastError ? `<div class="text-xs text-error truncate">${m.lastError.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}
                    </div>
                    <div class="flex gap-1 flex-shrink-0 ml-2">
                        ${m.isDefault
                        ? '<button class="btn btn-xs btn-disabled">当前默认</button>'
                        : `<button class="btn btn-xs btn-outline btn-primary" onclick="setDefaultAiModel(${m.id})">设默认</button>`}
                        <button class="btn btn-xs btn-outline btn-info" onclick="testAiModel(${m.id})">测试</button>
                        <button class="btn btn-xs btn-ghost" onclick="editAiModelInline(${m.id}, '${(m.name || '').replace(/'/g, "\\'")}', '${(m.modelId || '').replace(/'/g, "\\'")}')">编辑</button>
                        <button class="btn btn-xs btn-error btn-outline" onclick="deleteAiModel(${m.id})">删</button>
                    </div>
                </div>`;
            }).join('');

            return `
            <div class="card bg-base-100 border ${ch.isActive ? 'border-base-300' : 'border-error opacity-60'}">
                <div class="card-body p-4">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <h4 class="font-bold text-lg">${ch.name} ${!ch.isActive ? '<span class="badge badge-error badge-xs">已禁用</span>' : ''}</h4>
                            <p class="text-xs text-base-content/50">API: ${ch.apiUrl} | Key: ${maskedKey}</p>
                        </div>
                        <div class="flex gap-1">
                            <button class="btn btn-xs btn-primary btn-outline" onclick="showAddModelToChannel(${ch.id}, '${ch.name.replace(/'/g, "\\'")}')">添加模型</button>
                            <button class="btn btn-xs btn-ghost" onclick="editChannel(${ch.id}, '${(ch.name || '').replace(/'/g, "\\'")}', '${(ch.apiUrl || '').replace(/'/g, "\\'")}')">编辑</button>
                            <button class="btn btn-xs btn-error btn-outline" onclick="deleteChannel(${ch.id})">删除</button>
                        </div>
                    </div>
                    <div class="space-y-1.5">${modelsHtml || '<p class="text-sm text-base-content/40 py-1">暂无模型，点击"添加模型"</p>'}</div>
                </div>
            </div>`;
        }).join('');
    } catch (err) { console.error('Load AI channels error:', err); }
}

function showAddAiModel() {
    document.getElementById('aim-form-title').textContent = '添加 AI 通道';
    document.getElementById('aim-id').value = '';
    document.getElementById('aim-name').value = '';
    document.getElementById('aim-url').value = '';
    document.getElementById('aim-key').value = '';
    document.getElementById('aiModelModal').showModal();
}

async function submitAiModel() {
    const id = document.getElementById('aim-id').value;
    const body = {
        name: document.getElementById('aim-name').value.trim(),
        apiUrl: document.getElementById('aim-url').value.trim(),
        apiKey: document.getElementById('aim-key').value.trim(),
    };
    if (!body.name || !body.apiUrl || !body.apiKey) { alert('请填写所有必填项'); return; }

    const url = id ? `/api/admin/ai-channels/${id}` : '/api/admin/ai-channels';
    const method = id ? 'PUT' : 'POST';
    const res = await Auth.apiFetch(url, { method, body: JSON.stringify(body) });
    const data = await res.json();
    document.getElementById('aiModelModal').close();
    if (res.ok) loadAiModels();
    else alert(data.error || '操作失败');
}

function editChannel(id, name, apiUrl) {
    document.getElementById('aim-form-title').textContent = '编辑 AI 通道';
    document.getElementById('aim-id').value = id;
    document.getElementById('aim-name').value = name;
    document.getElementById('aim-url').value = apiUrl;
    document.getElementById('aim-key').value = '';
    document.getElementById('aim-key').placeholder = '留空则不修改';
    document.getElementById('aiModelModal').showModal();
}

async function deleteChannel(id) {
    if (!confirm('确定要删除此通道及其所有模型？')) return;
    await Auth.apiFetch(`/api/admin/ai-channels/${id}`, { method: 'DELETE' });
    loadAiModels();
}

function showAddModelToChannel(channelId, channelName) {
    const name = prompt(`为通道 "${channelName}" 添加模型\n\n模型名称（显示用）:`);
    if (!name) return;
    const modelId = prompt('模型ID（API调用用）:');
    if (!modelId) return;
    const isDefault = confirm('设为默认模型？');
    Auth.apiFetch(`/api/admin/ai-channels/${channelId}/models`, {
        method: 'POST', body: JSON.stringify({ name, modelId, isDefault })
    }).then(r => r.json()).then(d => { if (d.error) alert(d.error); loadAiModels(); });
}

async function setDefaultAiModel(id) {
    const res = await Auth.apiFetch(`/api/admin/ai-models/${id}/set-default`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
        alert(data.error || '设置默认模型失败');
        return;
    }
    loadAiModels();
}

function editAiModelInline(id, name, modelId) {
    const newName = prompt('模型名称:', name);
    if (newName === null) return;
    const newModelId = prompt('模型ID:', modelId);
    if (newModelId === null) return;
    Auth.apiFetch(`/api/admin/ai-models/${id}`, {
        method: 'PUT', body: JSON.stringify({ name: newName, modelId: newModelId })
    }).then(() => loadAiModels());
}

async function testAiModel(id) {
    const btn = event.target;
    btn.classList.add('loading');
    try {
        const res = await Auth.apiFetch(`/api/admin/ai-models/${id}/test`, { method: 'POST' });
        const data = await res.json();
        btn.classList.remove('loading');
        alert(data.success ? `测试成功! 延迟: ${data.latency}ms\n回复: ${data.reply}` : `测试失败: ${data.error || `HTTP ${data.status}`}`);
        loadAiModels();
    } catch (err) { btn.classList.remove('loading'); alert('请求失败: ' + err.message); }
}

async function deleteAiModel(id) {
    if (!confirm('确定要删除此模型？')) return;
    await Auth.apiFetch(`/api/admin/ai-models/${id}`, { method: 'DELETE' });
    loadAiModels();
}

// ==================== AI Credit Packages ====================
async function loadAiCreditPackages() {
    try {
        const res = await Auth.apiFetch('/api/admin/ai-credit-packages');
        const data = await res.json();
        const pkgs = data.packages || [];
        const container = document.getElementById('ai-credits-list');
        if (pkgs.length === 0) {
            container.innerHTML = '<p class="text-base-content/60">暂无 AI 点数包</p>';
            return;
        }
        container.innerHTML = pkgs.map(p => {
            const normalizedDescription = String(p.description || '')
                .replace(/AI分析/g, 'AI')
                .replace(/AI 分析/g, 'AI')
                .replace(/分析额度/g, '点数')
                .replace(/额度包/g, '点数包')
                .replace(/(\d+)次/g, '$1点');
            return `
            <div class="card bg-base-100 border ${p.isActive ? 'border-base-300' : 'border-error opacity-60'}">
                <div class="card-body p-4">
                    <div class="flex justify-between items-center">
                        <div>
                            <h4 class="font-bold">${p.name}</h4>
                            <p class="text-sm">${p.credits} 点 | ¥${Number(p.priceYuan || 0).toFixed(2)} ${normalizedDescription ? '| ' + normalizedDescription : ''}</p>
                        </div>
                        <div class="flex gap-1">
                            <button class="btn btn-xs btn-ghost" onclick='editAiCreditPkg(${JSON.stringify(p).replace(/'/g, "&#39;")})'>编辑</button>
                            <button class="btn btn-xs btn-error btn-outline" onclick="deleteAiCreditPkg(${p.id})">下架</button>
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (err) { console.error('Load AI credit packages error:', err); }
}

function showAiCreditForm(pkg) {
    document.getElementById('aic-form-title').textContent = pkg ? '编辑 AI 点数包' : '新增 AI 点数包';
    document.getElementById('aic-id').value = pkg?.id || '';
    document.getElementById('aic-name').value = pkg?.name || '';
    document.getElementById('aic-credits').value = pkg?.credits || '';
    document.getElementById('aic-price').value = pkg?.priceYuan || '';
    document.getElementById('aic-desc').value = pkg?.description || '';
    document.getElementById('aiCreditModal').showModal();
}

function editAiCreditPkg(p) { showAiCreditForm(p); }

async function submitAiCreditForm() {
    const id = document.getElementById('aic-id').value;
    const body = {
        name: document.getElementById('aic-name').value.trim(),
        credits: parseInt(document.getElementById('aic-credits').value),
        priceYuan: parseInt(document.getElementById('aic-price').value, 10),
        description: document.getElementById('aic-desc').value.trim(),
    };
    if (!body.name || !body.credits || isNaN(body.priceYuan)) { alert('请填写必填项'); return; }
    const url = id ? `/api/admin/ai-credit-packages/${id}` : '/api/admin/ai-credit-packages';
    const method = id ? 'PUT' : 'POST';
    const res = await Auth.apiFetch(url, { method, body: JSON.stringify(body) });
    const data = await res.json();
    document.getElementById('aiCreditModal').close();
    if (res.ok) loadAiCreditPackages();
    else alert(data.error || '操作失败');
}

async function deleteAiCreditPkg(id) {
    if (!confirm('确定要下架此额度包？')) return;
    await Auth.apiFetch(`/api/admin/ai-credit-packages/${id}`, { method: 'DELETE' });
    loadAiCreditPackages();
}


// ==================== Payment Config ====================
function updatePaymentImagePreview(previewId, emptyId, value) {
    const preview = document.getElementById(previewId);
    const empty = document.getElementById(emptyId);
    if (!preview || !empty) return;
    if (value) {
        preview.src = value;
        preview.classList.remove('hidden');
        empty.classList.add('hidden');
    } else {
        preview.removeAttribute('src');
        preview.classList.add('hidden');
        empty.classList.remove('hidden');
    }
}

function handlePaymentImageUpload(input, hiddenId, previewId, emptyId) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const hidden = document.getElementById(hiddenId);
        if (hidden) hidden.value = reader.result;
        updatePaymentImagePreview(previewId, emptyId, reader.result);
    };
    reader.readAsDataURL(file);
}

function clearPaymentImage(fileInputId, hiddenId, previewId, emptyId) {
    const fileInput = document.getElementById(fileInputId);
    const hidden = document.getElementById(hiddenId);
    if (fileInput) fileInput.value = '';
    if (hidden) hidden.value = '';
    updatePaymentImagePreview(previewId, emptyId, '');
}

function setPaymentRangeFields(minId, maxId, data = {}) {
    const minInput = document.getElementById(minId);
    const maxInput = document.getElementById(maxId);
    if (minInput) minInput.value = data?.minAmount ?? '';
    if (maxInput) maxInput.value = data?.maxAmount ?? '';
}

function getPositiveIntegerInputValue(id, fallback = '') {
    const raw = document.getElementById(id)?.value?.trim() || '';
    if (!raw) return fallback;
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return value;
}

function getNonNegativeDecimalInputValue(id, fallback = '') {
    const raw = document.getElementById(id)?.value?.trim() || '';
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function setPaymentFeeFields(modeId, valueId, data = {}) {
    const modeInput = document.getElementById(modeId);
    const valueInput = document.getElementById(valueId);
    if (modeInput) modeInput.value = data?.feeMode || 'fixed';
    if (valueInput) valueInput.value = data?.feeValue ?? data?.feeAmount ?? 0;
}

function readPaymentFeeFields(modeId, valueId) {
    const feeMode = document.getElementById(modeId)?.value || 'fixed';
    const feeValue = getNonNegativeDecimalInputValue(valueId, 0) || 0;
    return {
        feeMode,
        feeValue,
        feeAmount: feeValue
    };
}

function parseQuickAmountList(value) {
    const uniqueAmounts = [];
    String(value || '')
        .split(/[，,\s|/]+/)
        .map(item => parseInt(item, 10))
        .forEach(amount => {
            if (!Number.isFinite(amount) || amount <= 0 || uniqueAmounts.includes(amount)) return;
            uniqueAmounts.push(amount);
        });
    return uniqueAmounts;
}

function formatQuickAmountList(amounts) {
    return Array.isArray(amounts) ? amounts.join(',') : '';
}

function readPaymentRange(minId, maxId, fallbackMin) {
    return {
        minAmount: getPositiveIntegerInputValue(minId, fallbackMin),
        maxAmount: getPositiveIntegerInputValue(maxId, '')
    };
}

function setNotificationPushplusFields(config = {}) {
    document.getElementById('notice-pushplus-enabled').checked = !!config.enabled;
    document.getElementById('notice-pushplus-api-url').value = config.apiUrl || 'https://www.pushplus.plus/batchSend';
    document.getElementById('notice-pushplus-token').value = config.token || '';
    document.getElementById('notice-pushplus-channel').value = config.channel || 'app';
}

function readNotificationPushplusFields() {
    return {
        enabled: document.getElementById('notice-pushplus-enabled').checked,
        apiUrl: document.getElementById('notice-pushplus-api-url').value.trim(),
        token: document.getElementById('notice-pushplus-token').value.trim(),
        channel: document.getElementById('notice-pushplus-channel').value.trim() || 'app'
    };
}

async function loadNotificationConfig() {
    try {
        const res = await Auth.apiFetch(`/api/admin/payment/pushplus-config?_=${Date.now()}`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载失败');
        setNotificationPushplusFields(data.config || {});
    } catch (err) {
        console.error('Load notification config error:', err);
        alert('加载通知配置失败');
    }
}

async function saveNotificationConfig() {
    const res = await Auth.apiFetch('/api/admin/payment/pushplus-config', {
        method: 'PUT',
        body: JSON.stringify({ config: readNotificationPushplusFields() })
    });
    const data = await res.json();
    if (res.ok) {
        alert(data.message || '通知配置保存成功');
        loadNotificationConfig();
    } else {
        alert(data.error || '通知配置保存失败');
    }
}

async function loadPaymentConfig() {
    try {
        const res = await Auth.apiFetch(`/api/admin/payment/config?_=${Date.now()}`, { cache: 'no-store' });
        const data = await res.json();
        const config = data.config || {};
        document.getElementById('pay-min-recharge').value = config.minRechargeAmount || 1;
        document.getElementById('pay-quick-amounts').value = formatQuickAmountList(config.quickAmounts);

        document.getElementById('pay-fixed-wechat-enabled').checked = !!config.fixedQr?.wechat?.enabled;
        document.getElementById('pay-fixed-wechat-data').value = config.fixedQr?.wechat?.imageData || '';
        setPaymentRangeFields('pay-fixed-wechat-min', 'pay-fixed-wechat-max', config.fixedQr?.wechat);
        setPaymentFeeFields('pay-fixed-wechat-fee-mode', 'pay-fixed-wechat-fee', config.fixedQr?.wechat);
        document.getElementById('pay-fixed-wechat-recommended').checked = !!config.fixedQr?.wechat?.recommended;
        updatePaymentImagePreview('pay-fixed-wechat-preview', 'pay-fixed-wechat-empty', config.fixedQr?.wechat?.imageData || '');

        document.getElementById('pay-fixed-alipay-enabled').checked = !!config.fixedQr?.alipay?.enabled;
        document.getElementById('pay-fixed-alipay-data').value = config.fixedQr?.alipay?.imageData || '';
        setPaymentRangeFields('pay-fixed-alipay-min', 'pay-fixed-alipay-max', config.fixedQr?.alipay);
        setPaymentFeeFields('pay-fixed-alipay-fee-mode', 'pay-fixed-alipay-fee', config.fixedQr?.alipay);
        document.getElementById('pay-fixed-alipay-recommended').checked = !!config.fixedQr?.alipay?.recommended;
        updatePaymentImagePreview('pay-fixed-alipay-preview', 'pay-fixed-alipay-empty', config.fixedQr?.alipay?.imageData || '');

        document.getElementById('pay-futong-enabled').checked = !!config.futong?.enabled;
        document.getElementById('pay-futong-api-url').value = config.futong?.apiUrl || '';
        document.getElementById('pay-futong-pid').value = config.futong?.pid || '';
        document.getElementById('pay-futong-secret').value = config.futong?.secretKey || '';
        document.getElementById('pay-futong-alipay-enabled').checked = !!config.futong?.alipayEnabled;
        document.getElementById('pay-futong-wxpay-enabled').checked = !!config.futong?.wxpayEnabled;
        document.getElementById('pay-futong-alipay-min').value = config.futong?.alipayMinAmount ?? '';
        document.getElementById('pay-futong-alipay-max').value = config.futong?.alipayMaxAmount ?? '';
        setPaymentFeeFields('pay-futong-alipay-fee-mode', 'pay-futong-alipay-fee', {
            feeMode: config.futong?.alipayFeeMode,
            feeValue: config.futong?.alipayFeeValue,
            feeAmount: config.futong?.alipayFeeAmount
        });
        document.getElementById('pay-futong-alipay-recommended').checked = !!config.futong?.alipayRecommended;
        document.getElementById('pay-futong-wxpay-min').value = config.futong?.wxpayMinAmount ?? '';
        document.getElementById('pay-futong-wxpay-max').value = config.futong?.wxpayMaxAmount ?? '';
        setPaymentFeeFields('pay-futong-wxpay-fee-mode', 'pay-futong-wxpay-fee', {
            feeMode: config.futong?.wxpayFeeMode,
            feeValue: config.futong?.wxpayFeeValue,
            feeAmount: config.futong?.wxpayFeeAmount
        });
        document.getElementById('pay-futong-wxpay-recommended').checked = !!config.futong?.wxpayRecommended;
        document.getElementById('pay-futong-notify-url').value = config.futong?.notifyUrl || '';
        document.getElementById('pay-futong-return-url').value = config.futong?.returnUrl || '';
        document.getElementById('pay-futong-open-mode').value = config.futong?.openMode || 'qrcode';

        document.getElementById('pay-bepusdt-enabled').checked = !!config.bepusdt?.enabled;
        document.getElementById('pay-bepusdt-api-url').value = config.bepusdt?.apiUrl || '';
        document.getElementById('pay-bepusdt-token').value = config.bepusdt?.authToken || '';
        document.getElementById('pay-bepusdt-secret').value = config.bepusdt?.signSecret || '';
        document.getElementById('pay-bepusdt-trade-type').value = config.bepusdt?.tradeType || 'usdt.bep20';
        document.getElementById('pay-bepusdt-min').value = config.bepusdt?.minAmount ?? '';
        document.getElementById('pay-bepusdt-max').value = config.bepusdt?.maxAmount ?? '';
        setPaymentFeeFields('pay-bepusdt-fee-mode', 'pay-bepusdt-fee', config.bepusdt);
        document.getElementById('pay-bepusdt-recommended').checked = !!config.bepusdt?.recommended;
        document.getElementById('pay-bepusdt-notify-url').value = config.bepusdt?.notifyUrl || '';
        document.getElementById('pay-bepusdt-open-mode').value = config.bepusdt?.openMode || 'redirect';

    } catch (err) {
        console.error('Load payment config error:', err);
        alert('加载支付配置失败');
    }
}

async function savePaymentConfig() {
    const minRechargeAmount = getPositiveIntegerInputValue('pay-min-recharge', 1) || 1;
    const quickAmounts = parseQuickAmountList(document.getElementById('pay-quick-amounts')?.value || '');
    const ranges = [
        { label: '固定码微信', ...readPaymentRange('pay-fixed-wechat-min', 'pay-fixed-wechat-max', minRechargeAmount) },
        { label: '固定码支付宝', ...readPaymentRange('pay-fixed-alipay-min', 'pay-fixed-alipay-max', minRechargeAmount) },
        { label: '富通支付宝', ...readPaymentRange('pay-futong-alipay-min', 'pay-futong-alipay-max', minRechargeAmount) },
        { label: '富通微信', ...readPaymentRange('pay-futong-wxpay-min', 'pay-futong-wxpay-max', minRechargeAmount) },
        { label: 'BEPUSDT', ...readPaymentRange('pay-bepusdt-min', 'pay-bepusdt-max', minRechargeAmount) }
    ];

    const invalidRange = ranges.find(item => item.maxAmount !== '' && item.maxAmount < item.minAmount);
    if (invalidRange) {
        alert(`${invalidRange.label} 的最高金额不能小于最低金额`);
        return;
    }

    const fixedWechatRange = ranges[0];
    const fixedAlipayRange = ranges[1];
    const futongAlipayRange = ranges[2];
    const futongWxpayRange = ranges[3];
    const bepusdtRange = ranges[4];
    const fixedWechatFee = readPaymentFeeFields('pay-fixed-wechat-fee-mode', 'pay-fixed-wechat-fee');
    const fixedAlipayFee = readPaymentFeeFields('pay-fixed-alipay-fee-mode', 'pay-fixed-alipay-fee');
    const futongAlipayFee = readPaymentFeeFields('pay-futong-alipay-fee-mode', 'pay-futong-alipay-fee');
    const futongWxpayFee = readPaymentFeeFields('pay-futong-wxpay-fee-mode', 'pay-futong-wxpay-fee');
    const bepusdtFee = readPaymentFeeFields('pay-bepusdt-fee-mode', 'pay-bepusdt-fee');

    const payload = {
        minRechargeAmount,
        quickAmounts,
        fixedQr: {
            wechat: {
                enabled: document.getElementById('pay-fixed-wechat-enabled').checked,
                imageData: document.getElementById('pay-fixed-wechat-data').value || '',
                minAmount: fixedWechatRange.minAmount,
                maxAmount: fixedWechatRange.maxAmount,
                feeMode: fixedWechatFee.feeMode,
                feeValue: fixedWechatFee.feeValue,
                feeAmount: fixedWechatFee.feeAmount,
                recommended: document.getElementById('pay-fixed-wechat-recommended').checked
            },
            alipay: {
                enabled: document.getElementById('pay-fixed-alipay-enabled').checked,
                imageData: document.getElementById('pay-fixed-alipay-data').value || '',
                minAmount: fixedAlipayRange.minAmount,
                maxAmount: fixedAlipayRange.maxAmount,
                feeMode: fixedAlipayFee.feeMode,
                feeValue: fixedAlipayFee.feeValue,
                feeAmount: fixedAlipayFee.feeAmount,
                recommended: document.getElementById('pay-fixed-alipay-recommended').checked
            }
        },
        futong: {
            enabled: document.getElementById('pay-futong-enabled').checked,
            apiUrl: document.getElementById('pay-futong-api-url').value.trim(),
            pid: document.getElementById('pay-futong-pid').value.trim(),
            secretKey: document.getElementById('pay-futong-secret').value.trim(),
            openMode: document.getElementById('pay-futong-open-mode').value || 'qrcode',
            notifyUrl: document.getElementById('pay-futong-notify-url').value.trim(),
            returnUrl: document.getElementById('pay-futong-return-url').value.trim(),
            alipayEnabled: document.getElementById('pay-futong-alipay-enabled').checked,
            wxpayEnabled: document.getElementById('pay-futong-wxpay-enabled').checked,
            alipayMinAmount: futongAlipayRange.minAmount,
            alipayMaxAmount: futongAlipayRange.maxAmount,
            alipayFeeMode: futongAlipayFee.feeMode,
            alipayFeeValue: futongAlipayFee.feeValue,
            alipayFeeAmount: futongAlipayFee.feeAmount,
            alipayRecommended: document.getElementById('pay-futong-alipay-recommended').checked,
            wxpayMinAmount: futongWxpayRange.minAmount,
            wxpayMaxAmount: futongWxpayRange.maxAmount,
            wxpayFeeMode: futongWxpayFee.feeMode,
            wxpayFeeValue: futongWxpayFee.feeValue,
            wxpayFeeAmount: futongWxpayFee.feeAmount,
            wxpayRecommended: document.getElementById('pay-futong-wxpay-recommended').checked
        },
        bepusdt: {
            enabled: document.getElementById('pay-bepusdt-enabled').checked,
            apiUrl: document.getElementById('pay-bepusdt-api-url').value.trim(),
            authToken: document.getElementById('pay-bepusdt-token').value.trim(),
            signSecret: document.getElementById('pay-bepusdt-secret').value.trim(),
            openMode: document.getElementById('pay-bepusdt-open-mode').value || 'redirect',
            notifyUrl: document.getElementById('pay-bepusdt-notify-url').value.trim(),
            tradeType: document.getElementById('pay-bepusdt-trade-type').value || 'usdt.bep20',
            minAmount: bepusdtRange.minAmount,
            maxAmount: bepusdtRange.maxAmount,
            feeMode: bepusdtFee.feeMode,
            feeValue: bepusdtFee.feeValue,
            feeAmount: bepusdtFee.feeAmount,
            recommended: document.getElementById('pay-bepusdt-recommended').checked
        }
    };

    const res = await Auth.apiFetch('/api/admin/payment/config', {
        method: 'PUT',
        body: JSON.stringify({ config: payload })
    });
    const data = await res.json();
    if (res.ok) {
        alert(data.message || '支付配置保存成功');
        loadPaymentConfig();
    } else {
        alert(data.error || '支付配置保存失败');
    }
}

async function markRechargeOrderPaid(orderId) {
    if (!confirm('确认将该充值订单标记为已支付并给用户入账吗？')) return;
    const res = await Auth.apiFetch(`/api/admin/payment/orders/${orderId}/mark-paid`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
        alert(data.message || '处理成功');
        loadAdminOrders(1);
        loadOverviewStats();
    } else {
        alert(data.error || '处理失败');
    }
}

async function cancelRechargeOrder(orderId) {
    if (!confirm('确认取消该充值订单吗？')) return;
    const res = await Auth.apiFetch(`/api/admin/payment/orders/${orderId}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
        alert(data.message || '订单已取消');
        loadAdminOrders(1);
    } else {
        alert(data.error || '取消失败');
    }
}


function formatAdminDocTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString('zh-CN');
}

function formatAdminDocSize(size) {
    const num = Number(size || 0);
    if (!Number.isFinite(num) || num <= 0) return '0 B';
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAdminDocList() {
    const container = document.getElementById('admin-docs-list');
    if (!container) return;

    if (!adminDocsListCache.length) {
        container.innerHTML = '<div class="rounded-box bg-base-200 px-4 py-6 text-sm text-base-content/60">`docs/` 目录下还没有 Markdown 文档。</div>';
        return;
    }

    container.innerHTML = adminDocsListCache.map(doc => {
        const active = doc.path === currentAdminDocPath;
        const buttonClass = active
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-base-300 bg-base-200/60 hover:border-primary/40 hover:bg-base-200';
        const encodedPath = encodeURIComponent(doc.path);
        return `
            <button class="w-full text-left rounded-box border px-4 py-3 transition ${buttonClass}" onclick="loadAdminDocContent(decodeURIComponent('${encodedPath}'))">
                <div class="font-semibold leading-6">${escapeHtml(doc.title || doc.path)}</div>
                <div class="text-xs text-base-content/60 mt-1">${escapeHtml(doc.path)}</div>
                <div class="text-xs text-base-content/50 mt-2">更新于 ${formatAdminDocTime(doc.updatedAt)}</div>
            </button>
        `;
    }).join('');
}

function renderAdminMarkdownInline(text) {
    let html = escapeHtml(text ?? '');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return html;
}

function renderAdminMarkdown(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let paragraphLines = [];
    let listType = null;
    let listItems = [];
    let inCodeBlock = false;
    let codeLines = [];

    const flushParagraph = () => {
        if (!paragraphLines.length) return;
        html.push(`<p>${renderAdminMarkdownInline(paragraphLines.join(' '))}</p>`);
        paragraphLines = [];
    };

    const flushList = () => {
        if (!listType || !listItems.length) return;
        html.push(`<${listType}>${listItems.map(item => `<li>${renderAdminMarkdownInline(item)}</li>`).join('')}</${listType}>`);
        listType = null;
        listItems = [];
    };

    const flushCodeBlock = () => {
        if (!inCodeBlock) return;
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
    };

    for (const line of lines) {
        const trimmed = line.trim();

        if (inCodeBlock) {
            if (trimmed.startsWith('```')) {
                flushCodeBlock();
            } else {
                codeLines.push(line);
            }
            continue;
        }

        if (trimmed.startsWith('```')) {
            flushParagraph();
            flushList();
            inCodeBlock = true;
            codeLines = [];
            continue;
        }

        if (!trimmed) {
            flushParagraph();
            flushList();
            continue;
        }

        if (/^---+$/.test(trimmed)) {
            flushParagraph();
            flushList();
            html.push('<hr>');
            continue;
        }

        const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            flushParagraph();
            flushList();
            const level = headingMatch[1].length;
            html.push(`<h${level}>${renderAdminMarkdownInline(headingMatch[2])}</h${level}>`);
            continue;
        }

        const quoteMatch = trimmed.match(/^>\s?(.*)$/);
        if (quoteMatch) {
            flushParagraph();
            flushList();
            html.push(`<blockquote>${renderAdminMarkdownInline(quoteMatch[1])}</blockquote>`);
            continue;
        }

        const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
        if (unorderedMatch) {
            flushParagraph();
            if (listType && listType !== 'ul') flushList();
            listType = 'ul';
            listItems.push(unorderedMatch[1]);
            continue;
        }

        const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
        if (orderedMatch) {
            flushParagraph();
            if (listType && listType !== 'ol') flushList();
            listType = 'ol';
            listItems.push(orderedMatch[1]);
            continue;
        }

        paragraphLines.push(trimmed);
    }

    flushParagraph();
    flushList();
    flushCodeBlock();
    return html.join('');
}

function setAdminDocLoading(message = '正在加载文档...') {
    const titleEl = document.getElementById('admin-doc-title');
    const metaEl = document.getElementById('admin-doc-meta');
    const pathEl = document.getElementById('admin-doc-path');
    const contentEl = document.getElementById('admin-doc-content');
    if (titleEl) titleEl.textContent = message;
    if (metaEl) metaEl.textContent = '请稍候';
    if (pathEl) pathEl.textContent = 'docs/';
    if (contentEl) {
        contentEl.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-base-content/60">正在读取文档内容...</div>';
    }
}

async function loadAdminDocContent(docPath) {
    currentAdminDocPath = docPath;
    renderAdminDocList();
    setAdminDocLoading('正在打开文档...');

    try {
        const res = await Auth.apiFetch(`/api/admin/docs/content?path=${encodeURIComponent(docPath)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '读取文档失败');

        document.getElementById('admin-doc-title').textContent = data.title || docPath;
        document.getElementById('admin-doc-meta').textContent = `最后更新 ${formatAdminDocTime(data.updatedAt)} · ${formatAdminDocSize(data.size)}`;
        document.getElementById('admin-doc-path').textContent = `docs/${data.path}`;
        document.getElementById('admin-doc-content').innerHTML = renderAdminMarkdown(data.content || '');
        renderAdminDocList();
    } catch (err) {
        console.error('Load admin doc content error:', err);
        document.getElementById('admin-doc-title').textContent = '文档加载失败';
        document.getElementById('admin-doc-meta').textContent = err.message || '请稍后重试';
        document.getElementById('admin-doc-path').textContent = 'docs/';
        document.getElementById('admin-doc-content').innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-5 py-6 text-error">${escapeHtml(err.message || '读取文档失败')}</div>`;
    }
}

async function loadAdminDocs(forceRefresh = false) {
    const listEl = document.getElementById('admin-docs-list');
    if (!listEl) return;

    if (!forceRefresh && adminDocsLoadedOnce && adminDocsListCache.length) {
        renderAdminDocList();
        if (currentAdminDocPath) return;
        await loadAdminDocContent(adminDocsListCache[0].path);
        return;
    }

    listEl.innerHTML = '<div class="rounded-box bg-base-200 px-4 py-6 text-sm text-base-content/60">正在加载文档列表...</div>';
    try {
        const res = await Auth.apiFetch('/api/admin/docs');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载文档列表失败');

        adminDocsLoadedOnce = true;
        adminDocsListCache = Array.isArray(data.docs) ? data.docs : [];
        if (!adminDocsListCache.some(doc => doc.path === currentAdminDocPath)) {
            currentAdminDocPath = adminDocsListCache[0]?.path || '';
        }
        renderAdminDocList();

        if (currentAdminDocPath) {
            await loadAdminDocContent(currentAdminDocPath);
        } else {
            document.getElementById('admin-doc-title').textContent = '暂无系统文档';
            document.getElementById('admin-doc-meta').textContent = '请在 `docs/` 目录下添加 Markdown 文件';
            document.getElementById('admin-doc-path').textContent = 'docs/';
            document.getElementById('admin-doc-content').innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-base-content/60">当前还没有可展示的 Markdown 文档。</div>';
        }
    } catch (err) {
        console.error('Load admin docs error:', err);
        listEl.innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-4 py-6 text-sm text-error">${escapeHtml(err.message || '加载文档列表失败')}</div>`;
    }
}

function getAdminPermissionMetaMap() {
    const map = new Map();
    (adminPermissionGroups || []).forEach((group) => {
        (group.permissions || []).forEach((permission) => {
            map.set(permission.key, permission);
        });
    });
    return map;
}

function getAdminPermissionLabel(permissionKey) {
    if (!permissionKey) return '-';
    const permission = getAdminPermissionMetaMap().get(permissionKey);
    return permission?.label || permissionKey;
}

function formatAdminAccessTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(String(value));
    return escapeHtml(date.toLocaleString('zh-CN'));
}

function renderAdminPermissionBadges(permissionKeys = [], limit = 4) {
    const normalized = Array.isArray(permissionKeys) ? permissionKeys : [];
    if (!normalized.length) {
        return '<span class="text-base-content/40">未配置权限</span>';
    }
    const badges = normalized.slice(0, limit).map((key) => `<span class="badge badge-outline badge-sm">${escapeHtml(getAdminPermissionLabel(key))}</span>`);
    if (normalized.length > limit) {
        badges.push(`<span class="badge badge-ghost badge-sm">+${normalized.length - limit}</span>`);
    }
    return badges.join('');
}

function getAdminRoleOptionsHtml(selectedRoleId = null, allowEmpty = true) {
    const options = [];
    if (allowEmpty) {
        options.push(`<option value="">请选择角色</option>`);
    }
    adminRolesCache.forEach((role) => {
        const selected = Number(selectedRoleId) === Number(role.id) ? 'selected' : '';
        options.push(`<option value="${role.id}" ${selected}>${escapeHtml(role.name)} (${escapeHtml(role.code)})</option>`);
    });
    return options.join('');
}

function renderAdminAccessSummary() {
    const wrap = document.getElementById('admin-access-summary');
    if (!wrap) return;
    if (!adminAccessProfile) {
        wrap.innerHTML = '<div class="rounded-box border border-base-300 bg-base-100 px-5 py-5 text-sm text-base-content/60">未获取到管理员权限画像。</div>';
        return;
    }

    const visibleSections = Object.keys(ADMIN_SECTION_META).filter((key) => canAccessSection(key));
    const permissionCount = adminAccessProfile.isSuperAdmin ? allAdminPermissions.length : adminPermissionsSet.size;
    const customRoleCount = adminRolesCache.filter((role) => !role.isSystem).length;

    wrap.innerHTML = `
        <div class="rounded-box border border-base-300 bg-base-100/90 px-5 py-5">
            <div class="text-sm text-base-content/60">当前账号</div>
            <div class="text-xl font-bold mt-2">${escapeHtml(adminAccessProfile.adminRoleName || adminAccessProfile.adminRoleCode || '管理员')}</div>
            <div class="text-sm text-base-content/65 mt-2">角色编码：${escapeHtml(adminAccessProfile.adminRoleCode || '-')}</div>
            <div class="flex flex-wrap gap-2 mt-4">
                <span class="badge ${adminAccessProfile.isSuperAdmin ? 'badge-primary' : 'badge-outline'}">${adminAccessProfile.isSuperAdmin ? '超级管理员' : '受限角色'}</span>
                <span class="badge badge-ghost">权限 ${permissionCount} 项</span>
            </div>
        </div>
        <div class="rounded-box border border-base-300 bg-base-100/90 px-5 py-5">
            <div class="text-sm text-base-content/60">菜单可见范围</div>
            <div class="text-xl font-bold mt-2">${visibleSections.length} 个模块</div>
            <div class="text-sm text-base-content/65 mt-2 leading-6">${visibleSections.map((section) => escapeHtml(ADMIN_SECTION_META[section].title)).join('、') || '暂无'}</div>
        </div>
        <div class="rounded-box border border-base-300 bg-base-100/90 px-5 py-5">
            <div class="text-sm text-base-content/60">角色 / 管理员规模</div>
            <div class="text-xl font-bold mt-2">${adminRolesCache.length} 个角色</div>
            <div class="text-sm text-base-content/65 mt-2 leading-6">管理员 ${adminAdminsCache.length} 人，自定义角色 ${customRoleCount} 个。</div>
        </div>
    `;
}

async function loadAdminAccessProfile(forceRefresh = false) {
    if (adminAccessProfile && !forceRefresh) return adminAccessProfile;

    const res = await Auth.apiFetch('/api/admin/admin-access/me', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-store' }
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || '加载管理员权限信息失败');
    }

    adminAccessProfile = data.access || {};
    adminPermissionGroups = Array.isArray(data.permissionGroups) ? data.permissionGroups : [];
    allAdminPermissions = Array.isArray(data.allPermissions) && data.allPermissions.length
        ? data.allPermissions
        : getDefaultMenuPermissions();
    adminPermissionsSet = new Set(
        adminAccessProfile.isSuperAdmin
            ? allAdminPermissions
            : (Array.isArray(adminAccessProfile.permissions) ? adminAccessProfile.permissions : [])
    );
    return adminAccessProfile;
}

async function loadAdminRoles(forceRefresh = false) {
    if (!forceRefresh && adminRolesCache.length) return adminRolesCache;

    const res = await Auth.apiFetch('/api/admin/admin-access/roles', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-store' }
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || '加载管理员角色失败');
    }

    adminRolesCache = Array.isArray(data.roles) ? data.roles : [];
    if (Array.isArray(data.permissionGroups) && data.permissionGroups.length) {
        adminPermissionGroups = data.permissionGroups;
    }
    if (Array.isArray(data.allPermissions) && data.allPermissions.length) {
        allAdminPermissions = data.allPermissions;
    }

    if (adminRoleEditorId && !adminRolesCache.some((role) => Number(role.id) === Number(adminRoleEditorId))) {
        adminRoleEditorId = null;
        adminRoleEditingSnapshot = null;
    }

    return adminRolesCache;
}

async function loadAdminAdmins(forceRefresh = false) {
    if (!forceRefresh && adminAdminsCache.length) return adminAdminsCache;

    const res = await Auth.apiFetch('/api/admin/admin-access/admins', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-store' }
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || '加载管理员列表失败');
    }

    adminAdminsCache = Array.isArray(data.admins) ? data.admins : [];
    return adminAdminsCache;
}

function renderAdminRolesList() {
    const listEl = document.getElementById('admin-role-list');
    if (!listEl) return;

    if (!adminRolesCache.length) {
        listEl.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">暂无角色数据。</div>';
        return;
    }

    listEl.innerHTML = adminRolesCache.map((role) => {
        const selected = Number(adminRoleEditorId) === Number(role.id);
        const permissionCount = Array.isArray(role.permissions) ? role.permissions.length : 0;
        return `
            <div class="rounded-box border ${selected ? 'border-primary bg-primary/5' : 'border-base-300 bg-base-100'} px-4 py-4">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <div class="text-base font-semibold">${escapeHtml(role.name)}</div>
                        <div class="text-xs text-base-content/55 mt-1">${escapeHtml(role.code)}</div>
                    </div>
                    <div class="flex flex-wrap gap-2 justify-end">
                        <span class="badge ${role.isSystem ? 'badge-outline' : 'badge-secondary badge-outline'}">${role.isSystem ? '系统角色' : '自定义角色'}</span>
                        <span class="badge badge-ghost">${permissionCount} 项权限</span>
                    </div>
                </div>
                <div class="text-sm text-base-content/65 mt-3 leading-6">${escapeHtml(role.description || '未填写角色说明')}</div>
                <div class="flex flex-wrap gap-2 mt-4">${renderAdminPermissionBadges(role.permissions || [], 4)}</div>
                <div class="flex flex-wrap gap-2 mt-4">
                    <button class="btn btn-sm ${selected ? 'btn-primary' : 'btn-outline'}" onclick="selectAdminRole(${role.id})">${selected ? '正在查看' : '查看角色'}</button>
                    ${role.isSystem ? '<span class="text-xs text-base-content/50 flex items-center">系统角色只读</span>' : `<button class="btn btn-ghost btn-sm text-error" onclick="deleteAdminRole(${role.id})">删除</button>`}
                </div>
            </div>
        `;
    }).join('');
}

function renderAdminRolePermissionChecklist(selectedPermissions = [], disabled = false) {
    const wrap = document.getElementById('admin-role-permissions');
    if (!wrap) return;

    const selectedSet = new Set(Array.isArray(selectedPermissions) ? selectedPermissions : []);
    wrap.innerHTML = (adminPermissionGroups || []).map((group) => `
        <div class="rounded-box border border-base-300 bg-base-100 px-4 py-4">
            <div class="font-semibold">${escapeHtml(group.label || group.key || '权限组')}</div>
            <div class="text-xs text-base-content/55 mt-1">建议按业务域收敛授权，避免给不必要的后台入口。</div>
            <div class="space-y-3 mt-4">
                ${(group.permissions || []).map((permission) => `
                    <label class="flex items-start gap-3 rounded-box border border-base-300/70 px-3 py-3 cursor-pointer ${disabled ? 'opacity-70 cursor-not-allowed' : 'hover:border-primary/40'}">
                        <input
                            type="checkbox"
                            class="checkbox checkbox-sm checkbox-primary mt-0.5"
                            data-admin-permission-key="${escapeHtml(permission.key)}"
                            ${selectedSet.has(permission.key) ? 'checked' : ''}
                            ${disabled ? 'disabled' : ''}
                        >
                        <span class="min-w-0">
                            <span class="block font-medium">${escapeHtml(permission.label || permission.key)}</span>
                            <span class="block text-xs text-base-content/60 mt-1 leading-6">${escapeHtml(permission.description || '')}</span>
                        </span>
                    </label>
                `).join('')}
            </div>
        </div>
    `).join('');
}

function setAdminRoleEditorResult(message, tone = 'muted') {
    const el = document.getElementById('admin-role-editor-result');
    if (!el) return;
    const toneClass = tone === 'error'
        ? 'text-error'
        : tone === 'success'
            ? 'text-success'
            : 'text-base-content/60';
    el.className = `mt-3 text-sm ${toneClass}`;
    el.textContent = message;
}

function openAdminRoleCreateForm() {
    adminRoleEditorId = null;
    adminRoleEditingSnapshot = null;
    renderAdminRolesList();
    renderAdminRoleEditor();
}

function selectAdminRole(roleId) {
    adminRoleEditorId = Number(roleId);
    adminRoleEditingSnapshot = null;
    renderAdminRolesList();
    renderAdminRoleEditor();
}

function resetAdminRoleEditor() {
    renderAdminRoleEditor();
}

function collectAdminRoleFormPayload() {
    const code = document.getElementById('admin-role-code')?.value.trim() || '';
    const name = document.getElementById('admin-role-name')?.value.trim() || '';
    const description = document.getElementById('admin-role-description')?.value.trim() || '';
    const permissions = Array.from(document.querySelectorAll('#admin-role-permissions input[data-admin-permission-key]:checked'))
        .map((input) => input.dataset.adminPermissionKey)
        .filter(Boolean);
    return { code, name, description, permissions };
}

function renderAdminRoleEditor() {
    const role = adminRolesCache.find((item) => Number(item.id) === Number(adminRoleEditorId)) || null;
    const isCreateMode = !role;
    const isSystemRole = Boolean(role?.isSystem);

    const titleEl = document.getElementById('admin-role-editor-title');
    const descEl = document.getElementById('admin-role-editor-desc');
    const codeInput = document.getElementById('admin-role-code');
    const nameInput = document.getElementById('admin-role-name');
    const descriptionInput = document.getElementById('admin-role-description');
    const saveBtn = document.getElementById('admin-role-save-btn');
    const deleteBtn = document.getElementById('admin-role-delete-btn');

    if (titleEl) titleEl.textContent = isCreateMode ? '新建自定义角色' : `角色编辑：${role.name}`;
    if (descEl) {
        descEl.textContent = isCreateMode
            ? '角色编码创建后固定，建议使用英文下划线命名。'
            : (isSystemRole ? '系统角色只读，用于保障基础后台职责分工。' : '仅支持修改角色名称、说明与权限项，角色编码创建后固定。');
    }
    if (codeInput) {
        codeInput.value = isCreateMode ? '' : (role.code || '');
        codeInput.disabled = !isCreateMode;
    }
    if (nameInput) {
        nameInput.value = isCreateMode ? '' : (role.name || '');
        nameInput.disabled = isSystemRole;
    }
    if (descriptionInput) {
        descriptionInput.value = isCreateMode ? '' : (role.description || '');
        descriptionInput.disabled = isSystemRole;
    }

    renderAdminRolePermissionChecklist(role?.permissions || [], isSystemRole);

    if (saveBtn) {
        saveBtn.textContent = isCreateMode ? '创建角色' : '保存角色';
        saveBtn.disabled = isSystemRole;
    }
    if (deleteBtn) {
        deleteBtn.style.display = !isCreateMode && !isSystemRole ? '' : 'none';
    }

    setAdminRoleEditorResult(
        isCreateMode
            ? '可创建新的自定义角色，并为其勾选后台菜单与接口权限。'
            : (isSystemRole ? '系统角色不允许修改或删除，可用于对照权限边界。' : '修改后会立即影响绑定该角色的管理员可见菜单与可调接口。'),
        'muted'
    );
}

async function saveAdminRole() {
    const role = adminRolesCache.find((item) => Number(item.id) === Number(adminRoleEditorId)) || null;
    if (role?.isSystem) {
        alert('系统角色不允许修改');
        return;
    }

    const payload = collectAdminRoleFormPayload();
    if (!payload.name) {
        alert('请填写角色名称');
        return;
    }
    if (!payload.permissions.length) {
        alert('请至少选择一个权限');
        return;
    }
    if (!role && !payload.code) {
        alert('请填写角色编码');
        return;
    }

    setAdminRoleEditorResult('正在保存角色...', 'muted');
    const url = role ? `/api/admin/admin-access/roles/${role.id}` : '/api/admin/admin-access/roles';
    const method = role ? 'PUT' : 'POST';
    const requestBody = role
        ? { name: payload.name, description: payload.description, permissions: payload.permissions }
        : payload;

    try {
        const res = await Auth.apiFetch(url, {
            method,
            body: JSON.stringify(requestBody)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '保存角色失败');

        adminRoleEditorId = data.role?.id || role?.id || null;
        await Promise.all([loadAdminRoles(true), loadAdminAdmins(true)]);
        renderAdminRolesList();
        renderAdminAdminsTable();
        renderAdminAccessSummary();
        renderAdminRoleEditor();
        setAdminRoleEditorResult(data.message || '角色已保存', 'success');
    } catch (err) {
        console.error('Save admin role error:', err);
        setAdminRoleEditorResult(err.message || '保存角色失败', 'error');
        alert(err.message || '保存角色失败');
    }
}

async function deleteAdminRole(roleId = null) {
    const targetId = roleId ? Number(roleId) : Number(adminRoleEditorId);
    const role = adminRolesCache.find((item) => Number(item.id) === targetId);
    if (!role) {
        alert('未找到待删除角色');
        return;
    }
    if (role.isSystem) {
        alert('系统角色不允许删除');
        return;
    }
    if (!confirm(`确认删除角色「${role.name}」吗？`)) {
        return;
    }

    try {
        const res = await Auth.apiFetch(`/api/admin/admin-access/roles/${targetId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '删除角色失败');

        if (Number(adminRoleEditorId) === targetId) {
            adminRoleEditorId = null;
        }
        await Promise.all([loadAdminRoles(true), loadAdminAdmins(true)]);
        renderAdminRolesList();
        renderAdminAdminsTable();
        renderAdminAccessSummary();
        renderAdminRoleEditor();
        alert(data.message || '角色已删除');
    } catch (err) {
        console.error('Delete admin role error:', err);
        alert(err.message || '删除角色失败');
    }
}

function renderAdminAdminsTable() {
    const wrap = document.getElementById('admin-admins-table-wrap');
    if (!wrap) return;

    if (!adminAdminsCache.length) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">当前还没有管理员账号。</div>';
        return;
    }

    wrap.innerHTML = `
        <table class="table table-sm md:table-md">
            <thead>
                <tr>
                    <th>账号</th>
                    <th>当前角色</th>
                    <th>权限摘要</th>
                    <th>状态</th>
                    <th>最近登录</th>
                    <th>重绑角色</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
                ${adminAdminsCache.map((admin) => {
        const isSelf = Number(admin.id) === Number(adminAccessProfile?.userId);
        const roleBadgeClass = admin.source === 'legacy_fallback' ? 'badge-warning badge-outline' : 'badge-primary badge-outline';
        return `
                        <tr>
                            <td>
                                <div class="font-semibold">${escapeHtml(admin.nickname || admin.username || '-')}</div>
                                <div class="text-xs text-base-content/55 mt-1">${escapeHtml(admin.username || '-')} · ${escapeHtml(admin.email || '未绑定邮箱')}</div>
                            </td>
                            <td>
                                <div class="flex flex-wrap gap-2">
                                    <span class="badge ${roleBadgeClass}">${escapeHtml(admin.roleName || admin.roleCode || '未绑定角色')}</span>
                                    ${isSelf ? '<span class="badge badge-ghost">当前登录</span>' : ''}
                                </div>
                                <div class="text-xs text-base-content/55 mt-2 leading-6">${escapeHtml(admin.roleDescription || '暂无角色说明')}</div>
                            </td>
                            <td><div class="flex flex-wrap gap-2">${renderAdminPermissionBadges(admin.permissions || [], 3)}</div></td>
                            <td><span class="badge ${admin.status === 'active' ? 'badge-success' : 'badge-error'} badge-outline">${admin.status === 'active' ? '正常' : '禁用'}</span></td>
                            <td class="text-xs leading-6">${formatAdminAccessTime(admin.lastLoginAt)}</td>
                            <td>
                                <select id="admin-role-select-${admin.id}" class="select select-bordered select-sm w-full min-w-[14rem]" ${isSelf ? 'disabled' : ''}>
                                    ${getAdminRoleOptionsHtml(admin.roleId, true)}
                                </select>
                            </td>
                            <td>
                                <div class="flex flex-wrap gap-2">
                                    <button class="btn btn-primary btn-xs" onclick="assignAdminRoleToUser(${admin.id})" ${isSelf ? 'disabled' : ''}>保存角色</button>
                                    <button class="btn btn-outline btn-error btn-xs" onclick="revokeAdminUser(${admin.id})" ${isSelf ? 'disabled' : ''}>移除管理员</button>
                                </div>
                            </td>
                        </tr>
                    `;
    }).join('')}
            </tbody>
        </table>
    `;
}

function renderAdminCandidates() {
    const wrap = document.getElementById('admin-candidates-results');
    if (!wrap) return;

    if (!adminCandidatesCache.length) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">未找到匹配用户。</div>';
        return;
    }

    wrap.innerHTML = `
        <table class="table table-sm md:table-md">
            <thead>
                <tr>
                    <th>候选用户</th>
                    <th>当前状态</th>
                    <th>分配角色</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
                ${adminCandidatesCache.map((user) => {
        const isSelf = Number(user.id) === Number(adminAccessProfile?.userId);
        const alreadyAdmin = user.role === 'admin';
        return `
                        <tr>
                            <td>
                                <div class="font-semibold">${escapeHtml(user.nickname || user.username || '-')}</div>
                                <div class="text-xs text-base-content/55 mt-1">${escapeHtml(user.username || '-')} · ${escapeHtml(user.email || '未绑定邮箱')}</div>
                            </td>
                            <td>
                                <div class="flex flex-wrap gap-2">
                                    <span class="badge ${alreadyAdmin ? 'badge-primary badge-outline' : 'badge-ghost'}">${alreadyAdmin ? '已是管理员' : '普通用户'}</span>
                                    <span class="badge ${user.status === 'active' ? 'badge-success' : 'badge-error'} badge-outline">${user.status === 'active' ? '正常' : '禁用'}</span>
                                </div>
                                <div class="text-xs text-base-content/55 mt-2">${escapeHtml(user.adminRoleName || (alreadyAdmin ? '历史管理员 / 未绑定角色' : '未分配后台角色'))}</div>
                            </td>
                            <td>
                                <select id="candidate-role-select-${user.id}" class="select select-bordered select-sm w-full min-w-[14rem]" ${isSelf ? 'disabled' : ''}>
                                    ${getAdminRoleOptionsHtml(null, true)}
                                </select>
                            </td>
                            <td>
                                <button class="btn btn-primary btn-xs" onclick="assignAdminRoleToUser(${user.id}, 'candidate')" ${isSelf ? 'disabled' : ''}>${alreadyAdmin ? '更新角色' : '设为管理员'}</button>
                            </td>
                        </tr>
                    `;
    }).join('')}
            </tbody>
        </table>
    `;
}

async function assignAdminRoleToUser(userId, source = 'admin') {
    const selectId = source === 'candidate' ? `candidate-role-select-${userId}` : `admin-role-select-${userId}`;
    const selectEl = document.getElementById(selectId);
    const roleId = Number(selectEl?.value || 0);
    if (!roleId) {
        alert('请选择要分配的角色');
        return;
    }

    try {
        const res = await Auth.apiFetch(`/api/admin/admin-access/admins/${userId}`, {
            method: 'PUT',
            body: JSON.stringify({ roleId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '分配管理员角色失败');

        await Promise.all([loadAdminAdmins(true), loadAdminRoles(true)]);
        renderAdminAdminsTable();
        renderAdminRolesList();
        renderAdminAccessSummary();
        if (source === 'candidate' && adminCandidatesCache.length) {
            renderAdminCandidates();
        }
        alert(data.message || '管理员角色已分配');
    } catch (err) {
        console.error('Assign admin role error:', err);
        alert(err.message || '分配管理员角色失败');
    }
}

async function revokeAdminUser(userId) {
    const target = adminAdminsCache.find((admin) => Number(admin.id) === Number(userId));
    if (!target) {
        alert('未找到目标管理员');
        return;
    }
    if (!confirm(`确认移除管理员「${target.nickname || target.username}」吗？`)) {
        return;
    }

    try {
        const res = await Auth.apiFetch(`/api/admin/admin-access/admins/${userId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '移除管理员失败');

        await loadAdminAdmins(true);
        renderAdminAdminsTable();
        renderAdminAccessSummary();
        alert(data.message || '管理员权限已移除');
    } catch (err) {
        console.error('Revoke admin user error:', err);
        alert(err.message || '移除管理员失败');
    }
}

async function searchAdminAccessCandidates() {
    const keywordInput = document.getElementById('admin-candidate-keyword');
    const keyword = keywordInput?.value.trim() || '';
    const wrap = document.getElementById('admin-candidates-results');
    if (!keyword) {
        clearAdminAccessCandidates();
        return;
    }

    if (wrap) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">正在搜索候选用户...</div>';
    }

    try {
        const res = await Auth.apiFetch(`/api/admin/admin-access/candidates?keyword=${encodeURIComponent(keyword)}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-store' }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '搜索候选用户失败');

        adminCandidatesCache = Array.isArray(data.candidates) ? data.candidates : [];
        renderAdminCandidates();
    } catch (err) {
        console.error('Search admin candidates error:', err);
        if (wrap) {
            wrap.innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-5 py-8 text-sm text-error">${escapeHtml(err.message || '搜索候选用户失败')}</div>`;
        }
    }
}

function clearAdminAccessCandidates() {
    adminCandidatesCache = [];
    const keywordInput = document.getElementById('admin-candidate-keyword');
    if (keywordInput) keywordInput.value = '';
    const wrap = document.getElementById('admin-candidates-results');
    if (wrap) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">输入关键词后可搜索待分配管理员的用户。</div>';
    }
}

async function loadAdminAccessSection(forceRefresh = false) {
    const adminsWrap = document.getElementById('admin-admins-table-wrap');
    const rolesWrap = document.getElementById('admin-role-list');
    if (adminsWrap && (forceRefresh || !adminAdminsCache.length)) {
        adminsWrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">正在加载管理员列表...</div>';
    }
    if (rolesWrap && (forceRefresh || !adminRolesCache.length)) {
        rolesWrap.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-8 text-sm text-base-content/60">正在加载角色列表...</div>';
    }

    try {
        await Promise.all([
            loadAdminAccessProfile(forceRefresh),
            loadAdminRoles(forceRefresh),
            loadAdminAdmins(forceRefresh),
        ]);
        if (!adminRoleEditorId && adminRolesCache.length) {
            adminRoleEditorId = adminRolesCache.find((role) => !role.isSystem)?.id || adminRolesCache[0].id;
        }
        renderAdminAccessSummary();
        renderAdminRolesList();
        renderAdminAdminsTable();
        renderAdminRoleEditor();
    } catch (err) {
        console.error('Load admin access section error:', err);
        const summary = document.getElementById('admin-access-summary');
        if (summary) {
            summary.innerHTML = `<div class="rounded-box border border-error/20 bg-error/10 px-5 py-5 text-sm text-error">${escapeHtml(err.message || '加载管理员管理数据失败')}</div>`;
        }
        if (adminsWrap) {
            adminsWrap.innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-5 py-8 text-sm text-error">${escapeHtml(err.message || '加载管理员列表失败')}</div>`;
        }
        if (rolesWrap) {
            rolesWrap.innerHTML = `<div class="rounded-box bg-error/10 border border-error/20 px-5 py-8 text-sm text-error">${escapeHtml(err.message || '加载角色列表失败')}</div>`;
        }
    }
}
