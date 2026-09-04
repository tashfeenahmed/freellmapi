import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { getDb } from '../db/index.js';
import { resolveProvider, getAllProviders } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { parseKeysFromFile, stripJsoncComments, stripTrailingCommas } from '../lib/key-parser.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import { verifyCredentials } from '../services/auth.js';
import { getActiveCooldownsForKeys, clearCooldownsForKey } from '../services/ratelimit.js';
import { resolveCustomEndpointKey, customEndpointKeyIds, siblingEndpointKeyId, endpointHasCredential } from '../services/custom-endpoint.js';
import { registerCustomModels, registerCustomChatModels } from '../services/custom-model-register.js';
import { registerCustomMediaModel } from '../services/custom-media-register.js';
import { discoverEndpointModels, probeEndpointModel, classifyModelId, ModelDiscoveryError } from '../services/model-discovery.js';
import { probeEmbeddingDimensions, registerCustomEmbeddingModel } from '../services/embeddings.js';
import { endpointScopeForBaseUrl, normalizeBaseUrl } from '../lib/endpoint-scope.js';
import { recordCustomModelTombstone } from '../services/custom-model-tombstone.js';
import type { Db } from '../db/types.js';
import { parseModelScope } from '../lib/model-scope.js';
import { KEY_PROXY_URL_ERROR, KEY_PROXY_URL_MAX, decryptProxyUrl, encryptProxyUrl, isValidKeyProxyUrl, maskProxyUrl } from '../lib/key-proxy.js';

export const keysRouter = Router();

// Active providers — must match providers/index.ts registrations + shared/types.ts Platform.
// Moonshot and MiniMax direct integrations were dropped in V4. HuggingFace
// was dropped in V4 and re-added in V13 via the router.huggingface.co route.
// SambaNova was dropped in V23 (free tier permanently retired).
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sail', 'bai', 'radeon', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'ovh', 'agnes', 'reka', 'siliconflow',
  'routeway', 'bazaarlink', 'ainative', 'aion', 'anyapi', 'requesty', 'navy', 'nara', 'sealion', 'orcarouter', 'unorouter', 'xkiro', 'modelscope',
  'qianfan', 'volcengine', 'longcat', 'xfyun', 'aihorde', 'custom',
] as const;

const ALLOWED_IMPORT_EXTENSIONS = new Set(['.env', '.json', '.jsonc', '.md', '.txt', '.csv']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMPORT_EXTENSIONS.has(ext)) {
      cb(new Error('Unsupported file type'));
      return;
    }
    cb(null, true);
  },
});

// `key` is optional so keyless providers (Kilo's anonymous gateway) can be added
// without one; the handler enforces a non-empty key for everyone else.
// #590 (per-key proxy): an optional per-key proxy override. Only schemes the
// proxy layer can actually dispatch through are accepted — an unvalidated
// string would be stored, encrypted, and only surface as a failed dispatcher
// at request time, one attempt at a time. '' = no override (global proxy).
const proxyUrlSchema = z.string().max(KEY_PROXY_URL_MAX).refine(isValidKeyProxyUrl, { message: KEY_PROXY_URL_ERROR });

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().optional(),
  label: z.string().optional(),
  proxyUrl: proxyUrlSchema.optional(),
});

// `modelScope` (#657): the model_id list this key may serve — relay stations
// scope each key to a model group. null (or an empty array) clears the scope,
// returning the key to serving every model of its platform.
const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
  modelScope: z.array(z.string().trim().min(1).max(200)).max(100).nullable().optional(),
  // #590: '' clears the per-key proxy; absent leaves it unchanged.
  proxyUrl: proxyUrlSchema.optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined || data.modelScope !== undefined || data.proxyUrl !== undefined, {
  message: 'At least one of enabled, label, modelScope or proxyUrl must be provided',
});

const importKeySchema = z.object({
  keyName: z.string().optional(),
  keyValue: z.string().min(1),
  platform: z.enum(PLATFORMS),
  // A custom row names an ENDPOINT, so it only means something with the URL
  // the export file carried alongside it (#687).
  baseUrl: z.string().optional(),
  // Models declared beside a custom endpoint in the paste (#382). Ignored for
  // catalog platforms — their model lists come from the catalog, not the file.
  models: z.array(z.object({
    id: z.string().min(1),
    supportsTools: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
  })).max(200).optional(),
});

function handleUploadError(err: any, res: Response, next: NextFunction): boolean {
  if (!err) return false;
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { message: 'File too large. Maximum size is 5MB' } });
    return true;
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    res.status(413).json({ error: { message: 'Too many files. Maximum is 10' } });
    return true;
  }
  if (err.message?.includes('Unsupported file type')) {
    res.status(400).json({ error: { message: 'Unsupported file type' } });
    return true;
  }
  next(err);
  return true;
}

function parseUpload(file: Express.Multer.File) {
  const content = file.buffer.toString('utf8');
  if (!content.trim()) {
    throw Object.assign(new Error('File contains no data'), { status: 400 });
  }

  if (/\.jsonc?$/i.test(file.originalname)) {
    try {
      JSON.parse(stripTrailingCommas(stripJsoncComments(content)));
    } catch {
      throw Object.assign(new Error('Invalid JSON format'), { status: 400 });
    }
  }

  return parseKeysFromFile(content, file.originalname);
}

function splitRawKey(rawKey: string) {
  const eqIndex = rawKey.indexOf('=');
  return {
    keyName: eqIndex === -1 ? rawKey : rawKey.slice(0, eqIndex),
    keyValue: eqIndex === -1 ? '' : rawKey.slice(eqIndex + 1),
  };
}

function insertImportedKey(platform: (typeof PLATFORMS)[number], keyName: string, keyValue: string) {
  if (platform === 'custom') {
    throw new Error('Custom providers must be added with a base URL');
  }
  if (!resolveProvider(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(keyValue.trim());
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, keyName, encrypted, iv, authTag);
}

// Count enabled catalog models for a platform. Used to warn when a key is
// added for a provider that has zero models in the operator's current catalog
// tier — the Agnes case (#438): the provider is registered and selectable, but
// its models ship in the premium/live catalog and only appear for free-tier
// installs once they age into the monthly catalog, so a fresh install adds the
// key and silently sees nothing.
/**
 * Whether a stored row belongs in an export file. Kept in one place because the
 * export dialog shows a count before downloading, and computing that count from
 * a different rule than the export itself made it lie: it promised 40 keys and
 * wrote 39 whenever a no-auth custom endpoint was in the list (#687).
 *
 * A custom endpoint is worth exporting even when it holds only the `no-key`
 * placeholder — the endpoint IS the thing being backed up, and its base_url
 * restores it. Anything else needs a real secret to be worth a line.
 */
export function isExportableKey(row: { platform: string; baseUrl: string | null; key: string }): boolean {
  if (row.platform === 'custom') return Boolean(row.baseUrl);
  const v = row.key.trim();
  return v.length > 0 && v !== 'no-key';
}

function enabledModelCount(platform: string): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM models WHERE platform = ? AND enabled = 1',
  ).get(platform) as { c: number };
  return row.c;
}

// Non-null when the just-added key has no usable models yet, so the client can
// explain the silence instead of leaving the user staring at an empty list.
function noModelsNotice(platform: string): string | undefined {
  if (enabledModelCount(platform) > 0) return undefined;
  return (
    `Key saved, but no ${platform} models are in your current catalog yet. ` +
    `Newer providers are published to the premium catalog first and appear ` +
    `for free-tier installs once they age into the monthly catalog. Add a ` +
    `Premium license key to use them now, or add ${platform} as a custom ` +
    `OpenAI-compatible provider with its base URL.`
  );
}

// Provider checklist (#543): every registered provider with whether the user
// has added at least one key yet, so the dashboard can show what's still
// missing without enumerating the whole list by hand. `custom` is excluded —
// it's a per-key user-defined placeholder, not a fixed free-tier provider to
// "check off".
keysRouter.get('/providers', (_req: Request, res: Response) => {
  const db = getDb();
  const countRows = db.prepare(`
    SELECT
      platform,
      COUNT(*) AS total_keys,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_keys
    FROM api_keys
    GROUP BY platform
  `).all() as Array<{ platform: string; total_keys: number; enabled_keys: number }>;
  const countsByPlatform = new Map(countRows.map(r => [r.platform, r]));

  const providers = getAllProviders()
    .filter(p => p.platform !== 'custom')
    .map(p => {
      const counts = countsByPlatform.get(p.platform);
      const keyCount = counts?.total_keys ?? 0;
      return {
        platform: p.platform,
        name: p.name,
        keyless: p.keyless,
        configured: keyCount > 0,
        keyCount,
        enabledKeyCount: counts?.enabled_keys ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const configured = providers.filter(p => p.configured).length;
  res.json({
    providers,
    summary: {
      total: providers.length,
      configured,
      unconfigured: providers.length - configured,
    },
  });
});

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const customModels = [
    ...db.prepare(`
      SELECT key_id, id, 'chat' AS kind, model_id, display_name, NULL AS family
        FROM models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
    ...db.prepare(`
      SELECT key_id, id, 'embedding' AS kind, model_id, display_name, family
        FROM embedding_models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
    ...db.prepare(`
      SELECT key_id, id, modality AS kind, model_id, display_name, NULL AS family
        FROM media_models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
  ];
  // Models are grouped by ENDPOINT, not by key row: an endpoint can hold
  // several credentials (#619) while each model binds to just one of them, and
  // every one of those keys serves the endpoint's whole model list.
  const endpointOfKey = new Map<number, string>();
  for (const row of rows) {
    if (row.platform === 'custom' && row.base_url) endpointOfKey.set(Number(row.id), row.base_url);
  }
  const endpointOf = (keyId: number) => endpointOfKey.get(keyId) ?? `key:${keyId}`;

  const modelsByEndpoint = new Map<string, any[]>();
  for (const m of customModels) {
    const keyId = Number(m.key_id);
    if (!Number.isInteger(keyId)) continue;
    const list = modelsByEndpoint.get(endpointOf(keyId)) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      modelId: m.model_id,
      displayName: m.display_name,
      family: m.family ?? null,
    });
    modelsByEndpoint.set(endpointOf(keyId), list);
  }
  for (const list of modelsByEndpoint.values()) {
    list.sort((a, b) => {
      const ka = ['chat', 'embedding', 'image', 'audio', 'transcription'].indexOf(a.kind);
      const kb = ['chat', 'embedding', 'image', 'audio', 'transcription'].indexOf(b.kind);
      return (ka - kb) || String(a.displayName).localeCompare(String(b.displayName));
    });
  }

  // A cooling-down key reads as healthy and enabled while the router skips it,
  // so surface the cooldowns that explain the idleness. (#P0-7)
  const cooldownsByKeyId = getActiveCooldownsForKeys(rows.map(row => Number(row.id)));

  const keys = rows.map(row => {
    let maskedKey = '****';
    let realKey = '';
    try {
      realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    const cooldowns = cooldownsByKeyId.get(Number(row.id)) ?? [];
    const scope = parseModelScope(row.model_scope_json);
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      baseUrl: row.base_url ?? null,
      status: row.status,
      enabled: row.enabled === 1,
      keyless: resolveProvider(row.platform)?.keyless === true,
      // Lets the export dialog count exactly what the export will write.
      exportable: isExportableKey({ platform: row.platform, baseUrl: row.base_url ?? null, key: realKey }),
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
      lastHealthError: row.last_health_error ?? null,
      // The model_id list this key is limited to; null = serves everything (#657).
      modelScope: scope ? [...scope] : null,
      // The per-key proxy override with its password masked (#590). '' = no
      // override. Enough for the dashboard to show that a key routes through
      // its own exit, without handing the proxy credentials back out.
      maskedProxyUrl: maskProxyUrl(decryptProxyUrl(row)),
      models: row.platform === 'custom' ? (modelsByEndpoint.get(endpointOf(Number(row.id))) ?? []) : undefined,
      cooldowns: cooldowns.map(c => ({
        modelId: c.modelId,
        expiresAtMs: c.expiresAtMs,
        remainingMs: c.remainingMs,
      })),
    };
  });

  res.json(keys);
});

// Clear every active cooldown for one key. An escalated cooldown can bench a key
// for up to 24h from a single bad window; once the operator has fixed the cause
// there is otherwise no way back short of restarting and waiting it out.
keysRouter.delete('/:id/cooldowns', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid key id' });
    return;
  }

  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get(id);
  if (!exists) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }

  const cleared = clearCooldownsForKey(id);
  res.json({ cleared });
});

// Is the caller connecting from this machine? Read from the real socket peer
// address, NOT req.ip or X-Forwarded-For: those are caller-controlled, so
// trusting them here would let a remote caller claim to be local.
function isLoopbackRemote(req: Request): boolean {
  let addr = req.socket?.remoteAddress ?? '';
  // Node reports IPv4 loopback over a dual-stack socket as "::ffff:127.0.0.1".
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

// #786: the desktop build has no user-set password (its machine user's password
// is random and never shown), so re-verification would lock desktop users out of
// reading their own keys. The embedder marks the process
// (desktop/src/server-host.ts) and the two plaintext-key endpoints below skip
// re-auth for it — but ONLY for a request from this machine. The desktop app can
// bind 0.0.0.0 through its LAN-access toggle, and a remote viewer on that LAN
// still has to prove the password before it can lift a key.
function skipsReauth(req: Request): boolean {
  return process.env.FREEAPI_DESKTOP === '1' && isLoopbackRemote(req);
}

// Export keys — returns plaintext keys in the requested format.
// GET /api/keys/export?format=json|env|csv&healthy=true
// The response is the raw file download (Content-Type varies by format).
// Password re-verification via x-reauth-password header is required, except for
// a local request on the desktop build (see skipsReauth).
keysRouter.get('/export', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!skipsReauth(req)) {
    const password = req.headers['x-reauth-password'] as string | undefined;
    if (!password || !verifyCredentials(user.email, password)) {
      res.status(403).json({ error: { message: 'Password verification required to export keys', type: 'authentication_error' } });
      return;
    }
  }
  const db = getDb();
  const format = (req.query.format as string) ?? 'json';
  const healthyOnly = req.query.healthy === 'true';

  let whereClause = '';
  if (healthyOnly) {
    whereClause = "WHERE status = 'healthy'";
  }

  const rows = db.prepare(`SELECT * FROM api_keys ${whereClause} ORDER BY platform, created_at ASC`).all() as any[];

  // Decrypt and filter — only export keys with a real value
  const decryptedKeys = rows
    .map(row => {
      let key = '';
      try {
        key = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      } catch {
        key = '';
      }
      return {
        platform: row.platform,
        key,
        label: row.label || '',
        baseUrl: row.base_url || undefined,
      };
    })
    .filter(k => isExportableKey({ platform: k.platform, baseUrl: k.baseUrl ?? null, key: k.key }));

  if (decryptedKeys.length === 0) {
    res.status(404).json({ error: { message: 'No keys to export' } });
    return;
  }

  if (format === 'env') {
    // .env format: GOOGLE_KEY=xxx\nGROQ_KEY=yyy
    //
    // Names have to stay unique. A .env is read back into a map keyed by name,
    // so two rows sharing one name collapse into a single imported key — every
    // second Google key was silently lost on a round trip. Repeats therefore
    // take a numeric suffix (GOOGLE_KEY_2), which still resolves to the same
    // platform through PREFIX_MAP.
    //
    // Custom endpoints get an indexed PAIR, because a custom key without its
    // base_url cannot be restored — there is no endpoint to attach it to (#687).
    const seenPerPlatform = new Map<string, number>();
    let customIndex = 0;
    const lines = decryptedKeys.map(k => {
      if (k.platform === 'custom' && k.baseUrl) {
        customIndex++;
        return [
          `# ${k.label || `custom endpoint ${customIndex}`}`,
          `CUSTOM_${customIndex}_BASE_URL=${k.baseUrl}`,
          `CUSTOM_${customIndex}_KEY=${k.key}`,
        ].join('\n');
      }
      const n = (seenPerPlatform.get(k.platform) ?? 0) + 1;
      seenPerPlatform.set(k.platform, n);
      const envKey = `${k.platform.toUpperCase()}_KEY${n > 1 ? `_${n}` : ''}=${k.key}`;
      return k.label ? `# ${k.label}\n${envKey}` : envKey;
    });
    const content = lines.join('\n\n') + '\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.env"');
    res.send(content);
    return;
  }

  if (format === 'csv') {
    // CSV format: platform,key,label
    const escCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
    // CSV formula-injection guard: a spreadsheet treats a cell that starts with
    // =, +, -, @, tab or CR as a live formula, so a label like `=HYPERLINK(...)`
    // would execute on open. Prefix such cells with a single quote to force them
    // to be read as text. Applied only to free-text fields the user controls
    // (labels); the key value must round-trip verbatim for re-import, and the
    // platform is one of our own fixed enum values.
    const neutralize = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    // base_url is the fourth column: a custom row is an ENDPOINT, and without
    // its URL the key cannot be re-imported (#687). Blank for every other
    // platform. The importer tolerates the three-column form too, so files
    // written by older builds still load.
    const header = 'platform,key,label,base_url';
    const lines = decryptedKeys.map(k =>
      [escCsv(k.platform), escCsv(k.key), escCsv(neutralize(k.label)), escCsv(k.baseUrl ?? '')].join(',')
    );
    const content = [header, ...lines].join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.csv"');
    res.send(content);
    return;
  }

  // Default: JSON format (round-trip safe — can be imported directly)
  const jsonExport = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'freellmapi',
    keys: decryptedKeys,
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.json"');
  res.json(jsonExport);
});

// Reveal ONE key in plaintext, so the dashboard can offer a copy action for a
// credential it otherwise only ever shows masked (#705). Exporting every key to
// a file was the only way to read one back, which is a poor trade for "what is
// the key on this row again?". Gated exactly like the export it narrows: the
// session alone is not enough, the password has to be re-entered — except for a
// local request on the desktop build, which has no password to re-enter (see
// skipsReauth; a LAN client of that same desktop server still needs one).
keysRouter.post('/:id/reveal', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!skipsReauth(req)) {
    const password = req.headers['x-reauth-password'] as string | undefined;
    if (!password || !verifyCredentials(user.email, password)) {
      res.status(403).json({ error: { message: 'Password verification required to reveal a key', type: 'authentication_error' } });
      return;
    }
  }

  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const row = getDb().prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?')
    .get(id) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  try {
    res.json({ key: decrypt(row.encrypted_key, row.iv, row.auth_tag) });
  } catch {
    res.status(500).json({ error: { message: 'This key could not be decrypted. It was stored with a different ENCRYPTION_KEY.' } });
  }
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, label } = parsed.data;
  const isKeyless = resolveProvider(platform)?.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  // Keyless providers (Kilo anon) store a sentinel so routing sees the platform
  // as configured; the provider omits the auth header on outgoing calls.
  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  const db = getDb();

  // A keyless provider needs only one sentinel row — re-enable an existing one
  // instead of piling up duplicates each time the user clicks "Add".
  if (isKeyless) {
    const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
      res.status(200).json({
        id: existing.id,
        platform,
        label: label ?? '',
        maskedKey: maskKey(keyToStore),
        status: 'unknown',
        enabled: true,
        modelsAvailable: enabledModelCount(platform),
        notice: noModelsNotice(platform),
      });
      return;
    }
  }

  const { encrypted, iv, authTag } = encrypt(keyToStore);
  // #590: the proxy URL is encrypted like the key itself — it usually embeds
  // `user:pass@` credentials. Absent/'' stores NULLs = no override.
  const proxyUrl = parsed.data.proxyUrl?.trim() ?? '';
  const proxy = encryptProxyUrl(proxyUrl);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, proxy_encrypted, proxy_iv, proxy_auth_tag)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1, ?, ?, ?)
  `).run(platform, label ?? '', encrypted, iv, authTag, proxy.encrypted, proxy.iv, proxy.authTag);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    // Echoed back masked, never in the clear — the response body ends up in
    // logs and dev tools.
    maskedProxyUrl: maskProxyUrl(proxyUrl),
    maskedKey: maskKey(keyToStore),
    status: 'unknown',
    enabled: true,
    modelsAvailable: enabledModelCount(platform),
    notice: noModelsNotice(platform),
  });
});

// ── Custom OpenAI-compatible providers (#117, #212) ───────────────────────
// User-configured endpoints (llama.cpp / LM Studio / vLLM / Ollama / any
// OpenAI-compatible base_url). Each DISTINCT base_url gets its own 'custom'
// api_keys row, and every registered model binds to its endpoint's key via
// models.key_id — so several custom providers coexist without overwriting
// each other (#212). Re-submitting an existing base_url updates its key/label;
// re-registering an existing model id re-binds it to the submitted endpoint.
// A model can be given as a bare id ("qwen3:4b") or as {model, displayName}.
// `model`/`displayName` (singular) stay supported for older clients; `models`
// (plural) lets one submit bind several model ids to the same endpoint. (#281)
// A custom model can declare its capabilities at registration. `supportsTools`
// defaults to 1 (modern OpenAI-compatible servers — Ollama, vLLM, LM Studio —
// all emit tool calls), `supportsVision` defaults to 0 unless declared. Leaving
// a flag unset keeps the DB default on insert and preserves the stored value on
// re-registration, so a capability the user later toggled isn't clobbered. (#470)
const modelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    displayName: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
  }),
]);
// `baseUrl` and `keyId` are both optional but at least one is required: the
// bulk registration that follows model discovery (#488) already holds the
// api_keys row it fetched the list with, and naming that row keeps the new
// models on the same credential of the endpoint's pool (#619/#640).
const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  keyId: z.number().int().positive().optional(),
  model: z.string().optional(),
  models: z.array(modelEntrySchema).optional(),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  // Top-level defaults applied to every model in this submit; a per-entry flag
  // (object form) overrides them for that one model.
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
}).refine(
  d => d.baseUrl !== undefined || d.keyId !== undefined,
  { message: 'baseUrl or keyId is required' },
);
// Naming no model at all is the credential-only add: a second key for an
// endpoint already registered (#702). It needs the endpoint to exist and a key
// to actually add, so those two checks live in the handler where the DB is in
// reach; a submit that is neither that nor a registration still gets the old
// 'model or models is required'.

interface CustomEndpointRef {
  baseUrl: string;
  /** The api_keys row this endpoint is already stored under, or null when the
   *  endpoint has never been registered. */
  keyId: number | null;
  /** Plaintext of that row's credential, when there is one. */
  storedKey: string | null;
}

/**
 * Turn a `{ keyId?, baseUrl? }` reference into the endpoint it names. A keyId
 * is the stronger reference (it identifies one credential of the pool); a bare
 * baseUrl falls back to the endpoint's first stored key, which is how the rest
 * of the custom-endpoint machinery addresses an endpoint. Throws a
 * `{ status, message }` for a reference that names nothing usable.
 */
function resolveEndpointRef(ref: { keyId?: number; baseUrl?: string }): CustomEndpointRef {
  const db = getDb();
  const requestedBaseUrl = ref.baseUrl === undefined ? undefined : normalizeBaseUrl(ref.baseUrl);

  if (ref.keyId !== undefined) {
    const row = db.prepare('SELECT id, platform, base_url, encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?')
      .get(ref.keyId) as { id: number; platform: string; base_url: string | null; encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (!row || row.platform !== 'custom' || !row.base_url) {
      throw Object.assign(new Error('keyId does not name a custom endpoint'), { status: 400 });
    }
    if (requestedBaseUrl !== undefined && requestedBaseUrl !== row.base_url) {
      throw Object.assign(new Error('baseUrl does not match the endpoint keyId belongs to'), { status: 400 });
    }
    let storedKey: string | null = null;
    try {
      storedKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    } catch { /* an undecryptable row still names the endpoint */ }
    return { baseUrl: row.base_url, keyId: row.id, storedKey };
  }

  if (!requestedBaseUrl) {
    throw Object.assign(new Error('baseUrl or keyId is required'), { status: 400 });
  }

  // Any key of this base_url serves the whole endpoint (#619), so the first one
  // is as good a representative as any.
  const rows = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag FROM api_keys
     WHERE platform = 'custom' AND base_url = ? ORDER BY id
  `).all(requestedBaseUrl) as Array<{ id: number; encrypted_key: string; iv: string; auth_tag: string }>;
  for (const row of rows) {
    try {
      return { baseUrl: requestedBaseUrl, keyId: row.id, storedKey: decrypt(row.encrypted_key, row.iv, row.auth_tag) };
    } catch { /* try the next credential */ }
  }
  return { baseUrl: requestedBaseUrl, keyId: rows[0]?.id ?? null, storedKey: null };
}

/**
 * Models attached to an imported custom endpoint (#382). Ids that look like
 * embedding models go through the embeddings path — it needs a dimension, so
 * reuse the stored one when the model is already registered and probe the
 * endpoint (as POST /api/embeddings/custom does) only for a new id. Everything
 * else registers as a chat model. A failure registers as a per-model error and
 * skips that model only: the key import itself has already succeeded.
 */
async function registerImportedModels(
  db: Db,
  baseUrl: string,
  keyId: number,
  apiKey: string,
  keyName: string,
  models: Array<{ id: string; supportsTools?: boolean; supportsVision?: boolean }>,
  errors: Array<{ key: string; error: string }>,
): Promise<number> {
  // #1051: classify by id, not just /embedding/. A whisper, diffusion or video
  // id registered as a chat model 404s in every chain; they go to their own
  // tables (or, for video, are skipped — nothing can serve a custom video
  // model yet).
  const kindOf = (id: string) => /embedding/i.test(id) ? 'embedding' : classifyModelId(id);
  const chat = models.filter(m => kindOf(m.id) === undefined);
  const embeds = models.filter(m => kindOf(m.id) === 'embedding');
  const media = models.filter(m => {
    const kind = kindOf(m.id);
    return kind === 'image' || kind === 'audio' || kind === 'transcription';
  });
  const video = models.filter(m => kindOf(m.id) === 'video');
  let registered = 0;

  if (chat.length > 0) {
    const entries = chat.map(m => ({
      modelId: m.id,
      displayName: null,
      supportsTools: m.supportsTools,
      supportsVision: m.supportsVision,
    }));
    registered += db.transaction(() => registerCustomChatModels(db, baseUrl, keyId, entries))().length;
  }

  for (const m of media) {
    try {
      registerCustomMediaModel(db, keyId, {
        modelId: m.id,
        displayName: null,
        modality: kindOf(m.id) as 'image' | 'audio' | 'transcription',
      });
      registered++;
    } catch (err: any) {
      errors.push({ key: `${keyName}: ${m.id}`, error: err?.message ?? 'media registration failed' });
    }
  }
  for (const m of video) {
    errors.push({ key: `${keyName}: ${m.id}`, error: 'video generation models are not supported on custom endpoints yet; skipped' });
  }

  for (const m of embeds) {
    try {
      const existing = db.prepare(
        "SELECT dimensions FROM embedding_models WHERE platform = 'custom' AND model_id = ?",
      ).get(m.id) as { dimensions: number } | undefined;
      const dimensions = existing?.dimensions ?? await probeEmbeddingDimensions(baseUrl, apiKey, m.id);
      registerCustomEmbeddingModel(db, {
        keyId,
        modelId: m.id,
        displayName: null,
        family: m.id,
        dimensions,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
      });
      registered++;
    } catch (err: any) {
      errors.push({ key: `${keyName}: ${m.id}`, error: err?.message ?? 'embedding registration failed' });
    }
  }

  return registered;
}

// SSRF guard (#440): a base_url is the one user-controlled outbound target.
// Cloud metadata / link-local addresses are rejected outright; private ranges
// too when FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS is set. Re-checked at request
// time in proxyFetch for URLs already in the DB.
async function rejectUnsafeBaseUrl(baseUrl: string, res: Response): Promise<boolean> {
  const verdict = await assessProviderUrl(baseUrl);
  if (verdict.allowed) return false;
  res.status(400).json({ error: { message: `baseUrl rejected: ${verdict.reason}` } });
  return true;
}

// Ask a configured custom endpoint what models it currently serves (#488).
// Relays add and drop models weekly, so re-typing the ids by hand goes stale
// immediately. This reads ONLY the operator's own base_url with the operator's
// own key — it never reads or refreshes the published provider catalog. Nothing
// is written: the picked ids come back through POST /custom to be registered.
const discoverModelsSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  keyId: z.number().int().positive().optional(),
  // Lets the Keys page fetch a list for an endpoint the user is still typing in,
  // before it has been saved. Falls back to the endpoint's stored credential.
  apiKey: z.string().optional(),
}).refine(
  d => d.baseUrl !== undefined || d.keyId !== undefined,
  { message: 'baseUrl or keyId is required' },
);

keysRouter.post('/custom/discover-models', async (req: Request, res: Response) => {
  const parsed = discoverModelsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let endpoint: CustomEndpointRef;
  try {
    endpoint = resolveEndpointRef(parsed.data);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: { message: err.message } });
    return;
  }

  if (await rejectUnsafeBaseUrl(endpoint.baseUrl, res)) return;

  // A submitted key wins (the user may be rotating it); otherwise use what the
  // endpoint already has. Local servers with auth off keep the 'no-key'
  // sentinel, which the bearer header carries harmlessly.
  const apiKey = parsed.data.apiKey?.trim() || endpoint.storedKey || 'no-key';

  try {
    const discovered = await discoverEndpointModels(endpoint.baseUrl, apiKey);

    // "Already registered" means bound to THIS endpoint — any key of the pool
    // counts, since they all serve the same model list (#619).
    const db = getDb();
    const registeredIds = new Set<string>();
    if (endpoint.keyId != null) {
      const poolIds = [...customEndpointKeyIds(db, endpoint.keyId)];
      const placeholders = poolIds.map(() => '?').join(', ');
      const rows = db.prepare(
        `SELECT model_id FROM models WHERE platform = 'custom' AND key_id IN (${placeholders})`,
      ).all(...poolIds) as { model_id: string }[];
      for (const row of rows) registeredIds.add(row.model_id);
    }

    const models = discovered.map(m => ({ ...m, registered: registeredIds.has(m.id) }));
    res.json({
      baseUrl: endpoint.baseUrl,
      keyId: endpoint.keyId,
      models,
      total: models.length,
      registeredCount: models.filter(m => m.registered).length,
    });
  } catch (err: any) {
    if (err instanceof ModelDiscoveryError) {
      // `upstream_error`, never `authentication_error`: this status is relayed
      // from the operator's own endpoint, and a client that reads a bare 401 as
      // "session expired" would sign the operator out for testing a bad key.
      res.status(err.status).json({ error: { message: err.message, type: 'upstream_error' } });
      return;
    }
    res.status(502).json({ error: { message: `Model discovery failed: ${err?.message ?? 'unknown error'}` } });
  }
});

// POST /custom/probe — fire one minimal real chat request at the endpoint so an
// unmeasured model gains a reliability/speed sample without waiting for natural
// traffic (#685 follow-up). Interactive: the operator is watching, so a bounded
// timeout and a clean error beat a silent 120s hang. Only a SUCCESSFUL probe
// writes a `requests` row (which the stats cache folds into the bandit); a
// failure (401 / timeout / unreachable) surfaces the reason and records nothing.
keysRouter.post('/custom/probe', async (req: Request, res: Response) => {
  const parsed = discoverModelsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let endpoint: CustomEndpointRef;
  try {
    endpoint = resolveEndpointRef(parsed.data);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: { message: err.message } });
    return;
  }

  if (await rejectUnsafeBaseUrl(endpoint.baseUrl, res)) return;

  const apiKey = parsed.data.apiKey?.trim() || endpoint.storedKey || 'no-key';

  // Probe a model actually REGISTERED on this endpoint when there is one — the
  // sample must feed the stats of a model the router can pick, not whatever id
  // happens to lead the upstream /models list. Any key of the pool counts
  // (#619), and knowing the id up front also skips the discovery round-trip.
  // Only an endpoint with nothing registered falls back to discovery.
  let registeredModelId: string | null = null;
  // The endpoint's key pool, hoisted so the capability write-back below can
  // scope its UPDATE to the same keys (an unscoped model_id match would touch
  // every unrelated custom endpoint that happens to serve the same id).
  let poolIds: number[] = [];
  if (endpoint.keyId != null) {
    const db = getDb();
    poolIds = [...customEndpointKeyIds(db, endpoint.keyId)];
    const placeholders = poolIds.map(() => '?').join(', ');
    const row = db.prepare(
      `SELECT model_id FROM models WHERE platform = 'custom' AND key_id IN (${placeholders}) ORDER BY id LIMIT 1`,
    ).get(...poolIds) as { model_id: string } | undefined;
    registeredModelId = row?.model_id ?? null;
  }

  try {
    const probe = await probeEndpointModel(endpoint.baseUrl, apiKey, registeredModelId);

    // Only a successful probe records a sample. The row mirrors what the proxy
    // writes on a real request so the decay-weighted stats cache picks it up.
    if (endpoint.keyId != null) {
      getDb().prepare(`
        INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, request_type)
        VALUES ('custom', ?, ?, 'success', ?, ?, ?, ?, 'chat')
      `).run(probe.modelId, endpoint.keyId, probe.inputTokens, probe.outputTokens, probe.latencyMs, probe.latencyMs);

      // A real completion just succeeded, which is stronger evidence than any
      // health ping — lift whatever cooldown was still holding the key back.
      clearCooldownsForKey(endpoint.keyId);
    }

    // Phase 1 (#874): a successful tool-call probe is positive evidence the
    // model speaks the OpenAI tool-call protocol — write it back to the models
    // row so the tool-aware router can pick it. Only a POSITIVE result writes
    // (the "only write success samples" philosophy); a negative/unknown result
    // leaves the existing flag untouched.
    //
    // Scoped to THIS endpoint's key pool: `model_id` alone is not unique across
    // custom endpoints (two relays both serving 'gpt-4o-mini' are two different
    // upstreams), so an unscoped UPDATE would claim tool support for endpoints
    // that were never probed.
    if (probe.toolCalls && poolIds.length > 0) {
      const placeholders = poolIds.map(() => '?').join(', ');
      getDb().prepare(
        `UPDATE models SET supports_tools = 1
          WHERE platform = 'custom' AND model_id = ? AND key_id IN (${placeholders})`,
      ).run(probe.modelId, ...poolIds);
    }

    // Response stays { modelId, latencyMs } for backward compat; capability
    // flags ride along as optional fields the client can opt to render.
    res.json({
      modelId: probe.modelId,
      latencyMs: probe.latencyMs,
      ...(probe.reasoning !== undefined ? { reasoning: probe.reasoning } : {}),
      ...(probe.toolCalls !== undefined ? { toolCalls: probe.toolCalls } : {}),
    });
  } catch (err: any) {
    if (err instanceof ModelDiscoveryError) {
      // `upstream_error`, never `authentication_error`: this status is relayed
      // from the operator's own endpoint, and a client that reads a bare 401 as
      // "session expired" would sign the operator out for testing a bad key.
      res.status(err.status).json({ error: { message: err.message, type: 'upstream_error' } });
      return;
    }
    res.status(502).json({ error: { message: `Probe failed: ${err?.message ?? 'unknown error'}` } });
  }
});

keysRouter.post('/custom', async (req: Request, res: Response) => {
  const parsed = customProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let endpoint: CustomEndpointRef;
  try {
    endpoint = resolveEndpointRef(parsed.data);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: { message: err.message } });
    return;
  }
  const baseUrl = endpoint.baseUrl;

  if (await rejectUnsafeBaseUrl(baseUrl, res)) return;

  // Local servers often need no key; keep a sentinel so there's always a bearer.
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const label = parsed.data.label?.trim() || undefined;

  // Flatten singular + plural inputs into one list, dedupe by model id, drop
  // blanks. Capability flags resolve per-entry first, then fall back to the
  // submit-level defaults, then to undefined (DB default). `displayName` is
  // optional and stays NULL when the submit did not name the model: the field
  // is genuinely optional, so an unnamed model takes its id on insert and keeps
  // whatever name it already has on re-registration (see the upsert below).
  const topTools = parsed.data.supportsTools;
  const topVision = parsed.data.supportsVision;
  const entries: { modelId: string; displayName: string | null; supportsTools?: boolean; supportsVision?: boolean }[] = [];
  const seen = new Set<string>();
  const addEntry = (rawId: string, rawDisplay?: string, tools?: boolean, vision?: boolean) => {
    const modelId = rawId.trim();
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    entries.push({
      modelId,
      displayName: rawDisplay?.trim() || null,
      supportsTools: tools ?? topTools,
      supportsVision: vision ?? topVision,
    });
  };
  if (parsed.data.model?.trim()) addEntry(parsed.data.model, parsed.data.displayName);
  for (const m of parsed.data.models ?? []) {
    if (typeof m === 'string') addEntry(m);
    else addEntry(m.model, m.displayName, m.supportsTools, m.supportsVision);
  }
  // A lone model submitted through the plural `models` also carries its name in
  // the top-level `displayName` — that is exactly what the dashboard's custom
  // form sends, and binding the field to the singular `model` alone silently
  // dropped the name the user typed, leaving the row named after its model id
  // (#704). Only a submit that resolves to ONE unnamed model may take it: a
  // single name cannot fan out across several ids, which is why the form
  // disables the input as soon as a second id is entered.
  const soleName = parsed.data.displayName?.trim();
  if (soleName && !parsed.data.model?.trim() && entries.length === 1 && entries[0]!.displayName === null) {
    entries[0]!.displayName = soleName;
  }

  const db = getDb();

  // Credential-only add (#702): a relay hands out one key per plan, and pooling
  // them is the point of #619, but every route into this handler used to demand
  // a model alongside the key. On an endpoint whose models are all registered
  // there was nothing left to name, so operators invented a throwaway model id
  // to get past the check, and deleting it afterwards took the new key with it.
  if (entries.length === 0) {
    if (!providedKey) {
      res.status(400).json({ error: { message: 'model or models is required' } });
      return;
    }
    if (endpoint.keyId === null) {
      res.status(400).json({ error: { message: 'model or models is required to register a new endpoint' } });
      return;
    }
    if (endpointHasCredential(db, baseUrl, providedKey)) {
      res.status(409).json({ error: { message: 'this endpoint already has that key' } });
      return;
    }
    const added = resolveCustomEndpointKey(db, baseUrl, providedKey, label, endpoint.keyId);
    res.status(added.created ? 201 : 200).json({
      success: true,
      keyId: added.keyId,
      platform: 'custom',
      baseUrl,
      models: [],
      created: 0,
      alreadyRegistered: 0,
      maskedKey: maskKey(added.storedKey),
    });
    return;
  }

  // #1051: a whisper, diffusion or video id submitted here used to register as
  // a chat model and then 404 in every chain. Classify by id and route each
  // entry to the table that can actually serve it. An explicit capability flag
  // on the entry is an operator override: someone who says "this is a chat
  // model with vision/tools" wins over the keyword guess.
  const overridden = (e: typeof entries[number]) => e.supportsTools !== undefined || e.supportsVision !== undefined;
  const kindOf = (e: typeof entries[number]) => overridden(e) ? undefined : classifyModelId(e.modelId);
  const chatEntries = entries.filter(e => kindOf(e) === undefined || kindOf(e) === 'embedding');
  const embedEntries = chatEntries.filter(e => kindOf(e) === 'embedding');
  const pureChatEntries = chatEntries.filter(e => kindOf(e) !== 'embedding');
  const mediaEntries = entries.filter(e => {
    const kind = kindOf(e);
    return kind === 'image' || kind === 'audio' || kind === 'transcription';
  });
  const videoEntries = entries.filter(e => kindOf(e) === 'video');

  const { keyId, storedKey, registered } = registerCustomModels(
    db, baseUrl, providedKey, label, endpoint.keyId ?? undefined, pureChatEntries,
  );

  const mediaRegistered: Array<{ modelDbId: number; model: string; modality: string; created: boolean }> = [];
  const perModelErrors: Array<{ model: string; error: string }> = [];
  for (const e of mediaEntries) {
    try {
      mediaRegistered.push(db.transaction(() => registerCustomMediaModel(db, keyId, {
        modelId: e.modelId,
        displayName: e.displayName,
        modality: kindOf(e) as 'image' | 'audio' | 'transcription',
      }))());
    } catch (err: any) {
      perModelErrors.push({ model: e.modelId, error: err?.message ?? 'media registration failed' });
    }
  }

  const embeddingsRegistered: Array<{ model: string }> = [];
  for (const e of embedEntries) {
    try {
      const existing = db.prepare(
        "SELECT dimensions FROM embedding_models WHERE platform = 'custom' AND model_id = ?",
      ).get(e.modelId) as { dimensions: number } | undefined;
      const dimensions = existing?.dimensions ?? await probeEmbeddingDimensions(baseUrl, providedKey ?? storedKey, e.modelId);
      registerCustomEmbeddingModel(db, {
        keyId,
        modelId: e.modelId,
        displayName: e.displayName,
        family: e.modelId,
        dimensions,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
      });
      embeddingsRegistered.push({ model: e.modelId });
    } catch (err: any) {
      perModelErrors.push({ model: e.modelId, error: err?.message ?? 'embedding registration failed' });
    }
  }

  // `model`/`displayName`/`modelDbId` echo the first model for older clients;
  // `models` carries the full set registered in this call.
  const first = registered[0];
  res.status(201).json({
    success: true,
    keyId,
    ...(first ? {
      modelDbId: first.modelDbId,
      model: first.model,
      displayName: first.displayName,
      supportsTools: first.supportsTools,
      supportsVision: first.supportsVision,
    } : {}),
    platform: 'custom',
    baseUrl,
    models: registered,
    media: mediaRegistered,
    embeddings: embeddingsRegistered,
    // Video generation has no custom-endpoint serving path yet; saying so
    // beats registering a chat model that can never answer.
    videoSkipped: videoEntries.map(e => e.modelId),
    modelErrors: perModelErrors,
    // Bulk registration (#488) needs to tell the user what actually changed:
    // picking a whole discovered list re-submits ids that are already there.
    created: registered.filter(m => m.created).length
      + mediaRegistered.filter(m => m.created).length
      + embeddingsRegistered.length,
    alreadyRegistered: registered.filter(m => !m.created).length
      + mediaRegistered.filter(m => !m.created).length,
    maskedKey: maskKey(storedKey),
  });
});

keysRouter.post('/import', (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, async (err: any) => {
    if (handleUploadError(err, res, next)) return;

    try {
      if (!req.file) {
        res.status(400).json({ error: { message: 'No file uploaded' } });
        return;
      }

      const result = parseUpload(req.file);
      const imported: Array<{ keyName: string; platform: string }> = [];
      const skipped = [...result.skipped];
      const errors: Array<{ key: string; error: string }> = [];
      let modelsRegistered = 0;
      // One SSRF verdict per endpoint, not per key: a pooled endpoint (#619)
      // brings several keys to the same URL and each check costs a DNS lookup.
      const urlVerdicts = new Map<string, { allowed: boolean; reason?: string }>();

      for (const parsedKey of result.keys) {
        const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
        if (!parsedKey.platform) {
          skipped.push(keyName);
          continue;
        }
        const platformParse = z.enum(PLATFORMS).safeParse(parsedKey.platform);
        if (!platformParse.success) {
          skipped.push(keyName);
          continue;
        }

        // Custom rows name an ENDPOINT. They used to be dropped outright, which
        // made every export/import round trip lose them (#687); they import now,
        // but only with the base_url that says where the endpoint is.
        if (platformParse.data === 'custom') {
          if (!parsedKey.baseUrl) {
            skipped.push(keyName);
            continue;
          }
          const baseUrl = normalizeBaseUrl(parsedKey.baseUrl);
          // Same SSRF guard the manual add path uses (#440) — an import file is
          // just as capable of naming a cloud metadata address.
          let verdict = urlVerdicts.get(baseUrl);
          if (!verdict) {
            verdict = await assessProviderUrl(baseUrl);
            urlVerdicts.set(baseUrl, verdict);
          }
          if (!verdict.allowed) {
            errors.push({ key: keyName, error: `baseUrl rejected: ${verdict.reason}` });
            continue;
          }
          try {
            // A placeholder value means "endpoint with auth off" — hand it to
            // the resolver as "no key submitted" so it stores the sentinel once
            // instead of treating 'no-key' as a real secret.
            const secret = keyValue.trim() === 'no-key' ? undefined : keyValue.trim() || undefined;
            const db = getDb();
            const resolved = resolveCustomEndpointKey(db, baseUrl, secret, keyName);
            imported.push({ keyName, platform: 'custom' });
            if (parsedKey.models?.length) {
              modelsRegistered += await registerImportedModels(
                db, baseUrl, resolved.keyId, resolved.storedKey, keyName, parsedKey.models, errors,
              );
            }
          } catch (insertErr) {
            errors.push({ key: keyName, error: (insertErr as Error).message });
          }
          continue;
        }

        if (!keyValue.trim()) {
          errors.push({ key: keyName, error: 'keyValue must be at least 1 character' });
          continue;
        }

        try {
          insertImportedKey(platformParse.data, keyName, keyValue);
          imported.push({ keyName, platform: platformParse.data });
        } catch (insertErr) {
          errors.push({ key: keyName, error: (insertErr as Error).message });
        }
      }

      res.json({
        imported: imported.length,
        skipped,
        errors,
        total: result.keys.length + result.skipped.length,
        modelsRegistered,
      });
    } catch (handlerErr: any) {
      res.status(handlerErr.status ?? 500).json({ error: { message: handlerErr.message } });
    }
  });
});

keysRouter.post('/preview', (req: Request, res: Response, next: NextFunction) => {
  upload.array('files', 10)(req, res, (err: any) => {
    if (handleUploadError(err, res, next)) return;

    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        res.status(400).json({ error: { message: 'No files uploaded' } });
        return;
      }

      const keys: Array<{
        keyName: string; keyValue: string; detectedPlatform: string | null; prefix: string;
        baseUrl?: string; models?: Array<{ id: string; supportsTools?: boolean; supportsVision?: boolean }>;
        isDuplicate: boolean;
      }> = [];
      const skipped: string[] = [];

      // Build a set of existing decrypted key values for duplicate detection
      const db = getDb();
      const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
      const existingKeys = new Set<string>();
      for (const row of existingRows) {
        try {
          existingKeys.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
        } catch { /* skip undecryptable rows */ }
      }

      let duplicateCount = 0;

      for (const file of files) {
        const result = parseUpload(file);
        for (const parsedKey of result.keys) {
          const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
          const isDuplicate = existingKeys.has(keyValue.trim());
          if (isDuplicate) duplicateCount++;
          keys.push({
            keyName,
            keyValue,
            detectedPlatform: parsedKey.platform,
            prefix: parsedKey.prefix,
            // Without this the dialog can show a custom row but never restore
            // it — the endpoint it belongs to would be lost between the two
            // calls the dashboard actually makes (#687). Models ride the same
            // round trip (#382).
            ...(parsedKey.baseUrl ? { baseUrl: parsedKey.baseUrl } : {}),
            ...(parsedKey.models?.length ? { models: parsedKey.models } : {}),
            isDuplicate,
          });
        }
        skipped.push(...result.skipped);
      }

      res.json({ keys, total: keys.length, skipped, duplicates: duplicateCount });
    } catch (handlerErr: any) {
      res.status(handlerErr.status ?? 500).json({ error: { message: handlerErr.message } });
    }
  });
});

keysRouter.post('/import-selected', async (req: Request, res: Response) => {
  const parsed = z.object({ keys: z.array(importKeySchema).max(100) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let imported = 0;
  let modelsRegistered = 0;
  const errors: Array<{ key: string; error: string }> = [];

  // Build a set of existing decrypted key values for duplicate detection
  const db = getDb();
  const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
  const existingKeys = new Set<string>();
  for (const row of existingRows) {
    try {
      existingKeys.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
    } catch { /* skip undecryptable rows */ }
  }

  // One SSRF verdict per endpoint, not per key — same reasoning as /import: a
  // pooled endpoint brings several keys to one URL and each check costs a DNS
  // lookup.
  const urlVerdicts = new Map<string, { allowed: boolean; reason?: string }>();

  for (const key of parsed.data.keys) {
    const keyName = key.keyName?.trim() || key.platform;
    // This is the route the dashboard actually uses (preview → import-selected),
    // so a custom endpoint could not be restored from its own export file until
    // it handled one — /import alone was never reachable from the UI (#687).
    if (key.platform === 'custom') {
      if (!key.baseUrl) {
        errors.push({ key: keyName, error: 'Custom providers must be added with a base URL' });
        continue;
      }
      const baseUrl = normalizeBaseUrl(key.baseUrl);
      // An import file can name a cloud metadata address just as easily as the
      // manual add form can (#440), so it gets the same guard.
      let verdict = urlVerdicts.get(baseUrl);
      if (!verdict) {
        verdict = await assessProviderUrl(baseUrl);
        urlVerdicts.set(baseUrl, verdict);
      }
      if (!verdict.allowed) {
        errors.push({ key: keyName, error: `baseUrl rejected: ${verdict.reason}` });
        continue;
      }
      try {
        // 'no-key' is the auth-less-local-server placeholder, not a secret —
        // hand it over as "no key submitted" so the resolver stores the
        // sentinel once instead of encrypting the literal string. Going
        // through the resolver (not a raw INSERT) keeps endpoint pooling
        // intact, so re-importing does not duplicate the row (#619).
        const secret = key.keyValue.trim() === 'no-key' ? undefined : key.keyValue.trim() || undefined;
        const resolved = resolveCustomEndpointKey(db, baseUrl, secret, keyName);
        imported++;
        if (key.models?.length) {
          modelsRegistered += await registerImportedModels(
            db, baseUrl, resolved.keyId, resolved.storedKey, keyName, key.models, errors,
          );
        }
      } catch (err) {
        errors.push({ key: keyName, error: (err as Error).message });
      }
      continue;
    }

    if (existingKeys.has(key.keyValue.trim())) {
      errors.push({ key: keyName, error: 'Duplicate key — already exists' });
      continue;
    }

    try {
      insertImportedKey(key.platform, keyName, key.keyValue);
      imported++;
      existingKeys.add(key.keyValue.trim());
    } catch (err) {
      errors.push({ key: keyName, error: (err as Error).message });
    }
  }

  res.json({
    imported,
    skipped: [],
    errors,
    total: parsed.data.keys.length,
    modelsRegistered,
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform, base_url FROM api_keys WHERE id = ?').get(id) as { platform: string; base_url: string | null } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }
  // Another credential for the SAME endpoint keeps it alive — the models move
  // over to it instead of being cascaded away with this key (#619).
  const sibling = row.platform === 'custom' ? siblingEndpointKeyId(db, id, row.base_url) : null;

  const remove = db.transaction(() => {
    if (sibling != null) {
      for (const table of ['models', 'embedding_models', 'media_models']) {
        db.prepare(`UPDATE ${table} SET key_id = ? WHERE platform = 'custom' AND key_id = ?`).run(sibling, id);
      }
      db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
      return;
    }

    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    // Custom models exist only because POST /custom registered them alongside
    // their endpoint key (#117) — they can't route without it. Cascade away
    // the models bound to THIS endpoint (#212); other custom providers keep
    // theirs. Legacy rows (key_id NULL) are swept once no custom keys remain,
    // so they never linger in the fallback chain forever (#189).
    if (row.platform === 'custom') {
      const defaultEmbedding = db.prepare("SELECT value FROM settings WHERE key = 'embeddings_default_family'").get() as { value: string } | undefined;
      // #926: the scheduled custom-model sync only knows a model by "is it in
      // the table yet". Without a tombstone, a key the operator deleted to get
      // rid of its models would have them all re-registered by the next pass.
      const scope = endpointScopeForBaseUrl(row.base_url);
      const doomed = db.prepare("SELECT model_id FROM models WHERE platform = 'custom' AND key_id = ?").all(id) as { model_id: string }[];
      for (const m of doomed) recordCustomModelTombstone(db, scope, m.model_id);
      db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom' AND key_id = ?)").run(id);
      db.prepare("DELETE FROM models WHERE platform = 'custom' AND key_id = ?").run(id);
      db.prepare("DELETE FROM embedding_models WHERE platform = 'custom' AND key_id = ?").run(id);
      db.prepare("DELETE FROM media_models WHERE platform = 'custom' AND key_id = ?").run(id);
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number };
      if (remaining.n === 0) {
        db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
        db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
        db.prepare("DELETE FROM embedding_models WHERE platform = 'custom'").run();
        db.prepare("DELETE FROM media_models WHERE platform = 'custom'").run();
      }
      if (defaultEmbedding) {
        const stillExists = db.prepare('SELECT 1 FROM embedding_models WHERE family = ? LIMIT 1').get(defaultEmbedding.value);
        if (!stillExists) {
          const replacement = db.prepare('SELECT family FROM embedding_models ORDER BY family, priority LIMIT 1').get() as { family: string } | undefined;
          if (replacement) {
            db.prepare("UPDATE settings SET value = ? WHERE key = 'embeddings_default_family'").run(replacement.family);
          }
        }
      }
    }
  });
  remove();

  res.json({ success: true });
});

// Toggle all keys for a platform
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);

  res.json({ success: true, enabled, updatedKeys: result.changes });
});

// Update key (toggle enable/disable or edit label)
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label, modelScope, proxyUrl } = parsed.data;
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }
  // #590: stored encrypted (credentials), so a change rewrites all three
  // columns; '' clears them to NULL.
  if (proxyUrl !== undefined) {
    const proxy = encryptProxyUrl(proxyUrl);
    updates.push('proxy_encrypted = ?', 'proxy_iv = ?', 'proxy_auth_tag = ?');
    values.push(proxy.encrypted, proxy.iv, proxy.authTag);
  }
  // Deduped; an empty result stores NULL, which the router reads as "unscoped".
  const scopeIds = modelScope == null ? [] : [...new Set(modelScope)];
  if (modelScope !== undefined) {
    updates.push('model_scope_json = ?');
    values.push(scopeIds.length > 0 ? JSON.stringify(scopeIds) : null);
  }

  values.push(id);

  const db = getDb();
  const result = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const response: Record<string, unknown> = { success: true };
  if (enabled !== undefined) response.enabled = enabled;
  if (label !== undefined) response.label = label;
  if (proxyUrl !== undefined) response.maskedProxyUrl = maskProxyUrl(proxyUrl);
  if (modelScope !== undefined) response.modelScope = scopeIds.length > 0 ? scopeIds : null;
  res.json(response);
});
