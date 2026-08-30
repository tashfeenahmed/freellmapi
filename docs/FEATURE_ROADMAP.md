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

## ✅ Completed Features (Sprint 0-1)

### Sprint 0: Foundation (Completed)
- [x] **Repo klonen** - JiMesh als Basis
- [x] **Verstehen** - JiMesh Routing-Logik analysiert
- [x] **Dokumentation** - JiMesh Probleme identifiziert

### Sprint 1: KeyPoolManager (Completed)
- [x] **KeyPoolManager** - Cost-aware Cooldown für API Keys
- [x] **Multi-Key Support** - Jeder Key bekommt eigenen Score
- [x] **Provider-Level Skip** - Vermeidet 5xx/Timeout auf ganzem Provider
- [x] **Free Model Prioritization** - Kürzere Cooldowns für Free Models

---

## 🚧 In Progress (Sprint 2)

### Sprint 2: Smart Routing & Mesh
- [ ] **Bandit Routing** - Thompson Sampling für Model-Selection
- [ ] **Community Prior** - Geteilte Reliability-Stats
- [ ] **Quota Weighting** - Headroom-aware Key Selection
- [ ] **Task-Aware Routing** - Vision/Tools/Context als Gates
- [ ] **Fallback Chains** - Automatische Key → Model → Provider Fallbacks
- [ ] **Health Checks** - Periodische Provider Health Probes

---

## 🚧 In Progress (Sprint 4)

### Sprint 4: Go Backend Architecture - gRPC + Redis Streams + HTTP/3
- [ ] **Go Backend Migration** - Replace Node.js/TypeScript backend with Go
- [ ] **gRPC + Protobuf as SSOT** - Single source of truth for all languages
- [ ] **Redis Streams Pub/Sub** - Real-time event streaming (like Trading Bot)
- [ ] **HTTP/3 Support** - quic-go for efficient REST
- [ ] **Flexible Fallback Chains** - User favorites, paid model tags, per-key model assignment
- [ ] **FlexGrid/RaphBuilder UI** - Drag-drop chain builder with smart routing overlay
- [ ] **API Key Auto-Discovery** - Auto-detect and register provider keys

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
- [ ] **Caching Layer** - Token-sparend durch Prompt-Caching
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
- [ ] **API Docs** - OpenAPI/Swagger
- [ ] **Architecture Diagrams** - C4 Model
- [ ] **Runbooks** - Für Operations
- [ ] **ADRs** - Architecture Decision Records
- [ ] **Contributing Guide** - Wie man beiträgt
- [ ] **Code of Conduct** - Community Standards

### DevOps
- [ ] **CI/CD** - GitHub Actions
- [ ] **Docker** - Multi-stage Builds
- [ ] **Kubernetes** - Helm Charts
- [ ] **Monitoring** - Prometheus + Grafana
- [ ] **Logging** - Structured Logs (pino)
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
