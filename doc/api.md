<!-- PATCH_SAFE_ANCHOR: ASCII-only line used as a stable patch anchor on Windows (avoids UTF-8 slicing panics when applying patches to this file). -->

# 对外接口（Socket.IO + REST API）

本文档按“前端实际用到 + 后端实际提供”的方式整理接口。接口定义在 `server.js`，前端调用分散在 `public/*.js`。

> 说明：`server.js` 内部存在部分重复路由定义（同一路径注册多次）。Express 会按注册顺序匹配并执行；如前一个 handler 已经 `res.json(...)` 并结束响应，后一个通常不会生效。这里以“能被前端正常使用的那一版返回结构”为准。

## 1) Socket.IO 事件

### 1.1 Client -> Server

- `setUniqueId`：开始订阅/（必要时）启动录制
  - payload：`(uniqueId, options)`
  - 当前前端 `public/app.js` 只传 `uniqueId`，不传 `options`
  - 后端逻辑：
    - 若 AutoRecorder 已连接：直接订阅
    - 否则调用 `autoRecorder.startRoom(uniqueId)` 手动启动录制并订阅

- `requestDisconnect`：用户显式停止录制
  - 后端会调用 `autoRecorder.disconnectRoom(roomId)`，并 emit `tiktokDisconnected`

### 1.2 Server -> Client

**连接状态**

- `tiktokConnecting`：开始连接中
  - payload：`{ roomId }`
- `tiktokConnected`：连接成功
  - payload：连接 state（含 `roomId` 等），或 `{ alreadyConnected: true }`
- `tiktokDisconnected`：连接断开或失败
  - payload：字符串 reason
- `streamEnd`：直播结束（后端从 TikTok 事件转发）

**实时事件（用于 UI 展示）**

- `chat`：弹幕
- `gift`：礼物
- `member`：进房
- `like`：点赞
- `roomUser`：房间在线/观众信息（后端透传原始 msg）
- 以及若干扩展事件（后端已透传但前端未必全部使用）：
  - `social` / `questionNew` / `linkMicBattle` / `linkMicArmies` / `liveIntro` / `emote` / `envelope` / `subscribe`

**全局统计**

- `statistic`：后端每 5 秒广播一次
  - payload：`{ globalConnectionCount }`

## 2) REST API

### 2.1 配置/设置

- `GET /api/config`
  - 返回：`settings` 表的所有 key/value 组成的对象
- `POST /api/settings`
  - body：任意 key/value（布尔会转成字符串存储）
  - 返回：`{ success: true }`
- `POST /api/config`
  - 与 `/api/settings` 等价（alias）

### 2.2 礼物单价（Price）

- `POST /api/price`
  - body：`{ id, price }`
  - 行为：写 `prices.json`（不走 DB）

> 注意：当前 `manager.js` 仍保留 price 逻辑，但统计的“礼物价值”多数使用 `diamond_count * repeat_count`（来自 TikTok 事件），不一定使用自定义单价。

### 2.3 房间（Rooms）

- `GET /api/rooms`
  - 返回：`room` 表列表（基础信息）

- `GET /api/rooms/stats`
  - 返回：房间列表 + 当前 LIVE 会话统计（`session_id IS NULL`）
  - 前端房间卡片页使用它来渲染 `totalVisits/totalComments/totalGiftValue/isLive/lastSessionTime`

- `POST /api/rooms`
  - body：`{ roomId, name, address, isMonitorEnabled }`
  - 行为：
    - `manager.updateRoom(...)` upsert room 配置
    - 若关闭监控，会立即 `autoRecorder.disconnectRoom(roomId)` 停止录制并触发归档

- `DELETE /api/rooms/:id`
  - 行为：删除该房间的 `event/session/room` 数据

### 2.4 房间详情/会话列表

- `GET /api/rooms/:id/sessions`
  - 返回：该房间的 session 列表（按 created_at desc）

- `GET /api/rooms/:id/stats_detail?sessionId=live|<session_id>`
  - 返回结构（前端 `public/app.js` 使用）：
    - `summary`: `{ duration, startTime, totalVisits, totalComments, totalLikes, totalGiftValue }`
    - `leaderboards`: `{ gifters, chatters, likers, giftDetails }`
    - 同时还会附加（由 `server.js` 拼装）：
      - `isLive`: boolean（是否当前正在录制）
      - `lastSession`: 最近一场 session

- `POST /api/rooms/:id/stop`
  - 行为：显式停止该房间自动录制（AutoRecorder 断开 + 归档）

### 2.5 会话（Sessions）

- `POST /api/sessions/end`
  - body：`{ roomId, snapshot, startTime }`
  - 行为：
    - 创建 session 记录
    - 把该房间 `session_id IS NULL` 的事件更新为新 `session_id`
    - 如果提供 `startTime`，则只标记 `timestamp >= startTime` 的事件

- `GET /api/sessions?roomId=...`：列出 session（可选 roomId）
- `GET /api/sessions/:id`：返回该 session 的 `snapshot_json`（JSON 解析后）

> 当前前端“历史回放”只会请求 `/api/sessions/:id` 并打印元数据；真正的事件回放接口暂未对外暴露（尽管 `manager.js` 里有 `getSessionEvents(sessionId)`）。

### 2.6 历史/时间分布

- `GET /api/history?roomId=...`
  - 返回：30 分钟粒度的 `{ time_range, income, comments, max_online }` 列表

### 2.7 用户分析

- `GET /api/analysis/users?lang=&page=&pageSize=`
  - 返回：`{ users, totalCount, page, pageSize }`

- `GET /api/analysis/user/:userId`
  - 返回：用户画像统计（礼物价值、活跃天数、常去房间、小时/星期分布等）

- `GET /api/analysis/stats`
  - 返回：全局统计（近 24h、近 7 天的礼物/聊天分布）

- `POST /api/analysis/ai`
  - body：`{ userId }`
  - 行为：调用第三方 AI 接口生成分析文本，并更新 `user.common_language/mastered_languages`

### 2.8 Debug / 数据修复

- `GET /api/debug/connections`
  - 返回：当前 AutoRecorder 正在录制的房间 id 列表
- `DELETE /api/debug/connections/:id`
  - 行为：强制断开该房间连接（用于排查“卡死的连接”）

- `POST /api/migrate-events`
- `POST /api/fix-orphaned-events`
- `POST /api/delete-empty-sessions`
- `POST /api/rebuild-missing-sessions`

这些接口分别对应 `manager.js` 内的数据迁移/修复方法，详见 `doc/runtime-flows.md` 的第 6 节。
