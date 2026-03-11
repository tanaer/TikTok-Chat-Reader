const db = require('../db');
const balanceService = require('./balanceService');
const quotaService = require('./quotaService');

const ADDON_ALLOWED_PLAN_CODES = new Set(['enterprise']);
const BILLING_CYCLE_DAYS = Object.freeze({
    monthly: 30,
    quarterly: 90,
    yearly: 365,
});
const BILLING_CYCLE_LABELS = Object.freeze({
    monthly: '月付',
    quarterly: '季付',
    yearly: '年付',
});

function getBillingCycleDays(billingCycle) {
    return BILLING_CYCLE_DAYS[billingCycle] || 0;
}

function getAddonPriceByBillingCycle(addon, billingCycle) {
    switch (billingCycle) {
        case 'monthly':
            return Number(addon.priceMonthly);
        case 'quarterly':
            return Number(addon.priceQuarterly);
        case 'yearly':
            return Number(addon.priceAnnual);
        default:
            return NaN;
    }
}

function getRemainingDays(endDate, now = new Date()) {
    const target = new Date(endDate);
    const endTime = target.getTime();
    if (!Number.isFinite(endTime)) return 0;
    const diff = endTime - now.getTime();
    if (diff <= 0) return 0;
    return Math.max(1, Math.ceil(diff / (24 * 3600 * 1000)));
}

function isAddonPlanEligible(subscription) {
    const planCode = String(subscription?.planCode || '').trim().toLowerCase();
    return ADDON_ALLOWED_PLAN_CODES.has(planCode);
}

function previewAddonPurchase(addon, subscription, now = new Date()) {
    if (!subscription) {
        return { ok: false, error: '请先开通企业版会员后再购买扩容包' };
    }

    if (!isAddonPlanEligible(subscription)) {
        return { ok: false, error: '仅企业版会员可购买扩容包' };
    }

    const billingCycle = String(subscription.billingCycle || '').trim().toLowerCase();
    const cycleDays = getBillingCycleDays(billingCycle);
    if (!cycleDays) {
        return { ok: false, error: '当前会员周期暂不支持购买扩容包' };
    }

    const referencePrice = getAddonPriceByBillingCycle(addon, billingCycle);
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
        return { ok: false, error: '当前扩容包未配置对应会员周期价格' };
    }

    const remainingDays = getRemainingDays(subscription.endDate, now);
    if (remainingDays <= 0) {
        return { ok: false, error: '当前会员已到期，无法购买扩容包' };
    }

    const price = Math.max(1, Math.round(referencePrice * (remainingDays / cycleDays)));
    const subscriptionEndDate = new Date(subscription.endDate);

    return {
        ok: true,
        billingCycle,
        billingCycleLabel: BILLING_CYCLE_LABELS[billingCycle] || billingCycle,
        referencePrice,
        cycleDays,
        remainingDays,
        price,
        startDate: now.toISOString(),
        endDate: subscriptionEndDate.toISOString(),
    };
}

function normalizeAddonPurchaseLimit(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
}

async function getAddonPurchaseCount(userId, addonId) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM user_room_addons
         WHERE user_id = ? AND package_id = ?`,
        [userId, addonId]
    );
    return Number(row?.total || 0);
}

async function enrichAddonPurchasePreview(addon, subscription, userId) {
    const preview = previewAddonPurchase(addon, subscription);
    const purchaseLimit = normalizeAddonPurchaseLimit(addon?.perUserPurchaseLimit);

    if (!userId || !purchaseLimit) {
        return {
            ...preview,
            purchaseLimit,
            purchaseCount: null,
            remainingPurchases: purchaseLimit,
        };
    }

    const purchaseCount = await getAddonPurchaseCount(userId, addon.id);
    const remainingPurchases = Math.max(0, purchaseLimit - purchaseCount);
    if (remainingPurchases <= 0) {
        return {
            ok: false,
            error: `该扩容包单账户最多可购买 ${purchaseLimit} 次`,
            purchaseLimit,
            purchaseCount,
            remainingPurchases: 0,
        };
    }

    return {
        ...preview,
        purchaseLimit,
        purchaseCount,
        remainingPurchases,
    };
}

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
         WHERE us.user_id = ?
           AND us.status = 'active'
           AND us.start_date <= NOW()
           AND us.end_date > NOW()
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
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
        return { success: false, error: '该套餐周期暂不可购买' };
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

    await db.run(
        `UPDATE user_room_addons
         SET status = 'expired'
         WHERE user_id = ?
           AND status = 'active'
           AND end_date <= NOW()`,
        [userId]
    );

    const subscription = await getActiveSubscription(userId);
    const addonPreview = await enrichAddonPurchasePreview(addon, subscription, userId);
    if (!addonPreview.ok) {
        return { success: false, error: addonPreview.error };
    }

    const itemName = addon.name;

    const purchase = await balanceService.purchaseWithBalance(
        userId,
        addonPreview.price,
        'addon',
        itemName,
        `扩容包: ${addon.name}, +${addon.roomCount}房间, 跟随当前会员至 ${new Date(addonPreview.endDate).toLocaleDateString('zh-CN')}, 剩余${addonPreview.remainingDays}天`
    );
    if (!purchase.success) {
        return purchase;
    }

    await db.run(
        `INSERT INTO user_room_addons (user_id, package_id, order_no, billing_cycle, start_date, end_date, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [userId, addonId, purchase.order.orderNo, addonPreview.billingCycle, addonPreview.startDate, addonPreview.endDate]
    );

    return {
        success: true,
        addon: {
            name: addon.name,
            roomCount: addon.roomCount,
            price: addonPreview.price,
            billingCycle: addonPreview.billingCycle,
            remainingDays: addonPreview.remainingDays,
            endDate: addonPreview.endDate,
            followsSubscription: true,
            purchaseLimit: addonPreview.purchaseLimit,
            remainingPurchases: addonPreview.remainingPurchases,
        },
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
    expireOverdueSubscriptions,
    previewAddonPurchase,
    enrichAddonPurchasePreview,
    isAddonPlanEligible,
};
