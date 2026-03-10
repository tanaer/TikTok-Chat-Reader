
// user_analysis.js - DaisyUI Version

// Pagination state
let userListPage = 1;
let userListTotalCount = 0;
let userListPageSize = 50;  // Now mutable for dynamic page size
let currentDetailAiUserId = '';
let currentDetailAiJobId = 0;
let aiAnalysisJobPollTimer = null;
const DEFAULT_PERSONALITY_ANALYSIS_POINTS = 1;
let currentDetailAiPointCost = DEFAULT_PERSONALITY_ANALYSIS_POINTS;

function confirmPersonalityAnalysisConsumption(pointCost = DEFAULT_PERSONALITY_ANALYSIS_POINTS, { force = false, batchSize = 0 } = {}) {
    const safePointCost = Math.max(0, Number(pointCost || DEFAULT_PERSONALITY_ANALYSIS_POINTS));
    if (batchSize > 0) {
        const safeBatchSize = Math.max(1, Number(batchSize || 0));
        const maxPointCost = safePointCost * safeBatchSize;
        const actionLabel = force ? '批量重新分析' : '批量生成 AI性格分析';
        const detailLabel = force
            ? '本批次会按实际成功重跑的用户逐个扣点，语料不足的用户会自动跳过。'
            : '本批次会按实际成功生成的用户逐个扣点，语料不足的用户会自动跳过。';
        return window.confirm(
            `${actionLabel}将处理 ${safeBatchSize} 个用户，最多消耗 ${maxPointCost} AI点。\n${detailLabel}\n确认后会立即开始，是否继续？`
        );
    }

    const actionLabel = force ? '重新分析将重新消耗' : '本次 AI性格分析将消耗';
    return window.confirm(`${actionLabel} ${safePointCost} AI点。\n确认后会立即开始生成，是否继续？`);
}

function setUserPageSize(size) {
    userListPageSize = parseInt(size) || 50;
    userListPage = 1;  // Reset to first page
    fetchUserAnalysis();
}

// Reset page to 1 (called from app.js searchUserExact)
function resetUserListPage() {
    userListPage = 1;
}
window.resetUserListPage = resetUserListPage;

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
            const pagePointCost = Number(data.pointCost || DEFAULT_PERSONALITY_ANALYSIS_POINTS);
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
                u.pointCost = Number(u?.pointCost || pagePointCost || DEFAULT_PERSONALITY_ANALYSIS_POINTS);
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
    currentDetailAiUserId = String(userId || '').trim();
    currentDetailAiPointCost = DEFAULT_PERSONALITY_ANALYSIS_POINTS;

    const safeNickname = nickname || userId || '匿名';
    const displayAccount = uniqueId || userId;

    $('#userDetailContent').html(`
        <div class="text-center py-6 border-b border-base-300">
            <div class="avatar placeholder mb-2">
                <div class="bg-neutral text-neutral-content rounded-full w-20 ring ring-primary ring-offset-base-100 ring-offset-2">
                    <span class="text-3xl uppercase">${safeNickname.substring(0, 2)}</span>
                </div>
            </div>
            <h3 class="font-bold text-xl">${safeNickname}</h3>
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
        <div class="card bg-base-100 shadow-sm border border-base-200" ${typeof Auth !== 'undefined' && Auth.isLoggedIn() ? '' : 'style="display:none"'}>
            <div class="card-body p-4">
                <div class="flex justify-between items-center mb-2">
                    <h4 class="card-title text-sm m-0">🤖 AI 性格分析</h4>
                    <span id="aiCacheStatus" class="text-[10px] opacity-40"></span>
                </div>
                <div id="aiResult" class="text-xs leading-relaxed opacity-80 min-h-[100px] bg-base-200 rounded p-3 whitespace-pre-wrap">
                    点击下方按钮进行分析...
                </div>
                <div id="aiMeta" class="text-[10px] opacity-40 mt-1" style="display:none;"></div>
                <div class="grid grid-cols-2 gap-2 mt-2">
                     <button id="runAiAnalysisBtn" class="btn btn-sm btn-primary gap-2" onclick="runAiAnalysis('${userId}')">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                        分析
                     </button>
                     <button id="rerunAiAnalysisBtn" class="btn btn-sm btn-ghost btn-outline text-error gap-2" onclick="runAiAnalysis('${userId}', true)">
                        重新分析
                     </button>
                </div>
                <div id="aiPointHint" class="text-[10px] opacity-50 mt-2">${typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin() ? '管理员发起性格分析不扣点。' : '首次生成会消耗 AI点；命中个人缓存再次查看不重复扣点。'}</div>
            </div>
        </div>
    `);

    $.get('/api/analysis/user/' + userId, (data) => {
        currentDetailAiPointCost = Number(data.pointCost || currentDetailAiPointCost || DEFAULT_PERSONALITY_ANALYSIS_POINTS);
        $('#detailTotalValue').text('💎 ' + (data.totalValue || 0).toLocaleString());
        $('#detailDailyAvg').text('💎 ' + Math.round(data.dailyAvg || 0).toLocaleString());
        const aiPointHint = document.getElementById('aiPointHint');
        if (aiPointHint) {
            const isAdminUser = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
            aiPointHint.textContent = isAdminUser
                ? '管理员发起性格分析不扣点。'
                : `首次生成默认消耗 ${currentDetailAiPointCost} AI点；命中个人缓存再次查看不重复扣点。`;
        }

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
            renderAiAnalysisResult(data.aiAnalysis, null);
            $('#aiCacheStatus').text('(个人缓存)');
            setAiAnalysisButtonsPending(false);
        } else if (data.aiJob && isPendingAiWorkJob(data.aiJob)) {
            showAiAnalysisJobPending(data.aiJob);
            startAiAnalysisJobPolling(data.aiJob.id, userId);
        } else {
            setAiAnalysisButtonsPending(false);
        }
    });
}

function closeUserDetailPanel() {
    clearAiAnalysisJobPolling();
    currentDetailAiUserId = '';
    $('#userDetailPanel').addClass('translate-x-full');
}

function isPendingAiWorkJob(job) {
    const status = String(job?.status || '').toLowerCase();
    return status === 'queued' || status === 'processing';
}

function clearAiAnalysisJobPolling() {
    if (aiAnalysisJobPollTimer) {
        window.clearInterval(aiAnalysisJobPollTimer);
        aiAnalysisJobPollTimer = null;
    }
    currentDetailAiJobId = 0;
}

function setAiAnalysisButtonsPending(pending, isProcessing = false) {
    const runBtn = document.getElementById('runAiAnalysisBtn');
    const rerunBtn = document.getElementById('rerunAiAnalysisBtn');
    if (runBtn) {
        runBtn.disabled = Boolean(pending);
        runBtn.classList.toggle('loading', Boolean(pending) && Boolean(isProcessing));
        runBtn.innerHTML = pending
            ? '分析中...'
            : `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>分析`;
    }
    if (rerunBtn) {
        rerunBtn.disabled = Boolean(pending);
        rerunBtn.textContent = pending ? '请稍候' : '重新分析';
    }
}

function showAiAnalysisJobPending(job) {
    const isProcessing = String(job?.status || '').toLowerCase() === 'processing';
    const progress = Math.max(5, Math.min(99, Number(job?.progressPercent || (isProcessing ? 35 : 10))));
    const currentStep = job?.currentStep || (isProcessing ? '正在后台处理中' : '等待后台调度');
    $('#aiResult').html(`
        <div class="rounded-box border border-base-300 bg-base-100/95 p-4 space-y-3">
            <div class="flex items-center justify-between gap-3">
                <div class="text-[10px] uppercase tracking-wide text-base-content/45">后台工作状态</div>
                <span class="badge ${isProcessing ? 'badge-primary' : 'badge-warning'} badge-outline badge-sm">${escapeAiHtml(isProcessing ? '处理中' : '排队中')}</span>
            </div>
            <div class="rounded-box bg-base-200/80 px-4 py-3">
                <div class="flex items-center justify-between gap-3 text-sm text-base-content/80">
                    <span>${escapeAiHtml(currentStep)}</span>
                    <span class="font-semibold">${progress}%</span>
                </div>
                <progress class="progress progress-primary w-full mt-3" value="${progress}" max="100"></progress>
            </div>
            <div class="text-sm leading-6 text-base-content/70">已切换为后台分析，完成后会通过消息通知提醒。</div>
        </div>
    `);
    $('#aiCacheStatus').text(isProcessing ? '(后台处理中)' : '(后台排队中)');
    $('#aiMeta').show().text(`${isProcessing ? '后台处理中' : '后台排队中'} | ${currentStep}`);
    setAiAnalysisButtonsPending(true, isProcessing);
}

async function refreshAiAnalysisDetail(userId) {
    const res = await Auth.apiFetch(`/api/analysis/user/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '获取客户分析结果失败');
    if (String(currentDetailAiUserId || '') !== String(userId || '')) return;

    if (data.aiJob && isPendingAiWorkJob(data.aiJob)) {
        showAiAnalysisJobPending(data.aiJob);
        startAiAnalysisJobPolling(data.aiJob.id, userId);
        return;
    }

    if (data.aiAnalysis) {
        renderAiAnalysisResult(data.aiAnalysis, data.aiAnalysisJson || null);
        $('#aiCacheStatus').text('(本地缓存)');
        $('#aiMeta').show().text('后台分析已完成');
    }
    setAiAnalysisButtonsPending(false);
}

async function pollAiAnalysisJobStatus(jobId, userId) {
    if (!jobId || !userId) return;
    if (String(currentDetailAiUserId || '') !== String(userId || '')) {
        clearAiAnalysisJobPolling();
        return;
    }

    try {
        const res = await Auth.apiFetch(`/api/user/ai-work/jobs/${encodeURIComponent(jobId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '获取任务状态失败');
        const job = data.job || null;
        if (!job) throw new Error('任务不存在');

        if (isPendingAiWorkJob(job)) {
            showAiAnalysisJobPending(job);
            return;
        }

        clearAiAnalysisJobPolling();
        if (String(job.status || '').toLowerCase() === 'completed') {
            await refreshAiAnalysisDetail(userId);
            return;
        }

        $('#aiCacheStatus').text('(后台失败)');
        $('#aiMeta').show().text(job.errorMessage || '后台处理失败，请稍后重试');
        renderAiAnalysisResult(`错误: ${job.errorMessage || '后台处理失败，请稍后重试'}`, null);
        setAiAnalysisButtonsPending(false);
    } catch (err) {
        console.error('pollAiAnalysisJobStatus error:', err);
    }
}

function startAiAnalysisJobPolling(jobId, userId) {
    if (!jobId || !userId) return;
    if (currentDetailAiJobId === Number(jobId) && aiAnalysisJobPollTimer) return;
    clearAiAnalysisJobPolling();
    currentDetailAiJobId = Number(jobId || 0);
    aiAnalysisJobPollTimer = window.setInterval(() => {
        pollAiAnalysisJobStatus(jobId, userId).catch(() => {});
    }, 10000);
}

function escapeAiHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeAiStringArray(value, limit = 8) {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, limit);
}

function normalizeAiAnalysisPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    return {
        summary: String(payload.summary || '').trim(),
        valueLevelCurrentRoom: String(payload.valueLevelCurrentRoom || '').trim(),
        valueLevelGlobal: String(payload.valueLevelGlobal || '').trim(),
        loyaltyAssessment: String(payload.loyaltyAssessment || '').trim(),
        diversionRiskAssessment: String(payload.diversionRiskAssessment || '').trim(),
        conversionStage: String(payload.conversionStage || '').trim(),
        keySignals: normalizeAiStringArray(payload.keySignals, 6),
        recommendedActions: normalizeAiStringArray(payload.recommendedActions, 6),
        outreachScript: normalizeAiStringArray(payload.outreachScript, 4),
        forbiddenActions: normalizeAiStringArray(payload.forbiddenActions, 4),
        tags: normalizeAiStringArray(payload.tags, 8),
        evidence: normalizeAiStringArray(payload.evidence, 6)
    };
}

function renderAiAnalysisListCard(title, items, tone = 'base') {
    if (!items || !items.length) return '';
    const toneClassMap = {
        base: 'border-base-300 bg-base-100/90',
        primary: 'border-primary/20 bg-primary/5',
        success: 'border-success/20 bg-success/5',
        warning: 'border-warning/20 bg-warning/5',
        error: 'border-error/20 bg-error/5'
    };
    const cardClass = toneClassMap[tone] || toneClassMap.base;
    return `
        <div class="rounded-box border ${cardClass} p-3">
            <div class="text-[11px] font-semibold text-base-content/70 mb-2">${escapeAiHtml(title)}</div>
            <div class="space-y-2">
                ${items.map(item => `<div class="leading-6 text-base-content/80">- ${escapeAiHtml(item)}</div>`).join('')}
            </div>
        </div>
    `;
}

function renderAiAnalysisOverviewItem(label, value) {
    if (!value) return '';
    return `
        <div class="rounded-box border border-base-300 bg-base-100/90 px-3 py-2">
            <div class="text-[10px] uppercase tracking-wide text-base-content/45">${escapeAiHtml(label)}</div>
            <div class="mt-1 text-xs font-semibold leading-5 text-base-content/85">${escapeAiHtml(value)}</div>
        </div>
    `;
}

function renderAiAnalysisResult(resultText, analysisPayload = null) {
    const analysis = normalizeAiAnalysisPayload(analysisPayload);
    if (!analysis) {
        $('#aiResult').html(`<div class="whitespace-pre-wrap leading-6 text-base-content/80">${escapeAiHtml(resultText || '点击下方按钮进行分析...')}</div>`);
        return;
    }

    const overviewItems = [
        renderAiAnalysisOverviewItem('本房价值', analysis.valueLevelCurrentRoom),
        renderAiAnalysisOverviewItem('平台价值', analysis.valueLevelGlobal),
        renderAiAnalysisOverviewItem('忠诚判断', analysis.loyaltyAssessment),
        renderAiAnalysisOverviewItem('分流风险', analysis.diversionRiskAssessment),
        renderAiAnalysisOverviewItem('转化阶段', analysis.conversionStage)
    ].filter(Boolean).join('');

    const html = `
        <div class="space-y-3">
            ${analysis.summary ? `
                <div class="rounded-box border border-primary/15 bg-base-100/95 p-3">
                    <div class="text-[11px] font-semibold text-base-content/60 mb-2">客户总结</div>
                    <div class="text-sm leading-6 text-base-content/85">${escapeAiHtml(analysis.summary)}</div>
                </div>
            ` : ''}
            ${overviewItems ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${overviewItems}</div>` : ''}
            ${analysis.tags.length ? `
                <div class="flex flex-wrap gap-2">
                    ${analysis.tags.map(tag => `<span class="badge badge-outline badge-sm">${escapeAiHtml(tag)}</span>`).join('')}
                </div>
            ` : ''}
            ${renderAiAnalysisListCard('关键信号', analysis.keySignals, 'primary')}
            ${renderAiAnalysisListCard('数据证据', analysis.evidence, 'base')}
            ${renderAiAnalysisListCard('建议动作', analysis.recommendedActions, 'success')}
            ${renderAiAnalysisListCard('建议话术', analysis.outreachScript, 'warning')}
            ${renderAiAnalysisListCard('不建议动作', analysis.forbiddenActions, 'error')}
            ${resultText ? `
                <div class="rounded-box border border-base-300 bg-base-100/80 p-3">
                    <div class="text-[11px] font-semibold text-base-content/60 mb-2">文本版摘要</div>
                    <div class="whitespace-pre-wrap leading-6 text-base-content/75">${escapeAiHtml(resultText)}</div>
                </div>
            ` : ''}
        </div>
    `;

    $('#aiResult').html(html);
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
    currentDetailAiUserId = String(userId || '').trim();
    const isAdminUser = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
    let keepPendingState = false;
    if (!isAdminUser) {
        const confirmed = confirmPersonalityAnalysisConsumption(currentDetailAiPointCost || DEFAULT_PERSONALITY_ANALYSIS_POINTS, { force });
        if (!confirmed) return;
    }

    $('#aiResult').html('<span class="loading loading-dots loading-sm"></span> 正在分析弹幕记录...');
    $('#aiCacheStatus').text('');
    $('#aiMeta').hide().text('');
    setAiAnalysisButtonsPending(true, true);

    Auth.apiFetch('/api/analysis/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId, force: force, confirmConsumption: !isAdminUser })
    })
    .then(r => {
        if (!r.ok) return r.json().then(d => { throw d; });
        return r.json();
    })
    .then(res => {
        if (res.accepted && res.job) {
            keepPendingState = true;
            showAiAnalysisJobPending(res.job);
            startAiAnalysisJobPolling(res.job.id, userId);
            if (res.message) {
                $('#aiMeta').show().text(res.message);
            }
            return;
        }
        if (res.skipped) {
            renderAiAnalysisResult(res.result, null);
            $('#aiCacheStatus').text(`(语料 ${res.chatCount} 条)`);
            return;
        }

        renderAiAnalysisResult(res.result, null);
        const sourceMap = { member_cache: '个人缓存', api: '实时分析' };
        const sourceLabel = sourceMap[res.source] || (res.cached ? '缓存' : '实时分析');
        $('#aiCacheStatus').text(`(${sourceLabel})`);

        const metaParts = [];
        if (res.chatCount) metaParts.push(`语料 ${res.chatCount} 条`);
        if (res.latency) metaParts.push(`耗时 ${(res.latency / 1000).toFixed(1)}s`);
        if (res.model) metaParts.push(`模型 ${res.model}`);
        if (res.analyzedAt) metaParts.push(`分析于 ${new Date(res.analyzedAt).toLocaleString('zh-CN')}`);
        if (metaParts.length > 0) {
            $('#aiMeta').show().text(metaParts.join(' | '));
        }
    })
    .catch(err => {
        const msg = err.error || err.message || '分析失败';
        if (err.code === 'AI_CREDITS_EXHAUSTED' || err.code === 'AI_CONSUMPTION_CONFIRM_REQUIRED') {
            $('#aiResult').html(`<span class="text-warning">${escapeAiHtml(msg)}</span>`);
        } else {
            renderAiAnalysisResult('错误: ' + msg, null);
        }
    })
    .finally(() => {
        if (!keepPendingState) {
            setAiAnalysisButtonsPending(false);
        }
    });
}

// Global Exports
window.renderUserList = renderUserList;
window.switchUserTab = switchUserTab;
window.showUserDetails = showUserDetails;
window.closeUserDetailPanel = closeUserDetailPanel;
window.renderGlobalCharts = renderGlobalCharts;
window.runAiAnalysis = runAiAnalysis;
window.goToUserPage = goToUserPage;
window.setUserPageSize = setUserPageSize;

// Global Charts Logic
async function renderGlobalCharts() {
    // Show loading state on all chart canvases
    const chartIds = ['chart24hGift', 'chart24hChat', 'chartWeeklyGift', 'chartWeeklyChat'];
    chartIds.forEach(id => {
        const canvas = $(`#${id}`);
        const parent = canvas.parent();
        if (!parent.find('.chart-loading').length) {
            parent.css('position', 'relative');
            parent.append(`
                <div class="chart-loading absolute inset-0 flex flex-col items-center justify-center bg-base-100/80 z-10">
                    <span class="loading loading-spinner loading-md text-primary"></span>
                    <p class="mt-2 text-xs text-base-content/60">加载统计数据...</p>
                </div>
            `);
        }
    });

    try {
        const stats = await $.get('/api/analysis/stats');

        // Remove loading states
        $('.chart-loading').remove();

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

    } catch (e) {
        console.error(e);
        $('.chart-loading').html('<p class="text-error text-xs">加载失败</p>');
    }
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
        const message = err?.responseJSON?.error || err?.message || '导出失败，请稍后重试';
        alert(message);
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
    const isAdminUser = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();

    // Show progress, hide options
    $('#batchAIOptions').hide();
    $('#batchAIProgress').show();
    $('#batchAIClose').prop('disabled', true);
    $('#batchAIStatus').text('正在计算本批次预计扣点...');
    $('#batchAIBar').val(0);
    $('#batchAICount').text('0/0');

    try {
        // Fetch top users
        const limit = 100;
        const response = await $.get(`/api/analysis/users?page=1&pageSize=${limit}&minRooms=1`);
        let users = response.users || [];

        // Filter: only unanalyzed if not force mode
        if (!forceReanalyze) {
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

        const effectivePointCost = Number(
            users.find(user => Number(user?.pointCost || 0) > 0)?.pointCost
            || currentDetailAiPointCost
            || DEFAULT_PERSONALITY_ANALYSIS_POINTS
        );

        if (!isAdminUser) {
            const confirmed = confirmPersonalityAnalysisConsumption(effectivePointCost, {
                force: forceReanalyze,
                batchSize: users.length
            });
            if (!confirmed) {
                $('#batchAIOptions').show();
                $('#batchAIProgress').hide();
                $('#batchAIErrors').hide().text('');
                return;
            }
        }

        const total = users.length;
        let completed = 0;
        let errors = 0;
        let skipped = 0;
        const CONCURRENCY = 3;
        const DELAY_MS = 500;

        // Update progress
        const updateProgress = () => {
            const pct = Math.round((completed / total) * 100);
            $('#batchAIBar').val(pct);
            $('#batchAICount').text(`${completed}/${total}`);
            const parts = [];
            if (skipped > 0) parts.push(`${skipped} 语料不足`);
            if (errors > 0) parts.push(`${errors} 失败`);
            $('#batchAIStatus').text(`正在生成 AI性格分析... ${parts.length ? '(' + parts.join(', ') + ')' : ''}`);
        };

        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        const queue = [...users];
        const workers = [];

        for (let i = 0; i < CONCURRENCY; i++) {
            workers.push((async () => {
                while (queue.length > 0) {
                    const user = queue.shift();
                    if (!user) break;
                    try {
                        const res = await Auth.apiFetch('/api/analysis/ai', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                userId: user.userId,
                                force: forceReanalyze,
                                confirmConsumption: !isAdminUser
                            })
                        });
                        if (!res.ok) {
                            const errData = await res.json().catch(() => ({}));
                            if (errData.code === 'AI_CREDITS_EXHAUSTED') {
                                // Stop entire batch - no credits left
                                queue.length = 0;
                                errors++;
                                $('#batchAIErrors').show().text('AI 点数不足，批量分析中止');
                                break;
                            }
                            if (errData.code === 'AI_CONSUMPTION_CONFIRM_REQUIRED') {
                                queue.length = 0;
                                errors++;
                                $('#batchAIErrors').show().text(errData.error || '批量分析缺少扣点确认，任务已中止');
                                break;
                            }
                            errors++;
                        } else {
                            const data = await res.json();
                            if (data.skipped) skipped++;
                        }
                    } catch (e) {
                        errors++;
                        console.error(`AI analysis failed for ${user.userId}:`, e);
                    }
                    completed++;
                    updateProgress();
                    await delay(DELAY_MS);
                }
            })());
        }

        await Promise.all(workers);

        const successCount = completed - errors - skipped;
        const parts = [`成功 ${successCount}`];
        if (skipped > 0) parts.push(`语料不足跳过 ${skipped}`);
        if (errors > 0) parts.push(`失败 ${errors}`);
        $('#batchAIStatus').text(`完成！${parts.join('，')}，共 ${total} 个用户`);
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
