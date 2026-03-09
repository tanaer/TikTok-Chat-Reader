const db = require('../db');

function normalizeLimitValue(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNullableLimit(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function isActiveTemporaryOverride(value, expiresAt) {
    if (value === null || value === undefined) return false;
    if (!expiresAt) return false;
    const expiresTime = new Date(expiresAt).getTime();
    return Number.isFinite(expiresTime) && expiresTime > Date.now();
}

function resolveEffectiveLimit(baseLimit, permanentOverride, temporaryOverride, temporaryExpiresAt) {
    const normalizedBase = normalizeLimitValue(baseLimit, 0);
    const normalizedPermanent = normalizeNullableLimit(permanentOverride);
    const normalizedTemporary = normalizeNullableLimit(temporaryOverride);

    if (isActiveTemporaryOverride(normalizedTemporary, temporaryExpiresAt)) {
        return {
            effective: normalizedTemporary,
            source: 'temporary',
            temporaryExpiresAt,
        };
    }

    if (normalizedPermanent !== null) {
        return {
            effective: normalizedPermanent,
            source: 'permanent',
            temporaryExpiresAt: null,
        };
    }

    return {
        effective: normalizedBase,
        source: 'base',
        temporaryExpiresAt: null,
    };
}

async function getActiveSubscription(userId) {
    return db.get(
        `SELECT us.*, p.name AS plan_name, p.code AS plan_code,
                p.room_limit AS plan_room_limit,
                p.daily_room_create_limit AS plan_daily_room_create_limit,
                p.feature_flags AS plan_feature_flags,
                p.sort_order AS plan_sort_order
         FROM user_subscriptions us
         JOIN subscription_plans p ON us.plan_id = p.id
         WHERE us.user_id = ? AND us.status = 'active' AND us.end_date > NOW()
         ORDER BY us.end_date DESC LIMIT 1`,
        [userId]
    );
}

async function getQuotaOverrides(userId) {
    const row = await db.get(
        `SELECT user_id,
                room_limit_permanent,
                room_limit_temporary,
                room_limit_temporary_expires_at,
                daily_room_create_limit_permanent,
                daily_room_create_limit_temporary,
                daily_room_create_limit_temporary_expires_at,
                updated_at
         FROM user_quota_overrides
         WHERE user_id = ?`,
        [userId]
    );

    return row || {
        userId,
        roomLimitPermanent: null,
        roomLimitTemporary: null,
        roomLimitTemporaryExpiresAt: null,
        dailyRoomCreateLimitPermanent: null,
        dailyRoomCreateLimitTemporary: null,
        dailyRoomCreateLimitTemporaryExpiresAt: null,
        updatedAt: null,
    };
}

async function getTodayRoomCreateCount(userId) {
    const countResult = await db.get(
        `SELECT COUNT(*) AS count
         FROM user_room
         WHERE user_id = ?
           AND created_at >= CURRENT_DATE
           AND created_at < CURRENT_DATE + INTERVAL '1 day'`,
        [userId]
    );
    return normalizeLimitValue(countResult?.count, 0);
}

async function getUserQuota(userId) {
    const user = await db.get('SELECT role FROM users WHERE id = ?', [userId]);
    if (user && user.role === 'admin') {
        return {
            subscription: null,
            subRooms: -1,
            addonRooms: 0,
            defaultRooms: 0,
            baseTotalLimit: -1,
            totalLimit: -1,
            limit: -1,
            used: 0,
            remaining: -1,
            isUnlimited: true,
            hasSubscription: true,
            subscriptionEndDate: null,
            baseDailyRoomCreateLimit: -1,
            dailyLimit: -1,
            dailyUsed: 0,
            dailyRemaining: -1,
            quotaOverrides: {
                roomLimit: { base: -1, permanent: null, temporary: null, temporaryExpiresAt: null, effective: -1, source: 'base' },
                dailyCreateLimit: { base: -1, permanent: null, temporary: null, temporaryExpiresAt: null, effective: -1, source: 'base' },
            }
        };
    }

    const sub = await getActiveSubscription(userId);
    const subLimit = sub ? normalizeLimitValue(sub.planRoomLimit, 0) : 0;
    const fallbackGiftDailyRoomCreateLimit = sub && sub.planCode === 'gift' && subLimit > 0 ? subLimit : -1;
    const baseDailyRoomCreateLimit = sub
        ? normalizeLimitValue(sub.planDailyRoomCreateLimit, fallbackGiftDailyRoomCreateLimit)
        : -1;
    const isSubUnlimited = subLimit === -1;
    const hasSubscription = !!sub;

    const addonResult = isSubUnlimited ? { total: 0 } : await db.get(
        `SELECT COALESCE(SUM(rap.room_count), 0) AS total
         FROM user_room_addons ura
         JOIN room_addon_packages rap ON ura.package_id = rap.id
         WHERE ura.user_id = ? AND ura.status = 'active' AND ura.end_date > NOW()`,
        [userId]
    );
    const addonRooms = isSubUnlimited ? 0 : normalizeLimitValue(addonResult?.total, 0);

    const settings = await db.getSystemSettings();
    const defaultRooms = normalizeLimitValue(settings.defaultRoomLimit || settings.default_room_limit, 0);
    const isDefaultUnlimited = defaultRooms === -1;
    const baseTotalLimit = (isSubUnlimited || isDefaultUnlimited) ? -1 : (subLimit + addonRooms + defaultRooms);

    const overrides = await getQuotaOverrides(userId);
    const roomLimitResolved = resolveEffectiveLimit(
        baseTotalLimit,
        overrides.roomLimitPermanent,
        overrides.roomLimitTemporary,
        overrides.roomLimitTemporaryExpiresAt
    );
    const dailyRoomCreateLimitResolved = resolveEffectiveLimit(
        baseDailyRoomCreateLimit,
        overrides.dailyRoomCreateLimitPermanent,
        overrides.dailyRoomCreateLimitTemporary,
        overrides.dailyRoomCreateLimitTemporaryExpiresAt
    );

    const countResult = await db.get(
        `SELECT COUNT(*) AS count FROM user_room WHERE user_id = ? AND deleted_at IS NULL`,
        [userId]
    );
    const used = normalizeLimitValue(countResult?.count, 0);

    const dailyUsed = await getTodayRoomCreateCount(userId);

    const effectiveRoomLimit = roomLimitResolved.effective;
    const effectiveDailyRoomCreateLimit = dailyRoomCreateLimitResolved.effective;
    const isUnlimited = effectiveRoomLimit === -1;
    const isDailyUnlimited = effectiveDailyRoomCreateLimit === -1;

    return {
        subscription: sub,
        subRooms: subLimit,
        addonRooms,
        defaultRooms,
        baseTotalLimit,
        totalLimit: effectiveRoomLimit,
        limit: effectiveRoomLimit,
        used,
        remaining: isUnlimited ? -1 : Math.max(0, effectiveRoomLimit - used),
        isUnlimited,
        hasSubscription,
        subscriptionEndDate: sub?.endDate || null,
        baseDailyRoomCreateLimit,
        dailyLimit: effectiveDailyRoomCreateLimit,
        dailyUsed,
        dailyRemaining: isDailyUnlimited ? -1 : Math.max(0, effectiveDailyRoomCreateLimit - dailyUsed),
        quotaOverrides: {
            roomLimit: {
                base: baseTotalLimit,
                permanent: normalizeNullableLimit(overrides.roomLimitPermanent),
                temporary: normalizeNullableLimit(overrides.roomLimitTemporary),
                temporaryExpiresAt: overrides.roomLimitTemporaryExpiresAt || null,
                effective: effectiveRoomLimit,
                source: roomLimitResolved.source,
            },
            dailyCreateLimit: {
                base: baseDailyRoomCreateLimit,
                permanent: normalizeNullableLimit(overrides.dailyRoomCreateLimitPermanent),
                temporary: normalizeNullableLimit(overrides.dailyRoomCreateLimitTemporary),
                temporaryExpiresAt: overrides.dailyRoomCreateLimitTemporaryExpiresAt || null,
                effective: effectiveDailyRoomCreateLimit,
                source: dailyRoomCreateLimitResolved.source,
            }
        }
    };
}

module.exports = {
    getActiveSubscription,
    getQuotaOverrides,
    getTodayRoomCreateCount,
    getUserQuota,
};
