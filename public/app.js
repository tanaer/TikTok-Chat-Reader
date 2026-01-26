
// app.js - Main Application Logic

let socket = null;
let currentSection = 'roomList';
let currentDetailRoomId = null;
let currentSessionId = 'live'; // 'live' or session UUID
let roomIsLive = false;
let connectedRoomId = null; // Track actually connected room to prevent cross-room event display

// Initialization
$(document).ready(() => {
    initSocket();

    // Initial Load
    loadConfig(); // from config.js
    renderRoomList(); // from room_list.js

    // Event Listeners (Global)
    // ...
});

function initSocket() {
    socket = io();

    // Connection Events
    socket.on('connect', () => {
        console.log('Connected to backend');
    });

    socket.on('tiktokConnected', (state) => {
        console.log('TikTok Connected:', state);
        connectedRoomId = state.roomId || null;
        if (currentSection === 'roomDetail' && state.roomId) {
            addSystemMessage(`Connected to Room: ${state.roomId}`);
            updateRoomStatusUI(true);
        }
    });

    socket.on('tiktokDisconnected', (reason) => {
        console.log('TikTok Disconnected:', reason);
        connectedRoomId = null; // Clear connected room on disconnect
        addSystemMessage(`Disconnected: ${reason}`);
        if (currentSection === 'roomDetail') updateRoomStatusUI(false);
    });

    socket.on('streamEnd', () => {
        addSystemMessage('Stream Ended.');
        if (currentSection === 'roomDetail') updateRoomStatusUI(false);
    });

    // Chat Events
    socket.on('chat', (msg) => {
        if (!isViewingLive()) return;
        addChatMessage(msg);
    });

    socket.on('gift', (msg) => {
        if (!isViewingLive()) return;
        addGiftMessage(msg);
        updateGiftStats(msg);
    });

    socket.on('member', (msg) => {
        if (!isViewingLive()) return;
        updateMemberStats(msg);
    });

    socket.on('like', (msg) => {
        if (!isViewingLive()) return;
        updateLikeStats(msg);
    });
}

// Navigation
function switchSection(sectionId) {
    currentSection = sectionId;
    $('.content-section').hide();
    $(`#section-${sectionId}`).show();

    // Update Nav Active State
    $('.nav-btn').removeClass('active');
    $(`.nav-btn[onclick="switchSection('${sectionId}')"]`).addClass('active');

    if (sectionId === 'roomList') {
        renderRoomList();
    } else if (sectionId === 'userAnalysis') {
        // Only auto-render if not coming from searchUserExact (which handles its own render)
        if (!window._pendingUserSearch && typeof renderUserList === 'function') {
            renderUserList();
        }
    } else if (sectionId === 'systemConfig') {
        if (typeof loadConfig === 'function') loadConfig();
    } else if (sectionId === 'roomAnalysis') {
        if (typeof initRoomAnalysis === 'function') initRoomAnalysis();
    }
}

// =======================
// Room Detail Logic
// =======================

async function loadRoom(id) {
    currentDetailRoomId = id;
    $('#detailRoomId').text(id);
    $('#chatContainer').empty();

    // Show loading state
    showLoadingState();

    try {
        // First check if room is live and get session list
        const [statsRes, sessions] = await Promise.all([
            $.get(`/api/rooms/${id}/stats_detail?sessionId=live`),
            $.get(`/api/rooms/${id}/sessions`)
        ]);

        // Load all-time leaderboards in background (don't block UI)
        loadAlltimeLeaderboards(id);

        roomIsLive = statsRes.isLive === true;

        // Populate session dropdown
        const select = $('#sessionSelect');
        select.empty();
        select.append('<option value="live">🟢 实时直播 (LIVE)</option>');

        if (sessions && sessions.length > 0) {
            sessions.forEach(s => {
                // Use createdAt or endTime as display, fallback to session ID if both null
                const displayTime = s.createdAt || s.endTime;
                const dateStr = displayTime ? new Date(displayTime).toLocaleString() : `场次 ${s.sessionId}`;
                select.append(`<option value="${s.sessionId}">${dateStr} (存档)</option>`);
            });
        }

        if (roomIsLive) {
            // Room is live - auto-connect and show live data
            currentSessionId = 'live';
            select.val('live');
            hideLoadingState();
            updateRoomStatusUI(true);
            addSystemMessage('🟢 房间正在直播中，已自动接入实时数据');

            // Auto-connect to live stream
            connectToLive(id);

            // Show stats
            updateRoomHeader(statsRes.summary);
            updateLeaderboards(statsRes.leaderboards);

        } else if (sessions && sessions.length > 0) {
            // Not live - auto-select last session
            const lastSessionId = sessions[0].sessionId;
            currentSessionId = lastSessionId;
            select.val(lastSessionId);

            // Load last session stats
            const lastStats = await $.get(`/api/rooms/${id}/stats_detail?sessionId=${lastSessionId}`);
            hideLoadingState();
            updateRoomStatusUI(false);
            const lastSessionTime = sessions[0].createdAt || sessions[0].endTime;
            const lastSessionStr = lastSessionTime ? new Date(lastSessionTime).toLocaleString() : `场次 ${lastSessionId}`;
            addSystemMessage(`📼 房间未开播，已加载最近一场数据 (${lastSessionStr})`);


            updateRoomHeader(lastStats.summary);
            updateLeaderboards(lastStats.leaderboards);

        } else {
            // No sessions and not live - show empty state
            currentSessionId = 'live';
            select.val('live');
            hideLoadingState();
            updateRoomStatusUI(false);
            addSystemMessage('⚠️ 该房间暂无任何数据');

            // Show empty data
            updateRoomHeader({ duration: 0, totalVisits: 0, totalComments: 0, totalLikes: 0, totalGiftValue: 0 });
            updateLeaderboards({ gifters: [], chatters: [], likers: [] });
        }

    } catch (err) {
        console.error('loadRoom error:', err);
        hideLoadingState();
        addSystemMessage('❌ 加载失败: ' + err.message);
    }
}

function showLoadingState() {
    $('#d_duration').text('--:--');
    $('#d_member, #d_like, #d_gift').text('...');
    $('#info_totalLikes, #info_totalComments, #info_totalGift, #info_maxViewers').text('...');
    $('#giftTable tbody, #topGiftersTable tbody, #topContributorsTable tbody, #topLikersTable tbody')
        .html('<tr><td colspan="3" class="text-center"><span class="loading loading-spinner loading-sm"></span> 加载中...</td></tr>');
}

function hideLoadingState() {
    // Loading complete - tables will be updated by updateLeaderboards
}

function exitRoom() {
    switchSection('roomList');
}

async function loadSessionList(roomId) {
    // Now handled in loadRoom for better control
}

function changeSession(val) {
    currentSessionId = val;
    $('#chatContainer').empty();

    if (val === 'live') {
        addSystemMessage('切换到实时视图');
        if (roomIsLive) {
            connectToLive(currentDetailRoomId);
        }
        loadDetailStats(currentDetailRoomId, 'live');
    } else {
        disconnectLive();
        loadHistoryData(val);
        loadDetailStats(currentDetailRoomId, val);
    }
}

async function loadDetailStats(roomId, sessionId) {
    try {
        const res = await $.get(`/api/rooms/${roomId}/stats_detail?sessionId=${sessionId}`);
        updateRoomHeader(res.summary);
        updateLeaderboards(res.leaderboards);
    } catch (e) { console.error('Stats load error', e); }
}

function updateRoomHeader(summary) {
    if (!summary) return;
    $('#d_duration').text(formatDuration(summary.duration));
    $('#d_member').text(summary.totalVisits.toLocaleString());
    $('#d_like').text(summary.totalLikes.toLocaleString());
    $('#d_gift').text(summary.totalGiftValue.toLocaleString());

    // Update Info Side Panel
    $('#info_totalLikes').text(summary.totalLikes.toLocaleString());
    $('#info_totalComments').text(summary.totalComments.toLocaleString());
    $('#info_totalGift').text(summary.totalGiftValue.toLocaleString());
    $('#info_maxViewers').text(summary.totalVisits.toLocaleString());

    // Start Time from database
    if (summary.startTime) {
        const start = new Date(summary.startTime);
        $('#info_startTime').text(start.toLocaleString('zh-CN'));
    } else {
        $('#info_startTime').text('未开播');
    }
}

function formatDuration(sec) {
    if (!sec) return '00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateLeaderboards(boards) {
    if (!boards) return;

    // Gift Stats Table (礼物明细 Tab - shows per-user per-gift breakdown)
    renderGiftTable('#giftTable tbody', boards.giftDetails);

    // Current Session Leaderboards (本场榜)
    renderTopTable('#currentGiftersTable tbody', boards.gifters, '💎', 'value');
    renderTopTable('#currentChattersTable tbody', boards.chatters, '💬', 'count');
    renderTopTable('#currentLikersTable tbody', boards.likers, '❤️', 'count');

    // Also update old tables for compatibility with room list
    renderTopTable('#topGiftersTable tbody', boards.gifters, '💎', 'value');
    renderTopTable('#topContributorsTable tbody', boards.chatters, '💬', 'count');
    renderTopTable('#topLikersTable tbody', boards.likers, '❤️', 'count');
}

function renderGiftTable(selector, data) {
    const tbody = $(selector);
    tbody.empty();
    if (!data || data.length === 0) {
        tbody.append('<tr><td colspan="5" class="text-center opacity-50">暂无数据</td></tr>');
        return;
    }
    data.forEach(row => {
        const account = row.uniqueId || row.nickname || '匿名';
        const giftName = row.giftName || '未知礼物';
        const count = row.count || 1;
        const unitPrice = row.unitPrice || 0;
        const totalValue = row.totalValue || 0;
        tbody.append(`<tr>
            <td>${account}</td>
            <td>${giftName}</td>
            <td class="text-right">${count.toLocaleString()}</td>
            <td class="text-right">💎 ${unitPrice.toLocaleString()}</td>
            <td class="text-right">💎 ${totalValue.toLocaleString()}</td>
        </tr>`);
    });
}

function renderTopTable(selector, data, icon, valueKey) {
    const tbody = $(selector);
    tbody.empty();
    if (!data || data.length === 0) {
        tbody.append('<tr><td colspan="2" class="text-center opacity-50">暂无数据</td></tr>');
        return;
    }
    data.forEach(row => {
        const val = row[valueKey] || row.value || row.count || 0;
        tbody.append(`<tr><td>${row.nickname || '匿名'}</td><td>${icon} ${val.toLocaleString()}</td></tr>`);
    });
}

function connectToLive(roomId) {
    addSystemMessage(`Connecting to ${roomId} live...`);
    socket.emit('setUniqueId', roomId);
    if (socket) socket.emit('connectTiktok');
}

function disconnectLive() {
    // Only unsubscribe from UI events - DO NOT stop recording!
    // Use 'unsubscribe' instead of 'requestDisconnect' to keep recording active
    socket.emit('unsubscribe');
    console.log('Switched to history view, unsubscribed from live events. Recording continues.');
}

async function loadHistoryData(sessionId) {
    addSystemMessage(`Loading session ${sessionId}...`);
    addSystemMessage("History playback not fully implemented yet (requires Event Replay API). Showing Metadata only.");

    const session = await $.get(`/api/sessions/${sessionId}`);
    addSystemMessage(`Session Info: ${JSON.stringify(session)}`);
}

function isViewingLive() {
    // Must be viewing room detail, in live mode, AND the connected room matches
    return currentSection === 'roomDetail' &&
        currentSessionId === 'live' &&
        connectedRoomId === currentDetailRoomId;
}

// UI Helpers
function addSystemMessage(text) {
    $('#chatContainer').append(`<div class="chat-message text-center text-xs opacity-50 py-1">[System] ${text}</div>`);
    scrollToBottom();
}

window.stopCurrentRecord = async function () {
    if (!currentDetailRoomId) return;
    if (!confirm('确定要停止当前房间的自动录制吗? (如果您在自动录制期间停止，可能会导致本场实录被切断)')) return;

    try {
        await $.post(`/api/rooms/${currentDetailRoomId}/stop`);
        addSystemMessage('已发送停止录制请求。');
        $('#stopRecordBtn').addClass('hidden');
    } catch (e) {
        alert('停止失败: ' + (e.responseText || e.statusText));
    }
};

// Manual save session
window.saveCurrentSession = async function () {
    if (!currentDetailRoomId) return;
    if (!confirm('确定要手动保存当前场次数据吗?')) return;

    try {
        const now = new Date().toISOString();
        await $.ajax({
            url: '/api/sessions/end',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                roomId: currentDetailRoomId,
                snapshot: { manual: true, savedAt: now },
                startTime: null
            })
        });
        addSystemMessage('✅ 场次数据已保存');
        // Refresh session list
        loadRoom(currentDetailRoomId);
    } catch (e) {
        alert('保存失败: ' + (e.responseText || e.statusText));
    }
};

// Expose checks for UI updates
function updateRoomStatusUI(isLive) {
    if (isLive) {
        $('#stopRecordBtn').removeClass('hidden');
        $('#connectBtn').addClass('hidden');
        $('#saveSessionBtn').removeClass('hidden');
    } else {
        $('#stopRecordBtn').addClass('hidden');
        $('#connectBtn').removeClass('hidden');
        $('#saveSessionBtn').addClass('hidden');
    }
}

function addChatMessage(msg) {
    const div = `<div class="chat-message hover:bg-base-200 transition-colors">
        <span class="nickname text-accent">${msg.nickname}:</span>
        <span class="comment text-base-content">${msg.comment}</span>
    </div>`;
    $('#chatContainer').append(div);
    scrollToBottom();
}

function addGiftMessage(msg) {
    const div = `<div class="chat-message gift bg-yellow-900/20 border-l-2 border-yellow-500 pl-2">
        <span class="nickname text-yellow-400">${msg.nickname}</span>
        <span class="text-sm">sent ${msg.giftName} x${msg.repeatCount} 💎${msg.diamondCount}</span>
    </div>`;
    $('#chatContainer').append(div);
    scrollToBottom();
}

function updateGiftStats(msg) {
    // Basic aggregation for UI table
}

function updateMemberStats(msg) {
    // ...
}

function updateLikeStats(msg) {
    // ...
}

function scrollToBottom() {
    const el = $('#chatContainer');
    el.scrollTop(el[0].scrollHeight);
}

function clearStats() {
    $('#giftTable tbody').empty();
    // ...
}

// Update tab switching for DaisyUI
function switchDetailTab(tabId, btnElement) {
    $('#section-roomDetail .tab').removeClass('tab-active');
    $(btnElement).addClass('tab-active');
    $('.detail-tab-content').addClass('hidden');
    $(`#tab-${tabId}`).removeClass('hidden');

    if (tabId === 'timeStats') {
        renderRoomTimeChart(currentDetailRoomId);
    }
}

async function renderRoomTimeChart(roomId) {
    const ctx = document.getElementById('roomTimeChart');
    if (!ctx) return;

    // Show loading in chart area maybe?

    try {
        const stats = await $.get(`/api/history?roomId=${roomId}`);

        const labels = stats.map(s => s.time_range);
        const incomeData = stats.map(s => s.income);
        const chatData = stats.map(s => s.comments);

        const existingChart = Chart.getChart(ctx);
        if (existingChart) existingChart.destroy();

        new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: '礼物流水 (💎)',
                        data: incomeData,
                        borderColor: '#fbbf24',
                        backgroundColor: '#fbbf2433',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: '弹幕数量',
                        data: chatData,
                        borderColor: '#3abff8',
                        backgroundColor: '#3abff833',
                        fill: true,
                        tension: 0.4,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: '礼物 💎', font: { size: 10 } }
                    },
                    y1: {
                        beginAtZero: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: '弹幕', font: { size: 10 } }
                    },
                    x: {
                        ticks: { font: { size: 8 }, maxRotation: 45, minRotation: 45 }
                    }
                },
                plugins: {
                    legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } }
                }
            }
        });
    } catch (e) {
        console.error('Failed to load room time stats', e);
    }
}

// All-Time Leaderboards Functions
async function loadAlltimeLeaderboards(roomId) {
    try {
        const data = await $.get(`/api/rooms/${roomId}/alltime-leaderboards`);
        renderAlltimeTable('#alltimeGiftersTable tbody', data.gifters, '💎', 'value');
        renderAlltimeTable('#alltimeChattersTable tbody', data.chatters, '💬', 'count');
        renderAlltimeTable('#alltimeLikersTable tbody', data.likers, '❤️', 'count');
    } catch (err) {
        console.error('Failed to load all-time leaderboards:', err);
    }
}

function renderAlltimeTable(selector, data, icon, valueKey) {
    const tbody = $(selector);
    tbody.empty();
    if (!data || data.length === 0) {
        tbody.append('<tr><td colspan="2" class="text-center opacity-50 text-xs">暂无数据</td></tr>');
        return;
    }
    data.forEach((row, i) => {
        const val = row[valueKey] || row.value || row.count || 0;
        const rank = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
        const uniqueId = row.uniqueId || '';
        // Make user name clickable to search in user analysis
        const nameCell = uniqueId
            ? `<a href="javascript:void(0)" class="link link-hover text-accent" onclick="searchUserExact('${uniqueId.replace(/'/g, "\\'")}')" title="点击精确搜索该用户">${row.nickname || '匿名'}</a>`
            : `${row.nickname || '匿名'}`;
        tbody.append(`<tr><td class="truncate max-w-[80px]">${rank} ${nameCell}</td><td class="text-right font-mono">${val.toLocaleString()}</td></tr>`);
    });
}

// Search user with exact match - navigate to User Analysis section
// Track source room for "back" functionality
let userAnalysisSourceRoom = null;

function searchUserExact(uniqueId) {
    // Remember the source room for "back" button
    userAnalysisSourceRoom = currentDetailRoomId;

    // Set flag to prevent auto-render in switchSection
    window._pendingUserSearch = true;

    // Clear any existing filters BEFORE switching section
    $('#userLangFilter').val('');
    $('#userLanguageFilter').val('');
    $('#userMinRooms').val('1');
    $('#userActiveHour').val('');
    $('#userActiveHourEnd').val('');
    $('#userGiftPreference').val('');
    $('#userSearch').val(uniqueId);
    $('#userSearchMode').val('exact');

    // Reset page via global setter
    if (typeof window.resetUserListPage === 'function') {
        window.resetUserListPage();
    }

    // Now switch section (won't trigger auto-render due to flag)
    switchSection('userAnalysis');

    // Clear the flag
    window._pendingUserSearch = false;

    // Show back button if we came from a room
    if (userAnalysisSourceRoom) {
        showBackToRoomButton(userAnalysisSourceRoom);
    }

    // Trigger the search with new params
    if (typeof renderUserList === 'function') {
        renderUserList();
    }
}

function showBackToRoomButton(roomId) {
    // Remove existing back button if any
    $('#backToRoomBtn').remove();

    // Add back button at the top of user analysis section
    const backBtn = $(`<button id="backToRoomBtn" class="btn btn-sm btn-outline btn-primary gap-1 mb-4" onclick="backToRoom('${roomId}')">
        ← 返回房间 ${roomId}
    </button>`);

    // Insert before the sub-nav buttons
    $('#section-userAnalysis .flex.gap-2.mb-4').before(backBtn);
}

function backToRoom(roomId) {
    userAnalysisSourceRoom = null;
    $('#backToRoomBtn').remove();
    // Clear search
    $('#userSearch').val('');
    // Switch to room detail and load the room
    switchSection('roomDetail');
    loadRoom(roomId);
}
window.searchUserExact = searchUserExact;
window.backToRoom = backToRoom;

function switchAlltimeTab(tabId, btnElement) {
    // Toggle tabs
    $('.alltime-tab').removeClass('tab-active');
    $(btnElement).addClass('tab-active');
    // Toggle content
    $('.alltime-tab-content').addClass('hidden');
    $(`#alltime-${tabId}`).removeClass('hidden');
}

// New outer tab switching for 本场榜 vs 历史榜
function switchLeaderboardOuterTab(tabId, btnElement) {
    // Toggle outer tab buttons
    $('.leaderboard-outer-tab').removeClass('tab-active');
    $(btnElement).addClass('tab-active');
    // Toggle outer content panels
    $('.leaderboard-outer-content').addClass('hidden');
    $(`#leaderboard-${tabId}`).removeClass('hidden');
}

// Current session inner tab switching
function switchCurrentTab(tabId, btnElement) {
    // Toggle tabs
    $('.current-tab').removeClass('tab-active');
    $(btnElement).addClass('tab-active');
    // Toggle content
    $('.current-tab-content').addClass('hidden');
    $(`#current-${tabId}`).removeClass('hidden');
}

// Assign to window for inline onclick handlers
window.switchDetailTab = switchDetailTab;
window.changeSession = changeSession;
window.exitRoom = exitRoom;
window.connectToLive = connectToLive;
window.saveCurrentSession = saveCurrentSession;
window.stopCurrentRecord = stopCurrentRecord;
window.switchAlltimeTab = switchAlltimeTab;
window.switchLeaderboardOuterTab = switchLeaderboardOuterTab;
window.switchCurrentTab = switchCurrentTab;
