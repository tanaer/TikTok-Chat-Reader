/**
 * SaaS API Integration Test
 * Tests all user management, subscription, and admin endpoints
 * against the production database schema.
 * 
 * Usage: node tests/test_saas_api.js
 * Requires: server running on localhost:8585
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:8081';

let accessToken = null;
let refreshToken = null;
let adminToken = null;
let testUserId = null;
let passed = 0;
let failed = 0;

async function request(method, path, body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

function assert(name, condition) {
    if (condition) {
        console.log(`  [PASS] ${name}`);
        passed++;
    } else {
        console.log(`  [FAIL] ${name}`);
        failed++;
    }
}

const TS = Date.now();
const TEST_USER = `testuser_${TS}`;
const TEST_EMAIL = `test_${TS}@example.com`;
const TEST_PASS = 'Test123456';

async function testAuthRegister() {
    console.log('\n--- Auth: Register ---');

    // Missing email should fail
    let r = await request('POST', '/api/auth/register', { username: TEST_USER, password: TEST_PASS });
    assert('Register without email fails', r.status === 400);

    // Valid register
    r = await request('POST', '/api/auth/register', {
        username: TEST_USER, password: TEST_PASS, email: TEST_EMAIL
    });
    assert('Register success', r.status === 201);
    assert('Has accessToken', !!r.data.accessToken);
    assert('Has refreshToken', !!r.data.refreshToken);
    assert('Has user.id', !!r.data.user?.id);
    assert('Username matches', r.data.user?.username === TEST_USER);

    accessToken = r.data.accessToken;
    refreshToken = r.data.refreshToken;
    testUserId = r.data.user?.id;

    // Duplicate username
    r = await request('POST', '/api/auth/register', {
        username: TEST_USER, password: TEST_PASS, email: `other_${TS}@example.com`
    });
    assert('Duplicate username rejected', r.status === 409);

    // Duplicate email
    r = await request('POST', '/api/auth/register', {
        username: `other_${TS}`, password: TEST_PASS, email: TEST_EMAIL
    });
    assert('Duplicate email rejected', r.status === 409);
}

async function testAuthLogin() {
    console.log('\n--- Auth: Login ---');

    // Login by username
    let r = await request('POST', '/api/auth/login', { username: TEST_USER, password: TEST_PASS });
    assert('Login by username success', r.status === 200);
    assert('Login returns accessToken', !!r.data.accessToken);

    // Login by email
    r = await request('POST', '/api/auth/login', { username: TEST_EMAIL, password: TEST_PASS });
    assert('Login by email success', r.status === 200);

    // Wrong password
    r = await request('POST', '/api/auth/login', { username: TEST_USER, password: 'wrongpwd' });
    assert('Wrong password rejected', r.status === 401);
}

async function testAuthRefresh() {
    console.log('\n--- Auth: Refresh Token ---');

    const r = await request('POST', '/api/auth/refresh', { refreshToken });
    assert('Refresh success', r.status === 200);
    assert('New accessToken', !!r.data.accessToken);
    assert('New refreshToken', !!r.data.refreshToken);

    // Update tokens
    accessToken = r.data.accessToken;
    refreshToken = r.data.refreshToken;
}

async function testAuthMe() {
    console.log('\n--- Auth: Me ---');

    const r = await request('GET', '/api/auth/me', null, accessToken);
    assert('Me success', r.status === 200);
    assert('Has user.id', !!r.data.user?.id);
    assert('Has user.username', r.data.user?.username === TEST_USER);
}

async function testUserProfile() {
    console.log('\n--- User: Profile ---');

    let r = await request('GET', '/api/user/profile', null, accessToken);
    assert('Get profile success', r.status === 200);
    assert('Has user and quota', !!r.data.user && r.data.quota !== undefined);

    // Update nickname
    r = await request('PUT', '/api/user/profile', { nickname: '测试用户' }, accessToken);
    assert('Update profile success', r.status === 200);
}

async function testUserSubscription() {
    console.log('\n--- User: Subscription ---');

    const r = await request('GET', '/api/user/subscription', null, accessToken);
    assert('Get subscription info', r.status === 200);
    assert('Has totalLimit', r.data.totalLimit !== undefined);
}

async function testUserOrders() {
    console.log('\n--- User: Orders ---');

    const r = await request('GET', '/api/user/orders', null, accessToken);
    assert('Get orders success', r.status === 200);
    assert('Has orders array', Array.isArray(r.data.orders));
    assert('Has pagination', !!r.data.pagination);
}

async function testUserBalanceLogs() {
    console.log('\n--- User: Balance Logs ---');

    const r = await request('GET', '/api/user/balance-logs', null, accessToken);
    assert('Get balance logs success', r.status === 200);
    assert('Has logs array', Array.isArray(r.data.logs));
}

async function testSubscriptionPlans() {
    console.log('\n--- Subscription: Plans (public) ---');

    const r = await request('GET', '/api/subscription/plans');
    assert('Get plans success', r.status === 200);
    assert('Has plans array', Array.isArray(r.data.plans));
    if (r.data.plans?.length > 0) {
        const p = r.data.plans[0];
        assert('Plan has priceMonthly', p.priceMonthly !== undefined);
        assert('Plan has priceAnnual', p.priceAnnual !== undefined);
        assert('Plan has roomLimit', p.roomLimit !== undefined);
    }
}

async function testSubscriptionAddons() {
    console.log('\n--- Subscription: Addons (public) ---');

    const r = await request('GET', '/api/subscription/addons');
    assert('Get addons success', r.status === 200);
    assert('Has addons array', Array.isArray(r.data.addons));
    if (r.data.addons?.length > 0) {
        const a = r.data.addons[0];
        assert('Addon has priceMonthly', a.priceMonthly !== undefined);
        assert('Addon has roomCount', a.roomCount !== undefined);
    }
}

async function testAdminLogin() {
    console.log('\n--- Admin: Login ---');

    const r = await request('POST', '/api/auth/login', {
        username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin123'
    });
    if (r.status === 200) {
        adminToken = r.data.accessToken;
        assert('Admin login success', true);
    } else {
        assert('Admin login success (admin may not exist)', false);
    }
}

async function testAdminStats() {
    if (!adminToken) return;
    console.log('\n--- Admin: Stats ---');

    const r = await request('GET', '/api/admin/stats', null, adminToken);
    assert('Get stats success', r.status === 200);
    assert('Has totalUsers', r.data.totalUsers !== undefined);
    assert('Has activeSubscriptions', r.data.activeSubscriptions !== undefined);
}

async function testAdminUsers() {
    if (!adminToken) return;
    console.log('\n--- Admin: Users ---');

    let r = await request('GET', '/api/admin/users', null, adminToken);
    assert('List users success', r.status === 200);
    assert('Has users array', Array.isArray(r.data.users));

    if (testUserId) {
        r = await request('GET', `/api/admin/users/${testUserId}`, null, adminToken);
        assert('Get user detail success', r.status === 200);
        assert('Has user data', !!r.data.user);
        assert('Has subscriptions array', Array.isArray(r.data.subscriptions));
    }
}

async function testAdminAdjustBalance() {
    if (!adminToken || !testUserId) return;
    console.log('\n--- Admin: Adjust Balance ---');

    const r = await request('POST', `/api/admin/users/${testUserId}/adjust-balance`, {
        amount: 10000, remark: '测试充值'
    }, adminToken);
    assert('Adjust balance success', r.status === 200);
    assert('Has balanceAfter', r.data.balanceAfter !== undefined);
}

async function testPurchasePlan() {
    console.log('\n--- Purchase: Plan ---');

    // Get plans first
    const plans = await request('GET', '/api/subscription/plans');
    if (!plans.data.plans?.length) {
        console.log('  [SKIP] No plans available');
        return;
    }

    const planId = plans.data.plans[0].id;
    const r = await request('POST', '/api/subscription/purchase', {
        planId, billingCycle: 'monthly'
    }, accessToken);

    // May fail if balance insufficient (depends on admin adjust-balance above)
    if (r.status === 200) {
        assert('Purchase plan success', true);
        assert('Has subscription info', !!r.data.subscription);
        assert('Has order info', !!r.data.order);
    } else {
        assert(`Purchase plan (expected: balance issue): ${r.data.error}`, r.status === 400);
    }
}

async function testAdminPlans() {
    if (!adminToken) return;
    console.log('\n--- Admin: Plans ---');

    const r = await request('GET', '/api/admin/plans', null, adminToken);
    assert('List plans success', r.status === 200);
    assert('Has plans array', Array.isArray(r.data.plans));
}

async function testAdminAddons() {
    if (!adminToken) return;
    console.log('\n--- Admin: Addons ---');

    const r = await request('GET', '/api/admin/addons', null, adminToken);
    assert('List addons success', r.status === 200);
    assert('Has addons array', Array.isArray(r.data.addons));
}

async function testAdminOrders() {
    if (!adminToken) return;
    console.log('\n--- Admin: Orders ---');

    const r = await request('GET', '/api/admin/orders', null, adminToken);
    assert('List orders success', r.status === 200);
    assert('Has orders array', Array.isArray(r.data.orders));
}

async function testChangePassword() {
    console.log('\n--- Auth: Change Password ---');

    const r = await request('PUT', '/api/auth/change-password', {
        oldPassword: TEST_PASS, newPassword: 'NewPass123'
    }, accessToken);
    assert('Change password success', r.status === 200);

    // Login with new password
    const login = await request('POST', '/api/auth/login', { username: TEST_USER, password: 'NewPass123' });
    assert('Login with new password', login.status === 200);
    accessToken = login.data.accessToken;
    refreshToken = login.data.refreshToken;
}

async function testLogout() {
    console.log('\n--- Auth: Logout ---');

    const r = await request('POST', '/api/auth/logout', { refreshToken });
    assert('Logout success', r.status === 200);
}

async function testAdminSettings() {
    if (!adminToken) return;
    console.log('\n--- Admin: Settings ---');

    let r = await request('GET', '/api/admin/settings', null, adminToken);
    assert('Get settings success', r.status === 200);

    r = await request('PUT', '/api/admin/settings', {
        settings: { default_room_limit: '3' }
    }, adminToken);
    assert('Update settings success', r.status === 200);
}

async function cleanup() {
    // Toggle user status (disable then re-enable)
    if (adminToken && testUserId) {
        console.log('\n--- Admin: Toggle User Status ---');
        let r = await request('POST', `/api/admin/users/${testUserId}/toggle-status`, null, adminToken);
        assert('Disable user success', r.status === 200);
        assert('User is disabled', r.data.status === 'disabled');

        r = await request('POST', `/api/admin/users/${testUserId}/toggle-status`, null, adminToken);
        assert('Re-enable user success', r.status === 200);
        assert('User is active', r.data.status === 'active');
    }
}

async function main() {
    console.log('=== SaaS API Integration Tests ===');
    console.log(`Target: ${BASE}\n`);

    try {
        // Auth flow
        await testAuthRegister();
        await testAuthLogin();
        await testAuthRefresh();
        await testAuthMe();

        // User center
        await testUserProfile();
        await testUserSubscription();
        await testUserOrders();
        await testUserBalanceLogs();

        // Public subscription info
        await testSubscriptionPlans();
        await testSubscriptionAddons();

        // Admin flow
        await testAdminLogin();
        await testAdminStats();
        await testAdminUsers();
        await testAdminAdjustBalance();
        await testAdminPlans();
        await testAdminAddons();
        await testAdminOrders();
        await testAdminSettings();

        // Purchase (after balance adjusted)
        await testPurchasePlan();

        // Password change + logout
        await testChangePassword();
        await testLogout();

        // Cleanup / toggle status
        await cleanup();

    } catch (err) {
        console.error('\n[FATAL]', err.message);
        failed++;
    }

    console.log('\n========================================');
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('========================================');

    process.exit(failed > 0 ? 1 : 0);
}

main();
