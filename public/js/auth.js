/**
 * Frontend Auth Utility
 * Manages tokens, provides authenticated fetch, and handles auth state
 */
const Auth = {
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
    },
    clearTokens() {
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

        // If 401 and we have a refresh token, try to refresh
        if (response.status === 401 && this.getRefreshToken()) {
            const refreshed = await this.refreshAccessToken();
            if (refreshed) {
                headers['Authorization'] = `Bearer ${this.getAccessToken()}`;
                response = await fetch(url, { ...options, headers });
            } else {
                this.clearTokens();
                window.location.href = '/login.html';
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
            if (!res.ok) return false;
            const data = await res.json();
            this.setTokens(data.accessToken, data.refreshToken, data.user);
            return true;
        } catch {
            return false;
        }
    },

    /**
     * Login
     */
    async login(username, password) {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
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
        window.location.href = '/login.html';
    },

    /**
     * Require auth - redirect to login if not authenticated
     */
    requireAuth() {
        if (!this.isLoggedIn()) {
            window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
            return false;
        }
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

        if (this.isLoggedIn()) {
            const user = this.getUser();
            let adminLink = '';
            if (this.isAdmin()) {
                adminLink = `<li><a href="/admin.html" class="btn btn-ghost btn-sm text-warning">管理后台</a></li>`;
            }
            authArea.innerHTML = `
                ${adminLink}
                <li><a href="/user-center.html" class="btn btn-ghost btn-sm">${user?.nickname || user?.username || '用户中心'}</a></li>
                <li><a onclick="Auth.logout()" class="btn btn-ghost btn-sm cursor-pointer">退出</a></li>
            `;
        } else {
            authArea.innerHTML = `
                <li><a href="/login.html" class="btn btn-ghost btn-sm">登录</a></li>
                <li><a href="/register.html" class="btn btn-primary btn-sm">注册</a></li>
            `;
        }
    }
};
