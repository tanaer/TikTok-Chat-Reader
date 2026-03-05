# 数据模型

后端使用 PostgreSQL 数据库，通过 `db.js` 的 `pg.Pool` 连接。

> **重要**：`db.js` 的 `query()` 函数对所有结果应用 `toCamelCase`，API 返回 camelCase 字段名。

## 存储方式与特点

- `db.js` 使用 `pg` 连接池（默认 20 连接）
- 迁移文件在 `migrations/` 目录，通过 `run_migration.js` 执行
- 核心表在 `db.js` 的 `initDb()` 中通过 `CREATE TABLE IF NOT EXISTS` 维护

## 核心监控表

### `room`（监控房间配置）

| 字段 | 含义 |
|---|---|
| `id` | 自增主键 |
| `room_id` | 房间标识（唯一） |
| `numeric_room_id` | TikTok numeric roomId |
| `name` | 房间名称 |
| `address` | 备注 |
| `updated_at` | 最近更新 |
| `is_monitor_enabled` | 是否自动监控（1/0） |

关键点：
- AutoRecorder 扫描时只选择 `name` 非空的房间作为"目标房间"
- UI 的"录制开关"对应 `is_monitor_enabled`

### `event`（事件明细：聊天/礼物/点赞/进房等）

| 字段 | 含义 |
|---|---|
| `id` | 自增主键 |
| `room_id` | 逻辑房间 id |
| `session_id` | 会话 id；`NULL` 表示当前 LIVE |
| `type` | chat/gift/like/member/roomUser |
| `timestamp` | 事件时间（TEXT） |
| `user_id` / `unique_id` / `nickname` | 用户字段 |
| `gift_id` / `diamond_count` / `repeat_count` | 礼物字段（价值 = diamond × repeat） |
| `like_count` / `total_like_count` | 点赞字段 |
| `comment` | 弹幕内容 |
| `viewer_count` | 在线人数 |
| `data_json` | 原始 JSON |

索引：`idx_event_room_session`、`idx_event_timestamp`、`idx_event_user_id`、`idx_event_type`、`idx_event_type_user`

### `session`（会话/场次）

| 字段 | 含义 |
|---|---|
| `session_id` | 唯一（`YYYYMMDDNN`） |
| `room_id` | 房间 |
| `snapshot_json` | 快照 JSON |
| `created_at` | 创建时间 |

### `user`（用户画像）

| 字段 | 含义 |
|---|---|
| `user_id` | 主键（TikTok userId） |
| `unique_id` | 账号名 |
| `nickname` | 昵称 |
| `avatar` | 头像 |
| `common_language` | 常用语种（AI 写入） |
| `mastered_languages` | 掌握语种（AI 写入） |

### `settings`（系统配置）

| 字段 | 含义 |
|---|---|
| `key` | 主键 |
| `value` | 字符串值 |

key 命名不一致说明：`interval` vs `scan_interval`、`proxy` vs `proxy_url`，详见 `doc/config.md`。

## SaaS 表（来自 migrations）

### `users`（注册用户）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | |
| email | VARCHAR(255) UNIQUE | 登录邮箱 |
| password_hash | VARCHAR(255) | bcrypt 哈希 |
| nickname | VARCHAR(100) | |
| balance | INTEGER DEFAULT 0 | 余额（分） |
| role | VARCHAR(20) DEFAULT 'user' | user/admin |
| status | VARCHAR(20) DEFAULT 'active' | active/suspended |
| refresh_token | TEXT | JWT Refresh Token |

### `subscription_plans`（套餐方案）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | |
| name | VARCHAR(50) | 免费版/基础版/专业版/企业版 |
| code | VARCHAR(20) UNIQUE | free/basic/pro/enterprise |
| price_monthly | INTEGER | 月价（分）|
| price_quarterly | INTEGER | 季价（分）|
| price_annual | INTEGER | 年价（分）|
| room_limit | INTEGER | 房间限制（-1=无限）|
| history_days | INTEGER | 数据保留天数 |
| ai_credits_monthly | INTEGER | 月度 AI 额度 |
| api_rate_limit | INTEGER | API 限频 |
| feature_flags | JSONB | 功能开关 |
| is_active | BOOLEAN | 上架 |
| sort_order | INTEGER | 排序 |

### `user_subscriptions`（用户订阅记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| user_id | FK → users | |
| plan_id | FK → subscription_plans | |
| billing_cycle | VARCHAR(20) | monthly/quarterly/annual |
| start_date / end_date | TIMESTAMP | 有效期 |
| status | VARCHAR(20) | active/expired/cancelled |
| auto_renew | BOOLEAN | 是否自动续费 |

### `payment_records`（支付记录）

| 字段 | 说明 |
|------|------|
| order_no | 内部订单号（唯一） |
| amount | 金额（分） |
| payment_method | alipay/wxpay/stripe/manual |
| status | pending/paid/failed/refunded |

### `user_room`（用户-房间关联）

| 字段 | 说明 |
|------|------|
| user_id | FK → users |
| room_id | FK → room |
| created_at | 关联时间 |

### `room_addon_packages`（加量包方案）

| 字段 | 说明 |
|------|------|
| name | 加量包名称 |
| room_count | 额外房间数 |
| price_monthly | 月价（分） |

### `balance_logs`（余额流水）

| 字段 | 说明 |
|------|------|
| user_id | FK → users |
| amount | 变动金额（正=入，负=出） |
| balance_before / balance_after | 变动前后余额 |
| type | recharge/subscription/addon/refund/admin_adjust |
| description | 说明 |

### `notifications`（站内通知）

| 字段 | 说明 |
|------|------|
| user_id | FK → users |
| title / message | 标题与内容 |
| type | system/subscription/payment |
| is_read | 是否已读 |

## 时间与时区

代码中存在多种时间来源：

- `db.js` 默认：`TIMESTAMP DEFAULT NOW()`（PostgreSQL UTC）
- `manager.js` 的 `getNowBeijing()`：UTC+8 字符串 `YYYY-MM-DD HH:mm:ss`
- `AutoRecorder` 某些地方使用 `new Date().toISOString()`

`event.timestamp` 是 TEXT 类型，存在字符串格式不一致的风险，需注意比较操作。
