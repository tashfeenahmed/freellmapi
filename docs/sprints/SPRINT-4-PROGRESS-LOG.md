# Sprint 4 Progress Log — Flexible Chains Implementation

**Date:** 2026-08-30  
**Session:** Sprint 4 — Go Backend + Flexible Fallback Chains  
**Status:** 🚧 In Progress — Core Schema + Store + Service + Gateway ✅ DONE

---

## ✅ What Was Implemented This Session

### 1. Protobuf Schema Extensions (`src/backend/protos/jimesh/jimesh.proto`)

**ChainType Enum (NEW):**
```protobuf
enum ChainType {
  CHAIN_TYPE_UNSPECIFIED = 0;
  CHAIN_TYPE_MAIN = 1;        // Primary chain (user drag-drop order)
  CHAIN_TYPE_FALLBACK = 2;    // Auto fallback when main fails
  CHAIN_TYPE_ESCALATION = 3;  // Escalation: free -> cheap -> expensive
  CHAIN_TYPE_SPECIALIZED = 4; // Specialized: vision-only, tools-only
}
```

**ChainEntry Extensions (NEW fields):**
```protobuf
message ChainEntry {
  string model_id = 1;
  string platform = 2;
  int32 priority = 3;
  bool enabled = 4;

  // ---- Advanced routing metadata (NEW) ----
  bool is_paid_model = 10;             // true if model requires paid quota
  string api_key_id = 11;              // specific API key (overrides round-robin)
  double user_preference = 12;         // -1.0 .. +1.0 user favourite score
  bool is_fallback = 13;               // explicit fallback marker
  string model_type = 14;              // chat|embedding|vision|reasoning|custom
  map<string, string> parameters = 15; // provider params: temperature, top_p...
  map<string, string> metadata = 16;   // arbitrary metadata (not sent to provider)
}
```

**Chain Extensions (NEW fields):**
```protobuf
message Chain {
  string id = 1;
  string name = 2;
  Tier tier = 3;
  repeated ChainEntry entries = 4;

  // ---- Chain-level metadata (NEW) ----
  ChainType type = 10;                 // MAIN|FALLBACK|ESCALATION|SPECIALIZED
  string description = 11;
  repeated string tags = 12;           // ["coding", "trading"]
  bool auto_skip_exhausted = 13;       // skip paid models on 402/429
  map<string, string> metadata = 14;
}
```

**LLMHelper Service (NEW — proto only, implementation pending):**
```protobuf
service LLMHelper {
  rpc AnalyzeTask(TaskRequest) returns (TaskAnalysis);
  rpc RecommendChain(ChainRecommendationRequest) returns (ChainRecommendation);
  rpc OrchestrateFallback(FailureContext) returns (FallbackDecision);
  rpc AssembleCrew(CrewRequest) returns (CrewPlan);
  rpc DelegateSubtask(SubtaskRequest) returns (SubtaskResult);
  rpc StreamCrewEvents(StreamEventsRequest) returns (stream RouteEvent);
}
```

**New Message Types:**
- `CapabilityRequirements` — vision, tools, structured_output, reasoning, min_context, max_latency, max_cost
- `TaskAnalysis` — requirements + suggested_chain_type + recommended_tags + confidence
- `ChainRecommendation` — chain_id + confidence + reasoning + alternatives
- `FailureContext` — trace_id, model_id, platform, chain_position, failure_reason
- `FallbackDecision` — action (RETRY_SAME|NEXT_IN_CHAIN|ESCALATE|SUPERVISOR|HUMAN) + reasoning
- `CrewRole` — role_id, chain_id, priority, depends_on, config
- `CrewPlan` — crew_id, roles, shared_context, timeout
- `CrewRequest` — task_description, requirements, context, budget
- `SubtaskRequest` — parent_trace_id, target model, prompt, input/output schemas
- `SubtaskResult` — trace_id, success, output, error, latency

---

### 2. SQLite Store Updates (`src/backend/internal/store/store.go`)

**New Migrations:**
```sql
CREATE TABLE chains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL,
  type TEXT DEFAULT 'MAIN',                    -- NEW
  description TEXT,                            -- NEW
  tags TEXT DEFAULT '[]',                      -- NEW (JSON array)
  auto_skip_exhausted INTEGER DEFAULT 1,       -- NEW
  metadata TEXT DEFAULT '{}'                   -- NEW (JSON map)
);

CREATE TABLE chain_entries (
  chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  is_paid_model INTEGER DEFAULT 0,             -- NEW
  api_key_id TEXT,                             -- NEW
  user_preference REAL DEFAULT 0.0,            -- NEW
  is_fallback INTEGER DEFAULT 0,               -- NEW
  model_type TEXT,                             -- NEW
  parameters TEXT DEFAULT '{}',                -- NEW (JSON map)
  metadata TEXT DEFAULT '{}'                   -- NEW (JSON map)
);
```

**New Indexes:**
- `idx_chains_type` — for filtering by chain type
- `idx_chain_entries` — existing (chain_id, priority)

**Helper Functions (NEW):**
- `parseJSONMap(s string) map[string]string` — for parameters/metadata columns
- `parseJSONArray(s string) []string` — for tags column

**Updated Structs:**
```go
type ChainRow struct {
  ID, Name, Tier, Type, Description string
  Tags []string
  AutoSkipExhausted bool
  Metadata map[string]string
  Entries []ChainEntryRow
}

type ChainEntryRow struct {
  ModelID, Platform, APIKeyID, ModelType string
  Priority int32
  Enabled, IsPaidModel, IsFallback bool
  UserPreference float64
  Parameters, Metadata map[string]string
}
```

**Updated Methods:**
- `ListChains()` — loads all new fields
- `chainEntries()` — loads all new fields incl. JSON parsing
- `UpsertChain()` — persists all new fields atomically
- `ChainByID()` / `ChainByTier()` — load all new fields

---

### 3. Service Layer Updates (`src/backend/internal/service/service.go`)

**`ListChains()`** — now maps ALL new fields between store and protobuf:
- ChainType string ↔ pb.ChainType enum conversion
- Tags, Metadata, AutoSkipExhausted, Description pass-through
- Per-entry: IsPaidModel, ApiKeyId, UserPreference, IsFallback, ModelType, Parameters, Metadata

**`UpsertChain()`** — now persists ALL new fields:
- Accepts complete Chain structure from gRPC/HTTP
- Type enum → string conversion for storage
- Returns authoritative version after upsert (via `ChainByID`)
- Previously: only id/name/tier — now full round-trip

---

### 4. Gateway Updates (`src/backend/internal/gateway/gateway.go`)

**`handleChainsPost()`** — completely rewritten:
- Accepts full chain JSON: type, description, tags, auto_skip_exhausted, metadata
- Accepts full entries array with all advanced fields
- AutoSkipExhausted defaults to `true` if not provided
- ChainType string → pb.ChainType enum conversion
- Returns the complete persisted chain

**Example Request (verified working):**
```json
POST /v1/chains
{
  "id": "test-advanced",
  "name": "Advanced Chain",
  "tier": "S",
  "type": "ESCALATION",
  "auto_skip_exhausted": true,
  "entries": [
    {
      "model_id": "gemini-1.5-flash",
      "platform": "gemini",
      "priority": 1,
      "enabled": true,
      "is_paid_model": false,
      "user_preference": 0.9,
      "model_type": "chat",
      "parameters": {"temperature": "0.5"}
    },
    {
      "model_id": "gpt-4o",
      "platform": "openai",
      "priority": 2,
      "enabled": true,
      "is_paid_model": true,
      "api_key_id": "key-prod-1",
      "user_preference": 0.7,
      "model_type": "chat",
      "parameters": {"temperature": "0.3", "top_p": "0.9"}
    }
  ]
}
```

**Response (verified):**
```json
{
  "id": "test-advanced",
  "entries": [
    {"model_id": "gemini-1.5-flash", "user_preference": 0.9, "parameters": {"temperature": "0.5"}, ...},
    {"model_id": "gpt-4o", "is_paid_model": true, "api_key_id": "key-prod-1", "parameters": {"temperature": "0.3", "top_p": "0.9"}, ...}
  ],
  "type": 3,
  "auto_skip_exhausted": true
}
```

---

## 🐛 Issues Fixed This Session

### Issue 1: SQLite Migration Failure
```
failed to open sqlite: migrate: SQL logic error: no such column: type (1)
```
- **Root Cause:** Old database volume had tables without new columns. `CREATE TABLE IF NOT EXISTS` doesn't alter existing tables.
- **Fix:** `docker compose down -v` (clear volumes) → fresh migration with new schema
- **Note:** For production, we need proper migration versioning (e.g., `schema_version` table or golang-migrate)

### Issue 2: Docker Build "No services to build"
```
time="..." level=warning msg="No services to build"
```
- **Root Cause:** docker-compose.yml uses `image: golang:1.23-bookworm` with volume-mounted source (dev mode), not a build context
- **Explanation:** This is intentional dev setup — `go run` inside golang container with mounted `/src`. Hot reload via volume mount + Go build cache volume.
- **Proto Codegen:** Still uses separate `make proto` (Docker codegen image) → generates .pb.go on host

### Issue 3: Gateway Returning Only Base Fields
- **Symptom:** POST /v1/chains returned only `{id, name, type}` 
- **Root Cause:** Gateway handler decoded only 3 fields and built minimal pb.Chain
- **Fix:** Complete rewrite of `handleChainsPost()` with full field mapping

---

## 📦 Commits

```
950b379 feat: protobuf+store+service+gateway for flexible chains
```

**Files changed:** 8 files, +3426 / -915 lines
- `src/backend/protos/jimesh/jimesh.proto` — ChainType, ChainEntry/Chain extensions, LLMHelper service
- `src/backend/protos/jimesh/jimesh.pb.go` — regenerated
- `src/backend/protos/jimesh/jimesh_grpc.pb.go` — regenerated
- `src/backend/internal/store/store.go` — migrations + structs + JSON helpers
- `src/backend/internal/service/service.go` — ListChains/UpsertChain full mapping
- `src/backend/internal/gateway/gateway.go` — handleChainsPost rewrite

---

## 🚧 Remaining Work (Prioritized)

### P0 — Router Logic (Next Session)
- [ ] **User-Preference Blending**: `final_score = 0.7*bandit + 0.3*user_preference`
- [ ] **Paid Auto-Skip**: On 402/429, if `chain.auto_skip_exhausted` → skip to next non-paid entry or FALLBACK chain
- [ ] **Per-Key Binding**: If `entry.api_key_id` set → use ONLY that key (no round-robin via KeyPool)
- [ ] **Pre-call Throttle Check**: Router checks KeyPool cooldown + router stats BEFORE returning candidate
- [ ] **Escalation Chain Support**: When chain type=ESCALATION → order by cost (free first)

### P1 — LLMHelper gRPC Implementation
- [ ] Implement `AnalyzeTask` — heuristic + optional LLM-based task classification
- [ ] Implement `RecommendChain` — match requirements against chains (capabilities, tags)
- [ ] Implement `OrchestrateFallback` — decision tree based on failure_reason + chain config
- [ ] Implement `AssembleCrew` — template-based crew builder (screener/expert/risk)
- [ ] Implement `DelegateSubtask` — route to target model with schema validation
- [ ] Register second gRPC service in main.go

### P1 — Language SDKs
- [ ] **Go SDK** — `clients/go/` — wrapper around generated pb with ChainBuilder
- [ ] **Python SDK** — `clients/python/` — pydantic models + async client → PyPI
- [ ] **TypeScript SDK** — `clients/typescript/` — types + React hooks → npm
- [ ] **Rust SDK** — `clients/rust/` — tonic-based client → crates.io

### P2 — UI
- [ ] FlexGrid Chain Builder (React Flow drag-drop)
- [ ] ModelPicker with filters
- [ ] ChainVisualizer (live routing view)
- [ ] ParameterEditor (per-node params + metadata)

### P2 — DSH Integration
- [ ] AgentSchema endpoints (CreateAgentSession, GetAgentSessions, StreamAgentLogs)
- [ ] Session metadata CRUD
- [ ] Log streaming via Redis Streams

---

## 🔗 Related Docs

- `docs/sprints/SPRINT-4-GO-BACKEND-ARCHITECTURE.md` — full sprint plan
- `docs/backlog/BACKLOG.md` — task-level backlog
- `docs/prompts/CHAT_LOG.md` — original user prompts
- Proto: `src/backend/protos/jimesh/jimesh.proto`
- Store: `src/backend/internal/store/store.go`
- Service: `src/backend/internal/service/service.go`
- Gateway: `src/backend/internal/gateway/gateway.go`