// The two base URLs a desktop user may need to paste into a client (#1956).
//
// OpenAI-style clients (Codex, Cline, Aider, the OpenAI SDK...) want the `/v1`
// base and append `/chat/completions` themselves. Anthropic-style clients
// (Claude Desktop's third-party gateway, Claude Code, the Anthropic SDK) want
// the bare origin and append `/v1/messages`, `/v1/models` themselves; handing
// them the `/v1` URL produces `/v1/v1/...`. The tray used to offer only the
// first one behind an unlabelled "Copy URL", which is how #1956 happened.

export type BaseUrlKind = 'openai' | 'anthropic';

export function gatewayBaseUrl(port: number, kind: BaseUrlKind): string {
  const origin = `http://127.0.0.1:${port}`;
  return kind === 'anthropic' ? origin : `${origin}/v1`;
}

// IPC input is untrusted-ish (renderer); anything unexpected falls back to
// the OpenAI URL, which is what the old single button copied.
export function parseBaseUrlKind(raw: unknown): BaseUrlKind {
  return raw === 'anthropic' ? 'anthropic' : 'openai';
}
