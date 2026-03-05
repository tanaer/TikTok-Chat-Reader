/**
 * auth.js — TikTok Monitor Universal Auth Gate
 * 
 * Responsibilities:
 *  1. Intercept all fetch() and inject Bearer token automatically
 *  2. initPage(options) — per-page auth + role guard
 *  3. checkQuota() — subscription gate for main app
 *  4. injectUserMenu() — top navbar user dropdown
 *  5. Global: window.logout(), window.authFetch()
 */
(function () {
    'use strict';

    const TOKEN_KEY = 'accessToken';
    const REFRESH_KEY = 'refreshToken';

    // ──────────────────────────────────────────────
    // 1. Fetch Interceptor — auto-inject Bearer token
    // ──────────────────────────────────────────────
    const _origFetch = window.fetch;
    window.fetch = function (url, options = {}) {
        const token = localStorage.getItem(TOKEN_KEY);
        if (token && typeof url === 'string' && url.startsWith('/api/')) {
            options = { ...options };
            options.headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
        }
        return _origFetch.call(this, url, options);
    };

    // ──────────────────────────────────────────────
    // 2. Token Helpers
    // ──────────────────────────────────────────────
    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function clearAuth() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(REFRESH_KEY);
    }

    function redirectLogin() {
        clearAuth();
        // Preserve current URL so we can redirect back after login
        const next = encodeURIComponent(window.location.href);
        window.location.href = '/landing/login.html?next=' + next;
    }

    async function refreshTokens() {
        const rt = localStorage.getItem(REFRESH_KEY);
        if (!rt) return null;
        try {
            const res = await _origFetch('/api/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken: rt })
            });
            if (!res.ok) return null;
            const data = await res.json();
            localStorage.setItem(TOKEN_KEY, data.accessToken);
            localStorage.setItem(REFRESH_KEY, data.refreshToken);
            return data;
        } catch { return null; }
    }

    // ──────────────────────────────────────────────
    // 3. Init Page — main entry point for each page
    // ──────────────────────────────────────────────
    /**
     * @param {Object} opts
     *   requireAuth  {boolean}  default true — redirect to login if no token
     *   requireAdmin {boolean}  default false — redirect to home if not admin
     *   checkQuota   {boolean}  default false — show quota gate overlay if no subscription
     *   onReady      {Function} called with user object when auth succeeds
     */
    window.initPage = async function (opts = {}) {
        const {
            requireAuth = true,
            requireAdmin = false,
            checkQuota = false,
            onReady = null
        } = opts;

        let token = getToken();

        // Not logged in
        if (!token) {
            if (requireAuth) { redirectLogin(); return; }
            if (onReady) onReady(null);
            return;
        }

        // Verify token with server
        let user = await verifyToken(token);

        // Try to refresh if expired
        if (!user) {
            const refreshed = await refreshTokens();
            if (refreshed) {
                token = refreshed.accessToken;
                user = refreshed.user || await verifyToken(token);
            }
        }

        if (!user) {
            if (requireAuth) { redirectLogin(); return; }
            if (onReady) onReady(null);
            return;
        }

        // Set globals
        window.currentUser = user;
        window.isAdmin = user.role === 'admin';

        // Admin guard
        if (requireAdmin && !window.isAdmin) {
            window.location.href = '/';
            return;
        }

        // Call onReady
        if (onReady) onReady(user);

        // Quota gate (non-blocking, visual only)
        if (checkQuota && !window.isAdmin) {
            showQuotaGate(user);
        }
    };

    async function verifyToken(token) {
        try {
            const res = await _origFetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; }
    }

    // ──────────────────────────────────────────────
    // 4. Quota Gate
    // ──────────────────────────────────────────────
    async function showQuotaGate() {
        try {
            // Wait until DOM is ready
            await domReady();
            const overlay = document.getElementById('quotaGateOverlay');
            if (!overlay) return; // Page doesn't have quota gate

            const res = await _origFetch('/api/subscription', {
                headers: { 'Authorization': `Bearer ${getToken()}` }
            });
            if (!res.ok) return;
            const sub = await res.json();

            const noSub = !sub.plan || sub.plan.code === 'none' || sub.daysRemaining < 0;
            if (noSub) {
                overlay.classList.add('visible');
            }
        } catch (e) {
            console.warn('[Auth] Quota check failed:', e);
        }
    }

    // ──────────────────────────────────────────────
    // 5. User Menu Injection
    // ──────────────────────────────────────────────
    window.injectUserMenu = function (user, containerId = 'userMenuSlot') {
        const slot = document.getElementById(containerId);
        if (!slot || !user) return;
        const isAdmin = user.role === 'admin';
        const initial = (user.nickname || user.email || '?')[0].toUpperCase();

        slot.innerHTML = `
          <div class="dropdown dropdown-end">
            <div tabindex="0" role="button" class="btn btn-ghost gap-2 px-2">
              <div class="avatar placeholder">
                <div class="bg-primary/20 text-primary rounded-full w-8 ring-1 ring-primary/30 font-bold">
                  <span>${initial}</span>
                </div>
              </div>
              <span class="hidden md:inline text-sm opacity-80 max-w-[120px] truncate">${user.nickname || user.email}</span>
              ${isAdmin ? '<span class="badge badge-warning badge-xs">Admin</span>' : ''}
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </div>
            <ul tabindex="0" class="dropdown-content menu bg-base-300/90 backdrop-blur-xl rounded-xl z-50 w-52 p-2 shadow-2xl border border-white/8 mt-2 animate-scale-in">
              <li class="menu-title text-xs opacity-40 pt-1">账户</li>
              <li><a href="/landing/user-center.html" class="rounded-lg">👤 用户中心</a></li>
              <li><a href="/landing/subscription.html" class="rounded-lg">💎 套餐订阅</a></li>
              ${isAdmin ? `<li class="divider my-1"></li><li class="menu-title text-xs opacity-40">管理员</li><li><a href="/landing/admin.html" class="rounded-lg text-warning">⚙️ 后台管理</a></li>` : ''}
              <li class="divider my-1"></li>
              <li><a onclick="window.logout()" class="rounded-lg text-error cursor-pointer">🚪 退出登录</a></li>
            </ul>
          </div>
        `;
    };

    // ──────────────────────────────────────────────
    // 6. Global Helpers
    // ──────────────────────────────────────────────
    window.logout = async function () {
        const rt = localStorage.getItem(REFRESH_KEY);
        try {
            await _origFetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
                body: JSON.stringify({ refreshToken: rt })
            });
        } catch { }
        clearAuth();
        window.location.href = '/landing/login.html';
    };

    window.authFetch = function (url, options = {}) {
        return window.fetch(url, options);
    };

    // ──────────────────────────────────────────────
    // 7. Utilities
    // ──────────────────────────────────────────────
    function domReady() {
        return new Promise(resolve => {
            if (document.readyState !== 'loading') resolve();
            else document.addEventListener('DOMContentLoaded', resolve, { once: true });
        });
    }

    // ──────────────────────────────────────────────
    // 8. Toast Helper (global)
    // ──────────────────────────────────────────────
    window.showToast = function (message, type = 'info', duration = 3500) {
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        const colors = { success: 'alert-success', error: 'alert-error', warning: 'alert-warning', info: 'alert-info' };
        const toast = document.createElement('div');
        toast.className = `toast-top alert ${colors[type] || 'alert-info'} shadow-2xl text-sm font-medium`;
        toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'fadeIn 0.3s ease reverse both';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    };

})();
