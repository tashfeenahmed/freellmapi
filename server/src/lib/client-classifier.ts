import type { Request } from 'express';

export const CLIENT_AGENTS = [
  'claude-code',
  'codex',
  'cline',
  'roo',
  'continue',
  'aider',
  'opencode',
  'goose',
  'qwen-code',
  'kilo-code',
  'crush',
  'deepseek-harness',
  'mimo-code',
  'cursor',
  'gemini-cli',
  'zed',
  'jetbrains',
  'ollama-client',
  'openai-sdk',
  'anthropic-sdk',
  'unknown',
] as const;

export type ClientAgent = (typeof CLIENT_AGENTS)[number];

function header(req: Request, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase() ?? '';
}

/**
 * Best-effort classifier from stable protocol/header signals first, then UA.
 * It intentionally returns a coarse enum: analytics should remain useful when
 * a client revs its version string or wraps an underlying SDK.
 */
export function classifyClientAgent(req: Request): ClientAgent {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0].toLowerCase();
  const tokenizedPath = path.replace(/^\/v1\/t\/[^/]+/, '');
  const ua = header(req, 'user-agent');

  // Strongest signal first: the dedicated session header only Claude Code sets.
  if (header(req, 'x-claude-code-session-id')) return 'claude-code';

  // UA signals must beat wire-format fallbacks: Qwen Code speaks the Gemini
  // wire on /v1beta, and a plain openai SDK can call /v1/responses — neither
  // should be counted as the surface's flagship client. Claude Code's real UA
  // is `claude-cli/x.y.z (external, cli)`.
  if (/claude[- ]?code|\bclaude-cli\b/.test(ua)) return 'claude-code';
  if (/\bcodex\b/.test(ua)) return 'codex';
  if (/qwen[- ]?code|\bqwen-cli\b/.test(ua)) return 'qwen-code';
  if (/gemini[- /]?cli/.test(ua)) return 'gemini-cli';
  if (/kilo[- ]?code|\bkilocode\b/.test(ua)) return 'kilo-code';
  if (/\bcrush(?:\/|\s|$)/.test(ua)) return 'crush';
  // `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`
  if (/deepseek[- ]?harness|\bdsh\//.test(ua)) return 'deepseek-harness';
  // MiMo Code is an OpenCode derivative and can carry either name in its UA,
  // so it has to be tested before the plain `opencode` rule below.
  if (/mimo[- ]?code|\bmimo\//.test(ua)) return 'mimo-code';
  if (/opencode/.test(ua)) return 'opencode';
  if (/\bcline\b/.test(ua)) return 'cline';
  if (/\broo[- /]/.test(ua) || /roo code/.test(ua)) return 'roo';
  if (/continue(?:\.dev)?/.test(ua)) return 'continue';
  if (/\baider\b/.test(ua)) return 'aider';
  if (/\bgoose\b/.test(ua)) return 'goose';
  if (/\bcursor\b/.test(ua)) return 'cursor';
  if (/\bzed\b/.test(ua)) return 'zed';
  if (/jetbrains|intellij|pycharm|webstorm/.test(ua)) return 'jetbrains';
  if (/\bollama\b/.test(ua)) return 'ollama-client';
  if (/anthropic|claude-sdk/.test(ua)) return 'anthropic-sdk';
  if (/openai|langchain|litellm/.test(ua)) return 'openai-sdk';

  // Wire-format fallbacks for clients with no recognizable UA.
  if (path.startsWith('/v1/responses') || tokenizedPath.startsWith('/responses')) return 'codex';
  if (path.startsWith('/v1beta/')) return 'gemini-cli';
  if (path.startsWith('/v1/messages')) {
    // anthropic.ts session affinity treats x-session-id as a Claude Code
    // signal on this surface; anything else Anthropic-shaped stays coarse.
    return header(req, 'x-session-id') ? 'claude-code' : 'anthropic-sdk';
  }
  if (tokenizedPath.startsWith('/api/chat')
      || tokenizedPath.startsWith('/api/generate')
      || tokenizedPath.startsWith('/api/tags')) return 'ollama-client';
  return 'unknown';
}
