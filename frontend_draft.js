
// ... (previous code)

function loadRoom(id) {
    currentDetailRoomId = id;
    $('#detailRoomId').text(id);

    // Fetch sessions
    loadSessionList(id);

    // Default to Live but DO NOT AUTO CONNECT
    // User wants "background maintenance", so we just show stats.
    // changeSession('live'); 
    // Updated: Just set ID, don't trigger connect.
    currentSessionId = 'live';
    $('#sessionSelect').val('live');

    // Load Stats immediately
    loadDetailStats(id, 'live');

    addSystemMessage('已进入房间详情。点击"连接直播"以查看实时弹幕 (后台自动录制不受影响)');

    // Add a manual connect button in the UI if not present
    // We will handle this in index.html update
}

// ...

function changeSession(val) {
    currentSessionId = val;
    $('#chatContainer').empty();
    // clearStats(); // Keep stats? 

    if (val === 'live') {
        // connectToLive(currentDetailRoomId); // Disable auto connect
        addSystemMessage('切换到实时视图 (未连接)');
        loadDetailStats(currentDetailRoomId, 'live');
    } else {
        disconnectLive();
        loadHistoryData(val);
        loadDetailStats(currentDetailRoomId, val); // Load historical stats
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
    $('#d_duration').text(formatDuration(summary.duration));
    $('#d_member').text(summary.totalVisits.toLocaleString());
    $('#d_like').text(summary.totalLikes.toLocaleString());
    $('#d_gift').text(summary.totalGiftValue.toLocaleString());
}

function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateLeaderboards(boards) {
    // Render tables...
    renderTable('#giftTable tbody', boards.gifters, '💎');
    renderTopTable('#topContributorsTable tbody', boards.gifters, '💎'); // Same as gift table? 
    // "Contrib Index" was a mix of chat + gift. The prompt asked for "Interact Stats" -> "Contrib" "Gift"
    // Let's just use Gift Value for Contrib for now unless we have complex formula.

    renderTopTable('#topGiftersTable tbody', boards.gifters, '💎');

    // Where do we show Comment Leaderboard? Review index.html tabs.
    // "Interact Stats" -> "Contrib Top 20", "Gift Top 20".
    // Maybe replace Contrib with Comments? Or add Comment tab? 
    // User asked for: "Interact List missing Like, Gift, Comment".
    // We should probably add tables for all 3.
}

function renderTable(selector, data, icon) {
    const tbody = $(selector);
    tbody.empty();
    data.forEach(row => {
        tbody.append(`<tr><td>${row.nickname}</td><td>${row.count || 0}</td><td class="text-right">${icon} ${row.value || 0}</td></tr>`);
    });
}

function renderTopTable(selector, data, icon) {
    const tbody = $(selector);
    tbody.empty();
    data.forEach(row => {
        tbody.append(`<tr><td>${row.nickname}</td><td>${icon} ${row.value || row.count}</td></tr>`);
    });
}

// ...
