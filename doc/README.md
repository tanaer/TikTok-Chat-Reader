# TikTok-Chat-Reader 文档索引

本目录记录当前仓库的整体架构、核心业务流程、数据模型与对外接口。

> 代码以 `server.js` 为入口，数据库为 PostgreSQL。系统分为核心监控层和 SaaS 商业层。

## 文档列表

### 核心监控
- `doc/architecture.md`：系统架构与模块职责（采集层、服务层、展示层）
- `doc/runtime-flows.md`：关键业务流程（自动监控/录制、手动接入、断开与归档、用户分析/AI）
- `doc/data-model.md`：数据库表结构（核心表 + SaaS 表）
- `doc/api.md`：对外接口（Socket.IO 事件 + REST API，含认证/订阅/管理接口）
- `doc/config.md`：配置项（`.env`、`settings` 表中的 key）

### SaaS 商业层
- `doc/auth.md`：认证与授权（JWT 流程、中间件、前端 auth.js 模块）
- `doc/subscription.md`：订阅与套餐管理（套餐体系、购买流程、加量包、plan_service.js）
- `doc/frontend.md`：前端架构（页面地图、共享模块、监控中心结构、设计体系）
- `doc/deployment.md`：部署与运维（环境配置、数据库迁移、PM2、定时任务）

### 其他
- `doc/monitor-archive-robustness.md`：开播监控 → 下播归档链路的健壮性审视
- `doc/futongpay.md`：富通支付集成

## 快速定位入口

- 后端入口：`server.js`
- 自动录制服务：`auto_recorder.js`
- TikTok 连接封装：`connectionWrapper.js`
- 业务/查询层：`manager.js`
- DB 模块（PostgreSQL）：`db.js`
- 认证：`auth/middleware.js` + `auth/routes.js`
- 订阅：`api/subscription.js`
- 管理后台：`api/admin.js`
- 前端入口：`public/index.html`（监控中心）
- 前端认证：`public/auth.js`
- 前端套餐：`public/plan_service.js`
