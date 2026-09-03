# Compression Domain

## Scope

This domain covers the prompt and context compression pipeline that reduces request
size before cache lookup, token budgeting, and routing. It documents the
compression modes (lossless, standard, aggressive), the individual engines,
preservation guarantees and fidelity gates, per-request controls, custom
tool-output filters, and the statistics/preview APIs.

## File index

| File | Description |
| --- | --- |
| [01-compression-pipeline.md](01-compression-pipeline.md) | Complete reference for compression modes, engines, fidelity gates, adaptive triggering, tool-output filters, settings APIs, and MCP tool access. |

## Related

- [../api/](../api/) — API reference showing `X-FreeLLM-Compress` response header.
- [../clients/](../clients/) — Coding agents that benefit from automatic compression.
- [../i18n/zh-CN/docs/compression/](../i18n/zh-CN/docs/compression/) — Simplified Chinese mirror (when translated).