---
name: freellmapi-orchestrator
version: 1.0.0
description: Routes LLM queries through FreeLLMAPI's dynamic router — auto-selects best model via scoring, penalties, cooldowns, and injects default system persona
author: bgill55
license: MIT
tags:
  - llm
  - router
  - freellmapi
  - orchestration
  - multi-provider
requires:
  - python: ">=3.10"
  - httpx: ">=0.27"
  - python-dotenv: ">=1.0"
config:
  FREELLAPI_BASE:
    description: "FreeLLMAPI base URL (e.g., http://localhost:3001/v1)"
    type: string
    default: "http://localhost:3001/v1"
  FREELLAPI_KEY:
    description: "Unified API key from FreeLLMAPI dashboard (Keys page)"
    type: string
    secret: true
  DEFAULT_TIMEOUT:
    description: "Request timeout in seconds"
    type: integer
    default: 120
---

# FreeLLMAPI Orchestrator Skill

This skill exposes FreeLLMAPI as a callable tool for Hermes agents. Instead of configuring FreeLLMAPI as a static model provider, this skill encapsulates the dynamic routing logic — penalties, cooldowns, scoring, system prompt injection — into a single `run_llm_query` tool that agents can invoke.

## Why a Tool, Not a Provider?

FreeLLMAPI is a **meta-router** that dispatches to 16+ backends with live scoring. Forcing it into a "model provider" slot loses:
- Dynamic model selection (penalties, cooldowns, headroom)
- Routing transparency (X-Routed-Via, fallback attempts)
- Agent-aware routing decisions

As a tool, the agent can **see** the routing state and **reason** about it.

## Tools

### `run_llm_query`

Route a prompt through FreeLLMAPI's dynamic router.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `prompt` | string | Yes | User prompt or message content |
| `messages` | array | No | Full OpenAI-format message array (overrides `prompt`) |
| `context` | object | No | Optional routing hints |
| `stream` | boolean | No | Stream response (default: false) |

**Context object (optional):**
```json
{
  "prefer_speed": true,
  "prefer_intelligence": false,
  "require_tools": false,
  "require_vision": false,
  "session_id": "optional-client-session-id",
  "extra_params": {}
}
```

**Returns:**
```json
{
  "text": "Model response text",
  "model_used": "gemini-2.5-flash",
  "routed_via": "google/gemini-2.5-flash",
  "fallback_attempts": 0,
  "usage": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 }
}
```

### `get_routing_state`

Fetch live routing state (penalties, scores, cooldowns) for agent-aware decisions.

**Returns:**
```json
{
  "strategy": "balanced",
  "models": [
    {
      "model_db_id": 42,
      "platform": "groq",
      "model_id": "llama-3.3-70b",
      "display_name": "Llama 3.3 70B",
      "penalty": 3,
      "score": 0.723,
      "reliability": 0.95,
      "speed": 0.88,
      "intelligence": 0.65,
      "guardrails": 0.92,
      "enabled": true
    }
  ]
}
```

## Installation

```bash
# Add to Hermes skills directory
hermes skill install freellmapi-orchestrator

# Or manually:
git clone <this-repo> ~/.hermes/skills/external-api/freellmapi-orchestrator
cd ~/.hermes/skills/external-api/freellmapi-orchestrator
pip install -r scripts/requirements.txt
```

The skill includes a native tool registration module (`__init__.py`) that registers `run_llm_query` and `get_routing_state` as native Hermes tools. **Restart Hermes** after installation for tools to become available.

## Configuration

Set via Hermes config or environment:

```yaml
# ~/.hermes/config.yaml
skills:
  freellmapi-orchestrator:
    config:
      FREELLAPI_BASE: "http://localhost:3001/v1"
      FREELLAPI_KEY: "freellmapi-xxx..."
      DEFAULT_SYSTEM_PROMPT: "You are a concise, helpful assistant. Never use markdown unless asked."
      DEFAULT_TIMEOUT: 120
```

Or `.env` in skill directory:
```bash
FREELLAPI_BASE=http://localhost:3001/v1
FREELLAPI_KEY=***
FREELLAPI_DASH_TOKEN=***  # Optional: for routing state access (penalties, scores, cooldowns)
DEFAULT_SYSTEM_PROMPT="You are a concise, helpful assistant."
DEFAULT_TIMEOUT=120
```

**Config fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `FREELLAPI_BASE` | Yes | FreeLLMAPI proxy base URL (default: `http://localhost:3001/v1`) |
| `FREELLAPI_KEY` | Yes | Unified API key from FreeLLMAPI dashboard → Keys page |
| `FREELLAPI_DASH_TOKEN` | No | Dashboard session token for `/api/fallback/routing` access |
| `DEFAULT_SYSTEM_PROMPT` | No | Injected at proxy level if client sends no system message |
| `DEFAULT_TIMEOUT` | No | Request timeout in seconds (default: 120) |

## Usage in Agent

```python
# Agent calls the tool:
result = await tools.run_llm_query(
    prompt="Summarize the fall of Rome in one sentence.",
    context={"prefer_speed": true}
)
print(result["text"])
print(f"Routed via: {result['routed_via']}")
```

Agent can also check routing state before calling:
```python
state = await tools.get_routing_state()
# Factor penalties into prompt strategy...
```

## Architecture

```text
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
                                    │   16 backends)   │
                                    └──────────────────┘
```

### Native Tool Registration (`__init__.py`)

The skill includes an `__init__.py` that uses Hermes's `@register_tool` decorator to expose two native tools:

```python
# Registered on Hermes startup
@register_tool(name="run_llm_query", ...)
async def run_llm_query(prompt, messages=None, context=None, stream=False): ...

@register_tool(name="get_routing_state", ...)
async def get_routing_state(): ...
```

**Key behaviors:**
- Loads config from Hermes-injected environment variables first, falls back to `scripts/.env`
- Imports async implementations from `scripts/run_llm_query.py` and `scripts/get_routing_state.py`
- Returns structured dicts with `text`, `routed_via`, `fallback_attempts`, `usage`, `model_used`
- Tools are available immediately after Hermes restart — no `execute_code` consent needed

### Production Verification

Tested and working in Hermes Desktop (June 2026):
- Native tool call: `tools.run_llm_query(prompt="...")` → returns structured response
- Routing via FreeLLMAPI proxy with penalty/cooldown awareness
- Returns `X-Routed-Via` header, `fallback_attempts`, token usage
- `tools.get_routing_state()` returns live penalties, scores, guardrails

## Common Pitfalls

1. **Restart required after install** — Native tools are registered at Hermes startup. After adding the skill, restart Hermes Desktop or CLI for `tools.run_llm_query` and `tools.get_routing_state` to appear.

2. **Config precedence** — Hermes injects skill config as environment variables. The `__init__.py` loads these first, then falls back to `scripts/.env`. Set config in `~/.hermes/config.yaml` for portability across machines.

3. **Dashboard token for routing state** — `get_routing_state` falls back to `/v1/models` (public) if no `FREELLAPI_DASH_TOKEN` is set, but penalty/score data requires admin endpoints. Set `FREELLAPI_DASH_TOKEN` (from dashboard localStorage `token`) for full routing intelligence.

4. **Model key availability** — Some models in the fallback chain may lack valid API keys. The router handles this via penalties/cooldowns and auto-fails to working models.

5. **Shared skills directory** — Hermes CLI and Desktop both read from `~/.hermes/config.yaml` and `~/.hermes/skills/`. Skills placed in `~/.hermes/skills/` work in both without symlinks or duplication.