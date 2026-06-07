#!/usr/bin/env python3
"""
get_routing_state - Fetch live routing state from FreeLLMAPI.

Returns penalties, scores, cooldowns for agent-aware decisions.
"""
import os
import json
import asyncio
import sys
from typing import Any, Dict, List
import httpx
from dotenv import load_dotenv

skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(skill_dir, ".env"))

FREELLAPI_BASE = os.getenv("FREELLAPI_BASE", "http://localhost:3001/v1")
FREELLAPI_KEY = os.getenv("FREELLAPI_KEY", "")
DEFAULT_TIMEOUT = int(os.getenv("DEFAULT_TIMEOUT", "120"))


async def get_routing_state() -> Dict[str, Any]:
    """
    Fetch live routing state from FreeLLMAPI.
    
    Returns:
        Dict with strategy and model array including penalties, scores, guardrails
    """
    if not FREELLAPI_KEY:
        raise RuntimeError("FREELLAPI_KEY not configured")

    # Dash auth token needed for /api/* endpoints
    # For now, assume skill has dashboard token configured
    dash_token = os.getenv("FREELLAPI_DASH_TOKEN", "")

    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        # Get routing state (requires dashboard auth)
        if dash_token:
            resp = await client.get(
                f"{FREELLAPI_BASE.replace('/v1', '')}/api/fallback/routing",
                headers={"Authorization": f"Bearer {dash_token}"},
            )
        else:
            # Without dash token, fall back to /v1/models which is public
            resp = await client.get(
                f"{FREELLAPI_BASE}/models",
                headers={"Authorization": f"Bearer {FREELLAPI_KEY}"},
            )

    if not resp.is_success:
        raise RuntimeError(f"Failed to fetch routing state: {resp.status_code}")

    data = resp.json()
    return data


if __name__ == "__main__":
    try:
        result = asyncio.run(get_routing_state())
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)