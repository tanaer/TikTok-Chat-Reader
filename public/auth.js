/**
 * auth.js — TikTok Monitor Universal Auth Gate
 *
 * Responsibilities:
 *  1. Intercept all fetch() AND jQuery $.ajax → inject Bearer token globally
 *  2. initPage(options) — per-page auth + role guard + quota check
 *  3. injectUserMenu() — top navbar user dropdown
 *  4. Global: window.logout(), window.authFetch(), window.showToast()
 */
(function () {
    'use strict';

    const TOKEN_KEY = 'accessToken';
    const REFRESH_KEY = 'refreshToken';

    // ── 1. Native fetch Interceptor ──────────────────────────────────────────
    const _origFetch = window.fetch;
    window.fetch = function (url, options = {}) {
        const token = localStorage.getItem(TOKEN_KEY);
        if (token && typeof url === 'string' && url.startsWith('/api/')) {
            options = { ...options };
            options.headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
        }
        return _origFetch.call(this, url, options);
    };

    // ── 2. jQuery $.ajax Interceptor ─────────────────────────────────────────
    // jQuery loads AFTER auth.js, so we wire this up on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', function () {
        if (typeof $ === 'undefined' || typeof $.ajaxSetup === 'undefined') return;

        $.ajaxSetup({
            beforeSend(xhr, settings) {
                // Only inject for internal API calls
                if (settings.url && settings.url.toString().startsWith('/api/')) {
                    const token = localStorage.getItem(TOKEN_KEY);
                    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
                }
            }
        });

        // Global 401 handler: auto-refresh token and retry once
        $(document).ajaxError(async function (event, xhr, settings) {
            if (xhr.status === 401 &&
                settings.url && settings.url.startsWith('/api/') &&
                !settings.url.includes('/auth/refresh') &&
                !settings.__retried) {
                const refreshed = await refreshTokens();
                if (refreshed) {
                    settings.__retried = true;
                    $.ajax(settings); // retry once with fresh token
                } else {
                    redirectLogin();
                }
            }
        });
    }, { once: true });

    // ── 3. Token Helpers ──────────────────────────────────────────────────────
    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function clearAuth() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(REFRESH_KEY);
    }

    function redirectLogin() {
        clearAuth();
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
            if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken);
            return data;
        } catch { return null; }
    }

    async function verifyToken(token) {
        try {
            const res = await _origFetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; }
    }

    // ── 4. initPage — main per-page entry point ───────────────────────────────
    /**
     * @param {Object} opts
     *   requireAuth  {boolean}  default true  — redirect to login if no token
     *   requireAdmin {boolean}  default false — redirect home if not admin
     *   checkQuota   {boolean}  default false — show quota gate if no valid subscription
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

        if (!token) {
            if (requireAuth) { redirectLogin(); return; }
            if (onReady) onReady(null);
            return;
        }

        let user = await verifyToken(token);

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

        window.currentUser = user;
        window.isAdmin = user.role === 'admin';

        if (requireAdmin && !window.isAdmin) {
            window.location.href = '/';
            return;
        }

        if (onReady) onReady(user);

        if (checkQuota && !window.isAdmin) {
            showQuotaGate();
        }
    };

    // ── 5. Quota Gate ─────────────────────────────────────────────────────────
    async function showQuotaGate() {
        try {
            await domReady();
            const overlay = document.getElementById('quotaGateOverlay');
            if (!overlay) return;
            const res = await _origFetch('/api/subscription', {
                headers: { 'Authorization': `Bearer ${getToken()}` }
            });
            if (!res.ok) return;
            const sub = await res.json();
            const noSub = !sub.plan || sub.plan.code === 'none' || sub.daysRemaining < 0;
            if (noSub) overlay.classList.add('visible');
        } catch (e) {
            console.warn('[Auth] Quota check failed:', e);
        }
    }

    // ── 6. User Menu Injection ────────────────────────────────────────────────
    window.injectUserMenu = function (user, containerId = 'userMenuSlot') {
        const slot = document.getElementById(containerId);
        if (!slot || !user) return;
        const isAdm = user.role === 'admin';
        const initial = (user.nickname || user.email || '?')[0].toUpperCase();

        slot.innerHTML = `
          <div class="dropdown dropdown-end">
            <label tabindex="0" class="btn btn-ghost gap-2 px-2 cursor-pointer">
              <div class="avatar placeholder">
                <div class="bg-primary/20 text-primary rounded-full w-8 ring-1 ring-primary/30 font-bold">
                  <span>${initial}</span>
                </div>
              </div>
              <span class="hidden md:inline text-sm opacity-80 max-w-[120px] truncate">${user.nickname || user.email}</span>
              ${isAdm ? '<span class="badge badge-warning badge-xs">Admin</span>' : ''}
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </label>
            <ul tabindex="0" class="dropdown-content z-[100] menu p-2 shadow-2xl bg-base-300 rounded-box w-52 border border-white/10">
              <li class="menu-title text-xs opacity-40 pt-1">账户</li>
              <li><a href="/landing/user-center.html">👤 用户中心</a></li>
              ${isAdm ? `<li class="menu-title text-xs opacity-40">管理员</li><li><a href="/landing/admin.html" class="text-warning">⚙️ 后台管理</a></li>` : ''}
              <li class="border-t border-white/10 mt-1 pt-1"><a class="text-error" id="logoutLink">🚪 退出登录</a></li>
            </ul>
          </div>
        `;

        // Bind logout click using setTimeout to ensure DOM is ready
        setTimeout(function() {
            const logoutLink = document.getElementById('logoutLink');
            if (logoutLink) {
                logoutLink.onclick = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    window.logout();
                    return false;
                };
            }
        }, 50);
    };

    // ── 7. Global Helpers ────────────────────────────────────────────────────
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
        window.location.href = '/';
    };

    window.authFetch = (url, options = {}) => window.fetch(url, options);

    // ── 8. Utilities ──────────────────────────────────────────────────────────
    function domReady() {
        return new Promise(resolve => {
            if (document.readyState !== 'loading') resolve();
            else document.addEventListener('DOMContentLoaded', resolve, { once: true });
        });
    }

    // ── 9. Toast Helper ───────────────────────────────────────────────────────
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
