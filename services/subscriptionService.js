const db = require('../db');
const balanceService = require('./balanceService');

/**
 * Get user's active subscription with plan info
 */
async function getActiveSubscription(userId) {
    return db.get(
        `SELECT us.*, p.name AS plan_name, p.code AS plan_code, p.room_limit AS plan_room_limit
         FROM user_subscriptions us
         JOIN subscription_plans p ON us.plan_id = p.id
         WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
         ORDER BY us.end_date DESC LIMIT 1`,
        [userId]
    );
}

/**
 * Get user's room quota info
 */
async function getUserQuota(userId) {
    const sub = await getActiveSubscription(userId);
    const subLimit = sub ? Number(sub.planRoomLimit) : 0;

    const addonResult = await db.get(
        `SELECT COALESCE(SUM(rap.room_count), 0) AS total
         FROM user_room_addons ura
         JOIN room_addon_packages rap ON ura.package_id = rap.id
         WHERE ura.user_id = ? AND ura.status = 'active' AND ura.end_date > NOW()`,
        [userId]
    );
    const addonRooms = Number(addonResult?.total || 0);

    const settings = await db.getSystemSettings();
    const defaultLimit = Number(settings.default_room_limit || 0);

    const totalLimit = subLimit + addonRooms + defaultLimit;

    const countResult = await db.get(
        `SELECT COUNT(*) AS count FROM user_room WHERE user_id = ?`,
        [userId]
    );
    const used = Number(countResult?.count || 0);

    return {
        subscription: sub,
        subRooms: subLimit,
        addonRooms,
        defaultRooms: defaultLimit,
        totalLimit,
        used,
        remaining: totalLimit - used
    };
}

/**
 * Purchase a subscription plan
 */
async function purchasePlan(userId, planId, billingCycle) {
    const plan = await db.get(`SELECT * FROM subscription_plans WHERE id = ? AND is_active = true`, [planId]);
    if (!plan) {
        return { success: false, error: '套餐不存在或已下架' };
    }

    let price, durationDays;
    switch (billingCycle) {
        case 'monthly':
            price = Number(plan.priceMonthly);
            durationDays = 30;
            break;
        case 'quarterly':
            price = Number(plan.priceQuarterly);
            durationDays = 90;
            break;
        case 'yearly':
            price = Number(plan.priceAnnual);
            durationDays = 365;
            break;
        default:
            return { success: false, error: '无效的计费周期' };
    }

    const cycleNames = { monthly: '月付', quarterly: '季付', yearly: '年付' };
    const itemName = `${plan.name} - ${cycleNames[billingCycle]}`;

    // Purchase with balance
    const purchase = await balanceService.purchaseWithBalance(
        userId, price, 'plan', itemName, `套餐: ${plan.name}, 周期: ${billingCycle}`
    );
    if (!purchase.success) {
        return purchase;
    }

    // Calculate subscription period
    // If user has active subscription of same plan, extend from end_date
    const existingSub = await db.get(
        `SELECT end_date FROM user_subscriptions
         WHERE user_id = ? AND plan_id = ? AND status = 'active' AND end_date > NOW()`,
        [userId, planId]
    );

    const startDate = existingSub ? new Date(existingSub.endDate) : new Date();
    const endDate = new Date(startDate.getTime() + durationDays * 24 * 3600 * 1000);

    // If upgrading from a different plan, expire old subscriptions
    if (!existingSub) {
        await db.run(
            `UPDATE user_subscriptions SET status = 'cancelled'
             WHERE user_id = ? AND status = 'active' AND end_date > NOW()`,
            [userId]
        );
    }

    // Create subscription
    await db.run(
        `INSERT INTO user_subscriptions (user_id, plan_id, billing_cycle, start_date, end_date, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [userId, planId, billingCycle, startDate.toISOString(), endDate.toISOString()]
    );

    return {
        success: true,
        subscription: {
            planName: plan.name,
            billingCycle,
            roomLimit: plan.roomLimit,
            startDate,
            endDate,
            price
        },
        order: purchase.order
    };
}

/**
 * Purchase an addon package
 */
async function purchaseAddon(userId, addonId, billingCycle = 'monthly') {
    const addon = await db.get(`SELECT * FROM room_addon_packages WHERE id = ? AND is_active = true`, [addonId]);
    if (!addon) {
        return { success: false, error: '扩容包不存在或已下架' };
    }

    let price, durationDays;
    switch (billingCycle) {
        case 'monthly':
            price = Number(addon.priceMonthly);
            durationDays = 30;
            break;
        case 'quarterly':
            price = Number(addon.priceQuarterly);
            durationDays = 90;
            break;
        case 'yearly':
            price = Number(addon.priceAnnual);
            durationDays = 365;
            break;
        default:
            return { success: false, error: '无效的计费周期' };
    }

    const itemName = addon.name;

    const purchase = await balanceService.purchaseWithBalance(
        userId, price, 'addon', itemName, `扩容包: ${addon.name}, +${addon.roomCount}房间, ${billingCycle}`
    );
    if (!purchase.success) {
        return purchase;
    }

    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + durationDays * 24 * 3600 * 1000);

    await db.run(
        `INSERT INTO user_room_addons (user_id, package_id, order_no, billing_cycle, start_date, end_date, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [userId, addonId, purchase.order.orderNo, billingCycle, startDate.toISOString(), endDate.toISOString()]
    );

    return {
        success: true,
        addon: { name: addon.name, roomCount: addon.roomCount, price, billingCycle },
        order: purchase.order
    };
}

/**
 * Expire overdue subscriptions
 */
async function expireOverdueSubscriptions() {
    const result = await db.run(
        `UPDATE user_subscriptions SET status = 'expired'
         WHERE status = 'active' AND end_date < NOW()`
    );
    return result;
}

module.exports = {
    getActiveSubscription,
    getUserQuota,
    purchasePlan,
    purchaseAddon,
    expireOverdueSubscriptions
};
