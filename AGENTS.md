# AGENTS.md

## Repo Rules

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
