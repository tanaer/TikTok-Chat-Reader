const db = require('../db');

const PROMPT_TEMPLATE_PREFIX = 'prompt_template.';

const PROMPT_TEMPLATES = {
    session_recap_comment_filter: {
        key: 'session_recap_comment_filter',
        title: 'AI直播复盘 · 高频弹幕筛选',
        description: '先对全场高频弹幕 Top50 做价值筛选，只保留对内容复盘、成交判断、节奏判断有用的信号。',
        variables: ['topCommentCandidatesJson'],
        defaultContent: [
            '你现在是直播运营复盘助手。',
            '下面会给你一场直播的高频弹幕 TOP50（按出现频次倒序）。',
            '',
            '你的任务：',
            '1. 只保留对直播复盘“有实际价值”的弹幕。',
            '2. 有价值的标准包括：用户需求、产品兴趣、购买意愿、价格异议、内容反馈、节奏反馈、情绪变化、主播表现反馈、转化障碍、流失信号。',
            '3. 删除纯灌水、表情刷屏、无意义重复、单纯路过、与直播内容无关的内容。',
            '',
            '输出必须是严格 JSON，不要加任何说明，不要加 Markdown，不要加代码块。',
            'JSON 结构必须是：',
            '{',
            '  "valuableComments": [',
            '    {',
            '      "text": "原始弹幕内容",',
            '      "count": 12,',
            '      "category": "需求/成交/价格/节奏/情绪/产品/主播表现/流失/其他",',
            '      "reason": "为什么这条弹幕对复盘有价值",',
            '      "insight": "它反映了什么用户信号"',
            '    }',
            '  ]',
            '}',
            '',
            '约束：',
            '- 最多返回 15 条，按复盘价值从高到低排序。',
            '- text 必须直接使用输入里的原文，不要改写。',
            '- count 必须使用输入里的频次。',
            '- 如果没有足够有价值的内容，返回空数组。',
            '',
            '输入数据：',
            '{{topCommentCandidatesJson}}'
        ].join('\n')
    },
    session_recap_review: {
        key: 'session_recap_review',
        title: 'AI直播复盘 · 主分析流程',
        description: '根据单场直播结构化数据，生成完整 AI 直播复盘，并映射到前台各区域。',
        variables: ['sessionDataJson'],
        defaultContent: [
            '你是资深直播运营总监，擅长给老板和运营团队写单场直播复盘。',
            '你必须专业、犀利、敢说真话，但不能脱离输入数据乱编。',
            '',
            '要求：',
            '1. 所有结论都必须能在输入数据里找到证据。',
            '2. 如果某个指标没有提供，比如 GMV、留存率、分享率、关注增长，不允许编造；可以明确说明“当前未提供该项数据”。',
            '3. 建议必须可执行，最好主播或运营拿去就能做。',
            '4. 输出内容要适合填充到产品页面的不同区域。',
            '',
            '请先按照下面的复盘结构思考，但最终必须只输出严格 JSON：',
            '1. 本场两点',
            '2. 主要问题',
            '3. 下一步建议',
            '4. 核心价值客户',
            '5. 潜力转化客户',
            '6. 流失风险客户',
            '7. 给老板看的本场摘要',
            '8. 本场评分',
            '9. 本场标签',
            '',
            '输出必须是严格 JSON，不要加任何引言，不要加 Markdown，不要加代码块。',
            'JSON 结构必须严格如下：',
            '{',
            '  "summary": "给老板看的本场摘要，150字以内",',
            '  "bossSummary": "给老板看的本场摘要，150字以内",',
            '  "highlights": ["本场两点1", "本场两点2"],',
            '  "issues": ["问题1", "问题2", "问题3"],',
            '  "actions": ["建议1", "建议2", "建议3"],',
            '  "coreCustomers": [',
            '    {',
            '      "nickname": "昵称",',
            '      "totalGiftValue": 0,',
            '      "giftCount": 0,',
            '      "keyBehavior": "关键行为描述",',
            '      "maintenanceSuggestion": "维护建议"',
            '    }',
            '  ],',
            '  "potentialCustomers": [',
            '    {',
            '      "nickname": "昵称",',
            '      "totalGiftValue": 0,',
            '      "giftCount": 0,',
            '      "keyBehavior": "关键行为描述",',
            '      "maintenanceSuggestion": "维护建议",',
            '      "conversionScript": "1-2句针对性转化话术模板"',
            '    }',
            '  ],',
            '  "riskCustomers": [',
            '    {',
            '      "nickname": "昵称",',
            '      "enterTime": "进房时间",',
            '      "leaveTime": "离开时间",',
            '      "keyBehavior": "关键行为/弹幕",',
            '      "riskReason": "流失原因推断",',
            '      "recoveryStrategy": "挽回策略"',
            '    }',
            '  ],',
            '  "valuableComments": [',
            '    {',
            '      "text": "高价值弹幕",',
            '      "count": 0,',
            '      "reason": "保留原因",',
            '      "insight": "对复盘的意义"',
            '    }',
            '  ],',
            '  "score": {',
            '    "total": 0,',
            '    "contentAttraction": 0,',
            '    "userInteraction": 0,',
            '    "giftConversion": 0,',
            '    "retentionGrowth": 0,',
            '    "overallRhythm": 0,',
            '    "reason": "一句话总结评分理由"',
            '  },',
            '  "tags": ["#标签1", "#标签2", "#标签3"]',
            '}',
            '',
            '补充约束：',
            '- highlights 固定返回 2 条。',
            '- issues 返回 3-5 条，按严重程度排序。',
            '- actions 返回 3-5 条，每条都要包含“怎么做 + 预期效果 + 资源准备”。',
            '- coreCustomers / potentialCustomers / riskCustomers 各返回 5-8 条；如果数据不够，可以少于 5 条，但不要凑数。',
            '- tags 返回 3-5 个，必须以 # 开头，一针见血。',
            '- score.total 必须是 0-100 的整数。',
            '- score.contentAttraction 范围 0-20。',
            '- score.userInteraction 范围 0-20。',
            '- score.giftConversion 范围 0-35。',
            '- score.retentionGrowth 范围 0-15。',
            '- score.overallRhythm 范围 0-10。',
            '- 分项分数之和必须等于 total。',
            '- 不要输出空对象；没有数据就输出空数组或简洁说明。',
            '',
            '输入数据如下：',
            '{{sessionDataJson}}'
        ].join('\n')
    }
};

function getPromptTemplateSettingKey(key) {
    return `${PROMPT_TEMPLATE_PREFIX}${key}`;
}

function getPromptTemplateDefinition(key) {
    return PROMPT_TEMPLATES[key] || null;
}

function listPromptTemplateDefinitions() {
    return Object.values(PROMPT_TEMPLATES);
}

async function listPromptTemplates() {
    const definitions = listPromptTemplateDefinitions();
    const settingKeys = definitions.map(item => getPromptTemplateSettingKey(item.key));
    const result = await db.pool.query(
        'SELECT key, value, updated_at FROM settings WHERE key = ANY($1::text[])',
        [settingKeys]
    );
    const rowMap = new Map(result.rows.map(row => [row.key, row]));

    return definitions.map(item => {
        const row = rowMap.get(getPromptTemplateSettingKey(item.key));
        return {
            key: item.key,
            title: item.title,
            description: item.description,
            variables: item.variables,
            content: row?.value || item.defaultContent,
            defaultContent: item.defaultContent,
            isCustomized: Boolean(row),
            updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null
        };
    });
}

async function getPromptTemplate(key) {
    const definition = getPromptTemplateDefinition(key);
    if (!definition) return null;

    const row = await db.pool.query(
        'SELECT value, updated_at FROM settings WHERE key = $1 LIMIT 1',
        [getPromptTemplateSettingKey(key)]
    );
    const current = row.rows[0] || null;

    return {
        key: definition.key,
        title: definition.title,
        description: definition.description,
        variables: definition.variables,
        content: current?.value || definition.defaultContent,
        defaultContent: definition.defaultContent,
        isCustomized: Boolean(current),
        updatedAt: current?.updated_at ? new Date(current.updated_at).toISOString() : null
    };
}

async function savePromptTemplate(key, content) {
    const definition = getPromptTemplateDefinition(key);
    if (!definition) return null;

    await db.pool.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [getPromptTemplateSettingKey(key), String(content || '')]
    );

    return getPromptTemplate(key);
}

async function resetPromptTemplate(key) {
    const definition = getPromptTemplateDefinition(key);
    if (!definition) return null;
    return savePromptTemplate(key, definition.defaultContent);
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderPromptTemplate(content, variables = {}) {
    let output = String(content || '');
    for (const [key, value] of Object.entries(variables)) {
        const pattern = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, 'g');
        output = output.replace(pattern, String(value ?? ''));
    }
    return output;
}

module.exports = {
    PROMPT_TEMPLATE_PREFIX,
    PROMPT_TEMPLATES,
    listPromptTemplates,
    getPromptTemplate,
    savePromptTemplate,
    resetPromptTemplate,
    getPromptTemplateDefinition,
    listPromptTemplateDefinitions,
    getPromptTemplateSettingKey,
    renderPromptTemplate
};
