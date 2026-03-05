/**
 * Auth Check - Universal auth gate for all authenticated pages
 * Include as FIRST script in <head> to block page content until auth succeeds
 */
(function () {
    const accessToken = localStorage.getItem('accessToken');

    // If no access token, redirect to landing page immediately
    if (!accessToken) {
        window.location.href = '/landing/';
        return;
    }

    // Verify token is valid by calling /api/auth/me
    fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    })
        .then(response => {
            if (!response.ok) throw new Error('Token invalid');
            return response.json();
        })
        .then(user => {
            console.log('[Auth] Authenticated:', user.email);
            window.currentUser = user;
            window.isAdmin = user.role === 'admin';

            // Reveal page content (body starts hidden)
            document.addEventListener('DOMContentLoaded', () => {
                document.body.style.display = '';
                addUserMenu(user);
                setupRoleBasedUI(user);
            });

            // If DOM already loaded
            if (document.readyState !== 'loading') {
                document.body.style.display = '';
                addUserMenu(user);
                setupRoleBasedUI(user);
            }
            checkQuota(accessToken);
        })
        .catch(err => {
            console.log('[Auth] Token validation failed:', err.message);
            const refreshToken = localStorage.getItem('refreshToken');
            if (refreshToken) {
                refreshAccessToken(refreshToken);
            } else {
                redirectToLanding();
            }
        });

    function refreshAccessToken(refreshToken) {
        fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        })
            .then(response => {
                if (!response.ok) throw new Error('Refresh failed');
                return response.json();
            })
            .then(data => {
                localStorage.setItem('accessToken', data.accessToken);
                localStorage.setItem('refreshToken', data.refreshToken);
                window.currentUser = data.user;
                window.isAdmin = data.user.role === 'admin';

                document.addEventListener('DOMContentLoaded', () => {
                    document.body.style.display = '';
                    addUserMenu(data.user);
                    setupRoleBasedUI(data.user);
                });
                if (document.readyState !== 'loading') {
                    document.body.style.display = '';
                    addUserMenu(data.user);
                    setupRoleBasedUI(data.user);
                }
                checkQuota(data.accessToken);
            })
            .catch(() => redirectToLanding());
    }

    function redirectToLanding() {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/landing/';
    }

    function checkQuota(token) {
        fetch('/api/subscription', { headers: { 'Authorization': `Bearer ${token}` } })
            .then(r => r.ok ? r.json() : null)
            .then(sub => {
                const overlay = document.getElementById('quotaGateOverlay');
                // Admins bypass quota gate usually, but script runs server side checks anyway. We block UI strictly just for UX gating.
                if (!window.isAdmin && overlay && (!sub || !sub.plan || sub.plan.code === 'free' || sub.daysRemaining < 0)) {
                    overlay.classList.remove('opacity-0', 'pointer-events-none');
                    overlay.classList.add('opacity-100', 'pointer-events-auto');
                    const card = document.getElementById('quotaGateCard');
                    if (card) {
                        card.classList.remove('scale-95');
                        card.classList.add('scale-100');
                    }
                }
            })
            .catch(console.error);
    }

    function addUserMenu(user) {
        const navbar = document.querySelector('.navbar .flex-none .menu');
        if (!navbar) return;

        // Prevent duplicate injection
        if (navbar.querySelector('.user-dropdown')) return;

        const isAdmin = user.role === 'admin';

        const adminMenuItems = isAdmin ? `
                <li class="divider"></li>
                <li class="menu-title"><span>管理</span></li>
                <li><a href="/landing/admin.html#users">用户管理</a></li>
                <li><a href="/landing/admin.html#orders">充值订单</a></li>
                <li><a href="/landing/admin.html#plans">套餐管理</a></li>
        ` : '';

        const userMenu = document.createElement('li');
        userMenu.className = 'dropdown dropdown-end user-dropdown';
        userMenu.innerHTML = `
            <div tabindex="0" role="button" class="btn btn-ghost gap-2">
                <div class="avatar placeholder">
                    <div class="bg-primary text-primary-content rounded-full w-8">
                        <span>${(user.nickname || user.email)[0].toUpperCase()}</span>
                    </div>
                </div>
                <span class="hidden md:inline text-sm">${user.nickname || user.email}</span>
                ${isAdmin ? '<span class="badge badge-warning badge-sm">Admin</span>' : ''}
            </div>
            <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box z-50 w-52 p-2 shadow-xl mt-2 border border-base-content/5">
                <li class="menu-title"><span>账户</span></li>
                <li><a href="/landing/user-center.html">用户中心</a></li>
                <li><a href="/landing/pricing.html">套餐定价</a></li>
                <li><a href="/landing/profile.html">个人设置</a></li>
                ${adminMenuItems}
                <li class="divider"></li>
                <li><a onclick="logout()" class="text-error">退出登录</a></li>
            </ul>
        `;
        navbar.appendChild(userMenu);
    }

    function setupRoleBasedUI(user) {
        const isAdmin = user.role === 'admin';

        // Hide admin-only nav tabs for non-admins
        if (!isAdmin) {
            // System config
            const systemConfigBtn = document.querySelector('.nav-btn[onclick*="systemConfig"]');
            if (systemConfigBtn) systemConfigBtn.parentElement.style.display = 'none';

            const systemConfigSection = document.getElementById('section-systemConfig');
            if (systemConfigSection) systemConfigSection.innerHTML = '<div class="alert alert-warning"><span>仅限管理员访问</span></div>';

            // Recording
            const recordingBtn = document.querySelector('.nav-btn[onclick*="recording"]');
            if (recordingBtn) recordingBtn.parentElement.style.display = 'none';

            const recordingSection = document.getElementById('section-recording');
            if (recordingSection) recordingSection.innerHTML = '<div class="alert alert-warning"><span>仅限管理员访问</span></div>';

            // Remove granular admin-only elements completely from DOM
            document.querySelectorAll('.admin-only').forEach(el => el.remove());
        }
    }

    // Global functions
    window.logout = function () {
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

    // Auth fetch helper for all pages
    window.authFetch = function (url, options = {}) {
        const token = localStorage.getItem('accessToken');
        if (!options.headers) options.headers = {};
        if (token) options.headers['Authorization'] = `Bearer ${token}`;
        return fetch(url, options).then(res => {
            if (res.status === 401) {
                redirectToLanding();
                return null;
            }
            return res;
        });
    };

    // Auto-inject auth headers for jQuery AJAX
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof $ !== 'undefined' && $.ajaxPrefilter) {
            $.ajaxPrefilter(function (options, originalOptions, jqXHR) {
                const token = localStorage.getItem('accessToken');
                if (token && options.url && options.url.startsWith('/api/')) {
                    jqXHR.setRequestHeader('Authorization', `Bearer ${token}`);
                }
            });
        }

        // Setup jQuery global error handler for 401s 
        if (typeof $ !== 'undefined') {
            $(document).ajaxError(function (event, jqXHR) {
                if (jqXHR.status === 401) {
                    redirectToLanding();
                }
            });
        }
    });
})();
