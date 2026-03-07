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

function showSection(name) {
    currentSection = name;
    document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
    document.getElementById(`sec-${name}`).classList.remove('hidden');
    document.querySelectorAll('#sidebar-menu a').forEach(a => a.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');

    const titles = {
        overview: '系统概览', users: '用户管理', orders: '订单管理', payment: '支付管理', plans: '套餐设置',
        gifts: '礼物配置', settings: '系统设置', docs: '系统文档', eulerKeys: 'Euler API Keys', aiModels: 'AI 通道配置'
    };
    document.getElementById('section-title').textContent = titles[name] || name;

    if (name === 'overview') loadOverviewStats();
    else if (name === 'users') loadUsers(1);
    else if (name === 'orders') loadAdminOrders(1);
    else if (name === 'payment') loadPaymentConfig();
    else if (name === 'plans') { loadPlans(); loadAddons(); loadAiCreditPackages(); }
    else if (name === 'gifts') loadAdminGiftConfig();
    else if (name === 'settings') loadSettingsForm();
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

function showPlanForm(plan) {
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
    document.getElementById('planFormModal').showModal();
}

function editPlan(plan) { showPlanForm(plan); }

async function submitPlanForm() {
    const id = document.getElementById('pf-id').value;
    const body = {
        name: document.getElementById('pf-name').value,
        code: document.getElementById('pf-code').value,
        roomLimit: parseInt(document.getElementById('pf-room').value),
        openRoomLimit: parseInt(document.getElementById('pf-open-room').value) || -1,
        dailyRoomCreateLimit: parseInt(document.getElementById('pf-daily').value) || -1,
        aiCreditsMonthly: parseInt(document.getElementById('pf-ai').value) || 0,
        priceMonthly: parseFloat(document.getElementById('pf-pm').value),
        priceQuarterly: parseFloat(document.getElementById('pf-pq').value),
        priceAnnual: parseFloat(document.getElementById('pf-py').value),
        sortOrder: parseInt(document.getElementById('pf-sort').value) || 0,
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

// SMTP settings definitions (separate section)
const smtpSettingDefs = [
    { key: 'smtp_host', label: 'SMTP 服务器', type: 'text', placeholder: 'smtp.qq.com' },
    { key: 'smtp_port', label: 'SMTP 端口', type: 'number', placeholder: '465' },
    { key: 'smtp_secure', label: 'SSL/TLS', type: 'toggle' },
    { key: 'smtp_user', label: 'SMTP 用户名', type: 'text', placeholder: 'your@email.com' },
    { key: 'smtp_pass', label: 'SMTP 密码/授权码', type: 'text', placeholder: '授权码' },
    { key: 'smtp_from', label: '发件人地址', type: 'text', placeholder: '留空则使用用户名' },
    { key: 'smtp_from_name', label: '发件人名称', type: 'text', placeholder: 'TikTok Monitor' },
    { key: 'email_verification_enabled', label: '注册邮箱验证', type: 'toggle' },
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
        <h4 class="text-lg font-bold mb-2">邮箱 SMTP 配置</h4>
        <p class="text-sm text-base-content/60 mb-3">配置 SMTP 后可开启注册邮箱验证码功能</p>
        ${renderSettingFields(smtpSettingDefs)}
        <div class="flex gap-2 mt-3">
            <button class="btn btn-sm btn-outline" onclick="testSmtpConnection()">测试连接</button>
            <button class="btn btn-sm btn-outline" onclick="testSmtpSend()">发送测试邮件</button>
        </div>
        <div id="smtp-test-result" class="mt-2"></div>
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

// ==================== SMTP Test ====================
async function testSmtpConnection() {
    // Save settings first
    await saveSettings();
    const el = document.getElementById('smtp-test-result');
    el.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 测试中...';
    try {
        const res = await Auth.apiFetch('/api/admin/smtp/test', { method: 'POST' });
        const data = await res.json();
        el.innerHTML = data.success
            ? '<span class="text-success">SMTP 连接成功</span>'
            : `<span class="text-error">连接失败: ${data.error}</span>`;
    } catch (err) {
        el.innerHTML = `<span class="text-error">请求失败: ${err.message}</span>`;
    }
}

async function testSmtpSend() {
    const email = prompt('请输入接收测试邮件的邮箱地址:');
    if (!email) return;
    await saveSettings();
    const el = document.getElementById('smtp-test-result');
    el.innerHTML = '<span class="loading loading-spinner loading-sm"></span> 发送中...';
    try {
        const res = await Auth.apiFetch('/api/admin/smtp/test-send', {
            method: 'POST', body: JSON.stringify({ email })
        });
        const data = await res.json();
        el.innerHTML = data.success
            ? '<span class="text-success">测试邮件已发送</span>'
            : `<span class="text-error">发送失败: ${data.error}</span>`;
    } catch (err) {
        el.innerHTML = `<span class="text-error">请求失败: ${err.message}</span>`;
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
async function loadAiModels() {
    try {
        const res = await Auth.apiFetch('/api/admin/ai-channels');
        const data = await res.json();
        const channels = data.channels || [];
        const container = document.getElementById('ai-models-list');

        if (channels.length === 0) {
            container.innerHTML = '<p class="text-base-content/60">暂无 AI 通道，点击右上方添加</p>';
            return;
        }

        container.innerHTML = channels.map(ch => {
            const maskedKey = ch.apiKey ? ch.apiKey.slice(0, 8) + '...' + ch.apiKey.slice(-4) : '-';
            const modelsHtml = (ch.models || []).map(m => {
                const statusBadge = m.lastStatus === 'ok' ? '<span class="badge badge-success badge-xs">正常</span>'
                    : m.lastStatus === 'error' ? '<span class="badge badge-error badge-xs">异常</span>'
                    : '<span class="badge badge-ghost badge-xs">未测试</span>';
                const successRate = m.callCount > 0 ? Math.round((m.successCount / m.callCount) * 100) : '-';
                return `<div class="flex items-center justify-between py-2 px-3 bg-base-200 rounded ${!m.isActive ? 'opacity-50' : ''}">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="font-mono text-sm">${m.name}</span>
                            ${statusBadge}
                            ${m.isDefault ? '<span class="badge badge-primary badge-xs">默认</span>' : ''}
                            ${!m.isActive ? '<span class="badge badge-error badge-xs">禁用</span>' : ''}
                        </div>
                        <div class="text-xs text-base-content/50 mt-0.5">ID: ${m.modelId} | 调用: ${m.callCount||0} | 成功率: ${successRate}% | 延迟: ${m.avgLatencyMs||'-'}ms</div>
                        ${m.lastError ? `<div class="text-xs text-error truncate">${m.lastError.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}
                    </div>
                    <div class="flex gap-1 flex-shrink-0 ml-2">
                        <button class="btn btn-xs btn-outline btn-info" onclick="testAiModel(${m.id})">测试</button>
                        <button class="btn btn-xs btn-ghost" onclick="editAiModelInline(${m.id}, '${(m.name||'').replace(/'/g,"\\'")}', '${(m.modelId||'').replace(/'/g,"\\'")}', ${!!m.isDefault})">编辑</button>
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

function editAiModelInline(id, name, modelId, isDefault) {
    const newName = prompt('模型名称:', name);
    if (newName === null) return;
    const newModelId = prompt('模型ID:', modelId);
    if (newModelId === null) return;
    const newDefault = confirm('设为默认模型？');
    Auth.apiFetch(`/api/admin/ai-models/${id}`, {
        method: 'PUT', body: JSON.stringify({ name: newName, modelId: newModelId, isDefault: newDefault })
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
                            <p class="text-sm">${p.credits} 点 | ¥${(p.priceCents / 100).toFixed(2)} ${normalizedDescription ? '| ' + normalizedDescription : ''}</p>
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
    document.getElementById('aic-price').value = pkg?.priceCents || '';
    document.getElementById('aic-desc').value = pkg?.description || '';
    document.getElementById('aiCreditModal').showModal();
}

function editAiCreditPkg(p) { showAiCreditForm(p); }

async function submitAiCreditForm() {
    const id = document.getElementById('aic-id').value;
    const body = {
        name: document.getElementById('aic-name').value.trim(),
        credits: parseInt(document.getElementById('aic-credits').value),
        priceCents: parseInt(document.getElementById('aic-price').value),
        description: document.getElementById('aic-desc').value.trim(),
    };
    if (!body.name || !body.credits || isNaN(body.priceCents)) { alert('请填写必填项'); return; }
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
        document.getElementById('pay-fixed-wechat-fee').value = config.fixedQr?.wechat?.feeAmount ?? 0;
        document.getElementById('pay-fixed-wechat-recommended').checked = !!config.fixedQr?.wechat?.recommended;
        updatePaymentImagePreview('pay-fixed-wechat-preview', 'pay-fixed-wechat-empty', config.fixedQr?.wechat?.imageData || '');

        document.getElementById('pay-fixed-alipay-enabled').checked = !!config.fixedQr?.alipay?.enabled;
        document.getElementById('pay-fixed-alipay-data').value = config.fixedQr?.alipay?.imageData || '';
        setPaymentRangeFields('pay-fixed-alipay-min', 'pay-fixed-alipay-max', config.fixedQr?.alipay);
        document.getElementById('pay-fixed-alipay-fee').value = config.fixedQr?.alipay?.feeAmount ?? 0;
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
        document.getElementById('pay-futong-alipay-fee').value = config.futong?.alipayFeeAmount ?? 0;
        document.getElementById('pay-futong-alipay-recommended').checked = !!config.futong?.alipayRecommended;
        document.getElementById('pay-futong-wxpay-min').value = config.futong?.wxpayMinAmount ?? '';
        document.getElementById('pay-futong-wxpay-max').value = config.futong?.wxpayMaxAmount ?? '';
        document.getElementById('pay-futong-wxpay-fee').value = config.futong?.wxpayFeeAmount ?? 0;
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
        document.getElementById('pay-bepusdt-fee').value = config.bepusdt?.feeAmount ?? 0;
        document.getElementById('pay-bepusdt-recommended').checked = !!config.bepusdt?.recommended;
        document.getElementById('pay-bepusdt-notify-url').value = config.bepusdt?.notifyUrl || '';
        document.getElementById('pay-bepusdt-open-mode').value = config.bepusdt?.openMode || 'redirect';

        document.getElementById('pay-pushplus-enabled').checked = !!config.pushplus?.enabled;
        document.getElementById('pay-pushplus-api-url').value = config.pushplus?.apiUrl || 'https://www.pushplus.plus/batchSend';
        document.getElementById('pay-pushplus-token').value = config.pushplus?.token || '';
        document.getElementById('pay-pushplus-channel').value = config.pushplus?.channel || 'app';
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

    const payload = {
        minRechargeAmount,
        quickAmounts,
        fixedQr: {
            wechat: {
                enabled: document.getElementById('pay-fixed-wechat-enabled').checked,
                imageData: document.getElementById('pay-fixed-wechat-data').value || '',
                minAmount: fixedWechatRange.minAmount,
                maxAmount: fixedWechatRange.maxAmount,
                feeAmount: getPositiveIntegerInputValue('pay-fixed-wechat-fee', 0) || 0,
                recommended: document.getElementById('pay-fixed-wechat-recommended').checked
            },
            alipay: {
                enabled: document.getElementById('pay-fixed-alipay-enabled').checked,
                imageData: document.getElementById('pay-fixed-alipay-data').value || '',
                minAmount: fixedAlipayRange.minAmount,
                maxAmount: fixedAlipayRange.maxAmount,
                feeAmount: getPositiveIntegerInputValue('pay-fixed-alipay-fee', 0) || 0,
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
            alipayFeeAmount: getPositiveIntegerInputValue('pay-futong-alipay-fee', 0) || 0,
            alipayRecommended: document.getElementById('pay-futong-alipay-recommended').checked,
            wxpayMinAmount: futongWxpayRange.minAmount,
            wxpayMaxAmount: futongWxpayRange.maxAmount,
            wxpayFeeAmount: getPositiveIntegerInputValue('pay-futong-wxpay-fee', 0) || 0,
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
            feeAmount: getPositiveIntegerInputValue('pay-bepusdt-fee', 0) || 0,
            recommended: document.getElementById('pay-bepusdt-recommended').checked
        },
        pushplus: {
            enabled: document.getElementById('pay-pushplus-enabled').checked,
            apiUrl: document.getElementById('pay-pushplus-api-url').value.trim(),
            token: document.getElementById('pay-pushplus-token').value.trim(),
            channel: document.getElementById('pay-pushplus-channel').value.trim() || 'app'
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
