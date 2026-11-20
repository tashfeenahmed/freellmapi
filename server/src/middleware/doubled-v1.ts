import type { Request, Response, NextFunction } from 'express';

// `/v1/v1`, `/v1/v1/...` or `/v1/v1?...` (repeats allowed: `/v1/v1/v1/...`).
// Anchored to whole segments so `/v1/v1beta` or `/v1/v1x` are left alone.
const DOUBLED_V1 = /^(?:\/v1)+(?=\/v1(?:[/?]|$))/;

/**
 * Collapse a duplicated `/v1` prefix to a single one (#1956).
 *
 * Anthropic-style clients (Claude Desktop's third-party gateway, Claude Code,
 * the Anthropic SDK) treat the configured base URL as an origin and append
 * `/v1/models`, `/v1/messages` etc. themselves. FreeLLMAPI also advertises an
 * OpenAI-style base URL ending in `/v1`, and when that one is pasted into an
 * Anthropic client every call lands on `/v1/v1/...` and 404s. No route is ever
 * legitimately served under `/v1/v1`, so rewriting is unambiguous.
 */
export function collapseDoubledV1Prefix(req: Request, _res: Response, next: NextFunction): void {
  if (req.url.startsWith('/v1/v1')) {
    req.url = req.url.replace(DOUBLED_V1, '');
  }
  next();
}
