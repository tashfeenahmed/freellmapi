#!/usr/bin/env python3
"""
run_llm_query - Route a prompt through FreeLLMAPI's dynamic router.

This is the main tool entry point for the freellmapi-orchestrator skill.
"""
import os
import json
import asyncio
from typing import Any, Dict, List, Optional
import httpx
from dotenv import load_dotenv

# Load .env from skill directory
skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(skill_dir, ".env"))

FREELLAPI_BASE = os.getenv("FREELLAPI_BASE", "http://localhost:3001/v1")
FREELLAPI_KEY = os.getenv("FREELLAPI_KEY", "")
DEFAULT_TIMEOUT = int(os.getenv("DEFAULT_TIMEOUT", "120"))

DEFAULT_SYSTEM_PROMPT = os.getenv("DEFAULT_SYSTEM_PROMPT", "")


class LLMBackendFailureError(Exception):
    """Raised when all retry attempts fail."""
    pass


async def run_llm_query(
    prompt: str = "",
    messages: Optional[List[Dict[str, Any]]] = None,
    context: Optional[Dict[str, Any]] = None,
    stream: bool = False,
) -> Dict[str, Any]:
    """
    Route a prompt through FreeLLMAPI's dynamic router.
    
    Args:
        prompt: User prompt (used if messages not provided)
        messages: Full OpenAI-format message array (overrides prompt)
        context: Optional routing hints (prefer_speed, require_tools, etc.)
        stream: Whether to stream response
        
    Returns:
        Dict with text, model_used, routed_via, fallback_attempts, usage
    """
    if not FREELLAPI_KEY:
        raise RuntimeError("FREELLAPI_KEY not configured. Set in .env or Hermes config.")

    # Build message array
    if messages is None:
        msgs = [{"role": "user", "content": prompt}]
    else:
        msgs = messages

    # Inject default system prompt if configured and no system message present
    if DEFAULT_SYSTEM_PROMPT and not any(m.get("role") == "system" for m in msgs):
        msgs.insert(0, {"role": "system", "content": DEFAULT_SYSTEM_PROMPT})

    # Build request body
    body = {
        "model": "auto",
        "messages": msgs,
        "stream": stream,
    }

    # Apply context hints as extra params (FreeLLMAPI ignores unknown fields)
    if context:
        body.update(context.get("extra_params", {}))

    # Make request
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        response = await client.post(
            f"{FREELLAPI_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {FREELLAPI_KEY}",
                "Content-Type": "application/json",
            },
            json=body,
        )

    if not response.is_success:
        raise LLMBackendFailureError(
            f"FreeLLMAPI error {response.status_code}: {response.text[:500]}"
        )

    # Parse response
    data = response.json()
    choice = data["choices"][0]
    text = choice["message"].get("content", "") or ""

    return {
        "text": text,
        "model_used": data.get("model"),
        "routed_via": response.headers.get("X-Routed-Via"),
        "fallback_attempts": int(response.headers.get("X-Fallback-Attempts", "0")),
        "usage": data.get("usage", {}),
        "finish_reason": choice.get("finish_reason"),
    }


if __name__ == "__main__":
    # CLI for testing: python scripts/run_llm_query.py "your prompt"
    import sys
    prompt = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "Hello, world!"
    result = asyncio.run(run_llm_query(prompt=prompt))
    print(json.dumps(result, indent=2))