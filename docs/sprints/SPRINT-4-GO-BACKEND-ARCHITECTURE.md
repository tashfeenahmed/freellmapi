# Sprint 4: Go Backend Architecture - gRPC + Redis Streams + HTTP/3

**Duration:** 2026-08-31 → 2026-09-07  
**Status:** 📋 Planned  
**Goal:** Replace Node.js backend with high-throughput Go backend using gRPC (protobuf SSOT), Redis Streams for real-time pub/sub, HTTP/3 for efficient REST, while keeping protobuf schemas as single source of truth for language-agnostic model and chain definitions.

---

## 🎯 Sprint Goals

1. **Go Backend Migration** - Replace Node.js/TypeScript backend with Go
2. **gRPC + Protobuf as SSOT** - Single source of truth for all languages (Go/Python/TS/Rust)
3. **Redis Streams Pub/Sub** - Real-time event streaming (like Trading Bot)
4. **HTTP/3 Support** - quic-go for efficient REST
4. **Flexible Fallback Chains** - User favorites, paid model tags, per-key model assignment
5. **FlexGrid/RaphBuilder UI** - Drag-drop chain builder with smart routing overlay
6. **API Key Auto-Discovery** - Auto-detect and register provider keys

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        JIMESH ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐         │
│  │  Client Apps │    │  DSH Agent   │    │  Trading Bot │         │
│  │  (Python/TS/ │    │  (Go/Python) │    │  (Python)    │         │
│  │   Rust/Go)   │    │              │    │              │         │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘         │
│         │                   │                   │                  │
│         ▼                   ▼                   ▼                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    gRPC Gateway (HTTP/1.1 + HTTP/2 + HTTP/3) │  │
│  │                      Port 8080 / 8443                        │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                      │
│         ┌───────────────────┼───────────────────┐                 │
│         ▼                   ▼                   ▼                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐           │
│  │  gRPC API   │    │  REST API   │    │  WebSocket  │           │
│  │  (Port 5051)│    │  /v1/*      │    │  /ws/*      │           │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘           │
│         │                  │                  │                   │
│         └──────────────────┼──────────────────┘                   │
│                            ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    SERVICE LAYER (Go)                       │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────┐   │  │
│  │  │ Router  │  │KeyPool  │  │ Store   │  │  Streams    │   │  │
│  │  │(Bandit) │  │(Cooldown)│  │(SQLite) │  │(Redis Str.) │   │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────────┘   │  │
│  └──────────────────────────┬──────────────────────────────────┘  │
│                             │                                      │
│         ┌───────────────────┼───────────────────┐                 │
│         ▼                   ▼                   ▼                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐           │
│  │   Redis     │    │  SQLite     │    │  Providers  │           │
│  │  (Streams)  │    │  (WAL mode) │    │  (34 APIs)  │           │
│  └─────────────┘    └─────────────┘    └─────────────┘           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 📋 Tasks

### Task 4.1: Go Backend Foundation ✅ (Already Started)
- **Status:** In Progress (code exists in `server-go/`)
- **Files:**
  - `server-go/protos/jimesh/jimesh.proto` - Core protobuf definitions
  - `server-go/go.mod` - Dependencies (go-redis, quic-go, grpc, protobuf, modernc.org/sqlite)
  - `server-go/internal/router/router.go` - Thompson-Sampling bandit (ported from router.ts)
  - `server-go/internal/keypool/keypool.go` - Cost-aware cooldown, reliability/speed EMA
  - `server-go/internal/store/store.go` - SQLite wrapper with migrations
  - `server-go/internal/streams/streams.go` - Redis Streams (XADD/XREAD, consumer groups)
  - `server-go/internal/service/service.go` - Business logic layer
  - `server-go/internal/gateway/gateway.go` - HTTP/1.1+2 server
  - `server-go/cmd/server/main.go` - Entrypoint with graceful shutdown
  - `server-go/Dockerfile` - Multi-stage build (codegen → build → distroless)

### Task 4.2: Complete Missing Service Implementations
- **Status:** Partially Completed
- **Implement in `service.go`:**
  - `Route()` - Wire router.Pick, keypool for key selection, publish RouteEvent to Redis Streams
  - `StreamEvents/StreamScores/StreamHealth` - Consumer groups → gRPC server streaming
  - `ListProviders`, `CheckHealth`, `CostReport`, `SyncCatalog` - Delegate to store/keypool
  - [x] Add `ChainByID`, `ChainByTier`, `ModelByIDPlatform` to store
  - [x] Add `PickScore` method to router

### Task 4.3: Protobuf Code Generation & Docker Build
- **Status:** Completed ✅
- [x] **Fix Dockerfile codegen stage** - Run protoc with `--go_out` and `--go-grpc_out` (Fixed the circular go.sum dependency loop in Docker build)
- [x] **Fix docker-compose.yml YAML syntax** (Added quotes to env variables, fixed host port bind conflicts with host Redis)
- [x] **Run `docker compose build jimesh`** - Verified zero compile errors and successfully started service container
- [x] **Add `rand01()` helper** to router.go

### Task 4.4: HTTP/3 Support (quic-go)
- **Status:** Planned
- **Extend `gateway.go`** with quic-go HTTP/3 listener
- **ALPN negotiation** for h3/h2/http/1.1
- **Connection migration** support for mobile clients

### Task 4.5: Flexible Fallback Chain System (Core Feature)
- **Status:** Planned
- **Protobuf Extensions** (add to `jimesh.proto`):
  ```protobuf
  message ChainEntry {
    // ... existing fields ...
    bool is_paid_model = 10;        // Mark paid models
    string api_key_id = 11;         // Specific key for this model
    double user_preference = 12;    // -1.0 to 1.0 (user favorite score)
    bool is_fallback = 13;          // Explicit fallback marker
    string model_type = 14;         // "chat", "embedding", "vision", "custom"
  }
  
  message Chain {
    // ... existing fields ...
    ChainType type = 10;            // MAIN | FALLBACK | ESCALATION | SPECIALIZED
    string description = 11;
    repeated string tags = 12;      // e.g., ["coding", "trading", "analysis"]
    bool auto_skip_exhausted = 13;  // Skip paid models when quota exhausted
  }
  
  enum ChainType {
    CHAIN_TYPE_UNSPECIFIED = 0;
    CHAIN_TYPE_MAIN = 1;        // Primary chain (user-defined order)
    CHAIN_TYPE_FALLBACK = 2;    // Auto fallback when main fails
    CHAIN_TYPE_ESCALATION = 3;  // Escalation chain (cheaper → expensive)
    CHAIN_TYPE_SPECIALIZED = 4; // Specialized (vision-only, tools-only, etc.)
  }
  ```

- **Router Logic Changes:**
  1. **Main Chain** - User drag-drop order respected, but smart scoring can reorder within user constraints
  2. **User Preference Weight** - `user_preference` (0-1) blends with bandit score: `final_score = 0.7*bandit + 0.3*user_pref`
  3. **Paid Model Tag** - When paid model exhausted (402/429), auto-skip to fallback chain if `auto_skip_exhausted=true`
  4. **Per-Key Model Assignment** - `api_key_id` binds specific model to specific key (not round-robin)
  5. **No Useless Calls** - If model in cooldown/throttled, router knows BEFORE calling (from KeyPool/Router stats)
  6. **Escalation Chain** - Auto-escalate from free → cheap → expensive based on task requirements

### Task 4.6: API Key Auto-Discovery
- **Status:** Planned
- **Endpoint:** `POST /api/v1/keys/discover`
- **Features:**
  - Scan environment for `*_API_KEY` patterns
  - Test each key against provider `/models` endpoint
  - Auto-register working keys with platform detection
  - Support custom OpenAI-compatible endpoints
  - Generate default chains from discovered models

### Task 4.7: FlexGrid/RaphBuilder UI Components
- **Status:** Planned
- **Components to Build:**
  - **ChainBuilderGrid** - React Flow / DnD based visual chain editor
    - Nodes = Models (with provider badge, tier, cost, speed, paid tag)
    - Edges = Fallback/Escalation links
    - User can drag to reorder, connect nodes
    - Shows bandit score overlay on each node
    - User preference slider per node (-1 to +1)
  - **ModelPicker** - Searchable, filterable model selector
    - Filters: tier, capabilities (vision/tools), cost (free/paid), provider
    - Shows real-time health, reliability, speed scores
    - "Add to Chain" button with position selector
  - **ChainVisualizer** - Read-only view showing live routing decisions
    - Highlights current model in chain
    - Shows fallback path taken
    - Latency/cost per hop

### Task 4.8: Redis Streams + gRPC Integration Patterns
- **Status:** Planned
- **Patterns:**
  1. **RouteEvent Stream** - `jimesh:events` topic
     - Producer: Service.Route() after decision
     - Consumers: Analytics dashboard, tracing, alerting
     - Consumer groups: `analytics`, `tracing`, `alerting`
  2. **ScoreSnapshot Stream** - `jimesh:scores` topic
     - Producer: Periodic (5s) router stats snapshot
     - Consumers: Real-time analytics dashboard
  3. **ProviderHealth Stream** - `jimesh:health` topic
     - Producer: Health check workers
     - Consumers: Dashboard, circuit breakers
  4. **gRPC Server Streaming** - `StreamEvents/StreamScores/StreamHealth`
     - Backend: `streams.Hub.TailGroup()` with consumer group per RPC
     - Client: Receives live updates without polling

### Task 4.9: Admin Dashboard as Example/Reference Implementation
- **Status:** Planned
- **Philosophy:** Frontend becomes reference implementation showing how to use gRPC/REST APIs
- **Keep:** Chat interface, Chain builder, Analytics, Provider health
- **Remove:** Complex business logic (move to Go backend)
- **Add:** Example widgets for logs, sessions, traces (for DSH integration)
- **Export:** OpenAPI spec from protobuf for client generation

### Task 4.10: DSH Integration Endpoints
- **Status:** Planned
- **Endpoints:**
  - `CreateAgentSession(agent_schema)` → session_id
  - `GetAgentSessions(agent_type, tags)` → list
  - `StreamAgentLogs(session_id)` → WebSocket/Server-Sent Events
  - `GetSessionMetadata(session_id)` → metadata
  - `UpdateSessionMetadata(session_id, metadata)`
- **Agent Schema** (protobuf):
  ```protobuf
  message AgentSchema {
    string agent_type = 1;      // "trader", "expert", "risk", "custom"
    string fallback_chain_id = 2;
    string description = 3;
    map<string, string> default_metadata = 4;
    repeated string tags = 5;
    string memory_config = 6;   // JSON for DSH long-term memory
  }
  ```

---

## 🔧 Technical Decisions

### Why Go Backend?
| Factor | Node.js (Current) | Go (Target) |
|--------|------------------|-------------|
| Throughput | ~5k req/s | ~50k+ req/s |
| Latency (p99) | ~100ms | ~5ms |
| Memory (idle) | ~150MB | ~15MB |
| Binary size | N/A (needs runtime) | ~15MB static |
| Concurrency | Event loop | Goroutines (native) |
| Type safety | TypeScript | Native + Protobuf |
| Hot reload | nodemon | Air (dev only) |

### Protobuf as SSOT
- **Single schema** → Go, Python, TypeScript, Rust, Java, C#
- **Versioning** - Package-level versioning (`jimesh.v1`, `jimesh.v2`)
- **Breaking change detection** - `buf breaking` in CI
- **Documentation** - Generated from proto comments

### Redis Streams vs Pub/Sub
| Feature | Pub/Sub | Redis Streams |
|---------|---------|---------------|
| Persistence | ❌ | ✅ (configurable) |
| Replay | ❌ | ✅ (by ID or time) |
| Consumer Groups | ❌ | ✅ |
| Acknowledgment | ❌ | ✅ |
| Multiple consumers | ❌ | ✅ |
| Ordering | Best-effort | Guaranteed per partition |

### HTTP/3 Benefits
- **0-RTT** resumption for repeated requests
- **Connection migration** - IP change doesn't break connection
- **Multiplexing** - No head-of-line blocking
- **Better congestion control** - BBR, etc.

---

## 🎨 UI/UX: FlexGrid Chain Builder

### Visual Design (Inspired by Trading Bot FlexGrid + RaphBuilder)

```
┌─────────────────────────────────────────────────────────────────┐
│  MAIN CHAIN                                    [+] Add Model    │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐       │
│  │ GPT-4o  │ ──▶│Claude 3.5│ ──▶│Gemini 1.5│ ──▶│DeepSeek  │       │
│  │ [Paid]  │    │ [Paid]  │    │ [Free]  │    │ [Free]  │       │
│  │ 🟢 98%  │    │ 🟢 95%  │    │ 🟡 87%  │    │ 🟢 92%  │       │
│  │ ⚡ 1.2s  │    │ ⚡ 1.8s  │    │ ⚡ 0.8s  │    │ ⚡ 0.5s  │       │
│  │ 💰$5/1M  │    │ 💰$3/1M  │    │ 💰$0.5/1M│    │ 💰$0.1/1M│       │
│  │ ★★★★☆    │    │ ★★★★☆    │    │ ★★★☆☆    │    │ ★★★★★    │       │
│  └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘       │
│       │              │              │              │             │
│       ▼              ▼              ▼              ▼             │
│  [User Pref: +0.8] [User Pref: 0] [User Pref: -0.2] [User Pref:+0.5]
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ FALLBACK CHAIN (auto)                    [⚙] Auto-Skip: ON  │
│  │ ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐   │
│  │ │Groq L3  │ ──▶│Cerebras │ ──▶│Cloudfl. │ ──▶│Custom   │   │
│  │ │[Free]   │    │[Free]   │    │[Free]   │    │[Local]  │   │
│  │ └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘   │
│  └───────┼─────────────┼─────────────┼─────────────┼────────┘  │
└──────────┼──────────────┼──────────────┼─────────────┼───────────┘
           │              │              │             │
           ▼              ▼              ▼             ▼
      [If paid]      [If paid]      [If free]      [Always]
      [exhausted]    [exhausted]    [throttled]    [last resort]
```

### Interaction Patterns
1. **Drag from ModelPicker** → Drop on chain position
2. **Drag chain nodes** → Reorder (updates priority)
3. **Click node** → Side panel with:
   - Bandit score breakdown
   - User preference slider
   - Paid/Free toggle
   - Key assignment dropdown
   - Capability badges (vision, tools, structured)
4. **Right-click node** → "Make Fallback", "Duplicate", "Remove", "View Traces"
5. **Chain-level toggles**:
   - Auto-skip exhausted paid models
   - Escalation mode (cheapest → expensive)
   - Require vision/tools gates

---

## 📊 Sprint Metrics (Target)

- **Go Backend Compile:** Zero errors
- **Docker Build:** < 3 minutes (multi-stage)
- **Binary Size:** < 20MB (distroless)
- **gRPC Latency (p99):** < 5ms local
- **HTTP/3 Handshake:** < 50ms
- **Redis Streams Throughput:** > 100k events/s
- **Chain Builder UX:** < 2s interaction latency
- **Test Coverage:** > 80% for new Go code

---

## 🐛 Anticipated Issues

1. **Protobuf Versioning** - Breaking changes when evolving schemas
   - **Fix:** Strict `buf breaking` checks in CI, package per version

2. **gRPC-Gateway HTTP/3** - quic-go API differs from stdlib http
   - **Fix:** Separate listener, shared handler via interface

3. **Redis Streams Consumer Group Lag** - Monitoring needed
   - **Fix:** Export `consumer_lag` metric to Prometheus

4. **SQLite WAL Contention** - Multiple writers
   - **Fix:** Single writer pattern, read replicas if needed

5. **Frontend/Backend Sync** - TypeScript types from protobuf
   - **Fix:** `buf generate` → `protoc-gen-ts` → shared npm package

6. **Dual Runtime** - Node.js (frontend dev) + Go (backend)
   - **Fix:** Docker Compose orchestrates both; shared volume for proto

---

## 🎓 Expected Learnings

1. **gRPC-First Design** - Forces clean API contracts, enables polyglot clients
2. **Redis Streams as Backbone** - Decouples producers/consumers, enables replay
3. **Protobuf-Driven Development** - Schema changes propagate to all languages
4. **Cost-Aware Routing** - User preferences + bandit scores = practical optimization
5. **HTTP/3 Reality** - Real benefits for high-latency clients, complexity for infra

---

## ➡️ Next Sprints

**Sprint 5:** Production Hardening - Load testing, circuit breakers, graceful degradation  
**Sprint 6:** Multi-Agent Routing - Crews, subtask delegation, supervisor pattern  
**Sprint 7:** Enterprise - SSO, audit logs, multi-tenancy, RBAC  
**Sprint 8:** Self-Improving Router - Online learning, A/B testing, canary deployments

---

## 📝 Chat Log Entry (2026-08-31)

**User Vision Summary:**
> "Frontend wird example frontend - kann konfigurieren aber dient hauptsächlich als Implementierungs-Erklärung und User Example Widgets. Admin Dashboard aber Unterschied: wir können Agents und Fallback Chains im gRPC kompilierten Code definieren. Models direkt in Fallback Chain auswählen. User Favorite Parameter als zusätzliche Metrik. Paid Model Tags. Models API Key einzeln zur Fallback Chain hinzufügen. Haupt Chain mit Input Model Point/Node. Wenn paid model exhausted → direkt weiter zur Fallback Chain. Wenn Model failed/throttled → direkt weiter zur nächsten Node. Keine sinnlosen Calls machen. Drag & Drop Models in Liste, Reihenfolge einstellen. Wenn Model schlechte Scores hat → übersprungen aber User Score versucht zu erreichen wenn praktisch möglich. Kein Loop durch schlechte Models wie im Original."

**Key Decisions:**
1. Go backend with gRPC/HTTP3 replaces Node.js
2. Protobuf schemas are SSOT for all languages
3. Redis Streams for real-time (like Trading Bot)
4. Flexible chains: Main + Fallback + Escalation + Specialized
5. User preference blends with bandit score (70/30)
6. Paid model tags + per-key assignment
7. Auto-skip exhausted/throttled models
8. Frontend as reference implementation
9. DSH integration endpoints for agent sessions
10. FlexGrid/RaphBuilder style visual chain builder

---

## 🔗 References

- Protobuf schemas: `server-go/protos/jimesh/jimesh.proto`
- Go backend: `server-go/`
- Current frontend: `client/src/components/*.tsx`
- Trading Bot patterns: `/home/ji/projects/trading/st-2/lcore/`
- DSH SDK: `https://github.com/ji-podhead/protoc-helper`
- gRPC Go example: `https://github.com/ji-podhead/grcp_go_example_backend`