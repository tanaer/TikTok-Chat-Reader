
// room_list.js - DaisyUI Version

let roomListRefreshTimer = null;
const ROOM_LIST_REFRESH_INTERVAL = 5000; // 5 seconds

async function renderRoomList() {
    try {
        const rooms = await $.get('/api/rooms/stats');
        const container = $('#roomListContainer');
        container.empty();

        if (rooms.length === 0) {
            container.append(`<div class="col-span-full text-center text-base-content/50 mt-10">
                <p>No rooms monitored.</p>
                <button class="btn btn-primary mt-4" onclick="openAddRoomModal()">Add Room</button>
            </div>`);
            return;
        }

        rooms.forEach(r => {
            // Use isLive from API response
            const isLive = r.isLive === true;
            const badgeClass = isLive ? 'badge-success' : 'badge-ghost';
            const statusText = isLive ? '🟢 直播中' : '未开播';
            const lastSession = r.lastSessionTime ? new Date(r.lastSessionTime).toLocaleString() : '无记录';
            const isMonitorOn = r.is_monitor_enabled !== 0; // Default 1

            const card = `
            <div class="card bg-base-100 shadow-xl border border-base-200 hover:border-primary transition-colors">
                <div class="card-body p-5">
                    <div class="flex justify-between items-start">
                        <div>
                            <h2 class="card-title text-lg font-bold truncate w-40" title="${r.name}">${r.name || '未命名'}</h2>
                            <div class="badge badge-outline badge-sm mt-1 opacity-70">${r.room_id}</div>
                        </div>
                        <div class="flex flex-col items-end gap-1">
                            <div class="badge ${badgeClass} badge-sm">${statusText}</div>
                            <label class="label cursor-pointer p-0 gap-2">
                                <span class="label-text text-xs opacity-70">录制</span> 
                                <input type="checkbox" class="toggle toggle-xs toggle-success" 
                                    onchange="toggleMonitor('${r.room_id}', this.checked, '${r.name}', '${r.address || ''}')"
                                    ${isMonitorOn ? 'checked' : ''} />
                            </label>
                        </div>
                    </div>
                    
                    <div class="stats stats-horizontal shadow-sm my-4 bg-base-200 w-full overflow-hidden">
                        <div class="stat p-2 place-items-center">
                            <div class="stat-title text-[10px] uppercase tracking-wider">进房</div>
                            <div class="stat-value text-sm font-mono">${(r.totalVisits || 0).toLocaleString()}</div>
                        </div>
                        <div class="stat p-2 place-items-center">
                            <div class="stat-title text-[10px] uppercase tracking-wider">💬弹幕</div>
                            <div class="stat-value text-sm font-mono">${(r.totalComments || 0).toLocaleString()}</div>
                        </div>
                        <div class="stat p-2 place-items-center">
                            <div class="stat-title text-[10px] uppercase tracking-wider">💎礼物</div>
                            <div class="stat-value text-sm text-warning font-mono">${(r.totalGiftValue || 0).toLocaleString()}</div>
                        </div>
                    </div>

                    <div class="text-xs text-base-content/40 mb-4 flex items-center gap-1">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        上次: ${lastSession}
                    </div>

                    <div class="card-actions justify-end mt-auto">
                         <button class="btn btn-xs btn-ghost text-error" onclick="deleteRoom('${r.room_id}')">删除</button>
                         <button class="btn btn-xs btn-ghost" onclick="openAddRoomModal('${r.room_id}', '${r.name}', ${isMonitorOn})">编辑</button>
                         <button class="btn btn-sm btn-primary" onclick="enterRoom('${r.room_id}', '${r.name}')">进入</button>
                    </div>
                </div>
            </div>`;
            container.append(card);
        });
    } catch (err) {
        console.error('Failed to load rooms:', err);
        $('#roomListContainer').html(`<div class="alert alert-error">Error loading rooms.</div>`);
    }
}

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
        await $.ajax({ url: `/api/rooms/${id}`, type: 'DELETE' });
        renderRoomList();
    } catch (e) { alert(e.statusText); }
};
window.saveRoom = async function () {
    const id = $('#roomUniqueId').val().trim();
    const name = $('#roomNameInput').val().trim();
    const isMonitor = $('#roomMonitorToggle').is(':checked');

    if (!id) return alert('ID required');
    try {
        await $.ajax({
            url: '/api/rooms',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ roomId: id, name: name, isMonitorEnabled: isMonitor })
        });
        closeRoomModal();
        renderRoomList();
    } catch (e) { alert('Save failed: ' + e.statusText); }
};
