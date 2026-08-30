# JiMesh Backlog

## 🟢 Sprint 4: Go Backend Architecture (In Progress)

### Task 4.1: Complete Service Implementations ✅ DONE
- [x] `service.Route()` - Wire router.Pick, keypool, publish RouteEvent to Redis Streams
- [x] `service.StreamEvents/StreamScores/StreamHealth` - Consumer groups → gRPC streaming
- [x] `service.ListProviders`, `CheckHealth`, `CostReport`, `SyncCatalog`
- [x] Add `ChainByID`, `ChainByTier`, `ModelByIDPlatform` to store
- [x] Add `PickScore` method to router

### Task 4.2: Build & Deploy ✅ DONE
- [x] Fix docker-compose.yml YAML syntax
- [x] Fix Dockerfile protoc codegen stage (circular go.sum fixed)
- [x] Run `docker compose build jimesh` - verify zero errors
- [x] Start stack + verify /health + gRPC reflection (defaults seeded automatically)

### Task 4.3: Flexible Fallback Chain System 🔥 🚧 IN PROGRESS
- [ ] Protobuf: ChainType enum (MAIN, FALLBACK, ESCALATION, SPECIALIZED)
- [ ] Protobuf: ChainEntry extensions (is_paid_model, api_key_id, user_preference, model_type, parameters, metadata)
- [ ] Protobuf: Chain extensions (auto_skip_exhausted, description, tags, metadata)
- [ ] Router: User preference blending (0.7*bandit + 0.3*user_pref)
- [ ] Router: Paid model auto-skip on 402/429
- [ ] Router: Per-key model assignment (api_key_id binding)
- [ ] Router: Pre-call throttle/cooldown check (NO useless API calls)
- [ ] Router: Escalation chain (free → cheap → expensive)

### Task 4.4: API Key Auto-Discovery ✅ DONE
- [x] `POST /api/v1/keys/discover` / `AutoDiscoverKeys` on startup
- [x] Scan env for `*_API_KEY` patterns
- [x] Auto-register working keys + platform detection
- [x] Generate default chains from discovered models

### Task 4.5: HTTP/3 (quic-go) 📋 PLANNED
- [ ] Extend gateway.go with quic-go listener
- [ ] ALPN negotiation (h3/h2/http/1.1)
- [ ] Connection migration support

### Task 4.6: Language SDKs (Generated + Ergonomic Wrappers) 🔥 📋 PLANNED
- [ ] **Go SDK** - `clients/go/` - Native gRPC, builder patterns, streaming helpers
- [ ] **Python SDK** - `clients/python/` - Async/await, Pydantic, context managers → PyPI
- [ ] **TypeScript SDK** - `clients/typescript/` - Type-safe, React hooks, SSE/WS → npm
- [ ] **Rust SDK** - `clients/rust/` - Async, serde, tonic → crates.io
- [ ] **SDK API Surface** (per language):
  - `JimeshClient` - route, stream_events, stream_scores, stream_health
  - `ChainBuilder` - fluent API: `.add_model()`, `.add_fallback()`, `.set_auto_skip_exhausted()`
  - `ChainEntryBuilder` - `.with_user_preference()`, `.with_api_key()`, `.with_parameters()`, `.with_metadata()`
  - `AgentSessionHelper` - create session, stream logs, get/update metadata

### Task 4.7: LLM Helper Agent (Smart Routing Core) 🔥 📋 PLANNED
- [ ] **TaskAnalysis** - Input prompt → required capabilities (vision, tools, reasoning, context_window)
- [ ] **ChainRecommendation** - Best chain for task type (coding, trading, analysis, chat)
- [ ] **FallbackOrchestration** - On failure: retry same? cheaper model? escalate? supervisor?
- [ ] **CrewAssembly** - Spawn sub-agents (screener, expert, risk) with own chains
- [ ] **SubtaskDelegation** - Model A → Model B with structured handoff
- [ ] **FreeModelBudgetManager** - Tracks free tier quotas, prefers free when quality sufficient
- [ ] **gRPC Service** - `AnalyzeTask`, `RecommendChain`, `OrchestrateFallback`, `AssembleCrew`, `DelegateSubtask`

### Task 4.8: Parameters & Metadata System 📋 PLANNED
- [ ] ChainEntry.parameters (provider params: temp, top_p, max_tokens, response_format, custom)
- [ ] ChainEntry.metadata (arbitrary, queryable, not sent to provider)
- [ ] Chain.metadata (chain-level metadata)
- [ ] Store: Persist and query by metadata/tags
- [ ] SDK: Pass through parameters, attach metadata

### Task 4.9: FlexGrid/RaphBuilder UI Components 📋 PLANNED
- [ ] ChainBuilderGrid (React Flow) - Drag-drop, bandit score overlay, user pref slider
- [ ] ModelPicker - Searchable, filterable (tier, caps, cost, provider), real-time health
- [ ] ChainVisualizer - Live routing decisions, fallback path, latency/cost per hop
- [ ] ParameterEditor - Per-node parameter + metadata editor

### Task 4.10: Redis Streams + gRPC Integration Patterns 📋 PLANNED
- [ ] Topics: `jimesh:events`, `jimesh:scores`, `jimesh:health`, `jimesh:requests`
- [ ] Consumer Groups: `analytics`, `tracing`, `alerting`, `dsh-bridge`, `feedback-loop`
- [ ] gRPC Streaming via `TailGroup()` per RPC

### Task 4.11: DSH Integration Endpoints 📋 PLANNED
- [ ] Agent Schema: agent_type, fallback_chain_id, memory_config, tags, default_metadata
- [ ] Endpoints: CreateAgentSession, GetAgentSessions, StreamAgentLogs, Get/UpdateSessionMetadata

### Task 4.12: Admin Dashboard as Reference Implementation 📋 PLANNED
- [ ] Frontend = Example showing SDK usage
- [ ] Keep: Chat, Chain Builder, Analytics, Provider Health
- [ ] Add: DSH widgets (logs, sessions, traces)
- [ ] Export: OpenAPI from protobuf

---

## 🔥 Sprint 5: Production Hardening & SDK Polish (2026-09-10 → 2026-09-17)

### Performance & Reliability
- [ ] Load testing with k6 (target: 50k req/s, p99 < 5ms)
- [ ] Circuit breakers per provider (Hystrix-style)
- [ ] Graceful degradation (partial provider failures)
- [ ] Response caching layer (opt-in, Redis-backed)
- [ ] Connection pooling (providers + Redis)

### Observability
- [ ] Prometheus metrics export (/metrics)
- [ ] Structured logging (zap) with correlation IDs
- [ ] Health check workers with exponential backoff
- [ ] Dead letter queue for failed stream events
- [ ] Consumer group lag monitoring (export to Prometheus)

### Security
- [ ] AES-256-GCM key encryption at rest (port from Node.js)
- [ ] Rate limiting per client (token bucket)
- [ ] API key rotation support
- [ ] TLS termination for HTTP/3
- [ ] Audit log for admin actions (chain/key changes)

### SDK Polish & Release
- [ ] **Go SDK** - Publish to `go.pkg.dev/github.com/ji-podhead/jimesh/sdk/go`
- [ ] **Python SDK** - Publish to PyPI (`pip install jimesh-sdk`)
- [ ] **TypeScript SDK** - Publish to npm (`npm install @jimesh/sdk`)
- [ ] **Rust SDK** - Publish to crates.io (`cargo add jimesh-sdk`)
- [ ] SDK Documentation - Auto-generated from protobuf + guides
- [ ] Example apps per language (CLI, simple server, streaming demo)

---

## 🔥 Sprint 6: LLM Helper Agent + Multi-Agent Routing (2026-09-17 → 2026-10-01) 🔥

### LLM Helper Agent Core
- [ ] **AnalyzeTask** - Prompt → CapabilityRequirements (vision, tools, reasoning, context, latency_budget)
- [ ] **RecommendChain** - CapabilityRequirements + ChainType → Best Chain (with confidence score)
- [ ] **OrchestrateFallback** - FailureContext (error, model, chain_position) → FallbackDecision
  - Decisions: `RETRY_SAME`, `NEXT_IN_CHAIN`, `ESCALATE_CHAIN`, `SUPERVISOR`, `HUMAN`
  - Emits `FallbackEvent` to `jimesh:fallbacks` stream
- [ ] **AssembleCrew** - Task → CrewPlan (roles: screener, expert_vision, news_expert, risk_manager, post_trade)
  - Each role gets own chain (can be different chain types)
  - Crew communicates via Redis Streams (`jimesh:crew:{crew_id}`)
- [ ] **DelegateSubtask** - Structured output from Model A → Input for Model B
  - Schema validation between hops
  - Trace parent/child relationship in `RouteEvent`

### Multi-Agent Routing
- [ ] **Crew Orchestration** - Parallel/sequential execution with dependency graph
- [ ] **Supervisor Pattern** - Dedicated model watches others, intervenes on:
  - Excessive latency
  - Repeated failures
  - Output quality degradation (heuristic)
  - Cost threshold breach
- [ ] **Escalation Chains** - Automatic: free → cheap → expensive → paid → human
  - Configurable per chain via `escalation_policy` metadata
- [ ] **Cost-Aware Crew Budgeting** - Total crew cost budget, auto-adjust model tiers

### SDK Integration
- [ ] `client.analyze_task()`, `client.recommend_chain()`, `client.orchestrate_crew()`
- [ ] Streaming crew events: `client.stream_crew_events(crew_id)`

---

## 🔥 Sprint 7: DeepSeek Harness Integration + Advanced Caching (2026-10-01 → 2026-10-15)

### DSH Integration
- [ ] **DSH SDK Wrapper** - Go/Python/TS bindings for DeepSeek Harness
- [ ] **Prompt Caching Layer** - 96% cost reduction via cached tokens
  - Static prefix caching (system prompts, templates, schemas)
  - Dynamic suffix (market data, user input) - NOT cached
  - TTL: 30s-2min for dynamic, 1hr+ for static
- [ ] **Cache Invalidation** - Event-based (market data change) + TTL
- [ ] **Cache-Aware Routing** - Router checks DSH cache before calling provider
  - If cache hit → route to DSH endpoint (cheaper)
  - If cache miss → normal routing

### Latency & Cost Optimization
- [ ] Round-trip latency tracking < 200ms target
- [ ] Cost tracking: cached vs uncached tokens
- [ ] Savings dashboard: `$ saved by DSH caching`

---

## 🔷 Sprint 8: Self-Improving Router + Enterprise (2026-10-15 → 2026-11-01)

### Self-Improving Router
- [ ] **Online Bandit Learning** - Continuous posterior updates from live `RouteEvent` stream
- [ ] **A/B Testing Framework** - Compare chain configs, statistical significance
- [ ] **Canary Deployments** - New models: 1% → 5% → 25% → 100% with auto-rollback
- [ ] **Model Retirement** - Auto-disable models with sustained < 50% success rate

### Enterprise Features
- [ ] **SSO/SAML/OIDC** - Enterprise auth
- [ ] **RBAC** - Roles: admin, operator, analyst, viewer
- [ ] **Audit Logs** - Who changed what chain/key when (immutable)
- [ ] **Multi-Tenancy** - Separate routers per team (namespace isolation)
- [ ] **API Gateway** - Centralized rate limiting, quotas
- [ ] **Usage Reports** - Per-user/team/project billing

### Advanced Analytics
- [ ] **Custom Date Range** - Not just 24h/7d/30d/90d
- [ ] **Drill-Down** - Click for details
- [ ] **Export** - CSV/JSON for reports
- [ ] **Alerts** - Slack/Discord on anomalies (success rate drop, latency spike)
- [ ] **Grafana Integration** - Pre-built dashboards

---

## 📦 Technical Debt & Infrastructure

- [ ] TypeScript types from protobuf (`buf generate` → `protoc-gen-ts` → shared npm package)
- [ ] Strict `buf breaking` checks in CI
- [ ] Test coverage > 80% for Go code + SDKs
- [ ] E2E tests (gRPC + REST + streaming + SDKs)
- [ ] Documentation generation from proto comments
- [ ] Redis Streams consumer group lag monitoring
- [ ] SQLite WAL contention handling (single writer pattern)
- [ ] Distributed tracing (OpenTelemetry → Jaeger)

---

## 💡 Ideas (Not Prioritized)

- LightLLM wrapper (only OpenAI endpoint → needs wrapper for other formats)
- DeepSeek Harness directly in container
- Traces: LangSmith / DSH / OpenTelemetry-kompatibel
- Trace Storage: Redis (7d) + SurrealDB (long-term)
- Trace Search & Replay
- Auto-Scaling (more keys at high load)
- Custom Date Range for Analytics
- Drill-Down in Analytics
- Grafana Integration
- Alerts (Slack/Discord on anomalies)