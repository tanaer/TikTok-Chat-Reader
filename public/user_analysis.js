
// user_analysis.js - DaisyUI Version

// Pagination state
let userListPage = 1;
let userListTotalCount = 0;
const userListPageSize = 50;

function renderUserList() {
    fetchUserAnalysis();
}

function switchUserTab(tab) {
    $('.sub-nav-btn').removeClass('active btn-active');
    $(`.sub-nav-btn[onclick="switchUserTab('${tab}')"]`).addClass('active btn-active');
    $('.user-sub-content').hide();
    $(`#userAnalysis-${tab}`).show();

    if (tab === 'charts') {
        renderGlobalCharts();
    } else if (tab === 'list') {
        fetchUserAnalysis();
    }
}

// Format relative time
function formatRelativeTime(timestamp) {
    if (!timestamp) return '-';
    const now = new Date();
    const date = new Date(timestamp);
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;
    // Format as date
    return timestamp.slice(5, 16).replace('T', ' ');
}

function goToUserPage(page) {
    const totalPages = Math.ceil(userListTotalCount / userListPageSize) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    userListPage = page;
    fetchUserAnalysis();
}

function renderPagination(currentPage, totalPages) {
    const container = $('#userPagination');
    container.empty();

    if (totalPages <= 1) return;

    // First page button
    container.append(`<button class="join-item btn btn-sm ${currentPage === 1 ? 'btn-disabled' : ''}" onclick="goToUserPage(1)">首页</button>`);

    // Previous button
    container.append(`<button class="join-item btn btn-sm ${currentPage === 1 ? 'btn-disabled' : ''}" onclick="goToUserPage(${currentPage - 1})">«</button>`);

    // Calculate which page numbers to show
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, currentPage + 2);

    // Ensure we show at least 5 pages if available
    if (endPage - startPage < 4) {
        if (startPage === 1) {
            endPage = Math.min(totalPages, 5);
        } else if (endPage === totalPages) {
            startPage = Math.max(1, totalPages - 4);
        }
    }

    // Show ellipsis before if needed
    if (startPage > 1) {
        container.append(`<button class="join-item btn btn-sm btn-disabled">...</button>`);
    }

    // Page number buttons
    for (let i = startPage; i <= endPage; i++) {
        const isActive = i === currentPage ? 'btn-active btn-primary' : '';
        container.append(`<button class="join-item btn btn-sm ${isActive}" onclick="goToUserPage(${i})">${i}</button>`);
    }

    // Show ellipsis after if needed
    if (endPage < totalPages) {
        container.append(`<button class="join-item btn btn-sm btn-disabled">...</button>`);
    }

    // Next button
    container.append(`<button class="join-item btn btn-sm ${currentPage === totalPages ? 'btn-disabled' : ''}" onclick="goToUserPage(${currentPage + 1})">»</button>`);

    // Last page button
    container.append(`<button class="join-item btn btn-sm ${currentPage === totalPages ? 'btn-disabled' : ''}" onclick="goToUserPage(${totalPages})">尾页</button>`);
}

function fetchUserAnalysis() {
    const langFilter = $('#userLangFilter').val();
    let tbody = $('#userListTable tbody');

    // Show loading state
    tbody.html('<tr><td colspan="9" class="text-center py-8"><span class="loading loading-spinner loading-lg"></span><p class="mt-2 opacity-50">加载中...</p></td></tr>');

    $.get(`/api/analysis/users?lang=${encodeURIComponent(langFilter || '')}&page=${userListPage}&pageSize=${userListPageSize}`)
        .done((data) => {
            tbody.empty();

            // Handle new response format { users, totalCount, page, pageSize }
            const users = data.users || data;
            userListTotalCount = data.totalCount || users.length;
            const totalPages = Math.ceil(userListTotalCount / userListPageSize) || 1;

            // Update pagination UI
            $('#userTotalCount').text(userListTotalCount);
            renderPagination(userListPage, totalPages);

            if (!users || users.length === 0) {
                tbody.append('<tr><td colspan="9" class="text-center opacity-50">暂无用户数据</td></tr>');
                return;
            }

            users.forEach((u, index) => {
                const val = u.totalValue || 0;
                const chats = u.chatCount || 0;
                const score = Math.floor((val / 100) + chats); // Contribution Index
                const roomCount = u.roomCount || 0;
                const lastActive = formatRelativeTime(u.lastActive);

                // Build role icons
                let roleIcons = '';
                if (u.isSuperAdmin) roleIcons += '<span class="tooltip" data-tip="超级管理员">🛡️</span>';
                else if (u.isAdmin) roleIcons += '<span class="tooltip" data-tip="管理员">👮</span>';
                if (u.isTopRoomModerator) roleIcons += '<span class="tooltip" data-tip="房管">⚔️</span>';

                // Fan badge
                const fanBadge = u.fanLevel > 0
                    ? `<span class="tooltip" data-tip="${u.fanClubName || '粉丝团'} Lv.${u.fanLevel}"><span class="badge badge-xs badge-secondary">💜${u.fanLevel}</span></span>`
                    : '';

                // Room link with room count and moderator icon
                const roomLink = u.topRoom ?
                    `<a href="https://www.tiktok.com/@${u.topRoom}/live" target="_blank" class="link link-accent no-underline hover:underline flex items-center gap-1">
                        ${u.isTopRoomModerator ? '<span class="tooltip" data-tip="该房间房管">⚔️</span>' : ''}${u.topRoom} <span class="badge badge-xs badge-ghost">${roomCount}</span>
                    </a>` : '<span class="opacity-50">-</span>';

                const languages = u.masteredLanguages ?
                    `<div class="badge badge-ghost badge-xs">${u.masteredLanguages}</div>` :
                    '<span class="opacity-30 text-xs">-</span>';

                const accountLink = u.uniqueId ?
                    `<a href="https://www.tiktok.com/@${u.uniqueId}" target="_blank" class="link link-hover">${u.uniqueId}</a>` :
                    u.userId;

                const rowNum = (userListPage - 1) * userListPageSize + index + 1;

                tbody.append(`
                    <tr class="hover">
                        <th>${rowNum}</th>
                        <td class="font-mono text-xs opacity-70">${accountLink}</td>
                        <td>
                            <div class="flex items-center gap-1">
                                <span class="font-bold">${u.nickname || '匿名'}</span>
                                ${roleIcons}${fanBadge}
                            </div>
                            ${languages}
                        </td>
                        <td class="font-mono text-warning font-bold">💎 ${val.toLocaleString()}</td>
                        <td class="text-xs">${u.commonLanguage || '-'}</td>
                        <td><div class="badge badge-primary badge-sm">${score}</div></td>
                        <td>${roomLink}</td>
                        <td class="text-xs opacity-70">${lastActive}</td>
                        <td><button class="btn btn-xs btn-ghost" onclick="showUserDetails('${u.userId}', '${(u.nickname || '匿名').replace(/'/g, "\\'")}', '${u.uniqueId || ''}')">详情</button></td>
                    </tr>
                `);
            });
        })
        .fail((err) => {
            console.error('User list fetch error:', err);
            $('#userListTable tbody').html('<tr><td colspan="9" class="text-center text-error">加载失败</td></tr>');
        });
}

function showUserDetails(userId, nickname, uniqueId) {
    // DaisyUI Slide-over
    $('#userDetailPanel').removeClass('translate-x-full');

    const displayAccount = uniqueId || userId;

    $('#userDetailContent').html(`
        <div class="text-center py-6 border-b border-base-300">
            <div class="avatar placeholder mb-2">
                <div class="bg-neutral text-neutral-content rounded-full w-20 ring ring-primary ring-offset-base-100 ring-offset-2">
                    <span class="text-3xl uppercase">${nickname.substring(0, 2)}</span>
                </div>
            </div>
            <h3 class="font-bold text-xl">${nickname}</h3>
            <a href="https://www.tiktok.com/@${displayAccount}" target="_blank" class="badge badge-outline mt-1 font-mono text-xs link link-hover">${displayAccount} ↗</a>
            <!-- Role badges will be inserted here -->
            <div id="detailRoleBadges" class="flex justify-center gap-2 mt-3 flex-wrap"></div>
        </div>

        <div class="grid grid-cols-2 gap-4 my-6">
             <div class="stat bg-base-100 rounded-box shadow-sm p-4 text-center">
                <div class="stat-title text-xs">总礼物价值</div>
                <div class="stat-value text-warning text-2xl" id="detailTotalValue">...</div>
             </div>
             <div class="stat bg-base-100 rounded-box shadow-sm p-4 text-center">
                <div class="stat-title text-xs">日均消费</div>
                <div class="stat-value text-success text-2xl" id="detailDailyAvg">...</div>
             </div>
        </div>

        <!-- Moderator Rooms (if any) -->
        <div class="mb-6" id="moderatorRoomsSection" style="display:none;">
            <h4 class="font-bold text-sm mb-2 text-accent">⚔️ 担任房管</h4>
            <div id="moderatorRoomsList" class="space-y-1 text-sm"></div>
        </div>

        <!-- Top Gift Rooms -->
        <div class="mb-6">
            <h4 class="font-bold text-sm mb-2 text-warning">💎 常去直播间 (送礼)</h4>
            <div id="giftRoomsList" class="space-y-1 text-sm">加载中...</div>
        </div>

        <!-- Top Visit Rooms -->
        <div class="mb-6">
            <h4 class="font-bold text-sm mb-2 text-info">👋 常去直播间 (进房)</h4>
            <div id="visitRoomsList" class="space-y-1 text-sm">加载中...</div>
        </div>

        <!-- Activity Charts -->
        <div class="mb-6">
            <h4 class="font-bold text-sm mb-2 opacity-70">📊 活跃时间分布 (按小时)</h4>
            <div class="h-32 bg-base-200 rounded p-2">
                <canvas id="detailHourChart"></canvas>
            </div>
        </div>

        <div class="mb-6">
            <h4 class="font-bold text-sm mb-2 opacity-70">📅 活跃时间分布 (周一-周日)</h4>
            <div class="h-32 bg-base-200 rounded p-2">
                <canvas id="detailDayChart"></canvas>
            </div>
        </div>

        <!-- AI Analysis -->
        <div class="card bg-base-100 shadow-sm border border-base-200">
            <div class="card-body p-4">
                <h4 class="card-title text-sm mb-2">🤖 AI 性格分析</h4>
                <div id="aiResult" class="text-xs leading-relaxed opacity-80 min-h-[100px] bg-base-200 rounded p-3">
                    点击下方按钮进行分析...
                </div>
                <div class="card-actions justify-end mt-2">
                     <button class="btn btn-sm btn-primary w-full gap-2" onclick="runAiAnalysis('${userId}')">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                        运行 AI 分析
                     </button>
                </div>
            </div>
        </div>
    `);

    $.get('/api/analysis/user/' + userId, (data) => {
        $('#detailTotalValue').text('💎 ' + (data.totalValue || 0).toLocaleString());
        $('#detailDailyAvg').text('💎 ' + (data.dailyAvg || 0).toFixed(0));

        // Render gift rooms
        if (data.giftRooms && data.giftRooms.length > 0) {
            $('#giftRoomsList').html(data.giftRooms.map(r =>
                `<div class="flex justify-between items-center">
                    <a href="https://www.tiktok.com/@${r.room_id}/live" target="_blank" class="link link-accent truncate max-w-[60%]">${r.name || r.room_id}</a>
                    <span class="text-warning font-mono">💎 ${(r.val || 0).toLocaleString()}</span>
                </div>`
            ).join(''));
        } else {
            $('#giftRoomsList').html('<div class="opacity-50">暂无记录</div>');
        }

        // Render visit rooms
        if (data.visitRooms && data.visitRooms.length > 0) {
            $('#visitRoomsList').html(data.visitRooms.map(r =>
                `<div class="flex justify-between items-center">
                    <a href="https://www.tiktok.com/@${r.room_id}/live" target="_blank" class="link link-info truncate max-w-[60%]">${r.name || r.room_id}</a>
                    <span class="text-info font-mono">👋 ${r.cnt} 次</span>
                </div>`
            ).join(''));
        } else {
            $('#visitRoomsList').html('<div class="opacity-50">暂无记录</div>');
        }

        // Render hour chart
        if (data.hourStats && data.hourStats.length > 0) {
            const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'));
            const hourData = hours.map(h => {
                const found = data.hourStats.find(s => s.hour === h);
                return found ? found.cnt : 0;
            });
            renderDetailChart('detailHourChart', hours.map(h => h + 'h'), hourData, '#fbbf24');
        }

        // Render day chart
        if (data.dayStats && data.dayStats.length > 0) {
            const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            const dayData = dayNames.map((_, i) => {
                const found = data.dayStats.find(s => parseInt(s.day) === i);
                return found ? found.cnt : 0;
            });
            renderDetailChart('detailDayChart', dayNames, dayData, '#36d399');
        }

        // Render role badges
        let badges = [];
        if (data.isSuperAdmin) badges.push('<span class="badge badge-error gap-1">🛡️ 超级管理员</span>');
        else if (data.isAdmin) badges.push('<span class="badge badge-warning gap-1">👮 管理员</span>');
        if (data.isModerator) badges.push('<span class="badge badge-accent gap-1">⚔️ 房管</span>');
        if (data.fanLevel > 0) {
            badges.push(`<span class="badge badge-secondary gap-1">💜 Lv.${data.fanLevel} ${data.fanClubName || ''}</span>`);
        }
        if (badges.length > 0) {
            $('#detailRoleBadges').html(badges.join(''));
        }

        // Render moderator rooms
        if (data.moderatorRooms && data.moderatorRooms.length > 0) {
            $('#moderatorRoomsSection').show();
            $('#moderatorRoomsList').html(data.moderatorRooms.map(r =>
                `<div class="flex items-center gap-2">
                    <span>⚔️</span>
                    <a href="https://www.tiktok.com/@${r.room_id}/live" target="_blank" class="link link-accent">${r.name || r.room_id}</a>
                </div>`
            ).join(''));
        }
    });
}

function renderDetailChart(canvasId, labels, data, color) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: color,
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, display: false },
                x: { ticks: { font: { size: 8 } } }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function runAiAnalysis(userId) {
    $('#aiResult').html('<span class="loading loading-dots loading-sm"></span> Analyzing chat history...');
    $.ajax({
        url: '/api/analysis/ai',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ userId: userId }),
        success: (res) => {
            $('#aiResult').html(res.result.replace(/\n/g, '<br>'));
        },
        error: (err) => $('#aiResult').text('Error: ' + err.statusText)
    });
}

// Global Exports
window.renderUserList = renderUserList;
window.switchUserTab = switchUserTab;
window.showUserDetails = showUserDetails;
window.renderGlobalCharts = renderGlobalCharts;
window.runAiAnalysis = runAiAnalysis;
window.goToUserPage = goToUserPage;

// Global Charts Logic
async function renderGlobalCharts() {
    try {
        const stats = await $.get('/api/analysis/stats');

        // 1. 24h Gift Value
        createChart('chart24hGift', 'bar', '24h 礼物流水',
            Object.keys(stats.hourStats).sort().map(h => h + 'h'),
            Object.values(stats.hourStats).map(d => d.gift),
            '#fbbf24'
        );

        // 2. 24h Chat Count
        createChart('chart24hChat', 'bar', '24h 弹幕数量',
            Object.keys(stats.hourStats).sort().map(h => h + 'h'),
            Object.values(stats.hourStats).map(d => d.chat),
            '#3abff8'
        );

        // 3. Weekly Gift Value
        const days = ['日', '一', '二', '三', '四', '五', '六'];
        createChart('chartWeeklyGift', 'bar', '周流水趋势',
            days,
            days.map((_, i) => stats.dayStats[i]?.gift || 0),
            '#f87272'
        );

        // 4. Weekly Chat Count
        createChart('chartWeeklyChat', 'bar', '周活跃趋势',
            days,
            days.map((_, i) => stats.dayStats[i]?.chat || 0),
            '#36d399'
        );

    } catch (e) { console.error(e); }
}

function createChart(canvasId, type, label, labels, data, color) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    // Destroy previous instance if any (Chart.js quirk)
    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    new Chart(ctx, {
        type: type,
        data: {
            labels: labels,
            datasets: [{
                label: label,
                data: data,
                backgroundColor: color,
                borderColor: color,
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { beginAtZero: true } },
            plugins: { legend: { display: false } }
        }
    });
}
