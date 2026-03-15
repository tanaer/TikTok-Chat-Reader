
// app.js - Main Application Logic

var socket = null;
var currentSection = 'roomList';
var currentDetailRoomId = null;
var currentSessionId = 'live'; // 'live' or session UUID
var roomIsLive = false;
var connectedRoomId = null; // Track actually connected room to prevent cross-room event display
var liveDetailAggregationState = createEmptyLiveDetailAggregationState();
var globalLoadingCount = 0;
var sessionRecapTrendChart = null;
var sessionRecapRadarChart = null;
var currentSessionRecap = null;
var sessionAiJobPollTimer = null;
var sessionAiJobPollTarget = null;
var sessionRecapExporting = false;
var roomCustomerAnalysisExporting = false;
var roomCustomerAnalysisJobPollTimer = null;
var currentRoomCustomerAnalysisJobId = 0;
var currentRoomCustomerAnalysisState = { roomId: '', userId: '', nickname: '', uniqueId: '', hasAnalysisResult: false };
var currentRoomLoadRequestId = 0;
var globalLoadingVariant = 'default';
var globalLoadingMessage = '加载中...';
const DEFAULT_SESSION_RECAP_POINTS = 10;
const DEFAULT_ROOM_CUSTOMER_ANALYSIS_POINTS = 3;
const SESSION_RECAP_LOADING_TIPS = [
    '正在抽取礼物高峰与掉人节点',
    '正在筛选高价值弹幕与关键反馈',
    '正在识别核心客户、潜力客户与风险客户',
    '正在整理老板能直接转发的 AI直播复盘'
];

function confirmSessionRecapConsumption(pointCost = DEFAULT_SESSION_RECAP_POINTS, { force = false } = {}) {
    const safePointCost = Math.max(0, Number(pointCost || DEFAULT_SESSION_RECAP_POINTS));
    const actionLabel = force ? '重新生成 AI直播复盘将重新消耗' : '本次 AI直播复盘将消耗';
    return window.confirm(`${actionLabel} ${safePointCost} AI点。\n确认后会立即提交后台任务，是否继续？`);
}

function confirmRoomCustomerAnalysisConsumption(pointCost = DEFAULT_ROOM_CUSTOMER_ANALYSIS_POINTS, { force = false } = {}) {
    const safePointCost = Math.max(0, Number(pointCost || DEFAULT_ROOM_CUSTOMER_ANALYSIS_POINTS));
    const actionLabel = force ? '重新挖掘将重新消耗' : '本次客户价值深度挖掘将消耗';
    return window.confirm(`${actionLabel} ${safePointCost} AI点。\n确认后会立即提交后台任务，是否继续？`);
}


function normalizeFeatureFlags(rawFlags) {
    if (!rawFlags) return {};
    if (typeof rawFlags === 'string') {
        try {
            return JSON.parse(rawFlags);
        } catch {
            return {};
        }
    }
    return rawFlags;
}

function hasFeatureFlag(flags, ...keys) {
    const normalized = normalizeFeatureFlags(flags);
    return keys.some(key => Boolean(normalized?.[key]));
}

function nextPaint(frames = 1) {
    const safeFrames = Math.max(1, Number(frames || 1));
    return new Promise(resolve => {
        let remaining = safeFrames;
        const step = () => {
            remaining -= 1;
            if (remaining <= 0) {
                resolve();
                return;
            }
            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(step);
                return;
            }
            window.setTimeout(step, 16);
        };
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(step);
            return;
        }
        window.setTimeout(step, 16);
    });
}

function getMonitorDeepLinkState() {
    const params = new URLSearchParams(window.location.search || '');
    return {
        roomId: String(params.get('roomId') || '').trim(),
        roomName: String(params.get('roomName') || '').trim(),
        sessionId: String(params.get('sessionId') || '').trim(),
        detailTab: String(params.get('detailTab') || '').trim(),
        section: String(params.get('section') || '').trim(),
        analysisUserId: String(params.get('analysisUserId') || '').trim(),
        analysisNickname: String(params.get('analysisNickname') || '').trim(),
        analysisUniqueId: String(params.get('analysisUniqueId') || '').trim(),
        customerAnalysisUserId: String(params.get('customerAnalysisUserId') || '').trim(),
        customerAnalysisNickname: String(params.get('customerAnalysisNickname') || '').trim(),
        customerAnalysisUniqueId: String(params.get('customerAnalysisUniqueId') || '').trim()
    };
}

async function handleMonitorDeepLink() {
    const deepLink = getMonitorDeepLinkState();
    if (deepLink.customerAnalysisUserId && deepLink.roomId) {
        switchSection('roomDetail');
        await loadRoom(deepLink.roomId);

        if (deepLink.sessionId && deepLink.sessionId !== currentSessionId) {
            await changeSession(deepLink.sessionId);
        }

        if (deepLink.detailTab) {
            const tabBtn = document.querySelector(`#section-roomDetail .tab[onclick*="${deepLink.detailTab}"]`);
            switchDetailTab(deepLink.detailTab, tabBtn || document.querySelector('#section-roomDetail .tab'));
        }

        await openRoomCustomerAnalysisModal(
            deepLink.roomId,
            deepLink.customerAnalysisUserId,
            deepLink.customerAnalysisNickname || deepLink.customerAnalysisUserId,
            deepLink.customerAnalysisUniqueId || ''
        );
        return;
    }

    if (deepLink.analysisUserId) {
        switchSection(deepLink.section || 'userAnalysis');
        if (typeof showUserDetails === 'function') {
            showUserDetails(
                deepLink.analysisUserId,
                deepLink.analysisNickname || deepLink.analysisUserId,
                deepLink.analysisUniqueId || ''
            );
        }
        return;
    }
    if (!deepLink.roomId) return;

    switchSection('roomDetail');
    if (deepLink.roomName) {
        updateDetailRoomIdentity(deepLink.roomId, deepLink.roomName);
    }
    await loadRoom(deepLink.roomId);

    if (deepLink.sessionId && deepLink.sessionId !== currentSessionId) {
        await changeSession(deepLink.sessionId);
    }

    if (deepLink.detailTab) {
        const tabBtn = document.querySelector(`#section-roomDetail .tab[onclick*="${deepLink.detailTab}"]`);
        switchDetailTab(deepLink.detailTab, tabBtn || document.querySelector('#section-roomDetail .tab'));
    }
}


function setGlobalLoadingVisible(visible, message = '加载中...', options = {}) {
    const overlay = document.getElementById('globalLoadingOverlay');
    const textEl = document.getElementById('globalLoadingText');
    if (!overlay || !textEl) return;

    textEl.textContent = message;
    overlay.dataset.variant = options.variant === 'compact' ? 'compact' : 'default';
    overlay.classList.toggle('is-visible', visible);
    overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function showGlobalLoading(message = '加载中...', options = {}) {
    globalLoadingCount += 1;
    globalLoadingMessage = message;
    globalLoadingVariant = options.variant === 'compact' ? 'compact' : 'default';
    setGlobalLoadingVisible(true, message, { variant: globalLoadingVariant });
}

function hideGlobalLoading() {
    globalLoadingCount = Math.max(0, globalLoadingCount - 1);
    if (globalLoadingCount === 0) {
        globalLoadingVariant = 'default';
        globalLoadingMessage = '加载中...';
        setGlobalLoadingVisible(false, globalLoadingMessage, { variant: globalLoadingVariant });
    }
}

async function withGlobalLoading(message, task, options = {}) {
    showGlobalLoading(message, options);
    const paintFrames = Math.max(0, Number(options.paintFrames || 0));
    if (paintFrames > 0) {
        await nextPaint(paintFrames);
    }
    try {
        return await task();
    } finally {
        hideGlobalLoading();
    }
}

window.showGlobalLoading = showGlobalLoading;
window.hideGlobalLoading = hideGlobalLoading;
window.withGlobalLoading = withGlobalLoading;
window.exportSessionRecapAsImage = exportSessionRecapAsImage;
window.exportSessionRecapAsPdf = exportSessionRecapAsPdf;
window.exportRoomCustomerAnalysisAsImage = exportRoomCustomerAnalysisAsImage;
window.exportRoomCustomerAnalysisAsPdf = exportRoomCustomerAnalysisAsPdf;

// Initialization
$(document).ready(async () => {
    // Require authentication - redirect to login if not authenticated
    if (typeof Auth !== 'undefined') {
        if (!Auth.requireAuth()) return; // Redirects to login if not authenticated
        const sessionOk = await Auth.ensureSessionActive();
        if (!sessionOk) return;
        Auth.updateNavbar();
        const subNavContainer = document.getElementById('sub-nav-container');
        if (subNavContainer) {
            subNavContainer.classList.remove('hidden');
        }
        const roomCustomerAnalysisModal = document.getElementById('roomCustomerAnalysisModal');
        if (roomCustomerAnalysisModal) {
            roomCustomerAnalysisModal.addEventListener('close', () => {
                clearRoomCustomerAnalysisJobPolling();
                currentRoomCustomerAnalysisState = { roomId: '', userId: '', nickname: '', uniqueId: '', hasAnalysisResult: false };
            });
        }
        // Show export button for admins or users with export feature
        if (Auth.isAdmin()) {
            const btn = document.getElementById('btn-export');
            if (btn) btn.style.display = '';
        } else {
            Auth.apiFetch('/api/user/subscription').then(r => r.json()).then(data => {
                const flags = data.subscription?.featureFlags || data.subscription?.planFeatureFlags || {};
                if (hasFeatureFlag(flags, 'export', 'data_export')) {
                    const btn = document.getElementById('btn-export');
                    if (btn) btn.style.display = '';
                }
            }).catch(() => { });
        }
    }

    initSocket();

    // Initial Load
    loadConfig(); // from config.js
    if (typeof window.renderRoomList === 'function') window.renderRoomList(); // from room_list.js
    await handleMonitorDeepLink();

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
        updateChatStats(msg);
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
    if (sectionId !== 'roomDetail' && currentRoomCustomerAnalysisState.roomId) {
        closeRoomCustomerAnalysisModal();
    }
    currentSection = sectionId;
    $('.content-section').hide();
    $(`#section-${sectionId}`).show();

    // Update sub-nav active state
    $('.sub-nav-btn').removeClass('active');
    $(`.sub-nav-btn[onclick="switchSection('${sectionId}')"]`).addClass('active');

    // Show/hide sub-navigation container based on current section
    const subNavContainer = document.getElementById('sub-nav-container');
    const monitorSections = ['roomList', 'userAnalysis', 'roomAnalysis', 'recording', 'systemConfig'];
    if (subNavContainer) {
        if (monitorSections.includes(sectionId)) {
            subNavContainer.classList.remove('hidden');
        } else {
            subNavContainer.classList.add('hidden');
        }
    }

    if (sectionId === 'roomList') {
        if (typeof window.renderRoomList === 'function') {
            window.renderRoomList();
        }
    } else if (sectionId === 'userAnalysis') {
        // Only auto-render if not coming from searchUserExact (which handles its own render)
        if (!window._pendingUserSearch && typeof renderUserList === 'function') {
            renderUserList();
        }
    } else if (sectionId === 'systemConfig') {
        if (typeof loadConfig === 'function') loadConfig();
    } else if (sectionId === 'roomAnalysis') {
        if (typeof initRoomAnalysis === 'function') initRoomAnalysis();
    } else if (sectionId === 'recording') {
        if (typeof initRecordingSection === 'function') initRecordingSection();
    }
}

// =======================
// Room Detail Logic
// =======================

function isActiveRoomLoad(roomId, requestId) {
    return Number(requestId || 0) === Number(currentRoomLoadRequestId || 0)
        && String(currentDetailRoomId || '').trim() === String(roomId || '').trim();
}

function renderAlltimeStatusTable(message, tone = 'loading') {
    const content = tone === 'loading'
        ? `<span class="loading loading-spinner loading-xs mr-1"></span>${message}`
        : message;
    $('#alltimeGiftersTable tbody, #alltimeChattersTable tbody, #alltimeLikersTable tbody')
        .html(`<tr><td colspan="2" class="text-center opacity-60 text-xs">${content}</td></tr>`);
}

function updateDetailRoomIdentity(roomId, roomName = '') {
    const safeRoomId = String(roomId || '').trim();
    const safeRoomName = String(roomName || '').trim();
    $('#detailRoomId').text(safeRoomId);
    $('#detailRoomName').text(safeRoomName || safeRoomId || '房间名');
}

function setAlltimeLeaderboardsLoading(roomId) {
    const safeRoomId = String(roomId || '').trim();
    renderAlltimeStatusTable(
        safeRoomId ? `正在加载房间 ${safeRoomId} 的历史排行榜...` : '正在加载历史排行榜...',
        'loading'
    );
}

async function loadRoom(id) {
    const safeRoomId = String(id || '').trim();
    const requestId = ++currentRoomLoadRequestId;
    if (currentRoomCustomerAnalysisState.roomId && currentRoomCustomerAnalysisState.roomId !== safeRoomId) {
        closeRoomCustomerAnalysisModal();
    }
    currentDetailRoomId = safeRoomId;
    updateDetailRoomIdentity(safeRoomId);
    $('#chatContainer').empty();
    showSessionRecapLoadingState('正在加载 AI直播复盘...');
    setAlltimeLeaderboardsLoading(safeRoomId);

    // Show loading state
    showLoadingState();

    await withGlobalLoading('加载房间详情中...', async () => {
        try {
            // First check if room is live and get session list
            const [statsRes, sessions] = await Promise.all([
                $.get(`/api/rooms/${safeRoomId}/stats_detail?sessionId=live`),
                $.get(`/api/rooms/${safeRoomId}/sessions`)
            ]);
            if (!isActiveRoomLoad(safeRoomId, requestId)) return;
            updateDetailRoomIdentity(safeRoomId, statsRes.roomName);

            // Load all-time leaderboards in background (don't block UI)
            loadAlltimeLeaderboards(safeRoomId, requestId);

            roomIsLive = statsRes.isLive === true;

            // Populate session dropdown
            const select = $('#sessionSelect');
            select.empty();
            select.append('<option value="live">🟢 实时直播 (LIVE)</option>');

            if (sessions && sessions.length > 0) {
                sessions.forEach(s => {
                    // Use createdAt or endTime as display, fallback to session ID if both null
                    const displayTime = s.createdAt || s.endTime;
                    const dateStr = displayTime ? formatBeijingDateTime(displayTime, `场次 ${s.sessionId}`) : `场次 ${s.sessionId}`;
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

                // Show stats
                setLiveDetailAggregationState(safeRoomId, statsRes.summary, statsRes.leaderboards);
                updateRoomHeader(statsRes.summary);
                updateLeaderboards(statsRes.leaderboards);

                connectToLive(safeRoomId);

            } else if (sessions && sessions.length > 0) {
                // Not live - auto-select last session
                const lastSessionId = sessions[0].sessionId;
                currentSessionId = lastSessionId;
                select.val(lastSessionId);

                // Load last session stats
                const lastStats = await $.get(`/api/rooms/${safeRoomId}/stats_detail?sessionId=${lastSessionId}`);
                if (!isActiveRoomLoad(safeRoomId, requestId)) return;
                hideLoadingState();
                updateRoomStatusUI(false);
                const lastSessionTime = sessions[0].createdAt || sessions[0].endTime;
                const lastSessionStr = lastSessionTime ? formatBeijingDateTime(lastSessionTime, `场次 ${lastSessionId}`) : `场次 ${lastSessionId}`;
                addSystemMessage(`📼 房间未开播，已加载最近一场数据 (${lastSessionStr})`);

                updateRoomHeader(lastStats.summary);
                updateLeaderboards(lastStats.leaderboards);
                clearLiveDetailAggregationState();

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
                clearLiveDetailAggregationState();
            }

            if (isSessionRecapTabActive() && isActiveRoomLoad(safeRoomId, requestId)) {
                await renderSessionRecap(safeRoomId, currentSessionId);
            }

        } catch (err) {
            if (!isActiveRoomLoad(safeRoomId, requestId)) return;
            console.error('loadRoom error:', err);
            hideLoadingState();
            addSystemMessage('❌ 加载失败: ' + err.message);
        }
    });
}

function showLoadingState() {
    $('#d_duration').text('--:--');
    $('#d_member, #d_like, #d_gift').text('...');
    $('#info_startTime').text('加载中...');
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

async function changeSession(val) {
    currentSessionId = val;
    $('#chatContainer').empty();
    showSessionRecapLoadingState('正在切换 AI直播复盘...');
    showLoadingState();

    const loadingText = val === 'live' ? '切换实时数据中...' : '切换场次数据中...';

    await withGlobalLoading(loadingText, async () => {
        try {
            if (val === 'live') {
                addSystemMessage('切换到实时视图');
                updateRoomStatusUI(roomIsLive);
                if (roomIsLive) {
                    ensureLiveDetailAggregationState(currentDetailRoomId);
                }
                await loadDetailStats(currentDetailRoomId, 'live');
                if (roomIsLive) {
                    connectToLive(currentDetailRoomId);
                }
            } else {
                disconnectLive();
                updateRoomStatusUI(false);
                addSystemMessage(`已切换到场次 ${val}`);
                await loadDetailStats(currentDetailRoomId, val);
            }

            if (isSessionRecapTabActive()) {
                await renderSessionRecap(currentDetailRoomId, currentSessionId);
            }
        } catch (err) {
            console.error('changeSession error:', err);
            addSystemMessage('❌ 切换场次失败: ' + (err.message || '未知错误'));
        }
    });
}

async function loadDetailStats(roomId, sessionId) {
    try {
        const res = await $.get(`/api/rooms/${roomId}/stats_detail?sessionId=${sessionId}`);
        updateDetailRoomIdentity(roomId, res.roomName);
        if (sessionId === 'live') {
            setLiveDetailAggregationState(roomId, res.summary, res.leaderboards);
        } else {
            clearLiveDetailAggregationState();
        }
        updateRoomHeader(res.summary);
        updateLeaderboards(res.leaderboards);
        hideLoadingState();
        return res;
    } catch (e) {
        console.error('Stats load error', e);
        throw e;
    }
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
        $('#info_startTime').text(formatBeijingDateTime(start));
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

function toStatsNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function createEmptyLiveSummary() {
    return {
        duration: 0,
        startTime: null,
        totalVisits: 0,
        totalComments: 0,
        totalLikes: 0,
        totalGiftValue: 0
    };
}

function createEmptyLiveDetailAggregationState() {
    return {
        active: false,
        roomId: null,
        summary: createEmptyLiveSummary(),
        gifters: new Map(),
        chatters: new Map(),
        likers: new Map(),
        giftDetails: new Map()
    };
}

function clearLiveDetailAggregationState() {
    liveDetailAggregationState = createEmptyLiveDetailAggregationState();
}

function ensureLiveDetailAggregationState(roomId = currentDetailRoomId) {
    const nextRoomId = String(roomId || '').trim();
    if (!nextRoomId) return;
    if (liveDetailAggregationState.roomId === nextRoomId && liveDetailAggregationState.active) return;

    liveDetailAggregationState = createEmptyLiveDetailAggregationState();
    liveDetailAggregationState.active = true;
    liveDetailAggregationState.roomId = nextRoomId;
}

function normalizeLiveUserKey({ userId, uniqueId, nickname } = {}) {
    const rawValue = userId ?? uniqueId ?? nickname ?? '';
    const normalized = String(rawValue || '').trim();
    return normalized || 'anonymous';
}

function normalizeLiveGiftKey(userKey, { giftId, giftName } = {}) {
    const giftPart = String(giftId ?? giftName ?? '').trim() || 'unknown-gift';
    return `${userKey}::${giftPart}`;
}

function upsertLiveLeaderboardEntry(map, key, payload = {}, metricKey = 'value', delta = 0) {
    const existing = map.get(key) || {
        userId: payload.userId || '',
        uniqueId: payload.uniqueId || '',
        nickname: payload.nickname || payload.uniqueId || '匿名',
        value: 0,
        count: 0
    };

    existing.userId = payload.userId || existing.userId || '';
    existing.uniqueId = payload.uniqueId || existing.uniqueId || '';
    existing.nickname = payload.nickname || existing.nickname || existing.uniqueId || '匿名';
    existing[metricKey] = toStatsNumber(existing[metricKey], 0) + toStatsNumber(delta, 0);
    map.set(key, existing);
    return existing;
}

function upsertLiveGiftDetailEntry(payload = {}) {
    const userKey = normalizeLiveUserKey(payload);
    const giftKey = normalizeLiveGiftKey(userKey, payload);
    const existing = liveDetailAggregationState.giftDetails.get(giftKey) || {
        userId: payload.userId || '',
        uniqueId: payload.uniqueId || '',
        nickname: payload.nickname || payload.uniqueId || '匿名',
        giftId: payload.giftId ?? null,
        giftName: payload.giftName || '未知礼物',
        count: 0,
        unitPrice: 0,
        totalValue: 0
    };

    const repeatCount = toStatsNumber(payload.repeatCount, 1);
    const unitPrice = toStatsNumber(payload.diamondCount, 0);

    existing.userId = payload.userId || existing.userId || '';
    existing.uniqueId = payload.uniqueId || existing.uniqueId || '';
    existing.nickname = payload.nickname || existing.nickname || existing.uniqueId || '匿名';
    existing.giftId = payload.giftId ?? existing.giftId ?? null;
    existing.giftName = payload.giftName || existing.giftName || '未知礼物';
    existing.count = toStatsNumber(existing.count, 0) + repeatCount;
    existing.unitPrice = Math.max(toStatsNumber(existing.unitPrice, 0), unitPrice);
    existing.totalValue = toStatsNumber(existing.totalValue, 0) + unitPrice * repeatCount;

    liveDetailAggregationState.giftDetails.set(giftKey, existing);
    return existing;
}

function seedLiveLeaderboardMap(map, rows = [], metricKey = 'value') {
    rows.forEach(row => {
        const key = normalizeLiveUserKey(row);
        map.set(key, {
            userId: row.userId || '',
            uniqueId: row.uniqueId || row.unique_id || '',
            nickname: row.nickname || row.uniqueId || row.unique_id || '匿名',
            value: metricKey === 'value' ? toStatsNumber(row.value, 0) : 0,
            count: metricKey === 'count' ? toStatsNumber(row.count, 0) : 0
        });
    });
}

function seedLiveGiftDetailMap(rows = []) {
    rows.forEach(row => {
        const userKey = normalizeLiveUserKey(row);
        const giftKey = normalizeLiveGiftKey(userKey, row);
        liveDetailAggregationState.giftDetails.set(giftKey, {
            userId: row.userId || '',
            uniqueId: row.uniqueId || row.unique_id || '',
            nickname: row.nickname || row.uniqueId || row.unique_id || '匿名',
            giftId: row.giftId ?? null,
            giftName: row.giftName || '未知礼物',
            count: toStatsNumber(row.count, 0),
            unitPrice: toStatsNumber(row.unitPrice, 0),
            totalValue: toStatsNumber(row.totalValue, 0)
        });
    });
}

function setLiveDetailAggregationState(roomId, summary = {}, boards = {}) {
    ensureLiveDetailAggregationState(roomId);

    liveDetailAggregationState.summary = {
        duration: toStatsNumber(summary.duration, 0),
        startTime: summary.startTime || null,
        totalVisits: toStatsNumber(summary.totalVisits, 0),
        totalComments: toStatsNumber(summary.totalComments, 0),
        totalLikes: toStatsNumber(summary.totalLikes, 0),
        totalGiftValue: toStatsNumber(summary.totalGiftValue, 0)
    };

    liveDetailAggregationState.gifters = new Map();
    liveDetailAggregationState.chatters = new Map();
    liveDetailAggregationState.likers = new Map();
    liveDetailAggregationState.giftDetails = new Map();

    seedLiveLeaderboardMap(liveDetailAggregationState.gifters, Array.isArray(boards.gifters) ? boards.gifters : [], 'value');
    seedLiveLeaderboardMap(liveDetailAggregationState.chatters, Array.isArray(boards.chatters) ? boards.chatters : [], 'count');
    seedLiveLeaderboardMap(liveDetailAggregationState.likers, Array.isArray(boards.likers) ? boards.likers : [], 'count');
    seedLiveGiftDetailMap(Array.isArray(boards.giftDetails) ? boards.giftDetails : []);
}

function isLiveDetailAggregationReady() {
    return isViewingLive() &&
        liveDetailAggregationState.active &&
        liveDetailAggregationState.roomId === currentDetailRoomId;
}

function getLiveSummaryForRender() {
    const summary = {
        ...createEmptyLiveSummary(),
        ...(liveDetailAggregationState.summary || {})
    };

    if (summary.startTime) {
        const startMs = new Date(summary.startTime).getTime();
        if (!Number.isNaN(startMs)) {
            summary.duration = Math.max(toStatsNumber(summary.duration, 0), Math.floor((Date.now() - startMs) / 1000));
        }
    }

    return summary;
}

function sortLiveLeaderboardEntries(map, metricKey = 'value', limit = 20) {
    return Array.from(map.values())
        .sort((left, right) => {
            const metricDiff = toStatsNumber(right[metricKey], 0) - toStatsNumber(left[metricKey], 0);
            if (metricDiff !== 0) return metricDiff;
            return String(left.nickname || '').localeCompare(String(right.nickname || ''));
        })
        .slice(0, limit);
}

function sortLiveGiftDetailEntries(limit = 100) {
    return Array.from(liveDetailAggregationState.giftDetails.values())
        .sort((left, right) => {
            const totalDiff = toStatsNumber(right.totalValue, 0) - toStatsNumber(left.totalValue, 0);
            if (totalDiff !== 0) return totalDiff;
            const countDiff = toStatsNumber(right.count, 0) - toStatsNumber(left.count, 0);
            if (countDiff !== 0) return countDiff;
            return String(left.nickname || '').localeCompare(String(right.nickname || ''));
        })
        .slice(0, limit);
}

function renderLiveSummaryState() {
    if (!isLiveDetailAggregationReady()) return;
    updateRoomHeader(getLiveSummaryForRender());
}

function renderLiveGiftState() {
    if (!isLiveDetailAggregationReady()) return;
    renderGiftTable('#giftTable tbody', sortLiveGiftDetailEntries(100));
    const gifters = sortLiveLeaderboardEntries(liveDetailAggregationState.gifters, 'value', 20);
    renderTopTable('#currentGiftersTable tbody', gifters, '💎', 'value');
    renderTopTable('#topGiftersTable tbody', gifters, '💎', 'value');
}

function renderLiveChatterState() {
    if (!isLiveDetailAggregationReady()) return;
    const chatters = sortLiveLeaderboardEntries(liveDetailAggregationState.chatters, 'count', 20);
    renderTopTable('#currentChattersTable tbody', chatters, '💬', 'count');
    renderTopTable('#topContributorsTable tbody', chatters, '💬', 'count');
}

function renderLiveLikerState() {
    if (!isLiveDetailAggregationReady()) return;
    const likers = sortLiveLeaderboardEntries(liveDetailAggregationState.likers, 'count', 20);
    renderTopTable('#currentLikersTable tbody', likers, '❤️', 'count');
    renderTopTable('#topLikersTable tbody', likers, '❤️', 'count');
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
        const nickname = row.nickname || row.uniqueId || '匿名';
        const account = row.uniqueId || '';
        const giftName = row.giftName || '未知礼物';
        const count = row.count || 1;
        const unitPrice = row.unitPrice || 0;
        const totalValue = row.totalValue || 0;
        const accountMeta = account
            ? `<button class="mt-1 text-left text-xs opacity-60 hover:opacity-100 hover:text-primary break-all" title="点击复制账号" onclick='copyGiftAccount(${JSON.stringify(account)}, event)'>${escapeRecapHtml(account)}</button>`
            : `<div class="mt-1 text-xs opacity-40">未记录账号</div>`;
        tbody.append(`<tr>
            <td>
                <div class="font-medium break-all">${escapeRecapHtml(nickname)}</div>
                ${accountMeta}
            </td>
            <td>${escapeRecapHtml(giftName)}</td>
            <td class="text-right">${count.toLocaleString()}</td>
            <td class="text-right">💎 ${unitPrice.toLocaleString()}</td>
            <td class="text-right">💎 ${totalValue.toLocaleString()}</td>
        </tr>`);
    });
}

async function copyGiftAccount(text, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!text) return;

    let copied = false;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            copied = true;
        }
    } catch (err) {
        copied = false;
    }

    if (!copied) {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', 'readonly');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            copied = document.execCommand('copy');
            document.body.removeChild(textarea);
        } catch (err) {
            copied = false;
        }
    }

    const el = event?.currentTarget;
    if (!el) return;

    const originalText = el.dataset.originalText || el.textContent;
    el.dataset.originalText = originalText;
    el.textContent = copied ? '✓ 已复制' : '复制失败';
    setTimeout(() => {
        el.textContent = originalText;
    }, 1000);
}
window.copyGiftAccount = copyGiftAccount;

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
    if (currentSessionId === 'live') {
        ensureLiveDetailAggregationState(roomId);
    }
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

function updateChatStats(msg) {
    if (!isLiveDetailAggregationReady()) return;

    const userKey = normalizeLiveUserKey(msg);
    liveDetailAggregationState.summary.totalComments += 1;
    upsertLiveLeaderboardEntry(liveDetailAggregationState.chatters, userKey, msg, 'count', 1);

    renderLiveSummaryState();
    renderLiveChatterState();
}

function updateGiftStats(msg) {
    if (!isLiveDetailAggregationReady()) return;

    const userKey = normalizeLiveUserKey(msg);
    const giftValue = toStatsNumber(msg.diamondCount, 0) * toStatsNumber(msg.repeatCount, 1);

    liveDetailAggregationState.summary.totalGiftValue += giftValue;
    upsertLiveLeaderboardEntry(liveDetailAggregationState.gifters, userKey, msg, 'value', giftValue);
    upsertLiveGiftDetailEntry(msg);

    renderLiveSummaryState();
    renderLiveGiftState();
}

function updateMemberStats(msg) {
    if (!isLiveDetailAggregationReady()) return;

    liveDetailAggregationState.summary.totalVisits += 1;
    renderLiveSummaryState();
}

function updateLikeStats(msg) {
    if (!isLiveDetailAggregationReady()) return;

    const userKey = normalizeLiveUserKey(msg);
    const likeDelta = toStatsNumber(msg.likeCount, 0);
    const currentLikes = toStatsNumber(liveDetailAggregationState.summary.totalLikes, 0);

    liveDetailAggregationState.summary.totalLikes = Math.max(
        currentLikes + likeDelta,
        toStatsNumber(msg.totalLikeCount, 0)
    );
    upsertLiveLeaderboardEntry(liveDetailAggregationState.likers, userKey, msg, 'count', likeDelta);

    renderLiveSummaryState();
    renderLiveLikerState();
}

function scrollToBottom() {
    const el = $('#chatContainer');
    el.scrollTop(el[0].scrollHeight);
}

function clearStats() {
    $('#giftTable tbody').empty();
    // ...
}

function formatBeijingDateTime(value, fallback = '--') {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
}

function formatSessionOffsetPoint(value, sessionStartAt = null, fallback = '-') {
    if (!value) return fallback;
    const normalized = String(value || '').trim();
    if (!normalized) return fallback;
    if (normalized.startsWith('开播后')) return normalized;

    const sessionStartMs = sessionStartAt ? new Date(sessionStartAt).getTime() : NaN;
    if (!Number.isFinite(sessionStartMs)) {
        const date = new Date(normalized);
        if (Number.isFinite(date.getTime())) {
            return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
        }
        return normalized || fallback;
    }

    const date = new Date(normalized);
    let pointMs = Number.isFinite(date.getTime()) ? date.getTime() : NaN;
    if (!Number.isFinite(pointMs)) {
        const hhmmMatch = /^(\d{2}):(\d{2})$/.exec(normalized);
        const hhmmssMatch = /^(\d{2}):(\d{2}):(\d{2})$/.exec(normalized);
        if (!hhmmMatch && !hhmmssMatch) return normalized || fallback;
        const point = new Date(sessionStartMs);
        const hoursPart = Number((hhmmssMatch || hhmmMatch)[1]);
        const minutesPart = Number((hhmmssMatch || hhmmMatch)[2]);
        const secondsPart = hhmmssMatch ? Number(hhmmssMatch[3]) : 0;
        point.setHours(hoursPart, minutesPart, secondsPart, 0);
        if (point.getTime() < sessionStartMs) point.setDate(point.getDate() + 1);
        pointMs = point.getTime();
    }

    const diffSeconds = Math.max(0, Math.floor((pointMs - sessionStartMs) / 1000));
    const hours = Math.floor(diffSeconds / 3600);
    const minutes = Math.floor((diffSeconds % 3600) / 60);
    const seconds = diffSeconds % 60;
    return `开播后${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildSessionOffsetRangeLabel(startTime, durationSeconds, fallback = '') {
    const safeDurationSeconds = Math.max(0, Math.floor(Number(durationSeconds || 0)));
    const endHours = Math.floor(safeDurationSeconds / 3600);
    const endMinutes = Math.floor((safeDurationSeconds % 3600) / 60);
    const endSeconds = safeDurationSeconds % 60;
    if (!startTime && !safeDurationSeconds) return fallback;
    return `开播后00:00:00-开播后${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}:${String(endSeconds).padStart(2, '0')}`;
}

// Update tab switching for DaisyUI
function switchDetailTab(tabId, btnElement) {
    $('#section-roomDetail .tab').removeClass('tab-active');
    $(btnElement).addClass('tab-active');
    $('.detail-tab-content').addClass('hidden');
    $(`#tab-${tabId}`).removeClass('hidden');

    if (tabId === 'timeStats') {
        renderSessionRecap(currentDetailRoomId, currentSessionId);
    }
}

function escapeRecapHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isSessionRecapTabActive() {
    const tab = document.getElementById('tab-timeStats');
    return !!tab && !tab.classList.contains('hidden');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setSessionRecapExportState({ visible = false, disabled = true, loadingType = '' } = {}) {
    const wrap = document.getElementById('sessionRecapExportActions');
    const menuBtn = document.getElementById('sessionRecapExportMenuBtn');
    const imageBtn = document.getElementById('exportSessionRecapImageBtn');
    const pdfBtn = document.getElementById('exportSessionRecapPdfBtn');

    if (wrap) {
        wrap.classList.toggle('hidden', !visible);
    }

    if (menuBtn) {
        if (!menuBtn.dataset.defaultLabel) menuBtn.dataset.defaultLabel = '导出复盘';
        menuBtn.disabled = !visible || disabled;
        menuBtn.classList.toggle('btn-disabled', !visible || disabled);
        menuBtn.classList.remove('loading');
        menuBtn.textContent = loadingType === 'image'
            ? '导出图片中...'
            : loadingType === 'pdf'
                ? '导出PDF中...'
                : menuBtn.dataset.defaultLabel;
        if (loadingType) menuBtn.classList.add('loading');
    }

    [imageBtn, pdfBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = !visible || disabled;
    });
}

function getAdaptiveExportPixelRatio(width, height) {
    const safeWidth = Math.max(1, Number(width || 0));
    const safeHeight = Math.max(1, Number(height || 0));
    const area = safeWidth * safeHeight;
    const deviceRatio = Math.max(1, Number(window.devicePixelRatio || 1));

    if (area >= 12000000) return Math.min(deviceRatio, 1);
    if (area >= 8000000) return Math.min(deviceRatio, 1.1);
    if (area >= 5000000) return Math.min(deviceRatio, 1.2);
    if (area >= 3000000) return Math.min(deviceRatio, 1.35);
    return Math.min(deviceRatio, 1.5);
}

function getRoomCustomerAnalysisActionElements() {
    return {
        wraps: Array.from(document.querySelectorAll('[data-room-customer-export-wrap="true"]')),
        menuButtons: Array.from(document.querySelectorAll('[data-room-customer-export-menu-btn="true"]')),
        imageButtons: Array.from(document.querySelectorAll('[data-room-customer-export-image-btn="true"]')),
        pdfButtons: Array.from(document.querySelectorAll('[data-room-customer-export-pdf-btn="true"]')),
        runButtons: Array.from(document.querySelectorAll('[data-room-customer-run-btn="true"]'))
    };
}

function normalizeRecapCustomerIdentity(value) {
    return String(value || '').trim().toLowerCase();
}

function findAiCustomerNarrativeMatch(systemItem, aiItems = [], usedIndexes = new Set()) {
    if (!Array.isArray(aiItems) || !aiItems.length) return null;
    const systemUniqueId = normalizeRecapCustomerIdentity(systemItem?.uniqueId);
    const systemNickname = normalizeRecapCustomerIdentity(systemItem?.nickname);

    let matchedIndex = aiItems.findIndex((candidate, index) => {
        if (usedIndexes.has(index)) return false;
        return systemUniqueId && normalizeRecapCustomerIdentity(candidate?.uniqueId) === systemUniqueId;
    });

    if (matchedIndex === -1) {
        matchedIndex = aiItems.findIndex((candidate, index) => {
            if (usedIndexes.has(index)) return false;
            return systemNickname && normalizeRecapCustomerIdentity(candidate?.nickname) === systemNickname;
        });
    }

    if (matchedIndex === -1) return null;
    usedIndexes.add(matchedIndex);
    return aiItems[matchedIndex] || null;
}

function mergeSessionRecapCustomerItems(systemItems = [], aiItems = [], segmentType = 'core') {
    if (!Array.isArray(systemItems) || !systemItems.length) return [];

    const usedIndexes = new Set();
    return systemItems.map((item, index) => {
        const aiItem = findAiCustomerNarrativeMatch(item, aiItems, usedIndexes) || {};
        const merged = {
            ...item,
            nickname: item?.nickname || aiItem?.nickname || '匿名',
            uniqueId: item?.uniqueId || aiItem?.uniqueId || '',
            totalGiftValue: Number(item?.totalGiftValue ?? item?.sessionGiftValue ?? 0),
            sessionGiftValue: Number(item?.sessionGiftValue ?? item?.totalGiftValue ?? 0),
            giftCount: Number(item?.giftCount || 0),
            historicalValue: Number(item?.historicalValue || 0),
            chatCount: Number(item?.chatCount || 0),
            likeCount: Number(item?.likeCount || 0),
            enterCount: Number(item?.enterCount || 0),
            firstEnterAt: item?.firstEnterAt || item?.enterTime || '',
            lastActiveAt: item?.lastActiveAt || item?.leaveTime || '',
            enterTime: item?.enterTime || item?.firstEnterAt || '',
            leaveTime: item?.leaveTime || item?.lastActiveAt || '',
            reason: item?.reason || aiItem?.reason || '',
            action: item?.action || aiItem?.action || '',
            keyBehavior: aiItem?.keyBehavior || item?.keyBehavior || item?.reason || '',
            maintenanceSuggestion: aiItem?.maintenanceSuggestion || item?.maintenanceSuggestion || item?.action || '',
            conversionScript: aiItem?.conversionScript || item?.conversionScript || '',
            riskReason: aiItem?.riskReason || item?.riskReason || item?.reason || '',
            recoveryStrategy: aiItem?.recoveryStrategy || item?.recoveryStrategy || item?.action || ''
        };

        if (segmentType === 'potential' && !merged.maintenanceSuggestion) {
            merged.maintenanceSuggestion = merged.action || '';
        }
        if (segmentType === 'risk' && !merged.maintenanceSuggestion) {
            merged.maintenanceSuggestion = merged.recoveryStrategy || merged.action || '';
        }
        return merged;
    });
}

function mergeSessionRecapCustomers(systemCustomers = {}, aiCustomers = {}) {
    return {
        core: mergeSessionRecapCustomerItems(systemCustomers?.core || [], aiCustomers?.core || [], 'core'),
        potential: mergeSessionRecapCustomerItems(systemCustomers?.potential || [], aiCustomers?.potential || [], 'potential'),
        risk: mergeSessionRecapCustomerItems(systemCustomers?.risk || [], aiCustomers?.risk || [], 'risk')
    };
}

function buildSessionRecapExportFileName(ext = 'png') {
    const roomPart = String(currentDetailRoomId || 'room').trim() || 'room';
    const sessionPart = String(currentSessionId || 'session').trim() || 'session';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    return `AI直播复盘_${roomPart}_${sessionPart}_${stamp}.${ext}`.replace(/[\/:*?"<>|\s]+/g, '_');
}

function downloadBlob(blob, filename) {
    if (!blob) throw new Error('导出文件生成失败');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function captureSessionRecapCanvas() {
    const target = document.getElementById('tab-timeStats');
    const content = document.getElementById('sessionRecapContent');
    if (!target || !content || content.classList.contains('hidden')) {
        throw new Error('当前没有可导出的 AI直播复盘内容');
    }
    if (typeof window.htmlToImage?.toCanvas !== 'function') {
        throw new Error('导出组件尚未加载完成，请刷新页面后重试');
    }
    if (sessionRecapExporting) {
        throw new Error('导出任务正在进行中，请稍候');
    }

    const previous = {
        width: target.style.width,
        maxWidth: target.style.maxWidth,
        height: target.style.height,
        overflowY: target.style.overflowY,
        overflowX: target.style.overflowX
    };

    sessionRecapExporting = true;
    const exportWidth = Math.max(Math.ceil(target.getBoundingClientRect().width || 0), 1180);
    const exportHeight = Math.max(target.scrollHeight, target.offsetHeight, content.scrollHeight, content.offsetHeight);

    try {
        target.classList.add('session-recap-exporting');
        target.style.width = `${exportWidth}px`;
        target.style.maxWidth = `${exportWidth}px`;
        target.style.height = 'auto';
        target.style.overflowY = 'visible';
        target.style.overflowX = 'visible';

        await sleep(80);

        return await window.htmlToImage.toCanvas(target, {
            cacheBust: true,
            pixelRatio: getAdaptiveExportPixelRatio(exportWidth, exportHeight),
            backgroundColor: '#f4f7fb',
            width: exportWidth,
            height: exportHeight,
            canvasWidth: exportWidth,
            canvasHeight: exportHeight,
            style: {
                margin: '0',
                transform: 'none'
            }
        });
    } catch (err) {
        if (String(err?.message || '').includes('oklch')) {
            throw new Error('当前主题样式与导出引擎不兼容，已自动切换规避方案失败，请刷新页面后重试');
        }
        throw err;
    } finally {
        target.classList.remove('session-recap-exporting');
        target.style.width = previous.width;
        target.style.maxWidth = previous.maxWidth;
        target.style.height = previous.height;
        target.style.overflowY = previous.overflowY;
        target.style.overflowX = previous.overflowX;
        sessionRecapExporting = false;
    }
}

async function exportSessionRecapAsImage() {
    const hasContent = document.getElementById('sessionRecapContent') && !document.getElementById('sessionRecapContent').classList.contains('hidden');
    if (!hasContent) {
        alert('当前没有可导出的 AI直播复盘内容');
        return;
    }
    try {
        document.getElementById('sessionRecapExportMenuBtn')?.blur();
        setSessionRecapExportState({ visible: true, disabled: true, loadingType: 'image' });
        await withGlobalLoading('正在导出复盘图片，请稍候...', async () => {
            const canvas = await captureSessionRecapCanvas();
            await nextPaint(1);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1));
            downloadBlob(blob, buildSessionRecapExportFileName('png'));
        }, { variant: 'compact', paintFrames: 2 });
    } catch (err) {
        alert(err?.message || '导出图片失败，请稍后重试');
    } finally {
        setSessionRecapExportState({ visible: hasContent, disabled: false });
    }
}

async function exportSessionRecapAsPdf() {
    const hasContent = document.getElementById('sessionRecapContent') && !document.getElementById('sessionRecapContent').classList.contains('hidden');
    if (!hasContent) {
        alert('当前没有可导出的 AI直播复盘内容');
        return;
    }
    try {
        const jsPDF = window.jspdf?.jsPDF;
        if (typeof jsPDF !== 'function') throw new Error('PDF 导出组件尚未加载完成，请刷新页面后重试');

        document.getElementById('sessionRecapExportMenuBtn')?.blur();
        setSessionRecapExportState({ visible: true, disabled: true, loadingType: 'pdf' });
        await withGlobalLoading('正在导出复盘 PDF，请稍候...', async () => {
            const canvas = await captureSessionRecapCanvas();
            await nextPaint(1);
            const pdf = new jsPDF('p', 'pt', 'a4');
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const margin = 22;
            const usableWidth = pageWidth - margin * 2;
            const imageHeight = canvas.height * usableWidth / canvas.width;
            const imageData = canvas.toDataURL('image/png');

            let remainingHeight = imageHeight;
            let positionY = margin;
            pdf.addImage(imageData, 'PNG', margin, positionY, usableWidth, imageHeight, undefined, 'FAST');
            remainingHeight -= (pageHeight - margin * 2);

            while (remainingHeight > 0) {
                positionY = margin - (imageHeight - remainingHeight);
                pdf.addPage();
                pdf.addImage(imageData, 'PNG', margin, positionY, usableWidth, imageHeight, undefined, 'FAST');
                remainingHeight -= (pageHeight - margin * 2);
            }

            pdf.save(buildSessionRecapExportFileName('pdf'));
        }, { variant: 'compact', paintFrames: 2 });
    } catch (err) {
        alert(err?.message || '导出 PDF 失败，请稍后重试');
    } finally {
        setSessionRecapExportState({ visible: hasContent, disabled: false });
    }
}

function setRoomCustomerAnalysisExportState({ visible = false, disabled = true, loadingType = '' } = {}) {
    const { wraps, menuButtons, imageButtons, pdfButtons } = getRoomCustomerAnalysisActionElements();

    wraps.forEach(wrap => {
        wrap.classList.toggle('hidden', !visible);
    });

    menuButtons.forEach(menuBtn => {
        if (!menuBtn.dataset.defaultLabel) menuBtn.dataset.defaultLabel = '导出结果';
        menuBtn.disabled = !visible || disabled;
        menuBtn.classList.toggle('btn-disabled', !visible || disabled);
        menuBtn.classList.remove('loading');
        menuBtn.textContent = loadingType === 'image'
            ? '导出图片中...'
            : loadingType === 'pdf'
                ? '导出PDF中...'
                : menuBtn.dataset.defaultLabel;
        if (loadingType) menuBtn.classList.add('loading');
    });

    [...imageButtons, ...pdfButtons].forEach(btn => {
        if (!btn) return;
        btn.disabled = !visible || disabled;
    });
}

function buildRoomCustomerAnalysisExportFileName(ext = 'png') {
    const roomPart = String(currentRoomCustomerAnalysisState?.roomId || currentDetailRoomId || 'room').trim() || 'room';
    const userPart = String(currentRoomCustomerAnalysisState?.uniqueId || currentRoomCustomerAnalysisState?.nickname || currentRoomCustomerAnalysisState?.userId || 'user').trim() || 'user';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    return `客户价值深度挖掘_${roomPart}_${userPart}_${stamp}.${ext}`.replace(/[\/:*?"<>|\s]+/g, '_');
}

async function captureRoomCustomerAnalysisCanvas() {
    const modal = document.getElementById('roomCustomerAnalysisModal');
    const target = document.getElementById('roomCustomerAnalysisExportCard');
    if (!modal?.open || !target || !currentRoomCustomerAnalysisState?.hasAnalysisResult) {
        throw new Error('当前没有可导出的客户价值深度挖掘结果');
    }
    if (typeof window.htmlToImage?.toCanvas !== 'function') {
        throw new Error('导出组件尚未加载完成，请刷新页面后重试');
    }
    if (roomCustomerAnalysisExporting) {
        throw new Error('导出任务正在进行中，请稍候');
    }

    const previous = {
        width: target.style.width,
        maxWidth: target.style.maxWidth
    };

    roomCustomerAnalysisExporting = true;
    const exportWidth = Math.max(Math.ceil(target.getBoundingClientRect().width || 0), 980);
    const exportHeight = Math.max(target.scrollHeight, target.offsetHeight);

    try {
        target.classList.add('room-customer-analysis-exporting');
        target.style.width = `${exportWidth}px`;
        target.style.maxWidth = `${exportWidth}px`;
        await sleep(80);

        return await window.htmlToImage.toCanvas(target, {
            cacheBust: true,
            pixelRatio: getAdaptiveExportPixelRatio(exportWidth, exportHeight),
            backgroundColor: '#f4f7fb',
            width: exportWidth,
            height: exportHeight,
            canvasWidth: exportWidth,
            canvasHeight: exportHeight,
            style: {
                margin: '0',
                transform: 'none'
            }
        });
    } catch (err) {
        if (String(err?.message || '').includes('oklch')) {
            throw new Error('当前主题样式与导出引擎不兼容，请刷新页面后重试');
        }
        throw err;
    } finally {
        target.classList.remove('room-customer-analysis-exporting');
        target.style.width = previous.width;
        target.style.maxWidth = previous.maxWidth;
        roomCustomerAnalysisExporting = false;
    }
}

async function exportRoomCustomerAnalysisAsImage() {
    const hasContent = Boolean(currentRoomCustomerAnalysisState?.hasAnalysisResult);
    if (!hasContent) {
        alert('当前没有可导出的客户价值深度挖掘结果');
        return;
    }

    try {
        document.querySelectorAll('[data-room-customer-export-menu-btn="true"]').forEach(btn => btn.blur());
        setRoomCustomerAnalysisExportState({ visible: true, disabled: true, loadingType: 'image' });
        await withGlobalLoading('正在导出深挖图片，请稍候...', async () => {
            const canvas = await captureRoomCustomerAnalysisCanvas();
            await nextPaint(1);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1));
            downloadBlob(blob, buildRoomCustomerAnalysisExportFileName('png'));
        }, { variant: 'compact', paintFrames: 2 });
    } catch (err) {
        alert(err?.message || '导出图片失败，请稍后重试');
    } finally {
        setRoomCustomerAnalysisExportState({ visible: hasContent, disabled: false });
    }
}

async function exportRoomCustomerAnalysisAsPdf() {
    const hasContent = Boolean(currentRoomCustomerAnalysisState?.hasAnalysisResult);
    if (!hasContent) {
        alert('当前没有可导出的客户价值深度挖掘结果');
        return;
    }

    try {
        const jsPDF = window.jspdf?.jsPDF;
        if (typeof jsPDF !== 'function') throw new Error('PDF 导出组件尚未加载完成，请刷新页面后重试');

        document.querySelectorAll('[data-room-customer-export-menu-btn="true"]').forEach(btn => btn.blur());
        setRoomCustomerAnalysisExportState({ visible: true, disabled: true, loadingType: 'pdf' });
        await withGlobalLoading('正在导出深挖 PDF，请稍候...', async () => {
            const canvas = await captureRoomCustomerAnalysisCanvas();
            await nextPaint(1);
            const pdf = new jsPDF('p', 'pt', 'a4');
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const margin = 22;
            const usableWidth = pageWidth - margin * 2;
            const imageHeight = canvas.height * usableWidth / canvas.width;
            const imageData = canvas.toDataURL('image/png');

            let remainingHeight = imageHeight;
            let positionY = margin;
            pdf.addImage(imageData, 'PNG', margin, positionY, usableWidth, imageHeight, undefined, 'FAST');
            remainingHeight -= (pageHeight - margin * 2);

            while (remainingHeight > 0) {
                positionY = margin - (imageHeight - remainingHeight);
                pdf.addPage();
                pdf.addImage(imageData, 'PNG', margin, positionY, usableWidth, imageHeight, undefined, 'FAST');
                remainingHeight -= (pageHeight - margin * 2);
            }

            pdf.save(buildRoomCustomerAnalysisExportFileName('pdf'));
        }, { variant: 'compact', paintFrames: 2 });
    } catch (err) {
        alert(err?.message || '导出 PDF 失败，请稍后重试');
    } finally {
        setRoomCustomerAnalysisExportState({ visible: hasContent, disabled: false });
    }
}

function refreshShellMessageBadgeSoon() {
    if (typeof Auth === 'undefined' || typeof Auth.refreshMessageBadge !== 'function') return;
    Auth.refreshMessageBadge({ silent: true }).catch(() => { });
}

function setSessionRecapButtonState({ label, disabled = false, locked = false, tone = 'primary', loading = false } = {}) {
    const btn = document.getElementById('generateSessionRecapBtn');
    if (!btn) return;
    delete btn.dataset.locked;
    btn.disabled = Boolean(disabled);
    btn.classList.remove('loading', 'btn-primary', 'btn-warning', 'btn-secondary', 'btn-outline', 'btn-ghost');

    if (tone === 'locked') {
        btn.classList.add('btn-warning', 'btn-outline');
    } else if (tone === 'secondary') {
        btn.classList.add('btn-secondary', 'btn-outline');
    } else if (tone === 'ghost') {
        btn.classList.add('btn-ghost');
    } else {
        btn.classList.add('btn-primary');
    }

    if (locked) btn.dataset.locked = 'feature';
    if (loading) btn.classList.add('loading');
    if (label) btn.textContent = label;
}

function setSessionRecapStatus(text, className = 'badge badge-outline') {
    const status = document.getElementById('sessionRecapStatus');
    if (!status) return;
    status.className = className;
    status.textContent = text;
}

function setSessionRecapEmptyHtml(html, className = 'space-y-4') {
    const empty = document.getElementById('sessionRecapEmpty');
    const content = document.getElementById('sessionRecapContent');
    if (empty) {
        empty.className = className;
        empty.innerHTML = html;
        empty.classList.remove('hidden');
    }
    if (content) content.classList.add('hidden');
}

function buildSessionRecapInfoCard({ badge, title, description, rightPanel = '', chips = [], tone = 'primary' } = {}) {
    const toneClass = tone === 'warning'
        ? 'from-warning/12 via-base-100 to-base-100 border-warning/20'
        : tone === 'neutral'
            ? 'from-base-200/80 via-base-100 to-base-100 border-base-300'
            : 'from-primary/12 via-base-100 to-secondary/10 border-primary/20';
    return `
        <div class="rounded-box border bg-gradient-to-br ${toneClass} p-6 shadow-sm overflow-hidden">
            <div class="flex flex-col xl:flex-row gap-6 justify-between">
                <div class="max-w-2xl">
                    ${badge ? `<div class="badge badge-outline ${tone === 'warning' ? 'badge-warning' : tone === 'neutral' ? '' : 'badge-primary'}">${escapeRecapHtml(badge)}</div>` : ''}
                    <h4 class="text-2xl font-black mt-3 leading-tight">${escapeRecapHtml(title || '')}</h4>
                    <p class="text-sm leading-7 opacity-75 mt-3">${escapeRecapHtml(description || '')}</p>
                    ${chips.length ? `<div class="flex flex-wrap gap-2 mt-4">${chips.map(item => `<span class="badge badge-outline">${escapeRecapHtml(item)}</span>`).join('')}</div>` : ''}
                </div>
                ${rightPanel ? `<div class="w-full xl:max-w-sm rounded-box border border-base-300 bg-base-100/80 p-4 shadow-sm">${rightPanel}</div>` : ''}
            </div>
        </div>
    `;
}

function buildSessionRecapStatusOnlyCard({ panel = '', tone = 'primary' } = {}) {
    const toneClass = tone === 'warning'
        ? 'from-warning/12 via-base-100 to-base-100 border-warning/20'
        : tone === 'neutral'
            ? 'from-base-200/80 via-base-100 to-base-100 border-base-300'
            : 'from-primary/12 via-base-100 to-secondary/10 border-primary/20';
    return `
        <div class="rounded-box border bg-gradient-to-br ${toneClass} p-6 shadow-sm overflow-hidden">
            <div class="w-full max-w-xl rounded-box border border-base-300 bg-base-100/80 p-4 shadow-sm">${panel}</div>
        </div>
    `;
}

function showSessionRecapTeaser(recap = {}) {
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
    const pointCost = Number(recap?.pointCost || DEFAULT_SESSION_RECAP_POINTS);
    const overview = recap?.overview || {};
    const isLive = overview.sessionMode === 'live' || currentSessionId === 'live';
    const sessionRangeLabel = buildSessionOffsetRangeLabel(overview.startTime, overview.duration, '');

    const rightPanel = isLive
        ? `
            <div class="text-xs uppercase tracking-[0.18em] opacity-60">当前状态</div>
            <div class="mt-3 text-sm leading-7 opacity-80">实时场次先持续采集数据，等归档后再一键生成 AI直播复盘，结论会更稳。</div>
            <div class="mt-4 rounded-box bg-base-200/70 px-4 py-3 text-sm opacity-80">归档后可解锁：老板摘要 / 本场两点 / 价值客户 / 建议动作。</div>
        `
        : `
            <div class="text-xs uppercase tracking-[0.18em] opacity-60">本次将解锁</div>
            <div class="mt-3 space-y-2 text-sm leading-7 opacity-80">
                <div>• 给老板看的本场摘要</div>
                <div>• 本场两点 / 主要问题 / 下一步建议</div>
                <div>• 高频弹幕 Top50 价值筛选</div>
                <div>• 关键时刻时间轴</div>
                <div>• 核心 / 潜力 / 风险客户</div>
            </div>
            <div class="mt-4 rounded-box bg-base-200/70 px-4 py-3 text-sm leading-6">
                ${isAdmin ? '管理员生成不扣点；提交后会转入后台处理，完成后会通过消息通知提醒。' : `本场默认消耗 ${pointCost} AI点；提交后会转入后台处理，完成后会通过消息通知提醒。`}
            </div>
        `;

    setSessionRecapEmptyHtml(buildSessionRecapInfoCard({
        badge: isLive ? '实时场次' : '单场复盘 · 老板视角',
        title: isLive ? '归档后再生成会更准。' : '点击生成按钮开始 AI直播复盘。',
        description: isLive
            ? 'AI直播复盘更适合归档场次。归档后，系统会把本场结果、关键节点、价值客户和下一场动作建议一次性整理好。'
            : 'AI整理本场结果、关键节点、价值客户、高价值弹幕和下一步动作。',
        chips: isLive
            ? ['归档后生成更稳', '老板摘要', '价值客户', '关键时刻']
            : [sessionRangeLabel ? `开播时间范围 ${sessionRangeLabel}` : '单场归档复盘', '老板摘要', '关键时刻', '价值客户'],
        rightPanel,
        tone: isLive ? 'neutral' : 'primary'
    }));

    const summary = document.getElementById('sessionAiSummary');
    if (summary) summary.textContent = isLive ? '实时场次暂不展示 AI直播复盘，建议归档后生成。' : '点击右上角生成 AI直播复盘后，这里会显示给老板看的本场摘要。';
    const meta = document.getElementById('sessionAiMeta');
    if (meta) meta.textContent = isLive ? '实时场次' : '生成一次后，这个场次下次进入会直接显示。';

    setSessionRecapExportState({ visible: false });

    if (isLive) {
        setSessionRecapStatus('实时场次', 'badge badge-outline');
        setSessionRecapButtonState({ label: '实时场次暂不支持生成', disabled: true, tone: 'ghost' });
        return;
    }

    setSessionRecapStatus('待生成复盘', 'badge badge-outline');
    setSessionRecapButtonState({
        label: isAdmin ? '生成AI直播复盘（管理员免扣点）' : `生成AI直播复盘（${pointCost}AI点）`,
        disabled: false,
        tone: 'primary'
    });
}

function showSessionRecapGenerating(delayMs = 7000) {
    const seconds = Math.max(5, Math.ceil(delayMs / 1000));
    const rightPanel = `
        <div class="flex items-center justify-between gap-3">
            <div class="text-xs uppercase tracking-[0.18em] opacity-60">后台工作状态</div>
            <span class="badge badge-primary badge-outline">生成中</span>
        </div>
        <div class="mt-3 space-y-3 text-sm leading-7 opacity-80">
            ${SESSION_RECAP_LOADING_TIPS.map((tip, index) => `
                <div class="flex items-center gap-3 rounded-box bg-base-200/60 px-3 py-3">
                    <span class="loading loading-dots loading-sm text-primary"></span>
                    <span>${escapeRecapHtml(tip)}</span>
                </div>
            `).join('')}
        </div>
        <div class="mt-4 rounded-box bg-base-200/70 px-4 py-3 text-sm leading-6">大概还需要 ${seconds} 秒左右，AI 正在整理老板摘要和直播复盘重点。</div>
    `;

    setSessionRecapEmptyHtml(buildSessionRecapStatusOnlyCard({
        panel: rightPanel,
        tone: 'primary'
    }));

    setSessionRecapExportState({ visible: false });

    const summary = document.getElementById('sessionAiSummary');
    if (summary) summary.textContent = 'AI 正在整理老板摘要、本场两点与价值客户结论，请稍候片刻…';
    const meta = document.getElementById('sessionAiMeta');
    if (meta) meta.textContent = '生成中 · 预计 5-10 秒';
    setSessionRecapStatus('AI生成中', 'badge badge-primary');
    setSessionRecapButtonState({ label: '正在生成AI直播复盘...', disabled: true, tone: 'secondary', loading: true });
}

function isSessionAiJobPending(job) {
    return job && ['queued', 'processing'].includes(String(job.status || '').toLowerCase());
}

function clearSessionAiJobPolling() {
    if (sessionAiJobPollTimer) {
        window.clearInterval(sessionAiJobPollTimer);
        sessionAiJobPollTimer = null;
    }
    sessionAiJobPollTarget = null;
}

async function pollSessionAiJobStatus(jobId, roomId, sessionId) {
    if (!jobId || typeof Auth === 'undefined' || typeof Auth.apiFetch !== 'function') return;
    if (currentDetailRoomId !== roomId || currentSessionId !== sessionId) {
        clearSessionAiJobPolling();
        return;
    }

    try {
        const res = await Auth.apiFetch(`/api/user/ai-work/jobs/${encodeURIComponent(jobId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '获取任务状态失败');
        if (currentDetailRoomId !== roomId || currentSessionId !== sessionId) {
            clearSessionAiJobPolling();
            return;
        }

        if (!currentSessionRecap) currentSessionRecap = { sessionId, pointCost: DEFAULT_SESSION_RECAP_POINTS, overview: {} };
        currentSessionRecap.aiJob = data.job || null;

        if (isSessionAiJobPending(data.job)) {
            restoreSessionRecapStage(currentSessionRecap);
            return;
        }

        clearSessionAiJobPolling();
        await renderSessionRecap(roomId, sessionId);
        if (data.job?.status === 'completed') {
            refreshShellMessageBadgeSoon();
            addSystemMessage('AI直播复盘已完成，可直接查看结果。');
        } else if (data.job?.status === 'failed') {
            refreshShellMessageBadgeSoon();
            addSystemMessage(`AI直播复盘处理失败：${data.job.errorMessage || '请稍后重试'}`);
        }
    } catch (err) {
        console.error('pollSessionAiJobStatus error', err);
    }
}

function startSessionAiJobPolling(job, roomId, sessionId) {
    if (!job?.id || !isSessionAiJobPending(job)) {
        clearSessionAiJobPolling();
        return;
    }

    const nextTarget = `${job.id}:${roomId}:${sessionId}`;
    if (sessionAiJobPollTarget === nextTarget && sessionAiJobPollTimer) return;

    clearSessionAiJobPolling();
    sessionAiJobPollTarget = nextTarget;
    sessionAiJobPollTimer = window.setInterval(() => {
        pollSessionAiJobStatus(job.id, roomId, sessionId);
    }, 10000);
}

function showSessionRecapQueued(recap = {}) {
    const aiJob = recap?.aiJob || {};
    const isProcessing = String(aiJob.status || '') === 'processing';
    const progressPercent = Math.max(5, Math.min(99, Number(aiJob.progressPercent || (isProcessing ? 35 : 10))));
    const currentStep = aiJob.currentStep || (isProcessing ? '正在后台处理中' : '等待后台调度');
    const rightPanel = `
        <div class="text-xs uppercase tracking-[0.18em] opacity-60">后台工作状态</div>
        <div class="mt-3 rounded-box bg-base-200/70 px-4 py-3">
            <div class="flex items-center justify-between gap-3 text-sm">
                <span>${escapeRecapHtml(isProcessing ? '处理中' : '排队中')}</span>
                <span class="font-semibold">${progressPercent}%</span>
            </div>
            <progress class="progress progress-primary w-full mt-3" value="${progressPercent}" max="100"></progress>
            <div class="text-xs opacity-70 mt-3 leading-6">当前步骤：${escapeRecapHtml(currentStep)}</div>
        </div>
        <div class="mt-4 text-sm leading-7 opacity-80">AI 已启动，正在后台工作中，无需一直在此等待。任务完成后会有站内通知。</div>
    `;

    setSessionRecapEmptyHtml(buildSessionRecapStatusOnlyCard({
        panel: rightPanel,
        tone: 'neutral'
    }));

    const summary = document.getElementById('sessionAiSummary');
    if (summary) summary.textContent = 'AI 已启动，正在后台工作中，无需一直在此等待，完成后会通过消息通知提醒。';
    const meta = document.getElementById('sessionAiMeta');
    if (meta) meta.textContent = `${isProcessing ? '后台处理中' : '后台排队中'} · ${currentStep}`;
    setSessionRecapStatus(isProcessing ? '后台处理中' : '后台排队中', 'badge badge-primary');
    setSessionRecapButtonState({ label: isProcessing ? 'AI后台处理中...' : 'AI排队中...', disabled: true, tone: 'secondary', loading: isProcessing });
    setSessionRecapExportState({ visible: false });
}

function showSessionRecapLoadingState(message = 'AI直播复盘加载中...') {
    currentSessionRecap = null;
    if (sessionRecapTrendChart) {
        sessionRecapTrendChart.destroy();
        sessionRecapTrendChart = null;
    }
    if (sessionRecapRadarChart) {
        sessionRecapRadarChart.destroy();
        sessionRecapRadarChart = null;
    }

    setSessionRecapEmptyHtml(`
        <div class="rounded-box border border-base-300 bg-base-100 p-5 text-sm leading-7 opacity-70 shadow-sm">
            <div class="flex items-center gap-3">
                <span class="loading loading-spinner loading-sm text-primary"></span>
                <span>${escapeRecapHtml(message)}</span>
            </div>
        </div>
    `);

    const participantHint = document.getElementById('recapParticipantHint');
    if (participantHint) participantHint.textContent = '发言/点赞/送礼/进房去重';
    const summary = document.getElementById('sessionAiSummary');
    if (summary) summary.textContent = '正在读取当前场次的 AI直播复盘数据，请稍候。';
    const meta = document.getElementById('sessionAiMeta');
    if (meta) meta.textContent = '加载中';
    setSessionRecapStatus('加载中', 'badge badge-secondary');
    setSessionRecapButtonState({ label: 'AI直播复盘加载中...', disabled: true, tone: 'secondary', loading: true });
    setSessionRecapExportState({ visible: false });
}

function resetSessionRecapState(message = '请先选择一场直播。建议切到归档场次后生成 AI直播复盘。') {
    currentSessionRecap = null;
    if (sessionRecapTrendChart) {
        sessionRecapTrendChart.destroy();
        sessionRecapTrendChart = null;
    }
    if (sessionRecapRadarChart) {
        sessionRecapRadarChart.destroy();
        sessionRecapRadarChart = null;
    }

    setSessionRecapEmptyHtml(`
        <div class="rounded-box border border-base-300 bg-base-100 p-5 text-sm leading-7 opacity-70 shadow-sm">
            ${escapeRecapHtml(message)}
        </div>
    `);

    const participantHint = document.getElementById('recapParticipantHint');
    if (participantHint) participantHint.textContent = '发言/点赞/送礼/进房去重';
    const summary = document.getElementById('sessionAiSummary');
    if (summary) summary.textContent = `点击右上角生成AI直播复盘，默认按 ${DEFAULT_SESSION_RECAP_POINTS} AI点计费。`;
    const meta = document.getElementById('sessionAiMeta');
    if (meta) meta.textContent = '未生成';
    setSessionRecapStatus('待生成复盘', 'badge badge-outline');
    setSessionRecapButtonState({ label: `生成AI直播复盘（${DEFAULT_SESSION_RECAP_POINTS}AI点）`, disabled: false, tone: 'primary' });
    setSessionRecapExportState({ visible: false });
}

function showSessionRecapLocked(message = '当前会员计划不包含此项权益') {
    currentSessionRecap = {
        ...(currentSessionRecap || {}),
        featureLocked: true,
        lockedMessage: message
    };

    const rightPanel = `
        <div class="text-xs uppercase tracking-[0.18em] opacity-60">解锁后可用</div>
        <div class="mt-3 space-y-2 text-sm leading-7 opacity-80">
            <div>• 给老板看的本场摘要</div>
            <div>• 本场两点 / 主要问题 / 下一步建议</div>
            <div>• 高频弹幕筛选</div>
            <div>• 关键时刻与节奏图</div>
            <div>• 核心 / 潜力 / 风险客户</div>
        </div>
        <div class="mt-4 rounded-box bg-base-200/70 px-4 py-3 text-sm leading-6">升级到包含 AI直播复盘权益的套餐后，即可对单场归档直播进行生成。</div>
    `;

    setSessionRecapEmptyHtml(buildSessionRecapInfoCard({
        badge: '会员权益',
        title: '当前会员计划不包含 AI直播复盘。',
        description: '这个能力属于指定套餐权益。开通后，你就能把单场直播直接整理成老板能看懂的结果页。',
        chips: ['老板摘要', '关键时刻', '价值客户', '动作建议'],
        rightPanel,
        tone: 'warning'
    }));

    setSessionRecapExportState({ visible: false });

    const summary = document.getElementById('sessionAiSummary');
    if (summary) summary.textContent = message;
    const meta = document.getElementById('sessionAiMeta');
    if (meta) meta.textContent = '升级到包含该权益的套餐后即可使用';
    setSessionRecapStatus('权益未开通', 'badge badge-warning');
    setSessionRecapButtonState({ label: '当前会员计划不包含此项权益', disabled: false, locked: true, tone: 'locked' });
}

function restoreSessionRecapStage(recap) {
    if (!recap) {
        resetSessionRecapState();
        return;
    }
    if (recap.featureLocked) {
        showSessionRecapLocked(recap.lockedMessage || '当前会员计划不包含此项权益');
        return;
    }
    if (isSessionAiJobPending(recap?.aiJob)) {
        currentSessionRecap = recap;
        showSessionRecapQueued(recap);
        startSessionAiJobPolling(recap.aiJob, currentDetailRoomId, recap.sessionId || currentSessionId);
        return;
    }

    clearSessionAiJobPolling();

    if (!recap?.aiReview && recap?.aiJob?.status === 'failed' && recap.aiJob?.errorMessage) {
        currentSessionRecap = { ...recap, aiReviewError: recap.aiJob.errorMessage };
        applySessionRecapData(currentSessionRecap);
        return;
    }
    if (recap?.aiReview && recap.aiReview.summary) {
        currentSessionRecap = recap;
        applySessionRecapData(recap);
        return;
    }
    currentSessionRecap = recap;
    showSessionRecapTeaser(recap);
}

function buildFallbackRecapReview(recap) {
    const overview = recap?.overview || {};
    const firstMoment = Array.isArray(recap?.keyMoments) ? recap.keyMoments[0] : null;
    return {
        summary: overview.score
            ? `本场评分 ${overview.score}/100，当前判断为${overview.gradeLabel || '稳态场'}。${firstMoment ? `重点看 ${firstMoment.timeRange} 的${firstMoment.title}。` : ''}`
            : '本场数据量有限，建议积累更多单场后再生成 AI直播复盘。',
        highlights: Array.isArray(recap?.insights?.highlights) ? recap.insights.highlights : [],
        issues: Array.isArray(recap?.insights?.issues) ? recap.insights.issues : [],
        actions: Array.isArray(recap?.insights?.actions) ? recap.insights.actions : []
    };
}

function renderRecapTags(tags = []) {
    const wrap = document.getElementById('recapTags');
    if (!wrap) return;
    wrap.innerHTML = (tags.length ? tags : ['稳态经营']).map(tag => `<span class="badge badge-primary badge-outline">${escapeRecapHtml(tag)}</span>`).join('');
}

function formatRecapTimeText(value) {
    return formatSessionOffsetPoint(value, currentSessionRecap?.overview?.startTime || null, '-');
}

function renderRecapScoreBreakdown(score = {}, overview = {}) {
    const wrap = document.getElementById('recapScoreBreakdown');
    const reason = document.getElementById('recapScoreReason');
    if (!wrap || !reason) return;

    const items = [
        ['内容吸引力', Number(score.contentAttraction || 0), 20],
        ['用户互动', Number(score.userInteraction || 0), 20],
        ['礼物转化', Number(score.giftConversion || 0), 35],
        ['留存增长', Number(score.retentionGrowth || 0), 15],
        ['整体节奏', Number(score.overallRhythm || 0), 10],
    ];

    wrap.innerHTML = items.map(([label, value, total]) => `
        <div class="rounded-box bg-base-200/60 px-2 py-2">
            <div class="opacity-60">${escapeRecapHtml(label)}</div>
            <div class="font-semibold">${value}/${total}</div>
        </div>
    `).join('');
    reason.textContent = score.reason || overview.gradeLabel || '暂无评分理由';
}

function renderRecapList(listId, items, emptyText) {
    const list = document.getElementById(listId);
    if (!list) return;
    if (!items || items.length === 0) {
        list.innerHTML = `<li class="text-sm opacity-50">${escapeRecapHtml(emptyText)}</li>`;
        return;
    }
    list.innerHTML = items.map(item => `<li class="rounded-box bg-base-200/60 px-3 py-3 leading-6">${escapeRecapHtml(item)}</li>`).join('');
}

function renderRecapKeyMoments(moments = []) {
    const wrap = document.getElementById('recapKeyMoments');
    if (!wrap) return;
    if (!moments.length) {
        wrap.innerHTML = '<div class="rounded-box bg-base-200 px-4 py-6 text-sm opacity-60">本场关键时刻还不足以形成结论。</div>';
        return;
    }
    wrap.innerHTML = moments.map(item => `
        <div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
            <div class="flex items-center justify-between gap-2 mb-2">
                <div class="font-semibold">${escapeRecapHtml(item.title || '关键时刻')}</div>
                <span class="badge badge-outline">${escapeRecapHtml(item.metric || '-')}</span>
            </div>
            <div class="text-xs opacity-60 mb-2">${escapeRecapHtml(item.timeRange || '-')}</div>
            <div class="text-sm leading-6 opacity-80">${escapeRecapHtml(item.description || '')}</div>
        </div>
    `).join('');
}

function renderRecapValuableComments(items = [], emptyText = '当前没有筛出明确的高价值弹幕信号。') {
    const wrap = document.getElementById('recapValuableComments');
    if (!wrap) return;
    if (!items.length) {
        wrap.innerHTML = `<div class="rounded-box bg-base-200 px-4 py-6 text-sm opacity-60">${escapeRecapHtml(emptyText)}</div>`;
        return;
    }
    wrap.innerHTML = items.map(item => `
        <div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="font-semibold break-all">${escapeRecapHtml(item.text || '')}</div>
                <span class="badge badge-outline">出现 ${Number(item.count || 0)} 次</span>
            </div>
            <div class="text-xs leading-6 opacity-70 mt-3">${escapeRecapHtml(item.reason || '')}</div>
            <div class="text-xs leading-6 text-primary mt-2">${escapeRecapHtml(item.insight || '')}</div>
        </div>
    `).join('');
}

function renderRecapCustomerSegment(containerId, items = [], emptyText = '暂无客户数据', segmentType = 'generic') {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    if (!items.length) {
        wrap.innerHTML = `<div class="rounded-box bg-base-200 px-4 py-6 text-sm opacity-60">${escapeRecapHtml(emptyText)}</div>`;
        return;
    }
    wrap.innerHTML = items.map(item => {
        const metaBadges = [];
        const sessionGiftValue = Number(item?.sessionGiftValue ?? 0);
        const giftCount = Number(item?.giftCount ?? 0);
        const sessionGiftBadge = sessionGiftValue > 0
            ? `本场💎 ${sessionGiftValue.toLocaleString()}`
            : giftCount > 0
                ? '本场已送礼'
                : '本场未出手';
        if (segmentType === 'risk') {
            metaBadges.push(`<span class="badge badge-ghost badge-sm">${escapeRecapHtml(formatRecapTimeText(item.enterTime || item.firstEnterAt))} → ${escapeRecapHtml(formatRecapTimeText(item.leaveTime || item.lastActiveAt))}</span>`);
        }
        return `
        <div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                    <div class="font-semibold truncate" title="${escapeRecapHtml(item.nickname || '匿名')}">${escapeRecapHtml(item.nickname || '匿名')}</div>
                    <div class="text-xs opacity-60 mt-1 truncate" title="${escapeRecapHtml(item.uniqueId || '未记录账号')}">${escapeRecapHtml(item.uniqueId || '未记录账号')}</div>
                </div>
                <span class="badge badge-outline shrink-0 whitespace-nowrap self-start">${sessionGiftBadge}</span>
            </div>
            ${metaBadges.length ? `<div class="flex flex-wrap gap-2 mt-3 text-xs opacity-70">${metaBadges.join('')}</div>` : ''}
            <div class="text-xs leading-6 mt-3 opacity-80 break-words">${escapeRecapHtml(item.keyBehavior || item.reason || '')}</div>
            <div class="text-xs leading-6 mt-2 text-primary break-words">${escapeRecapHtml(item.maintenanceSuggestion || item.action || item.recoveryStrategy || '')}</div>
            ${segmentType === 'potential' && item.conversionScript ? `<div class="mt-3 rounded-box session-recap-note-box px-3 py-3 text-xs leading-6">承接话术：${escapeRecapHtml(item.conversionScript)}</div>` : ''}
            ${segmentType === 'risk' && item.riskReason ? `<div class="mt-3 rounded-box session-recap-risk-box px-3 py-3 text-xs leading-6">流失原因：${escapeRecapHtml(item.riskReason)}</div>` : ''}
        </div>
    `;
    }).join('');
}

function renderSessionRecapTrendChart(timeline = [], trafficMetricLabel = '在线波动') {
    const ctx = document.getElementById('sessionRecapTrendChart');
    if (!ctx) return;
    if (sessionRecapTrendChart) sessionRecapTrendChart.destroy();
    const labels = timeline.map(item => item.timeRange);
    sessionRecapTrendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: '礼物流速',
                    data: timeline.map(item => item.income),
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.18)',
                    fill: true,
                    tension: 0.35,
                    yAxisID: 'y'
                },
                {
                    label: '弹幕热度',
                    data: timeline.map(item => item.comments),
                    borderColor: '#38bdf8',
                    backgroundColor: 'rgba(56, 189, 248, 0.16)',
                    fill: true,
                    tension: 0.35,
                    yAxisID: 'y1'
                },
                {
                    label: trafficMetricLabel,
                    data: timeline.map(item => item.maxOnline),
                    borderColor: '#a855f7',
                    backgroundColor: 'rgba(168, 85, 247, 0.14)',
                    fill: false,
                    tension: 0.3,
                    borderDash: [6, 4],
                    yAxisID: 'y2'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: '礼物 💎' } },
                y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '弹幕' } },
                y2: { beginAtZero: true, position: 'right', display: false, title: { display: false, text: trafficMetricLabel } }
            },
            plugins: {
                legend: { position: 'top' }
            }
        }
    });
}

function renderSessionRecapRadarChart(radar = []) {
    const ctx = document.getElementById('sessionRecapRadarChart');
    if (!ctx) return;
    if (sessionRecapRadarChart) sessionRecapRadarChart.destroy();
    sessionRecapRadarChart = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: radar.map(item => item.label),
            datasets: [{
                label: '单场能力画像',
                data: radar.map(item => item.value),
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.18)',
                pointBackgroundColor: '#6366f1'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    min: 0,
                    max: 100,
                    ticks: { stepSize: 20, backdropColor: 'transparent' }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function applySessionRecapData(recap) {
    const empty = document.getElementById('sessionRecapEmpty');
    const content = document.getElementById('sessionRecapContent');
    if (empty) empty.classList.add('hidden');
    if (content) content.classList.remove('hidden');

    const overview = recap?.overview || {};
    const fallbackReview = buildFallbackRecapReview(recap);
    const hasAiReview = Boolean(recap?.aiReview && recap.aiReview.summary);
    const activeReview = hasAiReview ? recap.aiReview : fallbackReview;
    const displayHighlights = (activeReview.highlights && activeReview.highlights.length) ? activeReview.highlights : (recap?.insights?.highlights || []);
    const displayIssues = (activeReview.issues && activeReview.issues.length) ? activeReview.issues : (recap?.insights?.issues || []);
    const displayActions = (activeReview.actions && activeReview.actions.length) ? activeReview.actions : (recap?.insights?.actions || []);
    const displayTags = Array.isArray(activeReview.tags) && activeReview.tags.length ? activeReview.tags : (Array.isArray(overview.tags) ? overview.tags : []);
    const displayScore = activeReview.score || {};
    const displayValuableComments = Array.isArray(activeReview.valuableComments) ? activeReview.valuableComments : [];
    const displayCustomers = mergeSessionRecapCustomers(recap?.valueCustomers || {}, activeReview.customers || {});

    document.getElementById('recapScoreValue').textContent = Number(displayScore.total || overview.score || 0).toLocaleString();
    document.getElementById('recapScoreGrade').textContent = overview.grade || '-';
    document.getElementById('recapScoreLabel').textContent = overview.gradeLabel || '暂无数据';
    document.getElementById('recapGiftValue').textContent = `💎 ${Number(overview.totalGiftValue || 0).toLocaleString()}`;
    document.getElementById('recapCommentValue').textContent = Number(overview.totalComments || 0).toLocaleString();
    document.getElementById('recapLikeValue').textContent = Number(overview.totalLikes || 0).toLocaleString();
    document.getElementById('recapDurationValue').textContent = formatDuration(Number(overview.duration || 0));
    document.getElementById('recapParticipantValue').textContent = Number(overview.participantCount || 0).toLocaleString();
    document.getElementById('recapPayingValue').textContent = Number(overview.payingUsers || 0).toLocaleString();
    const participantHint = document.getElementById('recapParticipantHint');
    if (participantHint) {
        const chattingUsers = Number(overview.chattingUsers || 0);
        participantHint.textContent = chattingUsers > 0
            ? `其中发言客户 ${chattingUsers.toLocaleString()} · 发言/点赞/送礼/进房去重`
            : '发言/点赞/送礼/进房去重';
    }
    const topSharePercent = Math.round(Number(overview.topGiftShare || 0) * 100);
    document.getElementById('recapTopShareValue').textContent = `${topSharePercent}%`;
    document.getElementById('recapTopShareBar').value = topSharePercent;
    renderRecapTags(displayTags);
    renderRecapScoreBreakdown(displayScore, overview);

    const summaryEl = document.getElementById('sessionAiSummary');
    if (summaryEl) {
        if (hasAiReview) {
            summaryEl.textContent = activeReview.bossSummary || activeReview.summary || '暂无摘要';
        } else if (recap?.aiReviewError) {
            summaryEl.textContent = `未生成AI直播复盘：${recap.aiReviewError}`;
        } else {
            summaryEl.textContent = '当前展示的是规则复盘结果；生成 AI直播复盘后，这里会显示老板能直接看的结论摘要。';
        }
    }

    const isLive = overview.sessionMode === 'live';
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
    const regenerateLabel = isAdmin ? '重新生成AI直播复盘（管理员免扣点）' : `重新生成AI直播复盘（${Number(recap.pointCost || DEFAULT_SESSION_RECAP_POINTS)}AI点）`;

    if (isLive) {
        setSessionRecapStatus('实时场次', 'badge badge-outline');
        setSessionRecapButtonState({ label: '实时场次暂不支持生成', disabled: true, tone: 'ghost' });
    } else if (hasAiReview) {
        setSessionRecapStatus('已生成AI直播复盘', 'badge badge-success');
        setSessionRecapButtonState({ label: regenerateLabel, disabled: false, tone: 'primary' });
    } else if (recap?.aiReviewError) {
        setSessionRecapStatus('生成失败', 'badge badge-warning');
        setSessionRecapButtonState({ label: isAdmin ? '重新生成AI直播复盘（管理员免扣点）' : `重新生成AI直播复盘（${Number(recap.pointCost || DEFAULT_SESSION_RECAP_POINTS)}AI点）`, disabled: false, tone: 'primary' });
    } else {
        setSessionRecapStatus('待生成复盘', 'badge badge-outline');
        setSessionRecapButtonState({ label: isAdmin ? '生成AI直播复盘（管理员免扣点）' : `生成AI直播复盘（${Number(recap.pointCost || DEFAULT_SESSION_RECAP_POINTS)}AI点）`, disabled: false, tone: 'primary' });
    }

    setSessionRecapExportState({ visible: true, disabled: false });

    const meta = document.getElementById('sessionAiMeta');
    if (meta) {
        if (isLive) meta.textContent = '实时场次先持续采集数据，建议归档后再生成 AI直播复盘。';
        else if (hasAiReview && recap.aiReview?.generatedAt) meta.textContent = `最近生成：${formatBeijingDateTime(recap.aiReview.generatedAt)} · 扣点 ${Number(recap.aiReview.creditsUsed || 0)} AI点`;
        else if (recap?.aiReviewError) meta.textContent = `本次未生成AI直播复盘：${recap.aiReviewError}`;
        else meta.textContent = `生成后将按单场消耗 ${Number(recap.pointCost || DEFAULT_SESSION_RECAP_POINTS)} AI点；下次进入直接显示。`;
    }

    renderSessionRecapTrendChart(
        Array.isArray(recap.timeline) ? recap.timeline : [],
        overview.trafficMetricLabel || '在线波动'
    );
    renderSessionRecapRadarChart(Array.isArray(recap.radar) ? recap.radar : []);
    renderRecapKeyMoments(Array.isArray(recap.keyMoments) ? recap.keyMoments : []);
    renderRecapList('recapHighlights', displayHighlights, '当前还没有可展示的本场两点。');
    renderRecapList('recapIssues', displayIssues, '当前还没有明显问题。');
    renderRecapList('recapActions', displayActions, '当前还没有明确动作建议。');
    renderRecapValuableComments(displayValuableComments, '当前还没有筛出明确的高价值弹幕。');
    renderRecapCustomerSegment('recapCoreCustomers', displayCustomers.core || recap?.valueCustomers?.core || [], '本场还没有形成核心价值客户。', 'core');
    renderRecapCustomerSegment('recapPotentialCustomers', displayCustomers.potential || recap?.valueCustomers?.potential || [], '本场暂未识别出明显的潜力转化客户。', 'potential');
    renderRecapCustomerSegment('recapRiskCustomers', displayCustomers.risk || recap?.valueCustomers?.risk || [], '本场暂未识别出明显的流失风险客户。', 'risk');
}

async function renderSessionRecap(roomId, sessionId = currentSessionId) {
    if (!roomId) return;
    showSessionRecapLoadingState('AI直播复盘加载中...');

    const requestRoomId = roomId;
    const requestSessionId = sessionId || 'live';

    if (requestSessionId === 'live') {
        restoreSessionRecapStage({
            sessionId: 'live',
            pointCost: DEFAULT_SESSION_RECAP_POINTS,
            overview: { sessionMode: 'live' }
        });
        return;
    }

    try {
        const fetcher = (typeof Auth !== 'undefined' && typeof Auth.apiFetch === 'function')
            ? Auth.apiFetch.bind(Auth)
            : window.fetch.bind(window);
        const res = await fetcher(`/api/rooms/${roomId}/session-recap?sessionId=${encodeURIComponent(requestSessionId)}`);
        const data = await res.json().catch(() => ({}));
        if (currentDetailRoomId !== requestRoomId || currentSessionId !== requestSessionId) return;
        if (!res.ok) {
            if (res.status === 403 && data.code === 'LIVE_RECAP_NOT_ALLOWED') {
                currentSessionRecap = {
                    sessionId: requestSessionId,
                    pointCost: DEFAULT_SESSION_RECAP_POINTS,
                    overview: { sessionMode: 'archived' },
                    featureLocked: true,
                    lockedMessage: '当前会员计划不包含此项权益'
                };
                showSessionRecapLocked('当前会员计划不包含此项权益');
                return;
            }
            throw new Error(data.error || 'AI直播复盘加载失败');
        }
        if (data?.aiJob?.status === 'failed' && !data?.aiReview) {
            data.aiReviewError = data.aiJob.errorMessage || data.aiReviewError || '生成失败，请稍后重试';
        }
        currentSessionRecap = data;
        if (isSessionAiJobPending(data?.aiJob)) startSessionAiJobPolling(data.aiJob, requestRoomId, requestSessionId);
        else clearSessionAiJobPolling();
        restoreSessionRecapStage(data);
    } catch (err) {
        console.error('Failed to load session recap', err);
        resetSessionRecapState(err?.message || 'AI直播复盘加载失败，请稍后重试。');
    }
}

async function renderRoomTimeChart(roomId) {
    return renderSessionRecap(roomId, currentSessionId);
}

async function generateSessionAiReview(force = false) {
    if (!currentDetailRoomId || !currentSessionId) return;

    if (currentSessionRecap?.featureLocked) {
        alert('当前会员计划不包含此项权益');
        showSessionRecapLocked('当前会员计划不包含此项权益');
        return;
    }

    if (currentSessionId === 'live') {
        alert('请先切到已归档场次，再生成 AI直播复盘');
        return;
    }

    if (!currentSessionRecap || currentSessionRecap.sessionId !== currentSessionId) {
        await renderSessionRecap(currentDetailRoomId, currentSessionId);
        if (!currentSessionRecap || currentSessionRecap.featureLocked) {
            if (currentSessionRecap?.featureLocked) alert('当前会员计划不包含此项权益');
            return;
        }
        if (currentSessionId === 'live') return;
    }

    const requestRoomId = currentDetailRoomId;
    const requestSessionId = currentSessionId;
    const pointCost = Number(currentSessionRecap?.pointCost || DEFAULT_SESSION_RECAP_POINTS);
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
    const isRegenerate = Boolean(currentSessionRecap?.aiReview);
    if (!isAdmin) {
        const confirmed = confirmSessionRecapConsumption(pointCost, { force: isRegenerate });
        if (!confirmed) return;
    } else if (isRegenerate && !confirm('当前场次已经生成过 AI直播复盘，是否重新生成？')) {
        return;
    }
    if (!force && isRegenerate) {
        force = true;
    }

    let previousRecap = null;
    try {
        previousRecap = currentSessionRecap ? JSON.parse(JSON.stringify(currentSessionRecap)) : null;
    } catch (err) {
        previousRecap = currentSessionRecap;
    }

    showSessionRecapGenerating(5000);

    try {
        const res = await Auth.apiFetch(`/api/rooms/${requestRoomId}/session-recap/ai`, {
            method: 'POST',
            body: JSON.stringify({ sessionId: requestSessionId, force, confirmConsumption: !isAdmin })
        });
        const data = await res.json().catch(() => ({}));

        if (currentDetailRoomId !== requestRoomId || currentSessionId !== requestSessionId) {
            return;
        }

        if (!res.ok) {
            if (data.code === 'LIVE_RECAP_NOT_ALLOWED') {
                currentSessionRecap = {
                    ...(previousRecap || {}),
                    featureLocked: true,
                    lockedMessage: '当前会员计划不包含此项权益'
                };
                showSessionRecapLocked('当前会员计划不包含此项权益');
                alert('当前会员计划不包含此项权益');
                return;
            }
            restoreSessionRecapStage(previousRecap);
            if (data.code === 'AI_CREDITS_EXHAUSTED') {
                alert(data.error || 'AI 点数不足');
                return;
            }
            if (data.code === 'AI_CONSUMPTION_CONFIRM_REQUIRED') {
                alert(data.error || '该操作需要先确认扣点');
                return;
            }
            throw new Error(data.error || '提交 AI 直播复盘失败');
        }

        if (data?.cached && data?.review) {
            clearSessionAiJobPolling();
            currentSessionRecap = {
                ...(previousRecap || currentSessionRecap || {}),
                aiReview: data.review,
                aiReviewError: null,
                aiJob: null
            };
            applySessionRecapData(currentSessionRecap);
            addSystemMessage('已读取缓存的 AI 直播复盘');
            return;
        }

        if (data?.accepted && data?.job) {
            currentSessionRecap = {
                ...(previousRecap || currentSessionRecap || {}),
                sessionId: requestSessionId,
                pointCost,
                aiReviewError: null,
                aiJob: data.job
            };
            restoreSessionRecapStage(currentSessionRecap);
            startSessionAiJobPolling(data.job, requestRoomId, requestSessionId);
            addSystemMessage(data.message || 'AI 已启动，正在后台工作中，无需一直在此等待。');
            return;
        }

        if (!currentSessionRecap || currentSessionRecap.sessionId !== requestSessionId) {
            await renderSessionRecap(requestRoomId, requestSessionId);
            return;
        }

        currentSessionRecap.aiReview = data.review || null;
        currentSessionRecap.aiReviewError = null;
        currentSessionRecap.aiJob = null;
        applySessionRecapData(currentSessionRecap);
        addSystemMessage(`AI直播复盘生成完成${data.chargedPoints ? `，已扣 ${data.chargedPoints} 点` : ''}`);
    } catch (err) {
        console.error('generateSessionAiReview error', err);
        if (currentDetailRoomId === requestRoomId && currentSessionId === requestSessionId) {
            restoreSessionRecapStage(previousRecap);
        }
        alert(err.message || '生成失败');
    }
}

// All-Time Leaderboards Functions
async function loadAlltimeLeaderboards(roomId, requestId = currentRoomLoadRequestId) {
    const safeRoomId = String(roomId || '').trim();
    if (!safeRoomId || !isActiveRoomLoad(safeRoomId, requestId)) return;
    try {
        const data = await $.get(`/api/rooms/${safeRoomId}/alltime-leaderboards`);
        if (!isActiveRoomLoad(safeRoomId, requestId)) return;
        renderAlltimeTable('#alltimeGiftersTable tbody', data.gifters, '💎', 'value', safeRoomId);
        renderAlltimeTable('#alltimeChattersTable tbody', data.chatters, '💬', 'count', safeRoomId);
        renderAlltimeTable('#alltimeLikersTable tbody', data.likers, '❤️', 'count', safeRoomId);
    } catch (err) {
        if (!isActiveRoomLoad(safeRoomId, requestId)) return;
        console.error('Failed to load all-time leaderboards:', err);
        renderAlltimeStatusTable('历史排行榜加载失败，请稍后重试', 'error');
    }
}

function escapeInlineJsString(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
}

function normalizeRoomCustomerAnalysisStringArray(value, limit = 8) {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, limit);
}

function dedupeRoomCustomerAnalysisArray(items, limit = 6) {
    const result = [];
    const seen = new Set();
    (Array.isArray(items) ? items : []).forEach(item => {
        const normalized = String(item || '').trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
    });
    return result.slice(0, limit);
}

function localizeRoomCustomerAnalysisText(value) {
    let output = String(value || '').trim();
    if (!output) return '';

    const replacements = [
        ['platform_lrfm', '平台LRFM'],
        ['room_lrfm', '本房LRFM'],
        ['clv_current_room_30d', '近30天本房客户价值'],
        ['abc_current_room', '本房ABC分层'],
        ['currentRoomValueShare30d', '近30天该客户总贡献里投向本房的占比'],
        ['otherRoomsValueShare30d', '近30天该客户总贡献里投向其他房间的占比'],
        ['giftTrend7dVsPrev7d', '近7天礼物趋势（较前7天）'],
        ['watchTrend7dVsPrev7d', '近7天观看趋势（较前7天）'],
        ['danmuTrend7dVsPrev7d', '近7天弹幕趋势（较前7天）'],
        ['platformGiftTopPercent30d', '平台近30天送礼排名'],
        ['platformGiftTopPercentLabel30d', '平台近30天送礼排名'],
        ['currentRoomGiftTopPercent30d', '本房近30天送礼排名'],
        ['currentRoomGiftTopPercentLabel30d', '本房近30天送礼排名'],
        ['otherRoomGrowthFlag', '其他房间增长信号'],
        ['currentRoomInactiveDays', '本房未活跃天数'],
        ['platformInactiveDays', '平台未活跃天数'],
        ['onlyWatchNoGiftFlag', '只看未送信号'],
        ['onlyGiftNoChatFlag', '只送不聊信号'],
        ['gift_value', '送礼值'],
        ['danmu_count', '弹幕条数']
    ];

    replacements.forEach(([source, target]) => {
        output = output.split(source).join(target);
    });

    output = output
        .replace(/=\s*true\b/gi, '=是')
        .replace(/=\s*false\b/gi, '=否')
        .replace(/:\s*true\b/gi, '：是')
        .replace(/:\s*false\b/gi, '：否')
        .replace(/\btrue\b/gi, '是')
        .replace(/\bfalse\b/gi, '否')
        .replace(/排名\s*([0-9][0-9,]*)\s*\/\s*([0-9][0-9,]*)/g, (_match, rankText, totalText) => {
            const rank = Number(String(rankText || '').replace(/,/g, ''));
            const total = Number(String(totalText || '').replace(/,/g, ''));
            if (!rank || !total) return _match;
            return `位于前${Math.max(1, Math.min(100, Math.ceil((rank / total) * 100)))}%`;
        });

    const replaceLabelNumber = (label, formatter) => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        output = output.replace(new RegExp(`${escaped}\\s*[=:：]\\s*(-?[0-9][0-9,.]*)`, 'g'), (_match, rawValue) => {
            const numeric = Number(String(rawValue || '').replace(/,/g, ''));
            if (!Number.isFinite(numeric)) return _match;
            return formatter(numeric);
        });
    };

    const formatPercent = numeric => `${String((numeric * 100).toFixed(2)).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')}%`;
    const formatTopPercent = numeric => `前${String(numeric.toFixed(1)).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')}%`;

    replaceLabelNumber('近30天本房贡献占比', numeric => `近30天该客户总贡献里投向本房的占比约${formatPercent(numeric)}`);
    replaceLabelNumber('近30天该客户总贡献里投向本房的占比', numeric => `近30天该客户总贡献里投向本房的占比约${formatPercent(numeric)}`);
    replaceLabelNumber('近30天其他房间贡献占比', numeric => `近30天该客户总贡献里投向其他房间的占比约${formatPercent(numeric)}`);
    replaceLabelNumber('近30天该客户总贡献里投向其他房间的占比', numeric => `近30天该客户总贡献里投向其他房间的占比约${formatPercent(numeric)}`);
    replaceLabelNumber('近7天礼物趋势（较前7天）', numeric => Math.abs(numeric) < 0.005 ? '近7天礼物趋势（较前7天）基本持平' : `近7天礼物趋势（较前7天）${numeric > 0 ? '增长约' : '下降约'}${formatPercent(Math.abs(numeric))}`);
    replaceLabelNumber('近7天观看趋势（较前7天）', numeric => Math.abs(numeric) < 0.005 ? '近7天观看趋势（较前7天）基本持平' : `近7天观看趋势（较前7天）${numeric > 0 ? '增长约' : '下降约'}${formatPercent(Math.abs(numeric))}`);
    replaceLabelNumber('近7天弹幕趋势（较前7天）', numeric => Math.abs(numeric) < 0.005 ? '近7天弹幕趋势（较前7天）基本持平' : `近7天弹幕趋势（较前7天）${numeric > 0 ? '增长约' : '下降约'}${formatPercent(Math.abs(numeric))}`);
    replaceLabelNumber('平台近30天送礼排名', numeric => `平台近30天送礼排名位于${formatTopPercent(numeric)}`);
    replaceLabelNumber('本房近30天送礼排名', numeric => `本房近30天送礼排名位于${formatTopPercent(numeric)}`);

    return output.trim();
}

function classifyRoomCustomerAnalysisEvidence(items) {
    const buckets = {
        modelEvidence: [],
        contributionEvidence: [],
        riskEvidence: [],
        interactionEvidence: [],
        evidence: []
    };
    const rules = [
        { key: 'modelEvidence', keywords: ['LRFM', 'ABC', '分层', '评分', '核心价值', '高价值', '潜力'] },
        { key: 'contributionEvidence', keywords: ['贡献占比', '送礼排名', '送礼值', '平台近30天', '本房近30天', '前'] },
        { key: 'riskEvidence', keywords: ['分流', '增长信号', '趋势', '未活跃', '流失', '其他房间', '召回'] },
        { key: 'interactionEvidence', keywords: ['弹幕', '语料', '互动', '聊天', '观看', '只看未送', '只送不聊'] }
    ];

    normalizeRoomCustomerAnalysisStringArray(items, 8)
        .map(localizeRoomCustomerAnalysisText)
        .forEach(item => {
            const matched = rules.find(rule => rule.keywords.some(keyword => item.includes(keyword)));
            if (matched) buckets[matched.key].push(item);
            else buckets.evidence.push(item);
        });

    return {
        modelEvidence: dedupeRoomCustomerAnalysisArray(buckets.modelEvidence, 4),
        contributionEvidence: dedupeRoomCustomerAnalysisArray(buckets.contributionEvidence, 4),
        riskEvidence: dedupeRoomCustomerAnalysisArray(buckets.riskEvidence, 4),
        interactionEvidence: dedupeRoomCustomerAnalysisArray(buckets.interactionEvidence, 4),
        evidence: dedupeRoomCustomerAnalysisArray(buckets.evidence, 4)
    };
}

function normalizeRoomCustomerAnalysisPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;

    const fallbackBuckets = classifyRoomCustomerAnalysisEvidence(payload.evidence || []);
    return {
        summary: localizeRoomCustomerAnalysisText(payload.summary || ''),
        valueLevelCurrentRoom: localizeRoomCustomerAnalysisText(payload.valueLevelCurrentRoom || ''),
        valueLevelGlobal: localizeRoomCustomerAnalysisText(payload.valueLevelGlobal || ''),
        loyaltyAssessment: localizeRoomCustomerAnalysisText(payload.loyaltyAssessment || ''),
        diversionRiskAssessment: localizeRoomCustomerAnalysisText(payload.diversionRiskAssessment || ''),
        conversionStage: localizeRoomCustomerAnalysisText(payload.conversionStage || ''),
        keySignals: normalizeRoomCustomerAnalysisStringArray(payload.keySignals, 6).map(localizeRoomCustomerAnalysisText),
        recommendedActions: normalizeRoomCustomerAnalysisStringArray(payload.recommendedActions, 6).map(localizeRoomCustomerAnalysisText),
        outreachScript: normalizeRoomCustomerAnalysisStringArray(payload.outreachScript, 4).map(localizeRoomCustomerAnalysisText),
        forbiddenActions: normalizeRoomCustomerAnalysisStringArray(payload.forbiddenActions, 4).map(localizeRoomCustomerAnalysisText),
        tags: normalizeRoomCustomerAnalysisStringArray(payload.tags, 8).map(localizeRoomCustomerAnalysisText),
        modelEvidence: dedupeRoomCustomerAnalysisArray([
            ...normalizeRoomCustomerAnalysisStringArray(payload.modelEvidence, 4).map(localizeRoomCustomerAnalysisText),
            ...fallbackBuckets.modelEvidence
        ], 4),
        contributionEvidence: dedupeRoomCustomerAnalysisArray([
            ...normalizeRoomCustomerAnalysisStringArray(payload.contributionEvidence, 4).map(localizeRoomCustomerAnalysisText),
            ...fallbackBuckets.contributionEvidence
        ], 4),
        riskEvidence: dedupeRoomCustomerAnalysisArray([
            ...normalizeRoomCustomerAnalysisStringArray(payload.riskEvidence, 4).map(localizeRoomCustomerAnalysisText),
            ...fallbackBuckets.riskEvidence
        ], 4),
        interactionEvidence: dedupeRoomCustomerAnalysisArray([
            ...normalizeRoomCustomerAnalysisStringArray(payload.interactionEvidence, 4).map(localizeRoomCustomerAnalysisText),
            ...fallbackBuckets.interactionEvidence
        ], 4),
        evidence: dedupeRoomCustomerAnalysisArray([
            ...normalizeRoomCustomerAnalysisStringArray(payload.generalEvidence, 4).map(localizeRoomCustomerAnalysisText),
            ...fallbackBuckets.evidence
        ], 4)
    };
}

function renderRoomCustomerAnalysisMetric(label, value, tone = 'base') {
    if (!value) return '';
    const toneClassMap = {
        base: 'border-base-300 bg-base-100/90',
        primary: 'border-primary/20 bg-primary/6',
        success: 'border-success/20 bg-success/6',
        warning: 'border-warning/20 bg-warning/8',
        error: 'border-error/20 bg-error/6'
    };
    const cardClass = toneClassMap[tone] || toneClassMap.base;
    return `
        <div class="rounded-box border ${cardClass} px-3 py-3">
            <div class="text-[11px] font-medium tracking-wide text-base-content/50">${escapeRecapHtml(label)}</div>
            <div class="mt-1 text-sm font-semibold leading-6 text-base-content/88">${escapeRecapHtml(value)}</div>
        </div>
    `;
}

function renderRoomCustomerAnalysisListCard(title, items, tone = 'base', subtitle = '') {
    if (!items || !items.length) return '';
    const toneClassMap = {
        base: 'border-base-300 bg-base-100/90',
        primary: 'border-primary/20 bg-primary/6',
        success: 'border-success/20 bg-success/6',
        warning: 'border-warning/20 bg-warning/8',
        error: 'border-error/20 bg-error/6'
    };
    const cardClass = toneClassMap[tone] || toneClassMap.base;
    return `
        <div class="rounded-box border ${cardClass} p-4">
            <div class="flex items-start justify-between gap-3 mb-2">
                <div>
                    <div class="text-sm font-semibold text-base-content/78">${escapeRecapHtml(title)}</div>
                    ${subtitle ? `<div class="text-[11px] leading-5 text-base-content/48 mt-1">${escapeRecapHtml(subtitle)}</div>` : ''}
                </div>
            </div>
            <div class="space-y-2">
                ${items.map(item => `<div class="rounded-box bg-base-100/80 px-3 py-2 text-sm leading-6 text-base-content/82">${escapeRecapHtml(item)}</div>`).join('')}
            </div>
        </div>
    `;
}

function renderRoomCustomerAnalysisResult(resultText, analysisPayload = null) {
    const wrap = document.getElementById('roomCustomerAnalysisResult');
    if (!wrap) return;

    const analysis = normalizeRoomCustomerAnalysisPayload(analysisPayload);
    if (!analysis) {
        wrap.innerHTML = `<div class="whitespace-pre-wrap leading-6 text-base-content/80">${escapeRecapHtml(localizeRoomCustomerAnalysisText(resultText || '点击开始客户价值深度挖掘...'))}</div>`;
        return;
    }

    const overviewItems = [
        renderRoomCustomerAnalysisMetric('本房价值定位', analysis.valueLevelCurrentRoom, 'primary'),
        renderRoomCustomerAnalysisMetric('平台价值定位', analysis.valueLevelGlobal, 'success'),
        renderRoomCustomerAnalysisMetric('忠诚稳定性', analysis.loyaltyAssessment, 'base'),
        renderRoomCustomerAnalysisMetric('跨房分流风险', analysis.diversionRiskAssessment, 'warning'),
        renderRoomCustomerAnalysisMetric('转化阶段', analysis.conversionStage, 'error')
    ].filter(Boolean).join('');

    wrap.innerHTML = `
        <div class="space-y-4">
            ${analysis.summary ? `
                <div class="rounded-box border border-primary/20 bg-gradient-to-br from-primary/10 via-base-100 to-base-100 p-4">
                    <div class="text-[11px] font-semibold tracking-wide text-base-content/55 mb-2">直接结论</div>
                    <div class="text-sm leading-7 text-base-content/88">${escapeRecapHtml(analysis.summary)}</div>
                </div>
            ` : ''}
            ${overviewItems ? `<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">${overviewItems}</div>` : ''}
            ${analysis.tags.length ? `
                <div class="rounded-box border border-base-300 bg-base-100/90 px-4 py-3">
                    <div class="text-[11px] font-semibold text-base-content/55 mb-2">客户标签</div>
                    <div class="flex flex-wrap gap-2">
                        ${analysis.tags.map(tag => `<span class="badge badge-outline badge-sm">${escapeRecapHtml(tag)}</span>`).join('')}
                    </div>
                </div>
            ` : ''}
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
                ${renderRoomCustomerAnalysisListCard('重点结论', analysis.keySignals, 'primary', '只保留当前最值得主播和运营关注的判断')}
                ${renderRoomCustomerAnalysisListCard('下一步动作', analysis.recommendedActions, 'success', '直接告诉你现在该怎么接、怎么跟、怎么转化')}
            </div>
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
                ${renderRoomCustomerAnalysisListCard('主播承接话术', analysis.outreachScript, 'warning', '主播或场控可直接使用的短句')}
                ${renderRoomCustomerAnalysisListCard('注意事项', analysis.forbiddenActions, 'error', '避免误伤关系或过度施压')}
            </div>
        </div>
    `;
}

function setRoomCustomerAnalysisButtonsPending(pending, isProcessing = false) {
    const { runButtons } = getRoomCustomerAnalysisActionElements();
    const rerunBtn = document.getElementById('rerunRoomCustomerAnalysisBtn');
    const hasAnalysisResult = Boolean(currentRoomCustomerAnalysisState?.hasAnalysisResult);
    const idleLabel = hasAnalysisResult ? '重新挖掘' : '开始挖掘';

    runButtons.forEach(runBtn => {
        runBtn.disabled = Boolean(pending);
        runBtn.classList.toggle('loading', Boolean(pending) && Boolean(isProcessing));
        runBtn.innerHTML = pending
            ? (isProcessing ? '后台挖掘中...' : '处理中...')
            : `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>${idleLabel}`;
    });
    if (rerunBtn) {
        rerunBtn.disabled = true;
        rerunBtn.classList.add('hidden');
    }
}

function clearRoomCustomerAnalysisJobPolling() {
    if (roomCustomerAnalysisJobPollTimer) {
        window.clearInterval(roomCustomerAnalysisJobPollTimer);
        roomCustomerAnalysisJobPollTimer = null;
    }
    currentRoomCustomerAnalysisJobId = 0;
}

function showRoomCustomerAnalysisPending(job) {
    const isProcessing = String(job?.status || '').toLowerCase() === 'processing';
    const progress = Math.max(5, Math.min(99, Number(job?.progressPercent || (isProcessing ? 35 : 10))));
    const currentStep = job?.currentStep || (isProcessing ? '正在后台处理中' : '等待后台调度');
    const wrap = document.getElementById('roomCustomerAnalysisResult');
    if (!wrap) return;
    setRoomCustomerAnalysisExportState({ visible: false });
    wrap.innerHTML = `
        <div class="rounded-box border border-base-300 bg-base-100/95 p-4 space-y-3">
            <div class="flex items-center justify-between gap-3">
                <div class="text-[10px] uppercase tracking-wide text-base-content/45">深挖任务状态</div>
                <span class="badge ${isProcessing ? 'badge-primary' : 'badge-warning'} badge-outline badge-sm">${escapeRecapHtml(isProcessing ? '处理中' : '排队中')}</span>
            </div>
            <div class="rounded-box bg-base-200/80 px-4 py-3">
                <div class="flex items-center justify-between gap-3 text-sm text-base-content/80">
                    <span>${escapeRecapHtml(currentStep)}</span>
                    <span class="font-semibold">${progress}%</span>
                </div>
                <progress class="progress progress-primary w-full mt-3" value="${progress}" max="100"></progress>
            </div>
            <div class="text-sm leading-6 text-base-content/70">已切换为后台深度挖掘，完成后会通过消息通知提醒。</div>
        </div>
    `;
    const statusEl = document.getElementById('roomCustomerAnalysisCacheStatus');
    if (statusEl) statusEl.textContent = isProcessing ? '(后台处理中)' : '(后台排队中)';
    const metaEl = document.getElementById('roomCustomerAnalysisMeta');
    if (metaEl) {
        metaEl.style.display = '';
        metaEl.textContent = `${isProcessing ? '后台处理中' : '后台排队中'} | ${currentStep}`;
    }
    setRoomCustomerAnalysisButtonsPending(true, isProcessing);
}

async function loadRoomCustomerAnalysis(roomId, userId) {
    const safeRoomId = String(roomId || '').trim();
    const safeUserId = String(userId || '').trim();
    if (!safeRoomId || !safeUserId) return;

    const wrap = document.getElementById('roomCustomerAnalysisResult');
    const statusEl = document.getElementById('roomCustomerAnalysisCacheStatus');
    const metaEl = document.getElementById('roomCustomerAnalysisMeta');
    setRoomCustomerAnalysisExportState({ visible: false });
    if (wrap) wrap.innerHTML = '<span class="loading loading-dots loading-sm"></span> 正在加载客户价值深度挖掘结果...';
    if (statusEl) statusEl.textContent = '';
    if (metaEl) {
        metaEl.style.display = 'none';
        metaEl.textContent = '';
    }

    const res = await Auth.apiFetch(`/api/rooms/${encodeURIComponent(safeRoomId)}/customer-analysis/${encodeURIComponent(safeUserId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '获取客户价值深度挖掘结果失败');
    if (currentRoomCustomerAnalysisState.roomId !== safeRoomId || currentRoomCustomerAnalysisState.userId !== safeUserId) return;
    currentRoomCustomerAnalysisState.pointCost = Number(data.pointCost || currentRoomCustomerAnalysisState.pointCost || DEFAULT_ROOM_CUSTOMER_ANALYSIS_POINTS);
    const tipEl = document.getElementById('roomCustomerAnalysisTip');
    if (tipEl) {
        const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
        tipEl.textContent = isAdmin
            ? '管理员发起客户价值深度挖掘不扣点。'
            : `首次深挖默认消耗 ${currentRoomCustomerAnalysisState.pointCost} AI点；命中当前账号 + 当前房间缓存再次查看不重复扣点。`;
    }

    if (data.aiJob && ['queued', 'processing'].includes(String(data.aiJob.status || '').toLowerCase())) {
        showRoomCustomerAnalysisPending(data.aiJob);
        startRoomCustomerAnalysisPolling(data.aiJob.id, safeRoomId, safeUserId);
        return;
    }

    clearRoomCustomerAnalysisJobPolling();
    currentRoomCustomerAnalysisState.hasAnalysisResult = Boolean(data.analyzedAt && (data.analysis || data.result));
    setRoomCustomerAnalysisButtonsPending(false);
    renderRoomCustomerAnalysisResult(data.result || '点击开始客户价值深度挖掘...', data.analysis || null);
    setRoomCustomerAnalysisExportState({ visible: currentRoomCustomerAnalysisState.hasAnalysisResult, disabled: false });

    const sourceMap = { member_cache: '当前账号缓存', api: '实时分析' };
    if (statusEl && data.source) statusEl.textContent = `(${sourceMap[data.source] || data.source})`;

    const metaParts = [];
    if (data.analyzedAt) metaParts.push(`分析于 ${new Date(data.analyzedAt).toLocaleString('zh-CN')}`);
    if (metaParts.length && metaEl) {
        metaEl.style.display = '';
        metaEl.textContent = metaParts.join(' | ');
    }
}

async function pollRoomCustomerAnalysisJobStatus(jobId, roomId, userId) {
    if (!jobId || !roomId || !userId) return;
    if (currentRoomCustomerAnalysisState.roomId !== String(roomId || '').trim() || currentRoomCustomerAnalysisState.userId !== String(userId || '').trim()) {
        clearRoomCustomerAnalysisJobPolling();
        return;
    }

    try {
        const res = await Auth.apiFetch(`/api/user/ai-work/jobs/${encodeURIComponent(jobId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '获取任务状态失败');
        const job = data.job || null;
        if (!job) throw new Error('任务不存在');

        if (['queued', 'processing'].includes(String(job.status || '').toLowerCase())) {
            showRoomCustomerAnalysisPending(job);
            return;
        }

        clearRoomCustomerAnalysisJobPolling();
        if (String(job.status || '').toLowerCase() === 'completed') {
            refreshShellMessageBadgeSoon();
            await loadRoomCustomerAnalysis(roomId, userId);
            addSystemMessage('客户价值深度挖掘已完成，可直接查看结果。');
            return;
        }

        refreshShellMessageBadgeSoon();
        const metaEl = document.getElementById('roomCustomerAnalysisMeta');
        const statusEl = document.getElementById('roomCustomerAnalysisCacheStatus');
        if (statusEl) statusEl.textContent = '(后台失败)';
        if (metaEl) {
            metaEl.style.display = '';
            metaEl.textContent = job.errorMessage || '后台处理失败，请稍后重试';
        }
        setRoomCustomerAnalysisExportState({ visible: false });
        renderRoomCustomerAnalysisResult(`错误: ${job.errorMessage || '后台处理失败，请稍后重试'}`, null);
        setRoomCustomerAnalysisButtonsPending(false);
        addSystemMessage(`客户价值深度挖掘处理失败：${job.errorMessage || '请稍后重试'}`);
    } catch (err) {
        console.error('pollRoomCustomerAnalysisJobStatus error:', err);
    }
}

function startRoomCustomerAnalysisPolling(jobId, roomId, userId) {
    if (!jobId || !roomId || !userId) return;
    if (currentRoomCustomerAnalysisJobId === Number(jobId) && roomCustomerAnalysisJobPollTimer) return;
    clearRoomCustomerAnalysisJobPolling();
    currentRoomCustomerAnalysisJobId = Number(jobId || 0);
    roomCustomerAnalysisJobPollTimer = window.setInterval(() => {
        pollRoomCustomerAnalysisJobStatus(jobId, roomId, userId).catch(() => { });
    }, 10000);
}

async function openRoomCustomerAnalysisModal(roomId, userId, nickname = '', uniqueId = '') {
    const safeRoomId = String(roomId || currentDetailRoomId || '').trim();
    const safeUserId = String(userId || '').trim();
    if (!safeRoomId || !safeUserId) return;

    currentRoomCustomerAnalysisState = {
        roomId: safeRoomId,
        userId: safeUserId,
        nickname: String(nickname || '').trim(),
        uniqueId: String(uniqueId || '').trim(),
        pointCost: DEFAULT_ROOM_CUSTOMER_ANALYSIS_POINTS,
        hasAnalysisResult: false
    };

    const identityEl = document.getElementById('roomCustomerAnalysisIdentity');
    const tipEl = document.getElementById('roomCustomerAnalysisTip');
    if (identityEl) {
        const nicknameLabel = currentRoomCustomerAnalysisState.nickname || '匿名';
        const uniqueLabel = currentRoomCustomerAnalysisState.uniqueId || currentRoomCustomerAnalysisState.userId;
        identityEl.textContent = `${nicknameLabel} · ${uniqueLabel} · 房间 ${safeRoomId}`;
    }
    if (tipEl) {
        const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
        tipEl.textContent = isAdmin
            ? '管理员发起客户价值深度挖掘不扣点。'
            : '首次深挖会消耗 AI点；命中当前账号 + 当前房间缓存再次查看不重复扣点。';
    }

    document.getElementById('roomCustomerAnalysisModal')?.showModal();
    setRoomCustomerAnalysisExportState({ visible: false });
    setRoomCustomerAnalysisButtonsPending(false);
    await loadRoomCustomerAnalysis(safeRoomId, safeUserId);
}

function closeRoomCustomerAnalysisModal() {
    clearRoomCustomerAnalysisJobPolling();
    setRoomCustomerAnalysisExportState({ visible: false });
    currentRoomCustomerAnalysisState = { roomId: '', userId: '', nickname: '', uniqueId: '', hasAnalysisResult: false };
    const modal = document.getElementById('roomCustomerAnalysisModal');
    if (modal?.open) modal.close();
}

async function runRoomCustomerAnalysis(force = null) {
    const roomId = String(currentRoomCustomerAnalysisState.roomId || '').trim();
    const userId = String(currentRoomCustomerAnalysisState.userId || '').trim();
    if (!roomId || !userId) return;

    const resolvedForce = typeof force === 'boolean' ? force : Boolean(currentRoomCustomerAnalysisState.hasAnalysisResult);
    const pointCost = Number(currentRoomCustomerAnalysisState.pointCost || DEFAULT_ROOM_CUSTOMER_ANALYSIS_POINTS);
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
    if (!isAdmin) {
        const confirmed = confirmRoomCustomerAnalysisConsumption(pointCost, { force: resolvedForce });
        if (!confirmed) return;
    }

    const statusEl = document.getElementById('roomCustomerAnalysisCacheStatus');
    const metaEl = document.getElementById('roomCustomerAnalysisMeta');
    if (statusEl) statusEl.textContent = '';
    if (metaEl) {
        metaEl.style.display = 'none';
        metaEl.textContent = '';
    }
    setRoomCustomerAnalysisExportState({ visible: false });
    renderRoomCustomerAnalysisResult('正在提交客户价值深度挖掘任务...', null);
    setRoomCustomerAnalysisButtonsPending(true, false);

    try {
        const res = await Auth.apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/customer-analysis`, {
            method: 'POST',
            body: JSON.stringify({ userId, force: resolvedForce, confirmConsumption: !isAdmin })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const error = new Error(data.error || '提交客户价值深度挖掘失败');
            error.code = data.code || '';
            throw error;
        }

        if (data.accepted && data.job) {
            showRoomCustomerAnalysisPending(data.job);
            startRoomCustomerAnalysisPolling(data.job.id, roomId, userId);
            return;
        }

        clearRoomCustomerAnalysisJobPolling();
        if (data.skipped) {
            currentRoomCustomerAnalysisState.hasAnalysisResult = false;
            renderRoomCustomerAnalysisResult(data.result, null);
            setRoomCustomerAnalysisExportState({ visible: false });
            setRoomCustomerAnalysisButtonsPending(false);
            return;
        }

        currentRoomCustomerAnalysisState.hasAnalysisResult = Boolean(data.analysis || data.result);
        renderRoomCustomerAnalysisResult(data.result, data.analysis || null);
        setRoomCustomerAnalysisExportState({ visible: currentRoomCustomerAnalysisState.hasAnalysisResult, disabled: false });
        const sourceMap = { member_cache: '当前账号缓存', api: '实时分析' };
        if (statusEl) statusEl.textContent = `(${sourceMap[data.source] || (data.cached ? '缓存' : '实时分析')})`;
        const metaParts = [];
        if (data.analyzedAt) metaParts.push(`分析于 ${new Date(data.analyzedAt).toLocaleString('zh-CN')}`);
        if (metaParts.length && metaEl) {
            metaEl.style.display = '';
            metaEl.textContent = metaParts.join(' | ');
        }
        setRoomCustomerAnalysisButtonsPending(false);
    } catch (err) {
        setRoomCustomerAnalysisExportState({ visible: false });
        renderRoomCustomerAnalysisResult(['AI_CREDITS_EXHAUSTED', 'AI_CONSUMPTION_CONFIRM_REQUIRED'].includes(err.code)
            ? (err.message || 'AI 点数不足，请购买点数包或升级套餐')
            : `错误: ${err.message || '提交客户价值深度挖掘失败'}`, null);
        setRoomCustomerAnalysisButtonsPending(false);
    }
}

function renderAlltimeTable(selector, data, icon, valueKey, roomId = currentDetailRoomId) {
    const tbody = $(selector);
    tbody.empty();
    if (!data || data.length === 0) {
        tbody.append('<tr><td colspan="2" class="text-center opacity-50 text-xs">暂无数据</td></tr>');
        return;
    }
    data.forEach((row, i) => {
        const val = row[valueKey] || row.value || row.count || 0;
        const rank = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
        const nickname = row.nickname || '匿名';
        const uniqueId = row.uniqueId || '';
        const userId = row.userId || '';
        const nameCell = uniqueId
            ? `<a href="javascript:void(0)" class="link link-hover text-accent" onclick="searchUserExact('${escapeInlineJsString(uniqueId)}')" title="点击精确搜索该用户">${escapeRecapHtml(nickname)}</a>`
            : `${escapeRecapHtml(nickname)}`;
        const aiButton = userId
            ? `<button class="btn btn-ghost btn-xs border border-base-300 hover:border-primary/50" title="客户价值深度挖掘" onclick="openRoomCustomerAnalysisModal('${escapeInlineJsString(roomId)}', '${escapeInlineJsString(userId)}', '${escapeInlineJsString(nickname)}', '${escapeInlineJsString(uniqueId)}')">AI</button>`
            : '';
        tbody.append(`
            <tr>
                <td class="max-w-[180px]">
                    <div class="flex items-center justify-between gap-2">
                        <div class="truncate">${rank} ${nameCell}</div>
                        ${aiButton}
                    </div>
                </td>
                <td class="text-right font-mono">${Number(val || 0).toLocaleString()}</td>
            </tr>
        `);
    });
}

// Search user with exact match - navigate to User Analysis section
// Track source room for "back" functionality
var userAnalysisSourceRoom = null;

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
window.updateDetailRoomIdentity = updateDetailRoomIdentity;

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
window.loadRoom = loadRoom;
window.openRoomCustomerAnalysisModal = openRoomCustomerAnalysisModal;
window.closeRoomCustomerAnalysisModal = closeRoomCustomerAnalysisModal;
window.runRoomCustomerAnalysis = runRoomCustomerAnalysis;
window.switchSection = switchSection;
window.resetSessionRecapState = resetSessionRecapState;
window.renderSessionRecap = renderSessionRecap;
window.generateSessionAiReview = generateSessionAiReview;
