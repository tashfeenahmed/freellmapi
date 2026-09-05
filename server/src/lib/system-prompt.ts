import crypto from 'crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';

// Per-client API keys with server-enforced system prompts (#411). A client
// profile is a second kind of inference credential: it authenticates ONLY the
// /v1 inference surface (proxy + responses), never the /api dashboard routes —
// those require a dashboard session (middleware/requireAuth). The unified key
// keeps today's behavior exactly: full inference access, no injected prompt.

export const CLIENT_PROFILE_KEY_PREFIX = 'sk-cp-';
export const TENANT_KEY_PREFIX = 'freetenant-';

// Constant-time string comparison for inference credentials. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
export function timingSafeStringEqual(provided: string, expected: string): boolean {
  // Use HMAC to produce fixed-length digests so timingSafeEqual always
  // receives same-length buffers regardless of input length. This eliminates
  // both the per-character timing leak and the length-branch timing leak that
  // the Buffer.alloc-on-mismatch approach had.
  const key = Buffer.alloc(32);
  const a = crypto.createHmac('sha256', key).update(provided).digest();
  const b = crypto.createHmac('sha256', key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function mintClientProfileKey(): string {
  return `${CLIENT_PROFILE_KEY_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
}

// Profile keys are stored and looked up by SHA-256 digest, so the DB never
// holds the plaintext for auth purposes (the encrypted copy exists only for
// masked display in the dashboard). The digest also makes the indexed lookup
// timing-independent of the secret's bytes.
export function hashClientProfileKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export type ResolvedAuth =
  | { kind: 'unified'; systemPrompt: null }
  | { kind: 'profile'; profileId: number; name: string; systemPrompt: string | null }
  | { kind: 'tenant'; tenantId: number; name: string; systemPrompt: string | null; allowedModels: string | null };

interface ProfileRow {
  id: number;
  name: string;
  system_prompt: string | null;
  enabled: number;
}

/**
 * Resolve an inference credential. The unified key maps to today's behavior
 * (no enforced prompt); a client-profile key carries its own prompt; a
 * disabled profile is rejected exactly like an unknown key so a revoked
 * client can't distinguish "disabled" from "deleted".
 */
export function resolveAuth(token: string | undefined): ResolvedAuth | null {
  if (!token) return null;
  if (timingSafeStringEqual(token, getUnifiedApiKey())) {
    return { kind: 'unified', systemPrompt: null };
  }
  if (!token.startsWith(CLIENT_PROFILE_KEY_PREFIX) && !token.startsWith(TENANT_KEY_PREFIX)) return null;

  const hash = hashClientProfileKey(token);

  // Check client profiles first (existing behavior)
  if (token.startsWith(CLIENT_PROFILE_KEY_PREFIX)) {
    const row = getDb().prepare(
      'SELECT id, name, system_prompt, enabled FROM client_profiles WHERE token_hash = ?',
    ).get(hash) as ProfileRow | undefined;
    if (!row || !row.enabled) return null;
    const prompt = row.system_prompt != null && row.system_prompt.trim().length > 0
      ? row.system_prompt
      : null;
    return { kind: 'profile', profileId: row.id, name: row.name, systemPrompt: prompt };
  }

  // Check tenants (multi-tenant auth #267)
  if (token.startsWith(TENANT_KEY_PREFIX)) {
    const row = getDb().prepare(
      'SELECT id, name, system_prompt, allowed_models, enabled FROM tenants WHERE token_hash = ?',
    ).get(hash) as { id: number; name: string; system_prompt: string | null; allowed_models: string | null; enabled: number } | undefined;
    if (!row || !row.enabled) return null;
    const prompt = row.system_prompt != null && row.system_prompt.trim().length > 0
      ? row.system_prompt
      : null;
    return { kind: 'tenant', tenantId: row.id, name: row.name, systemPrompt: prompt, allowedModels: row.allowed_models };
  }

  return null;
}

/**
 * Prepend the server-enforced system prompt. It goes FIRST, ahead of any
 * caller-supplied system message, so the enforced instructions take priority
 * while the caller's own system message is preserved after it — the caller
 * can add context but cannot override or remove the profile's prompt.
 * An empty/null prompt is a neutral passthrough: nothing is injected.
 */
export function prependSystemPrompt(messages: ChatMessage[], prompt: string | null | undefined): ChatMessage[] {
  if (prompt == null || prompt.trim().length === 0) return messages;
  return [{ role: 'system', content: prompt }, ...messages];
}
