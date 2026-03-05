/**
 * nav_shared.js — TikTok Monitor Unified Navigation
 *
 * Injected into all public/landing pages via <div id="app-navbar"></div>.
 * Dynamically shows links based on auth status + role.
 *
 * - Guest:      Logo | 首页 | [立即开始] [登录]
 * - Logged in:  Logo | 首页 | 监控中心 | 用户中心 | [user menu]
 * - Admin:      Logo | 首页 | 监控中心 | 用户中心 | 后台管理 | [user menu]
 *
 * Set active tab: <html data-nav-active="home|monitor|user-center|admin">
 */
(function () {
    'use strict';

    const TOKEN_KEY = 'accessToken';

    // All possible nav items — filtered based on auth state
    const NAV_LINKS = [
        { id: 'home', href: '/', label: '🏠 首页', auth: 'guest' },
        { id: 'monitor', href: '/app', label: '📺 监控中心', auth: 'user' },
        { id: 'user-center', href: '/landing/user-center.html', label: '👤 用户中心', auth: 'user' },
        { id: 'admin', href: '/landing/admin.html', label: '⚙️ 管理后台', auth: 'admin' },
    ];

    function getActiveId() {
        const override = document.documentElement.dataset.navActive;
        if (override) return override;
        const p = window.location.pathname;
        if (p === '/' || p.includes('/landing/index')) return 'home';
        if (p === '/app' || p === '/index.html') return 'monitor';
        if (p.includes('user-center')) return 'user-center';
        if (p.includes('admin')) return 'admin';
        return '';
    }

    function buildLinks(isLoggedIn, isAdmin, activeId) {
        return NAV_LINKS
            .filter(l => {
                if (l.auth === 'guest') return true;
                if (l.auth === 'user') return isLoggedIn;
                if (l.auth === 'admin') return isAdmin;
                return false;
            })
            .map(l => {
                const active = l.id === activeId ? 'active' : '';
                const adminCls = l.id === 'admin' ? 'text-warning' : '';
                return `<a href="${l.href}" class="nav-link ${active} ${adminCls} btn btn-ghost btn-sm rounded-lg">${l.label}</a>`;
            }).join('');
    }

    function buildMobileLinks(isLoggedIn, isAdmin, activeId) {
        const cls = 'block w-full text-left px-4 py-2.5 rounded-lg opacity-75 hover:opacity-100 hover:bg-white/5 transition-all text-sm';
        return NAV_LINKS
            .filter(l => {
                if (l.auth === 'guest') return true;
                if (l.auth === 'user') return isLoggedIn;
                if (l.auth === 'admin') return isAdmin;
                return false;
            })
            .map(l => `<a href="${l.href}" class="${cls} ${l.id === activeId ? 'text-primary font-bold' : ''}">${l.label}</a>`)
            .join('');
    }

    function buildNavbar(user) {
        const isLoggedIn = !!user;
        const isAdmin = user?.role === 'admin';
        const activeId = getActiveId();
        const links = buildLinks(isLoggedIn, isAdmin, activeId);

        // Right side: if logged in show user menu placeholder, else show CTA buttons
        const rightSection = isLoggedIn
            ? `<div id="userMenuSlot"></div>`
            : `<div class="flex items-center gap-2">
                 <a href="/landing/login.html"    class="btn btn-ghost btn-sm rounded-lg opacity-70">登录</a>
                 <a href="/landing/register.html" class="btn btn-sm gradient-btn text-white rounded-lg px-4">立即开始</a>
               </div>`;

        return `
          <nav class="glass-navbar sticky top-0 z-50 w-full">
            <div class="max-w-[1400px] mx-auto px-4 flex items-center h-14 gap-4">
              <!-- Brand -->
              <a href="/" class="flex items-center gap-2 shrink-0 mr-2">
                <span class="text-xl">📺</span>
                <span class="font-extrabold text-base tracking-tight gradient-text-primary hidden sm:inline">TikTok Monitor</span>
              </a>

              <!-- Nav Links (desktop) -->
              <div class="hidden md:flex items-center gap-1 flex-1">
                ${links}
              </div>

              <!-- Right section -->
              <div class="ml-auto flex items-center gap-2">
                ${rightSection}
                <!-- Mobile toggle -->
                <button id="mobileMenuBtn" class="btn btn-ghost btn-sm btn-square md:hidden" onclick="window.toggleMobileMenu()">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- Mobile dropdown -->
            <div id="mobileMenu" class="hidden md:hidden border-t border-white/5 bg-black/40 backdrop-blur-xl px-4 py-3 space-y-1">
              ${buildMobileLinks(isLoggedIn, isAdmin, activeId)}
              ${isLoggedIn ? `<hr class="border-white/10 my-2"><button onclick="window.logout()" class="block w-full text-left px-4 py-2 rounded-lg text-error opacity-80 hover:opacity-100 text-sm">🚪 退出登录</button>` : ''}
            </div>
          </nav>
        `;
    }

    window.toggleMobileMenu = function () {
        const menu = document.getElementById('mobileMenu');
        if (menu) menu.classList.toggle('hidden');
    };

    async function init() {
        const slot = document.getElementById('app-navbar');
        if (!slot) return;

        const token = localStorage.getItem(TOKEN_KEY);
        let user = null;

        if (token) {
            try {
                // Use the already-intercepted fetch from auth.js (token injected automatically)
                const res = await fetch('/api/auth/me');
                if (res.ok) user = await res.json();
            } catch { }
        }

        slot.innerHTML = buildNavbar(user);

        // Delegate user menu rendering to auth.js after nav is in DOM
        if (user && typeof window.injectUserMenu === 'function') {
            window.injectUserMenu(user, 'userMenuSlot');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
