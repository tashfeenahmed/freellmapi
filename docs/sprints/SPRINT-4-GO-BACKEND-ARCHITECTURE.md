# Sprint 4: Go Backend Architecture - gRPC + Redis Streams + HTTP/3

**Duration:** 2026-08-31 → 2026-09-10  
**Status:** 🚧 In Progress  
**Goal:** Replace Node.js backend with high-throughput Go backend using gRPC (protobuf SSOT), Redis Streams for real-time pub/sub, HTTP/3 for efficient REST. **Language SDKs als First-Class Citizens.** Protobuf schemas are SSOT for all languages (Go/Python/TS/Rust/...).

---

## 🎯 Sprint Goals

1. **Go Backend Migration** - Replace Node.js/TypeScript backend with Go
2. **gRPC + Protobuf as SSOT** - Single source of truth for ALL languages
3. **Redis Streams Pub/Sub** - Real-time event streaming (like Trading Bot)
4. **HTTP/3 Support** - quic-go for efficient REST
5. **Flexible Fallback Chains** - User favorites, paid model tags, per-key model assignment
6. **Language SDKs** - Go/Python/TS/Rust clients with ergonomic APIs for chains, agents, streaming
7. **FlexGrid/RaphBuilder UI** - Drag-drop chain builder with smart routing overlay
8. **API Key Auto-Discovery** - Auto-detect and register provider keys
9. **DSH Integration** - Agent sessions, log streaming, memory config

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         JIMESH ARCHITECTURE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    LANGUAGE SDKs (Generated from Protobuf)          │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │   │
│  │  │   Go    │  │ Python  │  │TypeScript│  │  Rust   │  │  Java   │   │   │
│  │  │  SDK    │  │  SDK    │  │   SDK    │  │  SDK    │  │  SDK    │   │   │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘   │   │
│  └───────┼────────────┼────────────┼────────────┼────────────┼────────┘   │
│          │            │            │            │            │             │
│          ▼            ▼            ▼            ▼            ▼             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              gRPC Gateway (HTTP/1.1 + HTTP/2 + HTTP/3)              │   │
│  │                     Port 8080 / 8443                                │   │
│  └────────────────────────────┬────────────────────────────────────────┘   │
│                               │                                             │
│          ┌────────────────────┼────────────────────┐                       │
│          ▼                    ▼                    ▼                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │  gRPC API    │    │  REST API    │    │  WebSocket   │               │
│  │  (Port 5051) │    │  /v1/*       │    │  /ws/*       │               │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘               │
│         │                   │                   │                        │
│         └───────────────────┼───────────────────┘                        │
│                             ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    SERVICE LAYER (Go)                               │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────┐  │   │
│  │  │ Router  │ │KeyPool  │ │ Store   │ │ Streams │ │  DSH Bridge │  │   │
│  │  │(Bandit) │ │(Cooldown)│ │(SQLite) │ │(Redis)  │ │ (Sessions)  │  │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────────┘  │   │
│  └────────────────────────────┬────────────────────────────────────────┘   │
│                               │                                             │
│          ┌────────────────────┼────────────────────┐                       │
│          ▼                    ▼                    ▼                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │   Redis      │    │  SQLite      │    │  Providers   │               │
│  │  (Streams)   │    │  (WAL mode)  │    │  (34 APIs)   │               │
│  └──────────────┘    └──────────────┘    └──────────────┘               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📋 Tasks

### Task 4.1: Go Backend Foundation ✅ (Done)
- **Status:** Completed - Code in `src/backend/`
- **Files:** Protobuf, Router (Bandit), KeyPool, Store (SQLite), Streams (Redis), Service, Gateway, Main

### Task 4.2: Core Service Implementations ✅ (Done)
- **Status:** Completed - Route, StreamEvents/Scores/Health, ListProviders, CheckHealth, CostReport, SyncCatalog, AutoDiscoverKeys
- **Store:** ChainByID, ChainByTier, ModelByIDPlatform, AddKey, SeedDefaults
- **Router:** PickScore, Pick with Thompson Sampling + User Preference blending

### Task 4.3: Protobuf Codegen & Docker Build ✅ (Done)
- **Status:** Completed - Multi-stage Dockerfile, fixed go.sum circular dep, YAML syntax fixed

### Task 4.4: HTTP/3 Support (quic-go)
- **Status:** 📋 Planned
- Extend `gateway.go` with quic-go listener, ALPN negotiation, connection migration

---

### Task 4.5: Flexible Fallback Chain System (CORE) 🔥
- **Status:** 🚧 In Progress
- **Protobuf Extensions** (add to `jimesh.proto`):
  ```protobuf
  message ChainEntry {
    string model_id = 1;
    string platform = 2;
    int32 priority = 3;
    bool enabled = 4;
    bool is_paid_model = 10;           // Mark paid models
    string api_key_id = 11;            // Specific key for THIS model (not round-robin)
    double user_preference = 12;       // -1.0 to +1.0 (user favorite score)
    bool is_fallback = 13;             // Explicit fallback marker
    string model_type = 14;            // "chat" | "embedding" | "vision" | "custom" | "reasoning"
    map<string, string> parameters = 15; // Model-specific params (temp, top_p, etc.)
    map<string, string> metadata = 16;   // Arbitrary metadata
  }

  message Chain {
    string id = 1;
    string name = 2;
    Tier tier = 3;
    repeated ChainEntry entries = 4;
    ChainType type = 10;               // MAIN | FALLBACK | ESCALATION | SPECIALIZED
    string description = 11;
    repeated string tags = 12;         // ["coding", "trading", "analysis"]
    bool auto_skip_exhausted = 13;     // Skip paid models when quota exhausted
    map<string, string> metadata = 14; // Chain-level metadata
  }

  enum ChainType {
    CHAIN_TYPE_UNSPECIFIED = 0;
    CHAIN_TYPE_MAIN = 1;               // Primary chain (user drag-drop order)
    CHAIN_TYPE_FALLBACK = 2;           // Auto fallback when main fails
    CHAIN_TYPE_ESCALATION = 3;         // Escalation: free → cheap → expensive
    CHAIN_TYPE_SPECIALIZED = 4;        // Specialized: vision-only, tools-only, etc.
  }
  ```

- **Router Logic Changes:**
  1. **Main Chain** - User drag-drop order respected; smart scoring reorders WITHIN user constraints
  2. **User Preference Blending** - `final_score = 0.7 * bandit_score + 0.3 * user_preference`
  3. **Paid Model Tag** - When paid model exhausted (402/429), auto-skip to fallback chain if `auto_skip_exhausted=true`
  4. **Per-Key Model Assignment** - `api_key_id` binds specific model → specific key (NO round-robin)
  5. **Pre-call Throttle Check** - Router checks KeyPool/Router stats BEFORE calling; skips throttled models
  6. **Escalation Chain** - Auto-escalate free → cheap → expensive based on task requirements
  7. **Parameters & Metadata** - Passed through to provider call; stored per ChainEntry

---

### Task 4.6: Language SDKs (Generated + Ergonomic Wrappers) 🔥
- **Status:** 📋 Planned - **HIGHEST PRIORITY** after core backend
- **Goal:** `protoc` generates gRPC stubs + we add ergonomic wrapper per language

| Language | Package | Key Features |
|----------|---------|--------------|
| **Go** | `github.com/ji-podhead/jimesh/sdk/go` | Native gRPC, builder patterns, streaming helpers |
| **Python** | `jimesh-sdk` (PyPI) | Async/await, Pydantic models, context managers |
| **TypeScript** | `@jimesh/sdk` (npm) | Type-safe, React hooks, SSE/WS helpers |
| **Rust** | `jimesh-sdk` (crates.io) | Async, serde, tonic integration |

- **SDK API Surface (per language):**
  ```python
  # Python Example
  from jimesh import JimeshClient, Chain, ChainEntry, ChainType

  client = JimeshClient("http://localhost:3010", api_key="...")

  # Define chain fluently
  chain = Chain.main("my-trading-chain") \
      .add_model("gpt-4o", platform="openai", priority=1, 
                 user_preference=0.8, api_key_id="key-123") \
      .add_model("claude-3.5-sonnet", platform="anthropic", priority=2,
                 user_preference=0.5) \
      .add_fallback("gemini-1.5-flash", platform="gemini", priority=10) \
      .set_auto_skip_exhausted(True) \
      .build()

  # Register chain
  await client.upsert_chain(chain)

  # Route request
  decision = await client.route(tier=Tier.S, require_tools=True)
  
  # Stream events (async generator)
  async for event in client.stream_events(platform="openai"):
      print(f"Routed: {event.model_id} via {event.platform}")
  ```

---

### Task 4.7: LLM Helper Agent (Smart Routing Core) 🔥
- **Status:** 📋 Planned - **Core Intelligence Layer**
- **Purpose:** LLM that helps route OTHER LLMs - analyzes task, picks optimal chain, manages fallbacks
- **Capabilities:**
  - **Task Analysis** - Input prompt → required capabilities (vision, tools, reasoning, context)
  - **Chain Selection** - Picks best chain for task type (coding, trading, analysis, chat)
  - **Auto-Fallback Orchestration** - When model fails, decides: retry same? cheaper model? escalate? supervisor?
  - **Crew Assembly** - For complex tasks: spawn sub-agents (screener, expert, risk) with own chains
  - **Subtask Delegation** - Model A does analysis → passes structured output → Model B executes
  - **Event-Driven** - Emits `RouteEvent` for every decision (success/fail/escalate/supervisor)
  - **Free Model Budget Management** - Tracks free tier quotas, prefers free when quality sufficient

- **API:**
  ```protobuf
  service LLMHelper {
    rpc AnalyzeTask(TaskRequest) returns (TaskAnalysis);      // What capabilities needed?
    rpc RecommendChain(ChainRecommendationRequest) returns (ChainRecommendation); // Best chain for task
    rpc OrchestrateFallback(FallbackContext) returns (FallbackDecision); // What next after failure?
    rpc AssembleCrew(CrewRequest) returns (CrewPlan);         // Multi-agent plan
    rpc DelegateSubtask(SubtaskRequest) returns (SubtaskResult); // A → B delegation
  }
  ```

---

### Task 4.8: Parameters & Metadata System
- **Status:** 📋 Planned
- **Per ChainEntry Parameters** (passed to provider):
  ```json
  {
    "temperature": 0.7,
    "top_p": 0.9,
    "max_tokens": 4096,
    "response_format": "json_object",
    "custom_param": "value"
  }
  ```
- **Metadata** (stored, queryable, not sent to provider):
  ```json
  {
    "owner": "trading-team",
    "cost_center": "prop-desk",
    "approved_by": "risk-lead",
    "tags": ["production", "high-frequency"]
  }
  ```
- **Chain-level Metadata** - Same concept for whole chain

---

### Task 4.9: FlexGrid/RaphBuilder UI Components
- **Status:** 📋 Planned
- **ChainBuilderGrid** (React Flow) - Drag-drop visual editor
- **ModelPicker** - Searchable, filterable (tier, caps, cost, provider)
- **ChainVisualizer** - Live routing decisions, fallback path, latency/cost per hop
- **ParameterEditor** - Per-node parameter + metadata editor

---

### Task 4.10: Redis Streams + gRPC Integration Patterns
- **Status:** 📋 Planned
- **Topics:** `jimesh:events`, `jimesh:scores`, `jimesh:health`, `jimesh:requests`
- **Consumer Groups:** `analytics`, `tracing`, `alerting`, `dsh-bridge`, `feedback-loop`
- **gRPC Streaming** backed by `TailGroup()` per RPC

---

### Task 4.11: DSH Integration Endpoints
- **Status:** 📋 Planned
- **Agent Schema:** `agent_type`, `fallback_chain_id`, `memory_config`, `tags`, `default_metadata`
- **Endpoints:** `CreateAgentSession`, `GetAgentSessions`, `StreamAgentLogs`, `Get/UpdateSessionMetadata`

---

### Task 4.12: Admin Dashboard as Reference Implementation
- **Status:** 📋 Planned
- **Philosophy:** Frontend = example showing how to use SDKs
- **Keep:** Chat, Chain Builder, Analytics, Provider Health
- **Add:** Example widgets for DSH logs, sessions, traces
- **Export:** OpenAPI from protobuf for client gen

---

## 🔧 Technical Decisions

### Why Go Backend?
| Factor | Node.js (Current) | Go (Target) |
|--------|------------------|-------------|
| Throughput | ~5k req/s | ~50k+ req/s |
| Latency (p99) | ~100ms | ~5ms |
| Memory (idle) | ~150MB | ~15MB |
| Binary size | N/A | ~15MB static |
| Concurrency | Event loop | Goroutines (native) |
| Type safety | TypeScript | Native + Protobuf |

### Protobuf as SSOT → Language SDKs
- Single `.proto` → `protoc` generates gRPC stubs for ALL languages
- **We add ergonomic wrappers** per language (builders, async helpers, streaming)
- Versioning: `jimesh.v1`, `jimesh.v2` packages
- CI: `buf breaking` + `buf lint` on every PR

### Redis Streams vs Pub/Sub
| Feature | Pub/Sub | Redis Streams |
|---------|---------|---------------|
| Persistence | ❌ | ✅ |
| Replay | ❌ | ✅ |
| Consumer Groups | ❌ | ✅ |
| Acknowledgment | ❌ | ✅ |
| Multiple consumers | ❌ | ✅ |

---

## 🎨 UI/UX: FlexGrid Chain Builder (Trading Bot Style)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MAIN CHAIN                                    [+] Add Model    [⚙ Settings] │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │ GPT-4o          │──│ Claude 3.5      │──│ Gemini 1.5      │              │
│  │ [Paid] 💰$5/1M  │  │ [Paid] 💰$3/1M  │  │ [Free] 💰$0.5/1M│              │
│  │ 🟢 Rel: 98%     │  │ 🟢 Rel: 95%     │  │ 🟡 Rel: 87%     │              │
│  │ ⚡ 1.2s         │  │ ⚡ 1.8s         │  │ ⚡ 0.8s         │              │
│  │ ★★★★☆ User:+0.8 │  │ ★★★★☆ User:0.0  │  │ ★★★☆☆ User:-0.2 │              │
│  │ 🔑 key-prod-1   │  │ 🔑 key-prod-2   │  │ (round-robin)   │              │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘              │
│           │                    │                    │                        │
│           ▼                    ▼                    ▼                        │
│  [Params: temp=0.3]     [Params: temp=0.5]     [Params: temp=0.7]           │
│  [Meta: prod,approved]  [Meta: prod,approved]  [Meta: fallback]             │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ FALLBACK CHAIN (auto)                    [⚙ Auto-Skip: ON]          │   │
│  │ ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │   │
│  │ │ Groq L3         │──│ Cerebras        │──│ Cloudflare      │       │   │
│  │ │ [Free] 💰$0     │  │ [Free] 💰$0     │  │ [Free] 💰$0     │       │   │
│  │ └────────┬────────┘  └────────┬────────┘  └────────┬────────┘       │   │
│  └──────────┼────────────────────┼────────────────────┼────────────────┘   │
└─────────────┼────────────────────┼────────────────────┼────────────────────┘
              │                    │                    │
              ▼                    ▼                    ▼
         [If paid]            [If paid]            [If free]
         [exhausted]          [exhausted]          [throttled]
         → FALLBACK           → FALLBACK           → FALLBACK
```

---

## 📊 Sprint 4 Metrics (Target)
- Go Backend Compile: Zero errors ✅
- Docker Build: < 3 min ✅
- Binary Size: < 20MB ✅
- gRPC Latency (p99): < 5ms local
- HTTP/3 Handshake: < 50ms
- Redis Streams Throughput: > 100k events/s
- **SDK Generation:** All 4 languages publishable
- **Chain Builder UX:** < 2s interaction latency
- Test Coverage: > 80%

---

## ➡️ Next Sprints (Sprint 5-8)

### Sprint 5: Production Hardening & SDK Polish
- Load testing (k6), circuit breakers, graceful degradation
- **SDK Polish:** Publish to PyPI/npm/crates.io/go.pkg.dev
- **SDK Docs:** Auto-generated from protobuf + examples
- Prometheus metrics, structured logging (zap), health checks

### Sprint 6: LLM Helper Agent + Multi-Agent Routing 🔥
- **LLM Helper Agent** implementation (Task 4.7)
- **Crew Assembly** - Screener → Expert → Risk Manager with separate chains
- **Subtask Delegation** - Model A → Model B with structured handoff
- **Supervisor Pattern** - Model monitors other models, intervenes on anomalies
- **Escalation Chains** - Auto-escalate on failure: retry → cheaper → expensive → human

### Sprint 7: DeepSeek Harness Integration + Advanced Caching
- **DSH SDK Integration** - Prompt caching (96% cost reduction)
- **Cache Invalidation** - TTL + event-based
- **Cache-Aware Routing** - Router knows what's cached, avoids duplicate work
- **Latency Monitoring** - Round-trip tracking < 200ms

### Sprint 8: Self-Improving Router + Enterprise
- **Online Learning** - Bandit updates from live traffic
- **A/B Testing** - Compare chain configurations
- **Canary Deployments** - New models slow rollout
- **SSO/RBAC/Audit** - Enterprise features
- **Multi-Tenancy** - Separate routers per team

---

## 📝 Chat Log Summary (Key Decisions from Your Prompts)

> **Go Backend + gRPC + Redis Streams + HTTP/3** - Replace Node.js entirely
> **Protobuf SSOT** → Generate SDKs for Go/Python/TS/Rust/Java
> **Language SDKs** - Ergonomic APIs: `client.route()`, `client.stream_events()`, `ChainBuilder`
> **Flexible Chains:** MAIN + FALLBACK + ESCALATION + SPECIALIZED types
> **Paid Model Tags** + **Per-Key Assignment** (no round-robin!)
> **User Preference (-1 to +1)** blends with Bandit (70/30)
> **Auto-skip exhausted/throttled** - Router knows BEFORE calling
> **Parameters & Metadata** per ChainEntry + per Chain
> **LLM Helper Agent** - Routes other LLMs, assembles crews, delegates subtasks
> **FlexGrid Chain Builder** - React Flow drag-drop, live bandit scores, user pref sliders
> **DSH Integration** - Agent sessions, log streaming, memory config
> **Frontend = Reference Implementation** - Shows how to use SDKs

---

## 🔗 References
- Protobuf: `src/backend/protos/jimesh/jimesh.proto`
- Go Backend: `src/backend/`
- SDK Output: `clients/go/`, `clients/python/`, `clients/typescript/`, `clients/rust/`
- Frontend: `client/src/components/*.tsx`
- Trading Bot Patterns: `/home/ji/projects/trading/st-2/lcore/`
- DSH SDK: `https://github.com/ji-podhead/protoc-helper`
- gRPC Go Example: `https://github.com/ji-podhead/grcp_go_example_backend`