const { get } = require('../db');

const CUSTOMER_FEATURE_VERSION = 'customer-feature.v1';

function toValidDate(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDays(base, deltaDays) {
    const next = new Date(base);
    next.setDate(next.getDate() + deltaDays);
    return next;
}

function safeDivide(numerator, denominator) {
    const left = Number(numerator || 0);
    const right = Number(denominator || 0);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return 0;
    return left / right;
}

function roundNumber(value, digits = 4) {
    if (!Number.isFinite(Number(value))) return 0;
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function daysSince(value, now = new Date()) {
    const parsed = toValidDate(value);
    if (!parsed) return null;
    return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 86400000));
}

function daysBetween(startValue, endValue = new Date()) {
    const start = toValidDate(startValue);
    const end = toValidDate(endValue);
    if (!start || !end) return 0;
    return Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1);
}

function scoreLength(relationshipDays) {
    if (relationshipDays >= 180) return 5;
    if (relationshipDays >= 90) return 4;
    if (relationshipDays >= 30) return 3;
    if (relationshipDays >= 7) return 2;
    return 1;
}

function scoreRecency(inactiveDays) {
    if (inactiveDays === null || inactiveDays === undefined) return 1;
    if (inactiveDays <= 1) return 5;
    if (inactiveDays <= 3) return 4;
    if (inactiveDays <= 7) return 3;
    if (inactiveDays <= 15) return 2;
    return 1;
}

function scoreFrequency(activeDays30d) {
    const activeDays = Number(activeDays30d || 0);
    if (activeDays >= 15) return 5;
    if (activeDays >= 9) return 4;
    if (activeDays >= 5) return 3;
    if (activeDays >= 2) return 2;
    return 1;
}

function scoreMonetary(rank, totalUsers, giftValue) {
    if (Number(giftValue || 0) <= 0) return 1;
    if (!rank || !totalUsers || totalUsers <= 1) return 5;
    const percentile = 1 - ((Number(rank) - 1) / Math.max(Number(totalUsers) - 1, 1));
    if (percentile >= 0.8) return 5;
    if (percentile >= 0.6) return 4;
    if (percentile >= 0.4) return 3;
    if (percentile >= 0.2) return 2;
    return 1;
}

function resolveLrfmTier(totalScore) {
    if (totalScore >= 18) return '核心价值';
    if (totalScore >= 15) return '高价值';
    if (totalScore >= 11) return '重点维护';
    if (totalScore >= 8) return '持续观察';
    return '待唤醒';
}

function buildGiftScopeClause({ roomId = null, roomFilter = null } = {}) {
    if (roomId) {
        return { clause: ' AND room_id = ?', params: [roomId] };
    }
    if (Array.isArray(roomFilter)) {
        if (roomFilter.length === 0) {
            return { clause: ' AND 1 = 0', params: [] };
        }
        const placeholders = roomFilter.map(() => '?').join(',');
        return { clause: ` AND room_id IN (${placeholders})`, params: [...roomFilter] };
    }
    return { clause: '', params: [] };
}

async function getGiftRanking30d({ userId, roomId = null, roomFilter = null, now = new Date() }) {
    const sinceTime = addDays(now, -30);
    const scope = buildGiftScopeClause({ roomId, roomFilter });

    const summary = await get(`
        SELECT COUNT(*) as total_users, COALESCE(SUM(gift_value), 0) as total_value
        FROM (
            SELECT user_id, SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as gift_value
            FROM event
            WHERE type = 'gift' AND user_id IS NOT NULL AND timestamp >= ?${scope.clause}
            GROUP BY user_id
        ) scoped_users
    `, [sinceTime, ...scope.params]);

    const rankedRow = await get(`
        WITH scoped_users AS (
            SELECT user_id, SUM(COALESCE(diamond_count, 0) * COALESCE(repeat_count, 1)) as gift_value
            FROM event
            WHERE type = 'gift' AND user_id IS NOT NULL AND timestamp >= ?${scope.clause}
            GROUP BY user_id
        ), ranked_users AS (
            SELECT
                user_id,
                gift_value,
                ROW_NUMBER() OVER (ORDER BY gift_value DESC, user_id ASC) as gift_rank,
                COUNT(*) OVER () as total_users,
                SUM(gift_value) OVER () as total_value,
                SUM(gift_value) OVER (ORDER BY gift_value DESC, user_id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as cumulative_value
            FROM scoped_users
        )
        SELECT user_id, gift_value, gift_rank, total_users, total_value, cumulative_value
        FROM ranked_users
        WHERE user_id = ?
        LIMIT 1
    `, [sinceTime, ...scope.params, userId]);

    return {
        rank: rankedRow?.giftRank ? Number(rankedRow.giftRank) : null,
        totalUsers: Number(rankedRow?.totalUsers || summary?.totalUsers || 0),
        giftValue: Number(rankedRow?.giftValue || 0),
        totalValue: Number(rankedRow?.totalValue || summary?.totalValue || 0),
        cumulativeValue: Number(rankedRow?.cumulativeValue || 0)
    };
}

function buildLrfmModel({ scopeLabel, relationshipDays, inactiveDays, activeDays30d, giftRanking, giftValue30d }) {
    const lScore = scoreLength(relationshipDays);
    const rScore = scoreRecency(inactiveDays);
    const fScore = scoreFrequency(activeDays30d);
    const mScore = scoreMonetary(giftRanking.rank, giftRanking.totalUsers, giftValue30d);
    const totalScore = lScore + rScore + fScore + mScore;

    return {
        scope: scopeLabel,
        l_score: lScore,
        r_score: rScore,
        f_score: fScore,
        m_score: mScore,
        score_code: `L${lScore}R${rScore}F${fScore}M${mScore}`,
        total_score: totalScore,
        tier: resolveLrfmTier(totalScore),
        relationship_days: relationshipDays,
        inactive_days: inactiveDays,
        active_days_30d: Number(activeDays30d || 0),
        gift_value_30d: Number(giftValue30d || 0),
        gift_rank_30d: giftRanking.rank,
        ranked_users_30d: giftRanking.totalUsers
    };
}

function buildClvModel({ currentRoomMetrics30d, allRoomsMetrics30d, inactiveDays }) {
    const giftValue30d = Number(currentRoomMetrics30d?.gift_value || 0);
    const activeDays30d = Number(currentRoomMetrics30d?.active_days || 0);
    const currentRoomShare30d = safeDivide(giftValue30d, Number(allRoomsMetrics30d?.gift_value || 0));

    let recencyFactor = 0.65;
    if (inactiveDays !== null && inactiveDays !== undefined) {
        if (inactiveDays <= 1) recencyFactor = 1.15;
        else if (inactiveDays <= 3) recencyFactor = 1.08;
        else if (inactiveDays <= 7) recencyFactor = 1;
        else if (inactiveDays <= 14) recencyFactor = 0.88;
        else if (inactiveDays <= 30) recencyFactor = 0.75;
    }

    const activityFactor = 0.8 + Math.min(activeDays30d, 10) * 0.05;
    const loyaltyFactor = 0.85 + Math.min(currentRoomShare30d, 1) * 0.35;
    const value = giftValue30d > 0
        ? Math.round(giftValue30d * activityFactor * recencyFactor * loyaltyFactor)
        : 0;

    return {
        value,
        formula_version: 'clv-current-room-30d.v1',
        gift_value_30d: giftValue30d,
        active_days_30d: activeDays30d,
        inactive_days: inactiveDays,
        current_room_value_share_30d: roundNumber(currentRoomShare30d, 4),
        activity_factor: roundNumber(activityFactor, 4),
        recency_factor: roundNumber(recencyFactor, 4),
        loyalty_factor: roundNumber(loyaltyFactor, 4)
    };
}

function buildAbcModel({ giftRanking }) {
    const giftValue = Number(giftRanking.giftValue || 0);
    const totalValue = Number(giftRanking.totalValue || 0);
    const contributionShare = safeDivide(giftValue, totalValue);
    const cumulativeShare = safeDivide(Number(giftRanking.cumulativeValue || 0), totalValue);

    let tier = 'C';
    if (giftValue > 0) {
        if (cumulativeShare <= 0.8) tier = 'A';
        else if (cumulativeShare <= 0.95) tier = 'B';
    }

    return {
        tier,
        gift_value_30d: giftValue,
        rank_30d: giftRanking.rank,
        ranked_users_30d: giftRanking.totalUsers,
        contribution_share_30d: roundNumber(contributionShare, 4),
        cumulative_contribution_share_30d: roundNumber(cumulativeShare, 4)
    };
}

async function buildCustomerFeatures({
    userId,
    currentRoomId = null,
    roomFilter = null,
    metricCube = {},
    now = new Date()
} = {}) {
    const currentRoomAllTime = metricCube?.current_room?.all_time || {};
    const currentRoom30d = metricCube?.current_room?.['30d'] || {};
    const allRoomsAllTime = metricCube?.all_rooms?.all_time || {};
    const allRooms30d = metricCube?.all_rooms?.['30d'] || {};

    const roomRelationshipDays = daysBetween(currentRoomAllTime.first_active_at, now);
    const platformRelationshipDays = daysBetween(allRoomsAllTime.first_active_at, now);
    const roomInactiveDays = daysSince(currentRoomAllTime.last_active_at, now);
    const platformInactiveDays = daysSince(allRoomsAllTime.last_active_at, now);

    const currentRoomRanking30d = currentRoomId
        ? await getGiftRanking30d({ userId, roomId: currentRoomId, now })
        : { rank: null, totalUsers: 0, giftValue: 0, totalValue: 0, cumulativeValue: 0 };
    const platformRanking30d = await getGiftRanking30d({ userId, roomFilter, now });

    const roomLrfm = buildLrfmModel({
        scopeLabel: 'current_room',
        relationshipDays: roomRelationshipDays,
        inactiveDays: roomInactiveDays,
        activeDays30d: currentRoom30d.active_days,
        giftRanking: currentRoomRanking30d,
        giftValue30d: currentRoom30d.gift_value
    });

    const platformLrfm = buildLrfmModel({
        scopeLabel: 'all_rooms',
        relationshipDays: platformRelationshipDays,
        inactiveDays: platformInactiveDays,
        activeDays30d: allRooms30d.active_days,
        giftRanking: platformRanking30d,
        giftValue30d: allRooms30d.gift_value
    });

    return {
        version: CUSTOMER_FEATURE_VERSION,
        models: {
            room_lrfm: roomLrfm,
            platform_lrfm: platformLrfm,
            clv_current_room_30d: buildClvModel({
                currentRoomMetrics30d: currentRoom30d,
                allRoomsMetrics30d: allRooms30d,
                inactiveDays: roomInactiveDays
            }),
            abc_current_room: buildAbcModel({ giftRanking: currentRoomRanking30d })
        },
        rankings: {
            currentRoomGiftRank30d: currentRoomRanking30d.rank,
            currentRoomGiftRankedUsers30d: currentRoomRanking30d.totalUsers,
            platformGiftRank30d: platformRanking30d.rank,
            platformGiftRankedUsers30d: platformRanking30d.totalUsers
        }
    };
}

module.exports = {
    CUSTOMER_FEATURE_VERSION,
    buildCustomerFeatures
};
