const db = require('../db');

const PROMPT_TEMPLATE_PREFIX = 'prompt_template.';

const PROMPT_TEMPLATES = {
    session_recap_comment_filter: {
        key: 'session_recap_comment_filter',
        sortOrder: 10,
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
        sortOrder: 20,
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
            '      "uniqueId": "账号ID",',
            '      "totalGiftValue": 0,',
            '      "giftCount": 0,',
            '      "keyBehavior": "关键行为描述",',
            '      "maintenanceSuggestion": "维护建议"',
            '    }',
            '  ],',
            '  "potentialCustomers": [',
            '    {',
            '      "nickname": "昵称",',
            '      "uniqueId": "账号ID",',
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
            '      "uniqueId": "账号ID",',
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
            '- coreCustomers 优先选择“本场送礼高 + 历史总价值高”的用户，maintenanceSuggestion 要写清楚怎么维护、谁来维护。',
            '- potentialCustomers 优先选择“互动高但送礼低 / 首次送礼 / 明显有兴趣”的用户，conversionScript 要给 1-2 句主播或场控可直接使用的话术，而且话术对象必须与该用户本人一致，不能串到别的用户身上。',
            '- riskCustomers 优先选择“历史高价值但本场明显变弱、只来不出手、早退、互动降温”的用户，riskReason 和 recoveryStrategy 不能空泛。',
            '- valuableComments 返回 5-10 条高价值弹幕；如果输入里没有，就返回空数组，不要凑数。',
            '- 同一用户默认不要重复出现在 coreCustomers / potentialCustomers / riskCustomers 三个数组里。',
            '- nickname、uniqueId、totalGiftValue、giftCount、enterTime、leaveTime 等字段优先沿用输入，不要编造。',
            '- 每个客户对象都必须与输入里的同一条客户记录保持一致，uniqueId 如有提供必须原样保留；不要把 A 用户的话术、原因、动作写到 B 用户上。',
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
    user_personality_analysis: {
        key: 'user_personality_analysis',
        sortOrder: 40,
        title: 'AI用户分析 · 性格分析流程',
        description: '根据用户历史弹幕，输出旧版性格分析结果，供用户分析页直接展示。',
        variables: ['chatCorpusText'],
        defaultContent: [
            '你是一个数十年经验的专业娱乐主播运营总监，并且你的情商非常高。',
            '请根据用户的历史弹幕内容，做一份简洁、接地气、可运营落地的性格分析。',
            '',
            '请只围绕以下 5 项输出：',
            '1. 常用语种',
            '2. 掌握语种',
            '3. 感兴趣的话题',
            '4. 聊天风格',
            '5. 建议破冰方式',
            '',
            '要求：',
            '1. 只根据输入弹幕判断，不要编造用户没有表现出来的身份、职业、地区或消费能力。',
            '2. 如果某项证据不足，请直接写“当前语料不足以判断”。',
            '3. 输出必须是中文，简洁、自然、像运营同事写给主播的观察结论。',
            '4. 不要输出 JSON，不要输出 Markdown 表格，不要加前言或结尾。',
            '5. 按 1-5 顺序直接输出，每项 1-2 句即可。',
            '',
            '用户历史弹幕如下：',
            '{{chatCorpusText}}'
        ].join('\n')
    },
    customer_analysis_review: {
        key: 'customer_analysis_review',
        sortOrder: 30,
        title: 'AI客户分析 · 主分析流程',
        description: '用于房间详情 / 历史排行榜中的 AI客户分析，基于结构化客户上下文与最近弹幕语料输出客户总结、风险判断、维护策略与话术。',
        variables: ['customerContextJson', 'chatCorpusText'],
        defaultContent: [
            '你现在是娱乐直播客户运营总监，擅长识别客户价值、忠诚风险、维护动作和主播承接话术。',
            '你必须专业、克制、直接，不能脱离输入数据乱编。',
            '',
            '角色边界：',
            '1. 所有数值、时间、排行、分层模型标签，都已经由系统提前计算好。你不能新增、修改、换算、重排，也不能把系统标签改写成另一套自定义等级。',
            '2. 你只负责：解释、总结、风险判断、维护建议、转化策略、主播/场控话术。',
            '3. 如果输入里没有某项事实，就输出“当前未提供该项数据”或空数组，不要猜。',
            '4. 如果结构化上下文与弹幕语料存在冲突，优先相信结构化上下文，弹幕只作为补充解释。',
            '5. 不能因为聊天语气热闹，就推翻系统给出的低价值、低忠诚或高分流风险结论。',
            '',
            '建议思考顺序：',
            '1. 先看 scope.currentRoom、scope.currentSession，明确本次结论围绕哪个房间。',
            '2. 再看 models.room_lrfm、models.platform_lrfm、models.clv_current_room_30d、models.abc_current_room。',
            '3. 再看 signals，判断忠诚、分流、沉默、观看未转化等风险。',
            '4. 最后再用 corpus.recentChatMessages 和 chatCorpusText 去补充偏好、情绪和话术风格。',
            '',
            '字段写法规则：',
            '1. valueLevelCurrentRoom 必须直接沿用系统标签，优先使用 room_lrfm.tier；若 room_lrfm.tier 缺失，再参考 abc_current_room.tier，并结合 clv_current_room_30d.value 做补充解释。',
            '2. valueLevelGlobal 必须直接沿用 platform_lrfm.tier；缺失时写“当前未提供该项数据”。',
            '3. loyaltyAssessment 优先参考 currentRoomValueShare30d、currentRoomInactiveDays、platformInactiveDays；输出“高忠诚 / 摇摆 / 易流失”之一，若证据不足可写“当前未提供该项数据”。',
            '4. diversionRiskAssessment 优先参考 otherRoomsValueShare30d、otherRoomGrowthFlag；输出“低 / 中 / 高”之一，若证据不足可写“当前未提供该项数据”。',
            '5. conversionStage 优先参考 gift_value、danmu_count、onlyWatchNoGiftFlag、onlyGiftNoChatFlag；输出“未激活 / 观察中 / 待转化 / 已转化 / 需召回”之一，若证据不足可写“当前未提供该项数据”。',
            '6. tags 是运营标签，不是模型标签；可以总结现象，但不能伪造新的系统分层。',
            '',
            '输出要求：',
            '1. 只能输出严格 JSON，不要加任何说明、引言、Markdown、代码块。',
            '2. evidence 必须引用输入中的系统事实，但最终表达必须用中文业务名称，不要直接输出 platform_lrfm、abc_current_room、otherRoomGrowthFlag、currentRoomValueShare30d 这类英文键名。',
            '2.1 如果引用模型结果，直接围绕模型评分、模型分层、系统说明来写，例如“平台LRFM分层为核心价值”“本房ABC分层为A”“近30天本房贡献占比高”。如需表达排行强弱，优先直接写“前X%”，不要写“排名13/1511”这类分子分母。',
            '2.2 如果引用布尔信号，必须写成中文业务描述 + 是/否，不要输出 true / false。',
            '3. keySignals / recommendedActions / outreachScript / forbiddenActions / tags / evidence 都必须是数组。',
            '4. summary 控制在 120 字以内，格式尽量接近“本房价值判断 + 当前主要风险/机会 + 下一步动作”。',
            '5. valueLevelCurrentRoom、valueLevelGlobal、loyaltyAssessment、diversionRiskAssessment、conversionStage 都必须给出字符串；没有依据时写“当前未提供该项数据”。',
            '6. keySignals 返回 2-4 条，recommendedActions 返回 2-4 条，outreachScript 返回 2-3 条，forbiddenActions 返回 1-3 条，tags 返回 2-5 条，evidence 返回 2-4 条。',
            '7. evidence 至少 1 条来自 models.*，至少 1 条来自 signals.* 或 corpus.*；如果 chatCorpusText 为空，就不要虚构弹幕证据。',
            '8. recommendedActions 每条尽量包含“谁来做、何时做、做什么”；outreachScript 每条尽量是主播或场控可直接说出口的自然短句。',
            '',
            '输出 JSON 结构必须严格如下：',
            '{',
            '  "summary": "一句话总结这个客户对本房的价值、风险和下一步动作",',
            '  "valueLevelCurrentRoom": "高价值",',
            '  "valueLevelGlobal": "核心价值",',
            '  "loyaltyAssessment": "高忠诚",',
            '  "diversionRiskAssessment": "中",',
            '  "conversionStage": "待转化",',
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
            '- 不要输出输入中不存在的房间、日期、排行。需要表达排行时，优先使用系统已提供的“前X%”字段，不要自己输出“排名A/B”。',
            '- 如果 room_lrfm / platform_lrfm / abc_current_room / clv_current_room_30d 已给出，就必须直接沿用这些系统结果，不要自行换口径。',
            '- 如果本房价值和平台价值不一致，要明确写出“平台有价值，但本房承接偏弱”或同类结论。',
            '- recommendedActions 必须写成可执行动作，尽量包含“谁来做、何时做、做什么”。',
            '- outreachScript 要偏主播或场控可直接说的话，语气自然，不要像报告，也不要承诺输入里没有的福利、价格或权益。',
            '- forbiddenActions 必须写“不要做什么”，不能写成空泛提醒。',
            '- evidence 每条都尽量带上输入里的原始事实关键词或数值，但必须翻译成中文业务表达。若涉及排行，优先写成“本房近30天送礼排名前10%”“平台近30天送礼排名前1%”，不要写“排名13/1511”。',
            '- keySignals 要写“模型/信号 + 含义”，不要只抄字段名或英文键名。',
            '- 不要输出空洞套话，例如“加强互动”“继续观察”“做好维护”这类没有动作对象和场景的话。',
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
    return Object.values(PROMPT_TEMPLATES).sort((left, right) => Number(left.sortOrder || 999) - Number(right.sortOrder || 999));
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

function shouldRepairSessionRecapReviewTemplate(content = '') {
    const normalized = String(content || '');
    if (!normalized) return false;
    const requiredMarkers = [
        'coreCustomers',
        'potentialCustomers',
        'riskCustomers',
        '"uniqueId": "账号ID"',
        '不要把 A 用户的话术'
    ];
    return requiredMarkers.some(marker => !normalized.includes(marker));
}

async function repairCriticalPromptTemplates() {
    const sessionRecapDefinition = getPromptTemplateDefinition('session_recap_review');
    if (!sessionRecapDefinition) return { repairedKeys: [] };

    const current = await db.pool.query(
        'SELECT value FROM settings WHERE key = $1 LIMIT 1',
        [getPromptTemplateSettingKey('session_recap_review')]
    );
    const currentValue = current.rows[0]?.value || '';
    const repairedKeys = [];

    if (currentValue && shouldRepairSessionRecapReviewTemplate(currentValue)) {
        await savePromptTemplate('session_recap_review', sessionRecapDefinition.defaultContent);
        repairedKeys.push('session_recap_review');
    }

    return { repairedKeys };
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
    repairCriticalPromptTemplates,
    getPromptTemplateDefinition,
    listPromptTemplateDefinitions,
    getPromptTemplateSettingKey,
    renderPromptTemplate
};
