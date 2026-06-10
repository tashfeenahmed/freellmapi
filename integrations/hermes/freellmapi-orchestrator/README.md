# FreeLLMAPI Orchestrator — Hermes Integration

Native Hermes skill that exposes FreeLLMAPI's dynamic router as callable tools.

## Features

- **`tools.run_llm_query`** — Route prompts through FreeLLMAPI's intelligent router (penalties, cooldowns, scoring)
- **`tools.get_routing_state`** — Fetch live model penalties, scores, guardrails for agent-aware decisions
- **Automatic system prompt injection** — Consistent persona across model failovers
- **Native Hermes tools** — No `execute_code` needed, registers at startup

## Installation

### Option 1: Manual (current)
```bash
# Clone or copy to Hermes skills directory
cp -r integrations/hermes/freellmapi-orchestrator ~/.hermes/skills/external-api/

# Install dependencies
cd ~/.hermes/skills/external-api/freellmapi-orchestrator/scripts
pip install -r requirements.txt
```

### Option 2: Via Hermes (future)
```bash
hermes skill install freellmapi-orchestrator
```

## Configuration

Set via Hermes config (`~/.hermes/config.yaml`):

```yaml
skills:
  freellmapi-orchestrator:
    config:
      FREELLAPI_BASE: "http://localhost:3001/v1"
      FREELLAPI_KEY: "freellmapi-xxx..."          # From FreeLLMAPI Keys page
      FREELLAPI_DASH_TOKEN: "xxx"                 # Optional: for routing state
      DEFAULT_SYSTEM_PROMPT: "You are a concise, helpful assistant."
      DEFAULT_TIMEOUT: 120
```

Or via `.env` in skill directory (copy `scripts/.env.example` to `.env` and edit).

## Usage

### In Agent Code
```python
# Route a query through the dynamic router
result = await tools.run_llm_query(
    prompt="Summarize the fall of Rome in one sentence.",
    context={"prefer_speed": true}
)
print(result["text"])
print(f"Routed via: {result['routed_via']}")
print(f"Fallback attempts: {result['fallback_attempts']}")
```

### Check Routing Intelligence
```python
state = await tools.get_routing_state()
# state.strategy, state.models[].penalty, state.models[].score, state.models[].guardrails
```

### Context Hints
```python
context = {
    "prefer_speed": true,          # Bias toward faster models (Cerebras, Groq)
    "prefer_intelligence": true,   # Bias toward smarter models
    "require_tools": true,         # Require tool-calling capability
    "require_vision": true,        # Require vision capability
    "session_id": "conv-123",      # Sticky session routing
    "extra_params": {}             # Passed to FreeLLMAPI
}
```

## Response Format

```json
{
  "text": "Model response text",
  "model_used": "gemini-2.5-flash",
  "routed_via": "google/gemini-2.5-flash",
  "fallback_attempts": 0,
  "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
  "finish_reason": "stop"
}
```

## Requirements

- FreeLLMAPI server running at `FREELLAPI_BASE` (default `http://localhost:3001/v1`)
- Hermes with skill loading enabled
- Python 3.10+ with `httpx`, `python-dotenv`

## How It Works

```
┌─────────────┐     Tool Call      ┌──────────────────┐
│  Hermes     │ ─────────────────▶ │ freellmapi-      │
│  Agent      │ ◀───────────────── │ orchestrator     │
└─────────────┘   Structured JSON  └────────┬─────────┘
                                            │
                                    HTTP /v1/chat/completions
                                            │
                                            ▼
                                    ┌──────────────────┐
                                    │  FreeLLMAPI      │
                                    │  (Router +       │
                                    │   16+ backends)  │
                                    └──────────────────┘
```

## Troubleshooting

### Tool Not Available in Agent

**Symptom:** `tools.run_llm_query` or `tools.get_routing_state` not found.

**Causes & Fixes:**

| Cause | Fix |
|-------|-----|
| Skill not in Hermes skills directory | Verify `~/.hermes/skills/external-api/freellmapi-orchestrator/__init__.py` exists |
| Hermes not restarted after install | **Restart Hermes Desktop completely** (tool registration happens at startup) |
| Skill config not loaded | Check `~/.hermes/config.yaml` has the skill config block |
| Python dependencies missing | Run `pip install -r scripts/requirements.txt` in skill directory |

**Debug:** Open Hermes console and check for skill load messages:
```
[Skills] Loading freellmapi-orchestrator...
[Skills] Registered tool: run_llm_query
[Skills] Registered tool: get_routing_state
```

### "FREELLAPI_KEY not configured" Error

**Symptom:** Tool returns error about missing API key.

**Fixes:**
1. **Via Hermes config (preferred):**
   ```yaml
   skills:
     freellmapi-orchestrator:
       config:
         FREELLAPI_KEY: "freellmapi-xxx..."
   ```
2. **Via skill `.env`:** Copy `scripts/.env.example` to `.env` and set `FREELLAPI_KEY`
3. **Verify key works:** Test with `curl -H "Authorization: Bearer *** http://localhost:3001/v1/models`

### Connection Refused / Timeout

**Symptom:** Tool hangs or returns connection error.

| Check | Command |
|-------|---------|
| FreeLLMAPI server running? | `curl http://localhost:3001/api/ping` → should return `{"status":"ok"}` |
| Correct base URL? | Default is `http://localhost:3001/v1` — check `FREELLAPI_BASE` |
| Firewall/port blocked? | Ensure port 3001 accessible (Windows: allow Python in firewall) |
| Timeout too short? | Increase `DEFAULT_TIMEOUT` (default 120s) for slow local models |

### Routing State Returns Empty / 401

**Symptom:** `get_routing_state()` returns minimal data or 401.

| Issue | Fix |
|-------|-----|
| No dashboard token | Penalties/scores require admin endpoint. Add `FREELLAPI_DASH_TOKEN` from dashboard localStorage (`token` key) |
| Token expired | Log into dashboard again, copy fresh token |
| Using `/v1/models` fallback | Without dash token, falls back to public `/v1/models` (no penalties/scores) |

### Model Not Routing / Wrong Model Selected

**Symptom:** Unexpected model used, or routing not respecting penalties.

**Debug Steps:**
1. Call `state = await tools.get_routing_state()` — inspect `state.models[].score`, `penalty`, `guardrails`
2. Check FreeLLMAPI dashboard → Models page → verify penalty badges (amber `−N`) and guardrails column
3. Verify `context` hints are correct:
   ```python
   context = {"prefer_speed": true}  # Not "speed": true
   ```
4. Check FreeLLMAPI logs for `[Proxy] Rescued...` or `falling back (attempt N/M)`

### Skill Loads But Tool Calls Fail Silently

**Symptom:** No error, but no response.

**Fixes:**
- Check Hermes logs for Python traceback (skill runs in Hermes Python runtime)
- Ensure `httpx` version ≥ 0.27: `pip show httpx`
- Verify FreeLLMAPI returns proper SSE/non-stream response format

### Windows-Specific Issues

| Issue | Fix |
|-------|-----|
| `python` not in PATH | Use `py -m pip install ...` or add Python to PATH |
| Symlinks fail | Copy folder instead of symlinking: `cp -r ...` or use File Explorer |
| Firewall blocks localhost | Allow `python.exe` through Windows Defender Firewall |

### Verification Checklist

After install, run through this checklist:

```bash
# 1. FreeLLMAPI health
curl http://localhost:3001/api/ping
# → {"status":"ok"}

# 2. Unified key works
python ~/.hermes/skills/external-api/freellmapi-orchestrator/scripts/run_llm_query.py "hi"
# → JSON with text, routed_via, fallback_attempts: 0

# 3. Dashboard token works (optional)
python ~/.hermes/skills/external-api/freellmapi-orchestrator/scripts/get_routing_state.py
# → JSON with strategy, scores array

# 4. In Hermes (new session)
# Agent calls tools.run_llm_query → works
# Agent calls tools.get_routing_state → works
```

## Related

- **FreeLLMAPI Core**: `../../../` — The router/proxy this skill connects to
- **Hermes Skills Docs**: `~/.hermes/skills/` — Skill development guide

## License

MIT — Same as FreeLLMAPI