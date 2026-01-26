/**
 * Auth Check - Verify user is logged in before showing dashboard
 * Also handles role-based UI visibility (admin vs user)
 */
(function () {
    const accessToken = localStorage.getItem('accessToken');

    // If no access token, redirect to landing/login
    if (!accessToken) {
        console.log('[Auth] No access token found, redirecting to login...');
        window.location.href = '/landing/login.html';
        return;
    }

    // Verify token is valid by calling /api/auth/me
    fetch('/api/auth/me', {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Token invalid');
            }
            return response.json();
        })
        .then(user => {
            console.log('[Auth] User authenticated:', user.email);
            // Store user info for later use
            window.currentUser = user;
            // Add user to navbar
            addUserMenu(user);
            // Handle role-based UI
            setupRoleBasedUI(user);
        })
        .catch(err => {
            console.log('[Auth] Token validation failed:', err.message);
            // Try to refresh token
            const refreshToken = localStorage.getItem('refreshToken');
            if (refreshToken) {
                refreshAccessToken(refreshToken);
            } else {
                redirectToLogin();
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
                addUserMenu(data.user);
                setupRoleBasedUI(data.user);
            })
            .catch(() => {
                redirectToLogin();
            });
    }

    function redirectToLogin() {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/landing/login.html';
    }

    function addUserMenu(user) {
        const navbar = document.querySelector('.navbar .flex-none .menu');
        if (!navbar) return;

        const isAdmin = user.role === 'admin';

        // Add user dropdown to navbar
        const userMenu = document.createElement('li');
        userMenu.className = 'dropdown dropdown-end';
        userMenu.innerHTML = `
            <div tabindex="0" role="button" class="btn btn-ghost">
                <div class="avatar placeholder">
                    <div class="bg-primary text-primary-content rounded-full w-8">
                        <span>${(user.nickname || user.email)[0].toUpperCase()}</span>
                    </div>
                </div>
                <span class="hidden md:inline ml-2">${user.nickname || user.email}</span>
                ${isAdmin ? '<span class="badge badge-warning badge-sm ml-1">管理员</span>' : ''}
            </div>
            <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box z-50 w-52 p-2 shadow-lg mt-2">
                <li class="menu-title"><span>账户</span></li>
                <li><a href="/landing/subscription.html">💎 我的订阅</a></li>
                <li><a href="/landing/profile.html">👤 个人资料</a></li>
                ${isAdmin ? '<li class="divider"></li><li class="menu-title"><span>管理员</span></li><li><a href="/admin.html">🔧 系统管理</a></li>' : ''}
                <li class="divider"></li>
                <li><a onclick="logout()" class="text-error">🚪 退出登录</a></li>
            </ul>
        `;
        navbar.appendChild(userMenu);
    }

    /**
     * Setup role-based UI visibility
     * Hides system config for non-admin users
     */
    function setupRoleBasedUI(user) {
        const isAdmin = user.role === 'admin';

        // Hide system config nav button for non-admins
        const systemConfigBtn = document.querySelector('.nav-btn[onclick*="systemConfig"]');
        if (systemConfigBtn) {
            if (!isAdmin) {
                systemConfigBtn.parentElement.style.display = 'none';
            }
        }

        // Hide system config section content
        const systemConfigSection = document.getElementById('section-systemConfig');
        if (systemConfigSection && !isAdmin) {
            systemConfigSection.innerHTML = `
                <div class="alert alert-warning">
                    <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>系统配置仅限管理员访问</span>
                </div>
            `;
        }

        // Store role for other scripts to use
        window.isAdmin = isAdmin;
    }

    // Global logout function
    window.logout = function () {
        const refreshToken = localStorage.getItem('refreshToken');

        fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        }).finally(() => {
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
            window.location.href = '/landing/';
        });
    };

    // Helper to add auth header to API requests
    window.authFetch = function (url, options = {}) {
        const token = localStorage.getItem('accessToken');
        if (!options.headers) options.headers = {};
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }
        return fetch(url, options);
    };

    // Auto-inject auth headers for jQuery AJAX requests
    if (typeof $ !== 'undefined' && $.ajaxPrefilter) {
        $.ajaxPrefilter(function (options, originalOptions, jqXHR) {
            const token = localStorage.getItem('accessToken');
            if (token && options.url && options.url.startsWith('/api/')) {
                jqXHR.setRequestHeader('Authorization', `Bearer ${token}`);
            }
        });
        console.log('[Auth] jQuery AJAX auth header injection enabled');
    }
})();
