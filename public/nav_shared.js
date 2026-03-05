/**
 * nav_shared.js — TikTok Monitor Unified Navigation
 *
 * Usage: Include this script in any landing page.
 * It auto-injects a consistent dark glass navbar into #app-navbar.
 *
 * Data attributes:
 *   <html data-nav-active="user-center"> — override active tab detection
 */
(function () {
    'use strict';

    const TOKEN_KEY = 'accessToken';

    const NAV_LINKS = [
        { id: 'home', href: '/landing/index.html', label: '首页', guestOk: true },
        { id: 'monitor', href: '/', label: '监控中心', guestOk: false },
        { id: 'user-center', href: '/landing/user-center.html', label: '用户中心', guestOk: false },
        { id: 'subscription', href: '/landing/subscription.html', label: '套餐订阅', guestOk: true },
    ];

    const ADMIN_LINKS = [
        { id: 'admin', href: '/landing/admin.html', label: '后台管理' }
    ];

    function getActiveId() {
        // Allow explicit override via <html data-nav-active="...">
        const override = document.documentElement.dataset.navActive;
        if (override) return override;

        const path = window.location.pathname;
        if (path === '/' || path === '/index.html') return 'monitor';
        if (path.includes('user-center')) return 'user-center';
        if (path.includes('subscription')) return 'subscription';
        if (path.includes('admin')) return 'admin';
        if (path.includes('index') || path.endsWith('/landing/') || path.endsWith('/landing')) return 'home';
        return '';
    }

    function buildNavLinks(isLoggedIn, isAdmin, activeId) {
        const visible = NAV_LINKS.filter(l => l.guestOk || isLoggedIn);
        const all = isAdmin ? [...visible, ...ADMIN_LINKS] : visible;

        return all.map(l => {
            const active = l.id === activeId ? 'active' : '';
            const adminCls = l.id === 'admin' ? 'text-warning' : '';
            return `<a href="${l.href}" class="nav-link ${active} ${adminCls} btn btn-ghost btn-sm rounded-lg">${l.label}</a>`;
        }).join('');
    }

    function buildNavbar(user) {
        const isLoggedIn = !!user;
        const isAdmin = user?.role === 'admin';
        const activeId = getActiveId();

        const links = buildNavLinks(isLoggedIn, isAdmin, activeId);
        const initial = user ? (user.nickname || user.email || '?')[0].toUpperCase() : '';

        const rightSection = isLoggedIn
            ? `<div id="userMenuSlot"></div>`
            : `<a href="/landing/login.html"    class="btn btn-ghost btn-sm">登录</a>
               <a href="/landing/register.html" class="btn btn-sm gradient-btn text-white">注册</a>`;

        return `
          <nav class="glass-navbar sticky top-0 z-50 w-full">
            <div class="max-w-[1400px] mx-auto px-4 flex items-center h-14 gap-4">
              <!-- Brand -->
              <a href="/landing/index.html" class="flex items-center gap-2 shrink-0 mr-4">
                <span class="text-xl">📺</span>
                <span class="font-extrabold text-base tracking-tight gradient-text-primary">TikTok Monitor</span>
              </a>

              <!-- Nav Links (desktop) -->
              <div class="hidden md:flex items-center gap-1 flex-1">
                ${links}
              </div>

              <!-- Right: User Menu or Auth buttons -->
              <div class="ml-auto flex items-center gap-2">
                ${rightSection}

                <!-- Mobile menu toggle -->
                <button id="mobileMenuBtn" class="btn btn-ghost btn-sm btn-square md:hidden" onclick="toggleMobileMenu()">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- Mobile dropdown -->
            <div id="mobileMenu" class="hidden md:hidden border-t border-white/5 bg-black/40 backdrop-blur-xl px-4 py-3 space-y-1">
              ${buildNavLinks(isLoggedIn, isAdmin, activeId).replace(/btn btn-ghost btn-sm rounded-lg/g, 'block w-full text-left px-4 py-2 rounded-lg opacity-75 hover:opacity-100 hover:bg-white/5 transition-all')}
              ${isLoggedIn ? `<hr class="border-white/10 my-2"><button onclick="window.logout()" class="block w-full text-left px-4 py-2 rounded-lg text-error opacity-80 hover:opacity-100">🚪 退出登录</button>` : ''}
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
                const res = await fetch('/api/auth/me', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (res.ok) user = await res.json();
            } catch { }
        }

        slot.innerHTML = buildNavbar(user);

        // Inject user menu via auth.js helper if logged in
        if (user && typeof window.injectUserMenu === 'function') {
            window.injectUserMenu(user, 'userMenuSlot');
        }

        // If guest visiting a protected page, redirect to login
        // (protected pages should also call initPage() for server-side validation)
        const path = window.location.pathname;
        const protectedPaths = ['/landing/user-center.html', '/landing/subscription.html', '/landing/admin.html'];
        if (!user && protectedPaths.some(p => path.includes(p))) {
            window.location.href = '/landing/login.html';
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
