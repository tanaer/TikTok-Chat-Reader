# 配置与参数（.env + settings）

本项目的配置来源主要有两类：

1. 环境变量（`.env`，由 `dotenv` 加载）
2. 数据库 `settings` 表（通过 UI 写入，或直接写库）

## 1) 环境变量（.env / .env.example）

示例文件：`.env.example`

- `PROXY_URL`
  - SOCKS5 代理地址，例如：`socks5://127.0.0.1:1080`
  - `connectionWrapper.js` 会使用它作为默认代理

- `EULER_API_KEY`
  - EulerStream API Key（用于 `tiktok-live-connector` 的签名/请求能力）
  - 映射到 `connectionWrapper.js` 中的 `SignConfig.apiKey`

- `SESSIONID`
  - 可选：TikTok Session ID（cookie），用于提升某些请求成功率

- `PORT`
  - Node 服务端口（如果 `settings.port` 未配置，则使用它）

## 2) settings 表中的 key（Node 实际读取的部分）

读取位置主要在：

- `server.js`：端口、AI 配置
- `auto_recorder.js`：监控间隔、全局开关、连接参数
- `public/config.js`：UI 展示/保存

### 2.1 AutoRecorder 相关

`auto_recorder.js` 当前使用的 key（重要）：

- `auto_monitor_enabled`
  - 值：`'true'/'false'`（字符串）或 boolean
  - 含义：全局是否自动监控扫描

- `interval`
  - 值：分钟（字符串数字）
  - 含义：AutoRecorder 扫描间隔（默认 5 分钟）

连接参数来自 `manager.getAllSettings()`：

- `session_id`：用于 TikTok 连接的 sessionId
- `euler_api_key`：EulerStream Key（传给 wrapper）
- `proxy` / `proxy_url`：代理
  - 自动扫描连接（`checkAndConnect`）目前读取的是 `proxy`
  - 手动启动连接（`startRoom`）会优先读 `proxy_url`，其次读 `proxy`

### 2.2 Server 相关

`server.js` 启动端口读取：

- `port`（settings）
- `PORT`（env）
- 默认 `8081`

AI 配置读取：

- `ai_api_key`（settings）或 `AI_API_KEY`（env）
- `ai_api_url`（settings）或 `AI_API_URL`（env）

## 3) 当前代码里存在的“key 命名不一致”现象

前端 `public/config.js` 保存配置时发送的 key：

- `scan_interval`
- `proxy_url`
- 以及：`auto_monitor_enabled` / `euler_api_key` / `session_id` / `port` / `ai_api_key` / `ai_api_url`

但 AutoRecorder 实际读取的是：

- 扫描间隔：`interval`（不是 `scan_interval`）
- 代理：自动扫描读 `proxy`（不是 `proxy_url`），手动启动才兼容 `proxy_url`

因此如果仅通过当前 UI 保存配置：

- 可能出现“UI 显示已保存，但 AutoRecorder 没按预期使用新配置”的情况

这是一个需要后续统一/映射 key 的点（建议在 `server.js` 的 settings 保存层或 `manager.getSetting` 层做兼容映射）。

