# AI结构化数据源与Prompt编排机制

日期：2026-03-09

## 目标

把“系统结构化事实计算”和“Prompt 组织方式”拆开，避免后续继续把变量拼装、业务规则和 AI 输入堆到 `server.js`、`manager.js` 或单个 Prompt 模板里。

本机制要解决 4 个问题：

- 系统事实要能模块化扩展
- Prompt 要能自由组合这些事实
- 管理员要能单独测试每个数据源
- 新增 AI 场景时不需要再重复造一套变量拼装链路

## 当前落地形态

本轮新增 `services/aiStructuredDataSourceService.js`，使用“注册表”方式管理 AI 可插入的数据源。

每个数据源至少包含：

- `key`：内部唯一标识
- `token`：Prompt 占位符，如 `{{customerContextJson}}`
- `scene`：适用场景，对应 Prompt key
- `title` / `description`：后台展示说明
- `inputSchema`：测试接口输入结构
- `defaultTestInput`：后台测试默认参数
- `resolver`：系统事实计算函数

## 当前已接入的数据源

### AI直播复盘

- `sessionDataJson`
- `sessionRecapScoreBenchmarkJson`
- `sessionRecapNewAttentionCustomersJson`

其中：

- `sessionRecapScoreBenchmarkJson` 用于给 AI 提供“6小时 / 64,000钻”单场及格线基准，并按本场时长等比例折算
- `sessionRecapNewAttentionCustomersJson` 用于识别“本场送出 Heart Me 且历史从未送过 Heart Me”的新增关注信号
- `sessionDataJson` 里的相对时间统一使用 `开播后HH:MM:SS` 或 `开播后HH:MM:SS-开播后HH:MM:SS`，明确表示“相对开播时长”，避免模型误读成凌晨/后半夜等自然时段

### AI客户分析

- `customerContextJson`

该数据源复用 `services/aiContextService.js` 输出的结构化客户上下文。

## Prompt 编排方式

当前仍沿用 `services/aiPromptService.js` 的简单变量替换方式，不引入额外 DSL。

具体做法：

1. 按 Prompt `scene` 找到当前场景下所有结构化数据源
2. 逐个执行数据源 resolver，生成变量值
3. 将结果注入模板变量
4. 再调用现有 `renderPromptTemplate()` 渲染最终 Prompt

这样做的好处：

- 实现成本低，兼容现有模板体系
- 不需要重写 Prompt 存储结构
- 后续新增数据源时，只需要补 resolver 和后台说明

## 自动补充策略

为避免历史自定义 Prompt 没有及时插入新 token，当前系统支持“缺失时自动补充结构化数据块”。

规则：

- 如果某个场景的关键结构化数据源没有被模板显式引用
- 且该数据源被标记为 `autoAppendWhenMissing`
- 系统会在渲染前自动补一段对应 token

这样能保证：

- 老 Prompt 不至于因为少写 token 而完全吃不到新数据
- 新 Prompt 仍然可以手动控制 token 出现位置

## 后台管理

### 结构化数据源菜单

后台新增 `结构化数据源` 菜单，提供：

- 数据源列表
- token 展示
- 适用场景展示
- 输入结构展示
- 默认测试参数
- 测试结果 JSON 预览

### Prompt 管理联动

后台 `提示词管理` 会同步展示：

- 当前模板可插入的数据源 token
- 对应数据源名称与说明
- 跳转到 `结构化数据源` 菜单的入口
- Prompt 渲染预览区，可直接输入测试参数并查看最终注入后的 Prompt

这样运营在改 Prompt 时，可以先确认系统事实，再决定怎么组织提示词。

### Prompt 渲染预览

后台 `提示词管理` 进一步提供“渲染预览”能力：

- 支持按模板加载一份默认测试参数
- 支持填写结构化输入 JSON
- 支持填写手动变量覆盖 JSON
- 支持直接查看最终渲染后的 Prompt 全文
- 支持对比“当前模板内容 / 系统补入后的有效模板 / 最终渲染结果”
- 会额外提示哪些结构化 token 是自动补入、哪些 token 因缺少输入而未替换
- 支持直接复制预览结果、下载为 TXT，方便运营留档或给他人复核

这样管理员不仅能验证“数据源是否正确”，还能验证“Prompt 最终喂给模型的内容是否符合预期”。

## 安全边界

- 结构化数据源测试接口仅开放给后台管理员
- 用户态接口不直接返回原始结构化上下文、调试结果或内部 Prompt 输入
- 普通用户仍只拿到白名单后的分析结果

## 扣点口径

- 后台 `结构化数据源` 测试默认不扣 AI 点数
- 真实用户侧 AI 分析是否扣点，仍由各业务接口独立控制
- 结构化数据源本身属于系统事实校验能力，不是用户侧可交付内容

## 后续扩展建议

后续新增 AI 场景时，优先按以下顺序扩展：

1. 先补系统结构化数据源
2. 再补 Prompt token
3. 最后再接入 AI 调用链路

建议下一批优先考虑：

- `sessionRecapTrafficBenchmarkJson`
- `sessionRecapCustomerStructureJson`
- `customerRoomContributionJson`
- `customerDiversionSignalJson`
- `customerRecallOpportunityJson`

这样可以持续扩展 AI 能力，同时保持服务层可维护。
