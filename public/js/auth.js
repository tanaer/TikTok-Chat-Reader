/**
 * Frontend Auth Utility
 * Manages tokens, provides authenticated fetch, and handles auth state
 */
const Auth = {
    _sessionHeartbeatTimer: null,
    _sessionCheckPromise: null,
    _shellMessagePollTimer: null,
    _shellMessageUnreadCount: 0,
    _shellMessageItems: [],
    _shellMessagePagination: { page: 1, totalPages: 1, total: 0 },
    _shellMessageLoading: false,

    // Token storage
    getAccessToken() {
        return localStorage.getItem('accessToken');
    },
    getRefreshToken() {
        return localStorage.getItem('refreshToken');
    },
    getUser() {
        try {
            const u = localStorage.getItem('authUser');
            if (u) return JSON.parse(u);
        } catch {}

        const token = this.getAccessToken();
        if (!token) return null;

        try {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return {
                id: payload.userId,
                username: payload.username,
                nickname: payload.nickname || payload.username,
                role: payload.role
            };
        } catch {
            return null;
        }
    },
    setUser(user) {
        if (user) localStorage.setItem('authUser', JSON.stringify(user));
    },
    setTokens(accessToken, refreshToken, user) {
        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', refreshToken);
        if (user) this.setUser(user);
        this.startSessionHeartbeat();
    },
    clearTokens() {
        this.stopSessionHeartbeat();
        if (this._shellMessagePollTimer) {
            clearInterval(this._shellMessagePollTimer);
            this._shellMessagePollTimer = null;
        }
        this._shellMessageUnreadCount = 0;
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('authUser');
    },
    isLoggedIn() {
        return !!this.getAccessToken();
    },
    isAdmin() {
        const user = this.getUser();
        return user && user.role === 'admin';
    },

    redirectToLogin(message) {
        if (message) {
            try { alert(message); } catch { /* ignore */ }
        }
        this.clearTokens();
        if (!window.location.pathname.endsWith('/login.html')) {
            window.location.href = '/login.html';
        }
    },

    /**
     * Authenticated fetch - auto-attaches token and handles refresh
     */
    async apiFetch(url, options = {}) {
        const token = this.getAccessToken();
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        let response = await fetch(url, { ...options, headers });

        // Check for disabled account (403 with specific error)
        if (response.status === 403) {
            try {
                const data = await response.clone().json();
                if (data.error === '账户已被禁用' || data.code === 'ACCOUNT_DISABLED') {
                    alert('您的账户已被禁用，请联系管理员');
                    this.clearTokens();
                    window.location.href = '/login.html';
                    return response;
                }
            } catch { /* ignore */ }
        }

        // If 401 and we have a refresh token, try to refresh
        if (response.status === 401 && this.getRefreshToken()) {
            const refreshed = await this.refreshAccessToken();
            if (refreshed) {
                headers['Authorization'] = `Bearer ${this.getAccessToken()}`;
                response = await fetch(url, { ...options, headers });
            } else {
                this.redirectToLogin();
                return response;
            }
        }

        return response;
    },

    /**
     * Refresh the access token using refresh token
     */
    async refreshAccessToken() {
        try {
            const res = await fetch('/api/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken: this.getRefreshToken() })
            });
            if (!res.ok) {
                try {
                    const data = await res.json();
                    if (data.code === 'SESSION_REVOKED') {
                        this.redirectToLogin(data.error || '您的账号已在其他地方登录，请重新登录');
                    }
                } catch { /* ignore */ }
                return false;
            }
            const data = await res.json();
            this.setTokens(data.accessToken, data.refreshToken, data.user);
            return true;
        } catch {
            return false;
        }
    },

    async ensureSessionActive() {
        if (!this.isLoggedIn()) return false;
        if (this._sessionCheckPromise) return this._sessionCheckPromise;

        this._sessionCheckPromise = (async () => {
            try {
                const res = await this.apiFetch('/api/auth/me', {
                    headers: { 'Cache-Control': 'no-store' }
                });
                if (res?.ok) {
                    try {
                        const data = await res.clone().json();
                        if (data?.user) this.setUser(data.user);
                    } catch {}
                }
                return !!res?.ok;
            } catch {
                return true;
            } finally {
                this._sessionCheckPromise = null;
            }
        })();

        return this._sessionCheckPromise;
    },

    startSessionHeartbeat(intervalMs = 15000) {
        if (!this.isLoggedIn() || this._sessionHeartbeatTimer) return;

        this.ensureSessionActive().catch(() => {});
        this._sessionHeartbeatTimer = setInterval(() => {
            if (!this.isLoggedIn()) {
                this.stopSessionHeartbeat();
                return;
            }
            this.ensureSessionActive().catch(() => {});
        }, intervalMs);
    },

    stopSessionHeartbeat() {
        if (this._sessionHeartbeatTimer) {
            clearInterval(this._sessionHeartbeatTimer);
            this._sessionHeartbeatTimer = null;
        }
    },

    /**
     * Login
     */
    async login(account, password, options = {}) {
        const body = { username: account, account, password };
        if (options.captchaToken) body.captchaToken = options.captchaToken;
        if (options.captchaAnswer) body.captchaAnswer = options.captchaAnswer;
        if (options.captchaPassToken && !body.captchaToken) body.captchaPassToken = options.captchaPassToken;

        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (res.ok) {
            this.setTokens(data.accessToken, data.refreshToken, data.user);
        }
        return { ok: res.ok, data };
    },

    /**
     * Register
     */
    async register(username, password, nickname, email) {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, nickname, email: email || undefined })
        });
        const data = await res.json();
        if (res.ok) {
            this.setTokens(data.accessToken, data.refreshToken, data.user);
        }
        return { ok: res.ok, data };
    },

    /**
     * Logout
     */
    async logout() {
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken: this.getRefreshToken() })
            });
        } catch { /* ignore */ }
        this.clearTokens();
        window.location.href = '/';
    },

    /**
     * Require auth - redirect to login if not authenticated
     */
    requireAuth() {
        if (!this.isLoggedIn()) {
            window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
            return false;
        }
        this.startSessionHeartbeat();
        this.ensureSessionActive().catch(() => {});
        return true;
    },

    /**
     * Require admin - redirect if not admin
     */
    requireAdmin() {
        if (!this.requireAuth()) return false;
        if (!this.isAdmin()) {
            window.location.href = '/';
            return false;
        }
        return true;
    },

    getCurrentPath() {
        return (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname : '/';
    },

    buildNavLink(href, label, { active = false, tone = 'default', button = false, onclick = '' } = {}) {
        const classes = [];
        if (button) {
            classes.push('btn', 'btn-sm', 'app-shell-nav-action');
            if (tone === 'primary') classes.push('btn-primary');
            else if (tone === 'warning') classes.push('btn-warning');
            else if (tone === 'danger') classes.push('btn-outline', 'btn-error', 'app-shell-nav-danger');
            else classes.push('btn-ghost');
            if (active) classes.push('is-active');
        } else {
            classes.push('app-shell-nav-link');
            if (active) classes.push('is-active');
            if (tone === 'warning') classes.push('text-warning');
        }
        const hrefAttr = href ? ` href="${href}"` : '';
        const onclickAttr = onclick ? ` onclick="${onclick}"` : '';
        return `<li><a${hrefAttr}${onclickAttr} class="${classes.join(' ')}">${label}</a></li>`;
    },

    renderGlobalNav(globalNav) {
        if (!globalNav) return;
        const currentPath = this.getCurrentPath();
        if (this.isLoggedIn()) {
            const items = [
                this.buildNavLink('/', '首页', { active: currentPath === '/' }),
                this.buildNavLink('/monitor.html', '监控中心', { active: currentPath === '/monitor.html' })
            ];
            if (this.isAdmin()) {
                items.push(this.buildNavLink('/tanaer.html', '管理后台', { active: currentPath === '/tanaer.html' }));
            }
            globalNav.innerHTML = items.join('');
        } else {
            globalNav.innerHTML = this.buildNavLink('/login.html', '立即开始', { button: true, tone: 'primary' });
        }
    },

    getShellOptions() {
        const body = (typeof document !== 'undefined') ? document.body : null;
        return {
            showMessages: body?.dataset?.shellMessages === 'true',
            messagePolling: body?.dataset?.shellMessagePolling || body?.dataset?.shellMessagePoll || 'none',
            messagePageSize: Math.max(1, Number(body?.dataset?.shellMessagePageSize || 5) || 5),
        };
    },

    buildMessageMenuButton() {
        return `<li><a href="#" id="message-menu-btn" onclick="return Auth.handleMessageMenuClick(event)" class="btn btn-ghost btn-sm gap-2 app-shell-nav-action">消息<span id="message-menu-badge" class="badge badge-error badge-sm hidden">0</span></a></li>`;
    },

    buildUserDropdown(user) {
        const displayName = user?.nickname || user?.username || '用户';
        return `
            <li class="dropdown dropdown-end dropdown-bottom dropdown-hover relative app-shell-user-dropdown">
                <div tabindex="0" role="button" class="btn btn-ghost btn-sm app-shell-nav-user app-shell-nav-action gap-2">
                    <span>${displayName}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
                <ul tabindex="0" class="dropdown-content menu menu-sm z-[80] top-full right-0 w-32 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl app-shell-user-menu">
                    <li><a href="#" class="text-error" onclick="return Auth.handleLogoutFromMenu(event)">退出登录</a></li>
                </ul>
            </li>
        `;
    },


    escapeShellMessageHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    getShellMessageLevelMeta(level) {
        const normalized = String(level || 'info').toLowerCase();
        if (normalized === 'success') return { label: '成功', badge: 'badge-success badge-outline' };
        if (normalized === 'warning' || normalized === 'warn') return { label: '提醒', badge: 'badge-warning badge-outline' };
        if (normalized === 'error') return { label: '异常', badge: 'badge-error badge-outline' };
        return { label: '通知', badge: 'badge-info badge-outline' };
    },

    formatShellMessageTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return this.escapeShellMessageHtml(value);
        return this.escapeShellMessageHtml(date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    },

    ensureShellMessageDialog() {
        if (typeof document === 'undefined') return null;
        let dialog = document.getElementById('global-message-modal');
        if (dialog) return dialog;

        dialog = document.createElement('dialog');
        dialog.id = 'global-message-modal';
        dialog.className = 'modal';
        dialog.innerHTML = `
            <div class="modal-box max-w-3xl p-0">
                <div class="px-5 py-4 border-b border-base-300 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h3 class="text-lg font-bold">消息中心</h3>
                        <p id="global-message-modal-subtitle" class="text-sm text-base-content/60 mt-1">支付到账、人工确认、AI处理结果等消息会显示在这里。</p>
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <button id="global-message-refresh-btn" type="button" class="btn btn-ghost btn-sm" onclick="return Auth.refreshShellMessages(event)">刷新</button>
                        <button id="global-message-read-all-btn" type="button" class="btn btn-primary btn-sm" onclick="return Auth.markAllShellMessagesRead(event)">全部已读</button>
                        <form method="dialog">
                            <button class="btn btn-ghost btn-sm">关闭</button>
                        </form>
                    </div>
                </div>
                <div id="global-message-modal-status" class="px-5 py-3 text-sm text-base-content/60 border-b border-base-300 hidden"></div>
                <div id="global-message-modal-list" class="px-5 py-4 max-h-[70vh] overflow-y-auto space-y-3"></div>
                <div class="px-5 py-4 border-t border-base-300 flex flex-wrap items-center justify-between gap-3">
                    <div id="global-message-pagination-summary" class="text-sm text-base-content/60">第 1 / 1 页</div>
                    <div class="join">
                        <button id="global-message-prev-btn" type="button" class="join-item btn btn-sm" onclick="return Auth.changeShellMessagePage(-1, event)">上一页</button>
                        <button id="global-message-next-btn" type="button" class="join-item btn btn-sm" onclick="return Auth.changeShellMessagePage(1, event)">下一页</button>
                    </div>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop">
                <button>关闭</button>
            </form>
        `;
        document.body.appendChild(dialog);
        return dialog;
    },

    setShellMessageStatus(message = '', tone = 'muted') {
        const el = document.getElementById('global-message-modal-status');
        if (!el) return;
        const toneClass = tone === 'error' ? 'text-error' : tone === 'success' ? 'text-success' : 'text-base-content/60';
        el.className = `px-5 py-3 text-sm border-b border-base-300 ${message ? '' : 'hidden'} ${toneClass}`;
        el.textContent = message;
    },

    renderShellMessageList() {
        const listEl = document.getElementById('global-message-modal-list');
        const subtitleEl = document.getElementById('global-message-modal-subtitle');
        const summaryEl = document.getElementById('global-message-pagination-summary');
        const prevBtn = document.getElementById('global-message-prev-btn');
        const nextBtn = document.getElementById('global-message-next-btn');
        const readAllBtn = document.getElementById('global-message-read-all-btn');
        if (!listEl || !subtitleEl || !summaryEl || !prevBtn || !nextBtn || !readAllBtn) return;

        const unreadCount = this._shellMessageUnreadCount || 0;
        const page = Math.max(1, Number(this._shellMessagePagination?.page || 1));
        const totalPages = Math.max(1, Number(this._shellMessagePagination?.totalPages || 1));
        const total = Math.max(0, Number(this._shellMessagePagination?.total || this._shellMessageItems.length || 0));

        subtitleEl.textContent = unreadCount > 0
            ? `当前有 ${unreadCount} 条未读通知，请及时处理。`
            : '支付到账、人工确认、AI处理结果等消息会显示在这里。';
        summaryEl.textContent = `第 ${page} / ${totalPages} 页 · 共 ${total} 条`;
        prevBtn.disabled = this._shellMessageLoading || page <= 1;
        nextBtn.disabled = this._shellMessageLoading || page >= totalPages;
        readAllBtn.disabled = this._shellMessageLoading || unreadCount <= 0;

        if (this._shellMessageLoading) {
            listEl.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-10 text-center text-base-content/60"><span class="loading loading-spinner loading-sm mr-2"></span>正在加载消息...</div>';
            return;
        }

        if (!this._shellMessageItems.length) {
            listEl.innerHTML = '<div class="rounded-box bg-base-200 px-5 py-10 text-center text-base-content/60">暂无消息</div>';
            return;
        }

        listEl.innerHTML = this._shellMessageItems.map((item) => {
            const levelMeta = this.getShellMessageLevelMeta(item.level);
            const unreadDot = item.isRead ? '' : '<span class="inline-flex h-2.5 w-2.5 rounded-full bg-error"></span>';
            const orderMeta = item.relatedOrderNo ? `<span>订单号 ${this.escapeShellMessageHtml(item.relatedOrderNo)}</span>` : '';
            const actionUrl = encodeURIComponent(item.actionUrl || '');
            const actionTab = this.escapeShellMessageHtml(item.actionTab || 'overview');
            return `
                <div class="rounded-box border ${item.isRead ? 'border-base-300 bg-base-100' : 'border-primary/30 bg-primary/5'} px-4 py-4 cursor-pointer hover:border-primary/40 transition" onclick="return Auth.handleShellMessageItemClick(event, ${Number(item.id || 0)}, '${actionTab}', '${actionUrl}')">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2 text-sm font-semibold">${unreadDot}<span>${this.escapeShellMessageHtml(item.title || '通知')}</span><span class="badge badge-sm ${levelMeta.badge}">${levelMeta.label}</span></div>
                            <div class="text-sm text-base-content/75 leading-6 mt-2 break-words">${this.escapeShellMessageHtml(item.content || '')}</div>
                            <div class="text-xs text-base-content/55 mt-3 flex flex-wrap gap-3"><span>${this.formatShellMessageTime(item.createdAt)}</span>${orderMeta}</div>
                        </div>
                        ${item.isRead ? '' : `<button type="button" class="btn btn-ghost btn-xs shrink-0" onclick="return Auth.markShellMessageRead(${Number(item.id || 0)}, event)">标记已读</button>`}
                    </div>
                </div>
            `;
        }).join('');
    },

    async loadShellMessages(page = 1, { silent = false } = {}) {
        const dialog = this.ensureShellMessageDialog();
        if (!dialog) return;
        const pageSize = this.getShellOptions().messagePageSize || 5;
        this._shellMessageLoading = true;
        this.setShellMessageStatus('', 'muted');
        this.renderShellMessageList();

        try {
            const res = await this.apiFetch(`/api/user/notifications?page=${page}&limit=${pageSize}`, { adminSilent: silent });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || '加载消息失败');
            }
            this._shellMessageItems = Array.isArray(data.notifications) ? data.notifications : [];
            this._shellMessagePagination = {
                page: Number(data.pagination?.page || page || 1),
                totalPages: Math.max(1, Number(data.pagination?.pages || data.pagination?.totalPages || 1)),
                total: Math.max(0, Number(data.pagination?.total || this._shellMessageItems.length || 0)),
            };
            this.setMessageBadgeCount(Number(data.unreadCount || 0));
            this.setShellMessageStatus('', 'muted');
        } catch (err) {
            this._shellMessageItems = [];
            this._shellMessagePagination = { page: 1, totalPages: 1, total: 0 };
            this.setShellMessageStatus(err.message || '加载消息失败', 'error');
        } finally {
            this._shellMessageLoading = false;
            this.renderShellMessageList();
        }
    },

    openShellMessagesModal() {
        const dialog = this.ensureShellMessageDialog();
        if (!dialog) return false;
        if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
        this.loadShellMessages(1, { silent: true }).catch(() => {});
        return false;
    },

    async refreshShellMessages(event) {
        if (event?.preventDefault) event.preventDefault();
        await this.loadShellMessages(this._shellMessagePagination?.page || 1, { silent: true });
        return false;
    },

    async changeShellMessagePage(delta, event) {
        if (event?.preventDefault) event.preventDefault();
        if (this._shellMessageLoading) return false;
        const nextPage = Math.max(1, Math.min((this._shellMessagePagination?.totalPages || 1), (this._shellMessagePagination?.page || 1) + Number(delta || 0)));
        if (nextPage === (this._shellMessagePagination?.page || 1)) return false;
        await this.loadShellMessages(nextPage, { silent: true });
        return false;
    },

    async markShellMessageRead(id, event) {
        if (event?.preventDefault) event.preventDefault();
        if (event?.stopPropagation) event.stopPropagation();
        try {
            const res = await this.apiFetch(`/api/user/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', adminSilent: true });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '操作失败');
            await this.loadShellMessages(this._shellMessagePagination?.page || 1, { silent: true });
            if (typeof window.loadNotifications === 'function') {
                window.loadNotifications(1, { silent: true });
            }
        } catch (err) {
            this.setShellMessageStatus(err.message || '标记已读失败', 'error');
        }
        return false;
    },

    async markAllShellMessagesRead(event) {
        if (event?.preventDefault) event.preventDefault();
        try {
            const res = await this.apiFetch('/api/user/notifications/read-all', { method: 'POST', adminSilent: true });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '操作失败');
            await this.loadShellMessages(1, { silent: true });
            if (typeof window.loadNotifications === 'function') {
                window.loadNotifications(1, { silent: true });
            }
            this.setShellMessageStatus(data.message || '已全部标记为已读', 'success');
        } catch (err) {
            this.setShellMessageStatus(err.message || '操作失败', 'error');
        }
        return false;
    },

    handleShellMessageRoute(actionTab = 'overview', actionUrl = '') {
        const currentPath = this.getCurrentPath();
        const normalizedActionUrl = String(actionUrl || '').trim();
        const normalizedActionTab = String(actionTab || 'overview').trim();
        if (normalizedActionUrl) {
            window.location.href = normalizedActionUrl;
            return false;
        }

        const tabMap = ['overview', 'orders', 'balance', 'subscription', 'settings'];
        const targetTab = tabMap.includes(normalizedActionTab) ? normalizedActionTab : 'overview';
        if (currentPath === '/user-center.html' && typeof window.switchTab === 'function') {
            const tabEl = document.getElementById(`main-tab-${targetTab}`) || document.querySelector(`.tab[onclick*="${targetTab}"]`);
            window.switchTab(targetTab, tabEl || null);
            return false;
        }

        const params = new URLSearchParams();
        if (targetTab !== 'overview') params.set('tab', targetTab);
        const nextQuery = params.toString();
        window.location.href = `/user-center.html${nextQuery ? `?${nextQuery}` : ''}`;
        return false;
    },

    async handleShellMessageItemClick(event, id, actionTab = 'overview', encodedActionUrl = '') {
        if (event?.preventDefault) event.preventDefault();
        const dialog = document.getElementById('global-message-modal');
        await this.markShellMessageRead(id, { preventDefault() {}, stopPropagation() {} });
        if (dialog?.open) dialog.close();
        return this.handleShellMessageRoute(actionTab, encodedActionUrl ? decodeURIComponent(encodedActionUrl) : '');
    },

    renderAuthArea(authArea, { hasGlobalNav = false } = {}) {
        if (!authArea) return;
        const currentPath = this.getCurrentPath();
        const shellOptions = this.getShellOptions();
        if (this.isLoggedIn()) {
            const user = this.getUser();
            const items = [];
            if (!hasGlobalNav) {
                items.push(this.buildNavLink('/monitor.html', '监控中心', { button: true, tone: 'default', active: currentPath === '/monitor.html' }));
                if (this.isAdmin()) {
                    items.push(this.buildNavLink('/tanaer.html', '管理后台', { button: true, tone: 'warning', active: currentPath === '/tanaer.html' }));
                }
            }
            if (shellOptions.showMessages) {
                items.push(this.buildMessageMenuButton());
            }
            items.push(this.buildNavLink('/user-center.html', '用户中心', { button: true, tone: 'default', active: currentPath === '/user-center.html' }));
            items.push(this.buildUserDropdown(user));
            authArea.innerHTML = items.join('');
            this.setMessageBadgeCount(this._shellMessageUnreadCount);
        } else {
            authArea.innerHTML = [
                this.buildNavLink('/login.html', '登录', { button: true, tone: 'default' }),
                this.buildNavLink('/register.html', '注册', { button: true, tone: 'primary' })
            ].join('');
        }
    },

    setMessageBadgeCount(count = 0) {
        const unreadCount = Math.max(0, Number(count) || 0);
        this._shellMessageUnreadCount = unreadCount;
        const badge = document.getElementById('message-menu-badge');
        if (!badge) return;
        badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        badge.classList.toggle('hidden', unreadCount <= 0);
    },

    async refreshMessageBadge({ silent = true } = {}) {
        if (!this.isLoggedIn()) return 0;
        try {
            const res = await this.apiFetch('/api/user/notifications?page=1&limit=1', { adminSilent: silent });
            const data = await res.json();
            if (!res.ok) return this._shellMessageUnreadCount || 0;
            this.setMessageBadgeCount(Number(data.unreadCount || 0));
            return this._shellMessageUnreadCount;
        } catch {
            return this._shellMessageUnreadCount || 0;
        }
    },

    syncMessagePolling() {
        const { showMessages, messagePolling } = this.getShellOptions();
        if (!showMessages || messagePolling !== 'auth' || !this.isLoggedIn()) {
            if (this._shellMessagePollTimer) {
                clearInterval(this._shellMessagePollTimer);
                this._shellMessagePollTimer = null;
            }
            return;
        }

        this.refreshMessageBadge({ silent: true }).catch(() => {});
        if (this._shellMessagePollTimer) return;

        this._shellMessagePollTimer = setInterval(() => {
            this.refreshMessageBadge({ silent: true }).catch(() => {});
        }, 15000);
    },

    handleMessageMenuClick(event) {
        if (event?.preventDefault) event.preventDefault();
        return this.openShellMessagesModal();
    },

    handleLogoutFromMenu(event) {
        if (event?.preventDefault) event.preventDefault();
        this.logout();
        return false;
    },

    /**
     * Update navbar based on auth state
     */
    updateNavbar() {
        const authArea = document.getElementById('auth-nav-area');
        if (!authArea) return;

        const globalNav = document.getElementById('global-top-nav');
        this.renderGlobalNav(globalNav);
        this.renderAuthArea(authArea, { hasGlobalNav: !!globalNav });
        if (this.getShellOptions().showMessages) {
            this.ensureShellMessageDialog();
        }
        this.syncMessagePolling();

        // Apply admin-only visibility
        this.applyAdminVisibility();
    },

    /**
     * Hide/show elements based on admin role
     * Elements with data-admin-only="true" are hidden for non-admins
     */
    applyAdminVisibility() {
        const isAdmin = this.isAdmin();
        document.querySelectorAll('[data-admin-only]').forEach(el => {
            if (isAdmin) {
                el.style.display = '';
            } else {
                el.style.display = 'none';
            }
        });
    }
};

if (typeof window !== 'undefined') {
    window.Auth = Auth;
}

if (typeof window !== 'undefined' && Auth.isLoggedIn()) {
    Auth.startSessionHeartbeat();
}

// Auto-attach Authorization header to all jQuery AJAX requests
if (typeof $ !== 'undefined') {
    $.ajaxSetup({
        beforeSend: function(xhr) {
            const token = Auth.getAccessToken();
            if (token) {
                xhr.setRequestHeader('Authorization', 'Bearer ' + token);
            }
        }
    });
}
