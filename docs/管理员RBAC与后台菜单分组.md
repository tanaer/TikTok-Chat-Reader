# 管理员RBAC与后台菜单分组

## 背景

为解决后台管理员只有 `admin / user` 二值权限的问题，系统引入了管理员 RBAC（角色权限控制）机制，并同步对管理后台侧栏进行分组折叠改造，确保：

- 菜单可见性与接口权限一致。
- 管理员账号可以按职责最小授权。
- 历史管理员账号可平滑迁移，不影响线上使用。

## 数据模型

新增两张表：

- `admin_role`
  - 角色基础信息：`code`、`name`、`description`
  - 权限集合：`permissions_json`
  - 系统角色标记：`is_system`
- `user_admin_role`
  - 管理员用户与后台角色绑定关系
  - 记录分配人和分配时间

说明：

- 一个管理员账号绑定一个后台角色（简化模型）。
- 权限列表存储在 `permissions_json`，不再单独拆 `role_permission` 明细表。

## 权限域与权限点

当前后台权限点按业务域组织：

- 总览与经营
  - `overview.view`
  - `users.manage`
  - `orders.manage`
  - `plans.manage`
  - `gifts.manage`
- 支付与通知
  - `payments.manage`
  - `notifications.manage`
- AI 与通道
  - `ai_work.manage`
  - `prompts.manage`
  - `ai_channels.manage`
  - `euler_keys.manage`
- 系统与运维
  - `session_maintenance.manage`
  - `settings.manage`
  - `smtp.manage`
  - `docs.manage`
  - `admins.manage`

## 默认系统角色

系统初始化自动种子以下角色：

- `super_admin`：全权限（`*`）
- `ops_admin`：运营相关
- `finance_admin`：支付/订单/通知相关
- `ai_admin`：AI/通道/场次运维相关

系统角色为只读，不允许在后台编辑或删除。

## 历史管理员兼容

对历史数据做兼容策略：

- 若 `users.role='admin'` 但未绑定 `user_admin_role`，识别为历史管理员。
- 历史管理员默认按全权限处理（兼容上线前行为）。
- 后续可在“管理员管理”页面显式绑定角色，完成规范化迁移。

## 后端拦截策略

### `/api/admin/*` 路由

在 `routes/admin.js` 内新增路径到权限点映射，按接口自动校验：

- 示例：
  - `GET /api/admin/stats` -> `overview.view`
  - `/api/admin/users*` -> `users.manage`
  - `/api/admin/session-maintenance*` -> `session_maintenance.manage`
  - `/api/admin/admin-access*` -> `admins.manage`（`/me` 例外）

### 支付后台路由

`routes/paymentAdmin.js` 增加权限拦截：

- `/config*` 与订单人工处理 -> `payments.manage`
- `/pushplus-config*` -> `notifications.manage`

### `server.js` 直挂管理接口

原先仅 `requireAdmin` 的配置与运维接口增加细粒度校验：

- `settings/config` 写入 -> `settings.manage`
- 场次维护/修复/迁移/调试相关 -> `session_maintenance.manage`

此外，`/api/config` 与 `/api/settings` 的读取结果按权限收敛：

- 拥有 `settings.manage` 的管理员可读取完整配置。
- 其他管理员和普通用户读取脱敏配置。

## 管理后台菜单分组

侧栏改为一级分组 + 二级菜单折叠：

- 系统概览（一级直达）
- 经营管理
- 支付与通知
- AI 与通道
- 系统与运维

新增菜单：

- `管理员管理`（归入“系统与运维”）

前端根据 `/api/admin/admin-access/me` 返回的权限动态隐藏菜单项；若某一级分组下无可见二级项，则该分组整体隐藏。

## 管理员管理页面能力

新增 `sec-adminAccess` 页面，支持：

- 查看当前管理员权限画像
- 查看管理员账号列表并重绑角色
- 搜索候选用户并提升为管理员
- 查看系统角色与自定义角色
- 创建/编辑/删除自定义角色

系统角色保持只读，防止误改基础权限边界。

