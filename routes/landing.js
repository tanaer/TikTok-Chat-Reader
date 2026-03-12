const express = require('express');
const db = require('../db');

const router = express.Router();

const LANDING_STATS_CACHE_TTL_MS = 60 * 1000;

let landingStatsCache = null;
let landingStatsCacheExpiresAt = 0;
let landingStatsPendingPromise = null;

async function queryCustomerDataCount() {
    const sequenceRow = await db.get(`
        SELECT COALESCE(last_value, 0)::bigint AS total
        FROM event_id_seq
    `);

    let customerDataCount = Number(sequenceRow?.total || 0);
    if (!Number.isFinite(customerDataCount) || customerDataCount <= 0) {
        const countRow = await db.get('SELECT COUNT(*) AS count FROM event');
        customerDataCount = Number(countRow?.count || 0);
    }

    return Math.max(0, Math.floor(customerDataCount));
}

async function loadLandingStats() {
    const customerDataCount = await queryCustomerDataCount();
    return {
        customerDataCount,
        updatedAt: new Date().toISOString(),
    };
}

router.get('/stats', async (req, res) => {
    try {
        const now = Date.now();
        if (landingStatsCache && landingStatsCacheExpiresAt > now) {
            return res.json(landingStatsCache);
        }

        if (!landingStatsPendingPromise) {
            landingStatsPendingPromise = loadLandingStats()
                .then((payload) => {
                    landingStatsCache = payload;
                    landingStatsCacheExpiresAt = Date.now() + LANDING_STATS_CACHE_TTL_MS;
                    return payload;
                })
                .finally(() => {
                    landingStatsPendingPromise = null;
                });
        }

        return res.json(await landingStatsPendingPromise);
    } catch (err) {
        console.error('[Landing] Stats error:', err.message);
        return res.status(500).json({ error: '获取首页统计失败' });
    }
});

module.exports = router;
