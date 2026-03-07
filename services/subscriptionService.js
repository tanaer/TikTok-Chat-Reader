const db = require('../db');
const balanceService = require('./balanceService');
const quotaService = require('./quotaService');

/**
 * Get user's active subscription with plan info
 */
async function getActiveSubscription(userId) {
    return db.get(
        `SELECT us.*, p.name AS plan_name, p.code AS plan_code, p.room_limit AS plan_room_limit,
                p.daily_room_create_limit AS plan_daily_room_create_limit,
                p.feature_flags AS plan_feature_flags, p.sort_order AS plan_sort_order
         FROM user_subscriptions us
         JOIN subscription_plans p ON us.plan_id = p.id
         WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
         ORDER BY us.end_date DESC LIMIT 1`,
        [userId]
    );
}

/**
 * Get user's room quota info
 * room_limit = -1 means unlimited
 */
async function getUserQuota(userId) {
    return quotaService.getUserQuota(userId);
}

/**
 * Purchase a subscription plan
 * Supports: 1) Extending same plan 2) Upgrading with prorated difference
 */
async function purchasePlan(userId, planId, billingCycle) {
    const plan = await db.get(`SELECT * FROM subscription_plans WHERE id = ? AND is_active = true`, [planId]);
    if (!plan) {
        return { success: false, error: '套餐不存在或已下架' };
    }

    let newPrice, durationDays;
    switch (billingCycle) {
        case 'monthly':
            newPrice = Number(plan.priceMonthly);
            durationDays = 30;
            break;
        case 'quarterly':
            newPrice = Number(plan.priceQuarterly);
            durationDays = 90;
            break;
        case 'yearly':
            newPrice = Number(plan.priceAnnual);
            durationDays = 365;
            break;
        default:
            return { success: false, error: '无效的计费周期' };
    }

    const cycleNames = { monthly: '月付', quarterly: '季付', yearly: '年付' };

    // Check for existing active subscription (same or different plan)
    const existingSub = await db.get(
        `SELECT us.*, sp.name AS old_plan_name, sp.room_limit AS old_room_limit,
                sp.price_monthly AS old_price_monthly, sp.price_quarterly AS old_price_quarterly, sp.price_annual AS old_price_annual,
                sp.sort_order AS old_sort_order
         FROM user_subscriptions us
         JOIN subscription_plans sp ON us.plan_id = sp.id
         WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
         ORDER BY us.end_date DESC LIMIT 1`,
        [userId]
    );

    // Block downgrade: if existing plan has higher sort_order than new plan
    if (existingSub && existingSub.planId !== planId) {
        const newSortOrder = Number(plan.sortOrder || 0);
        const oldSortOrder = Number(existingSub.oldSortOrder || 0);
        if (newSortOrder < oldSortOrder) {
            return { success: false, error: '不支持降级套餐，如需降级请联系客服' };
        }
    }

    let finalPrice = newPrice;
    let refundAmount = 0;
    let startDate = new Date();
    let upgradeInfo = null;

    if (existingSub) {
        const now = new Date();
        const endDate = new Date(existingSub.endDate);
        const remainingDays = Math.max(0, Math.ceil((endDate - now) / (24 * 3600 * 1000)));
        const totalDays = Math.ceil((endDate - new Date(existingSub.startDate)) / (24 * 3600 * 1000));

        // Get old plan price based on billing cycle
        let oldPrice;
        switch (existingSub.billingCycle) {
            case 'monthly': oldPrice = Number(existingSub.oldPriceMonthly); break;
            case 'quarterly': oldPrice = Number(existingSub.oldPriceQuarterly); break;
            case 'yearly': oldPrice = Number(existingSub.oldPriceAnnual); break;
            default: oldPrice = Number(existingSub.oldPriceMonthly);
        }

        // Calculate prorated value of remaining subscription
        const dailyRate = totalDays > 0 ? oldPrice / totalDays : 0;
        const remainingValue = Math.round(dailyRate * remainingDays);

        if (existingSub.planId === planId) {
            // Same plan - just extend from end date
            startDate = endDate;
            finalPrice = newPrice;
        } else {
            // Different plan - calculate upgrade/downgrade
            // Refund remaining value, charge new price
            finalPrice = newPrice - remainingValue;
            refundAmount = remainingValue;

            upgradeInfo = {
                oldPlan: existingSub.oldPlanName,
                newPlan: plan.name,
                remainingDays,
                remainingValue,
                priceAdjustment: -remainingValue,
                finalPrice
            };

            // If finalPrice is negative, user gets refund
            // If finalPrice is positive, user pays the difference
        }
    }

    const itemName = upgradeInfo
        ? `${plan.name} - ${cycleNames[billingCycle]} (升级自 ${upgradeInfo.oldPlan})`
        : `${plan.name} - ${cycleNames[billingCycle]}`;

    // Handle the transaction
    let purchase;
    if (finalPrice <= 0) {
        // User gets refund or free upgrade
        if (finalPrice < 0) {
            // Refund the difference
            await balanceService.adjustBalance(
                userId,
                Math.abs(finalPrice),
                'refund',
                `套餐升级退款: ${upgradeInfo.oldPlan} → ${plan.name}`,
                null
            );
        }
        purchase = { success: true, order: { orderNo: 'FREE-' + Date.now(), amount: 0, balanceAfter: null } };
    } else {
        // User pays the difference or full price
        purchase = await balanceService.purchaseWithBalance(
            userId, finalPrice, 'plan', itemName,
            upgradeInfo
                ? `套餐升级: ${upgradeInfo.oldPlan} → ${plan.name}, 原价${newPrice}, 抵扣${refundAmount}, 实付${finalPrice}`
                : `套餐: ${plan.name}, 周期: ${billingCycle}`
        );
        if (!purchase.success) {
            return purchase;
        }
    }

    // Cancel old subscription if exists and different plan
    if (existingSub && existingSub.planId !== planId) {
        await db.run(
            `UPDATE user_subscriptions SET status = 'cancelled', updated_at = NOW()
             WHERE id = ?`,
            [existingSub.id]
        );
    }

    // Calculate start and end date
    if (existingSub && existingSub.planId === planId) {
        // Same plan - extend from end_date
        startDate = new Date(existingSub.endDate);
    } else {
        // New plan or upgrade - start from now
        startDate = new Date();
    }
    const endDate = new Date(startDate.getTime() + durationDays * 24 * 3600 * 1000);

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
            price: finalPrice
        },
        upgrade: upgradeInfo,
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
