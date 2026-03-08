// admin.js - Admin panel logic

document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAdmin()) return;
    Auth.updateNavbar();
    loadOverviewStats();
});

let currentSection = 'overview';
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

function showSection(name) {
    currentSection = name;
    document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
    document.getElementById(`sec-${name}`).classList.remove('hidden');
    document.querySelectorAll('#sidebar-menu a').forEach(a => a.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');

    const titles = {
        overview: '系统概览', users: '用户管理', orders: '订单管理', payment: '支付管理', notifications: '通知系统', plans: '套餐设置',
        gifts: '礼物配置', settings: '系统设置', sessionMaintenance: '场次运维', smtpServices: '邮箱服务', aiWork: 'AI工作中心', prompts: '提示词管理', docs: '系统文档', eulerKeys: 'Euler API Keys', aiModels: 'AI 通道配置'
    };
    document.getElementById('section-title').textContent = titles[name] || name;

    if (name === 'overview') loadOverviewStats();
    else if (name === 'users') loadUsers(1);
    else if (name === 'orders') loadAdminOrders(1);
    else if (name === 'payment') loadPaymentConfig();
    else if (name === 'notifications') loadNotificationConfig();
    else if (name === 'plans') { loadPlans(); loadAddons(); loadAiCreditPackages(); }
    else if (name === 'gifts') loadAdminGiftConfig();
    else if (name === 'settings') loadSettingsForm();
    else if (name === 'sessionMaintenance') loadSessionMaintenanceSection();
    else if (name === 'smtpServices') loadSmtpServices();
    else if (name === 'aiWork') loadAdminAiWorkJobs(1);
    else if (name === 'prompts') loadPromptTemplates();
    else if (name === 'docs') loadAdminDocs();
    else if (name === 'eulerKeys') loadEulerKeys();
    else if (name === 'aiModels') loadAiModels();
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

async function showUserDetail(userId) {
    try {
        currentAdminUserDetailId = userId;
        const res = await Auth.apiFetch(`/api/admin/users/${userId}`);
        const data = await res.json();
        const u = data.user;
        const quota = data.quota || {};
        const roomOverride = quota.quotaOverrides?.roomLimit || {};
        const dailyOverride = quota.quotaOverrides?.dailyCreateLimit || {};
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
            ${data.subscriptions.map(s => `<tr><td>${escapeHtml(s.planName)}</td><td>${escapeHtml(s.billingCycle)}</td><td>${new Date(s.startAt).toLocaleDateString('zh-CN')}</td><td>${new Date(s.endAt).toLocaleDateString('zh-CN')}</td><td><span class="badge badge-xs ${s.status === 'active' ? 'badge-success' : 'badge-ghost'}">${escapeHtml(s.status)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="text-center">无</td></tr>'}
            </tbody></table></div>
            <div class="divider">房间</div>
            <div class="flex flex-wrap gap-2">
            ${data.rooms.map(r => `<span class="badge badge-outline">${escapeHtml(r.roomName || r.roomId)}</span>`).join('') || '<span class="text-base-content/60">无</span>'}
            </div>`;

        document.getElementById('userDetailModal').showModal();
    } catch (err) { console.error('User detail error:', err); }
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
        const openText = (p.openRoomLimit == null || p.openRoomLimit === -1) ? '不限' : p.openRoomLimit;
        const dailyText = p.dailyRoomCreateLimit === -1 ? '无限' : (p.dailyRoomCreateLimit || '无限');
        return `
        <div class="card bg-base-100 border ${p.isActive ? 'border-base-300' : 'border-error opacity-60'}">
            <div class="card-body p-4">
                <div class="flex justify-between items-start">
                    <div>
                        <h4 class="font-bold">${p.name} <span class="text-xs text-base-content/60">(${p.code})</span></h4>
                        <p class="text-sm">房间: ${roomText} | 可打开: ${openText} | 每日新建: ${dailyText} | AI: ${p.aiCreditsMonthly || 0}点/月 | 月¥${p.priceMonthly} / 季¥${p.priceQuarterly} / 年¥${p.priceAnnual}</p>
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
    document.getElementById('pf-open-room').value = plan?.openRoomLimit ?? -1;
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
        openRoomLimit: parseIntOr('pf-open-room', -1),
        dailyRoomCreateLimit: parseIntOr('pf-daily', -1),
        aiCreditsMonthly: parseIntOr('pf-ai', 0),
        priceMonthly: parseFloatOr('pf-pm', 0),
        priceQuarterly: parseFloatOr('pf-pq', 0),
        priceAnnual: parseFloatOr('pf-py', 0),
        sortOrder: parseIntOr('pf-sort', 0),
        featureFlags,
    };

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
                        <p class="text-sm">+${a.roomCount}房间 | ¥${a.price}</p>
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
    document.getElementById('af-price').value = addon?.price || '';
    document.getElementById('af-desc').value = addon?.description || '';
    document.getElementById('addonFormModal').showModal();
}

function editAddon(addon) { showAddonForm(addon); }

async function submitAddonForm() {
    const id = document.getElementById('af-id').value;
    const body = {
        name: document.getElementById('af-name').value,
        roomCount: parseInt(document.getElementById('af-count').value),
        price: parseFloat(document.getElementById('af-price').value),
        description: document.getElementById('af-desc').value,
    };

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
const settingDefs = [
    { key: 'scan_interval', label: '扫描间隔 (分钟)', type: 'number' },
    { key: 'auto_monitor_enabled', label: '自动监控', type: 'toggle' },
    { key: 'proxy_url', label: '代理地址', type: 'text' },
    { key: 'session_id', label: 'TikTok Session ID', type: 'text' },
    { key: 'port', label: '服务端口 (需重启)', type: 'number' },
    { key: 'dynamic_tunnel_proxy', label: '动态隧道代理', type: 'text' },
    { key: 'proxy_api_url', label: '代理API地址', type: 'text' },
    { key: 'default_room_limit', label: '默认房间上限 (未订阅, -1无限)', type: 'number' },
    { key: 'min_recharge_amount', label: '最低充值金额', type: 'number' },
    { key: 'site_name', label: '网站名称', type: 'text' },
    // 注册赠送设置
    { key: 'gift_room_limit', label: '注册赠送房间数 (空=不送)', type: 'number' },
    { key: 'gift_open_room_limit', label: '赠送可打开房间数 (空=同房间数)', type: 'number' },
    { key: 'gift_duration_days', label: '注册赠送天数 (空=不送)', type: 'number' },
];

const authSettingDefs = [
    { key: 'single_session_login_enabled', label: '单点登录（新登录踢掉旧登录）', type: 'toggle' },
];

async function loadSettingsForm() {
    const res = await Auth.apiFetch('/api/admin/settings');
    const data = await res.json();
    const settings = data.settings || {};
    const form = document.getElementById('settings-form');

    function renderSettingFields(defs) {
        return defs.map(d => {
            const val = settings[d.key] !== undefined ? settings[d.key] : '';
            if (d.type === 'toggle') {
                return `<div class="form-control"><label class="label cursor-pointer justify-start gap-4">
                    <span class="label-text w-48">${d.label}</span>
                    <input type="checkbox" class="toggle toggle-primary" data-key="${d.key}" ${val === true || val === 'true' || val === 1 ? 'checked' : ''}>
                </label></div>`;
            }
            return `<div class="form-control"><label class="label"><span class="label-text">${d.label}</span></label>
                <input type="${d.type === 'number' ? 'number' : 'text'}" class="input input-bordered" data-key="${d.key}" value="${val}" placeholder="${d.placeholder || ''}">
            </div>`;
        }).join('');
    }

    form.innerHTML = `
        <h4 class="text-lg font-bold mb-2">基础设置</h4>
        ${renderSettingFields(settingDefs)}
        <div class="divider"></div>
        <h4 class="text-lg font-bold mb-2">登录与安全</h4>
        <p class="text-sm text-base-content/60 mb-3">开启后，同一账号再次登录会让旧登录立即失效。</p>
        ${renderSettingFields(authSettingDefs)}
    `;
}

async function saveSettings() {
    const settings = {};
    document.querySelectorAll('#settings-form [data-key]').forEach(el => {
        const key = el.dataset.key;
        if (el.type === 'checkbox') settings[key] = el.checked;
        else settings[key] = el.value;
    });

    const res = await Auth.apiFetch('/api/admin/settings', {
        method: 'PUT', body: JSON.stringify({ settings })
    });
    const data = await res.json();
    if (res.ok) alert(data.message);
    else alert(data.error || '保存失败');
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
                            <label class="label cursor-pointer justify-start gap-4 rounded-2xl border border-base-300 bg-base-100 px-4 py-3">
                                <input type="checkbox" class="toggle toggle-primary" data-session-maintenance-key="${field.key}" ${value ? 'checked' : ''}>
                                <span class="flex-1">
                                    <span class="block font-medium">${escapeHtml(field.label)}</span>
                                    <span class="block text-xs text-base-content/60 mt-1 leading-6">${escapeHtml(field.hint || '')}</span>
                                </span>
                            </label>
                        `;
                    }
                    return `
                        <label class="form-control rounded-2xl border border-base-300 bg-base-100 px-4 py-3">
                            <span class="label-text font-medium">${escapeHtml(field.label)}</span>
                            <input
                                type="number"
                                class="input input-bordered mt-2"
                                data-session-maintenance-key="${field.key}"
                                min="${field.min ?? ''}"
                                step="${field.step ?? 1}"
                                value="${escapeHtml(value)}"
                            >
                            <span class="label-text-alt text-base-content/60 mt-2 leading-6">${escapeHtml(field.hint || '')}</span>
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
    { key: 'name', label: '服务名称', type: 'text', placeholder: '主邮箱服务 / QQ 邮箱' },
    { key: 'host', label: 'SMTP 服务器', type: 'text', placeholder: 'smtp.qq.com' },
    { key: 'port', label: 'SMTP 端口', type: 'number', placeholder: '465' },
    { key: 'secure', label: 'SSL/TLS', type: 'toggle' },
    { key: 'username', label: 'SMTP 用户名', type: 'text', placeholder: 'your@email.com' },
    { key: 'password', label: 'SMTP 密码/授权码', type: 'password', placeholder: '授权码' },
    { key: 'fromEmail', label: '发件人地址', type: 'text', placeholder: '留空则使用 SMTP 用户名' },
    { key: 'fromName', label: '发件人名称', type: 'text', placeholder: 'TikTok Monitor' },
    { key: 'isActive', label: '启用该邮箱服务', type: 'toggle' },
    { key: 'setAsDefault', label: '保存后设为默认', type: 'toggle', createOnly: true },
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

    formEl.innerHTML = `
        <div class="form-control">
            <label class="label cursor-pointer justify-start gap-4">
                <span class="label-text w-44">注册邮箱验证</span>
                <input type="checkbox" id="smtp-email-verification-enabled" class="toggle toggle-primary" ${smtpEmailSettings.emailVerificationEnabled ? 'checked' : ''}>
            </label>
            <label class="label pt-2">
                <span class="label-text-alt text-base-content/55">关闭后，注册流程不再要求邮箱验证码；邮件服务仍可用于找回密码和改绑邮箱。</span>
            </label>
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
                            <span class="label-text flex-1">${escapeHtml(field.label)}</span>
                            <input type="checkbox" class="toggle toggle-primary" data-key="${escapeHtml(field.key)}" ${checked ? 'checked' : ''}>
                        </label>
                    </div>
                `;
            }

            return `
                <div class="form-control">
                    <label class="label"><span class="label-text">${escapeHtml(field.label)}</span></label>
                    <input
                        type="${field.type === 'password' ? 'password' : (field.type === 'number' ? 'number' : 'text')}"
                        class="input input-bordered"
                        data-key="${escapeHtml(field.key)}"
                        value="${escapeHtml(value)}"
                        placeholder="${escapeHtml(field.placeholder || '')}"
                    >
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

function formatAdminAiWorkDateTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(String(value));
    return date.toLocaleString('zh-CN');
}

async function loadAdminAiWorkJobs(page = 1) {
    aiWorkAdminPage = page;
    const tbody = document.getElementById('admin-ai-work-tbody');
    if (!tbody) return;

    const status = document.getElementById('admin-ai-work-status')?.value || '';
    const search = document.getElementById('admin-ai-work-search')?.value?.trim() || '';
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-base-content/60">正在加载 AI 工作任务...</td></tr>';

    try {
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (status) params.set('status', status);
        if (search) params.set('search', search);
        const res = await Auth.apiFetch(`/api/admin/ai-work/jobs?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '加载 AI 工作任务失败');

        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        if (!jobs.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-base-content/60">暂无 AI 工作任务</td></tr>';
        } else {
            tbody.innerHTML = jobs.map(job => `
                <tr>
                    <td>${Number(job.id || 0)}</td>
                    <td>${formatAdminAiWorkStatusBadge(job.status)}</td>
                    <td>${escapeHtml(job.nickname || job.username || '-')}</td>
                    <td>
                        <div class="font-semibold">${escapeHtml(job.roomId || '-')}</div>
                        <div class="text-xs text-base-content/55 mt-1">${escapeHtml(job.sessionId || '-')}</div>
                    </td>
                    <td>
                        <div>${escapeHtml(job.currentStep || '-')}</div>
                        <div class="text-xs text-base-content/55 mt-1">进度 ${Number(job.progressPercent || 0)}%</div>
                    </td>
                    <td>${escapeHtml(job.modelName || '-')}</td>
                    <td class="text-xs">${formatAdminAiWorkDateTime(job.createdAt)}</td>
                    <td><button class="btn btn-xs btn-outline" onclick="loadAdminAiWorkJobDetail(${Number(job.id || 0)})">详情</button></td>
                </tr>
            `).join('');
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
                    <span class="badge badge-ghost">通知 ${job.notificationSent ? '已发送' : '未发送'}</span>
                </div>
                <div class="rounded-box bg-base-200/70 p-4 text-sm leading-7">
                    <div><span class="font-semibold">标题：</span>${escapeHtml(job.title || '-')}</div>
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
        wrap.innerHTML = templates.map(item => `
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
                <div class="text-xs text-base-content/50 mb-3">可用变量：${(item.variables || []).map(v => `<code>${escapeHtml(`{{${v}}}`)}</code>`).join('、') || '无'}</div>
                <textarea id="prompt-template-${escapeHtml(item.key)}" class="textarea textarea-bordered w-full min-h-[22rem] font-mono text-xs leading-6">${escapeHtml(item.content || '')}</textarea>
                <div class="flex flex-wrap items-center gap-3 mt-4">
                    <button class="btn btn-primary btn-sm" onclick="savePromptTemplate('${escapeHtml(item.key)}')">保存提示词</button>
                    <button class="btn btn-outline btn-sm" onclick="resetPromptTemplate('${escapeHtml(item.key)}')">恢复默认</button>
                </div>
            </div>
        `).join('');
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
            input.addEventListener('keydown', function(e) {
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
async function loadEulerKeys() {
    try {
        const res = await Auth.apiFetch('/api/admin/euler-keys');
        const data = await res.json();
        const keys = data.keys || [];
        const container = document.getElementById('euler-keys-list');

        if (keys.length === 0) {
            container.innerHTML = '<p class="text-base-content/60">暂无 Euler API Key，点击右上方添加</p>';
            return;
        }

        container.innerHTML = keys.map(k => {
            const masked = k.keyValue ? k.keyValue.slice(0, 12) + '...' + k.keyValue.slice(-4) : '-';
            const statusBadge = k.lastStatus === 'ok'
                ? '<span class="badge badge-success badge-xs">正常</span>'
                : k.lastStatus === 'error'
                    ? '<span class="badge badge-error badge-xs">异常</span>'
                    : '<span class="badge badge-ghost badge-xs">未测试</span>';
            const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('zh-CN') : '从未';
            return `
            <div class="card bg-base-100 border ${k.isActive ? 'border-base-300' : 'border-error opacity-60'}">
                <div class="card-body p-4">
                    <div class="flex justify-between items-start flex-wrap gap-2">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                                <h4 class="font-bold">${k.name || '未命名'}</h4>
                                ${statusBadge}
                                ${!k.isActive ? '<span class="badge badge-error badge-xs">已禁用</span>' : ''}
                            </div>
                            <p class="text-sm font-mono text-base-content/60 mt-1">${masked}</p>
                            <div class="flex gap-4 mt-2 text-xs text-base-content/50">
                                <span>调用次数: <strong class="text-base-content">${k.callCount || 0}</strong></span>
                                <span>最后使用: ${lastUsed}</span>
                            </div>
                            ${k.lastError ? `<p class="text-xs text-error mt-1 truncate" title="${k.lastError}">${k.lastError}</p>` : ''}
                        </div>
                        <div class="flex gap-1 flex-shrink-0">
                            <button class="btn btn-xs btn-outline btn-info" onclick="testEulerKey(${k.id})">测试</button>
                            <button class="btn btn-xs btn-ghost" onclick="editEulerKey(${k.id}, '${(k.name || '').replace(/'/g, "\\'")}', ${k.isActive})">编辑</button>
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
    document.getElementById('ek-name').value = '';
    document.getElementById('ek-key').value = '';
    document.getElementById('eulerKeyModal').showModal();
}

async function submitEulerKey() {
    const keyValue = document.getElementById('ek-key').value.trim();
    const name = document.getElementById('ek-name').value.trim();
    if (!keyValue) { alert('请输入 API Key'); return; }

    const res = await Auth.apiFetch('/api/admin/euler-keys', {
        method: 'POST', body: JSON.stringify({ keyValue, name })
    });
    const data = await res.json();
    document.getElementById('eulerKeyModal').close();
    if (res.ok) { loadEulerKeys(); }
    else alert(data.error || '添加失败');
}

async function testEulerKey(id) {
    const btn = event.target;
    btn.classList.add('loading');
    try {
        const res = await Auth.apiFetch(`/api/admin/euler-keys/${id}/test`, { method: 'POST' });
        const data = await res.json();
        btn.classList.remove('loading');
        if (data.success) {
            alert(`测试成功! 延迟: ${data.latency}ms`);
        } else {
            alert(`测试失败: ${data.error || `HTTP ${data.status}`}`);
        }
        loadEulerKeys();
    } catch (err) {
        btn.classList.remove('loading');
        alert('请求失败: ' + err.message);
    }
}

function editEulerKey(id, name, isActive) {
    const newName = prompt('Key 名称:', name);
    if (newName === null) return;
    const toggle = confirm('是否启用此 Key？（确定=启用，取消=禁用）');
    Auth.apiFetch(`/api/admin/euler-keys/${id}`, {
        method: 'PUT', body: JSON.stringify({ name: newName, isActive: toggle })
    }).then(() => loadEulerKeys());
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
                        <div class="text-xs text-base-content/50 mt-0.5">ID: ${m.modelId} | 调用: ${m.callCount||0} | 成功率: ${successRate}% | 延迟: ${m.avgLatencyMs||'-'}ms</div>
                        ${m.lastError ? `<div class="text-xs text-error truncate">${m.lastError.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}
                    </div>
                    <div class="flex gap-1 flex-shrink-0 ml-2">
                        ${m.isDefault
                            ? '<button class="btn btn-xs btn-disabled">当前默认</button>'
                            : `<button class="btn btn-xs btn-outline btn-primary" onclick="setDefaultAiModel(${m.id})">设默认</button>`}
                        <button class="btn btn-xs btn-outline btn-info" onclick="testAiModel(${m.id})">测试</button>
                        <button class="btn btn-xs btn-ghost" onclick="editAiModelInline(${m.id}, '${(m.name||'').replace(/'/g,"\\'")}', '${(m.modelId||'').replace(/'/g,"\\'")}')">编辑</button>
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
                            <button class="btn btn-xs btn-primary btn-outline" onclick="showAddModelToChannel(${ch.id}, '${ch.name.replace(/'/g,"\\'")}')">添加模型</button>
                            <button class="btn btn-xs btn-ghost" onclick="editChannel(${ch.id}, '${(ch.name||'').replace(/'/g,"\\'")}', '${(ch.apiUrl||'').replace(/'/g,"\\'")}')">编辑</button>
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
                            <button class="btn btn-xs btn-ghost" onclick='editAiCreditPkg(${JSON.stringify(p).replace(/'/g,"&#39;")})'>编辑</button>
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
