# 订阅与套餐管理（Subscription）

## 套餐体系

### 数据库表：`subscription_plans`

| 列名 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | 自增主键 |
| name | VARCHAR(50) | 套餐名称（免费版/基础版/专业版/企业版） |
| code | VARCHAR(20) | 唯一标识（free/basic/pro/enterprise） |
| price_monthly | INTEGER | 月付价格（分） |
| price_quarterly | INTEGER | 季付价格（分） |
| price_annual | INTEGER | 年付价格（分） |
| room_limit | INTEGER | 房间数量限制（-1 = 无限） |
| history_days | INTEGER | 历史数据保留天数 |
| ai_credits_monthly | INTEGER | 每月 AI 分析额度 |
| api_rate_limit | INTEGER | API 每分钟调用限制 |
| feature_flags | JSONB | 功能开关（扩展字段） |
| is_active | BOOLEAN | 是否上架 |
| sort_order | INTEGER | 排序 |

> **重要**：`db.js` 的 `query()` 函数对所有结果应用 `toCamelCase`，因此 API 返回的字段名为 camelCase（如 `roomLimit`、`priceMonthly`），而非 DB 列名。

### 当前套餐

| 套餐 | 月价 | 房间数 |
|------|------|--------|
| 基础版 basic | ¥29 | 5 |
| 专业版 pro | ¥99 | 20 |
| 企业版 enterprise | ¥299 | 无限 |

## 购买流程

```
用户点击"立即订阅"
  → PlanService.purchasePlan(planCode, billingCycle)
  → POST /api/subscription/purchase { planCode, billingCycle }
  → 后端：
    1. 查找套餐 → 计算价格（按 billingCycle 选择 monthly/quarterly/annual）
    2. 检查余额 ≥ 价格
    3. 如有旧订阅 → 计算剩余价值 → 按比例退款
    4. 创建 user_subscriptions 记录
    5. 扣除余额 → 写 balance_logs
    6. 发送系统通知
```

### 按比例退款（Proration）

升级/更换套餐时系统自动计算旧订阅剩余天数的价值并退回余额：

```
剩余天数 = (旧订阅 end_date - 当前时间) / (1天)
退款金额 = 旧订阅总价 × (剩余天数 / 总天数)
```

## 加量包系统

### 数据库表：`room_addon_packages`

| 列名 | 说明 |
|------|------|
| name | 加量包名称 |
| room_count | 额外房间数 |
| price_monthly | 月价（分） |

### 购买流程

```
POST /api/subscription/addon/purchase { packageId, billingCycle }
→ 验证有付费订阅 → 扣余额 → 创建 user_room_addons 记录
```

## 自动续费（`cron_jobs.js`）

定时任务处理：
- **即将到期提醒**：到期前 3 天发送通知
- **自动续费**：到期当天自动从余额扣费续期
- **过期处理**：无余额 → 标记 `status = 'expired'`

## 前端：`plan_service.js`

集中管理套餐数据的加载、渲染和购买。所有页面引用同一模块：

```html
<script src="/plan_service.js"></script>
```

### API

| 方法 | 说明 |
|------|------|
| `PlanService.loadPlans()` | 获取 `{plans, addons, balance}`，有缓存 |
| `PlanService.openPlanModal()` | 打开套餐选择弹窗（自动注入 DOM） |
| `PlanService.renderPlanCards(el, plans, opts)` | 渲染套餐卡片网格 |
| `PlanService.renderAddonCards(el, addons, opts)` | 渲染加量包卡片 |
| `PlanService.renderPlanTableRows(plans)` | 渲染管理后台表格行 |
| `PlanService.renderLandingPlanCards(el, plans, opts)` | 渲染首页定价卡片 |
| `PlanService.purchasePlan(code, cycle, name, price)` | 购买套餐 |
| `PlanService.purchaseAddon(id, name, price)` | 购买加量包 |

### 字段映射

API 返回 camelCase（经 `db.js toCamelCase`），`plan_service.js` 统一使用 camelCase：

| API 字段 | DB 列 | 说明 |
|----------|-------|------|
| `roomLimit` | `room_limit` | 房间限制 |
| `priceMonthly` | `price_monthly` | 月价 |
| `priceQuarterly` | `price_quarterly` | 季价 |
| `priceAnnual` | `price_annual` | 年价 |
| `aiCreditsMonthly` | `ai_credits_monthly` | 月度 AI 额度 |
| `historyDays` | `history_days` | 数据保留天数 |

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/subscription` | 当前用户订阅详情+余额 |
| GET | `/api/subscription/plans` | 所有可用套餐+加量包+余额 |
| POST | `/api/subscription/purchase` | 购买/升级套餐 |
| POST | `/api/subscription/addon/purchase` | 购买加量包 `{ packageId, billingCycle }` |
