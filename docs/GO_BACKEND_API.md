# JiMesh Go Backend — API Reference

**Base URL (HTTP):** `http://localhost:3010`  
**gRPC:** `localhost:3009` (with reflection enabled)  
**Protocol Buffers:** `src/backend/protos/jimesh/jimesh.proto` (SSOT)

---

## Endpoints (HTTP REST)

### Health & Ready

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check → `{"status":"ok"}` |
| GET | `/ready` | Readiness check → `{"status":"ready"}` |

### Models

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List models. Query: `?tier=S|A|B`, `?enabled=false` |

**Response:**
```json
{"models": [{
  "id": "gpt-4o", "platform": "openai", "display_name": "GPT-4o",
  "intelligence_rank": 5, "speed_rank": 4, "context_window": 128000,
  "supports_vision": true, "supports_tools": true, "enabled": true,
  "input_price_per_m": 2.5, "output_price_per_m": 10.0, "tier": "TIER_S"
}]}
```

### Chains

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/chains` | List all chains with entries |
| POST | `/v1/chains` | Create/update chain (full structure) |

**POST /v1/chains — Full Example (all advanced fields):**

```json
{
  "id": "trading-main",
  "name": "Trading Main Chain",
  "tier": "S",
  "type": "MAIN",
  "description": "Primary chain for trading decisions",
  "tags": ["trading", "production"],
  "auto_skip_exhausted": true,
  "metadata": {
    "owner": "trading-team",
    "cost_center": "prop-desk",
    "approved_by": "risk-lead"
  },
  "entries": [
    {
      "model_id": "gpt-4o",
      "platform": "openai",
      "priority": 1,
      "enabled": true,
      "is_paid_model": true,
      "api_key_id": "key-prod-1",
      "user_preference": 0.8,
      "is_fallback": false,
      "model_type": "chat",
      "parameters": {
        "temperature": "0.3",
        "top_p": "0.9",
        "max_tokens": "4096"
      },
      "metadata": {
        "approved": "true",
        "sla": "premium"
      }
    },
    {
      "model_id": "gemini-1.5-flash",
      "platform": "gemini",
      "priority": 2,
      "enabled": true,
      "is_paid_model": false,
      "user_preference": 0.5,
      "model_type": "chat",
      "parameters": {"temperature": "0.7"}
    }
  ]
}
```

**Field Reference:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique chain ID (required) |
| `name` | string | Display name (required) |
| `tier` | string | `S`, `A`, `B` (required) |
| `type` | string | `MAIN` \| `FALLBACK` \| `ESCALATION` \| `SPECIALIZED` (default: `MAIN`) |
| `description` | string | Human-readable description |
| `tags` | string[] | Arbitrary tags for filtering |
| `auto_skip_exhausted` | bool | Skip paid models on 402/429 (default: `true`) |
| `metadata` | map<string,string> | Arbitrary, queryable, NOT sent to provider |

**ChainEntry Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `model_id` | string | Model identifier |
| `platform` | string | Provider (openai, anthropic, gemini, ...) |
| `priority` | int32 | Lower = tried first |
| `enabled` | bool | Is entry active |
| `is_paid_model` | bool | Requires paid quota |
| `api_key_id` | string | Pin specific key (overrides round-robin) |
| `user_preference` | float | -1.0 .. +1.0 (blends with bandit score) |
| `is_fallback` | bool | Explicit fallback marker |
| `model_type` | string | `chat` \| `embedding` \| `vision` \| `reasoning` \| `custom` |
| `parameters` | map<string,string> | Provider params (temperature, top_p, ...) — SENT to provider |
| `metadata` | map<string,string> | Arbitrary metadata — NOT sent to provider |

**ChainType Values:**

| Value | Name | Behavior |
|-------|------|----------|
| 1 | `MAIN` | User-defined order; smart scoring reorders within constraints |
| 2 | `FALLBACK` | Auto-invoked when MAIN fails |
| 3 | `ESCALATION` | Ordered by cost: free → cheap → expensive |
| 4 | `SPECIALIZED` | Capability-gated (vision-only, tools-only) |

### Routing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/route` | Route a request. Query: `?chain_id=`, `?tier=S`, `?estimated_tokens=`, `?vision=`, `?tools=` |

**Response:**
```json
{
  "trace_id": "trace-20260830123456.000000",
  "model_id": "gpt-4o",
  "platform": "openai",
  "key": {"id": 1},
  "score": 0.87,
  "strategy": "exploit",
  "fallbacks": []
}
```

### Scores / Analytics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/score` | Bandit scores. Query: `?tier=S` |

**Response:**
```json
{"scores": [{
  "model_id": "gpt-4o", "platform": "openai",
  "score": 0.87, "reliability": 0.92, "speed": 0.78,
  "samples": 42, "successes": 39, "failures": 3,
  "ts_unix_ms": 1693400000000
}]}
```

### Providers & Keys

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/providers` | Provider health + registered keys |

**Response:**
```json
{
  "health": [
    {"platform":"openai","healthy":true,"latency_ms":100,"uptime_pct":100,"last_check_unix_ms":...}
  ],
  "keys": [
    {"id":1,"platform":"openai","label":"prod","enabled":true}
  ]
}
```

---

## gRPC API

**Port:** `3009` — reflection enabled (use `grpcurl -plaintext localhost:3009 list`)

### Services

#### `jimesh.v1.JiMesh`

| RPC | Type | Description |
|-----|------|-------------|
| `ListModels` | unary | Catalog query with tier/enabled filter |
| `SyncCatalog` | unary | Pull model catalog from remote (with offline fallback) |
| `ListChains` | unary | All chains + entries |
| `UpsertChain` | unary | Create/update chain (full structure) |
| `Route` | unary | Fast-path routing decision |
| `StreamEvents` | server-stream | Tail RouteEvents from Redis Streams |
| `StreamScores` | server-stream | Tail ScoreSnapshots |
| `StreamHealth` | server-stream | Tail ProviderHealth |
| `GetScores` | unary | Current bandit scores |
| `ListProviders` | unary | Health + keys |
| `CheckHealth` | unary | Probe single platform |
| `CostReport` | unary | Cost summary by period |

#### `jimesh.v1.LLMHelper` *(proto defined, implementation pending)*

| RPC | Type | Description |
|-----|------|-------------|
| `AnalyzeTask` | unary | Prompt → CapabilityRequirements |
| `RecommendChain` | unary | Requirements → best Chain |
| `OrchestrateFallback` | unary | FailureContext → FallbackDecision |
| `AssembleCrew` | unary | Task → multi-agent CrewPlan |
| `DelegateSubtask` | unary | Model A → Model B with schemas |
| `StreamCrewEvents` | server-stream | Crew execution events |

### grpcurl Examples

```bash
# List services
grpcurl -plaintext localhost:3009 list

# List chains
grpcurl -plaintext localhost:3009 jimesh.v1.JiMesh/ListChains

# Create advanced chain
grpcurl -plaintext -d '{
  "chain": {
    "id": "esc-1", "name": "Escalation", "tier": "TIER_S",
    "type": "CHAIN_TYPE_ESCALATION",
    "auto_skip_exhausted": true,
    "entries": [{
      "model_id": "gemini-1.5-flash", "platform": "gemini",
      "priority": 1, "enabled": true,
      "user_preference": 0.9,
      "parameters": {"temperature": "0.5"}
    }]
  }
}' localhost:3009 jimesh.v1.JiMesh/UpsertChain

# Stream events
grpcurl -plaintext localhost:3009 jimesh.v1.JiMesh/StreamEvents
```

---

## Redis Streams

| Topic | Content | Producer | Consumers |
|-------|---------|----------|-----------|
| `jimesh:events` | RouteEvent JSON | Route() / provider callback | feedback-loop, analytics, DSH |
| `jimesh:scores` | ScoreSnapshot[] JSON | Periodic (5s) + on feedback | dashboards |
| `jimesh:health` | ProviderHealth JSON | Health workers | dashboards, circuit breakers |
| `jimesh:requests` | Request summaries | Providers | analytics |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis for Streams |
| `REDIS_ENABLED` | `true` | Enable Streams |
| `OPENAI_API_KEY` | — | Auto-discovered on startup |
| `ANTHROPIC_API_KEY` | — | Auto-discovered on startup |
| `GEMINI_API_KEY` | — | Auto-discovered on startup |
| `DEEPSEEK_API_KEY` | — | Auto-discovered on startup |
| `GROQ_API_KEY` | — | Auto-discovered on startup |

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-grpc-port` | `50051` | gRPC listen port |
| `-http-port` | `8080` | HTTP listen port |
| `-sqlite-path` | `./data/jimesh.db` | SQLite file path |
| `-redis-url` | — | Redis URL override |
| `-redis-enable` | `true` | Enable Redis Streams |
| `-shutdown-sec` | `10` | Graceful shutdown timeout |

---

## Scoring Model

**Bandit Score (per model+platform):**
```
score = 0.6 * reliability + 0.4 * speed
```
- `reliability` = Beta posterior mean `(successes + 1) / (successes + failures + 2)`
- `speed` = mean of normalized inverse latencies
- Decay: exponential, 2-day half-life

**Pick Strategy:**
1. Cold-start probe: entries with `< 5 samples` → `strategy="prior"`
2. 10% exploration: least-sampled entry → `strategy="explore"`
3. Exploit: highest score → `strategy="exploit"`

**Planned (P0):** `final_score = 0.7 * bandit + 0.3 * user_preference`

---

## Docker Compose (Dev Mode)

```yaml
jimesh:
  image: golang:1.23-bookworm     # go run inside container
  working_dir: /src
  volumes:
    - ./src/backend:/src          # hot reload via mount
    - jimesh-data:/data           # SQLite persistence
    - /home/ji/go/pkg/mod:/go/pkg/mod   # module cache
    - go-build:/root/.cache/go-build    # build cache
  command: ["go", "run", "cmd/server/main.go", "-http-port=3010", "-grpc-port=3009"]
```

**Ports:** HTTP `3010`, gRPC `3009`, Redis (host) `6380` → container `6379`

---

## Proto Codegen

```bash
make proto   # Docker codegen image → generates .pb.go on host
```

Generated files are committed to repo so CI doesn't need protoc.