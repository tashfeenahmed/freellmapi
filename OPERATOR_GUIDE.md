# JiMesh - Operator Guide

## Real-Time Features (Implemented)

### 1. DeepSeek Harness Integration

**Status:** ✅ Implemented
**Files:**
- `server/src/services/deepseekHarness.ts` - Service wrapper
- `server/src/services/router.ts` - Integrated as final fallback

**What it does:**
- DeepSeek Harness available as CLI tool (`dsh` command)
- Used as last-resort fallback when all other providers fail
- Provides tracing via `traceWithDeepSeekHarness()`

**Usage:**
```bash
# Check if DeepSeek Harness is available
dsh --version

# Test fallback (when all providers fail)
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "nonexistent-model", "messages": [{"role": "user", "content": "test"}]}'
# Will fall through to DeepSeek Harness as last resort
```

---

### 2. Chat Interface for Fallback Chains

**Status:** ✅ Implemented
**Files:**
- `client/src/components/ChatInterface.tsx` - React component
- Route: `/chat`

**Features:**
- Model selection dropdown
- Fallback chain builder (add/remove models)
- Real-time chat with selected model
- Automatic fallback via JiMesh routing
- Error display
- Message history

**Usage:**
1. Open `http://localhost:3000/chat`
2. Select primary model from dropdown
3. Add fallback models (will be tried automatically by JiMesh)
4. Start chatting

---

### 3. Routing Analytics Dashboard

**Status:** ✅ Implemented
**Files:**
- `client/src/components/RoutingAnalytics.tsx` - React component
- `server/src/routes/sse.ts` - SSE endpoint
- `server/src/services/router.ts` - `getRoutingScores()` function
- Route: `/routing-analytics`

**Features:**
- **Real-time updates** via Server-Sent Events (SSE)
- **Smart subscription** - only connects when component is visible
- **Automatic reconnection** with exponential backoff
- **Live indicator** (green/red dot showing connection status)
- **Summary cards:**
  - Average reliability
  - Average speed
  - Total requests
  - Low reliability count
- **Top 10 Models Bar Chart** (score, reliability, speed)
- **Radar Chart** for top 5 models (multi-axis comparison)
- **Score Distribution** histogram
- **Detailed scores table** with all metrics

**Usage:**
1. Open `http://localhost:3000/routing-analytics`
2. SSE connection opens automatically
3. Data updates every 5 seconds
4. Close tab → SSE connection closes automatically

---

### 4. Real-Time Monitor

**Status:** ✅ Implemented
**Files:**
- `client/src/components/RealtimeMonitor.tsx` - React component
- `server/src/routes/sse.ts` - SSE endpoints
- Route: `/realtime-monitor`

**Features:**
- **Real-time request stream** via SSE
- **Real-time trace stream** via SSE
- **Smart subscription** - only connects to visible data
- **Timeline chart** (last 60 seconds, 5-second buckets)
- **Model stats** (requests, errors, latency per model)
- **Recent activity table** (last 50 events)
- **Toggle between Requests and Traces views**
- **Live status indicator**

**Usage:**
1. Open `http://localhost:3000/realtime-monitor`
2. Choose "Requests" or "Traces" view
3. SSE connection opens for the selected view
4. Switch views → connections switch automatically
5. Close tab → all connections close

---

### 5. SSE Backend Endpoints

**Status:** ✅ Implemented
**Files:**
- `server/src/routes/sse.ts` - SSE router
- Registered at: `/api/sse/*`

**Endpoints:**

#### `GET /api/sse/analytics`
- Streams routing scores
- Updates every 5 seconds
- Event: `scores`

#### `GET /api/sse/models`
- Streams recent model requests
- Updates every 3 seconds
- Event: `requests`

#### `GET /api/sse/traces`
- Streams trace events
- Updates every 2 seconds
- Event: `traces`

**Features:**
- Automatic heartbeat (every 30s)
- Cleanup on disconnect
- Manual broadcast function (`broadcastSSE()`)

---

## Smart Store Pattern (PubSub)

**Status:** ✅ Implemented
**Files:**
- `client/src/hooks/useRealtimeStore.ts` - SSE connection manager + hooks

**How it works:**

```typescript
// Hook usage (automatic subscribe/unsubscribe)
function MyComponent() {
  const { scores, connected } = useRealtimeScores()
  // SSE connection opens when component mounts
  // SSE connection closes when component unmounts

  return <div>{scores.length} models</div>
}
```

**Benefits:**
- ✅ Only subscribes when component is visible
- ✅ Automatic cleanup on unmount
- ✅ Exponential backoff reconnection
- ✅ Connection status tracking
- ✅ Multiple components can share same SSE stream

---

## Summary

| Feature | JiMesh | JiMesh | Status |
|---------|-----------|-------|--------|
| **DeepSeek Harness** | ❌ | ✅ | Implemented |
| **Chat Interface** | ❌ | ✅ | Implemented |
| **Routing Analytics** | ❌ | ✅ | Implemented |
| **Real-Time SSE** | ❌ | ✅ | Implemented |
| **Smart Store (PubSub)** | ❌ | ✅ | Implemented |
| **Trace Streaming** | ❌ | ✅ | Implemented |
| **Automatic Reconnect** | ❌ | ✅ | Implemented |
| **Connection Status** | ❌ | ✅ | Implemented |

---

## Next Steps

1. **Test all features** in development
2. **Add navigation links** to new pages in the menu
3. **Add authentication** to SSE endpoints (if not already)
4. **Monitor SSE performance** (check backend logs)
5. **Add more SSE endpoints** as needed (e.g., per-model stats, per-key stats)

---

## Quick Start

```bash
# Start JiMesh server
cd JiMesh/server
pnpm dev

# Start JiMesh client
cd JiMesh/client
pnpm dev

# Open in browser
# Chat:        http://localhost:3000/chat
# Analytics:   http://localhost:3000/routing-analytics
# Monitor:     http://localhost:3000/realtime-monitor
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   React Frontend                        │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Chat         │  │ Analytics    │  │ Monitor      │ │
│  │ Interface    │  │ Dashboard    │  │ (Real-Time)  │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                  │                  │         │
│         │   useRealtimeScores()              │         │
│         │                  │                  │         │
│         └──────────────────┼──────────────────┘         │
│                            │                            │
│                   ┌────────▼────────┐                   │
│                   │ SSE Connection  │                   │
│                   │ Manager         │                   │
│                   │ (Smart Store)   │                   │
│                   └────────┬────────┘                   │
└────────────────────────────┼────────────────────────────┘
                             │
                    EventSource (SSE)
                             │
┌────────────────────────────▼────────────────────────────┐
│                   Express Backend                        │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ /sse/        │  │ /sse/        │  │ /sse/        │ │
│  │ analytics    │  │ models       │  │ traces       │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                  │                  │         │
│         └──────────────────┼──────────────────┘         │
│                            │                            │
│                   ┌────────▼────────┐                   │
│                   │  Router + DB    │                   │
│                   │  (getRouting    │                   │
│                   │   Scores)       │                   │
│                   └─────────────────┘                   │
└──────────────────────────────────────────────────────────┘
```

**Key Points:**
- **Frontend:** Components subscribe via hooks → SSE connection opens
- **Backend:** SSE endpoints stream data on intervals
- **Smart Store:** Only connects when component is visible
- **Automatic cleanup:** Connections close when components unmount
