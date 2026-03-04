/**
 * Cron Jobs - Automated background tasks
 * 1. Subscription expiry enforcement (hourly)
 * 2. Auto-renewal (daily 2:00 AM)
 * 3. Expiry warning notifications (daily 9:00 AM)
 */
const db = require('./db');

const CYCLE_DAYS = { monthly: 30, quarterly: 90, annual: 365 };

/**
 * Start all cron jobs
 */
function startCronJobs() {
    console.log('[Cron] Starting background jobs...');

    // 1. Expiry check every hour
    setInterval(() => {
        enforceExpiry().catch(err => console.error('[Cron] Expiry enforcement failed:', err));
    }, 60 * 60 * 1000);

    // Run once on startup (delayed 10s to let DB init)
    setTimeout(() => {
        enforceExpiry().catch(err => console.error('[Cron] Initial expiry check failed:', err));
    }, 10000);

    // 2. Auto-renew check every 6 hours
    setInterval(() => {
        processAutoRenewals().catch(err => console.error('[Cron] Auto-renew failed:', err));
    }, 6 * 60 * 60 * 1000);

    // 3. Expiry warnings every 12 hours
    setInterval(() => {
        sendExpiryWarnings().catch(err => console.error('[Cron] Expiry warnings failed:', err));
    }, 12 * 60 * 60 * 1000);

    // Run warnings once on startup (delayed 30s)
    setTimeout(() => {
        sendExpiryWarnings().catch(err => console.error('[Cron] Initial warning check failed:', err));
    }, 30000);

    console.log('[Cron] Background jobs started: expiry(1h), auto-renew(6h), warnings(12h)');
}

/**
 * 1. Enforce subscription & addon expiry
 * - Mark expired subscriptions as 'expired'
 * - Mark expired addons as 'expired'
 * - Disable excess rooms for users who lost capacity
 */
async function enforceExpiry() {
    console.log('[Cron] Running expiry enforcement...');

    // 1a. Expire subscriptions
    const expiredSubs = await db.query(`
        UPDATE user_subscriptions 
        SET status = 'expired', updated_at = NOW()
        WHERE status = 'active' AND end_date < NOW()
        RETURNING user_id, plan_id
    `);

    if (expiredSubs.length > 0) {
        console.log(`[Cron] Expired ${expiredSubs.length} subscriptions`);
    }

    // 1b. Expire addons
    const expiredAddons = await db.query(`
        UPDATE user_room_addons 
        SET status = 'expired', updated_at = NOW()
        WHERE status = 'active' AND end_date < NOW()
        RETURNING user_id, package_id
    `);

    if (expiredAddons.length > 0) {
        console.log(`[Cron] Expired ${expiredAddons.length} room addons`);
    }

    // 1c. Collect affected user IDs
    const affectedUserIds = new Set();
    for (const s of expiredSubs) affectedUserIds.add(s.userId);
    for (const a of expiredAddons) affectedUserIds.add(a.userId);

    // 1d. For each affected user, check room limits
    for (const userId of affectedUserIds) {
        await enforceRoomLimit(userId);
    }

    if (affectedUserIds.size > 0) {
        console.log(`[Cron] Checked room limits for ${affectedUserIds.size} users`);
    }
}

/**
 * Enforce room limit for a single user
 * Disables excess rooms (newest first) if over limit
 */
async function enforceRoomLimit(userId) {
    // Get current plan limit
    const sub = await db.get(`
        SELECT sp.room_limit 
        FROM user_subscriptions us
        JOIN subscription_plans sp ON us.plan_id = sp.id
        WHERE us.user_id = $1 AND us.status = 'active' AND us.end_date > NOW()
        ORDER BY us.end_date DESC LIMIT 1
    `, [userId]);

    // Get addon rooms
    const addonResult = await db.get(`
        SELECT COALESCE(SUM(rap.room_count), 0) as addon_rooms
        FROM user_room_addons ura
        JOIN room_addon_packages rap ON ura.package_id = rap.id
        WHERE ura.user_id = $1 AND ura.status = 'active' AND ura.end_date > NOW()
    `, [userId]);

    const planLimit = sub?.roomLimit ?? 0;
    const addonRooms = parseInt(addonResult?.addonRooms || 0);
    const totalLimit = planLimit === -1 ? -1 : planLimit + addonRooms;

    if (totalLimit === -1) return; // Unlimited

    // Count current enabled rooms
    const countResult = await db.get(
        'SELECT COUNT(*) as cnt FROM user_room WHERE user_id = $1 AND is_enabled = TRUE',
        [userId]
    );
    const currentEnabled = parseInt(countResult?.cnt || 0);

    if (currentEnabled <= totalLimit) return; // Within limit

    // Disable excess rooms (newest first)
    const excess = currentEnabled - totalLimit;
    const roomsToDisable = await db.query(`
        SELECT id, room_id FROM user_room 
        WHERE user_id = $1 AND is_enabled = TRUE
        ORDER BY created_at DESC
        LIMIT $2
    `, [userId, excess]);

    for (const room of roomsToDisable) {
        await db.run('UPDATE user_room SET is_enabled = FALSE, updated_at = NOW() WHERE id = $1', [room.id]);
    }

    // Notify user
    if (roomsToDisable.length > 0) {
        const disabledNames = roomsToDisable.map(r => r.roomId).join(', ');
        await db.run(`
            INSERT INTO notifications (user_id, type, title, content)
            VALUES ($1, 'room_disabled', '房间已停用', $2)
        `, [userId, `您的套餐已到期或降级，以下房间已被自动停用：${disabledNames}。当前限额 ${totalLimit} 间，请升级套餐恢复监控。`]);

        console.log(`[Cron] User ${userId}: disabled ${roomsToDisable.length} excess rooms (limit: ${totalLimit})`);
    }
}

/**
 * 2. Process auto-renewals
 * Scans subscriptions expiring within 24h with auto_renew = true
 */
async function processAutoRenewals() {
    console.log('[Cron] Processing auto-renewals...');

    const candidates = await db.query(`
        SELECT us.id as sub_id, us.user_id, us.plan_id, us.billing_cycle, us.end_date,
               sp.code as plan_code, sp.name as plan_name,
               sp.price_monthly, sp.price_quarterly, sp.price_annual,
               u.balance
        FROM user_subscriptions us
        JOIN subscription_plans sp ON us.plan_id = sp.id
        JOIN users u ON us.user_id = u.id
        WHERE us.status = 'active' 
          AND us.auto_renew = true
          AND us.end_date < NOW() + INTERVAL '24 hours'
          AND us.end_date > NOW() - INTERVAL '7 days'
    `);

    let renewed = 0, failed = 0;

    for (const c of candidates) {
        const cycle = c.billingCycle;
        let price;
        if (cycle === 'monthly') price = c.priceMonthly;
        else if (cycle === 'quarterly') price = c.priceQuarterly;
        else if (cycle === 'annual') price = c.priceAnnual;
        else continue; // Unknown cycle (e.g., 'admin', 'free')

        if (!price || price <= 0) continue;

        if (c.balance >= price) {
            // Sufficient balance - auto renew
            const intervalStr = cycle === 'monthly' ? '1 month' : cycle === 'quarterly' ? '3 months' : '1 year';
            const cycleNames = { monthly: '月付', quarterly: '季付', annual: '年付' };
            const orderNo = `RENEW-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
            const newBalance = c.balance - price;

            // Deduct balance
            await db.run('UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, c.userId]);

            // Log balance change
            await db.run(`
                INSERT INTO balance_log (user_id, type, amount, balance_after, description, ref_order_no)
                VALUES ($1, 'purchase', $2, $3, $4, $5)
            `, [c.userId, -price, newBalance, `自动续费${c.planName}(${cycleNames[cycle]})`, orderNo]);

            // Create payment record
            await db.run(`
                INSERT INTO payment_records (user_id, order_no, amount, currency, payment_method, status, paid_at, metadata)
                VALUES ($1, $2, $3, 'CNY', 'balance', 'paid', NOW(), $4)
            `, [c.userId, orderNo, price, JSON.stringify({
                type: 'auto_renew', plan_code: c.planCode, plan_name: c.planName, billing_cycle: cycle
            })]);

            // Extend subscription
            await db.run(`
                UPDATE user_subscriptions 
                SET end_date = end_date + INTERVAL '${intervalStr}', updated_at = NOW()
                WHERE id = $1
            `, [c.subId]);

            // Notify success
            await db.run(`
                INSERT INTO notifications (user_id, type, title, content)
                VALUES ($1, 'auto_renew_success', '自动续费成功', $2)
            `, [c.userId, `已自动续费${c.planName}(${cycleNames[cycle]})，扣款 ¥${(price / 100).toFixed(2)}，剩余余额 ¥${(newBalance / 100).toFixed(2)}`]);

            renewed++;
            console.log(`[Cron] Auto-renewed user ${c.userId}: ${c.planCode} ${cycle}, cost ${price}`);
        } else {
            // Insufficient balance
            await db.run(`
                INSERT INTO notifications (user_id, type, title, content)
                VALUES ($1, 'auto_renew_fail', '自动续费失败', $2)
            `, [c.userId, `余额不足，无法自动续费${c.planName}。需要 ¥${(price / 100).toFixed(2)}，当前余额 ¥${(c.balance / 100).toFixed(2)}。请及时充值以避免服务中断。`]);

            failed++;
            console.log(`[Cron] Auto-renew failed for user ${c.userId}: insufficient balance (need ${price}, have ${c.balance})`);
        }
    }

    if (renewed > 0 || failed > 0) {
        console.log(`[Cron] Auto-renewal complete: ${renewed} renewed, ${failed} failed`);
    }
}

/**
 * 3. Send expiry warning notifications
 * Notifies users whose subscriptions expire within 3 days
 */
async function sendExpiryWarnings() {
    console.log('[Cron] Checking for expiry warnings...');

    // Users with subscriptions expiring in 3 days (and haven't been warned recently)
    const expiring = await db.query(`
        SELECT us.user_id, us.end_date, us.auto_renew, us.billing_cycle,
               sp.name as plan_name, sp.price_monthly, sp.price_quarterly, sp.price_annual,
               u.balance
        FROM user_subscriptions us
        JOIN subscription_plans sp ON us.plan_id = sp.id
        JOIN users u ON us.user_id = u.id
        WHERE us.status = 'active'
          AND us.end_date > NOW()
          AND us.end_date < NOW() + INTERVAL '3 days'
          AND NOT EXISTS (
              SELECT 1 FROM notifications n 
              WHERE n.user_id = us.user_id 
                AND n.type = 'expiry_warning'
                AND n.created_at > NOW() - INTERVAL '2 days'
          )
    `);

    for (const e of expiring) {
        const daysLeft = Math.ceil((new Date(e.endDate) - new Date()) / (1000 * 60 * 60 * 24));
        const cycle = e.billingCycle;
        let renewPrice = 0;
        if (cycle === 'monthly') renewPrice = e.priceMonthly;
        else if (cycle === 'quarterly') renewPrice = e.priceQuarterly;
        else if (cycle === 'annual') renewPrice = e.priceAnnual;

        let content = `您的${e.planName}将在 ${daysLeft} 天后到期。`;
        if (e.autoRenew && e.balance >= renewPrice) {
            content += `已开启自动续费，届时将自动扣款 ¥${(renewPrice / 100).toFixed(2)}。`;
        } else if (e.autoRenew && e.balance < renewPrice) {
            content += `已开启自动续费，但余额不足（需 ¥${(renewPrice / 100).toFixed(2)}，余额 ¥${(e.balance / 100).toFixed(2)}），请及时充值。`;
        } else {
            content += `未开启自动续费，到期后监控将停止，请及时续费。`;
        }

        await db.run(`
            INSERT INTO notifications (user_id, type, title, content)
            VALUES ($1, 'expiry_warning', '套餐即将到期', $2)
        `, [e.userId, content]);
    }

    if (expiring.length > 0) {
        console.log(`[Cron] Sent ${expiring.length} expiry warnings`);
    }
}

module.exports = { startCronJobs, enforceExpiry, processAutoRenewals, sendExpiryWarnings, enforceRoomLimit };
