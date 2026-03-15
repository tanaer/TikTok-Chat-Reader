// State variables for pagination and search
let roomListPage = 1;
let roomListLimit = 20;
let roomListSearch = '';
let roomListSort = 'default';
let roomListTotal = 0;
const ROOM_LIST_VIEW_MODE_KEY = 'roomListViewMode';
const ROOM_LIST_VIEW_MODES = new Set(['card', 'list']);
let roomListViewMode = 'card'; // 'card' or 'list'
let roomListRefreshTimer = null; // Timer for auto-refresh
const ROOM_LIST_REFRESH_INTERVAL = 10000; // 10 seconds for listing is enough
let roomRenameJobPollTimer = null;
let roomRenameJobPanelOpen = false;
let selectedRoomRenameJobId = 0;
let latestRoomRenameJobs = [];
let roomListForceFreshToken = 0;
const roomRenamePendingMap = new Map();
const roomRenameInFlight = new Set();
const roomRenameCompletedJobs = new Set();

function canManageRoomRename() {
    return typeof Auth !== 'undefined'
        && typeof Auth.hasAdminPermission === 'function'
        && Auth.hasAdminPermission('session_maintenance.manage');
}

function loadRoomViewModePreference() {
    if (typeof window === 'undefined') return 'card';

    try {
        const savedMode = window.localStorage.getItem(ROOM_LIST_VIEW_MODE_KEY);
        return ROOM_LIST_VIEW_MODES.has(savedMode) ? savedMode : 'card';
    } catch (error) {
        console.warn('[RoomList] Failed to load view mode preference:', error);
        return 'card';
    }
}

function saveRoomViewModePreference(mode) {
    if (typeof window === 'undefined') return;

    try {
        window.localStorage.setItem(ROOM_LIST_VIEW_MODE_KEY, mode);
    } catch (error) {
        console.warn('[RoomList] Failed to save view mode preference:', error);
    }
}

roomListViewMode = loadRoomViewModePreference();

const MONTHLY_GIFT_TOOLTIP = '自然月累计（从每月1日开始统计）；括号内按26天折算日均';

// Column header tooltips for list view
const COL_TIPS = {
    duration:    '当前场次的开播时长',
    visits:      '本场进入直播间的总人次',
    comments:    '本场弹幕总条数',
    giftNow:     '本场礼物总价值（钻石）',
    giftMonth:   MONTHLY_GIFT_TOOLTIP,
    giftDaily:   '有效日均：仅统计开播超过2小时的日期',
    giftEff:     '赚钱效率 = 礼物总价值 ÷ 进房人次，衡量单个观众的付费贡献',
    interact:    '话题度 = 弹幕数 ÷ 进房人次，衡量观众互动活跃程度',
    quality:     '账号质量 = 进房人次 ÷ 开播分钟数，衡量流量获取能力',
    top1:        'TOP1 用户贡献占总礼物价值的百分比，越高说明越依赖头部用户',
    top3:        'TOP3 用户贡献占比',
    top10:       'TOP10 用户贡献占比',
    top30:       'TOP30 用户贡献占比',
    monitor:     '监控开关：开启后系统会连接该直播间采集数据',
};

/** Render a table header cell with optional tooltip question mark */
function thWithTip(label, tipKey, extraClass) {
    var cls = 'p-2 text-center' + (extraClass ? ' ' + extraClass : '');
    if (!tipKey || !COL_TIPS[tipKey]) {
        return '<th class="' + cls + '">' + label + '</th>';
    }
    return '<th class="' + cls + '">' +
        '<span class="inline-flex items-center gap-0.5 cursor-help tooltip tooltip-bottom" data-tip="' +
        COL_TIPS[tipKey].replace(/"/g, '&quot;') + '">' +
        label + '<span class="opacity-30 text-[10px] font-normal">?</span></span></th>';
}

// Helper to format monthly total with daily average: "260（10）"
// Total = current calendar month; average in parentheses = total / 26 (fixed divisor)
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

function formatBeijingDateTime(value, fallback = '--') {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
}

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

function normalizeRoomIdInput(value) {
    const text = String(value || '').trim();
    return text.startsWith('@') ? text.slice(1) : text;
}

function getRoomRenamePendingKey(roomId) {
    return normalizeRoomIdInput(roomId);
}

function setRoomRenamePending(roomId, pending) {
    const key = getRoomRenamePendingKey(roomId);
    if (!key) return;
    if (pending) {
        roomRenamePendingMap.set(key, true);
    } else {
        roomRenamePendingMap.delete(key);
    }
}

function isRoomRenamePending(roomId) {
    return roomRenamePendingMap.has(getRoomRenamePendingKey(roomId));
}

function escapeHtmlText(str) {
    return str == null ? '' : String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatRoomRenameJobStatus(job) {
    const status = String(job?.status || '').toLowerCase();
    if (status === 'queued') return { label: '排队中', className: 'badge badge-warning badge-sm' };
    if (status === 'processing') return { label: '执行中', className: 'badge badge-info badge-sm' };
    if (status === 'completed') return { label: '已完成', className: 'badge badge-success badge-sm' };
    if (status === 'failed') return { label: '失败', className: 'badge badge-error badge-sm' };
    return { label: status || '未知', className: 'badge badge-ghost badge-sm' };
}

function formatRoomRenameJobTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function summarizeRoomRenameJob(job) {
    if (!job) return '当前暂无任务';
    const status = formatRoomRenameJobStatus(job);
    const payload = job.requestPayload || {};
    const sourceRoomId = payload.oldRoomId || '';
    const targetRoomId = payload.newRoomId || '';
    return `${status.label}：${sourceRoomId || '--'} -> ${targetRoomId || '--'}，${job.currentStep || '等待后台执行'}`;
}

async function fetchRoomRenameJobs() {
    if (!canManageRoomRename()) {
        return { jobs: [], activeCount: 0 };
    }
    const response = await Auth.apiFetch('/api/admin/async-jobs?scope=room-rename&limit=8');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || '获取房间迁移任务失败');
    }
    return {
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        activeCount: Number(data.activeCount || 0)
    };
}

async function fetchRoomRenameJobDetail(jobId) {
    const response = await Auth.apiFetch(`/api/admin/async-jobs/${encodeURIComponent(jobId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || '获取任务详情失败');
    }
    return data.job || null;
}

function renderRoomRenameJobFab(activeCount = 0) {
    const fab = document.getElementById('roomRenameJobFab');
    const countEl = document.getElementById('roomRenameJobFabCount');
    if (!fab || !countEl) return;
    if (!canManageRoomRename()) {
        fab.classList.add('hidden');
        return;
    }

    fab.classList.remove('hidden');
    if (activeCount > 0) {
        countEl.classList.remove('hidden');
        countEl.textContent = String(activeCount);
    } else {
        countEl.classList.add('hidden');
        countEl.textContent = '0';
    }
}

function renderRoomRenameJobList(jobs = []) {
    const listEl = document.getElementById('roomRenameJobPanelList');
    const summaryEl = document.getElementById('roomRenameJobPanelSummary');
    if (!listEl || !summaryEl) return;

    latestRoomRenameJobs = jobs;
    const selectedJob = jobs.find((job) => Number(job.id) === Number(selectedRoomRenameJobId)) || jobs[0] || null;
    if (selectedJob) {
        selectedRoomRenameJobId = Number(selectedJob.id);
    } else {
        selectedRoomRenameJobId = 0;
    }

    summaryEl.textContent = selectedJob ? summarizeRoomRenameJob(selectedJob) : '当前暂无任务';

    if (!jobs.length) {
        listEl.innerHTML = '<div class="room-rename-job-panel__empty">当前暂无房间迁移任务。</div>';
        renderRoomRenameJobDetail(null);
        return;
    }

    listEl.innerHTML = jobs.map((job) => {
        const status = formatRoomRenameJobStatus(job);
        const payload = job.requestPayload || {};
        const title = job.title || `${payload.oldRoomId || '--'} -> ${payload.newRoomId || '--'}`;
        const progress = Math.max(0, Math.min(100, Number(job.progressPercent || 0)));
        const activeClass = Number(job.id) === Number(selectedRoomRenameJobId) ? ' is-active' : '';
        return `
            <button type="button" class="room-rename-job-item${activeClass}" onclick="selectRoomRenameJob(${Number(job.id)})">
                <div class="room-rename-job-item__top">
                    <div class="room-rename-job-item__title">${escapeHtmlText(title)}</div>
                    <span class="${status.className}">${status.label}</span>
                </div>
                <div class="room-rename-job-item__step">${escapeHtmlText(job.currentStep || '等待后台执行')}</div>
                <div class="room-rename-job-progress">
                    <div class="room-rename-job-progress__bar" style="width:${progress}%"></div>
                </div>
                <div class="room-rename-job-item__meta">
                    <span>#${Number(job.id || 0)}</span>
                    <span>${formatRoomRenameJobTime(job.updatedAt || job.createdAt)}</span>
                </div>
            </button>
        `;
    }).join('');

    renderRoomRenameJobDetail(selectedJob);
}

function renderRoomRenameJobDetail(job) {
    const detailEl = document.getElementById('roomRenameJobPanelDetail');
    if (!detailEl) return;
    if (!job) {
        detailEl.innerHTML = '<div class="room-rename-job-panel__detail-empty">选择一条任务后可查看执行进度与结果。</div>';
        return;
    }

    const status = formatRoomRenameJobStatus(job);
    const payload = job.requestPayload || {};
    const result = job.resultPayload || {};
    const progress = Math.max(0, Math.min(100, Number(job.progressPercent || 0)));
    const detailStats = [];

    if (result && typeof result === 'object') {
        if (result.mode) detailStats.push({ label: '模式', value: result.mode === 'merged' ? '合并' : '迁移' });
        if (result.moved?.events != null) detailStats.push({ label: '事件', value: String(result.moved.events) });
        if (result.moved?.sessions != null) detailStats.push({ label: '场次', value: String(result.moved.sessions) });
        if (result.associations?.mergedUsers != null) detailStats.push({ label: '关联用户', value: String(result.associations.mergedUsers) });
    }

    detailEl.innerHTML = `
        <div class="room-rename-job-panel__detail-header">
            <div class="room-rename-job-panel__detail-title">${escapeHtmlText(job.title || '房间迁移任务')}</div>
            <span class="${status.className}">${status.label}</span>
        </div>
        <div class="room-rename-job-panel__detail-meta">
            <span>#${Number(job.id || 0)}</span>
            <span>${escapeHtmlText(payload.oldRoomId || '--')} -> ${escapeHtmlText(payload.newRoomId || '--')}</span>
        </div>
        <div class="room-rename-job-panel__detail-step">${escapeHtmlText(job.currentStep || '等待后台执行')}</div>
        <div class="room-rename-job-progress">
            <div class="room-rename-job-progress__bar" style="width:${progress}%"></div>
        </div>
        ${job.errorMessage ? `<div class="room-rename-job-panel__detail-error">${escapeHtmlText(job.errorMessage)}</div>` : ''}
        ${detailStats.length ? `
            <div class="room-rename-job-panel__detail-result">
                ${detailStats.map((item) => `
                    <div class="room-rename-job-panel__detail-stat">
                        <div class="room-rename-job-panel__detail-stat-label">${escapeHtmlText(item.label)}</div>
                        <div class="room-rename-job-panel__detail-stat-value">${escapeHtmlText(item.value)}</div>
                    </div>
                `).join('')}
            </div>
        ` : ''}
    `;
}

async function refreshRoomRenameJobs(options = {}) {
    if (!canManageRoomRename()) return;
    try {
        const result = await fetchRoomRenameJobs();
        roomRenamePendingMap.clear();
        result.jobs.forEach((job) => {
            const status = String(job.status || '').toLowerCase();
            const sourceRoomId = normalizeRoomIdInput(job.requestPayload?.oldRoomId || '');
            if ((status === 'queued' || status === 'processing') && sourceRoomId) {
                roomRenamePendingMap.set(sourceRoomId, true);
            }
        });
        let shouldRefreshRoomList = false;
        result.jobs.forEach((job) => {
            const jobId = Number(job.id || 0);
            if (!jobId) return;
            if (String(job.status || '').toLowerCase() === 'completed' && !roomRenameCompletedJobs.has(jobId)) {
                roomRenameCompletedJobs.add(jobId);
                shouldRefreshRoomList = true;
            }
        });
        renderRoomRenameJobFab(result.activeCount);
        renderRoomRenameJobList(result.jobs);

        if (options.jobId) {
            selectedRoomRenameJobId = Number(options.jobId);
            const detail = await fetchRoomRenameJobDetail(options.jobId).catch(() => null);
            if (detail) {
                const mergedJobs = result.jobs.some((job) => Number(job.id) === Number(detail.id))
                    ? result.jobs.map((job) => Number(job.id) === Number(detail.id) ? detail : job)
                    : [detail, ...result.jobs];
                renderRoomRenameJobList(mergedJobs.slice(0, 8));
            }
        }

        if (shouldRefreshRoomList) {
            queueFreshRoomListReload();
            renderRoomList();
        }
    } catch (error) {
        console.error('Failed to refresh room rename jobs:', error);
    }
}

function startRoomRenameJobPolling() {
    stopRoomRenameJobPolling();
    if (!canManageRoomRename()) return;
    roomRenameJobPollTimer = setInterval(() => {
        refreshRoomRenameJobs();
    }, 4000);
}

function stopRoomRenameJobPolling() {
    if (roomRenameJobPollTimer) {
        clearInterval(roomRenameJobPollTimer);
        roomRenameJobPollTimer = null;
    }
}

window.toggleRoomRenameJobPanel = function toggleRoomRenameJobPanel(force) {
    const panel = document.getElementById('roomRenameJobPanel');
    if (!panel) return;

    if (typeof force === 'boolean') {
        roomRenameJobPanelOpen = force;
    } else {
        roomRenameJobPanelOpen = !roomRenameJobPanelOpen;
    }

    panel.classList.toggle('hidden', !roomRenameJobPanelOpen);
    panel.setAttribute('aria-hidden', roomRenameJobPanelOpen ? 'false' : 'true');

    if (roomRenameJobPanelOpen) {
        refreshRoomRenameJobs({ jobId: selectedRoomRenameJobId || 0 });
    }
};

window.selectRoomRenameJob = async function selectRoomRenameJob(jobId) {
    selectedRoomRenameJobId = Number(jobId || 0);
    const inMemoryJob = latestRoomRenameJobs.find((job) => Number(job.id) === selectedRoomRenameJobId);
    if (inMemoryJob) {
        renderRoomRenameJobList(latestRoomRenameJobs);
    }
    const detail = await fetchRoomRenameJobDetail(selectedRoomRenameJobId).catch((error) => {
        console.error('Failed to load room rename job detail:', error);
        return null;
    });
    if (!detail) return;
    const mergedJobs = latestRoomRenameJobs.some((job) => Number(job.id) === selectedRoomRenameJobId)
        ? latestRoomRenameJobs.map((job) => Number(job.id) === selectedRoomRenameJobId ? detail : job)
        : [detail, ...latestRoomRenameJobs];
    renderRoomRenameJobList(mergedJobs.slice(0, 8));
};

function roomListShowToast(message, type = 'info') {
    if (typeof window.showToast === 'function') {
        window.showToast(message, type);
        return;
    }

    if (type === 'error') {
        alert(message);
    } else {
        console.log(`[RoomList:${type}] ${message}`);
    }
}

function queueFreshRoomListReload() {
    roomListForceFreshToken = Date.now();
}


function applyRoomSortButtonState() {
    const buttons = Array.from(document.querySelectorAll('.room-sort-btn'));
    if (!buttons.length) return;

    buttons.forEach((button) => {
        button.classList.remove('active', 'btn-primary');
        button.classList.add('btn-ghost');
    });

    const activeButton = buttons.find((button) => {
        const onclick = button.getAttribute('onclick') || '';
        return onclick.includes(`setRoomSort('${roomListSort}'`);
    });

    if (activeButton) {
        activeButton.classList.add('active', 'btn-primary');
        activeButton.classList.remove('btn-ghost');
    }
}

// Render a single room as a card
function renderRoomCard(r, index = 0) {
    const isLive = r.isLive === true;
    const badgeClass = isLive ? 'badge-success' : 'badge-ghost';
    const statusText = isLive ? '🟢 直播中' : '未开播';
    const duration = formatRoomDuration(r.broadcastDuration);
    const lastSession = r.lastSessionTime ? formatBeijingDateTime(r.lastSessionTime, '无记录') : '无记录';
    const isMonitorOn = r.isMonitorEnabled !== 0;
    const isRecordingEnabled = r.isRecordingEnabled === 1;
    const recordingAccountId = escapeHtml(r.recordingAccountId || '');
    const safeRoomId = escapeHtml(r.roomId);
    const safeName = escapeHtml(r.displayName || r.name || '');
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin();
    const canManageRename = canManageRoomRename();


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
                        <h2 class="card-title text-lg font-bold truncate w-36" title="${r.displayName || r.name}">${r.displayName || r.name || '未命名'}</h2>
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
                    ${isAdmin ? `<label class="label cursor-pointer p-0 gap-2">
                        <span class="label-text text-xs opacity-70">LZ</span>
                        <input type="checkbox" class="toggle toggle-xs toggle-success"
                            onchange="toggleMonitor('${safeRoomId}', this.checked, '${safeName}', '${escapeHtml(r.address || '')}')"
                            ${isMonitorOn ? 'checked' : ''} />
                    </label>` : ''}
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
                <div class="stat p-2 place-items-center" title="${MONTHLY_GIFT_TOOLTIP}">
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
                    ${isAdmin ? `<button class="btn btn-xs ${recoBtnClass}" onclick="toggleRecording('${safeRoomId}', '${safeRoomId}', this)" title="${recoBtnTooltip}">${recoBtnText}</button>` : ''}
                    ${canManageRename && r.lastSessionTime ? `<button class="btn btn-xs btn-ghost text-primary" onclick="renameRoom('${safeRoomId}')" title="更新房间ID/迁移数据">🔄</button>` : ''}
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
    const safeName = escapeHtml(r.displayName || r.name || '');
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin();
    const canManageRename = canManageRoomRename();

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
                    <div class="font-bold truncate max-w-[120px]" title="${r.displayName || r.name}">${r.displayName || r.name || '未命名'}</div>
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
        <td class="p-2 text-center font-mono text-sm text-success" title="${MONTHLY_GIFT_TOOLTIP}">${formatMonthlyWithAvg(r.monthlyGiftValue || 0)}</td>
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
        ${isAdmin ? `<td class="p-2 text-center" onclick="event.stopPropagation()">
            <input type="checkbox" class="toggle toggle-xs toggle-success"
                onchange="toggleMonitor('${safeRoomId}', this.checked, '${safeName}', '${escapeHtml(r.address || '')}')"
                ${isMonitorOn ? 'checked' : ''} />
        </td>` : ''}
        <td class="p-2 text-center" onclick="event.stopPropagation()">
            <div class="flex gap-1 justify-center">
                ${canManageRename ? `<button class="btn btn-xs btn-ghost text-primary" onclick="renameRoom('${safeRoomId}')" title="更新房间ID/迁移数据">🔄</button>` : ''}
                ${isAdmin ? `<button class="btn btn-xs ${recoBtnClass}" onclick="toggleRecording('${safeRoomId}', '${safeRoomId}', this)" title="${isRecording ? '停止录制' : '开始录制'}">${recoBtnText}</button>` : ''}
                <button class="btn btn-xs btn-ghost" onclick="openAddRoomModal('${safeRoomId}', '${safeName}', ${isMonitorOn}, '${r.language || '中文'}', ${r.priority}, ${isRecordingEnabled}, '${recordingAccountId}')">✏️</button>
                <button class="btn btn-xs btn-ghost text-error" onclick="deleteRoom('${safeRoomId}')">🗑️</button>

            </div>
        </td>
    </tr>`;
}

async function renderRoomList() {
    const container = $('#roomListContainer');
    applyRoomSortButtonState();

    // Show loading indicator immediately
    container.html(`
        <div class="col-span-full flex flex-col items-center justify-center py-20">
            <span class="loading loading-spinner loading-lg text-primary"></span>
            <p class="mt-4 text-base-content/60">加载中...</p>
        </div>
    `);

    try {
        // Build query string with pagination and search
        const forceFreshToken = roomListForceFreshToken;
        const params = new URLSearchParams({
            page: roomListPage,
            limit: roomListLimit,
            search: roomListSearch,
            sort: roomListSort
        });
        if (forceFreshToken) {
            params.set('forceFresh', String(forceFreshToken));
        }
        const result = await $.get(`/api/rooms/stats?${params}`);
        if (forceFreshToken && roomListForceFreshToken === forceFreshToken) {
            roomListForceFreshToken = 0;
        }

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
            const isAdminUser = typeof Auth !== 'undefined' && Auth.isAdmin();
            const tableHtml = `
            <div class="col-span-full overflow-x-auto">
                <table class="table table-sm w-full">
                    <thead>
                        <tr class="bg-base-200">
                            <th class="p-2 text-center">#</th>
                            <th class="p-2">房间</th>
                            ${thWithTip('时长', 'duration')}
                            ${thWithTip('进房', 'visits')}
                            ${thWithTip('弹幕', 'comments')}
                            ${thWithTip('💎本场', 'giftNow')}
                            ${thWithTip('💎月', 'giftMonth')}
                            ${roomListSort.includes('daily_avg') ? thWithTip('💎日均', 'giftDaily') : ''}
                            ${thWithTip('💰效率', 'giftEff')}
                            ${thWithTip('💬话题度', 'interact')}
                            ${thWithTip('👥质量', 'quality')}
                            ${thWithTip('T1', 'top1')}
                            ${thWithTip('T3', 'top3')}
                            ${thWithTip('T10', 'top10')}
                            ${thWithTip('T30', 'top30')}
                            ${isAdminUser ? thWithTip('LZ', 'monitor') : ''}
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

    if (btn) {
        applyRoomSortButtonState();
    }

    roomListPage = 1;
    renderRoomList();
}

function setRoomViewMode(mode) {
    if (!ROOM_LIST_VIEW_MODES.has(mode)) return;

    roomListViewMode = mode;
    saveRoomViewModePreference(mode);
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
    if (window.fetchAccountsForSelect) {
        window.fetchAccountsForSelect();
    }

    const isEdit = id && id !== 'undefined' && id !== 'null';
    const modalTitleEl = document.getElementById('roomModalTitle');

    if (modalTitleEl) {
        modalTitleEl.textContent = isEdit ? '编辑房间' : '添加房间';
    }

    if (isEdit) {
        $('#editRoomIdRaw').val(id);
        $('#roomUniqueId').val(id).prop('disabled', true);
        $('#roomNameInput').val(name);
        $('#roomMonitorToggle').prop('checked', isMonitorOn);
        if (language) $('#roomLanguage').val(language);
        $('#roomPriority').val(priority || 0);
        $('#roomAutoRecordToggle').prop('checked', isRecordingOn);
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

    // Load and display quota info
    const quotaEl = document.getElementById('roomQuotaInfo');
    quotaEl.style.display = 'none';
    if (typeof Auth !== 'undefined' && Auth.isLoggedIn() && !Auth.isAdmin()) {
        Auth.apiFetch('/api/rooms/quota').then(r => r.json()).then(data => {
            if (!data.quota) return;
            const q = data.quota;
            const items = [];
            const dailyLimit = Number.isFinite(Number(q.dailyLimit)) ? Number(q.dailyLimit) : -1;
            const dailyUsed = Number(q.dailyUsed || 0);
            // Room quota
            const roomLimitText = q.isUnlimited ? '无限' : q.limit;
            items.push(`<span>房间额度 <strong>${q.used}</strong> / ${roomLimitText}</span>`);
            // Daily limit - always show, -1 means unlimited
            const dailyLimitText = dailyLimit === -1 ? '不限' : dailyLimit;
            items.push(`<span>每日可添加次数 <strong>${dailyUsed}</strong> / ${dailyLimitText}</span>`);

            // Alert style based on remaining
            const isLow = (!q.isUnlimited && q.remaining <= 0) || (dailyLimit !== -1 && dailyUsed >= dailyLimit);
            quotaEl.className = `mb-4 alert ${isLow ? 'alert-warning' : 'alert-info'} py-2 text-sm`;
            quotaEl.innerHTML = `<div class="flex flex-wrap gap-x-4 gap-y-1">${items.join('<span class="opacity-30">|</span>')}</div>`;
            quotaEl.style.display = '';
        }).catch(() => {});
    }

    document.getElementById('roomModal').showModal();
    if (typeof Auth !== 'undefined') Auth.applyAdminVisibility();
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

window.bootRoomListOnMonitorPage = function bootRoomListOnMonitorPage() {
    if (window.__roomListBootstrapped) return;
    const container = document.getElementById('roomListContainer');
    if (!container) return;
    window.__roomListBootstrapped = true;
    if (canManageRoomRename()) {
        refreshRoomRenameJobs();
        startRoomRenameJobPolling();
    }
    renderRoomList();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof window.bootRoomListOnMonitorPage === 'function') {
            window.bootRoomListOnMonitorPage();
        }
    }, { once: true });
} else if (typeof window !== 'undefined' && typeof window.bootRoomListOnMonitorPage === 'function') {
    setTimeout(() => window.bootRoomListOnMonitorPage(), 0);
}

if (typeof window !== 'undefined') {
    window.addEventListener('auth:admin-access-updated', () => {
        renderRoomRenameJobFab(0);
        if (!canManageRoomRename()) {
            stopRoomRenameJobPolling();
            roomRenameJobPanelOpen = false;
            const panel = document.getElementById('roomRenameJobPanel');
            if (panel) {
                panel.classList.add('hidden');
                panel.setAttribute('aria-hidden', 'true');
            }
        } else {
            refreshRoomRenameJobs();
            startRoomRenameJobPolling();
        }
        renderRoomList();
    });
}
window.openAddRoomModal = openAddRoomModal;
window.closeRoomModal = closeRoomModal;
window.enterRoom = enterRoom;
window.deleteRoom = async function (id) {
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin();
    const msg = isAdmin
        ? '确定要删除该房间吗？\n\n此操作将永久删除房间及所有关联数据，不可恢复。'
        : '确定要移除该房间吗？\n\n如在 7 天内重新添加，可恢复之前的数据查看范围；超过 7 天则仅能查看重新添加后的数据。';
    if (!confirm(msg)) return;
    try {
        // URL-encode room ID to handle special characters like @
        await $.ajax({ url: `/api/rooms/${encodeURIComponent(id)}`, type: 'DELETE' });
        // Remove the DOM element instead of refreshing the entire list
        $(`[data-room-id="${escapeHtml(id)}"]`).fadeOut(300, function () { $(this).remove(); });
    } catch (e) {
        console.error('Delete room error:', e);
        alert('删除失败: ' + (e.responseJSON?.error || e.statusText));
    }
};
window.saveRoom = async function () {
    const id = $('#roomUniqueId').val().trim();
    const name = $('#roomNameInput').val().trim();
    const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin();
    const isEdit = $('#editRoomIdRaw').val().trim() !== '';

    if (!id) return alert('请输入房间ID');

    // Build request body: admin sends all fields, member only sends roomId + name (alias)
    const body = { roomId: id, name: name };
    if (isAdmin) {
        body.isMonitorEnabled = $('#roomMonitorToggle').is(':checked');
        body.isRecordingEnabled = $('#roomAutoRecordToggle').is(':checked');
        body.recordingAccountId = $('#roomRecordingAccount').val() || null;
        body.language = $('#roomLanguage').val();
        body.priority = parseInt($('#roomPriority').val()) || 0;
    }

    try {
        await $.ajax({
            url: '/api/rooms',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(body)
        });
        closeRoomModal();

        if (isEdit) {
            // Update DOM element instead of refreshing the entire list
            const el = $(`[data-room-id="${escapeHtml(id)}"]`);
            // Update name in card view
            el.find('.card-title').text(name || '未命名').attr('title', name);
            // Update name in list view
            el.find('.font-bold.truncate').text(name || '未命名').attr('title', name);
            // Update monitor toggle (admin only)
            if (isAdmin) {
                el.find('.toggle-success').prop('checked', body.isMonitorEnabled);
            }
            // Flash the element to indicate success
            el.addClass('ring-2 ring-primary');
            setTimeout(() => el.removeClass('ring-2 ring-primary'), 1000);
        } else {
            // New room - need to refresh to show it
            renderRoomList();
        }
    } catch (e) {
        console.error('Save room error:', e);
        let errorMsg = '保存失败';
        if (e.responseJSON) {
            const err = e.responseJSON;
            if (err.code === 'NO_SUBSCRIPTION') {
                errorMsg = err.error + '\n\n请前往用户中心购买套餐后再使用。';
                if (confirm(err.error + '\n\n是否立即跳转到用户中心?')) {
                    window.location.href = '/user-center.html';
                    return;
                }
            } else if (err.error) {
                errorMsg = err.error;
            }
        }
        alert(errorMsg);
    }
};

window.renameRoom = async function (oldRoomId) {
    if (!canManageRoomRename()) {
        roomListShowToast('当前管理员没有房间迁移权限', 'error');
        return;
    }
    const sourceRoomId = normalizeRoomIdInput(oldRoomId);
    if (isRoomRenamePending(sourceRoomId)) {
        toggleRoomRenameJobPanel(true);
        roomListShowToast(`房间 ${sourceRoomId} 正在处理中，请勿重复提交`, 'info');
        return;
    }
    if (roomRenameInFlight.has(sourceRoomId)) {
        toggleRoomRenameJobPanel(true);
        roomListShowToast(`房间 ${sourceRoomId} 正在处理中，请勿重复提交`, 'info');
        return;
    }

    const requestedRoomId = prompt(`请输入新的房间ID (将迁移 ${sourceRoomId} 的所有数据):`);
    const targetRoomId = normalizeRoomIdInput(requestedRoomId);
    if (!targetRoomId || targetRoomId === sourceRoomId) return;

    if (!confirm(`确定要将 ${sourceRoomId} 更新为 ${targetRoomId} 吗？\n\n系统会先停止当前房间采集，再迁移历史数据。`)) {
        return;
    }

    const submitRename = async (mergeExisting = false) => {
        const response = await Auth.apiFetch('/api/admin/async-jobs/room-rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                oldRoomId: sourceRoomId,
                newRoomId: targetRoomId,
                mergeExisting
            })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.error || '提交房间迁移任务失败');
            error.responseJSON = data;
            error.statusText = response.statusText;
            throw error;
        }
        return data;
    };

    roomRenameInFlight.add(sourceRoomId);
    setRoomRenamePending(sourceRoomId, true);
    try {
        await window.withGlobalLoading?.(
            `正在提交房间任务 ${sourceRoomId} -> ${targetRoomId}...`,
            async () => {
                const result = await submitRename(false);
                const jobId = Number(result?.job?.id || 0);
                if (jobId) {
                    selectedRoomRenameJobId = jobId;
                }
                toggleRoomRenameJobPanel(true);
                await refreshRoomRenameJobs({ jobId: jobId || selectedRoomRenameJobId || 0 });
                roomListShowToast(result?.message || '房间迁移任务已提交，请在右下角任务面板查看进度。', 'success');
            },
            { paintFrames: 1 }
        ) ?? (async () => {
            const result = await submitRename(false);
            const jobId = Number(result?.job?.id || 0);
            if (jobId) {
                selectedRoomRenameJobId = jobId;
            }
            toggleRoomRenameJobPanel(true);
            await refreshRoomRenameJobs({ jobId: jobId || selectedRoomRenameJobId || 0 });
            roomListShowToast(result?.message || '房间迁移任务已提交，请在右下角任务面板查看进度。', 'success');
        })();
    } catch (e) {
        console.error(e);

        const response = e?.responseJSON || {};
        if (response.code === 'TARGET_ROOM_EXISTS' && response.requiresConfirmation) {
            const targetName = response.targetRoom?.name || targetRoomId;
            const shouldMerge = confirm(
                `目标房间ID ${targetRoomId} 已存在（${targetName}）。\n\n选择“确定”后，将把 ${sourceRoomId} 的房间数据合并到 ${targetRoomId}。\n此操作会合并历史事件、场次、录制任务和房间关联，无法撤销。`
            );
            if (!shouldMerge) return;

            try {
                await window.withGlobalLoading?.(
                    `正在提交房间合并任务 ${sourceRoomId} -> ${targetRoomId}...`,
                    async () => {
                        const mergeResult = await submitRename(true);
                        const mergeJobId = Number(mergeResult?.job?.id || 0);
                        if (mergeJobId) {
                            selectedRoomRenameJobId = mergeJobId;
                        }
                        toggleRoomRenameJobPanel(true);
                        await refreshRoomRenameJobs({ jobId: mergeJobId || selectedRoomRenameJobId || 0 });
                        roomListShowToast(mergeResult?.message || '房间合并任务已提交，请在右下角任务面板查看进度。', 'success');
                    },
                    { paintFrames: 1 }
                ) ?? (async () => {
                    const mergeResult = await submitRename(true);
                    const mergeJobId = Number(mergeResult?.job?.id || 0);
                    if (mergeJobId) {
                        selectedRoomRenameJobId = mergeJobId;
                    }
                    toggleRoomRenameJobPanel(true);
                    await refreshRoomRenameJobs({ jobId: mergeJobId || selectedRoomRenameJobId || 0 });
                    roomListShowToast(mergeResult?.message || '房间合并任务已提交，请在右下角任务面板查看进度。', 'success');
                })();
            } catch (mergeError) {
                console.error(mergeError);
                const mergeResponse = mergeError?.responseJSON || {};
                if (mergeResponse.code === 'ROOM_RENAME_IN_PROGRESS') {
                    toggleRoomRenameJobPanel(true);
                    roomListShowToast('该房间正在执行迁移或合并，请勿重复提交', 'info');
                    return;
                }
                if (mergeResponse.code === 'ROOM_ALREADY_MIGRATED') {
                    toggleRoomRenameJobPanel(true);
                    roomListShowToast(mergeResponse.error || '原房间可能已完成迁移，请刷新列表确认', 'info');
                    queueFreshRoomListReload();
                    renderRoomList();
                    return;
                }
                alert('合并失败: ' + (mergeResponse.error || mergeError.statusText));
            }
            return;
        }

        if (response.code === 'ROOM_RENAME_IN_PROGRESS') {
            toggleRoomRenameJobPanel(true);
            roomListShowToast('该房间正在执行迁移或合并，请勿重复提交', 'info');
            return;
        }
        if (response.code === 'ROOM_ALREADY_MIGRATED') {
            toggleRoomRenameJobPanel(true);
            roomListShowToast(response.error || '原房间可能已完成迁移，请刷新列表确认', 'info');
            queueFreshRoomListReload();
            renderRoomList();
            return;
        }
        if (response.code === 'ROOM_NOT_FOUND') {
            alert('该房间已不存在，可能已被删除或已完成迁移。请刷新列表后再试。');
            queueFreshRoomListReload();
            renderRoomList();
            return;
        }

        alert('迁移失败: ' + (response.error || e.statusText));
    } finally {
        roomRenameInFlight.delete(sourceRoomId);
        setTimeout(() => setRoomRenamePending(sourceRoomId, false), 1500);
    }
};
