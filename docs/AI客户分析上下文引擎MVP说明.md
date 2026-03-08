# AI客户分析上下文引擎 MVP 说明

日期：2026-03-08

## 目标

本轮在不重做用户分析前端的前提下，把现有 `POST /api/analysis/ai` 从“纯弹幕文本分析”升级为“结构化客户上下文 + 最近弹幕语料”的组合分析。

核心原则只有一条：

- 用户数值、时间、排行、模型标签，全部由系统计算。
- AI 只负责解释、总结、策略和话术。

## 本轮新增服务

### `services/customerMetricCubeService.js`

负责构建客户行为立方体，当前支持：

- 空间维度：`current_room`、`other_rooms`、`all_rooms`
- 时间维度：`current_session`、`today`、`3d`、`7d`、`30d`、`all_time`

当前输出的核心指标包括：

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

当前口径：

- `L`：关系长度，按首次活跃至今的关系天数评分
- `R`：最近活跃度，按距离最后活跃天数评分
- `F`：近 30 天活跃频次，按活跃天数评分
- `M`：近 30 天送礼价值，按房间或平台内排名评分

### `services/aiContextService.js`

负责组装 `customerContextJson`，统一输出：

- `identity`
- `scope`
- `metricCube`
- `preference`
- `rankings`
- `models`
- `signals`
- `corpus`

### `services/customerAiAnalysisService.js`

负责：

- 加载 `customer_analysis_review` Prompt 模板
- 渲染 `customerContextJson` 与 `chatCorpusText`
- 调用 AI 模型
- 解析严格 JSON 输出
- 生成兼容旧前端的文本版结果

## current_room 的判定规则

本轮没有重做用户分析页的房间选择器，所以 `current_room` 采用系统自动解析：

1. 如果请求显式传入 `roomId`，优先使用该房间。
2. 否则优先使用当前可见范围内送礼价值最高的房间。
3. 如果没有送礼数据，则退化为最近活跃房间。
4. 再不行，则退化为用户当前可访问房间列表中的第一个房间。

这套规则的目标不是“永远最完美”，而是先保证 `current_room` 在 MVP 阶段稳定、有解释性、可复用。

## customerContextJson 结构

当前主变量：`{{customerContextJson}}`

辅助变量：`{{chatCorpusText}}`

结构摘要如下：

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

其中重点字段：

- `models.room_lrfm`
- `models.platform_lrfm`
- `models.clv_current_room_30d`
- `models.abc_current_room`
- `signals.currentRoomValueShare30d`
- `signals.giftTrend7dVsPrev7d`
- `signals.onlyWatchNoGiftFlag`
- `signals.onlyGiftNoChatFlag`

## Prompt 边界

后台新增模板：`AI客户分析 · 主分析流程`

模板约束已经明确要求：

- AI 不能重算系统数值
- AI 不能自行发明房间、日期、排行或模型标签
- `valueLevelCurrentRoom`、`valueLevelGlobal` 必须直接沿用系统已有标签，不允许 AI 另起一套等级口径
- AI 只能围绕输入事实做解释与动作建议
- `evidence` 必须尽量引用原始字段名、标签和值
- 输出必须是严格 JSON

此外，服务层还增加了一层不可编辑的系统护栏提示，用于兜底约束：

- 结构化上下文优先级高于弹幕语料
- 聊天语料只能补充解释，不能推翻系统模型结果
- 缺少依据时，必须输出“当前未提供该项数据”或空数组

当前 JSON 输出结构为：

```json
{
  "summary": "",
  "valueLevelCurrentRoom": "",
  "valueLevelGlobal": "",
  "loyaltyAssessment": "",
  "diversionRiskAssessment": "",
  "conversionStage": "",
  "keySignals": [],
  "recommendedActions": [],
  "outreachScript": [],
  "forbiddenActions": [],
  "tags": [],
  "evidence": []
}
```

## 缓存与版本元数据

为了避免旧结果和新上下文混用，本轮给客户分析缓存补了以下元数据：

- `prompt_key`
- `prompt_updated_at`
- `context_version`
- `model_version`
- `current_room_id`
- 结构化结果 JSON

缓存复用条件：

- Prompt key 一致
- Prompt 更新时间一致
- Context 版本一致
- current_room 一致
- 缓存时间不早于最近一次客户活跃时间
- 缓存时间未超过 90 天

## 用户态返回面

本轮继续保持用户态接口白名单输出。

`POST /api/analysis/ai` 仅返回：

- `result`
- `analysis`
- `cached`
- `chatCount`
- `latency`
- `model`
- `source`
- `analyzedAt`

其中：

- `result` 是兼容旧前端的人类可读文本
- `analysis` 是新的结构化 JSON 结果

不会返回原始 Prompt、原始 `customerContextJson`、内部调试字段或模型调用细节。

## AI 点数建议

本轮代码先保持原用户分析扣点逻辑不变，方便平滑上线与兼容现有用户心智。

但从产品价值和营收视角，建议后续将“上下文版 AI客户分析”独立定价，推荐口径：

- 命中个人缓存再次查看：`0 点`
- 命中系统缓存但首次写入个人缓存：`1 次扣点`
- 上下文版 AI客户分析标准版：建议 `3 点 / 次`
- 强制重新分析：按完整标准版再次扣点

推荐 `3 点 / 次` 的原因：

- 已不再是简单弹幕总结，而是“系统事实 + 模型标签 + 运营建议 + 话术”的组合产物
- 按当前文档中的点价估算，`3 点` 约等于 `¥1.2 ~ ¥1.5`
- 该价格既明显高于旧版纯文本分析，又不会逼近单场 AI复盘的价格带

如果后续增加批量客户分析、召回脚本、多轮动作建议，可再拆成更高档位。

## 本轮暂不做

- 不新增独立的批量客户分析接口
- 不新增管理员上下文预览页
- 不把客户分析并入 AI工作中心异步任务
- 不切换到用户房间日聚合表
