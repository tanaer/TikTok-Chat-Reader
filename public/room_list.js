// State variables for pagination and search
let roomListPage = 1;
let roomListLimit = 20;
let roomListSearch = '';
let roomListSort = 'default';
let roomListTotal = 0;
let roomListViewMode = 'card'; // 'card' or 'list'
let roomListRefreshTimer = null; // Timer for auto-refresh
const ROOM_LIST_REFRESH_INTERVAL = 10000; // 10 seconds for listing is enough

// Helper to format monthly total with daily average: "260（10）"
// Daily average = total / 26 (fixed divisor)
const formatMonthlyWithAvg = (total) => {
    const avg = Math.round(total / 26);
    return `${total.toLocaleString()}（${avg.toLocaleString()}）`;
};

// Helper to format time ago in human-readable format (e.g., "3天前", "7天前", "1个月前")
const formatTimeAgo = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 1) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays}天前`;
    if (diffDays < 30) {
        const weeks = Math.floor(diffDays / 7);
        return `${weeks}周前`;
    }
    if (diffDays < 365) {
        const months = Math.floor(diffDays / 30);
        return `${months}个月前`;
    }
    const years = Math.floor(diffDays / 365);
    return `${years}年前`;
};

// Helper to escape strings for use in HTML attributes
const escapeHtml = (str) => str == null ? '' : String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');

// Helper to format duration in seconds (uses global formatDuration from app.js if available)
const formatRoomDuration = (seconds) => {
    if (typeof window.formatDuration === 'function') {
        return window.formatDuration(seconds);
    }
    if (!seconds || seconds <= 0) return '-';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h${mins}m`;
    return `${mins}m`;
};

// Helper to copy text to clipboard
const copyToClipboard = (text, event) => {
    event.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
        // Show brief feedback
        const el = event.target;
        const original = el.textContent;
        el.textContent = '✓ 已复制';
        setTimeout(() => el.textContent = original, 1000);
    });
};
window.copyToClipboard = copyToClipboard;

// Render a single room as a card
function renderRoomCard(r, index = 0) {
    const isLive = r.isLive === true;
    const badgeClass = isLive ? 'badge-success' : 'badge-ghost';
    const statusText = isLive ? '🟢 直播中' : '未开播';
    const duration = formatRoomDuration(r.broadcastDuration);
    const lastSession = r.lastSessionTime ? new Date(r.lastSessionTime).toLocaleString() : '无记录';
    const isMonitorOn = r.isMonitorEnabled !== 0;
    const isRecordingEnabled = r.isRecordingEnabled === 1;
    const recordingAccountId = escapeHtml(r.recordingAccountId || '');
    const safeRoomId = escapeHtml(r.roomId);
    const safeName = escapeHtml(r.name || '');


    // Recording status
    const isRecording = window.activeRecordingSet && window.activeRecordingSet.has(r.roomId);
    const recoBtnClass = isRecording ? 'btn-error recording-active' : 'btn-ghost';
    const recoBtnText = isRecording ? '⏹ 停止' : '⏺ 录制';
    const recoBtnTooltip = isRecording ? '停止录制' : '开始录制';

    return `

    <div class="card bg-base-100 shadow-xl border border-base-200 hover:border-primary transition-colors" data-room-id="${safeRoomId}">
        <div class="card-body p-5">
            <div class="flex justify-between items-start">
                <div>
                    <div class="flex items-center gap-2">
                        <span class="badge badge-neutral badge-sm font-mono">#${index}</span>
                        <h2 class="card-title text-lg font-bold truncate w-36" title="${r.name}">${r.name || '未命名'}</h2>
                    </div>
                    <div class="flex items-center gap-1 mt-1">
                        <div class="badge badge-outline badge-sm opacity-70 truncate max-w-[150px] cursor-pointer hover:bg-base-300" 
                             title="点击复制: ${r.roomId}" onclick="copyToClipboard('${safeRoomId}', event)">${r.roomId}</div>
                        ${r.lastSessionTime ? `<span class="text-xs opacity-50">- ${formatTimeAgo(r.lastSessionTime)}</span>` : ''}
                    </div>
                </div>
                <div class="flex flex-col items-end gap-1">
                    <div class="flex items-center gap-1">
                        <span class="text-xs font-mono opacity-60" title="本场开播时长">⏱️${duration}</span>
                        <div class="badge ${badgeClass} badge-sm">${statusText}</div>
                    </div>
                    <label class="label cursor-pointer p-0 gap-2">
                        <span class="label-text text-xs opacity-70">LZ</span> 
                        <input type="checkbox" class="toggle toggle-xs toggle-success" 
                            onchange="toggleMonitor('${safeRoomId}', this.checked, '${safeName}', '${escapeHtml(r.address || '')}')"
                            ${isMonitorOn ? 'checked' : ''} />
                    </label>
                </div>
            </div>
            
            <div class="stats stats-horizontal shadow-sm my-4 bg-base-200 w-full overflow-hidden">
                <div class="stat p-2 place-items-center">
                    <div class="stat-title text-[10px] uppercase tracking-wider">📶</div>
                    <div class="stat-value text-sm font-mono">${(r.totalVisits || 0).toLocaleString()}</div>
                </div>
                <div class="stat p-2 place-items-center">
                    <div class="stat-title text-[10px] uppercase tracking-wider">💬</div>
                    <div class="stat-value text-sm font-mono">${(r.totalComments || 0).toLocaleString()}</div>
                </div>
                <div class="stat p-2 place-items-center">
                    <div class="stat-title text-[10px] uppercase tracking-wider">💎N</div>
                    <div class="stat-value text-sm text-warning font-mono">${(r.totalGiftValue || 0).toLocaleString()}</div>
                </div>
                <div class="stat p-2 place-items-center" title="本月总计（日均）">
                    <div class="stat-title text-[10px] uppercase tracking-wider">💎月</div>
                    <div class="stat-value text-sm text-success font-mono">${formatMonthlyWithAvg(r.monthlyGiftValue || 0)}</div>
                </div>
                ${roomListSort.includes('daily_avg') ? `
                <div class="stat p-2 place-items-center" title="有效日均 (开播>2h的日期)&#10;有效天数: ${r.validDays || 0}天">
                    <div class="stat-title text-[10px] uppercase tracking-wider">💎日</div>
                    <div class="stat-value text-sm text-primary font-mono">${(r.validDailyAvg || 0).toLocaleString()}</div>
                </div>
                ` : ''}
            </div>

            <div class="text-xs text-base-content/40 mb-2 flex items-center justify-end gap-1">
                <span class="badge badge-warning badge-sm" title="赚钱效率 (💎/人)">💰${r.giftEfficiency || 0}</span>
                <span class="badge badge-info badge-sm" title="话题度 (💬/人)">💬${r.interactEfficiency || 0}</span>
                <span class="badge badge-success badge-sm" title="账号质量 (人/分钟)">👥${r.accountQuality || 0}</span>
            </div>
            <div class="text-xs text-base-content/40 mb-4 flex items-center justify-end gap-1">
                <span class="badge badge-error badge-sm" title="TOP1用户贡献占比">T1: ${r.top1Ratio || 0}%</span>
                <span class="badge badge-warning badge-sm" title="TOP3用户贡献占比">T3: ${r.top3Ratio || 0}%</span>
                <span class="badge badge-primary badge-sm" title="TOP10用户贡献占比">T10: ${r.top10Ratio || 0}%</span>
                <span class="badge badge-secondary badge-sm" title="TOP30用户贡献占比">T30: ${r.top30Ratio || 0}%</span>
            </div>

            <div class="card-actions justify-between items-center mt-auto">
                <div class="text-xs text-base-content/40 flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    ${lastSession}
                </div>
                <div class="flex gap-1">
                    <button class="btn btn-xs btn-ghost text-error" onclick="deleteRoom('${safeRoomId}')">删除</button>
                    <button class="btn btn-xs ${recoBtnClass}" onclick="toggleRecording('${safeRoomId}', '${safeRoomId}', this)" title="${recoBtnTooltip}">${recoBtnText}</button>
                    ${r.lastSessionTime ? `<button class="btn btn-xs btn-ghost text-primary" onclick="renameRoom('${safeRoomId}')" title="更新房间ID/迁移数据">🔄</button>` : ''}
                    <button class="btn btn-xs btn-ghost" onclick="openAddRoomModal('${safeRoomId}', '${safeName}', ${isMonitorOn}, '${r.language || '中文'}', ${r.priority}, ${isRecordingEnabled}, '${recordingAccountId}')">编辑</button>
                    <button class="btn btn-sm btn-primary" onclick="enterRoom('${safeRoomId}', '${safeName}')">进入</button>

                </div>
            </div>
        </div>
    </div>`;
}

// Render a single room as a list row
function renderRoomRow(r, index = 0) {
    const isLive = r.isLive === true;
    const badgeClass = isLive ? 'badge-success' : 'badge-ghost';
    const statusText = isLive ? '🟢' : '⚫';
    const duration = formatRoomDuration(r.broadcastDuration);
    const isMonitorOn = r.isMonitorEnabled !== 0;
    const isRecordingEnabled = r.isRecordingEnabled === 1;
    const recordingAccountId = escapeHtml(r.recordingAccountId || '');
    const safeRoomId = escapeHtml(r.roomId);

    const safeName = escapeHtml(r.name || '');

    // Recording status
    const isRecording = window.activeRecordingSet && window.activeRecordingSet.has(r.roomId);
    const recoBtnClass = isRecording ? 'btn-error recording-active' : 'btn-ghost';
    const recoBtnText = isRecording ? '⏹' : '⏺';

    return `

    <tr class="hover:bg-base-200 cursor-pointer" data-room-id="${safeRoomId}" onclick="enterRoom('${safeRoomId}', '${safeName}')">
        <td class="p-2 text-center font-mono text-sm opacity-60">${index}</td>
        <td class="p-2">
            <div class="flex items-center gap-2">
                <span class="text-lg" title="${isLive ? '直播中' : '未开播'}">${statusText}</span>
                <div>
                    <div class="font-bold truncate max-w-[120px]" title="${r.name}">${r.name || '未命名'}</div>
                    <div class="text-xs opacity-50">
                        <span class="cursor-pointer hover:opacity-100" onclick="event.stopPropagation();copyToClipboard('${safeRoomId}', event)" title="点击复制">${r.roomId}</span>${r.lastSessionTime ? ` - ${formatTimeAgo(r.lastSessionTime)}` : ''}
                    </div>
                </div>
            </div>
        </td>
        <td class="p-2 text-center font-mono text-xs opacity-60" title="本场时长">${duration}</td>
        <td class="p-2 text-center font-mono text-sm">${(r.totalVisits || 0).toLocaleString()}</td>
        <td class="p-2 text-center font-mono text-sm">${(r.totalComments || 0).toLocaleString()}</td>
        <td class="p-2 text-center font-mono text-sm text-warning">${(r.totalGiftValue || 0).toLocaleString()}</td>
        <td class="p-2 text-center font-mono text-sm text-success" title="本月总计（日均）">${formatMonthlyWithAvg(r.monthlyGiftValue || 0)}</td>
        ${roomListSort.includes('daily_avg') ? `<td class="p-2 text-center font-mono text-sm text-primary" title="有效天数: ${r.validDays || 0}天">${(r.validDailyAvg || 0).toLocaleString()}</td>` : ''}
        <td class="p-2 text-center">
            <span class="badge badge-warning badge-sm">💰${r.giftEfficiency || 0}</span>
        </td>
        <td class="p-2 text-center">
            <span class="badge badge-info badge-sm">💬${r.interactEfficiency || 0}</span>
        </td>
        <td class="p-2 text-center">
            <span class="badge badge-success badge-sm">👥${r.accountQuality || 0}</span>
        </td>
        <td class="p-2 text-center">
            <span class="badge badge-error badge-sm">${r.top1Ratio || 0}%</span>
        </td>
        <td class="p-2 text-center">
            <span class="badge badge-warning badge-sm">${r.top3Ratio || 0}%</span>
        </td>
        <td class="p-2 text-center">
            <span class="badge badge-primary badge-sm">${r.top10Ratio || 0}%</span>
        </td>
        <td class="p-2 text-center">
            <span class="badge badge-secondary badge-sm">${r.top30Ratio || 0}%</span>
        </td>
        <td class="p-2 text-center" onclick="event.stopPropagation()">
            <input type="checkbox" class="toggle toggle-xs toggle-success" 
                onchange="toggleMonitor('${safeRoomId}', this.checked, '${safeName}', '${escapeHtml(r.address || '')}')"
                ${isMonitorOn ? 'checked' : ''} />
        </td>
        <td class="p-2 text-center" onclick="event.stopPropagation()">
            <div class="flex gap-1 justify-center">
                <button class="btn btn-xs btn-ghost text-primary" onclick="renameRoom('${safeRoomId}')" title="更新房间ID/迁移数据">🔄</button>
                <button class="btn btn-xs ${recoBtnClass}" onclick="toggleRecording('${safeRoomId}', '${safeRoomId}', this)" title="${isRecording ? '停止录制' : '开始录制'}">${recoBtnText}</button>
                <button class="btn btn-xs btn-ghost" onclick="openAddRoomModal('${safeRoomId}', '${safeName}', ${isMonitorOn}, '${r.language || '中文'}', ${r.priority}, ${isRecordingEnabled}, '${recordingAccountId}')">✏️</button>
                <button class="btn btn-xs btn-ghost text-error" onclick="deleteRoom('${safeRoomId}')">🗑️</button>

            </div>
        </td>
    </tr>`;
}

async function renderRoomList() {
    const container = $('#roomListContainer');

    // Show loading indicator immediately
    container.html(`
        <div class="col-span-full flex flex-col items-center justify-center py-20">
            <span class="loading loading-spinner loading-lg text-primary"></span>
            <p class="mt-4 text-base-content/60">加载中...</p>
        </div>
    `);

    try {
        // Build query string with pagination and search
        const params = new URLSearchParams({
            page: roomListPage,
            limit: roomListLimit,
            search: roomListSearch,
            sort: roomListSort
        });
        const result = await $.get(`/api/rooms/stats?${params}`);

        // Fetch active recordings
        try {
            const activeList = await $.get('/api/recordings/active');
            window.activeRecordingSet = new Set(activeList);
        } catch (e) {
            console.error("Failed to fetch active recordings", e);
            window.activeRecordingSet = new Set();
        }

        const rooms = result.data || [];
        const pagination = result.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 };
        roomListTotal = pagination.total;


        container.empty();

        // Render search bar with view toggle
        const searchBar = `
        <div class="col-span-full mb-4">
            <div class="flex gap-2 items-center justify-between flex-wrap">
                <div class="flex gap-2 items-center flex-1">
                    <button class="btn btn-sm btn-ghost" onclick="refreshRoomList()" title="刷新数据">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    </button>
                    <input type="text" id="roomSearchInput" 
                        class="input input-bordered input-sm flex-1 max-w-xs" 
                        placeholder="搜索房间名或账号..." 
                        value="${roomListSearch}"
                        onkeyup="if(event.key==='Enter') searchRooms()">
                    <button class="btn btn-sm btn-primary" onclick="searchRooms()">搜索</button>
                    <button class="btn btn-sm btn-ghost" onclick="clearRoomSearch()">清除</button>
                </div>
                <div class="join">
                    <button class="btn btn-sm join-item ${roomListViewMode === 'card' ? 'btn-active' : ''}" onclick="setRoomViewMode('card')" title="卡片视图">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
                    </button>
                    <button class="btn btn-sm join-item ${roomListViewMode === 'list' ? 'btn-active' : ''}" onclick="setRoomViewMode('list')" title="列表视图">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                    </button>
                </div>
            </div>
        </div>`;
        container.append(searchBar);

        if (rooms.length === 0) {
            container.append(`<div class="col-span-full text-center text-base-content/50 mt-10">
                <p>${roomListSearch ? '未找到匹配的房间' : 'No rooms monitored.'}</p>
            </div>`);
        } else if (roomListViewMode === 'list') {
            // List view - table format
            const tableHtml = `
            <div class="col-span-full overflow-x-auto">
                <table class="table table-sm w-full">
                    <thead>
                        <tr class="bg-base-200">
                            <th class="p-2 text-center">#</th>
                            <th class="p-2">房间</th>
                            <th class="p-2 text-center">时长</th>
                            <th class="p-2 text-center">进房</th>
                            <th class="p-2 text-center">弹幕</th>
                            <th class="p-2 text-center">💎本场</th>
                            <th class="p-2 text-center" title="本月总计（日均）">💎月</th>
                            ${roomListSort.includes('daily_avg') ? '<th class="p-2 text-center" title="有效日均 (开播>2h的日期)">💎日均</th>' : ''}
                            <th class="p-2 text-center">💰效率</th>
                            <th class="p-2 text-center">💬效率</th>
                            <th class="p-2 text-center">👥质量</th>
                            <th class="p-2 text-center">T1</th>
                            <th class="p-2 text-center">T3</th>
                            <th class="p-2 text-center">T10</th>
                            <th class="p-2 text-center">T30</th>
                            <th class="p-2 text-center">LZ</th>
                            <th class="p-2 text-center">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rooms.map((r, i) => renderRoomRow(r, (pagination.page - 1) * pagination.limit + i + 1)).join('')}
                    </tbody>
                </table>
            </div>`;
            container.append(tableHtml);
        } else {
            // Card view - grid format
            rooms.forEach((r, i) => {
                container.append(renderRoomCard(r, (pagination.page - 1) * pagination.limit + i + 1));
            });
        }

        // Render pagination controls (always show for page size selector)
        const paginationHtml = `
        <div class="col-span-full flex justify-center items-center gap-2 mt-6 flex-wrap">
            <div class="flex items-center gap-1">
                <span class="text-xs opacity-70">每页</span>
                <select class="select select-bordered select-xs" onchange="setRoomPageSize(this.value)">
                    <option value="20" ${roomListLimit === 20 ? 'selected' : ''}>20</option>
                    <option value="50" ${roomListLimit === 50 ? 'selected' : ''}>50</option>
                    <option value="100" ${roomListLimit === 100 ? 'selected' : ''}>100</option>
                    <option value="200" ${roomListLimit === 200 ? 'selected' : ''}>200</option>
                    <option value="500" ${roomListLimit === 500 ? 'selected' : ''}>500</option>
                </select>
            </div>
            ${pagination.totalPages > 1 ? `
            <button class="btn btn-sm" onclick="roomListGoPage(1)" ${pagination.page <= 1 ? 'disabled' : ''}>«</button>
            <button class="btn btn-sm" onclick="roomListGoPage(${pagination.page - 1})" ${pagination.page <= 1 ? 'disabled' : ''}>‹</button>
            <span class="text-sm">第 ${pagination.page} / ${pagination.totalPages} 页 (共 ${pagination.total} 个房间)</span>
            <button class="btn btn-sm" onclick="roomListGoPage(${pagination.page + 1})" ${pagination.page >= pagination.totalPages ? 'disabled' : ''}>›</button>
            <button class="btn btn-sm" onclick="roomListGoPage(${pagination.totalPages})" ${pagination.page >= pagination.totalPages ? 'disabled' : ''}>»</button>
            ` : `<span class="text-sm opacity-70">(共 ${pagination.total} 个房间)</span>`}
        </div>`;
        container.append(paginationHtml);
    } catch (err) {
        console.error('Failed to load rooms:', err);
        $('#roomListContainer').html(`<div class="alert alert-error">Error loading rooms.</div>`);
    }
}

// Pagination and search functions
function roomListGoPage(page) {
    roomListPage = page;
    renderRoomList();
}

function searchRooms() {
    roomListSearch = $('#roomSearchInput').val().trim();
    roomListPage = 1; // Reset to first page on new search
    renderRoomList();
}

function clearRoomSearch() {
    roomListSearch = '';
    roomListPage = 1;
    $('#roomSearchInput').val('');
    renderRoomList();
}

function setRoomSort(sort, btn) {
    roomListSort = sort;

    // Update active UI state
    $('.room-sort-btn').removeClass('active btn-primary').addClass('btn-ghost');
    if (btn) {
        $(btn).addClass('active btn-primary').removeClass('btn-ghost');
    }

    roomListPage = 1;
    renderRoomList();
}

function setRoomViewMode(mode) {
    roomListViewMode = mode;
    renderRoomList();
}

function setRoomPageSize(size) {
    roomListLimit = parseInt(size) || 20;
    roomListPage = 1; // Reset to first page when changing page size
    renderRoomList();
}

// Export pagination and sort functions
window.roomListGoPage = roomListGoPage;
window.searchRooms = searchRooms;
window.clearRoomSearch = clearRoomSearch;
window.setRoomSort = setRoomSort;
window.setRoomViewMode = setRoomViewMode;
window.setRoomPageSize = setRoomPageSize;

// Start auto-refresh when viewing room list
function startRoomListAutoRefresh() {
    stopRoomListAutoRefresh(); // Clear any existing timer
    roomListRefreshTimer = setInterval(() => {
        // Only refresh if currently viewing room list section
        if (window.currentSection === 'roomList') {
            renderRoomList();
        }
    }, ROOM_LIST_REFRESH_INTERVAL);
    console.log('[RoomList] Auto-refresh started (5s interval)');
}

// Stop auto-refresh
function stopRoomListAutoRefresh() {
    if (roomListRefreshTimer) {
        clearInterval(roomListRefreshTimer);
        roomListRefreshTimer = null;
        console.log('[RoomList] Auto-refresh stopped');
    }
}

// Auto-refresh is DISABLED - user requested manual refresh only
// $(document).ready(() => {
//     startRoomListAutoRefresh();
// });

// Manual refresh function
function refreshRoomList() {
    renderRoomList();
}
window.refreshRoomList = refreshRoomList;

async function toggleMonitor(roomId, enabled, name, address) {
    // We reuse the update endpoint - must send as JSON
    try {
        await $.ajax({
            url: '/api/rooms',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                roomId: roomId,
                name: name,
                address: address,
                isMonitorEnabled: enabled
            })
        });
        console.log(`Updated monitor for ${roomId} to ${enabled}`);
    } catch (e) {
        alert('Update failed: ' + (e.responseText || e.statusText));
    }
}

// Fetch accounts for the select dropdown
window.fetchAccountsForSelect = async function () {
    try {
        const res = await $.get('/api/tiktok_accounts');
        const accounts = res.accounts || [];
        const select = $('#roomRecordingAccount');
        const currentVal = select.val();

        select.empty();
        select.append('<option value="">(无指定 / 匿名)</option>');

        accounts.forEach(acc => {
            const label = `${acc.username || acc.id} ${acc.isActive ? '🟢' : '🔴'}`; // Use isActive (camelCase from DB wrapper)
            select.append(new Option(label, acc.id));
        });

        if (currentVal) select.val(currentVal);
    } catch (e) {
        console.error("Failed to load accounts for select", e);
    }
};

function openAddRoomModal(id = null, name = null, isMonitorOn = true, language = '中文', priority = 0, isRecordingOn = false, recordingAccount = null) {
    // Populate account select if not already done (assuming populated on load or demand)
    // We should probably trigger a refresh of accounts here just in case? Or rely on periodic?
    // Let's assume fetchAccounts() or similar is available or just call the API.
    // For now, let's just populate the fields.

    // Reload accounts (from global cache or fetch new)
    // We'll rely on a global function or direct call.
    if (window.fetchAccountsForSelect) {
        window.fetchAccountsForSelect();
    }

    if (id && id !== 'undefined' && id !== 'null') { // check string 'null' if called from template
        $('#editRoomIdRaw').val(id);
        $('#roomUniqueId').val(id).prop('disabled', true);
        $('#roomNameInput').val(name);
        $('#roomMonitorToggle').prop('checked', isMonitorOn);
        if (language) $('#roomLanguage').val(language);
        $('#roomPriority').val(priority || 0);

        // Recording settings
        $('#roomAutoRecordToggle').prop('checked', isRecordingOn);
        // We'll set the value after the select is populated, but since fetch is async, 
        // we might need a small delay or better architectural approach.
        // For simplicity, we set it and hope options are there or will be set.
        setTimeout(() => {
            $('#roomRecordingAccount').val(recordingAccount || '');
        }, 100);
    } else {
        $('#editRoomIdRaw').val('');
        $('#roomUniqueId').val('').prop('disabled', false);
        $('#roomNameInput').val('');
        $('#roomMonitorToggle').prop('checked', true);
        $('#roomLanguage').val('中文');
        $('#roomPriority').val(0);

        $('#roomAutoRecordToggle').prop('checked', false);
        $('#roomRecordingAccount').val('');
    }
    document.getElementById('roomModal').showModal();
}


function closeRoomModal() {
    document.getElementById('roomModal').close();
}

function enterRoom(id, name) {
    $('#detailRoomName').text(name || id);
    $('#detailRoomId').text(id);
    if (window.loadRoom) window.loadRoom(id);
    if (window.switchSection) window.switchSection('roomDetail');
}

// Global Exports
window.renderRoomList = renderRoomList;
window.openAddRoomModal = openAddRoomModal;
window.closeRoomModal = closeRoomModal;
window.enterRoom = enterRoom;
window.deleteRoom = async function (id) {
    if (!confirm('确定要删除该房间吗?')) return;
    try {
        // URL-encode room ID to handle special characters like @
        await $.ajax({ url: `/api/rooms/${encodeURIComponent(id)}`, type: 'DELETE' });
        // Remove the DOM element instead of refreshing the entire list
        $(`[data-room-id="${escapeHtml(id)}"]`).fadeOut(300, function () { $(this).remove(); });
    } catch (e) { alert(e.statusText); }
};
window.saveRoom = async function () {
    const id = $('#roomUniqueId').val().trim();
    const name = $('#roomNameInput').val().trim();
    const isMonitor = $('#roomMonitorToggle').is(':checked');
    const isRecording = $('#roomAutoRecordToggle').is(':checked');
    const recAccount = $('#roomRecordingAccount').val() || null;
    const language = $('#roomLanguage').val();
    const priority = parseInt($('#roomPriority').val()) || 0;
    const isEdit = $('#editRoomIdRaw').val().trim() !== '';

    if (!id) return alert('ID required');
    try {
        await $.ajax({
            url: '/api/rooms',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                roomId: id,
                name: name,
                isMonitorEnabled: isMonitor,
                language: language,
                priority: priority,
                isRecordingEnabled: isRecording,
                recordingAccountId: recAccount
            })
        });
        closeRoomModal();

        if (isEdit) {
            // Update DOM element instead of refreshing the entire list
            const el = $(`[data-room-id="${escapeHtml(id)}"]`);
            // Update name in card view
            el.find('.card-title').text(name || '未命名').attr('title', name);
            // Update name in list view
            el.find('.font-bold.truncate').text(name || '未命名').attr('title', name);
            // Update monitor toggle
            el.find('.toggle-success').prop('checked', isMonitor);
            // Flash the element to indicate success
            el.addClass('ring-2 ring-primary');
            setTimeout(() => el.removeClass('ring-2 ring-primary'), 1000);
        } else {
            // New room - need to refresh to show it
            renderRoomList();
        }
    } catch (e) { alert('Save failed: ' + e.statusText); }
};

window.renameRoom = async function (oldRoomId) {
    const newRoomId = prompt(`请输入新的房间ID (将迁移 ${oldRoomId} 的所有数据):`);
    if (!newRoomId || newRoomId === oldRoomId) return;

    if (!confirm(`确定要将 ${oldRoomId} 重命名为 ${newRoomId} 吗?\n此操作将在后台迁移历史数据，请稍候...`)) return;

    try {
        await $.ajax({
            url: `/api/rooms/${encodeURIComponent(oldRoomId)}/rename`,
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ newRoomId })
        });
        alert('迁移成功!');
        renderRoomList();
    } catch (e) {
        console.error(e);
        alert('迁移失败: ' + (e.responseJSON?.error || e.statusText));
    }
};
