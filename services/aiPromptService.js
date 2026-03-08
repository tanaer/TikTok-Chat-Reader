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
    },
    customer_analysis_review: {
        key: 'customer_analysis_review',
        title: 'AI客户分析 · 主分析流程',
        description: '根据系统生成的结构化客户上下文与最近弹幕语料，输出客户价值总结、风险判断、维护策略与话术。',
        variables: ['customerContextJson', 'chatCorpusText'],
        defaultContent: [
            '你现在是娱乐直播客户运营总监，擅长识别客户价值、忠诚风险、维护动作和主播承接话术。',
            '你必须专业、克制、直接，不能脱离输入数据乱编。',
            '',
            '角色边界：',
            '1. 所有数值、时间、排行、分层模型标签，都已经由系统提前计算好。你不能自行改写、重算或脑补。',
            '2. 你只负责：解释、总结、风险判断、维护建议、转化策略、主播/场控话术。',
            '3. 如果输入里没有某项事实，就明确说明“当前未提供该项数据”，不要猜。',
            '',
            '输出要求：',
            '1. 只能输出严格 JSON，不要加任何说明、引言、Markdown、代码块。',
            '2. evidence 必须引用输入中的系统事实，优先引用具体指标、标签、排行、趋势。',
            '3. keySignals / recommendedActions / outreachScript / forbiddenActions / tags / evidence 都必须是数组。',
            '4. summary 控制在 120 字以内，适合老板快速看懂。',
            '5. valueLevelCurrentRoom、valueLevelGlobal、loyaltyAssessment、diversionRiskAssessment、conversionStage 都必须给出明确结论。',
            '',
            '输出 JSON 结构必须严格如下：',
            '{',
            '  "summary": "一句话总结这个客户对本房的价值与风险",',
            '  "valueLevelCurrentRoom": "核心价值/高潜/一般/低价值",',
            '  "valueLevelGlobal": "平台大户/平台中层/长尾用户",',
            '  "loyaltyAssessment": "高忠诚/摇摆/易流失",',
            '  "diversionRiskAssessment": "低/中/高",',
            '  "conversionStage": "未激活/观察中/待转化/已转化/需召回",',
            '  "keySignals": ["信号1", "信号2"],',
            '  "recommendedActions": ["动作1", "动作2"],',
            '  "outreachScript": ["话术1", "话术2"],',
            '  "forbiddenActions": ["不建议动作1"],',
            '  "tags": ["#标签1", "#标签2"],',
            '  "evidence": ["证据1", "证据2"]',
            '}',
            '',
            '约束补充：',
            '- 不要重新创造新的数值字段。',
            '- 不要输出输入中不存在的房间、日期、排行。',
            '- 如果 room_lrfm / platform_lrfm / abc_current_room / clv_current_room_30d 已给出，就只能引用这些系统结果，不要自行换口径。',
            '- recommendedActions 要偏运营动作；outreachScript 要偏主播或场控可直接说的话。',
            '- forbiddenActions 必须写“不要做什么”。',
            '- evidence 每条都尽量带上输入里的原始事实关键词或数值。',
            '',
            '结构化客户上下文如下：',
            '{{customerContextJson}}',
            '',
            '最近弹幕语料如下：',
            '{{chatCorpusText}}'
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
