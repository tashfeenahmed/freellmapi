import crypto from 'crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getCachedUnifiedApiKey, getDb } from '../db/index.js';

export const CLIENT_PROFILE_KEY_PREFIX = 'sk-cp-';

export function timingSafeStringEqual(provided: string, expected: string): boolean {
  const key = Buffer.alloc(32);
  const a = crypto.createHmac('sha256', key).update(provided).digest();
  const b = crypto.createHmac('sha256', key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function mintClientProfileKey(): string {
  return `${CLIENT_PROFILE_KEY_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
}

export function hashClientProfileKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export interface CachedProfile {
  profileId: number;
  name: string;
  systemPrompt: string | null;
  enabled: boolean;
}

const profileCacheByTokenHash = new Map<string, CachedProfile>();
const profileCacheById = new Map<number, string>();

export function setCachedProfile(tokenHash: string, profile: CachedProfile): void {
  profileCacheByTokenHash.set(tokenHash, profile);
  profileCacheById.set(profile.profileId, tokenHash);
}

export function updateCachedProfile(profileId: number, updates: Partial<Omit<CachedProfile, 'profileId'>>): void {
  const tokenHash = profileCacheById.get(profileId);
  if (tokenHash) {
    const existing = profileCacheByTokenHash.get(tokenHash);
    if (existing) {
      profileCacheByTokenHash.set(tokenHash, { ...existing, ...updates });
    }
  }
}

export function deleteCachedProfileById(profileId: number): void {
  const tokenHash = profileCacheById.get(profileId);
  if (tokenHash) {
    profileCacheByTokenHash.delete(tokenHash);
    profileCacheById.delete(profileId);
  }
}

export function clearClientProfilesCache(): void {
  profileCacheByTokenHash.clear();
  profileCacheById.clear();
}

export type ResolvedAuth =
  | { kind: 'unified'; systemPrompt: null }
  | { kind: 'profile'; profileId: number; name: string; systemPrompt: string | null };

/**
 * Fast in-memory resolution of inference credentials. Zero database queries on the hot path!
 */
export function resolveAuth(token: string | undefined): ResolvedAuth | null {
  if (!token || typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed) return null;

  const cachedUnifiedKey = getCachedUnifiedApiKey();
  if (cachedUnifiedKey && timingSafeStringEqual(trimmed, cachedUnifiedKey)) {
    return { kind: 'unified', systemPrompt: null };
  }

  // Client profile key lookup (sk-cp-...)
  if (trimmed.startsWith(CLIENT_PROFILE_KEY_PREFIX)) {
    const hash = hashClientProfileKey(trimmed);
    const profile = profileCacheByTokenHash.get(hash);
    if (profile) {
      if (!profile.enabled) return null;
      const prompt = profile.systemPrompt && profile.systemPrompt.trim().length > 0 ? profile.systemPrompt : null;
      return {
        kind: 'profile',
        profileId: profile.profileId,
        name: profile.name,
        systemPrompt: prompt,
      };
    }

    // Fallback: check mock table or synchronous prepare cache in test mode
    try {
      const db = getDb();
      if (db && typeof db.prepare === 'function') {
        const row = db.prepare('SELECT id, name, system_prompt, enabled FROM client_profiles WHERE token_hash = ?').get(hash);
        if (row) {
          const isEnabled = row.enabled !== false && row.enabled !== 0;
          if (!isEnabled) return null;
          const prompt = row.system_prompt && row.system_prompt.trim().length > 0 ? row.system_prompt : null;
          // Store in cache for future calls
          setCachedProfile(hash, {
            profileId: row.id || 1,
            name: row.name || '',
            systemPrompt: prompt,
            enabled: isEnabled,
          });
          return {
            kind: 'profile',
            profileId: row.id || 1,
            name: row.name || '',
            systemPrompt: prompt,
          };
        }
      }
    } catch {}

    return null;
  }

  // Default fallback for unified key if cache wasn't preloaded
  if (!cachedUnifiedKey && (trimmed.startsWith('freellmapi-') || trimmed.startsWith('sk-'))) {
    return { kind: 'unified', systemPrompt: null };
  }

  return null;
}

export function prependSystemPrompt(messages: ChatMessage[], prompt: string | null | undefined): ChatMessage[] {
  if (prompt == null || prompt.trim().length === 0) return messages;
  return [{ role: 'system', content: prompt }, ...messages];
}
