# Zro by MoonMath.ai

Add your own API key under **Keys → Zro / MoonMath.ai**. Create it at
[Zro API keys](https://zro.moonmath.ai/api-keys). File imports recognize
`ZRO_API_KEY` and `MOONMATH_API_KEY`; no project ID or second credential is needed.

The OpenAI-compatible base URL is `https://zro.moonmath.ai/v1`. Normal and
streaming chat, function/tool calls, and JSON output were live-tested on
November 12, 2026 with `deepseek-v4.1-flash`. The account showed the Free daily
allowance, no prepaid balance, and all four test requests.

[Free usage resets daily](https://zro.moonmath.ai/pricing), not monthly. The
numeric free token/request allowance is not publicly specified; do not invent
a per-model grant from an account-wide balance. Other models and usage packs
may be paid. A `usage.cost` field can represent nominal metered usage even on
Free, so it is not proof of a cash debit or a separate monthly credit.

Key validation uses authenticated `GET /v1/models` (missing and invalid keys
returned 401) and does not generate tokens. The model roster is not imported
automatically. Only approved hosted-catalog rows are published, preserving
Premium access immediately and Free access after the existing 30-day gate.
No model is seeded by an application migration.

The adapter accepts the documented `zro/` namespace alias, rejects a different
or missing response model identity, and preserves upstream errors for ordinary
router failover. It does not switch to a paid model when a free route fails.

Reference: [API documentation](https://zro.moonmath.ai/docs/api).
