# JiMesh - Project Structure

**Location:** `/home/ji/projects/jimesh/`
**Original:** FreeLLMAPI (https://github.com/tashfeenahmed/freellmapi)
**Renamed:** lmesh → jimesh (2026-08-30)

---

## 📁 Directory Structure

```
/home/ji/projects/jimesh/
├── cli/                          # CLI tool (formerly freellmapi CLI)
├── frontend/                     # React Frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── ChatInterface.tsx       # NEW: Chat with Fallback Chains
│   │   │   ├── RoutingAnalytics.tsx    # NEW: Live Analytics Dashboard
│   │   │   ├── RealtimeMonitor.tsx     # NEW: Real-Time Monitor
│   │   │   └── ... (other components)
│   │   ├── hooks/
│   │   │   └── useRealtimeStore.ts     # NEW: Smart PubSub Store
│   │   ├── pages/
│   │   └── App.tsx                      # MODIFIED: Added new routes
├── server/                       # Express Backend
│   ├── src/
│   │   ├── services/
│   │   │   ├── router.ts                # MODIFIED: Core routing
│   │   │   ├── keyPool.ts               # NEW: KeyPoolManager
│   │   │   ├── deepseekHarness.ts       # NEW: DSH Integration
│   │   │   └── ... (other services)
│   │   ├── routes/
│   │   │   ├── sse.ts                   # NEW: SSE Endpoints
│   │   │   ├── routing-history.ts       # NEW: History API
│   │   │   └── ... (other routes)
│   │   └── app.ts                       # MODIFIED: Registered new routes
│   └── dist/                            # Compiled output
├── shared/                       # Shared TypeScript types
├── desktop/                      # Desktop app
├── docs/                         # Documentation
│   ├── FEATURE_ROADMAP.md       # NEW: Feature Backlog
│   ├── prompts/
│   │   └── CHAT_LOG.md          # NEW: All chat prompts
│   ├── sprints/
│   │   ├── SPRINT-0-FOUNDATION.md
│   │   ├── SPRINT-1-KEYPOOL.md
│   │   └── SPRINT-2-ROUTING-AND-DSH.md
│   └── ... (other docs)
├── docker-compose.yml            # Docker setup
├── Dockerfile                    # Docker image
├── package.json                  # Root package (@jimesh/monorepo)
└── README.md                     # Main README
```

---

## 🎯 What Changed from FreeLLMAPI

### Renamed
- `lmesh` → `jimesh`
- `@freellmapi/*` → `@jimesh/*`
- CLI: `freellmapi` → `jimesh`

### New Features Added

#### Backend
1. **KeyPoolManager** (`server/src/services/keyPool.ts`)
   - Cost-aware Cooldown für API Keys
   - Free Model Prioritization
   - Multi-Key Support

2. **DeepSeek Harness Integration** (`server/src/services/deepseekHarness.ts`)
   - CLI wrapper for `dsh` command
   - Fallback Logic
   - Tracing Support

3. **SSE Endpoints** (`server/src/routes/sse.ts`)
   - `/api/sse/analytics` - Routing Scores (5s)
   - `/api/sse/models` - Recent Requests (3s)
   - `/api/sse/traces` - Trace Events (2s)

4. **History API** (`server/src/routes/routing-history.ts`)
   - `/api/routing/history` - Recent routing decisions
   - `/api/routing/traces` - Trace logs
   - `/api/routing/score-history` - Score changes over time

#### Frontend
1. **Chat Interface** (`frontend/src/components/ChatInterface.tsx`)
   - Model Selection Dropdown
   - Fallback Chain Builder
   - Real-time Chat
   - Route: `/chat`

2. **Routing Analytics** (`frontend/src/components/RoutingAnalytics.tsx`)
   - Live Updates via SSE
   - Bar Charts, Radar Charts
   - Score Distribution
   - Route: `/routing-analytics`

3. **Real-Time Monitor** (`frontend/src/components/RealtimeMonitor.tsx`)
   - Request/Trace Streams
   - Timeline Charts
   - Activity Tables
   - Route: `/realtime-monitor`

4. **Smart Store** (`frontend/src/hooks/useRealtimeStore.ts`)
   - PubSub Pattern (like Trading Bot)
   - Only subscribes when visible
   - Auto-cleanup on unmount
   - Exponential Backoff Reconnect

### Modified Files
- `server/src/services/router.ts` - Fixed key loop, added KeyPoolManager integration
- `server/src/app.ts` - Registered new routes
- `frontend/src/App.tsx` - Added new routes

---

## 🚀 Quick Start

```bash
cd /home/ji/projects/jimesh

# Install dependencies (one-time)
npm install --cache /tmp/npm-cache

# Start server (port 3001)
cd server
PORT=3001 ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef npm start

# Start client (port 3000) - in another terminal
cd client
npm run dev

# Open browser
# Chat:         http://localhost:3000/chat
# Analytics:    http://localhost:3000/routing-analytics
# Monitor:      http://localhost:3000/realtime-monitor
```

---

## 📊 Build Status

✅ **Server builds successfully** (`npx tsc` in `server/`)
⚠️ **Client not yet built** (need to fix some TS errors)
✅ **All documentation created**
✅ **All files in correct location**

---

## 🔧 Next Steps

1. **Test server** - Start it and verify it works
2. **Build client** - Fix any remaining TS errors
3. **Test SSE endpoints** - Verify real-time updates work
4. **Test chat** - Verify fallback chains work
5. **Deploy** - Either Docker or local dev mode

---

## 📝 Notes

- **No symlinks** - jimesh is a real directory, not a symlink
- **Moved (not copied)** - jimesh was moved from `/home/ji/projects/trading/st-2/lmesh`
- **Old lmesh deleted** - No more references to `lmesh` anywhere
- **Trading bot unaffected** - st-2 directory is clean
