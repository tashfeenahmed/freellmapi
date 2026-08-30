# JiMesh Backlog

## 🟢 Sprint 4: Go Backend Architecture (Completed ✅)

### Task 4.1: Complete Service Implementations
- [x] `service.Route()` - Wire router.Pick, keypool, publish RouteEvent to Redis Streams
- [x] `service.StreamEvents/StreamScores/StreamHealth` - Consumer groups → gRPC streaming
- [x] `service.ListProviders`, `CheckHealth`, `CostReport`, `SyncCatalog`
- [x] Add `ChainByID`, `ChainByTier`, `ModelByIDPlatform` to store
- [x] Add `PickScore` method to router

### Task 4.2: Build & Deploy
- [x] Fix docker-compose.yml YAML syntax (currently broken)
- [x] Fix Dockerfile protoc codegen stage
- [x] Run `docker compose build jimesh` - verify zero errors
- [x] Start stack + verify /health + gRPC reflection (Completed with automatic defaults seeding and live health check verification)

### Task 4.3: Flexible Fallback Chains
- [ ] Protobuf: ChainType enum (MAIN, FALLBACK, ESCALATION, SPECIALIZED)
- [ ] Protobuf: ChainEntry extensions (is_paid_model, api_key_id, user_preference, model_type)
- [ ] Router: 0.7*bandit + 0.3*user_pref scoring
- [ ] Router: Auto-skip exhausted paid models (402/429)
- [ ] Router: Pre-call throttle/cooldown check (no useless API calls)
- [ ] Router: Escalation chain (free → cheap → expensive)

### Task 4.4: API Key Auto-Discovery
- [x] `POST /api/v1/keys/discover` / `AutoDiscoverKeys` on startup
- [x] Scan env for `*_API_KEY` patterns
- [x] Auto-register working keys + platform detection
- [x] Generate default chains from discovered models

### Task 4.5: HTTP/3 (quic-go)
- [ ] Extend gateway.go with quic-go listener
- [ ] ALPN negotiation (h3/h2/http/1.1)
- [ ] Connection migration support

### Task 4.6: FlexGrid/RaphBuilder UI
- [ ] ChainBuilderGrid (React Flow / DnD)
  - Nodes = Models (provider badge, tier, cost, speed, paid tag)
  - Edges = Fallback/Escalation links
  - Drag to reorder, connect nodes
  - Bandit score overlay per node
  - User preference slider (-1 to +1)
- [ ] ModelPicker (searchable, filterable)
  - Filters: tier, capabilities, cost (free/paid), provider
  - Real-time health/reliability/speed
  - "Add to Chain" with position selector
- [ ] ChainVisualizer (read-only live view)
  - Highlights current model
  - Shows fallback path taken
  - Latency/cost per hop

### Task 4.7: Redis Streams Integration Patterns
- [x] RouteEvent stream (`jimesh:events`) with consumer groups
- [x] ScoreSnapshot stream (`jimesh:scores`) - 5s periodic
- [x] ProviderHealth stream (`jimesh:health`) - health workers
- [x] gRPC server streaming backed by TailGroup()

### Task 4.8: DSH Integration Endpoints
- [ ] `CreateAgentSession(agent_schema)` → session_id
- [ ] `GetAgentSessions(agent_type, tags)` → list
- [ ] `StreamAgentLogs(session_id)` → WebSocket/SSE
- [ ] `GetSessionMetadata` / `UpdateSessionMetadata`
- [ ] AgentSchema protobuf (agent_type, fallback_chain_id, tags, memory_config)

### Task 4.9: Admin Dashboard as Reference Implementation
- [ ] Keep: Chat, Chain builder, Analytics, Provider health
- [ ] Move business logic to Go backend
- [ ] Add: Example widgets for logs, sessions, traces (DSH)
- [ ] Export: OpenAPI spec from protobuf for client generation

---

## 🔶 Sprint 5: Production Hardening (Planned)

### Performance
- [ ] Load testing (k6/autocannon)
- [ ] Circuit breakers per provider
- [ ] Graceful degradation (partial provider failures)
- [ ] Response caching layer (opt-in)
- [ ] Connection pooling (providers + redis)

### Reliability
- [ ] Prometheus metrics export
- [ ] Structured logging (pino equivalent in Go - zap/zerolog)
- [ ] Health check workers with backoff
- [ ] Dead letter queue for failed events
- [ ] Circuit breaker metrics

### Security
- [ ] AES-256-GCM key encryption (port from Node.js)
- [ ] Rate limiting per client
- [ ] API key rotation support
- [ ] TLS termination for HTTP/3
- [ ] Audit log for admin actions

---

## 🔷 Sprint 6: Multi-Agent Routing (Planned)

- [ ] Crews of models for complex tasks
- [ ] Subtask delegation (Model A → Model B)
- [ ] Escalation chains (auto-escalate on failure)
- [ ] Supervisor pattern (model monitors others)
- [ ] LLM Helper Agent for unknown models
- [ ] Auto-routing for ambiguous requests
- [ ] Billiges Model → Richtiges Model weiterleitung
- [ ] Events für Calls (Grund angeben: Teil-Task abgeschlossen, besseres Model, Supervisor, Eskalieren)
- [ ] Chain muss immer weitergehen (keine Sackgassen)

---

## 📦 Technical Debt

- [ ] TypeScript types from protobuf (`buf generate` → `protoc-gen-ts`)
- [ ] Shared npm package for generated client
- [ ] Strict buf breaking checks in CI
- [ ] Test coverage > 80% for Go code
- [ ] E2E tests (gRPC + REST + streaming)
- [ ] Documentation generation from proto comments
- [ ] Redis Streams consumer group lag monitoring
- [ ] SQLite WAL contention handling (single writer pattern)

---

## 💡 Ideas (Not Prioritized)

- LightLLM clone as wrapper (only OpenAI endpoint - needs wrapper)
- DeepSeek Harness direkt in Container integrieren
- Traces: LangSmith / DSH / OpenTelemetry-kompatibel
- Trace Storage: Redis (7d) + SurrealDB (long-term)
- Trace Search & Replay
- Multi-Tenancy (separate routers per team)
- RBAC (role-based access control)
- A/B Testing für Chain-Konfigurationen
- Canary deployments für neue Models
- Auto-Scaling (mehr Keys bei High Load)
- Custom Date Range für Analytics
- Drill-Down in Analytics
- Grafana Integration
- Alerts (Slack/Discord bei Anomalien)
