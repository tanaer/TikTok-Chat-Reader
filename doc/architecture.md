# 系统架构与模块职责（TikTok-Chat-Reader）

## 总体架构（当前主线：Node.js）

系统由三层组成：

1. **数据采集层（TikTok LIVE）**
   - 通过 `tiktok-live-connector` 建立到指定主播 LIVE 房间的连接
   - 接收事件流：`chat` / `gift` / `like` / `member` 等

2. **后端服务层（Express + Socket.IO + AutoRecorder + SQLite）**
   - `server.js` 提供：
     - WebSocket（Socket.IO）给前端实时推送事件（展示用）
     - REST API 给前端做配置、房间管理、统计分析、会话归档等
   - `auto_recorder.js` 提供：
     - **后台常驻**的“自动监控 + 录制”服务（即使前端断开也继续录制）
     - 连接健康检查（heartbeat）和断开后的会话归档
   - `db.js` / `manager.js` 提供：
     - 基于 `sql.js` 的 SQLite 数据库加载、迁移、查询、落盘与备份
     - 统计计算（房间榜单、用户榜单、时间分布）

3. **前端展示层（public 静态页面）**
   - `public/index.html`（DaisyUI/Tailwind + jQuery + Chart.js）
   - 通过 REST 拉取房间列表、统计、用户榜单；通过 Socket.IO 接收实时事件

### 核心设计点：录制与展示解耦

后端 **不以浏览器连接为“录制是否继续”的依据**：

- 浏览器进入房间详情页：只是在 Socket.IO 上“订阅”某个房间的事件
- 浏览器离开页面：只移除订阅监听器，不会断开 TikTok 连接
- 只有两种情况会停止录制：
  - 后台判断房间不再 Live / 连接失效并放弃重连
  - 用户显式触发停止（Socket 事件 `requestDisconnect` 或 REST `POST /api/rooms/:id/stop`）

## 目录与文件角色

### 后端（Node.js）

- `server.js`
  - Express + HTTP Server + Socket.IO 的启动与路由定义
  - Socket.IO：处理 `setUniqueId` / `requestDisconnect`，把 TikTok 事件转发给前端
  - REST API：配置、房间、会话、统计、用户分析、AI 分析、数据修复接口
  - 启动时创建 `AutoRecorder`，并从 `settings`/环境变量读取端口

- `auto_recorder.js`
  - **常驻服务**：定时扫描“需要监控的房间列表”，自动连接正在 Live 的房间
  - 维护 `activeConnections: Map<roomId, { wrapper, startTime, lastEventTime }>`
  - 连接后：
    - 监听 TikTok 事件并调用 `manager.logEvent(...)` 记录到 `event` 表
    - 断开时触发 `handleDisconnect`：创建 `session` 并把事件打上 `session_id`（归档）
  - Heartbeat：
    - 每 60 秒调用 `wrapper.connection.fetchIsLive()` 主动验证是否仍在直播
    - 失败时用 “最近事件时间” 作为兜底判定（5 分钟无事件则断开）

- `connectionWrapper.js`
  - `TikTokConnectionWrapper`：对 `tiktok-live-connector` 的薄封装
  - 支持：
    - SOCKS 代理（`SocksProxyAgent`，来自 `options.proxyUrl` 或 `PROXY_URL`）
    - EulerStream 签名服务 Key（`SignConfig.apiKey`）
    - 断线重连（指数退避 + 最大 5 次）
    - `streamEnd` 时停止重连并触发 wrapper 的 `'disconnected'`（供 AutoRecorder 归档）
  - 维护全局连接计数 `globalConnectionCount`，`server.js` 会周期性广播给前端

- `db.js`
  - `sql.js`（纯 JS SQLite）加载/创建 `data.db`
  - 自动建表与迁移（`ALTER TABLE` 补列）
  - 写入采用“debounce + 周期强制保存”降低 IO，同时尽量减少数据丢失窗口
  - shutdown hook：收到 `SIGINT`/`SIGTERM` 时保存 + 备份

- `manager.js`
  - **业务与查询层**：
    - 房间管理：`updateRoom` / `getRooms` / `deleteRoom`
    - 会话管理：`createSession` / `tagEventsWithSession` / `getSessions`
    - 事件写入：`logEvent`
    - 统计：`getRoomStats` / `getRoomDetailStats` / `getTimeStats`
    - 用户分析：`getTopGifters` / `getUserAnalysis` / `updateUserLanguages`
    - 数据修复：`migrateEventRoomIds` / `fixOrphanedEvents` / `deleteEmptySessions` / `rebuildMissingSessions`

### 前端（public）

- `public/index.html`
  - 主要页面：房间列表 / 房间详情 / 用户分析 / 系统配置
  - 依赖 CDN：DaisyUI、Tailwind、jQuery、socket.io-client、Chart.js

- `public/app.js`
  - Socket.IO 连接初始化与事件分发（只在“实时 LIVE”视图下渲染实时消息）
  - 房间详情页加载逻辑：判断房间是否 Live，自动接入或加载最近会话
  - 切换会话：`live` vs `session_id`（历史回放目前提示“未实现”）
  - 手动归档：`POST /api/sessions/end`
  - 停止自动录制：`POST /api/rooms/:id/stop`

- `public/room_list.js`
  - 渲染房间卡片列表（来自 `GET /api/rooms/stats`）
  - 添加/编辑/删除房间（`POST /api/rooms` / `DELETE /api/rooms/:id`）
  - 录制开关：`is_monitor_enabled`（关闭时会触发后端立即断开）

- `public/user_analysis.js`
  - 用户榜单（分页 + 语言筛选）：`GET /api/analysis/users`
  - 用户详情：`GET /api/analysis/user/:userId`
  - AI 分析触发：`POST /api/analysis/ai`

- `public/config.js`
  - 系统配置读写：`GET /api/config` + `POST /api/settings`
  - 注意：当前代码里“settings key 命名”存在不一致，详见 `doc/config.md`

### Python（历史实现/备用实现）

仓库根目录的 Python 文件：

- `main.py`：Flask + Flask-SocketIO + TikTokLive（Python 库）实现的后端（包含 Socket 与部分 API）
- `database.py`、`manager.py`：peewee ORM + SQLite 的数据模型与简单统计

从 `README.md` 与 `package.json` 看，当前默认运行方式是 Node.js；Python 更像是早期原型或替代方案。

## 外部依赖与关键集成点

- TikTok 事件源：`tiktok-live-connector`
  - 注意：本仓库的依赖写成 `file:../TikTok-Live-Connector`，意味着需要同级目录存在该项目
- 代理：SOCKS5（环境变量 `PROXY_URL` 或 settings/请求参数）
- EulerStream：用于签名/绕过限制的 API Key（`EULER_API_KEY` 或 settings）
- AI 分析：后端调用 `node-fetch` 请求第三方 `chat/completions` API（默认 ModelScope）

