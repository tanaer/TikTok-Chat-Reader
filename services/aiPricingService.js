const db = require('../db');

const AI_POINT_SCENES = Object.freeze({
    SESSION_RECAP: 'session_recap',
    CUSTOMER_ANALYSIS: 'customer_analysis',
    USER_PERSONALITY: 'user_personality',
});

const AI_POINT_SETTING_KEYS = Object.freeze({
    [AI_POINT_SCENES.SESSION_RECAP]: 'session_recap_ai_points',
    [AI_POINT_SCENES.CUSTOMER_ANALYSIS]: 'customer_analysis_ai_points',
    [AI_POINT_SCENES.USER_PERSONALITY]: 'user_personality_ai_points',
});

const DEFAULT_AI_POINT_COSTS = Object.freeze({
    [AI_POINT_SCENES.SESSION_RECAP]: 10,
    [AI_POINT_SCENES.CUSTOMER_ANALYSIS]: 3,
    [AI_POINT_SCENES.USER_PERSONALITY]: 1,
});

function normalizeAiPointCost(value, fallback = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return Math.max(0, Number(fallback || 0));
    return Math.max(0, Math.floor(numeric));
}

async function getAiPointCost(scene) {
    const settingKey = AI_POINT_SETTING_KEYS[scene];
    const fallback = DEFAULT_AI_POINT_COSTS[scene] ?? 0;
    if (!settingKey) return normalizeAiPointCost(null, fallback);

    try {
        const row = await db.get('SELECT value FROM settings WHERE key = ? LIMIT 1', [settingKey]);
        return normalizeAiPointCost(row?.value, fallback);
    } catch (err) {
        console.error(`[AI Pricing] Load point cost failed for ${scene}:`, err.message);
        return normalizeAiPointCost(null, fallback);
    }
}

module.exports = {
    AI_POINT_SCENES,
    AI_POINT_SETTING_KEYS,
    DEFAULT_AI_POINT_COSTS,
    normalizeAiPointCost,
    getAiPointCost,
};
