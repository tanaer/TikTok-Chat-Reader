# Live Monitor → Archive Robustness Review

本文聚焦“直播间开播监控 → 下播/断开 → 会话归档（session）”这条链路的健壮性：在网络波动、重复触发、并发竞争、数据库写入延迟等异常场景下，系统是否能做到**不重复归档、不跨场打标签、尽量不丢最后一段数据**。

## 1) 链路总览（从监控到归档）

核心文件：

- `auto_recorder.js`：后台扫描、建立连接、事件落库、断开后归档
- `connectionWrapper.js`：对 `tiktok-live-connector` 的连接封装（重连/放弃/代理/错误处理）
- `manager.js`：session / event 的落库、打标签、统计与修复工具
- `db.js`：SQLite(sql.js) 初始化/迁移/落盘策略
- `server.js`：REST/Socket API（手动 stop / 手动 end session / 查询统计）

核心数据结构：

- `AutoRecorder.activeConnections: Map<roomId, { wrapper, startTime, lastEventTime, pendingWrites }>`
- `event.session_id IS NULL`：表示“当前直播实时数据/未归档事件”
- `session`：一次录制的归档容器；归档动作本质是“创建 session + 给 event 打 session_id 标签”

## 2) 典型时序

### 2.1 自动监控开播

1. `AutoRecorder.monitor()` 定期扫描房间配置（`settings.auto_monitor_enabled` + 房间 `is_monitor_enabled`）
2. 对候选房间调用 `checkAndConnect(room)`：
   - 初始化 `TikTokConnectionWrapper`
   - `await wrapper.connect()` 成功后写入 `activeConnections`
   - 绑定事件并通过 `manager.logEvent(...)` 写入 `event`

### 2.2 下播/断开触发归档

触发来源（可能多路同时发生）：

- heartbeat `fetchIsLive=false`
- TikTok `streamEnd`
- wrapper 放弃重连后 emit `disconnected`
- 用户手动 stop（REST/Socket）

统一入口：`AutoRecorder.handleDisconnect(roomId, reason)`

归档关键步骤：

1. `wrapper.disconnect()`，并从 `activeConnections` 移除（停止继续产生新事件）
2. best-effort 等待 `pendingWrites`（事件落库 Promise）完成
3. `manager.getUntaggedEventCount(roomId, startTime)` 判断是否有可归档事件
4. `manager.createSession(roomId, snapshot)` 创建 session
5. `manager.tagEventsWithSession(roomId, sessionId, startTime)` 将事件打标签归档

## 3) 已加固/修复点（实现层）

### 3.1 防并发竞争（连接/断开/归档互斥）

风险：同一房间同时发生“连接中 + 断开中 + 又被 monitor 拉起”的并发，容易导致：

- 连接重复创建、重复监听
- `startTime` 被覆盖导致跨场打标签（A 场的 event 归到 B 场 session）

措施：

- `AutoRecorder.connectingRooms` / `disconnectingRooms` 对每个房间加 in-flight 锁
- `handleDisconnect` 幂等化：同一房间多路触发最终只归档一次
- 归档中禁止新连接：避免“边归档边写入”导致 session 不完整/跨场

### 3.2 防“最后几条事件没进 session”

风险：事件 handler 内部 `manager.logEvent(...)` 是 async；断开触发时可能仍有少量未完成写入。

措施：

- `AutoRecorder` 维护 `pendingWrites`（Set<Promise>）
- 归档前 best-effort 等待这些 Promise settle（带超时），尽量把最后的事件纳入 session

### 3.3 wrapper.connect 可 await（修复“并发限制形同虚设”）

风险：如果 `connect()` 不是一个真实可 await 的 Promise，外层节流/并发限制会失效，导致高并发冲击 sign server 或造成更多连接竞态。

措施：

- `TikTokConnectionWrapper.connect()` 返回真实 Promise

### 3.4 “房间离线”不再反复重连

风险：连接成功但 roomInfo 显示非 Live（例如 status!=2）时，若仍开启重连可能造成后台无意义循环与噪音日志。

措施：

- room offline 时禁用重连，并给出一次明确 `disconnected` reason

### 3.5 修复数据修复工具的 schema 不一致

风险：`fixOrphanedEvents` 写入 `session.info`，但实际 schema 为 `session.snapshot_json`，会导致修复接口执行时报错。

措施：

- 统一写入 `session.snapshot_json`

### 3.6 清理重复 REST 路由注册（避免维护误伤）

风险：同一路由在 `server.js` 被注册两次，会导致：

- 新增/修改时改错位置，产生“看起来改了但没生效”的维护事故
- 代码可读性下降，误判真实逻辑

措施：

- 移除重复注册，确保每个 route 只定义一次

## 4) 仍可考虑的改进点（产品/工程权衡）

1. **手动 stop 后的冷却期（cooldown）**
   - 当前：用户 stop 后，下一次 monitor 扫描可能又把房间拉起（如果仍在 Live 且 monitor 开关为开）
   - 可选：内存 cooldown（例如 10~30 分钟）或写入 room 字段标记“暂停自动连接”

2. **更结构化的断开原因**
   - 将 reason 统一为枚举/码表（例如 `HEARTBEAT_OFFLINE` / `STREAM_END` / `MANUAL_STOP` / `ROOM_OFFLINE`）
   - 便于 UI 展示与后续分析

3. **归档动作可观测性**
   - 记录每次归档的事件数、耗时、失败原因（写到 log 或保存到 session.snapshot_json）
   - 遇到“空 session/漏归档”能更快定位

4. **崩溃恢复策略更自动化**
   - 目前已有修复接口（fix orphan / rebuild sessions），可考虑在启动时提供可选自动修复开关（谨慎，避免误操作）

