"""
freellmapi-orchestrator - Native Hermes tool registration.

This module registers the FreeLLMAPI orchestrator tools so they're available
as native tools in Hermes agents: `tools.run_llm_query` and `tools.get_routing_state`.
"""
import os
import sys
from hermes.tools import register_tool

# Add scripts directory to path for imports
skill_dir = os.path.dirname(os.path.abspath(__file__))
scripts_dir = os.path.join(skill_dir, "scripts")
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)

# Import the async tool functions
from run_llm_query import run_llm_query as _run_llm_query_impl
from get_routing_state import get_routing_state as _get_routing_state_impl


def _ensure_env_loaded():
    """Ensure environment variables are loaded from skill .env or Hermes config."""
    # Hermes injects skill config as environment variables with prefix
    # Also load from skill's .env as fallback
    from dotenv import load_dotenv
    env_path = os.path.join(skill_dir, ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path, override=False)


@register_tool(
    name="run_llm_query",
    description=(
        "Route an LLM query through FreeLLMAPI's dynamic router. "
        "Auto-selects best model via scoring, penalties, cooldowns. "
        "Injects default system persona if configured."
    ),
    parameters={
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "User prompt or message content"
            },
            "messages": {
                "type": "array",
                "description": "Full OpenAI-format message array (overrides prompt)",
                "items": {
                    "type": "object",
                    "properties": {
                        "role": {"type": "string", "enum": ["system", "user", "assistant", "tool"]},
                        "content": {"type": "string"}
                    },
                    "required": ["role", "content"]
                }
            },
            "context": {
                "type": "object",
                "description": "Optional routing hints",
                "properties": {
                    "prefer_speed": {"type": "boolean", "description": "Bias toward faster models"},
                    "prefer_intelligence": {"type": "boolean", "description": "Bias toward smarter models"},
                    "require_tools": {"type": "boolean", "description": "Require tool-calling capability"},
                    "require_vision": {"type": "boolean", "description": "Require vision capability"},
                    "session_id": {"type": "string", "description": "Optional client session ID for sticky routing"},
                    "extra_params": {"type": "object", "description": "Extra params passed to FreeLLMAPI"}
                }
            },
            "stream": {"type": "boolean", "default": False, "description": "Stream response"}
        },
        "required": ["prompt"]
    }
)
async def run_llm_query(
    prompt: str,
    messages: list = None,
    context: dict = None,
    stream: bool = False
) -> dict:
    """Route a prompt through FreeLLMAPI's dynamic router."""
    _ensure_env_loaded()
    return await _run_llm_query_impl(prompt, messages, context, stream)


@register_tool(
    name="get_routing_state",
    description=(
        "Fetch live routing state from FreeLLMAPI including penalties, scores, "
        "cooldowns, and guardrails for agent-aware routing decisions."
    ),
    parameters={"type": "object", "properties": {}}
)
async def get_routing_state() -> dict:
    """Fetch live routing state (penalties, scores, cooldowns)."""
    _ensure_env_loaded()
    return await _get_routing_state_impl()


# Export for direct imports if needed
__all__ = ["run_llm_query", "get_routing_state"]
