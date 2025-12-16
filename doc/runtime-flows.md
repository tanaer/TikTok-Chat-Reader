# 关键业务流程（Runtime Flows）

本文件按“系统实际运行时”拆解核心流程，便于快速定位“数据从哪里来、怎么落库、怎么展示、什么时候归档”。

## 0. 启动流程

入口：`server.js`

1. `dotenv` 读取 `.env`
2. 初始化 Express（`express.json()`）+ 静态资源（`express.static('public')`）
3. 创建 HTTP Server + Socket.IO Server
4. `new AutoRecorder()`：
   - 2 秒后开始 `startLoop()`（定期扫描监控房间）
   - 同时启动 heartbeat（每 60 秒健康检查）
5. `manager.ensureDb()`：
   - 触发 `db.js` 初始化（建表、迁移、索引、落盘）
6. 读取端口：优先 `settings.port`，其次 `process.env.PORT`，默认 `8081`
7. `httpServer.listen(...)`

## 1. 自动监控 + 自动录制（AutoRecorder 主流程）

触发：`auto_recorder.js:startLoop()` 周期调用 `monitor()`

核心目标：后台维持“应该录制的房间”的连接，即使没有浏览器打开页面也持续录制。

### 1.1 监控扫描逻辑

1. `manager.getRooms()` 拉取所有房间配置
2. 读取全局开关：`settings.auto_monitor_enabled`（默认 `'true'`）
3. 过滤 `name` 非空的房间作为“目标房间”（即用户真正配置过的房间）
4. 对每个房间：
   - 若 `room.is_monitor_enabled === 0`：
     - 若当前已经连接，执行断开并归档
     - 否则跳过
   - 若已连接：跳过
   - 否则触发 `checkAndConnect(room)` 尝试连接（并在循环里 `await 1s` 做连接节流）

> 监控循环间隔由 DB 设置控制：`settings.interval`（分钟）。UI 若保存 `scan_interval`，会在 `manager.js` 层自动映射到 `interval`（见 `doc/config.md`）。

### 1.2 建立 TikTok 连接

`checkAndConnect(room)` 主要步骤：

1. 读取 `manager.getAllSettings()`，组装 `TikTokConnectionWrapper` 的 options
2. `const wrapper = new TikTokConnectionWrapper(uniqueId, options, true)`
3. 监听 wrapper 事件：
   - `connected`：写入 `activeConnections`，记录 `startTime`，并开始 `setupLogging(...)`
   - `disconnected` / `streamEnd`：触发 `handleDisconnect(uniqueId)`（断开 + 归档）

### 1.3 事件落库（setupLogging）

连接成功后监听 TikTok 事件，做两件事：

- 更新 heartbeat 所需的 `lastEventTime`
- `manager.logEvent(roomId, type, data)` 写入 `event` 表

已覆盖事件：

- `member`：进房事件，写 `userId/uniqueId/nickname`
- `chat`：弹幕，写 `comment` + 用户字段
- `gift`：礼物，写 `giftId/giftName/diamondCount/repeatCount/...`
  - 只在 “非连击礼物” 或 “连击结束包（repeatEnd）” 时落库，避免重复计数
- `like`：点赞，写 `likeCount/totalLikeCount`

## 2. 浏览器进入房间（实时展示订阅）

触发：前端 `public/app.js` 中 `connectToLive(roomId)` -> Socket.IO `emit('setUniqueId', roomId)`

后端：`server.js` Socket.IO `socket.on('setUniqueId', ...)`

流程：

1. 清理旧订阅（移除旧房间的事件监听器）
2. 如果 `AutoRecorder` 已经连着该房间：
   - 直接 `subscribeToWrapper(socket, wrapper, roomId)`
   - `socket.emit('tiktokConnected', { alreadyConnected: true })`
3. 如果 `AutoRecorder` 尚未连接：
   - `socket.emit('tiktokConnecting', { roomId })`
   - `await autoRecorder.startRoom(roomId)`（手动启动录制）
   - 成功后获取 wrapper 并订阅

`subscribeToWrapper(...)` 会把 TikTok 事件转发为 Socket.IO 消息（UI 用）：

- `chat` / `gift` / `member` / `like` / `streamEnd` / `roomUser` 等

注意：

- **浏览器断开（刷新/关闭页面）不会停止录制**：后端仅移除事件监听器
- 只有 `requestDisconnect` 才会调用 `autoRecorder.disconnectRoom(...)` 真正停止录制

## 3. 断开与归档（Session）

系统把一次录制视作一个“会话”（session），用来在 UI 中回看该场的统计。

### 3.1 自动归档（AutoRecorder.handleDisconnect）

触发条件：

- heartbeat 判定不再 Live
- TikTok `streamEnd`
- wrapper 放弃重连并 emit `'disconnected'`
- 用户通过 REST/Socket 显式停止

主要行为：

1. `wrapper.disconnect()`，并从 `activeConnections` 删除
2. 统计是否有可归档事件：
   - `manager.getUntaggedEventCount(roomId, startTime)`
3. 若有事件：
   - `sessionId = manager.createSession(roomId, snapshot)`
   - `manager.tagEventsWithSession(roomId, sessionId, startTime)` 将 `event.session_id` 填上

健壮性要点（避免“重复断开/重复归档/跨场打标签”）：

- `handleDisconnect` 对同一房间做幂等合并（多路触发最终只会归档一次）
- 房间级 in-flight 锁：连接中/归档中不会再启动新的连接，避免并发竞争
- 归档前 best-effort 等待事件落库 Promise settle，减少“最后几条事件未被归档”的概率

### 3.2 手动归档（前端按钮）

前端：`public/app.js` -> `POST /api/sessions/end`

后端：`server.js` -> `manager.createSession(...)` + `manager.tagEventsWithSession(...)`

这会把当前房间“所有未打标签的事件”归档到新 session（`startTime` 如果传 null）。

## 4. 房间数据展示（列表/详情）

### 4.1 房间列表

前端：`public/room_list.js` -> `GET /api/rooms/stats`

后端：`manager.getRoomStats(liveRoomIds)`：

- 统计“当前直播中的实时数据”（`session_id IS NULL`）
- `isLive` 由 `AutoRecorder.getLiveRoomIds()` 计算
- `lastSessionTime` 来自 `session` 表最新记录

### 4.2 房间详情

前端：`public/app.js` -> `GET /api/rooms/:id/stats_detail?sessionId=...`

- `sessionId=live`：查询 `session_id IS NULL`（实时）
- `sessionId=<具体 session_id>`：查询该场归档的事件

统计由 `manager.getRoomDetailStats(...)` 返回：

- Summary：duration / totalVisits / totalComments / totalLikes / totalGiftValue
- Leaderboards：Top Gifters / Top Chatters / Top Likers + 礼物明细（按用户+礼物聚合）

历史“弹幕回放”目前前端明确提示未实现（需要额外的事件回放 API）。

## 5. 用户分析与 AI 分析

### 5.1 用户榜单（Top Gifters）

前端：`public/user_analysis.js` -> `GET /api/analysis/users?page=&pageSize=&lang=`

后端：`manager.getTopGifters(...)`：

- 以 `gift` 事件聚合礼物价值
- `lang` 过滤匹配 `user.common_language` / `user.mastered_languages`
- 返回分页结构 `{ users, totalCount, page, pageSize }`

### 5.2 AI 性格/语言分析

前端：`POST /api/analysis/ai`（传 `userId`）

后端：

1. `manager.getUserChatHistory(userId, 50)` 拉取最近弹幕
2. 调用第三方 `chat/completions` 接口（默认 ModelScope URL）
3. 用正则解析回答中的：
   - `1、常用语种`
   - `2、掌握语种`
4. `manager.updateUserLanguages(...)` 写回 `user` 表

## 6. 数据修复/维护接口（DB 清理）

后端提供了一些“修复工具型 API”，用于处理历史数据不一致：

- `POST /api/migrate-events`：把 event.room_id 从 numeric_room_id 迁移回 room_id（用户名）
- `POST /api/fix-orphaned-events`：对 `session_id IS NULL` 的历史事件按 room+date 造 session 并打标签
- `POST /api/delete-empty-sessions`：删除没有任何 event 的 session
- `POST /api/rebuild-missing-sessions`：对 event 里存在但 session 表缺失的 session_id 进行重建
