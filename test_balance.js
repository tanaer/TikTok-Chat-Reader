const { initDb, query, run } = require('./db');

async function testBalanceSystem() {
    await initDb();
    console.log('[Test] DB initialized');

    // Make sure 'basic' plan exists for the test
    const existingPlan = await query("SELECT id FROM subscription_plans WHERE code = 'basic'");
    if (existingPlan.length === 0) {
        await run(`INSERT INTO subscription_plans (name, code, price_monthly, price_quarterly, price_annual, is_active, sort_order) 
                   VALUES ('Basic', 'basic', 2900, 7400, 25900, true, 1)`);
        console.log('[Test] Seeded basic plan data');
    }

    // 1. Create a test user
    const email = 'test_balance_' + Math.floor(Math.random() * 10000) + '@example.com';
    const userId = (await query('INSERT INTO users (email, password_hash, status, balance) VALUES ($1, $2, $3, $4) RETURNING id', [email, 'xxx', 'active', 0]))[0].id;
    console.log(`[Test] Created user ${userId}`);

    try {
        // 2. Add balance (simulate recharge)
        await run('UPDATE users SET balance = balance + 5000 WHERE id = $1', [userId]);
        await run(`INSERT INTO balance_log (user_id, type, amount, balance_after, description) VALUES ($1, 'recharge', 5000, 5000, 'Test Recharge')`, [userId]);

        let user = (await query('SELECT balance FROM users WHERE id = $1', [userId]))[0];
        console.log(`[Test] Recharged 5000. Current balance: ${user.balance}`);

        // 3. Purchase a plan
        const plan = (await query("SELECT id, price_monthly FROM subscription_plans WHERE code = 'basic'"))[0];
        const cost = plan.priceMonthly; // db.js converts it to camelCase automatically

        await run('UPDATE users SET balance = balance - $1 WHERE id = $2', [cost, userId]);
        await run(`INSERT INTO balance_log (user_id, type, amount, balance_after) VALUES ($1, 'purchase', $2, $3)`, [userId, -cost, 5000 - cost]);

        user = (await query('SELECT balance FROM users WHERE id = $1', [userId]))[0];
        console.log(`[Test] Purchased plan for ${cost}. Current balance: ${user.balance}. Expected: ${5000 - cost}`);

        if (user.balance !== 5000 - cost) {
            throw new Error(`[Fail] Balance mismatch. Expected ${5000 - cost}, got ${user.balance}`);
        } else {
            console.log(`[Test] Success: Balance logic is correct.`);
        }

    } finally {
        // Cleanup
        await run('DELETE FROM balance_log WHERE user_id = $1', [userId]);
        await run('DELETE FROM users WHERE id = $1', [userId]);
        console.log(`[Test] Cleaned up user ${userId}`);
    }
}

testBalanceSystem().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
