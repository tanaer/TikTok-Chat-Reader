# TikTok-Chat-Reader 文档索引

这份目录是给“以后我自己快速回忆系统结构”用的：记录当前仓库里 **Node.js 版本** 的整体架构、核心业务流程、数据模型与对外接口。

> 代码以 `server.js` 为入口；仓库里还保留了一套 Python（Flask + TikTokLive）实现，但从 README 和依赖来看当前主线是 Node.js。

## 文档列表

- `doc/architecture.md`：系统架构与模块职责（从后端到前端）
- `doc/runtime-flows.md`：关键业务流程（自动监控/录制、手动接入、断开与归档、用户分析/AI）
- `doc/data-model.md`：数据库与数据模型（`data.db`、表结构、字段含义、索引与迁移）
- `doc/api.md`：对外接口（Socket.IO 事件 + REST API）
- `doc/config.md`：配置项（`.env`、`settings` 表中的 key、历史 key 兼容映射）
- `doc/monitor-archive-robustness.md`：开播监控 → 下播归档链路的健壮性审视与改进点

## 快速定位入口

- 后端入口：`server.js`
- 自动录制服务：`auto_recorder.js`
- TikTok 连接封装：`connectionWrapper.js`
- 业务/查询层：`manager.js`
- DB 模块（sql.js + 落盘）：`db.js`
- 前端（静态资源）：`public/index.html` + `public/*.js`
