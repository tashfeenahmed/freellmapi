# Logs Domain

## Scope

This domain documents the operator-facing server log viewer in the dashboard: the
two-tier storage architecture (in-memory ring buffer + persisted warn/error
entries), the polling API contract with cursor-based pagination and filtering,
level counts and clear endpoints, configuration via environment variables,
integration with the log redaction pipeline, and the React client implementation.

For the implementation internals (ingest path, structured provider-log metadata,
boot preload, the underlying database schema, and the desktop `freeapi.log` file
logger), see the [Observability deep-dive](../architecture/06-observability.md).

## File index

| File | Description |
| --- | --- |
| [01-server-logs-viewer.md](01-server-logs-viewer.md) | Complete reference for the server logs viewer: two-tier store, `/api/logs` polling API, level counts, clear endpoint, environment variables, and redaction integration. |

## Related

- [../api/](../api/) — API reference for inference endpoints (the log viewer is an admin route under `/api/logs`).
- [../i18n/zh-CN/docs/logs/](../i18n/zh-CN/docs/logs/) — Simplified Chinese mirror (when translated).