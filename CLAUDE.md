# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TikTok Chat Reader / Monitor is a SaaS platform for monitoring TikTok LIVE streams. It captures chat messages, gifts, likes, and other events from live broadcasts, Features include user subscriptions, balance-based payments, admin management, and AI-powered user analysis.

**Tech Stack:** Node.js + Express + PostgreSQL + Socket.IO + TikTok-Live-Connector

## Development Commands

```bash
# Install dependencies
npm install

# Run in production
npm start                 # -> node server.js

# Run in development (with logging)
npm run dev              # -> node scripts/start_dev.js

# Run database migrations
node run_migration.js

# Quick scripts (see scripts/ folder)
node scripts/seed_admin.js    # Create admin user
node scripts/check_room.js    # Inspect room data
```

## Architecture

### Core Entry Points

| File | Purpose |
|------|---------|
| `server.js` | Main entry - Express REST API + Socket.IO server |
| `auto_recorder.js` | Background monitoring loop - maintains persistent TikTok connections |
| `manager.js` | Business logic layer - rooms, sessions, events, statistics |
| `db.js` | PostgreSQL connection pool with helper methods |

### Key Data Flow

1. **AutoRecorder.monitor()** scans enabled rooms periodically
2. **TikTokConnectionWrapper** connects to TikTok LIVE via tiktok-live-connector
3. Events (chat/gift/member/like) flow: TikTok → wrapper → `manager.logEvent()` → PostgreSQL
4. Browser clients subscribe via Socket.IO; events are forwarded from existing AutoRecorder connections
5. When stream ends, events are archived into sessions via `manager.createSession()` + `tagEventsWithSession()`

### Database (PostgreSQL)

Tables are created via migrations in `migrations/*.sql`. Key tables:
- `users`, `subscription_plans`, `user_subscriptions` - User & billing
- `room`, `session`, `event`, `user` - TikTok monitoring data
- `payment_records`, `payment_qr_codes`, `balance_log` - Payments
- `user_room`, `user_room_addons`, `room_addon_packages` - Multi-tenant room assignments

**Important:** This project migrated from SQLite to PostgreSQL. Use `$1, $2` parameterized queries via `db.query()`, `db.get()`, `db.run()`.

### Authentication & Authorization

Located in `auth/middleware.js`:
- `requireAuth` - JWT token validation
- `requireAdmin` - Admin role check
- `loadSubscription` - Loads user's active subscription into `req.subscription`
- `checkRoomLimit` - Enforces room count limits based on subscription

### API Routes

Routes are modularized in `api/`:
- `api/admin.js` - Admin-only: user management, plans, addons, QR codes, orders
- `api/subscription.js` - Plans, subscription status, purchasing with balance
- `api/payment.js` - Balance, recharge, payment flow
- `api/user_rooms.js` - User's room assignments

### Frontend

Located in `public/`:
- `landing/` - Marketing pages (index.html, subscription.html, user-center.html, admin.html)
- `public/index.html` + `app.js` - Main monitor dashboard (requires auth)
- `auth.js` - Client-side auth state, token refresh
- `plan_service.js` - Subscription modal logic

Frontend uses DaisyUI + TailwindCSS loaded from CDN.

## Configuration

Environment variables in `.env`:
```
PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD  # PostgreSQL connection
JWT_SECRET                                          # JWT signing key
PORT=8081                                           # Server port
PROXY_URL                                           # SOCKS5 proxy for TikTok
EULER_API_KEY                                       # EulerStream API (optional)
```

## Common Patterns

### Database Queries
```javascript
const db = require('./db');

// Multiple rows
const rows = await db.query('SELECT * FROM users WHERE status = $1', ['active']);

// Single row
const user = await db.get('SELECT * FROM users WHERE id = $1', [userId]);

// Insert/Update
await db.run('UPDATE users SET nickname = $1 WHERE id = $2', [name, id]);
```

### Session Archiving
When a TikTok stream ends, the system archives events into a session:
1. `manager.getUntaggedEventCount(roomId, startTime)` - Check for events
2. `manager.createSession(roomId, snapshot)` - Create session record
3. `manager.tagEventsWithSession(roomId, sessionId, startTime)` - Tag events with session_id

Events with `session_id IS NULL` are "live" data; events with a session_id are archived.

### Adding New API Endpoints
1. Add route in appropriate file under `api/`
2. Import middleware: `const { requireAuth, loadSubscription } = require('../auth/middleware');`
3. Register in `server.js`: `app.use('/api/your-module', require('./api/your-module'));`

## Documentation

- `doc/runtime-flows.md` - Detailed runtime flow documentation (startup, monitoring, archiving)
- `doc/monitor-archive-robustness.md` - Robustness review for session archiving
