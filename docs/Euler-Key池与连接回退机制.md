# Euler Key池与连接回退机制

## 背景

系统当前同时存在三类与 Euler 相关的运行状态：

1. Key 池健康状态
2. 当前进程内存中的冷却状态
3. 实际建连时是否已经退化到 TikTok HTML / API / Euler 兜底链路

过去后台 Euler 面板更偏向展示 Key 池与内存态，容易让运维误以为“全 Key 冷却 = 系统完全不可连接”。本次调整后，后台会同时展示 Key 池状态、最近连接路径与当前配置来源，减少误判。

## 官方套餐结论

截至 2026-03-09，结合 Euler 官网定价页与官方文档，可确认的稳定结论是：

- `Community` 公开包含基础请求额度、Cloud WebSockets 与 LIVE Alerts，适合基础监测
- `Business` 及更高方案公开包含 `Premium Webcast Routes` 能力
- `/webcast/room_id` 在本系统中按 Premium room lookup 对待，不作为 Community 默认必需链路
- 系统现已改为“手工等级模式”，不会再自动探测某把 Key 是否具备 Premium room lookup

这意味着：

- 你的 Community Key 仍可正常支撑直播间监测，这是合理现象
- 系统不应把 `/webcast/room_id` 当作默认主链路
- 当某把 Key 升级后，请直接在后台把这把 Key 手工设为 `Premium / Business`，系统才会启用对应高级路由

## Key 来源优先级

运行时按以下优先级装载 Euler Key：

1. `euler_api_keys` 数据表中的启用 Key
2. `settings.euler_keys`
3. 环境变量 `EULER_KEYS` / `EULER_API_KEY`

如果数据库表中已有启用 Key，则它们优先级最高。此时旧的单 Key 配置仅用于兼容无池模式，不再在“池已存在但全部冷却”时偷偷接管。

## 当前连接策略

### 1. Key 池轮换

- 每次创建 `TikTokConnectionWrapper` 时，都会通过 `KeyManager.getActiveKeyEntry()` 轮询选择当前可用 Key。
- 轮换是顺序轮询，不做加权分配。
- 冷却结束后，Key 在下一次被扫描到时惰性恢复。
- 选中的 Key 若被后台手工设为 `Premium / Business`，则本次连接允许在 HTML / API 失败时使用 Euler `/webcast/room_id` 做增强兜底；基础 / Community Key 则保持 TikTok HTML / API 主链路。

### 2. 限流与冷却

当 Euler 房间解析或直播状态查询返回 `429` 时：

- 当前 Key 会进入冷却
- 后台面板会保留“上次限流”提示
- 这类状态会被视为临时限流，而不是永久失效
- 由于系统已停用 Premium 自动探测，后台不再根据 `/webcast/room_id` 的 401 / 429 自动改写 Key 等级。

### 3. 系统回退

对 Community 方案，系统默认主链路使用 TikTok HTML / TikTok API 获取房间信息，不会把 Euler `/webcast/room_id` 当成必需链路。只有当某把 Key 被后台手工设为 `Premium / Business` 后，系统才会允许这把 Key 在 HTML / API 失败时使用 Euler room lookup 做兜底增强。

因此：

- `Euler Key 池可用 / 冷却` 只代表 Key 池状态
- 不代表系统在该时刻绝对不可连接

## 后台面板字段说明

### 运行态总览

- `Euler Key 池可用 / 冷却`：当前进程视角下未冷却与冷却中的 Key 数
- `被选中次数`：Key 被调度器挑中的次数，不等同于真实成功请求数
- `房间查询请求`：通过 Euler 进行 room lookup 的运行时计数
- `直播探活请求`：通过 Euler 进行 live check 的运行时计数
- `成功建连`：连接成功次数
- `Fallback 建连`：最近连接成功但走了 TikTok HTML / API / Euler 兜底链路的次数
- `权限拒绝`：Euler 返回 401/402/403 的计数
- `最近连接路径`：最近一次成功连接主要依赖的路径
- `配置来源`：当前 Key 集合来自后台 Key 表、系统设置还是环境变量
- `Premium 等级 / 基础 / 未设置等级`：按手工配置的 Key 等级拆分统计，不再混入自动探测状态。

### 单 Key 卡片

- `累计选中`：数据库持久化的累计分配次数
- `运行选中`：当前进程运行期内的选择次数
- `房间查询`：该 Key 参与 Euler room lookup 的次数
- `直播探活`：该 Key 参与 Euler live check 的次数
- `成功建连`：该 Key 成功参与连接的次数
- `限流次数`：该 Key 命中 429 的次数
- `权限拒绝`：该 Key 命中 401/402/403 的次数

- `Key等级`：该 Key 当前被手工设为 `Premium / Business`、`基础 / Community` 或 `未设置`

### Key 等级与处理建议

- `Premium / Business`：这把 Key 允许在 HTML / API 失败时使用 Euler `/webcast/room_id` 做兜底
- `基础 / Community`：这把 Key 不会使用 Euler `/webcast/room_id`，适合绝大多数 Community 场景
- `未设置`：保留中性状态；默认也不会启用 Euler `/webcast/room_id`

### 连接路径标签

- `TikTok HTML 解析`：当前连接通过 TikTok 直播页 HTML 成功拿到 roomId
- `TikTok API 解析`：HTML 失败后，通过 TikTok API 成功拿到 roomId
- `TikTok HTML/API 回退链`：表示当前连接处于 HTML / API 回退模式
- `Euler 直连解析`：仅在旧兼容模式显式强制开启 Premium 直连时才会出现
- `Euler 兜底解析`：仅在某把 Key 被手工设为 Premium / Business 后才会出现

### 后台测试按钮

- `额度`：调用 Euler 额度相关接口，快速判断 Key 是否存活、是否明显失效或是否被临时限流
- `编辑`：手工设置该 Key 的等级（基础 / Community、Premium / Business、未设置）
- 若你后续升级了某把 Key，请直接在后台把它改成 `Premium / Business`；系统不会再自动探测并改写这个等级

## 心跳探活优化

为了降低 Euler Key 被活跃房间持续打穿的概率，系统将心跳探活调整为：

- 若最近 90 秒内仍有事件流，则不额外调用 `fetchIsLive()`
- 仅在事件长时间沉默时，再补做 API 探活

这能显著降低“活跃连接数量增长后，所有 Key 一起被心跳流量打进冷却”的风险。

## 运维判断建议

当你在后台看到：

- `全池冷却` + `系统可能退化到 HTML/API`：说明 Euler Key 池暂时不可用，但系统仍可能继续连接
- `全池冷却` + `当前已有 HTML/API fallback 成功`：说明当前系统确实已经在退化运行
- `最近连接路径 = TikTok HTML 解析 / TikTok API 解析`：在 Community 默认模式下，可直接判断最近成功建连具体依赖的是哪一层
- 若某把 Key 已被手工设为 Premium / Business，才可能出现 `Euler 直连解析 / Euler 兜底解析`
- `权限拒绝` 持续上升：优先检查 Key 权限或套餐能力
- `房间查询请求` 和 `直播探活请求` 增长很快：优先检查扫描并发、心跳策略与房间总数

## 后续建议

后续如需继续优化，可优先考虑：

1. 将连接成功来源持久化到数据库
2. 引入更精确的连接成功率统计
3. 如果套餐支持，研究使用批量探活或 Euler WebSocket 方案，减少 room lookup 压力
