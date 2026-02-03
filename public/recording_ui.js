// Recording UI Logic

let recordingAccounts = [];
let recordingProxies = [];
let recordingTasks = []; // Active or recent tasks
let editingProxyId = null;
let editingAccountId = null;

$(document).ready(() => {
    // Initial Load
    // We strictly load when tab is switched to keep performance, but can also load on init
});

function initRecordingSection() {
    loadAccounts();
    loadProxies();
    loadTasks();
    checkFFmpegStatus();
}




// --- Tabs ---
function switchRecordingTab(tabName, btn) {
    $('.recording-sub-nav-btn').removeClass('active btn-primary').addClass('btn-ghost');
    $(btn).removeClass('btn-ghost').addClass('active btn-primary');

    $('.recording-tab-content').addClass('hidden');
    $(`#recordingTab-${tabName}`).removeClass('hidden');

    if (tabName === 'accounts') loadAccounts();
    if (tabName === 'proxies') loadProxies();
    if (tabName === 'tasks') loadTasks();
}


// --- Accounts ---
async function loadAccounts() {
    try {
        const res = await fetch('/api/tiktok_accounts');
        const data = await res.json();
        recordingAccounts = data.accounts || [];
        renderAccounts();
    } catch (e) {
        console.error("Failed to load accounts", e);
    }
}

function renderAccounts() {
    const tbody = $('#accountTable tbody');
    tbody.empty();

    recordingAccounts.forEach(acc => {
        const proxy = recordingProxies.find(p => p.id === acc.proxyId);
        const proxyName = proxy ? proxy.name : (acc.proxyId ? `ID: ${acc.proxyId}` : 'Direct');
        const isActive = acc.isActive === 1 || acc.isActive === true;

        tbody.append(`
            <tr>
                <td>${acc.id}</td>
                <td>${acc.username || '-'}</td>
                <td class="max-w-xs truncate" title="${acc.cookie || ''}">${acc.cookie ? 'Has Cookie' : 'None'}</td>
                <td>${proxyName}</td>
                <td>
                    <label class="cursor-pointer">
                        <input type="checkbox" class="toggle toggle-sm toggle-success" 
                            ${isActive ? 'checked' : ''} 
                            onchange="toggleAccountStatus(${acc.id}, this.checked)" />
                    </label>
                </td>
                <td>
                    <button class="btn btn-xs btn-ghost" onclick="openEditAccountModal(${acc.id})">✏️</button>
                    <button class="btn btn-xs btn-error" onclick="deleteAccount(${acc.id})">🗑️</button>
                </td>
            </tr>
        `);
    });
}

async function addAccount() {
    const username = $('#acc_username').val();
    const cookie = $('#acc_cookie').val();
    const proxyId = $('#acc_proxy').val();

    if (!cookie && !username) return alert("Username or Cookie required");

    try {
        await fetch('/api/tiktok_accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                cookie,
                proxyId: proxyId || null,
                isActive: 1
            })
        });
        $('#addAccountModal')[0].close();
        loadAccounts();
    } catch (e) {
        alert("Failed to add account: " + e.message);
    }
}

async function deleteAccount(id) {
    if (!confirm("Delete this account?")) return;
    try {
        await fetch(`/api/tiktok_accounts/${id}`, { method: 'DELETE' });
        loadAccounts();
    } catch (e) {
        alert("Failed to delete: " + e.message);
    }
}

function openAddAccountModal() {
    // Clear form and reset edit state
    $('#editAccountId').val(''); // Clear ID -> Add Mode
    $('#acc_username').val('');
    $('#acc_cookie').val('');

    // Populate proxy dropdown
    const select = $('#acc_proxy');
    select.empty();
    select.append('<option value="">Direct (No Proxy)</option>');
    recordingProxies.forEach(p => {
        select.append(`<option value="${p.id}">${p.name || p.host}</option>`);
    });

    $('#addAccountModal')[0].showModal();
}


// --- Proxies ---
async function loadProxies() {
    try {
        const res = await fetch('/api/socks5_proxies');
        recordingProxies = await res.json();
        renderProxies();
    } catch (e) {
        console.error("Failed to load proxies", e);
    }
}

function renderProxies() {
    const tbody = $('#proxyTable tbody');
    tbody.empty();

    recordingProxies.forEach(p => {
        const isActive = p.isActive === 1 || p.isActive === true;
        tbody.append(`
            <tr>
                <td>${p.id}</td>
                <td>${p.name || '-'}</td>
                <td>${p.host}:${p.port}</td>
                <td>
                    <label class="cursor-pointer">
                        <input type="checkbox" class="toggle toggle-sm toggle-success" 
                            ${isActive ? 'checked' : ''} 
                            onchange="toggleProxyStatus(${p.id}, this.checked)" />
                    </label>
                </td>
                <td>
                    <button class="btn btn-xs btn-info" onclick="testProxy(${p.id})" title="Test Connectivity">📡</button>
                    <button class="btn btn-xs btn-ghost" onclick="openEditProxyModal(${p.id})">✏️</button>
                    <button class="btn btn-xs btn-error" onclick="deleteProxy(${p.id})">🗑️</button>
                </td>
            </tr>
        `);
    });
}

function openAddProxyModal() {
    // Clear form and reset edit state
    $('#editProxyId').val(''); // Clear ID -> Add Mode
    $('#proxy_name').val('');
    $('#proxy_host').val('');
    $('#proxy_port').val('');
    $('#proxy_user').val('');
    $('#proxy_pass').val('');
    $('#addProxyModal')[0].showModal();
}

async function addProxy() {
    // Deprecated: use saveProxy
    saveProxy();
}

async function deleteProxy(id) {
    if (!confirm("Delete this proxy?")) return;
    try {
        await fetch(`/api/socks5_proxies/${id}`, { method: 'DELETE' });
        loadProxies();
    } catch (e) {
        alert("Failed to delete: " + e.message);
    }
}

async function toggleProxyStatus(id, isActive) {
    try {
        const res = await fetch(`/api/socks5_proxies/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive: isActive ? 1 : 0 })
        });
        if (!res.ok) throw new Error(await res.text());
        loadProxies();
    } catch (e) {
        alert("Failed to update status: " + e.message);
        loadProxies(); // Revert UI
    }
}


async function testProxy(id) {
    const btn = $(`button[onclick="testProxy(${id})"]`);
    const originalText = btn.html();
    btn.prop('disabled', true).text('Testing...');

    try {
        const res = await fetch(`/api/socks5_proxies/${id}/test`, { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            alert(`✅ Connection Successful!\n\nLatency: ${data.duration}ms\nStatus Code: ${data.status}\nTarget: tiktok.com`);
        } else {
            alert(`❌ Connection Failed\n\nError: ${data.error}\nDuration: ${data.duration || 0}ms`);
        }
    } catch (e) {
        alert("Error testing proxy: " + e.message);
    } finally {
        btn.prop('disabled', false).html(originalText);
    }
}

async function toggleAccountStatus(id, isActive) {
    try {
        const res = await fetch(`/api/tiktok_accounts/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive: isActive ? 1 : 0 })
        });
        if (!res.ok) throw new Error(await res.text());
        loadAccounts();
    } catch (e) {
        alert("Failed to update status: " + e.message);
        loadAccounts(); // Revert UI
    }
}



function openEditProxyModal(id) {
    const proxy = recordingProxies.find(p => p.id === id);
    if (!proxy) return;

    $('#editProxyId').val(id); // Set ID -> Edit Mode
    $('#proxy_name').val(proxy.name || '');
    $('#proxy_host').val(proxy.host || '');
    $('#proxy_port').val(proxy.port || '');
    $('#proxy_user').val(proxy.username || '');
    $('#proxy_pass').val(''); // Don't show password
    $('#proxy_pass').attr('placeholder', 'Leave blank to keep unchanged');
    $('#addProxyModal')[0].showModal();
}

function openEditAccountModal(id) {
    const acc = recordingAccounts.find(a => a.id === id);
    if (!acc) return;

    $('#editAccountId').val(id); // Set ID -> Edit Mode
    $('#acc_username').val(acc.username || '');
    $('#acc_cookie').val(acc.cookie || '');

    // Populate proxy dropdown
    const select = $('#acc_proxy');
    select.empty();
    select.append('<option value="">Direct (No Proxy)</option>');
    recordingProxies.forEach(p => {
        // Use loose equality for safety
        const selected = p.id == acc.proxyId ? 'selected' : '';
        select.append(`<option value="${p.id}" ${selected}>${p.name || p.host}</option>`);
    });

    $('#addAccountModal')[0].showModal();
}

async function saveProxy() {
    const id = $('#editProxyId').val(); // Read hidden ID
    const name = $('#proxy_name').val();
    const host = $('#proxy_host').val();
    const port = $('#proxy_port').val();
    const username = $('#proxy_user').val();
    const password = $('#proxy_pass').val();

    if (!host || !port) return alert("Host and Port required");

    const payload = { name, host, port, username };

    // Password logic
    if (password) {
        payload.password = password;
    } else if (!id) {
        // Creating new -> allow empty password
        payload.password = "";
    }
    // Editing with empty password -> omit 'password' key

    try {
        let res;
        if (id) {
            // Update existing
            res = await fetch(`/api/socks5_proxies/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            // Add new
            payload.isActive = 1; // Default active
            res = await fetch('/api/socks5_proxies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        if (!res.ok) throw new Error(await res.text());

        $('#addProxyModal')[0].close();
        loadProxies();
    } catch (e) {
        alert("Failed to save proxy: " + e.message);
    }
}

async function saveAccount() {
    const id = $('#editAccountId').val(); // Read hidden ID
    const username = $('#acc_username').val();
    const cookie = $('#acc_cookie').val();
    const proxyId = $('#acc_proxy').val();

    if (!cookie && !username) return alert("Username or Cookie required");

    const payload = {
        username,
        cookie,
        proxyId: proxyId ? parseInt(proxyId) : null // Ensure null if empty
    };

    try {
        let res;
        if (id) {
            console.log("Updating account:", id);
            // Update existing
            res = await fetch(`/api/tiktok_accounts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            console.log("Creating new account");
            // Add new
            payload.isActive = 1;
            res = await fetch('/api/tiktok_accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, isActive: 1 })
            });
        }

        if (!res.ok) throw new Error(await res.text());

        $('#addAccountModal')[0].close();
        loadAccounts();
    } catch (e) {
        alert("Failed to save account: " + e.message);
    }
}

// --- Recording Control (Called from Room List) ---
async function toggleRecording(roomId, uniqueId, btn) {
    // Check status
    const isRecording = $(btn).hasClass('recording-active');

    if (isRecording) {
        // Stop
        try {
            const res = await fetch(`/api/rooms/${roomId}/recording/stop`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                $(btn).removeClass('recording-active btn-error').addClass('btn-ghost');
                $(btn).html('⏺ 录制');
            }
        } catch (e) {
            alert("Stop failed: " + e.message);
        }
    } else {
        // Start - Open Modal to select options? Or quick start?
        // Let's do quick start with default or open modal if needed.
        // For now, let's open a modal to choose account.

        currentRecordingRoom = { roomId, uniqueId, btn };
        openStartRecordingModal();
    }
}

let currentRecordingRoom = null;

function openStartRecordingModal() {
    // Populate accounts
    loadAccounts().then(() => {
        const select = $('#rec_account');
        select.empty();
        select.append('<option value="">Anonymous (No Account)</option>');
        recordingAccounts.forEach(acc => {
            select.append(`<option value="${acc.id}">${acc.username || 'Account ' + acc.id}</option>`);
        });
        $('#startRecordingModal')[0].showModal();
    });
}

async function confirmStartRecording() {
    if (!currentRecordingRoom) return;

    const accountId = $('#rec_account').val();
    const { roomId, uniqueId, btn } = currentRecordingRoom;

    try {
        const res = await fetch(`/api/rooms/${roomId}/recording/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, uniqueId, accountId })
        });
        const data = await res.json();

        if (data.success) {
            $(btn).addClass('recording-active btn-error').removeClass('btn-ghost');
            $(btn).html('⏹ 停止');
            $('#startRecordingModal')[0].close();
        } else {
            alert("Start failed: " + (data.error || 'Unknown error'));
        }
    } catch (e) {
        alert("Start failed: " + e.message);
    }
}

// --- Tasks ---
let taskCurrentPage = 1;
let taskTotalPages = 1;

async function loadRecordingTasks() {
    try {
        // Build query params from filters
        const roomId = $('#taskFilterRoom').val();
        const status = $('#taskFilterStatus').val();
        const dateFrom = $('#taskFilterDateFrom').val();
        const dateTo = $('#taskFilterDateTo').val();

        let params = new URLSearchParams();
        if (roomId) params.append('roomId', roomId);
        if (status) params.append('status', status);
        if (dateFrom) params.append('dateFrom', dateFrom);
        if (dateTo) params.append('dateTo', dateTo);
        params.append('page', taskCurrentPage);
        params.append('limit', 15);

        const [tasksRes, activeRes] = await Promise.all([
            fetch(`/api/recording_tasks?${params}`).then(r => r.json()),
            fetch('/api/recordings/active').then(r => r.json())
        ]);

        // Render active recordings
        renderActiveRecordings(activeRes);

        // Render history
        renderTaskHistory(tasksRes.tasks || []);

        // Update pagination
        const pagination = tasksRes.pagination || { page: 1, totalPages: 1 };
        taskCurrentPage = pagination.page;
        taskTotalPages = pagination.totalPages;
        $('#taskPageInfo').text(`${taskCurrentPage} / ${taskTotalPages || 1}`);
        $('#taskPrevBtn').prop('disabled', taskCurrentPage <= 1);
        $('#taskNextBtn').prop('disabled', taskCurrentPage >= taskTotalPages);

    } catch (e) {
        console.error("Failed to load recording tasks", e);
    }
}

// Alias for backward compatibility
async function loadTasks() {
    await loadRoomDropdown();
    await loadRecordingTasks();
}

async function loadRoomDropdown() {
    try {
        const rooms = await fetch('/api/recording_tasks/rooms').then(r => r.json());
        const select = $('#taskFilterRoom');
        select.find('option:not(:first)').remove();
        rooms.forEach(r => {
            select.append(`<option value="${r.room_id}">${r.room_id} (${r.task_count})</option>`);
        });
    } catch (e) {
        console.error("Failed to load room dropdown", e);
    }
}

function renderActiveRecordings(activeRoomIds) {
    const container = $('#activeRecordingsList');
    const section = $('#activeRecordingsSection');
    container.empty();

    if (!activeRoomIds || activeRoomIds.length === 0) {
        section.addClass('hidden');
        return;
    }

    section.removeClass('hidden');
    activeRoomIds.forEach(roomId => {
        container.append(`
            <div class="alert alert-success shadow-sm flex justify-between items-center p-3">
                <div>
                    <span class="badge badge-error badge-sm animate-pulse gap-1 mr-2">
                        <span class="w-1.5 h-1.5 rounded-full bg-white"></span> REC
                    </span>
                    <span class="font-mono text-sm">${roomId}</span>
                </div>
                <button class="btn btn-xs btn-outline btn-error" onclick="stopTask('${roomId}')">⏹ 停止</button>
            </div>
        `);
    });
}

function renderTaskHistory(tasks) {
    const tbody = $('#taskHistoryBody');
    tbody.empty();

    if (tasks.length === 0) {
        tbody.append('<tr><td colspan="6" class="text-center opacity-50 py-4">暂无历史记录</td></tr>');
        return;
    }

    tasks.forEach(t => {
        const startTime = t.start_time ? new Date(t.start_time).toLocaleString('zh-CN') : '-';
        const duration = calculateDuration(t.start_time, t.end_time);
        const statusBadge = getStatusBadge(t.status);
        const hasFile = t.file_path && t.status === 'completed';

        tbody.append(`
            <tr>
                <td>${t.id}</td>
                <td class="font-mono text-xs">${t.room_id}</td>
                <td class="text-xs">${startTime}</td>
                <td>${duration}</td>
                <td>${statusBadge}</td>
                <td>
                    ${hasFile ? `<button class="btn btn-xs btn-info" onclick="downloadRecording(${t.id})" title="下载">📥</button>` : ''}
                    <button class="btn btn-xs btn-ghost text-error" onclick="deleteRecordingTask(${t.id})" title="删除">🗑️</button>
                </td>
            </tr>
        `);
    });
}

function calculateDuration(start, end) {
    if (!start) return '-';
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date();
    const diffMs = endDate - startDate;
    const diffSec = Math.floor(diffMs / 1000);
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;
    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getStatusBadge(status) {
    switch (status) {
        case 'recording': return '<span class="badge badge-error badge-sm">录制中</span>';
        case 'completed': return '<span class="badge badge-success badge-sm">✅ 完成</span>';
        case 'failed': return '<span class="badge badge-warning badge-sm">❌ 失败</span>';
        default: return `<span class="badge badge-ghost badge-sm">${status || '未知'}</span>`;
    }
}

function changeTaskPage(delta) {
    const newPage = taskCurrentPage + delta;
    if (newPage >= 1 && newPage <= taskTotalPages) {
        taskCurrentPage = newPage;
        loadRecordingTasks();
    }
}

function clearTaskFilters() {
    $('#taskFilterRoom').val('');
    $('#taskFilterStatus').val('');
    $('#taskFilterDateFrom').val('');
    $('#taskFilterDateTo').val('');
    taskCurrentPage = 1;
    loadRecordingTasks();
}

function downloadRecording(taskId) {
    window.open(`/api/recording_tasks/${taskId}/download`, '_blank');
}

async function deleteRecordingTask(taskId) {
    const deleteFile = confirm('是否同时删除录制文件？\n\n确定 = 删除文件\n取消 = 仅删除记录');
    if (!confirm('确定要删除这条录制记录吗？')) return;

    try {
        const res = await fetch(`/api/recording_tasks/${taskId}?deleteFile=${deleteFile}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        loadRecordingTasks();
    } catch (e) {
        alert("删除失败: " + e.message);
    }
}

async function stopTask(roomId) {
    if (!confirm('确定要停止录制吗?')) return;
    try {
        await fetch(`/api/rooms/${roomId}/recording/stop`, { method: 'POST' });
        setTimeout(loadRecordingTasks, 500);
    } catch (e) {
        alert("停止失败: " + e.message);
    }
}

// --- FFmpeg Management ---
async function checkFFmpegStatus() {
    try {
        const res = await fetch('/api/maintenance/ffmpeg');
        const status = await res.json();

        // Update UI logic: we expect elements #ffmpegStatusBadge, #ffmpegActionContainer, #ffmpegInfo
        // These will be in index.html
        const badge = $('#ffmpegStatusBadge');
        const container = $('#ffmpegActionContainer');
        const info = $('#ffmpegInfo');

        if (status.installed) {
            badge.removeClass('badge-error badge-ghost').addClass('badge-success').text('已安装');
            info.text(`v${status.version} (${status.isLocal ? '内置' : '系统'})`);

            // Show update button or nothing
            if (status.isLocal) {
                container.html(`
                    <button class="btn btn-xs btn-ghost text-primary" onclick="window.installFFmpeg(true)">🔄 更新</button>
                `);
            } else {
                container.html(`
                    <span class="text-xs opacity-50 mr-2">使用系统路径</span>
                    <button class="btn btn-xs btn-outline" onclick="window.installFFmpeg(true)">📥 安装内置版本</button>
                `);
            }
        } else {
            badge.removeClass('badge-success badge-ghost').addClass('badge-error').text('未安装');
            info.text('无法录制');
            container.html(`
                <button class="btn btn-sm btn-primary" onclick="window.installFFmpeg(false)">📥 立即安装 FFmpeg</button>
            `);
        }
    } catch (e) {
        console.error("FFmpeg check failed", e);
        $('#ffmpegStatusBadge').text('检查失败');
    }
}

window.installFFmpeg = async function (force) {
    const btn = $(event.target).closest('button');
    const originalText = btn.html();
    btn.prop('disabled', true).html('<span class="loading loading-spinner loading-xs"></span> 处理中...');

    try {
        const res = await fetch('/api/maintenance/ffmpeg/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force })
        });
        const result = await res.json();

        if (result.success) {
            alert("FFmpeg 安装/更新成功!");
            checkFFmpegStatus();
        } else {
            alert("安装失败: " + (result.error || 'Unknown error'));
            btn.prop('disabled', false).html(originalText);
        }
    } catch (e) {
        alert("请求失败: " + e.message);
        btn.prop('disabled', false).html(originalText);
    }
};

