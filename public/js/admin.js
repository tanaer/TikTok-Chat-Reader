// admin.js - Admin panel logic

document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAdmin()) return;
    Auth.updateNavbar();
    loadOverviewStats();
});

let currentSection = 'overview';

function showSection(name) {
    currentSection = name;
    document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
    document.getElementById(`sec-${name}`).classList.remove('hidden');
    document.querySelectorAll('#sidebar-menu a').forEach(a => a.classList.remove('active'));
    event.target.classList.add('active');

    const titles = { overview: '系统概览', users: '用户管理', orders: '订单管理', plans: '套餐设置', gifts: '礼物配置', settings: '系统设置' };
    document.getElementById('section-title').textContent = titles[name] || name;

    if (name === 'overview') loadOverviewStats();
    else if (name === 'users') loadUsers(1);
    else if (name === 'orders') loadAdminOrders(1);
    else if (name === 'plans') { loadPlans(); loadAddons(); }
    else if (name === 'gifts') loadAdminGiftConfig();
    else if (name === 'settings') loadSettingsForm();
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

async function showUserDetail(userId) {
    try {
        const res = await Auth.apiFetch(`/api/admin/users/${userId}`);
        const data = await res.json();
        const u = data.user;
        const content = document.getElementById('user-detail-content');

        content.innerHTML = `
            <div class="grid grid-cols-2 gap-4 mb-4">
                <div><strong>用户名:</strong> ${u.username}</div>
                <div><strong>昵称:</strong> ${u.nickname || '-'}</div>
                <div><strong>邮箱:</strong> ${u.email || '-'}</div>
                <div><strong>余额:</strong> ¥${parseFloat(u.balance).toFixed(2)}</div>
                <div><strong>角色:</strong> ${u.role}</div>
                <div><strong>状态:</strong> ${u.status}</div>
                <div><strong>最后登录:</strong> ${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未'}</div>
                <div><strong>注册时间:</strong> ${new Date(u.createdAt).toLocaleString('zh-CN')}</div>
            </div>
            <div class="divider">订阅记录</div>
            <div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>套餐</th><th>周期</th><th>开始</th><th>结束</th><th>状态</th></tr></thead><tbody>
            ${data.subscriptions.map(s => `<tr><td>${s.planName}</td><td>${s.billingCycle}</td><td>${new Date(s.startAt).toLocaleDateString('zh-CN')}</td><td>${new Date(s.endAt).toLocaleDateString('zh-CN')}</td><td><span class="badge badge-xs ${s.status === 'active' ? 'badge-success' : 'badge-ghost'}">${s.status}</span></td></tr>`).join('') || '<tr><td colspan="5" class="text-center">无</td></tr>'}
            </tbody></table></div>
            <div class="divider">房间</div>
            <div class="flex flex-wrap gap-2">
            ${data.rooms.map(r => `<span class="badge badge-outline">${r.roomName || r.roomId}</span>`).join('') || '<span class="text-base-content/60">无</span>'}
            </div>
            <div class="divider">最近订单</div>
            <div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>订单号</th><th>类型</th><th>金额</th><th>时间</th></tr></thead><tbody>
            ${data.recentOrders.map(o => `<tr><td class="text-xs">${o.orderNo}</td><td>${o.type}</td><td>¥${parseFloat(o.amount).toFixed(2)}</td><td class="text-xs">${new Date(o.createdAt).toLocaleString('zh-CN')}</td></tr>`).join('') || '<tr><td colspan="4" class="text-center">无</td></tr>'}
            </tbody></table></div>
            <div class="mt-4 flex gap-2">
                <button class="btn btn-sm btn-warning" onclick="resetPassword(${u.id})">重置密码</button>
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
const statusLabels = { paid: '已支付', pending: '待支付', cancelled: '已取消', refunded: '已退款' };

async function loadAdminOrders(page) {
    try {
        const search = document.getElementById('order-search').value;
        const type = document.getElementById('order-type-filter').value;
        const params = new URLSearchParams({ page, limit: 20, search, type });
        const res = await Auth.apiFetch(`/api/admin/orders?${params}`);
        const data = await res.json();
        const tbody = document.getElementById('admin-orders-tbody');

        if (!data.orders || data.orders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-base-content/60">暂无数据</td></tr>';
            return;
        }

        tbody.innerHTML = data.orders.map(o => `<tr>
            <td class="text-xs">${o.orderNo}</td>
            <td>${o.username || '-'}</td>
            <td>${typeLabels[o.type] || o.type}</td>
            <td>${o.itemName || '-'}</td>
            <td class="font-mono">¥${parseFloat(o.amount).toFixed(2)}</td>
            <td><span class="badge badge-sm ${o.status === 'paid' ? 'badge-success' : 'badge-ghost'}">${statusLabels[o.status] || o.status}</span></td>
            <td class="text-xs">${new Date(o.createdAt).toLocaleString('zh-CN')}</td>
        </tr>`).join('');

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
    container.innerHTML = data.plans.map(p => `
        <div class="card bg-base-100 border ${p.isActive ? 'border-base-300' : 'border-error opacity-60'}">
            <div class="card-body p-4">
                <div class="flex justify-between items-start">
                    <div>
                        <h4 class="font-bold">${p.name} <span class="text-xs text-base-content/60">(${p.code})</span></h4>
                        <p class="text-sm">房间: ${p.roomLimit} | 月¥${p.priceMonthly} / 季¥${p.priceQuarterly} / 年¥${p.priceAnnual}</p>
                        ${!p.isActive ? '<span class="badge badge-error badge-sm">已下架</span>' : ''}
                    </div>
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="editPlan(${JSON.stringify(p).replace(/"/g, '&quot;')})">编辑</button>
                        <button class="btn btn-xs ${p.isActive ? 'btn-error' : 'btn-success'} btn-outline" onclick="togglePlanStatus(${p.id})">${p.isActive ? '下架' : '上架'}</button>
                    </div>
                </div>
            </div>
        </div>`).join('');
}

function showPlanForm(plan) {
    document.getElementById('plan-form-title').textContent = plan ? '编辑套餐' : '新增套餐';
    document.getElementById('pf-id').value = plan?.id || '';
    document.getElementById('pf-name').value = plan?.name || '';
    document.getElementById('pf-code').value = plan?.code || '';
    document.getElementById('pf-code').disabled = !!plan;
    document.getElementById('pf-room').value = plan?.roomLimit || '';
    document.getElementById('pf-pm').value = plan?.priceMonthly || '';
    document.getElementById('pf-pq').value = plan?.priceQuarterly || '';
    document.getElementById('pf-py').value = plan?.priceAnnual || '';
    document.getElementById('pf-sort').value = plan?.sortOrder || 0;
    document.getElementById('planFormModal').showModal();
}

function editPlan(plan) { showPlanForm(plan); }

async function submitPlanForm() {
    const id = document.getElementById('pf-id').value;
    const body = {
        name: document.getElementById('pf-name').value,
        code: document.getElementById('pf-code').value,
        roomLimit: parseInt(document.getElementById('pf-room').value),
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
    { key: 'euler_keys', label: 'Euler API Keys', type: 'text' },
    { key: 'session_id', label: 'TikTok Session ID', type: 'text' },
    { key: 'port', label: '服务端口 (需重启)', type: 'number' },
    { key: 'ai_api_key', label: 'AI API Key', type: 'text' },
    { key: 'ai_api_url', label: 'AI API URL', type: 'text' },
    { key: 'ai_model_name', label: 'AI 模型名', type: 'text' },
    { key: 'dynamic_tunnel_proxy', label: '动态隧道代理', type: 'text' },
    { key: 'proxy_api_url', label: '代理API地址', type: 'text' },
    { key: 'default_room_limit', label: '默认房间上限 (未订阅)', type: 'number' },
    { key: 'min_recharge_amount', label: '最低充值金额', type: 'number' },
    { key: 'site_name', label: '网站名称', type: 'text' },
];

async function loadSettingsForm() {
    const res = await Auth.apiFetch('/api/admin/settings');
    const data = await res.json();
    const settings = data.settings || {};
    const form = document.getElementById('settings-form');

    form.innerHTML = settingDefs.map(d => {
        const val = settings[d.key] !== undefined ? settings[d.key] : '';
        if (d.type === 'toggle') {
            return `<div class="form-control"><label class="label cursor-pointer justify-start gap-4">
                <span class="label-text w-48">${d.label}</span>
                <input type="checkbox" class="toggle toggle-primary" data-key="${d.key}" ${val === true || val === 'true' || val === 1 ? 'checked' : ''}>
            </label></div>`;
        }
        return `<div class="form-control"><label class="label"><span class="label-text">${d.label}</span></label>
            <input type="${d.type === 'number' ? 'number' : 'text'}" class="input input-bordered" data-key="${d.key}" value="${val}">
        </div>`;
    }).join('');
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
