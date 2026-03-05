# 部署与运维（Deployment）

## 环境要求

- **Node.js** ≥ 18.x
- **PostgreSQL** ≥ 14.x
- **npm** ≥ 8.x

## 环境变量（`.env`）

```ini
# ── PostgreSQL ──────────────────────
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=tkmonitor
PG_USER=postgres
PG_PASSWORD=root
PG_MAX_CONNECTIONS=20

# ── Server ──────────────────────────
PORT=8081

# ── TikTok 连接 ─────────────────────
PROXY_URL=socks5://127.0.0.1:1080    # SOCKS5 代理（可选）
EULER_API_KEY=                        # EulerStream 签名 API Key
SESSIONID=                            # TikTok Session ID（可选）

# ── AI 分析 ─────────────────────────
AI_API_KEY=                           # 第三方 AI API Key
AI_API_URL=                           # AI 接口地址（默认 ModelScope）

# ── JWT ─────────────────────────────
JWT_SECRET=your-secret-key-here
JWT_REFRESH_SECRET=your-refresh-secret
```

## 数据库初始化

### 1. 创建数据库

```bash
createdb tkmonitor
```

### 2. 执行迁移

```bash
node run_migration.js
```

迁移文件在 `migrations/` 目录中按序号执行：
- `001_saas_schema.sql` — 用户、订阅方案、支付记录
- `002_ai_credits.sql` — AI 额度字段
- `003_multi_tenant.sql` — 多租户（user_room 关联表）
- `004_room_addon.sql` — 加量包
- `005_balance_system.sql` — 余额体系（balance_logs）
- `006_notifications.sql` — 站内通知
- `007_fix_addon_pricing.sql` — 修复加量包定价列

### 3. 初始化套餐数据

```sql
INSERT INTO subscription_plans (name, code, price_monthly, price_quarterly, price_annual, room_limit, is_active, sort_order)
VALUES
  ('基础版', 'basic', 2900, 7800, 27800, 5, true, 1),
  ('专业版', 'pro', 9900, 26700, 89900, 20, true, 2),
  ('企业版', 'enterprise', 29900, 80700, 269100, -1, true, 3);
```

## 启动

### 开发模式

```bash
npm install
node server.js
```

### 生产模式（PM2）

```bash
pm2 start server.js --name tkmonitor
pm2 save
pm2 startup
```

## 定时任务（`cron_jobs.js`）

服务器启动时自动执行。包含：

| 任务 | 间隔 | 说明 |
|------|------|------|
| 订阅到期检查 | 每小时 | 标记过期订阅 |
| 自动续费 | 每天 0:05 | 到期 + 自动续费 + 有余额 → 自动扣费 |
| 到期提醒 | 每天 10:00 | 到期前 3 天发通知 |
| 统计快照 | 每 6 小时 | user_stats 更新 |

## 目录结构

```
TikTok-Chat-Reader/
├── server.js              # Express 入口 + Socket.IO + 路由挂载
├── auto_recorder.js       # 后台常驻录制服务
├── connectionWrapper.js   # TikTok 连接封装
├── manager.js             # 业务逻辑与查询层
├── db.js                  # PostgreSQL 连接池 + toCamelCase
├── cron_jobs.js           # 定时任务
├── auth/
│   ├── middleware.js       # requireAuth / loadSubscription / requireAdmin
│   └── routes.js           # 注册/登录/Profile
├── api/
│   ├── subscription.js     # 订阅与套餐 API
│   ├── admin.js            # 管理后台 API
│   ├── payment.js          # 充值 API
│   ├── stripe.js           # Stripe Webhook
│   ├── futongpay.js        # 富通支付
│   └── user_rooms.js       # 用户房间管理
├── migrations/             # SQL 迁移文件
├── public/                 # 前端静态资源
│   ├── index.html          # 监控中心（/app）
│   ├── auth.js             # 认证模块
│   ├── plan_service.js     # 套餐管理模块
│   ├── nav_shared.js       # 导航栏
│   ├── app.js / room_list.js / user_analysis.js / ...
│   └── landing/            # 落地页、认证页、用户中心、管理后台
└── doc/                    # 项目文档
```
