# JiMesh - Feature Roadmap & Backlog

## 🎯 Vision

**JiMesh** = **L**LM **Mesh** - Ein intelligenter Router für LLM-APIs der:
- Smart zwischen Providern routet (nicht nur Tiers)
- Free Models bevorzugt (via Cost-aware Cooldown)
- Multiple API Keys pro Provider verwaltet
- DeepSeek Harness für Caching nutzt
- Live Analytics wie im Trading Bot bietet
- Traces für Debugging sammelt
- Chat-Interface für Fallback Chains hat

---

## ✅ Completed Features (Sprint 0-1 + Sprint 4 Core)

### Sprint 0: Foundation (Completed)
- [x] **Repo klonen** - JiMesh als Basis
- [x] **Verstehen** - JiMesh Routing-Logik analysiert
- [x] **Dokumentation** - JiMesh Probleme identifiziert

### Sprint 1: KeyPoolManager (Completed)
- [x] **KeyPoolManager** - Cost-aware Cooldown für API Keys
- [x] **Multi-Key Support** - Jeder Key bekommt eigenen Score
- [x] **Provider-Level Skip** - Vermeidet 5xx/Timeout auf ganzem Provider
- [x] **Free Model Prioritization** - Kürzere Cooldowns für Free Models

### Sprint 4: Go Backend Core ✅ DONE (2026-08-30)
- [x] **Go Backend Migration** - Node.js → Go (gRPC + HTTP REST)
- [x] **gRPC + Protobuf as SSOT** - Single source of truth for Go/Python/TS/Rust
- [x] **Redis Streams Pub/Sub** - Real-time event streaming (like Trading Bot)
- [x] **Protobuf Schema Extensions**:
  - ChainType enum (MAIN/FALLBACK/ESCALATION/SPECIALIZED)
  - ChainEntry: is_paid_model, api_key_id, user_preference, parameters, metadata
  - Chain: description, tags, auto_skip_exhausted, metadata
  - LLMHelper service (AnalyzeTask, RecommendChain, OrchestrateFallback, AssembleCrew, DelegateSubtask)
- [x] **SQLite Store** - Migrations, JSON serialization for maps/arrays
- [x] **Service Layer** - Full mapping Protobuf ↔ Store
- [x] **Gateway (HTTP REST)** - POST /v1/chains with full advanced fields
- [x] **API Key Auto-Discovery** - Scans env vars, registers keys, generates defaults
- [x] **Docker Dev Mode** - Hot reload via volume mount

---

## 🚧 In Progress (Sprint 4 Remaining)

### Sprint 4: Router Logic + LLMHelper + SDKs
- [ ] **Router: User-Preference Blending** — `final_score = 0.7*bandit + 0.3*user_preference`
- [ ] **Router: Paid Auto-Skip** — On 402/429, skip to next non-paid entry or FALLBACK chain
- [ ] **Router: Per-Key Binding** — `entry.api_key_id` pins specific key (no round-robin)
- [ ] **Router: Pre-call Throttle Check** — Check KeyPool cooldown BEFORE returning candidate
- [ ] **Router: Escalation Chain Support** — Type=ESCALATION orders by cost (free→cheap→expensive)
- [ ] **LLMHelper gRPC Implementation** — AnalyzeTask, RecommendChain, OrchestrateFallback, AssembleCrew, DelegateSubtask
- [ ] **Language SDKs** — Go/Python/TS/Rust wrappers (clients/ subdirs)
- [ ] **FlexGrid/RaphBuilder UI** — React Flow drag-drop chain builder
- [ ] **HTTP/3 (quic-go)** — quic-go listener with ALPN negotiation
- [ ] **DSH Integration Endpoints** — AgentSchema, CreateAgentSession, StreamAgentLogs

---

## 📋 Backlog (Prioritized)

### 🔥 High Priority (Sprint 5-6)

#### LLM Mesh Core
- [ ] **Multi-Endpoint Discovery** - Auto-discover alle verfügbaren Endpoints
- [ ] **Capability Detection** - Vision/Tools/Structured Output per Endpoint
- [ ] **Cost Optimization** - Wähle günstigstes Model das Requirements erfüllt
- [ ] **Latency Optimization** - Wähle schnellstes Model bei ähnlicher Quality
- [ ] **Reliability Scoring** - Beta-Posterior für jeden Endpoint
- [ ] **Failure Modes** - 429, 402, 5xx, Timeout, Network Errors
- [ ] **Retry Logic** - Exponential Backoff mit Jitter
- [ ] **Circuit Breaker** - Automatisches Skip bei wiederholten Failures

#### DeepSeek Harness Integration
- [ ] **DSH SDK** - DeepSeek Harness als Provider integrieren
- [ ] **Caching Layer** - Token-sparend durch Prompt-Caching (96% cost reduction)
- [ ] **Workflow Engine** - Multi-Step Workflows (DSH → JiMesh → Model)
- [ ] **Cost Tracking** - Cached vs Uncached Token Counts
- [ ] **Cache Invalidation** - TTL + Event-basiert
- [ ] **Latency Monitoring** - Round-Trip-Time Tracking

#### Chat Interface
- [ ] **Model Selector** - Dropdown mit allen verfügbaren Models
- [ ] **Fallback Chain Builder** - Drag & Drop für Chain-Reihenfolge
- [ ] **Live Chat** - Streaming Responses
- [ ] **Model Comparison** - Side-by-side Comparison
- [ ] **Preset Manager** - Save/Load Chain Presets
- [ ] **Cost Estimator** - Zeige geschätzte Kosten pro Chain

#### Analytics Dashboard
- [ ] **Live Updates** - SSE/WebSocket statt Polling
- [ ] **Request Volume** - Real-time Request Counter
- [ ] **Success Rate** - Per Model/Provider/Key
- [ ] **Latency Tracking** - P50, P95, P99
- [ ] **Token Usage** - Input/Output/Cached
- [ ] **Cost Tracking** - $ pro Model/Provider
- [ ] **Failure Analysis** - Top Error Types
- [ ] **Routing Decisions** - Welcher Endpoint wurde gewählt & warum

#### Traces & Debugging
- [ ] **LangSmith Integration** - Optional, für Production Tracing
- [ ] **DSH Traces** - Native DeepSeek Harness Traces
- [ ] **Custom Trace Format** - OpenTelemetry-kompatibel
- [ ] **Trace Storage** - Redis (7d) + SurrealDB (long-term)
- [ ] **Trace Search** - Filter by Model/Error/Latency
- [ ] **Trace Replay** - Reproduce Failures

---

### 🔶 Medium Priority (Sprint 5-6)

#### Multi-Key Management
- [ ] **Key Pool UI** - Drag & Drop für Key Reihenfolge
- [ ] **Key Health Dashboard** - Per-Key Stats
- [ ] **Key Quota Tracking** - Per-Key Daily/Monthly Limits
- [ ] **Key Auto-Rotation** - Wechsel bei Cooldown
- [ ] **Key Performance Score** - Reliability × Speed
- [ ] **Key Cost Tracking** - $ pro Key

#### Provider Management
- [ ] **Provider Health** - Real-time Status
- [ ] **Provider Quotas** - Global Limits pro Provider
- [ ] **Provider Costs** - Token-Price Tracking
- [ ] **Provider Comparison** - Side-by-side
- [ ] **Auto-Discovery** - Neue Provider finden

#### Presets & Profiles
- [ ] **Preset Templates** - "Coding", "Chat", "Vision", etc.
- [ ] **Profile Switching** - Per-Use-Case Profiles
- [ ] **Import/Export** - Presets teilen
- [ ] **Preset Versioning** - Git-like Version Control

---

### 🔷 Low Priority (Sprint 7+)

#### Advanced Features
- [ ] **Multi-Agent Routing** - Crews von Models für Complex Tasks
- [ ] **Subtask Delegation** - Model A → Model B für Subtasks
- [ ] **Escalation Chains** - Auto-escalate bei Failures
- [ ] **Supervisor Pattern** - Model überwacht andere Models
- [ ] **Self-Improvement** - Model lernt aus eigenen Failures
- [ ] **A/B Testing** - Vergleiche Chain-Konfigurationen
- [ ] **Canary Deployments** - Neue Models langsam rollout
- [ ] **Auto-Scaling** - Mehr Keys bei High Load

#### Enterprise Features
- [ ] **SSO/SAML** - Enterprise Auth
- [ ] **Audit Logs** - Wer hat was wann gemacht
- [ ] **Compliance** - GDPR, SOC2
- [ ] **Multi-Tenancy** - Separate Routers per Team
- [ ] **RBAC** - Role-based Access Control
- [ ] **API Gateway** - Centralized Rate Limiting
- [ ] **Usage Reports** - Per-User/Team/Project

---

## 🎨 UI/UX Improvements

### Chat Overlay
- [ ] **Floating Chat** - Immer verfügbar, nicht Full-Screen
- [ ] **Quick Switch** - Model wechseln mit `/model name`
- [ ] **Command Palette** - `/help`, `/stats`, `/presets`
- [ ] **Markdown Support** - Code Highlighting, Tables
- [ ] **Image Preview** - Vision Models inline
- [ ] **Export Chat** - Als Markdown/JSON
- [ ] **Search History** - Durchsuche alte Chats

### Analytics Dashboard
- [ ] **Custom Date Range** - Nicht nur 24h/7d/30d/90d
- [ ] **Filters** - By Provider, Model, Key, Status
- [ ] **Drill-Down** - Click für Details
- [ ] **Export** - CSV/JSON für Reports
- [ ] **Alerts** - Slack/Discord bei Anomalien
- [ ] **Grafana Integration** - Optional

---

## 🔧 Technical Debt

### Code Quality
- [ ] **TypeScript Strict** - Alle Files strict mode
- [ ] **Test Coverage** - Min 80% Coverage
- [ ] **E2E Tests** - Playwright für UI
- [ ] **Load Tests** - k6/autocannon
- [ ] **Security Audit** - npm audit, snyk
- [ ] **Dependency Updates** - Automated PRs

### Documentation
- [x] **API Docs** - OpenAPI/Swagger (→ `docs/GO_BACKEND_API.md`)
- [ ] **Architecture Diagrams** - C4 Model
- [ ] **Runbooks** - Für Operations
- [ ] **ADRs** - Architecture Decision Records
- [ ] **Contributing Guide** - Wie man beiträgt
- [ ] **Code of Conduct** - Community Standards

### DevOps
- [ ] **CI/CD** - GitHub Actions
- [x] **Docker** - Multi-stage Builds (done for dev)
- [ ] **Kubernetes** - Helm Charts
- [ ] **Monitoring** - Prometheus + Grafana
- [ ] **Logging** - Structured Logs (zap)
- [ ] **Tracing** - OpenTelemetry

---

## 📊 Success Metrics

### Performance
- **P95 Latency** < 2s (Routing + LLM)
- **Success Rate** > 95%
- **Cache Hit Rate** > 40% (DSH)
- **Cost Reduction** > 30% vs Direct API

### Quality
- **Test Coverage** > 80%
- **Zero Downtime** Deploys
- **< 1 Critical Bug** per Sprint
- **Documentation** für alle Features

### Adoption
- **100+ Models** Supported
- **10+ Providers** Integrated
- **5+ Chat Presets** Built-in
- **Community** - GitHub Stars, Discord Members

---

## 📁 Documentation Files

| File | Purpose |
|------|---------|
| `docs/GO_BACKEND_API.md` | Complete HTTP/gRPC/Streams API reference |
| `docs/sprints/SPRINT-4-PROGRESS-LOG.md` | This session's implementation details |
| `docs/sprints/SPRINT-4-GO-BACKEND-ARCHITECTURE.md` | Full sprint plan |
| `docs/backlog/BACKLOG.md` | Task-level backlog |
| `docs/prompts/CHAT_LOG.md` | Original user prompts |
| `src/backend/protos/jimesh/jimesh.proto` | Protobuf SSOT (all schemas) |