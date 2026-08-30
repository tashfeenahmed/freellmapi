# Sprint 3: DSH Advanced Integration

**Duration:** 2026-08-31 → 2026-09-01  
**Status:** 📋 Planned  
**Goal:** Implement advanced DeepSeek Harness features: Agent Type management, Session metadata, custom variables, dynamic querying, and UI enhancements for agent/session selection.

---

## 🎯 Sprint Goals

1. **Agent Type System** – Define and manage agent types (trading, expert, risk, etc.) with default tags and fallback chains.
2. **Session Metadata Extension** – Store arbitrary key‑value metadata (PNL, notes, learning, memory entries, daytrade/scalp mode, etc.) per session.
3. **Dynamic Query Endpoint** – Provide a flexible POST `/sessions/query` endpoint that filters sessions by agent type, tags, and metadata conditions.
4. **UI – Agent/Session Selector** – Add a header switch (Chat/Agents) and dropdowns to choose agent type and session, populated via the new API.
5. **Metadata Panel** – Allow viewing and editing session metadata directly in the UI.
6. **Log Forwarding** – Ensure DSH session logs are streamed to Jimesh and optionally persisted locally.
7. **Documentation & Testing** – Update API docs, add unit/integration tests for new endpoints and UI components.

---

## 📋 Tasks

### Task 3.1: Define Agent Type Schema & CRUD ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `api/schemas/agent_type_schema.yaml`
  - `server/src/models/AgentType.ts` (or equivalent)
  - `server/src/services/agentTypeService.ts`
  - `server/src/routes/agentTypes.ts`
- **Features:**
  - Create, read, update, delete agent types.
  - Fields: `type_id`, `label`, `description`, `default_tags`, `default_fallback_chain`.
  - Validation via schema.
- **Deliverable:** Functional API at `/api/agent-types`.

### Task 3.2: Extend Session Schema with Metadata & Agent Type ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `api/schemas/session_schema.yaml` (update)
  - `server/src/models/Session.ts`
  - `server/src/services/sessionService.ts` (update create/update)
  - `server/src/routes/sessions.ts` (update POST `/sessions`)
- **Features:**
  - Add `agent_type_id` (foreign key to AgentType).
  - Keep `metadata` as `object` with `additionalProperties: true`.
  - Ensure metadata is stored and returned unchanged.
- **Deliverable:** Session creation accepts and returns metadata; listing includes agent_type_id.

### Task 3.3: Implement Dynamic Query Endpoint ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `server/src/routes/sessionQuery.ts`
  - `server/src/services/queryBuilder.ts` (helper)
- **Features:**
  - POST `/api/sessions/query`
  - Accept JSON body with optional filters:
    - `agent_type_id`: string
    - `tags`: array of strings (must match all)
    - `metadata_filters`: array of `{ field, op, value }` where ops include: `=, !=, >, >=, <, <=, starts_with, ends_with, contains, not_starts_with, not_ends_with, not_contains`.
  - Support pagination (`limit`, `offset`) and sorting (`order_by`).
  - Return total count and list of sessions (including metadata).
- **Deliverable:** Working query endpoint tested with various filter combinations.

### Task 3.4: UI – Mode Toggle (Chat/Agents) ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `client/src/components/ModeToggle.tsx`
  - Update `client/src/components/Header.tsx` to include toggle.
  - State management (e.g., React Context or Redux) to track mode.
- **Features:**
  - Two buttons: Chat and Agents.
  - Clicking switches UI state.
- **Deliverable:** Toggle functional; Agents mode shows subsequent UI.

### Task 3.5: UI – Agent Type & Session Dropdowns ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `client/src/components/AgentSessionSelector.tsx`
  - Hooks to fetch agent types (`GET /api/agent-types`) and sessions (`POST /api/sessions/query` with selected type).
- **Features:**
  - Dropdown for agent type (loaded on mount).
  - On type change, fetch sessions of that type (limit 200) and populate second dropdown.
  - Display session info: timestamp and abbreviated metadata.
  - Store selected `session_id` in global state.
- **Deliverator:** Dropdowns update correctly; selected session ID available for prompting.

### Task 3.6: UI – Metadata Panel ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `client/src/components/MetadataPanel.tsx`
  - Integration in main view below chat window.
- **Features:**
  - Show JSON representation of selected session's metadata.
  - Edit button to turn fields into inputs.
  - Save changes via `PUT /api/sessions/{session_id}/metadata`.
  - Cancel reverts to original.
- **Deliverable:** Metadata can be viewed and edited without leaving the page.

### Task 3.7: Integrate DSH Adapter for Session Runs ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `freellmapi/dsh_adapter.py` (ensure exists)
  - `lcore/ai/agent/jimesh_client.py` (use adapter)
  - `lcore/ai/agent/graph_jimesh.py` (or equivalent) to start session via JimeshClient.
- **Features:**
  - When a session is selected in UI, use its `session_id` to run prompts via DSH adapter.
  - Support streaming and non‑streaming modes.
  - Forward logs via adapter’s `subscribe_logs` to a local file and/or Jimesh log websocket.
- **Deliverable:** Selecting a session and sending a prompt yields a response; logs appear in `logs/agent_<session_id>.log`.

### Task 3.8: Log Forwarding & WebSocket Endpoint ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `server/src/routes/logsWs.ts` (websocket endpoint `/ws/logs/:session_id`)
  - `server/src/services/logForwarder.ts` (pubsub → ws broadcast)
  - Adjust `DshAdapter.subscribe_logs` to forward to Jimesh backend (optional HTTP post) or directly to ws if same process.
- **Features:**
  - Open websocket to receive real‑time log lines for a session.
  - Persist logs to a `session_logs` table (optional).
  - Allow multiple clients to subscribe.
- **Deliverable:** Logs visible in UI via a optional "Live Logs" panel or accessible via external tools.

### Task 3.9: Unit & Integration Tests ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `tests/agentType.test.ts`
  - `tests/sessionQuery.test.ts`
  - `tests/metadataPanel.test.tsx` (if using testing library)
  - `tests/dshAdapter.test.py`
- **Features:**
  - Test schema validation.
  - Test query builder with various ops.
  - Test UI interactions (mocked API).
  - Test adapter mocks DSH calls.
- **Deliverable:** Test suite passes; coverage ≥80% for new code.

### Task 3.10: Documentation Update ✅
- **Status:** Planned
- **Assignee:** JiMesh
- **Files:**
  - `docs/API_REFERENCE.md` (add agent types, session query, metadata endpoints)
  - `docs/UI_GUIDE.md` (explain mode toggle, dropdowns, metadata panel)
  - `docs/FEATURE_ROADMAP.md` (update progress)
- **Features:**
  - Clear examples of request/response bodies.
  - Screenshots of UI components.
- **Deliverable:** Documentation reflects new capabilities.

---

## 📊 Sprint Metrics (Target)

- **Tasks Completed:** 10/10 (100%)
- **Files Created/Modified:** ~25
- **Lines of Code:** ~2000 (backend) + ~1500 (frontend)
- **Unit Tests:** ≥80% coverage on new logic
- **Duration:** 2 days

---

## 🐛 Anticipated Issues

1. **Complex Metadata Filtering** – Building safe SQL/no‑SQL queries from arbitrary filters could lead to injection or performance problems.
   - **Fix:** Use ORM/parameterized queries; whitelist allowed operations; limit number of filters per request.
2. **UI State Synchronization** – Ensuring mode, agent type, and session selections stay in sync across components.
   - **Fix:** Centralize state in a React Context or state‑management library; use immutable updates.
3. **Log Volume** – Streaming logs for many sessions could overwhelm the websocket.
   - **Fix:** Allow clients to specify log levels; provide buffering; optional server‑side storage with retrieval on demand.
4. **Adapter Async/Sync Mismatch** – The DSH SDK is synchronous; wrapping in async methods must avoid blocking the event loop.
   - **Fix:** Use `asyncio.to_thread` or run SDK calls in a thread pool; keep the async interface non‑blocking.

---

## 🎓 Learnings (Expected)

1. **Metadata‑Driven Sessions** – Storing arbitrary key‑value data enables powerful post‑hoc analysis without schema changes.
2. **Dynamic Query Flexibility** – A single generic query endpoint reduces endpoint proliferation and adapts to evolving analytical needs.
3. **UI‑Driven Workflow** – Separating chat (stateless prompts) from agent/session‑driven workflows clarifies user intent and reduces confusion.
4. **Centralized Logging** – Forwarding DSH logs through Jimesh creates a single observability pipeline for debugging and audit.
5. **Agent Typing** – Defining agent types promotes reuse and makes it easier to enforce defaults (tags, fallback chains) across sessions.

---

## ➡️ Next Sprint

**Sprint 4: Performance Optimization & Production Hardening** – Load testing, caching strategies, security audits, and deployment preparations.

