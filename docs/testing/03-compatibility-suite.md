# Compatibility suite

## What it is

The coding-agent compatibility suite (commit `19168ac`, #629, 2026-07-27) proves that real AI coding agents work against FreeLLMAPI's surfaces — not just that the endpoints exist. It covers the three integration layers an agent touches: the wire API it calls, the config files it is pointed at, and the client classification the gateway applies to its traffic.

## What it covers and where

### Native Gemini `/v1beta` surface

[`server/src/__tests__/routes/gemini.test.ts`](../../server/src/__tests__/routes/gemini.test.ts) drives the assembled Express app over HTTP:

- model discovery, `generateContent` (JSON and SSE streaming), `countTokens`;
- tool / thinking / structured-output translation between Gemini's schema dialect and upstream providers;
- family mapping and correct defaults for Gemini CLI (output cap, dynamic thinking, `tool_choice` omission).

### Ollama emulation (opt-in)

[`server/src/__tests__/routes/ollama.test.ts`](../../server/src/__tests__/routes/ollama.test.ts) covers NDJSON `chat`/`generate`, `tags`/`show`/`version`, embeddings, and the mode matrix (off / open loopback / key-required with per-IP rate limiting), plus protocol fidelity details: generate frames, legacy embeddings body, load probes, `done_reason` vocabulary.

### Setup CLI

The `cli/` workspace (added in the same commit, tested by the root chain) generates per-agent configuration for Claude Code, Codex CLI, Cline, Continue, OpenCode, Goose, Qwen Code, Roo/Kilo/Crush, and Cursor — 13 data-driven generators with comment-preserving structural merges (TOML that survives existing MCP tables), backups, dry runs, credential-safe launchers, and Claude Code discovery aliases. Tests: `cli/src/tools.test.ts`, `cli/src/config-files.test.ts` (with snapshots), `cli/src/index.test.ts`.

### Client classification and URL tokens

Client-classifier tests (`server/src/__tests__/lib/client-context.test.ts` and friends) pin agent identification feeding the Agents dashboard and per-agent analytics; [`routes/url-tokens.test.ts`](../../server/src/__tests__/routes/url-tokens.test.ts) covers separately revocable URL tokens used by headerless clients, validated timing-safely.

## What it proves

1. **Protocol fidelity**: an agent speaking native Gemini or Ollama wire formats gets semantically correct answers — streaming frames, tool-call translation, token counting — not merely a 200.
2. **Zero-config onboarding**: the setup CLI writes agent config files correctly even when they already contain unrelated content (structural merge, not overwrite), and never leaks credentials into generated launchers.
3. **Regression safety for hardening**: review-hardening fixes from #629 (Gemini CLI defaults, Ollama protocol edge cases, TOML merge survival, timing-safe token checks) are pinned as tests.

The commit message notes the suite was live-verified against an isolated deployment with real provider keys across all new surfaces — these tests encode those observations so the guarantees survive refactors.
