# AI直播复盘提示词管理

日期：2026-03-09

## 变更目的

当前后台 `提示词管理` 不再只服务 `AI直播复盘`，而是统一承接以下几类 AI Prompt：

- `AI直播复盘 · 高频弹幕筛选`
- `AI直播复盘 · 主分析流程`
- `AI用户分析 · 性格分析流程`
- `AI客户分析 · 主分析流程`

这样运营侧可以分别调整：

- 复盘筛选口径
- 复盘结论风格
- 性格分析表达风格
- 客户分析判断与话术风格

## 当前模板清单

### 1. `session_recap_comment_filter`

标题：`AI直播复盘 · 高频弹幕筛选`

用途：

- 对高频弹幕 Top50 做价值筛选
- 删除灌水、刷屏、无意义重复
- 当前还会在系统侧先剔除重复发送超过 15 次的自动福袋类弹幕

### 2. `session_recap_review`

标题：`AI直播复盘 · 主分析流程`

用途：

- 根据结构化场次数据生成完整直播复盘
- 输出老板摘要、本场两点、主要问题、下一步建议、客户分层、评分、标签等

当前关键要求：

- 必须包含 `coreCustomers / potentialCustomers / riskCustomers`
- 客户对象要求带 `uniqueId`
- 严禁把 A 用户的话术、理由、动作错写到 B 用户
- 复盘里的时间表达优先使用“开播后XX:XX-开播后XX:XX”的相对时间范围，不直接展示北京时间，方便团队跨场次复盘时按流程节奏联想

### 3. `user_personality_analysis`

标题：`AI用户分析 · 性格分析流程`

用途：

- 服务 `用户分析 -> 用户详情`
- 保留旧版性格分析体验
- 只围绕语言、话题、聊天风格、破冰方式输出简洁结果

### 4. `customer_analysis_review`

标题：`AI客户分析 · 主分析流程`

用途：

- 服务 `房间详情 -> 历史排行榜 -> AI客户分析`
- 输入 `customerContextJson + chatCorpusText`
- 输出价值判断、忠诚判断、分流风险、转化阶段、建议动作和话术

## 存储方式

提示词内容保存在 `settings` 表中，key 前缀为：

- `prompt_template.session_recap_comment_filter`
- `prompt_template.session_recap_review`
- `prompt_template.user_personality_analysis`
- `prompt_template.customer_analysis_review`

为避免泄露，公开配置接口会过滤所有 `prompt_template.` 前缀，只允许管理员读取与修改。

## 保护策略

### 1. 后台可编辑

- 保存后立即生效
- 恢复默认会把系统默认模板重新写入数据库

### 2. 系统护栏不可编辑

对于 `AI客户分析`，除了后台 Prompt 外，服务层还带有不可编辑的系统护栏，防止 AI 越权：

- 结构化上下文优先于弹幕语料
- AI 不得改写系统数值和系统标签
- 缺少事实时必须明确说“当前未提供该项数据”

### 3. 主复盘模板自动修复

如果 `session_recap_review` 被误删了三类客户分析段落或关键约束，服务启动时会自动恢复默认模板，避免线上继续产生不完整复盘。

## 前台挂载关系

- `session_recap_comment_filter` -> `AI直播复盘` 高频弹幕筛选
- `session_recap_review` -> `AI直播复盘` 主结论输出
- `user_personality_analysis` -> `用户分析` 用户详情性格分析
- `customer_analysis_review` -> `房间详情` 历史排行榜客户分析弹窗
