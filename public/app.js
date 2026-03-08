
// app.js - Main Application Logic

var socket = null;
var currentSection = 'roomList';
var currentDetailRoomId = null;
var currentSessionId = 'live'; // 'live' or session UUID
var roomIsLive = false;
var connectedRoomId = null; // Track actually connected room to prevent cross-room event display
var globalLoadingCount = 0;
var sessionRecapTrendChart = null;
var sessionRecapRadarChart = null;
var currentSessionRecap = null;
var sessionAiJobPollTimer = null;
var sessionAiJobPollTarget = null;
var sessionRecapExporting = false;
const DEFAULT_SESSION_RECAP_POINTS = 20;
const SESSION_RECAP_LOADING_TIPS = [
    '正在抽取礼物高峰与掉人节点',
    '正在筛选高价值弹幕与关键反馈',
    '正在识别核心客户、潜力客户与风险客户',
    '正在整理老板能直接转发的 AI直播复盘'
];


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

function getMonitorDeepLinkState() {
    const params = new URLSearchParams(window.location.search || '');
    return {
        roomId: String(params.get('roomId') || '').trim(),
        sessionId: String(params.get('sessionId') || '').trim(),
        detailTab: String(params.get('detailTab') || '').trim()
    };
}

async function handleMonitorDeepLink() {
    const deepLink = getMonitorDeepLinkState();
    if (!deepLink.roomId) return;

    switchSection('roomDetail');
    await loadRoom(deepLink.roomId);

    if (deepLink.sessionId && deepLink.sessionId !== currentSessionId) {
        await changeSession(deepLink.sessionId);
    }

    if (deepLink.detailTab) {
        const tabBtn = document.querySelector(`#section-roomDetail .tab[onclick*="${deepLink.detailTab}"]`);
        switchDetailTab(deepLink.detailTab, tabBtn || document.querySelector('#section-roomDetail .tab'));
    }
}


function setGlobalLoadingVisible(visible, message = '加载中...') {
    const overlay = document.getElementById('globalLoadingOverlay');
    const textEl = document.getElementById('globalLoadingText');
    if (!overlay || !textEl) return;

    textEl.textContent = message;
    overlay.classList.toggle('is-visible', visible);
    overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function showGlobalLoading(message = '加载中...') {
    globalLoadingCount += 1;
    setGlobalLoadingVisible(true, message);
}

function hideGlobalLoading() {
    globalLoadingCount = Math.max(0, globalLoadingCount - 1);
    if (globalLoadingCount === 0) {
        setGlobalLoadingVisible(false);
    }
}

async function withGlobalLoading(message, task) {
    showGlobalLoading(message);
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

async function loadRoom(id) {
    currentDetailRoomId = id;
    $('#detailRoomId').text(id);
    $('#chatContainer').empty();
    resetSessionRecapState('正在加载 AI直播复盘...');

    // Show loading state
    showLoadingState();

    await withGlobalLoading('加载房间详情中...', async () => {
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
                const lastSessionStr = lastSessionTime ? formatBeijingDateTime(lastSessionTime, `场次 ${lastSessionId}`) : `场次 ${lastSessionId}`;
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

            if (isSessionRecapTabActive()) {
                await renderSessionRecap(id, currentSessionId);
            }

        } catch (err) {
            console.error('loadRoom error:', err);
            hideLoadingState();
            addSystemMessage('❌ 加载失败: ' + err.message);
        }
    });
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

async function changeSession(val) {
    currentSessionId = val;
    $('#chatContainer').empty();
    resetSessionRecapState('正在切换 AI直播复盘...');
    showLoadingState();

    const loadingText = val === 'live' ? '切换实时数据中...' : '切换场次数据中...';

    await withGlobalLoading(loadingText, async () => {
        try {
            if (val === 'live') {
                addSystemMessage('切换到实时视图');
                updateRoomStatusUI(roomIsLive);
                if (roomIsLive) {
                    connectToLive(currentDetailRoomId);
                }
                await loadDetailStats(currentDetailRoomId, 'live');
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

function formatBeijingDateTime(value, fallback = '--') {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
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

function normalizeRecapCustomerIdentity(value) {
    return String(value || '').trim().toLowerCase();
}

function findAiCustomerNarrativeMatch(systemItem, aiItems = [], usedIndexes = new Set(), fallbackIndex = -1) {
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

    if (matchedIndex === -1 && fallbackIndex >= 0 && fallbackIndex < aiItems.length && !usedIndexes.has(fallbackIndex)) {
        matchedIndex = fallbackIndex;
    }

    if (matchedIndex === -1) return null;
    usedIndexes.add(matchedIndex);
    return aiItems[matchedIndex] || null;
}

function mergeSessionRecapCustomerItems(systemItems = [], aiItems = [], segmentType = 'core') {
    if (!Array.isArray(systemItems) || !systemItems.length) return [];

    const usedIndexes = new Set();
    return systemItems.map((item, index) => {
        const aiItem = findAiCustomerNarrativeMatch(item, aiItems, usedIndexes, index) || {};
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
            pixelRatio: Math.min(2, Math.max(1.5, window.devicePixelRatio || 1)),
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
        await withGlobalLoading('正在导出复盘图片...', async () => {
            const canvas = await captureSessionRecapCanvas();
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1));
            downloadBlob(blob, buildSessionRecapExportFileName('png'));
        });
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
        await withGlobalLoading('正在导出复盘 PDF...', async () => {
            const canvas = await captureSessionRecapCanvas();
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
        });
    } catch (err) {
        alert(err?.message || '导出 PDF 失败，请稍后重试');
    } finally {
        setSessionRecapExportState({ visible: hasContent, disabled: false });
    }
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

function showSessionRecapTeaser(recap = {}) {
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
    const pointCost = Number(recap?.pointCost || DEFAULT_SESSION_RECAP_POINTS);
    const overview = recap?.overview || {};
    const isLive = overview.sessionMode === 'live' || currentSessionId === 'live';
    const startTime = overview.startTime ? formatBeijingDateTime(overview.startTime, '') : '';

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
            : [startTime ? `场次时间 ${startTime}` : '单场归档复盘', '老板摘要', '关键时刻', '价值客户'],
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
        <div class="text-xs uppercase tracking-[0.18em] opacity-60">生成中</div>
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

    setSessionRecapEmptyHtml(buildSessionRecapInfoCard({
        badge: 'AI 正在出结论',
        title: '正在为你生成 AI直播复盘，请稍候片刻。',
        description: '系统正在抽取礼物高峰、互动转折、价值客户、高价值弹幕与关键建议。等这轮跑完，会一次性把完整内容铺开。',
        chips: ['老板摘要生成中', '关键时刻提炼中', '价值客户识别中', '通常 5-10 秒'],
        rightPanel,
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
            addSystemMessage('AI直播复盘已完成，可直接查看结果。');
        } else if (data.job?.status === 'failed') {
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
    const pointCost = Number(recap?.pointCost || DEFAULT_SESSION_RECAP_POINTS);
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

    setSessionRecapEmptyHtml(buildSessionRecapInfoCard({
        badge: isProcessing ? 'AI 后台处理中' : 'AI 已加入队列',
        title: isProcessing ? 'AI直播复盘正在后台生成。' : 'AI直播复盘已提交，等待后台开始处理。',
        description: '你不用一直停留在这里。系统会继续在后台跑完整个复盘流程，完成后会通过消息通知提醒，可直接点击通知跳转到该房间的 AI复盘。',
        chips: [
            `任务 #${Number(aiJob.id || 0) || '-'}`,
            `当前步骤 ${currentStep}`,
            `本场价格 ${pointCost}AI点`,
            '完成后主动通知'
        ],
        rightPanel,
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
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return escapeRecapHtml(String(value));
    return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
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
    wrap.innerHTML = items.map(item => `
        <div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                    <div class="font-semibold truncate" title="${escapeRecapHtml(item.nickname || '匿名')}">${escapeRecapHtml(item.nickname || '匿名')}</div>
                    <div class="text-xs opacity-60 mt-1 truncate" title="${escapeRecapHtml(item.uniqueId || '未记录账号')}">${escapeRecapHtml(item.uniqueId || '未记录账号')}</div>
                </div>
                <span class="badge badge-outline shrink-0 whitespace-nowrap self-start">${Number(item.totalGiftValue || item.sessionGiftValue || 0) > 0 ? `💎 ${Number(item.totalGiftValue || item.sessionGiftValue || 0).toLocaleString()}` : '本场未出手'}</span>
            </div>
            <div class="flex flex-wrap gap-2 mt-3 text-xs opacity-70">
                <span class="badge badge-ghost badge-sm">送礼 ${Number(item.giftCount || 0)}</span>
                <span class="badge badge-ghost badge-sm">历史 💎${Number(item.historicalValue || 0).toLocaleString()}</span>
                <span class="badge badge-ghost badge-sm">弹幕 ${Number(item.chatCount || 0)}</span>
                <span class="badge badge-ghost badge-sm">点赞 ${Number(item.likeCount || 0)}</span>
                <span class="badge badge-ghost badge-sm">进房 ${Number(item.enterCount || 0)}</span>
                ${segmentType === 'risk' ? `<span class="badge badge-ghost badge-sm">${escapeRecapHtml(formatRecapTimeText(item.enterTime || item.firstEnterAt))} → ${escapeRecapHtml(formatRecapTimeText(item.leaveTime || item.lastActiveAt))}</span>` : ''}
            </div>
            <div class="text-xs leading-6 mt-3 opacity-80 break-words">${escapeRecapHtml(item.keyBehavior || item.reason || '')}</div>
            <div class="text-xs leading-6 mt-2 text-primary break-words">${escapeRecapHtml(item.maintenanceSuggestion || item.action || item.recoveryStrategy || '')}</div>
            ${segmentType === 'potential' && item.conversionScript ? `<div class="mt-3 rounded-box session-recap-note-box px-3 py-3 text-xs leading-6">转化话术：${escapeRecapHtml(item.conversionScript)}</div>` : ''}
            ${segmentType === 'risk' && item.riskReason ? `<div class="mt-3 rounded-box session-recap-risk-box px-3 py-3 text-xs leading-6">流失原因：${escapeRecapHtml(item.riskReason)}</div>` : ''}
        </div>
    `).join('');
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
    resetSessionRecapState('AI直播复盘加载中...');

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
    if (!force && currentSessionRecap?.aiReview) {
        const confirmText = isAdmin
            ? '当前场次已经生成过 AI直播复盘，是否重新生成？'
            : `当前场次已经生成过 AI直播复盘，重新生成将再消耗 ${pointCost} AI点，是否继续？`;
        if (!confirm(confirmText)) return;
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
            body: JSON.stringify({ sessionId: requestSessionId, force })
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
window.switchSection = switchSection;
window.resetSessionRecapState = resetSessionRecapState;
window.renderSessionRecap = renderSessionRecap;
window.generateSessionAiReview = generateSessionAiReview;
