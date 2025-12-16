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
- `proxy`：代理（canonical）
  - 兼容：UI/旧脚本如果保存的是 `proxy_url`，`manager.getAllSettings()` / `manager.getSetting()` 会自动映射到 `proxy`

### 2.2 Server 相关

`server.js` 启动端口读取：

- `port`（settings）
- `PORT`（env）
- 默认 `8081`

AI 配置读取：

- `ai_api_key`（settings）或 `AI_API_KEY`（env）
- `ai_api_url`（settings）或 `AI_API_URL`（env）

## 3) 历史 key 兼容（已统一到 canonical）

为兼容历史前端/脚本，本项目在 `manager.js` 对 settings key 做了兼容映射：

- `scan_interval` -> `interval`
- `proxy_url` -> `proxy`

行为约定：

- 读取：`manager.getSetting('interval')` 会在 `interval` 不存在时回退读取 `scan_interval`（`proxy` 同理）
- 保存：`manager.saveSetting(...)` 会把别名 key 统一写成 canonical key（DB 中以 `interval` / `proxy` 为准）
- 批量读取：`manager.getAllSettings()` 会在 canonical 缺失时用别名回填（保证 AutoRecorder/Server 读取一致）

因此即使前端 `public/config.js` 仍然发送 `scan_interval` / `proxy_url`，AutoRecorder 也能正确读取并生效。
