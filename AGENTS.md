# AGENTS.md

## Repo Rules

### Commit Policy
- All future git commit messages must be written in Chinese.
- Prefer Conventional Commits, but keep the type/scope structure readable with a Chinese summary and body.

### Instruction Hygiene
- 不要把用户给 Codex 的操作要求、提示词、审阅意见、协作规则原样写进业务代码、页面文案、注释、配置、测试数据或日志文案，除非用户明确要求这些文字本身成为产品内容的一部分。
- 区分“实现要求”和“交付内容”：前者用于指导实现，后者才进入程序。
- 需要长期保留的协作偏好，优先记录到 `AGENTS.md`、相关文档或记忆文件，不要混入应用产物。

### AI 点数消耗确认
- 凡是会消耗 AI 点数、额度、余额或其他可计费资源的用户操作，默认必须设计为二次确认后才能真正执行，除非用户明确要求取消该保护。
- 二次确认要明确提示“将发生扣点/消耗”，避免把查看、试算、预览与真实扣点操作做成相同交互。
- 涉及 AI 点数消耗的按钮、菜单、批量操作、自动触发流程或管理台功能，在交付前都要检查是否存在误触扣点风险。

### Security First
- Treat every API response as public unless the route is explicitly admin-only.
- For user-facing APIs, use explicit response whitelists. Do not return raw database rows or raw `metadata` blobs directly.
- Do not use `SELECT *` on user-facing order, payment, auth, profile, or settings endpoints unless the result is immediately mapped to a strict whitelist object.
- Never expose gateway or upstream payment internals to non-admin users, including `channelRequest`, `upstream`, `notifyPayload`, signatures, tokens, callback URLs, provider configs, raw payment methods, or other transport/debug fields.
- When adding new fields under payment/order `metadata`, decide whether each field is `admin-only` or `user-safe` before exposing it anywhere.
- Frontend convenience is not a security boundary. If a field is not required by the UI, remove it from the server response.

### Required Review For Route Changes
- Any change touching `routes/`, `services/paymentService.js`, auth, payment, order, or user data must include a quick response-surface review before finishing.
- Check all affected endpoints for:
  - role boundary mistakes (`user` vs `admin`)
  - secret leakage
  - raw upstream payload leakage
  - over-broad `metadata` exposure
  - unnecessary identifiers or internal fields in JSON responses

### Preferred Pattern
- Query only needed columns where practical.
- Serialize on the server with separate functions for:
  - admin/full detail
  - user/payment detail
  - user/order list summary
- Default to the smallest safe payload, then add fields only when a concrete UI need exists.

### Documentation Policy
- All system design, architecture, core mechanism, and important performance changes must be written into `docs/` as Markdown.
- Every new architecture or mechanism document must start with a clear first-level heading in the form `# 标题`.
- The admin doc center uses the first `#` heading as the display name, so titles must be explicit and readable.
- When a change affects system structure, data flow, permissions, quotas, payments, analysis, recording, or major performance behavior, update an existing doc or add a new one under `docs/`.
