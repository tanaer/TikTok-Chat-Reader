/**
 * Frontend Auth Utility
 * Manages tokens, provides authenticated fetch, and handles auth state
 */
const Auth = {
    _sessionHeartbeatTimer: null,
    _sessionCheckPromise: null,

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
                items.push(this.buildNavLink('/admin.html', '管理后台', { active: currentPath === '/admin.html' }));
            }
            globalNav.innerHTML = items.join('');
        } else {
            globalNav.innerHTML = this.buildNavLink('/login.html', '立即开始', { button: true, tone: 'primary' });
        }
    },

    renderAuthArea(authArea, { hasGlobalNav = false } = {}) {
        if (!authArea) return;
        const currentPath = this.getCurrentPath();
        if (this.isLoggedIn()) {
            const user = this.getUser();
            const items = [];
            if (!hasGlobalNav) {
                items.push(this.buildNavLink('/monitor.html', '监控中心', { button: true, tone: 'default', active: currentPath === '/monitor.html' }));
                if (this.isAdmin()) {
                    items.push(this.buildNavLink('/admin.html', '管理后台', { button: true, tone: 'warning', active: currentPath === '/admin.html' }));
                }
            }
            items.push(this.buildNavLink('/user-center.html', '用户中心', { button: true, tone: 'default', active: currentPath === '/user-center.html' }));
            items.push(`<li><span class="btn btn-ghost btn-sm app-shell-nav-user">${user?.nickname || user?.username || '用户'}</span></li>`);
            items.push(this.buildNavLink('', '退出', { button: true, tone: 'danger', onclick: 'Auth.logout()' }));
            authArea.innerHTML = items.join('');
        } else {
            authArea.innerHTML = [
                this.buildNavLink('/login.html', '登录', { button: true, tone: 'default' }),
                this.buildNavLink('/register.html', '注册', { button: true, tone: 'primary' })
            ].join('');
        }
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
