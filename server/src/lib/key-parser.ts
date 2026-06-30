export interface ParsedKey {
  rawKey: string;
  prefix: string;
  platform: string | null;
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
  AIHORDE_: 'aihorde',
};

export const AUTH_JSON_PROVIDER_MAP: Record<string, string> = {
  gemini: 'google',
  google: 'google',
  groq: 'groq',
  openrouter: 'openrouter',
  'ollama-cloud': 'ollama',
  ollama: 'ollama',
  nvidia: 'nvidia',
  'opencode-zen': 'opencode',
  opencode: 'opencode',
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
    const doubleQuoted = value.startsWith('"') && value.endsWith('"');
    const singleQuoted = value.startsWith("'") && value.endsWith("'");

    if (doubleQuoted || singleQuoted) {
      value = value.slice(1, -1);
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

function toParsedKeys(pairs: Array<{ key: string; value: string }>): ParseResult {
  const keys: ParsedKey[] = [];
  const skipped: string[] = [];

  for (const { key, value } of pairs) {
    const prefix = extractPrefix(key);
    const platform = detectPlatform(prefix);

    if (platform) {
      keys.push({ rawKey: `${key}=${value}`, prefix, platform });
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

export function parseKeysFromFile(content: string, filename: string): ParseResult {
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');

  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
  if (ext === '.json' || ext === '.jsonc') {
    const clean = stripTrailingCommas(stripJsoncComments(text));
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return toParsedKeys(parseDotEnv(text));
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'credential_pool' in parsed) {
      return parseAuthJson(clean);
    }
    return toParsedKeys(parseJson(clean));
  }

  return toParsedKeys(parseDotEnv(text));
}
