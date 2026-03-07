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
            return u ? JSON.parse(u) : null;
        } catch { return null; }
    },
    setTokens(accessToken, refreshToken, user) {
        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', refreshToken);
        if (user) localStorage.setItem('authUser', JSON.stringify(user));
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

    /**
     * Update navbar based on auth state
     */
    updateNavbar() {
        const authArea = document.getElementById('auth-nav-area');
        if (!authArea) return;

        // Update global top nav if present
        const globalNav = document.getElementById('global-top-nav');
        if (globalNav) {
            if (this.isLoggedIn()) {
                let adminLink = '';
                if (this.isAdmin()) {
                    adminLink = `<li><a href="/admin.html" class="text-warning">管理后台</a></li>`;
                }
                globalNav.innerHTML = `
                    <li><a href="/">首页</a></li>
                    <li><a href="/monitor.html">监控中心</a></li>
                    ${adminLink}
                `;
            } else {
                globalNav.innerHTML = `
                    <li><a href="/login.html" class="btn btn-primary btn-sm">立即开始</a></li>
                `;
            }
        }

        // Update auth area (right side)
        if (this.isLoggedIn()) {
            const user = this.getUser();
            authArea.innerHTML = `
                <li><a href="/user-center.html" class="btn btn-ghost btn-sm">用户中心</a></li>
                <li class="dropdown dropdown-end">
                    <label tabindex="0" class="btn btn-ghost btn-sm">
                        ${user?.nickname || user?.username || '用户'}
                        <svg class="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                    </label>
                    <ul tabindex="0" class="dropdown-content z-[1] menu p-2 shadow bg-base-100 rounded-box w-40">
                        <li><a onclick="Auth.logout()" class="text-error cursor-pointer">退出登录</a></li>
                    </ul>
                </li>
            `;
        } else {
            authArea.innerHTML = `
                <li><a href="/login.html" class="btn btn-ghost btn-sm">登录</a></li>
                <li><a href="/register.html" class="btn btn-primary btn-sm">注册</a></li>
            `;
        }

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
