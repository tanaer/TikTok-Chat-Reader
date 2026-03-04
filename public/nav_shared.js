/**
 * Shared Navigation - Unified navbar for all landing pages
 * Include this script + call injectNavbar() on each page
 */
(function () {
    const token = localStorage.getItem('accessToken');

    // Check auth for landing pages - redirect if no token on protected pages
    function checkLandingAuth() {
        const publicPages = ['/landing/', '/landing/index.html', '/landing/login.html', '/landing/register.html', '/landing/pricing.html'];
        const currentPath = window.location.pathname;
        const isPublic = publicPages.some(p => currentPath === p || currentPath.endsWith(p));

        if (!token && !isPublic) {
            window.location.href = '/landing/login.html';
            return false;
        }
        return true;
    }

    // Build navbar HTML
    function buildNavbar(activePage) {
        const isLoggedIn = !!token;

        let user = null;
        try {
            // Try to decode JWT to get user info without API call
            const payload = token ? JSON.parse(atob(token.split('.')[1])) : null;
            if (payload) user = { email: payload.email || '', role: payload.role || 'user', nickname: payload.nickname || '' };
        } catch (e) { /* ignore */ }

        const isAdmin = user?.role === 'admin';
        const displayName = user?.nickname || user?.email || '';
        const initial = displayName ? displayName[0].toUpperCase() : '?';

        // Nav items
        const navItems = [
            { href: '/', label: '监控中心', icon: '📺', auth: true },
            { href: '/landing/user-center.html', label: '用户中心', icon: '', auth: true, id: 'user-center' },
            { href: '/landing/pricing.html', label: '套餐定价', icon: '', auth: false, id: 'pricing' },
            { href: '/landing/profile.html', label: '个人设置', icon: '', auth: true, id: 'profile' },
        ];

        const adminItems = isAdmin ? [
            { href: '/landing/admin.html#users', label: '用户管理', icon: '', auth: true, id: 'admin' },
            { href: '/landing/admin.html#orders', label: '充值订单', icon: '', auth: true, id: 'admin-orders' },
        ] : [];

        return `
        <div class="navbar bg-base-100/60 backdrop-blur-md sticky top-0 z-50 border-b border-base-content/5 px-6">
            <div class="flex-1">
                <a href="${isLoggedIn ? '/' : '/landing/'}" class="btn btn-ghost text-lg font-bold tracking-tight gap-2">
                    <span class="text-primary">TikTok Monitor</span>
                </a>
            </div>
            <div class="flex-none gap-1 hidden md:flex">
                ${isLoggedIn ? navItems.filter(i => !i.auth || isLoggedIn).map(i =>
            `<a href="${i.href}" class="btn btn-ghost btn-sm text-sm ${activePage === i.id ? 'text-primary' : 'text-base-content/70'}">${i.icon ? i.icon + ' ' : ''}${i.label}</a>`
        ).join('') : ''}
                ${isLoggedIn && isAdmin ? '<div class="divider divider-horizontal mx-0 h-6 self-center"></div>' : ''}
                ${adminItems.map(i =>
            `<a href="${i.href}" class="btn btn-ghost btn-sm text-sm text-base-content/70">${i.label}</a>`
        ).join('')}
                ${isLoggedIn ? `
                    <div class="dropdown dropdown-end ml-2">
                        <div tabindex="0" role="button" class="btn btn-ghost btn-sm gap-2">
                            <div class="avatar placeholder">
                                <div class="bg-primary text-primary-content rounded-full w-7">
                                    <span class="text-xs">${initial}</span>
                                </div>
                            </div>
                            <span class="text-sm">${displayName}</span>
                            ${isAdmin ? '<span class="badge badge-warning badge-xs">Admin</span>' : ''}
                        </div>
                        <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box z-50 w-48 p-2 shadow-xl mt-2 border border-base-content/5">
                            <li><a onclick="doSharedLogout()" class="text-error text-sm">退出登录</a></li>
                        </ul>
                    </div>
                ` : `
                    <a href="/landing/login.html" class="btn btn-ghost btn-sm text-sm">登录</a>
                    <a href="/landing/register.html" class="btn btn-primary btn-sm text-sm">注册</a>
                `}
            </div>
            <div class="flex-none md:hidden dropdown dropdown-end">
                <label tabindex="0" class="btn btn-ghost btn-circle btn-sm">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                </label>
                <ul tabindex="0" class="menu menu-sm dropdown-content mt-3 z-50 p-2 shadow-xl bg-base-100 rounded-box w-52 border border-base-content/5">
                    ${isLoggedIn ? navItems.filter(i => !i.auth || isLoggedIn).map(i =>
            `<li><a href="${i.href}">${i.icon ? i.icon + ' ' : ''}${i.label}</a></li>`
        ).join('') : ''}
                    ${adminItems.length > 0 ? '<li class="menu-title"><span>管理</span></li>' : ''}
                    ${adminItems.map(i => `<li><a href="${i.href}">${i.label}</a></li>`).join('')}
                    <li class="divider"></li>
                    ${isLoggedIn
                ? '<li><a onclick="doSharedLogout()" class="text-error">退出登录</a></li>'
                : '<li><a href="/landing/login.html">登录</a></li><li><a href="/landing/register.html">注册</a></li>'
            }
                </ul>
            </div>
        </div>`;
    }

    // Global logout function
    window.doSharedLogout = function () {
        const rt = localStorage.getItem('refreshToken');
        fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: rt })
        }).catch(() => null).finally(() => {
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
            window.location.href = '/landing/';
        });
    };

    // Inject navbar into page
    window.injectNavbar = function (activePage) {
        if (!checkLandingAuth()) return;

        const container = document.getElementById('app-navbar');
        if (container) {
            container.innerHTML = buildNavbar(activePage);
        }
    };

    // Auto-inject on DOMContentLoaded if container exists
    document.addEventListener('DOMContentLoaded', () => {
        const container = document.getElementById('app-navbar');
        if (container && !container.innerHTML.trim()) {
            // Detect active page from URL
            const path = window.location.pathname;
            let active = '';
            if (path.includes('user-center')) active = 'user-center';
            else if (path.includes('pricing')) active = 'pricing';
            else if (path.includes('profile')) active = 'profile';
            else if (path.includes('admin')) active = 'admin';
            container.innerHTML = buildNavbar(active);
        }
    });

    // Shared authFetch for landing pages
    window.authFetch = window.authFetch || function (url, options = {}) {
        const t = localStorage.getItem('accessToken');
        if (!options.headers) options.headers = {};
        if (t) options.headers['Authorization'] = `Bearer ${t}`;
        return fetch(url, options).then(res => {
            if (res.status === 401) {
                localStorage.removeItem('accessToken');
                localStorage.removeItem('refreshToken');
                window.location.href = '/landing/login.html';
                return null;
            }
            return res;
        });
    };
})();
