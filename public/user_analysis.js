
// user_analysis.js - DaisyUI Version

// Pagination state
let userListPage = 1;
let userListTotalCount = 0;
let userListPageSize = 50;  // Now mutable for dynamic page size

function setUserPageSize(size) {
    userListPageSize = parseInt(size) || 50;
    userListPage = 1;  // Reset to first page
    fetchUserAnalysis();
}

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
    const search = $('#userSearch').val();
    const searchMode = $('#userSearchMode').val();  // 'exact' or 'fuzzy'
    const langFilter = $('#userLanguageFilter').val();
    const minRooms = $('#userMinRooms').val() || 1;
    const activeHour = $('#userActiveHour').val();
    const activeHourEnd = $('#userActiveHourEnd').val();
    const giftPreference = $('#userGiftPreference').val();

    let tbody = $('#userListTable tbody');

    // Show loading state
    tbody.html('<tr><td colspan="10" class="text-center py-8"><span class="loading loading-spinner loading-lg"></span><p class="mt-2 opacity-50">加载中...</p></td></tr>');

    let url = `/api/analysis/users?minRooms=${minRooms}&page=${userListPage}&pageSize=${userListPageSize}`;
    if (langFilter) {
        url += `&languageFilter=${encodeURIComponent(langFilter)}`;
    }
    if (activeHour !== "") {
        url += `&activeHour=${activeHour}`;
    }
    if (activeHourEnd !== "") {
        url += `&activeHourEnd=${activeHourEnd}`;
    }
    if (search) {
        url += `&search=${encodeURIComponent(search)}`;
        if (searchMode === 'exact') {
            url += `&searchExact=true`;
        }
    }
    if (giftPreference) {
        url += `&giftPreference=${giftPreference}`;
    }

    $.get(url)
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
                tbody.append('<tr><td colspan="10" class="text-center opacity-50">暂无用户数据</td></tr>');
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
                // Display room name, use room ID in URL
                const roomDisplayName = u.topRoomName || u.topRoom || '-';
                const roomLink = u.topRoom ?
                    `<a href="https://www.tiktok.com/@${u.topRoom}/live" target="_blank" class="link link-accent no-underline hover:underline flex items-center gap-1">
                        ${u.isTopRoomModerator ? '<span class="tooltip" data-tip="该房间房管">⚔️</span>' : ''}${roomDisplayName} <span class="badge badge-xs badge-ghost">${roomCount}</span>
                    </a>` : '<span class="opacity-50">-</span>';

                // Language display: primary、secondary format
                let languageDisplay = '';
                if (u.commonLanguage) {
                    languageDisplay = u.commonLanguage;
                    if (u.masteredLanguages) {
                        languageDisplay += '、' + u.masteredLanguages;
                    }
                }
                const languages = languageDisplay
                    ? `<div class="badge badge-ghost badge-xs">${languageDisplay}</div>`
                    : '<span class="opacity-30 text-xs">-</span>';

                const accountLink = u.uniqueId ?
                    `<a href="https://www.tiktok.com/@${u.uniqueId}" target="_blank" class="link link-hover">${u.uniqueId}</a>` :
                    u.userId;

                const rowNum = (userListPage - 1) * userListPageSize + index + 1;

                // Render top 6 gifts with icons (exclude Rose and TikTok from topGifts)
                const allGifts = u.topGifts || [];
                const otherGifts = allGifts.filter(g => {
                    const name = (g.name || '').toLowerCase();
                    return name !== 'rose' && name !== 'tiktok';
                }).slice(0, 6);

                const topGiftsHtml = otherGifts.map(g => {
                    const icon = g.icon ? `<img src="${g.icon}" class="w-4 h-4 inline-block" alt="${g.name}">` : '🎁';
                    return `<span class="tooltip cursor-help" data-tip="${g.name} x${g.count} (${g.totalValue}💎)">${icon}</span>`;
                }).join('') || '<span class="opacity-30 text-xs">-</span>';

                // Rose vs TikTok comparison: use dedicated roseStats/tiktokStats from backend
                let roseVsTiktokHtml = '';
                const roseValue = u.roseStats ? (u.roseStats.totalValue || 0) : 0;
                const tiktokValue = u.tiktokStats ? (u.tiktokStats.totalValue || 0) : 0;
                if (roseValue > 0 || tiktokValue > 0) {
                    if (roseValue >= tiktokValue && roseValue > 0) {
                        const icon = u.roseStats.icon ? `<img src="${u.roseStats.icon}" class="w-3 h-3 inline-block">` : '🌹';
                        roseVsTiktokHtml = `<div class="text-[10px] opacity-60 mt-0.5">${icon} ${roseValue.toLocaleString()}</div>`;
                    } else if (tiktokValue > 0) {
                        const icon = u.tiktokStats.icon ? `<img src="${u.tiktokStats.icon}" class="w-3 h-3 inline-block">` : '🎵';
                        roseVsTiktokHtml = `<div class="text-[10px] opacity-60 mt-0.5">${icon} ${tiktokValue.toLocaleString()}</div>`;
                    }
                }

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
                        <td class="max-w-[120px]">
                            <div class="flex gap-0.5 flex-wrap">${topGiftsHtml}</div>
                            ${roseVsTiktokHtml}
                        </td>
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
            $('#userListTable tbody').html('<tr><td colspan="10" class="text-center text-error">加载失败</td></tr>');
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
             <div class="stat bg-base-100 rounded-box shadow-sm p-4 text-center overflow-hidden">
                <div class="stat-title text-xs">总礼物价值</div>
                <div class="stat-value text-warning text-base md:text-2xl truncate" id="detailTotalValue">...</div>
             </div>
             <div class="stat bg-base-100 rounded-box shadow-sm p-4 text-center overflow-hidden">
                <div class="stat-title text-xs">日均消费</div>
                <div class="stat-value text-success text-base md:text-2xl truncate" id="detailDailyAvg">...</div>
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
                <div class="flex justify-between items-center mb-2">
                    <h4 class="card-title text-sm m-0">🤖 AI 性格分析</h4>
                    <span id="aiCacheStatus" class="text-[10px] opacity-40"></span>
                </div>
                <div id="aiResult" class="text-xs leading-relaxed opacity-80 min-h-[100px] bg-base-200 rounded p-3 whitespace-pre-wrap">
                    点击下方按钮进行分析...
                </div>
                <div class="grid grid-cols-2 gap-2 mt-2">
                     <button class="btn btn-sm btn-primary gap-2" onclick="runAiAnalysis('${userId}')">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                        分析
                     </button>
                     <button class="btn btn-sm btn-ghost btn-outline text-error gap-2" onclick="runAiAnalysis('${userId}', true)">
                        重新分析
                     </button>
                </div>
            </div>
        </div>
    `);

    $.get('/api/analysis/user/' + userId, (data) => {
        $('#detailTotalValue').text('💎 ' + (data.totalValue || 0).toLocaleString());
        $('#detailDailyAvg').text('💎 ' + Math.round(data.dailyAvg || 0).toLocaleString());

        // Render gift rooms (db.js converts room_id to roomId)
        if (data.giftRooms && data.giftRooms.length > 0) {
            $('#giftRoomsList').html(data.giftRooms.map(r =>
                `<div class="flex justify-between items-center">
                    <a href="https://www.tiktok.com/@${r.roomId}/live" target="_blank" class="link link-accent truncate max-w-[60%]">${r.name || r.roomId}</a>
                    <span class="text-warning font-mono">💎 ${(r.val || 0).toLocaleString()}</span>
                </div>`
            ).join(''));
        } else {
            $('#giftRoomsList').html('<div class="opacity-50">暂无记录</div>');
        }

        // Render visit rooms (db.js converts room_id to roomId)
        if (data.visitRooms && data.visitRooms.length > 0) {
            $('#visitRoomsList').html(data.visitRooms.map(r =>
                `<div class="flex justify-between items-center">
                    <a href="https://www.tiktok.com/@${r.roomId}/live" target="_blank" class="link link-info truncate max-w-[60%]">${r.name || r.roomId}</a>
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

        // Render moderator rooms (db.js converts room_id to roomId)
        if (data.moderatorRooms && data.moderatorRooms.length > 0) {
            $('#moderatorRoomsSection').show();
            $('#moderatorRoomsList').html(data.moderatorRooms.map(r =>
                `<div class="flex items-center gap-2">
                    <span>⚔️</span>
                    <a href="https://www.tiktok.com/@${r.roomId}/live" target="_blank" class="link link-accent">${r.name || r.roomId}</a>
                </div>`
            ).join(''));
        }

        // Display existing AI analysis if available
        if (data.aiAnalysis) {
            $('#aiResult').text(data.aiAnalysis);
            $('#aiCacheStatus').text('(本地缓存)');
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

function runAiAnalysis(userId, force = false) {
    $('#aiResult').html('<span class="loading loading-dots loading-sm"></span> Analyzing chat history...');
    $('#aiCacheStatus').text('');

    $.ajax({
        url: '/api/analysis/ai',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ userId: userId, force: force }),
        success: (res) => {
            $('#aiResult').text(res.result);
            if (res.cached) {
                $('#aiCacheStatus').text('(本地缓存)');
            } else {
                $('#aiCacheStatus').text('(实时分析)');
            }
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
window.setUserPageSize = setUserPageSize;

// Global Charts Logic
async function renderGlobalCharts() {
    try {
        const stats = await $.get('/api/analysis/stats');

        // IMPORTANT: Sort keys first, then use sorted keys to get corresponding values
        // Object.values() returns in INSERTION ORDER, not sorted order!
        const sortedHours = Object.keys(stats.hourStats).sort();

        // 1. 24h Gift Value
        createChart('chart24hGift', 'bar', '24h 礼物流水',
            sortedHours.map(h => h + 'h'),
            sortedHours.map(h => stats.hourStats[h].gift),
            '#fbbf24'
        );

        // 2. 24h Chat Count
        createChart('chart24hChat', 'bar', '24h 弹幕数量',
            sortedHours.map(h => h + 'h'),
            sortedHours.map(h => stats.hourStats[h].chat),
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

// Export Modal Functions
function showExportModal() {
    document.getElementById('exportModal').showModal();
}

async function executeExport() {
    const exportCount = parseInt($('#exportCount').val());
    const selectedCols = [];
    $('.export-col:checked').each(function () {
        selectedCols.push($(this).data('col'));
    });

    if (selectedCols.length === 0) {
        alert('请至少选择一列');
        return;
    }

    // Get current filters
    const langFilter = $('#userLanguageFilter').val();
    const minRooms = $('#userMinRooms').val() || 1;
    const activeHour = $('#userActiveHour').val();
    const activeHourEnd = $('#userActiveHourEnd').val();
    const search = $('#userSearch').val();
    const giftPreference = $('#userGiftPreference').val();

    // Build URL using export API
    let url = `/api/analysis/users/export?minRooms=${minRooms}&limit=${exportCount === -1 ? 10000 : exportCount}`;
    if (langFilter) url += `&languageFilter=${encodeURIComponent(langFilter)}`;
    if (activeHour !== "") url += `&activeHour=${activeHour}`;
    if (activeHourEnd !== "") url += `&activeHourEnd=${activeHourEnd}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (giftPreference) url += `&giftPreference=${giftPreference}`;

    $('#exportBtn').addClass('loading').prop('disabled', true).text('导出中...');

    try {
        const data = await $.get(url);

        if (!data.users || data.users.length === 0) {
            alert('没有数据可导出');
            return;
        }

        // Column mapping
        const colMap = {
            uniqueId: '用户名',
            nickname: '昵称',
            commonLanguage: '主语种',
            masteredLanguages: '副语种',
            totalValue: '礼物总值',
            dailyAvg: '日均消费',
            topGiftsText: '常刷礼物',
            roseValue: '🌹玫瑰消费',
            tiktokValue: '🎁TikTok消费',
            roomCount: '房间数',
            giftRoomsText: '常去直播间(消费)',
            visitRoomsText: '常去直播间(进房)',
            peakHours: '活跃时间(小时)',
            peakDays: '活跃时间(周)',
            lastActive: '最近活跃',
            aiAnalysis: 'AI性格分析'
        };

        // Build export data
        const exportData = data.users.map(u => {
            const row = {};
            for (const col of selectedCols) {
                let value = u[col];
                if (col === 'lastActive' && value) {
                    value = new Date(value).toLocaleString('zh-CN');
                }
                if (col === 'dailyAvg' && value) {
                    value = Math.round(value);
                }
                row[colMap[col]] = value === null || value === undefined ? '' : value;
            }
            return row;
        });

        // Generate Excel with SheetJS
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '用户列表');

        const fileName = `用户导出_${new Date().toISOString().slice(0, 10)}.xlsx`;
        XLSX.writeFile(wb, fileName);

        document.getElementById('exportModal').close();
    } catch (err) {
        alert('导出失败: ' + err.message);
    } finally {
        $('#exportBtn').removeClass('loading').prop('disabled', false).text('导出 Excel');
    }
}

window.showExportModal = showExportModal;
window.executeExport = executeExport;

// Batch AI Analysis Functions
function showBatchAIModal() {
    // Reset modal state
    $('#batchAIOptions').show();
    $('#batchAIProgress').hide();
    $('#batchAIErrors').hide().text('');
    document.getElementById('batchAIModal').showModal();
}

let batchAIRunning = false;

async function startBatchAI(forceReanalyze) {
    if (batchAIRunning) return;
    batchAIRunning = true;

    // Show progress, hide options
    $('#batchAIOptions').hide();
    $('#batchAIProgress').show();
    $('#batchAIClose').prop('disabled', true);

    try {
        // Fetch top users
        const limit = forceReanalyze ? 100 : 100;
        const response = await $.get(`/api/analysis/users?page=1&pageSize=${limit}&minRooms=1`);
        let users = response.users || [];

        // Filter: only unanalyzed if not force mode
        if (!forceReanalyze) {
            // Need to check which users have ai_analysis
            const needsAnalysis = [];
            for (const u of users) {
                const detail = await $.get(`/api/analysis/user/${u.userId}`);
                if (!detail.aiAnalysis) {
                    needsAnalysis.push(u);
                }
                if (needsAnalysis.length >= 100) break;
            }
            users = needsAnalysis;
        }

        if (users.length === 0) {
            $('#batchAIStatus').text('没有需要分析的用户');
            batchAIRunning = false;
            $('#batchAIClose').prop('disabled', false);
            return;
        }

        const total = users.length;
        let completed = 0;
        let errors = 0;
        const CONCURRENCY = 3;  // Reduced from 20 to avoid API rate limits
        const DELAY_MS = 500;    // Delay between requests

        // Update progress
        const updateProgress = () => {
            const pct = Math.round((completed / total) * 100);
            $('#batchAIBar').val(pct);
            $('#batchAICount').text(`${completed}/${total}`);
            $('#batchAIStatus').text(`正在分析... (${errors} 个失败)`);
        };

        // Helper: delay function
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        // Process with concurrency limit
        const queue = [...users];
        const workers = [];

        for (let i = 0; i < CONCURRENCY; i++) {
            workers.push((async () => {
                while (queue.length > 0) {
                    const user = queue.shift();
                    if (!user) break;
                    try {
                        await $.ajax({
                            url: '/api/analysis/ai',
                            type: 'POST',
                            contentType: 'application/json',
                            data: JSON.stringify({
                                userId: user.userId,
                                force: forceReanalyze
                            }),
                            timeout: 60000  // 60 second timeout
                        });
                    } catch (e) {
                        errors++;
                        console.error(`AI analysis failed for ${user.userId}:`, e);
                    }
                    completed++;
                    updateProgress();
                    await delay(DELAY_MS);  // Wait between requests
                }
            })());
        }

        await Promise.all(workers);

        $('#batchAIStatus').text(`完成！成功 ${completed - errors}/${total}，失败 ${errors}`);
        if (errors > 0) {
            $('#batchAIErrors').show().text(`${errors} 个用户分析失败`);
        }

    } catch (err) {
        $('#batchAIStatus').text('分析出错: ' + err.message);
    } finally {
        batchAIRunning = false;
        $('#batchAIClose').prop('disabled', false);
    }
}

window.showBatchAIModal = showBatchAIModal;
window.startBatchAI = startBatchAI;
