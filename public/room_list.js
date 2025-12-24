// State variables for pagination and search
let roomListPage = 1;
let roomListLimit = 20;
let roomListSearch = '';
let roomListSort = 'default';
let roomListTotal = 0;
let roomListViewMode = 'card'; // 'card' or 'list'
let roomListRefreshTimer = null; // Timer for auto-refresh
const ROOM_LIST_REFRESH_INTERVAL = 10000; // 10 seconds for listing is enough

// Helper to escape strings for use in HTML attributes
const escapeHtml = (str) => String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');

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
    const safeRoomId = escapeHtml(r.roomId);
    const safeName = escapeHtml(r.name || '');

    return `
    <div class="card bg-base-100 shadow-xl border border-base-200 hover:border-primary transition-colors">
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
                <div class="stat p-2 place-items-center">
                    <div class="stat-title text-[10px] uppercase tracking-wider">💎T</div>
                    <div class="stat-value text-sm text-success font-mono">${(r.allTimeGiftValue || 0).toLocaleString()}</div>
                </div>
                ${roomListSort.includes('daily_avg') ? `
                <div class="stat p-2 place-items-center" title="有效日均 (开播>3h的日期)&#10;有效天数: ${r.validDays || 0}天">
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
                    <button class="btn btn-xs btn-ghost" onclick="openAddRoomModal('${safeRoomId}', '${safeName}', ${isMonitorOn})">编辑</button>
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
    const safeRoomId = escapeHtml(r.roomId);
    const safeName = escapeHtml(r.name || '');

    return `
    <tr class="hover:bg-base-200 cursor-pointer" onclick="enterRoom('${safeRoomId}', '${safeName}')">
        <td class="p-2 text-center font-mono text-sm opacity-60">${index}</td>
        <td class="p-2">
            <div class="flex items-center gap-2">
                <span class="text-lg" title="${isLive ? '直播中' : '未开播'}">${statusText}</span>
                <div>
                    <div class="font-bold truncate max-w-[120px]" title="${r.name}">${r.name || '未命名'}</div>
                    <div class="text-xs opacity-50 cursor-pointer hover:opacity-100" onclick="event.stopPropagation();copyToClipboard('${safeRoomId}', event)" title="点击复制">${r.roomId}</div>
                </div>
            </div>
        </td>
        <td class="p-2 text-center font-mono text-xs opacity-60" title="本场时长">${duration}</td>
        <td class="p-2 text-center font-mono text-sm">${(r.totalVisits || 0).toLocaleString()}</td>
        <td class="p-2 text-center font-mono text-sm">${(r.totalComments || 0).toLocaleString()}</td>
        <td class="p-2 text-center font-mono text-sm text-warning">${(r.totalGiftValue || 0).toLocaleString()}</td>
        <td class="p-2 text-center font-mono text-sm text-success">${(r.allTimeGiftValue || 0).toLocaleString()}</td>
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
                <button class="btn btn-xs btn-ghost" onclick="openAddRoomModal('${safeRoomId}', '${safeName}', ${isMonitorOn})">✏️</button>
                <button class="btn btn-xs btn-ghost text-error" onclick="deleteRoom('${safeRoomId}')">🗑️</button>
            </div>
        </td>
    </tr>`;
}

async function renderRoomList() {
    try {
        // Build query string with pagination and search
        const params = new URLSearchParams({
            page: roomListPage,
            limit: roomListLimit,
            search: roomListSearch,
            sort: roomListSort
        });
        const result = await $.get(`/api/rooms/stats?${params}`);
        const rooms = result.data || [];
        const pagination = result.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 };
        roomListTotal = pagination.total;

        const container = $('#roomListContainer');
        container.empty();

        // Render search bar with view toggle
        const searchBar = `
        <div class="col-span-full mb-4">
            <div class="flex gap-2 items-center justify-between flex-wrap">
                <div class="flex gap-2 items-center flex-1">
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
                            <th class="p-2 text-center">💎总计</th>
                            ${roomListSort.includes('daily_avg') ? '<th class="p-2 text-center" title="有效日均 (开播>3h的日期)">💎日均</th>' : ''}
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

// Auto-start refresh on page load
$(document).ready(() => {
    startRoomListAutoRefresh();
});

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

function openAddRoomModal(id = null, name = null, isMonitorOn = true) {
    if (id && id !== 'undefined' && id !== 'null') { // check string 'null' if called from template
        $('#editRoomIdRaw').val(id);
        $('#roomUniqueId').val(id).prop('disabled', true);
        $('#roomNameInput').val(name);
        $('#roomMonitorToggle').prop('checked', isMonitorOn);
    } else {
        $('#editRoomIdRaw').val('');
        $('#roomUniqueId').val('').prop('disabled', false);
        $('#roomNameInput').val('');
        $('#roomMonitorToggle').prop('checked', true);
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
        renderRoomList();
    } catch (e) { alert(e.statusText); }
};
window.saveRoom = async function () {
    const id = $('#roomUniqueId').val().trim();
    const name = $('#roomNameInput').val().trim();
    const isMonitor = $('#roomMonitorToggle').is(':checked');
    const language = $('#roomLanguage').val();

    if (!id) return alert('ID required');
    try {
        await $.ajax({
            url: '/api/rooms',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ roomId: id, name: name, isMonitorEnabled: isMonitor, language: language })
        });
        closeRoomModal();
        renderRoomList();
    } catch (e) { alert('Save failed: ' + e.statusText); }
};
