# AI客户分析上下文引擎 MVP 说明

日期：2026-03-09

## 当前目标

本轮 MVP 已拆成两条能力线：

- `用户分析 -> 用户详情` 继续保留原本的 `AI性格分析`
- `房间详情 -> 历史排行榜` 新增 `客户价值深度挖掘`（原 `AI客户分析`）

核心原则不变：

- 用户数值、时间、排行、模型标签全部由系统计算
- AI 只负责解释、总结、策略、维护动作和可执行话术

## 当前入口划分

### 1. 性格分析

接口：`POST /api/analysis/ai`

用途：

- 继续服务 `用户分析` 页
- 只基于历史弹幕语料做旧版性格分析
- 结果绑定 `当前发起分析的登录账号 + 目标用户`
- 前端继续走同步体验，但后台仍会写入 `AI工作任务` 记录，便于统一追踪

后台 Prompt：

- `user_personality_analysis`
- 标题：`AI用户分析 · 性格分析流程`

### 2. 房间客户深挖

接口：

- `GET /api/rooms/:id/customer-analysis/:userId`
- `POST /api/rooms/:id/customer-analysis`

用途：

- 在 `房间详情 -> 历史排行榜` 对单个用户发起 `客户价值深度挖掘`
- 分析维度为 `当前房间`
- 结果绑定 `当前发起分析的登录账号 + 当前房间 + 目标用户`
- 首次生成和强制重算走后台异步任务，完成后发送消息通知

后台 Prompt：

- `customer_analysis_review`
- 标题：`客户价值深度挖掘 · 主分析流程`

## 本轮服务层

### `services/customerMetricCubeService.js`

负责构建客户行为立方体，支持：

- 空间维度：`current_room`、`other_rooms`、`all_rooms`
- 时间维度：`current_session`、`today`、`3d`、`7d`、`30d`、`all_time`

当前核心指标包括：

- `gift_value`
- `gift_count`
- `entry_count`
- `watch_minutes`
- `avg_watch_minutes_per_entry`
- `median_watch_minutes_per_entry`
- `danmu_count`
- `like_count`
- `active_days`
- `active_sessions`
- `last_active_at`
- `first_active_at`

### `services/customerFeatureService.js`

负责基于系统事实生成 MVP 模型：

- `room_lrfm`
- `platform_lrfm`
- `clv_current_room_30d`
- `abc_current_room`

### `services/aiContextService.js`

负责组装 `customerContextJson`，统一输出：

- `identity`
- `scope`
- `metricCube`
- `preference`
- `rankings`
  - `currentRoomGiftTopPercent30d` / `currentRoomGiftTopPercentLabel30d`
  - `platformGiftTopPercent30d` / `platformGiftTopPercentLabel30d`
- `models`
- `signals`
- `corpus`

### `services/customerAiAnalysisService.js`

负责：

- 加载 `customer_analysis_review` Prompt 模板
- 渲染 `customerContextJson` 与 `chatCorpusText`
- 调用 AI 模型
- 解析严格 JSON 输出
- 生成前台可直接展示的文本版结果

## customerContextJson 边界

主变量：`{{customerContextJson}}`

辅助变量：`{{chatCorpusText}}`

结构摘要：

```json
{
  "contextVersion": "customer-context.v1",
  "identity": {},
  "scope": {},
  "metricCube": {},
  "preference": {},
  "rankings": {},
  "models": {},
  "signals": {},
  "corpus": {}
}
```

当前重点使用字段：

- `models.room_lrfm`
- `models.platform_lrfm`
- `models.clv_current_room_30d`
- `models.abc_current_room`
- `signals.currentRoomValueShare30d`
- `signals.giftTrend7dVsPrev7d`
- `signals.onlyWatchNoGiftFlag`
- `signals.onlyGiftNoChatFlag`

## Prompt 边界

### `customer_analysis_review`

已明确约束：

- AI 不得重算系统数值
- AI 不得创造新的房间、日期、排行或分层标签
- `valueLevelCurrentRoom`、`valueLevelGlobal` 必须直接沿用系统标签
- `evidence` 必须引用系统字段、系统标签或系统数值
- 最终面向用户的分析文案中，不应直接输出 `platform_lrfm`、`abc_current_room`、`otherRoomGrowthFlag` 这类英文键名，而应转写为“平台LRFM”“本房ABC分层”“其他房间增长信号”等中文业务表达
- 若需要表达排行强弱，应优先输出系统计算后的“前X%”，而不是 `13/1511` 这类原始排行分母形式
- 输出必须为严格 JSON

### `session_recap_review`

本轮同步修正了主复盘 Prompt 的客户区块要求：

- `coreCustomers`
- `potentialCustomers`
- `riskCustomers`
- 每个客户对象要求带 `uniqueId`
- 明确禁止把 A 用户的话术、原因、动作错写到 B 用户

为防止后台误删导致线上模板残缺，服务启动时会对 `session_recap_review` 做一次关键结构校验；若缺少三类客户段落或关键约束，会自动恢复默认模板。

## 缓存绑定与复用规则

### 性格分析缓存

绑定维度：

- `member_id`
- `target_user_id`
- `prompt_key = user_personality_analysis`
- `current_room_id = ''`

复用条件：

- Prompt key 一致
- Prompt 更新时间一致
- 缓存未超过 90 天

### 房间客户分析缓存

绑定维度：

- `member_id`
- `target_user_id`
- `current_room_id`
- `prompt_key = customer_analysis_review`
- `context_version`

复用条件：

- Prompt key 一致
- Prompt 更新时间一致
- Context 版本一致
- `current_room_id` 一致
- 缓存时间不早于最近一次客户活跃时间
- 缓存未超过 90 天

## AI 工作中心

所有 AI 分析现在都会进入后台 `AI工作中心`：

- `session_recap`：房间维度任务
- `customer_analysis + analysisScene=personality`：用户性格分析
- `customer_analysis + analysisScene=room_customer`：房间客户分析

当前后台仍按 `用户 / 房间` 分类筛选：

- 性格分析、房间客户分析统一归入 `用户`
- AI直播复盘归入 `房间`

## 客户价值深度挖掘结果分区

2026-03-09 起，房间详情里的前台产品名统一改为 `客户价值深度挖掘`，展示重点也从“依据堆叠”调整为“结论优先”：

- 顶部：`summary`，直接给出本房价值判断、当前主要风险/机会、下一步动作
- 中部：5 个核心判断字段
  - `valueLevelCurrentRoom`
  - `valueLevelGlobal`
  - `loyaltyAssessment`
  - `diversionRiskAssessment`
  - `conversionStage`
- 结论区：
  - `keySignals`：重点结论
  - `recommendedActions`：下一步动作
  - `outreachScript`：主播承接话术
  - `forbiddenActions`：注意事项
- `modelEvidence / contributionEvidence / riskEvidence / interactionEvidence / evidence` 继续保留为兼容字段，但前台默认弱化，不再作为主展示区
- `currentRoomValueShare30d` 和 `otherRoomsValueShare30d` 的展示文案统一改为“该客户近30天总贡献里投向本房/其他房间的占比”，避免被误解成“占本房总盘子”

同时补充了两个交互点：

- 已生成结果时支持按图片/PDF 导出，导出方式与 `AI直播复盘` 保持一致
- AI 异步任务完成后会主动刷新一级菜单消息未读角标，不再必须先点开消息弹层

## 用户态返回面

用户侧接口继续坚持白名单：

- 仅返回结果文本、结构化结果、安全任务状态、基础元信息
- 不返回原始 Prompt
- 不返回原始 `customerContextJson`
- 不返回原始 `requestPayloadJson`
- 不返回原始 `resultJson`
- 不返回内部调试字段

## AI 点数方案

当前建议口径：

- `AI性格分析`：`1 点 / 次`
- `房间客户价值深度挖掘`：`3 点 / 次`
- `AI直播复盘`：`20 点 / 场`
- 命中当前账号缓存：`0 点`
- 管理员发起：`0 点`

定价思路：

- 性格分析仍是轻交付，保留低门槛 `1 点`
- 房间客户分析已是“系统事实 + 分层模型 + 策略建议 + 话术”的组合交付，维持 `3 点`
- 后续若升级为批量客户分析、召回方案包、分层打法包，建议直接做更高点数档位，不压低价格带
