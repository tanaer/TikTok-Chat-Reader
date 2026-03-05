# 认证与授权（Auth）

## 架构概览

```
auth/
├── routes.js      # 注册/登录/Profile API
└── middleware.js   # requireAuth / loadSubscription / requireAdmin

public/
├── auth.js         # 前端认证模块（token 管理、interceptor、UI 注入）
└── plan_service.js # 套餐管理模块
```

## JWT Token 流程

采用 **Access + Refresh Token** 双 Token 方案：

- **Access Token**: 有效期 24h，包含 `{ id, email, role }`
- **Refresh Token**: 有效期 7d，存储在 `users.refresh_token` 列

### 登录流程

```
POST /api/auth/login { email, password }
  → bcrypt.compare → 生成 accessToken + refreshToken
  → 返回 { accessToken, refreshToken, user }
```

### Token 刷新

```
POST /api/auth/refresh { refreshToken }
  → 验证 refreshToken → 签发新 accessToken
  → 返回 { accessToken }
```

### 前端存储

- `localStorage.accessToken` — Access Token
- `localStorage.refreshToken` — Refresh Token

## 中间件

### `requireAuth`（`auth/middleware.js`）

从 `Authorization: Bearer <token>` 提取 JWT，验证后将 `req.user` 注入：
- `req.user = { id, email, role }`
- 401 → 未提供或无效 Token

### `loadSubscription`（`auth/middleware.js`）

加载用户当前有效订阅信息并注入 `req.subscription`：
- 查询 `user_subscriptions JOIN subscription_plans`
- 无有效订阅 → 降级为免费版 (`plan_code = 'free'`, `plan_room_limit = 1`)
- 计算 `addonRooms`（加量包额外房间数）和 `totalRoomLimit`

### `requireAdmin`（`auth/middleware.js`）

检查 `req.user.role === 'admin'`，非管理员返回 403。

## 前端认证模块（`public/auth.js`）

### Fetch Interceptor

拦截所有 `fetch()` 调用，自动注入 `Authorization` 请求头：

```javascript
const _originalFetch = window.fetch;
window.fetch = async function(url, opts) {
    if (url.toString().startsWith('/api/')) {
        opts.headers['Authorization'] = 'Bearer ' + token;
    }
    // 401 → 自动尝试 refresh → 重试
};
```

### jQuery AJAX Prefilter

对 `$.get`/`$.post`/`$.ajax` 生效：

```javascript
$.ajaxSetup({
    beforeSend(xhr, settings) {
        if (settings.url?.startsWith('/api/')) {
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        }
    }
});
```

### `initPage(options)`

页面级初始化函数，支持：
- `requireAuth: true` — 未登录自动跳转 `/landing/login.html`
- `requireAdmin: true` — 非管理员跳转 404
- `checkQuota: true` — 检查订阅是否有效，过期显示 `quotaGateOverlay`
- `onReady(user)` — 验证通过后回调

### `injectUserMenu(user, containerId)`

向 `#containerId` 注入用户头像下拉菜单（昵称、角色 badge、用户中心链接、退出按钮）。

## 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册新用户 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/refresh` | 刷新 Token |
| GET | `/api/auth/me` | 获取当前用户信息 |
| PUT | `/api/auth/profile` | 更新昵称 |
| PUT | `/api/auth/password` | 修改密码 |
| GET | `/api/auth/notifications` | 通知列表 |
| PUT | `/api/auth/notifications/:id/read` | 标记已读 |
| PUT | `/api/auth/notifications/read-all` | 全部已读 |
