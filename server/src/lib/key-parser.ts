/** One model id from a `*_MODELS` list (#382). A capability flag is set only
 *  when the paste declared it via a trailing `-TOOLS` / `-VISION` suffix;
 *  unset means "no opinion" so registration keeps its own defaults. */
export interface ParsedModelEntry {
  id: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export interface ParsedKey {
  rawKey: string;
  prefix: string;
  platform: string | null;
  /** Custom OpenAI-compatible endpoints are identified by their base_url, so a
   *  'custom' key is meaningless without one — the importer refuses those. Set
   *  by the formats that can carry it (export JSON, CSV, and the paired
   *  CUSTOM_<n>_BASE_URL / CUSTOM_<n>_KEY convention in .env). */
  baseUrl?: string;
  /** Custom endpoints only: models declared beside the key via
   *  CUSTOM_<n>_MODELS / <PREFIX>_CUSTOM_MODELS (#382). */
  models?: ParsedModelEntry[];
}

/** A key/value pair on its way to becoming a ParsedKey. `platform` and
 *  `baseUrl` are set only by formats that state them outright (CSV names the
 *  platform in a column); otherwise the platform is inferred from the prefix. */
interface KeyPair {
  key: string;
  value: string;
  platform?: string;
  baseUrl?: string;
  models?: ParsedModelEntry[];
}

export interface ParseResult {
  keys: ParsedKey[];
  skipped: string[];
}

export const PREFIX_MAP: Record<string, string> = {
  GOOGLE_: 'google',
  GEMINI_: 'google',
  GROQ_: 'groq',
  CEREBRAS_: 'cerebras',
  SAIL_: 'sail',
  SAILRESEARCH_: 'sail',
  SAIL_RESEARCH_: 'sail',
  BAI_: 'bai',
  B_AI_: 'bai',
  NVIDIA_: 'nvidia',
  MISTRAL_: 'mistral',
  OPENROUTER_: 'openrouter',
  GITHUB_: 'github',
  COHERE_: 'cohere',
  CLOUDFLARE_: 'cloudflare',
  ZHIPU_: 'zhipu',
  OLLAMA_: 'ollama',
  OLLAMA_CLOUD_: 'ollama',
  HF_: 'huggingface',
  HUGGINGFACE_: 'huggingface',
  OPENCODE_: 'opencode',
  AGNES_: 'agnes',
  REKA_: 'reka',
  SILICONFLOW_: 'siliconflow',
  ROUTEWAY_: 'routeway',
  BAZAARLINK_: 'bazaarlink',
  AINATIVE_: 'ainative',
  AION_: 'aion',
  AIONLABS_: 'aion',
  AION_LABS_: 'aion',
  REQUESTY_: 'requesty',
  NAVY_: 'navy',
  NAVYAI_: 'navy',
  API_NAVY_: 'navy',
  NARA_: 'nara',
  NARAROUTER_: 'nara',
  BYNARA_: 'nara',
  SEALION_: 'sealion',
  SEA_LION_: 'sealion',
  ORCAROUTER_: 'orcarouter',
  ORCA_ROUTER_: 'orcarouter',
  ORCA_: 'orcarouter',
  UNOROUTER_: 'unorouter',
  UNO_ROUTER_: 'unorouter',
  XKIRO_: 'xkiro',
  MODELSCOPE_: 'modelscope',
  MODEL_SCOPE_: 'modelscope',
  ANYAPI_: 'anyapi',
  ANY_API_: 'anyapi',
  AIHORDE_: 'aihorde',
  QIANFAN_: 'qianfan',
  BAIDU_: 'qianfan',
  ERNIE_: 'qianfan',
  VOLCENGINE_: 'volcengine',
  VOLC_: 'volcengine',
  ARK_: 'volcengine',
  DOUBAO_: 'volcengine',
  LONGCAT_: 'longcat',
  XFYUN_: 'xfyun',
  SPARK_: 'xfyun',
  IFLYTEK_: 'xfyun',
};

export const AUTH_JSON_PROVIDER_MAP: Record<string, string> = {
  gemini: 'google',
  google: 'google',
  groq: 'groq',
  sail: 'sail',
  'sail-research': 'sail',
  sailresearch: 'sail',
  bai: 'bai',
  'b-ai': 'bai',
  openrouter: 'openrouter',
  'ollama-cloud': 'ollama',
  ollama: 'ollama',
  nvidia: 'nvidia',
  'opencode-zen': 'opencode',
  opencode: 'opencode',
  aion: 'aion',
  'aion-labs': 'aion',
  aionlabs: 'aion',
  requesty: 'requesty',
  navy: 'navy',
  navyai: 'navy',
  'api-navy': 'navy',
  nara: 'nara',
  bynara: 'nara',
  'nara-router': 'nara',
  sealion: 'sealion',
  'sea-lion': 'sealion',
  orcarouter: 'orcarouter',
  'orca-router': 'orcarouter',
  orca: 'orcarouter',
  unorouter: 'unorouter',
  'uno-router': 'unorouter',
  xkiro: 'xkiro',
  modelscope: 'modelscope',
  'model-scope': 'modelscope',
  anyapi: 'anyapi',
  'any-api': 'anyapi',
  qianfan: 'qianfan',
  baidu: 'qianfan',
  ernie: 'qianfan',
  volcengine: 'volcengine',
  volc: 'volcengine',
  ark: 'volcengine',
  doubao: 'volcengine',
  longcat: 'longcat',
  xfyun: 'xfyun',
  spark: 'xfyun',
  iflytek: 'xfyun',
};

export function detectPlatform(prefix: string): string | null {
  return PREFIX_MAP[prefix] ?? null;
}

export function parseDotEnv(content: string): Array<{ key: string; value: string }> {
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');

  const result = new Map<string, string>();
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trimStart();
    // A quoted value ends at its closing quote; whatever follows is an inline
    // comment, not part of the credential. Matching on endsWith instead meant
    // `KEY="secret" # note` failed the quoted test, took the unquoted branch,
    // and imported the key with its quote characters still attached.
    const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
    const closeIndex = quote ? value.indexOf(quote, 1) : -1;

    if (closeIndex !== -1) {
      value = value.slice(1, closeIndex);
    } else {
      const commentIndex = value.indexOf(' #');
      if (commentIndex !== -1) value = value.slice(0, commentIndex);
      value = value.trimEnd();
    }

    result.set(key, value);
  }

  return Array.from(result.entries()).map(([key, value]) => ({ key, value }));
}

export function stripJsoncComments(text: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '"') {
      out.push('"');
      i++;
      while (i < text.length) {
        out.push(text[i]);
        if (text[i] === '\\') {
          i++;
          if (i < text.length) {
            out.push(text[i]);
            i++;
          }
        } else if (text[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out.push(text[i]);
    i++;
  }

  return out.join('');
}

export function stripTrailingCommas(text: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '"') {
      out.push('"');
      i++;
      while (i < text.length) {
        out.push(text[i]);
        if (text[i] === '\\') {
          i++;
          if (i < text.length) {
            out.push(text[i]);
            i++;
          }
        } else if (text[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (text[i] === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }

    out.push(text[i]);
    i++;
  }

  return out.join('');
}

export function parseJson(content: string): Array<{ key: string; value: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  return Object.entries(parsed)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => ({ key, value }));
}

/**
 * Parse the FreeLLMAPI export JSON format:
 * { version: 1, exportedAt, source, keys: [{ platform, key, label, baseUrl? }] }
 * Returns key-value pairs compatible with toParsedKeys().
 */
export function parseExportJson(content: string): ParseResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (!('keys' in obj) || !Array.isArray(obj.keys)) {
    return null;
  }

  // Validate it looks like our export format (has version + keys array of objects)
  const keys = obj.keys as unknown[];
  if (keys.length > 0 && typeof keys[0] === 'object' && keys[0] !== null && 'platform' in (keys[0] as any) && 'key' in (keys[0] as any)) {
    const result: ParseResult = { keys: [], skipped: [] };
    for (const entry of keys) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const platform = typeof row.platform === 'string' ? row.platform : null;
      const keyValue = typeof row.key === 'string' ? row.key : '';
      const label = typeof row.label === 'string' ? row.label : platform ?? 'imported';

      if (!keyValue.trim()) {
        result.skipped.push(`${label}: empty key value`);
        continue;
      }

      const prefix = platform
        ? (Object.entries(PREFIX_MAP).find(([, v]) => v === platform)?.[0] ?? `${platform.toUpperCase()}_`)
        : '';
      const baseUrl = typeof row.baseUrl === 'string' ? row.baseUrl.trim() : '';
      result.keys.push({ rawKey: `${label}=${keyValue}`, prefix, platform, ...(baseUrl ? { baseUrl } : {}) });
    }
    return result;
  }

  return null;
}

/**
 * Parse CSV format: platform,key,label[,base_url] (with optional header row).
 * The trailing base_url column is what makes a 'custom' row importable — an
 * endpoint is identified by its URL, so a custom key without one is orphaned.
 */
export function parseCsv(content: string): KeyPair[] {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];

  const result: KeyPair[] = [];

  // Skip header row if it looks like a CSV header
  const startIdx = lines[0]!.toLowerCase().startsWith('platform,') ? 1 : 0;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    // Simple CSV parsing: split on comma, strip quotes
    const match = line.match(/^"?([^"]*?)"?,"?([^"]*?)"?(?:,"?([^"]*?)"?)?(?:,"?([^"]*?)"?)?$/);
    if (!match) continue;

    const platform = (match[1] ?? '').trim();
    const key = (match[2] ?? '').trim();
    const baseUrl = (match[4] ?? '').trim();

    if (!key || !platform) continue;

    const envKey = `${platform.toUpperCase()}_KEY`;
    // Name the platform outright rather than re-deriving it from the prefix:
    // 'custom' has no PREFIX_MAP entry, so inference would drop the row.
    result.push({ key: envKey, value: key, platform, ...(baseUrl ? { baseUrl } : {}) });
  }

  return result;
}

export function parseAuthJson(content: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { keys: [], skipped: [] };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { keys: [], skipped: [] };
  }

  const pool = (parsed as Record<string, unknown>).credential_pool;
  if (typeof pool !== 'object' || pool === null || Array.isArray(pool)) {
    return { keys: [], skipped: [] };
  }

  const keys: ParsedKey[] = [];
  const skipped: string[] = [];

  for (const [providerName, credentials] of Object.entries(pool)) {
    if (!Array.isArray(credentials)) {
      skipped.push(`${providerName}: not an array`);
      continue;
    }

    for (const credential of credentials) {
      if (typeof credential !== 'object' || credential === null) continue;
      const row = credential as Record<string, unknown>;
      const label = typeof row.label === 'string'
        ? row.label
        : typeof row.id === 'string'
          ? row.id
          : providerName;

      if ('auth_type' in row && row.auth_type !== 'api_key') {
        skipped.push(`${providerName}/${label}: auth_type is ${String(row.auth_type)}`);
        continue;
      }
      if (typeof row.access_token !== 'string' || row.access_token.trim() === '') {
        skipped.push(`${providerName}/${label}: no access_token`);
        continue;
      }

      const platform = AUTH_JSON_PROVIDER_MAP[providerName] ?? null;
      if (!platform) {
        skipped.push(`${providerName}/${label}: no platform mapping`);
        continue;
      }

      const prefix = Object.entries(PREFIX_MAP).find(([, value]) => value === platform)?.[0] ?? `${platform.toUpperCase()}_`;
      keys.push({ rawKey: `${label}=${row.access_token}`, prefix, platform });
    }
  }

  return { keys, skipped };
}

/**
 * Parse a comma-separated model list (#382). Trailing `-TOOLS` / `-VISION`
 * suffixes — either order, possibly both — strip off the stored id and set the
 * matching capability flag. Trailing ONLY: a TOOLS/VISION inside the id is
 * part of the id, and the suffixes are uppercase by convention so a real model
 * id ending in `-tools` is never mangled.
 */
export function parseModelList(value: string): ParsedModelEntry[] {
  const entries: ParsedModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(',')) {
    let id = raw.trim();
    let tools: boolean | undefined;
    let vision: boolean | undefined;
    for (;;) {
      if (id.endsWith('-TOOLS')) { tools = true; id = id.slice(0, -'-TOOLS'.length); }
      else if (id.endsWith('-VISION')) { vision = true; id = id.slice(0, -'-VISION'.length); }
      else break;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      ...(tools !== undefined ? { supportsTools: tools } : {}),
      ...(vision !== undefined ? { supportsVision: vision } : {}),
    });
  }
  return entries;
}

interface CustomEnvFold {
  pairs: KeyPair[];
  skipped: string[];
}

/**
 * Fold the paired CUSTOM_<n>_BASE_URL / CUSTOM_<n>_KEY lines the .env export
 * writes back into one custom key carrying its endpoint. A plain `CUSTOM_KEY=`
 * with no URL beside it stays unpaired and is skipped downstream, which is the
 * honest outcome: there is no endpoint to attach it to.
 *
 * Model lists ride the same conventions (#382): `CUSTOM_<n>_MODELS=` attaches
 * to the CUSTOM_<n> pair, and `<PREFIX>_CUSTOM_MODELS=` turns a
 * `<PREFIX>_BASE_URL` + `<PREFIX>_API_KEY` (or `<PREFIX>_KEY`) pair in the
 * same paste into a custom endpoint carrying those models. A bare
 * `<PREFIX>_BASE_URL` without a models line beside it keeps its old meaning —
 * only the explicit models declaration makes the trio endpoint-defining.
 * A models line that pairs with nothing is consumed and reported, never
 * imported as if its value were a key.
 */
function pairCustomEndpointEnv(pairs: Array<{ key: string; value: string }>): CustomEnvFold {
  const baseUrls = new Map<string, string>();
  const modelLists = new Map<string, ParsedModelEntry[]>();
  const prefixModels = new Map<string, ParsedModelEntry[]>();
  for (const { key, value } of pairs) {
    const upper = key.toUpperCase();
    let m = upper.match(/^CUSTOM_(.+)_BASE_URL$/);
    if (m && value.trim()) { baseUrls.set(m[1]!, value.trim()); continue; }
    m = upper.match(/^CUSTOM_(.+)_MODELS$/);
    if (m) { modelLists.set(m[1]!, parseModelList(value)); continue; }
    m = upper.match(/^(.+)_CUSTOM_MODELS$/);
    if (m) prefixModels.set(m[1]!, parseModelList(value));
  }
  const prefixUrls = new Map<string, string>();
  for (const { key, value } of pairs) {
    const m = key.toUpperCase().match(/^(.+)_BASE_URL$/);
    if (m && prefixModels.has(m[1]!) && value.trim()) prefixUrls.set(m[1]!, value.trim());
  }
  if (baseUrls.size === 0 && modelLists.size === 0 && prefixModels.size === 0) {
    return { pairs, skipped: [] };
  }

  const out: KeyPair[] = [];
  const attachedLists = new Set<string>();
  const attachedPrefixes = new Set<string>();
  for (const pair of pairs) {
    const upper = pair.key.toUpperCase();
    if (/^CUSTOM_.+_BASE_URL$/.test(upper)) continue; // consumed above
    if (/^CUSTOM_.+_MODELS$/.test(upper) || /^.+_CUSTOM_MODELS$/.test(upper)) continue; // consumed above
    const urlMatch = upper.match(/^(.+)_BASE_URL$/);
    if (urlMatch && prefixUrls.has(urlMatch[1]!)) continue; // consumed above

    const customMatch = upper.match(/^CUSTOM_(.+)_KEY$/);
    const customUrl = customMatch ? baseUrls.get(customMatch[1]!) : undefined;
    if (customMatch && customUrl) {
      const models = modelLists.get(customMatch[1]!);
      if (models !== undefined) attachedLists.add(customMatch[1]!);
      out.push({ ...pair, platform: 'custom', baseUrl: customUrl, ...(models?.length ? { models } : {}) });
      continue;
    }

    // Both spellings can name the endpoint prefix (`X_API_KEY` → X, but also
    // `X_API_KEY` → X_API when the paste used X_API_BASE_URL), so try each.
    const prefixCandidates = [upper.match(/^(.+)_API_KEY$/), upper.match(/^(.+)_KEY$/)];
    let folded = false;
    for (const candidate of prefixCandidates) {
      const prefixUrl = candidate ? prefixUrls.get(candidate[1]!) : undefined;
      if (!candidate || !prefixUrl) continue;
      // A second key line for the same prefix is another credential of the
      // pool; the model list attaches once.
      const models = attachedPrefixes.has(candidate[1]!) ? undefined : prefixModels.get(candidate[1]!);
      attachedPrefixes.add(candidate[1]!);
      out.push({ ...pair, platform: 'custom', baseUrl: prefixUrl, ...(models?.length ? { models } : {}) });
      folded = true;
      break;
    }
    if (folded) continue;

    out.push(pair);
  }

  const skipped: string[] = [];
  for (const n of modelLists.keys()) {
    if (!attachedLists.has(n)) skipped.push(`CUSTOM_${n}_MODELS: no CUSTOM_${n}_BASE_URL / CUSTOM_${n}_KEY pair to attach to`);
  }
  for (const p of prefixModels.keys()) {
    if (!attachedPrefixes.has(p)) skipped.push(`${p}_CUSTOM_MODELS: needs ${p}_BASE_URL and ${p}_API_KEY (or ${p}_KEY) in the same paste`);
  }
  return { pairs: out, skipped };
}

function extractPrefix(key: string): string {
  const upper = key.toUpperCase();
  const direct = Object.keys(PREFIX_MAP)
    .sort((a, b) => b.length - a.length)
    .find(prefix => upper.startsWith(prefix));
  if (direct) return direct;

  const firstUnderscore = upper.indexOf('_');
  if (firstUnderscore === -1) return '';
  const candidate = upper.slice(0, firstUnderscore + 1);
  const rest = upper.slice(firstUnderscore + 1);
  return rest.includes('_') ? candidate : '';
}

export function looksLikeApiKey(value: string): boolean {
  if (value.length < 8) return false;
  const lower = value.toLowerCase();
  if (['true', 'false', 'yes', 'no'].includes(lower)) return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (value.includes('/')) return false;
  return /[a-z]/i.test(value);
}

function toParsedKeys(pairs: KeyPair[]): ParseResult {
  const keys: ParsedKey[] = [];
  const skipped: string[] = [];

  for (const { key, value, platform: statedPlatform, baseUrl, models } of pairs) {
    const prefix = extractPrefix(key);
    const platform = statedPlatform ?? detectPlatform(prefix);

    if (platform) {
      keys.push({
        rawKey: `${key}=${value}`, prefix, platform,
        ...(baseUrl ? { baseUrl } : {}),
        ...(models?.length ? { models } : {}),
      });
      continue;
    }

    if (looksLikeApiKey(value)) {
      keys.push({ rawKey: `${key}=${value}`, prefix, platform: null });
    } else {
      skipped.push(`${key}: value does not look like an API key`);
    }
  }

  return { keys, skipped };
}

function parseEnvText(text: string): ParseResult {
  const folded = pairCustomEndpointEnv(parseDotEnv(text));
  const result = toParsedKeys(folded.pairs);
  return { keys: result.keys, skipped: [...result.skipped, ...folded.skipped] };
}

export function parseKeysFromFile(content: string, filename: string): ParseResult {
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');

  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
  if (ext === '.json' || ext === '.jsonc') {
    const clean = stripTrailingCommas(stripJsoncComments(text));

    // Check for FreeLLMAPI export format first (version + keys array)
    const exportResult = parseExportJson(clean);
    if (exportResult) return exportResult;

    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return parseEnvText(text);
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'credential_pool' in parsed) {
      return parseAuthJson(clean);
    }
    return toParsedKeys(parseJson(clean));
  }

  if (ext === '.csv') {
    return toParsedKeys(parseCsv(text));
  }

  return parseEnvText(text);
}
