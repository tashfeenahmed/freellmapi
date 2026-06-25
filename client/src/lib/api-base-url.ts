/** OpenAI-compatible /v1 base URL for external clients (direct to the backend).
 *  In dev we pin 127.0.0.1 — on Windows, `localhost` can resolve to ::1 and
 *  miss the Node listener while the Vite proxy (also on 127.0.0.1) still works. */
export function apiBaseUrl(): string {
  return import.meta.env.DEV
    ? `http://127.0.0.1:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`
}

/** Bare server origin for Anthropic clients (they append /v1/messages themselves). */
export function apiOrigin(): string {
  return import.meta.env.DEV
    ? `http://127.0.0.1:${__SERVER_PORT__}`
    : window.location.origin
}
