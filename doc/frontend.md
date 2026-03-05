# 前端架构（Frontend）

## 页面地图

```
/                         → 首页（landing/index.html）  — 公开，无需认证
/app                      → 监控中心（index.html）      — 需认证 + 有效订阅
/landing/login.html       → 登录
/landing/register.html    → 注册
/landing/user-center.html → 用户中心                   — 需认证
/landing/admin.html       → 管理后台                   — 需 admin 角色
```

路由在 `server.js` 定义：
- `GET /` → `landing/index.html`（`res.sendFile`，优先于 static middleware）
- `GET /app` → `index.html`
- 其他页面由 `express.static('public')` 直接提供

## 共享模块

| 文件 | 职责 |
|------|------|
| `auth.js` | Token 管理、fetch/jQuery 拦截器、`initPage()`、`injectUserMenu()` |
| `plan_service.js` | 套餐加载/渲染/购买的集中模块 |
| `nav_shared.js` | 跨页面导航栏（根据认证状态显示不同链接） |
| `style.css` | 全局样式：glass morphism、gradient utilities、dark-table 等 |

### 加载顺序

所有页面统一按以下顺序加载共享模块：
```html
<script src="/auth.js"></script>
<script src="/plan_service.js"></script>
<script src="/nav_shared.js"></script>
```

## 监控中心模块（`/app`）

| 文件 | 负责 Tab | 核心功能 |
|------|---------|---------|
| `app.js` | — | Socket.IO 连接、事件分发、房间详情视图 |
| `room_list.js` | 房间列表 | 房间卡片渲染、添加/编辑/删除房间 |
| `user_analysis.js` | 用户分析 | 用户榜单、详情 slide-over、AI 分析 |
| `room_analysis.js` | 房间分析 | 房间级别统计图表 |
| `recording_ui.js` | 录制管理 | 录制状态、下载、配置 |

### 导航结构（两级）

```
┌─ 全局导航（sticky top-0 z-50）─────────────────────────┐
│  Brand  │  首页  │  用户中心  │  管理后台(admin)  │ 头像 │
└──────────────────────────────────────────────────────────┘
┌─ 二级 Tab（sticky top-14 z-40）────────────────────────┐
│  房间列表  │  用户分析  │  房间分析  │  录制管理  │
└──────────────────────────────────────────────────────────┘
```

`switchSection(name, btn)` 切换 `.content-section` 的 display。
`initPage.onReady(user)` 按角色移除 `.admin-only` 元素。

## 设计体系

- **CSS 框架**: DaisyUI v4 + TailwindCSS CDN
- **主题**: `data-theme="dark"`
- **字体**: Google Fonts - Inter
- **主色板**: Indigo gradient (`#6366f1` → `#818cf8`)
- **玻璃效果**: `.glass-card`（`backdrop-filter:blur(16px)` + 半透明背景 + 边框）
- **渐变文字**: `.gradient-text-primary`
- **渐变按钮**: `.gradient-btn`
- **动画**: `@keyframes fadeInUp` / `pulse-glow` / `breath`

## 依赖（CDN）

| 库 | 版本 | 用途 |
|-----|------|------|
| DaisyUI | 4.12.2 | UI 组件（modal, badge, table, btn 等）|
| TailwindCSS | CDN latest | 工具类（flex, grid, spacing 等）|
| jQuery | 3.x | DOM 操作 + AJAX（历史代码，app.js 等）|
| Socket.IO Client | 4.x | 实时事件推送 |
| Chart.js | 4.x | 数据可视化图表 |
