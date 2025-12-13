# 数据模型（data.db）

后端使用 SQLite 数据库文件：`data.db`

## 存储方式与特点

- `db.js` 使用 `sql.js` 把 SQLite 文件加载到内存中操作，然后定期/批量落盘回 `data.db`
- 文件级备份：`data.db.backup`
- 迁移策略：启动时执行 `CREATE TABLE IF NOT EXISTS ...` + `ALTER TABLE ... ADD COLUMN ...`

## 表结构概览

> 下面字段来自 `db.js` 中的建表 SQL；实际库可能因为历史迁移存在额外列（例如某些修复脚本/旧版本写入的字段）。

### 1) `room`（监控房间配置）

| 字段 | 含义 |
|---|---|
| `id` | 自增主键 |
| `room_id` | 房间标识（主要作为“主播 uniqueId/用户名”使用，唯一） |
| `numeric_room_id` | TikTok 实际 numeric roomId（连接成功时保存，用于迁移/兼容） |
| `name` | 房间名称（用户配置，用于 UI 展示；AutoRecorder 也用它判断“是否已配置”） |
| `address` | 备注/地址（业务含义以 UI 为准） |
| `updated_at` | 最近更新（默认 localtime） |
| `is_monitor_enabled` | 是否自动监控（1/0） |

关键点：

- AutoRecorder 扫描时只会选择 `name` 非空的房间作为“目标房间”
- UI 的“录制开关”对应 `is_monitor_enabled`

### 2) `event`（事件明细：聊天/礼物/点赞/进房等）

| 字段 | 含义 |
|---|---|
| `id` | 自增主键 |
| `room_id` | 逻辑房间 id（通常是用户名/uniqueId） |
| `session_id` | 会话 id；`NULL` 表示“当前 LIVE（未归档）” |
| `type` | 事件类型（`chat`/`gift`/`like`/`member`/`roomUser` 等） |
| `timestamp` | 事件时间（TEXT，默认 localtime；`manager.js` 用北京时间字符串写入） |
| `user_id` / `unique_id` / `nickname` | 用户维度的展开字段（便于直接查询） |
| `gift_id` / `diamond_count` / `repeat_count` | 礼物维度字段（礼物价值 = `diamond_count * repeat_count`） |
| `like_count` / `total_like_count` | 点赞字段（单次 + 累计） |
| `comment` | 弹幕内容（`chat`） |
| `viewer_count` | 在线人数（通常来自 `roomUser` 或其他事件的展开） |
| `data_json` | 原始 JSON（保留扩展字段，便于后续补列/回填） |

索引（`db.js` 创建）：

- `idx_event_room_session`：`(room_id, session_id)`
- `idx_event_timestamp`：`(timestamp)`
- `idx_event_user_id`：`(user_id)`
- `idx_event_type`：`(type)`
- `idx_event_type_user`：`(type, user_id)`

关键点：

- 事件写入统一走 `manager.logEvent(roomId, type, data)`
- 写入时既写展开字段，也把完整结构存 `data_json`
- 启动迁移阶段会尝试用 `json_extract(data_json, '$....')` 回填展开字段

### 3) `session`（会话/场次）

| 字段 | 含义 |
|---|---|
| `id` | 自增主键 |
| `session_id` | 会话 id（`YYYYMMDDNN` 形式，唯一） |
| `room_id` | 对应房间 |
| `snapshot_json` | 会话快照（JSON 字符串；目前主要用于存一些“备注/标记”，不是事件列表） |
| `created_at` | 创建时间（localtime） |

会话与事件的关系：

- “实时 LIVE”时：事件 `event.session_id IS NULL`
- 归档时：创建 `session` 记录，并把某段时间内的事件打上 `session_id`
- UI 在房间详情页可以在 `live` 与 `session_id` 之间切换查看统计

### 4) `user`（用户画像/聚合属性）

| 字段 | 含义 |
|---|---|
| `user_id` | 主键（TikTok userId） |
| `unique_id` | 账号名/handle（可能随迁移脚本调整，见 `fix_db.js`） |
| `nickname` | 昵称 |
| `avatar` | 头像 |
| `updated_at` | 最近更新 |
| `common_language` | 常用语种（AI 分析写入） |
| `mastered_languages` | 掌握语种（AI 分析写入） |

来源：

- `manager.logEvent(...)` 在写 event 时会同步 `ensureUser(...)` upsert 到 user 表
- AI 分析接口会更新 `common_language` / `mastered_languages`

### 5) `settings`（系统配置）

| 字段 | 含义 |
|---|---|
| `key` | 主键 |
| `value` | 字符串值（布尔会被转成 `'true'/'false'`） |
| `updated_at` | 更新时间 |

使用方：

- `server.js`：读取 `port`、AI 配置等
- `auto_recorder.js`：读取监控间隔与自动监控开关
- 前端 `public/config.js`：读写配置项

注意：当前存在 key 命名不一致（例如 `interval` vs `scan_interval`、`proxy` vs `proxy_url`），详见 `doc/config.md`。

## 时间与时区（重要）

代码中存在多种时间来源：

- `db.js` 默认时间：`datetime('now', 'localtime')`，格式 `YYYY-MM-DD HH:mm:ss`
- `manager.js` 的 `getNowBeijing()`：用 `toISOString()` 计算 UTC+8 后替换 `'T'` 为 `' '`，同样是 `YYYY-MM-DD HH:mm:ss`
- `AutoRecorder` 某些地方使用 `new Date().toISOString()`（包含 `T` 和 `Z`）

由于 `event.timestamp` 是 TEXT，且查询里存在 `timestamp >= ?` 的比较逻辑，**需要特别注意比较双方的字符串格式是否一致**，否则可能导致过滤条件失效。

