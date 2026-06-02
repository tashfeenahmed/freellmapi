/**
 * Key parser — parses API keys from .env, .json, and .js config files.
 *
 * Provides format detection, prefix-based platform mapping, and batch parsing
 * for the POST /api/keys/import endpoint.
 *
 * @see server/src/__tests__/lib/key-parser.test.ts
 */

import { parse } from 'acorn';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedKey {
  rawKey: string;
  prefix: string;
  platform: string | null;
}

export interface ParseResult {
  keys: ParsedKey[];
  skipped: string[];
}

// ---------------------------------------------------------------------------
// PREFIX_MAP — recognised platform env-var prefixes → platform names
// ---------------------------------------------------------------------------

export const PREFIX_MAP: Record<string, string> = {
  GOOGLE_: 'google',
  GROQ_: 'groq',
  CEREBRAS_: 'cerebras',
  SAMBANOVA_: 'sambanova',
  NVIDIA_: 'nvidia',
  MISTRAL_: 'mistral',
  OPENROUTER_: 'openrouter',
  GITHUB_: 'github',
  COHERE_: 'cohere',
  CLOUDFLARE_: 'cloudflare',
  ZHIPU_: 'zhipu',
  OLLAMA_: 'ollama',
  HF_: 'huggingface',
};

// ---------------------------------------------------------------------------
// AUTH_JSON_PROVIDER_MAP — Hermes/OpenCode auth.json provider → platform
// ---------------------------------------------------------------------------

export const AUTH_JSON_PROVIDER_MAP: Record<string, string> = {
  'gemini': 'google',
  'openrouter': 'openrouter',
  'ollama-cloud': 'ollama',
  'nvidia': 'nvidia',
};

// ---------------------------------------------------------------------------
// detectPlatform
// ---------------------------------------------------------------------------

export function detectPlatform(prefix: string): string | null {
  return PREFIX_MAP[prefix] ?? null;
}

// ---------------------------------------------------------------------------
// parseDotEnv
// ---------------------------------------------------------------------------

export function parseDotEnv(content: string): Array<{ key: string; value: string }> {
  // Strip BOM
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // Normalise CRLF → LF
  text = text.replace(/\r\n/g, '\n');

  const lines = text.split('\n');
  const resultMap = new Map<string, string>();

  for (let line of lines) {
    line = line.trim();

    // Skip blank / whitespace-only / comment lines
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      continue; // no `=` → not a key=value line
    }

    // Key: everything before first `=`, trailing whitespace stripped
    const key = line.slice(0, eqIndex).trimEnd();

    // Value: everything after first `=`
    let value = line.slice(eqIndex + 1);

    // Strip leading whitespace from the value
    value = value.trimStart();

    // Quoted value detection
    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");

    if (isDoubleQuoted || isSingleQuoted) {
      // Strip surrounding quotes, preserve internal whitespace
      value = value.slice(1, -1);
    } else {
      // Unquoted value — strip inline comments (` #…`)
      const commentIdx = value.indexOf(' #');
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx);
      }

      // Strip trailing whitespace
      value = value.trimEnd();
    }

    // Deduplicate: last occurrence wins
    resultMap.set(key, value);
  }

  return Array.from(resultMap.entries()).map(([key, value]) => ({ key, value }));
}

// ---------------------------------------------------------------------------
// parseJson
// ---------------------------------------------------------------------------

export function parseJson(content: string): Array<{ key: string; value: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  // Only plain objects are valid entry sources
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  const result: Array<{ key: string; value: string }> = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      result.push({ key, value });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// parseJavaScript
// ---------------------------------------------------------------------------

export function parseJavaScript(content: string): Array<{ key: string; value: string }> {
  let ast: unknown;
  try {
    ast = parse(content, { ecmaVersion: 2022, sourceType: 'module' });
  } catch {
    return [];
  }

  const result: Array<{ key: string; value: string }> = [];

  /**
   * Extract string-literal key/value pairs from an ObjectExpression node.
   * Non-string values are silently skipped (they are not reported — the
   * caller tracks skipped entries separately when needed).
   */
  function extractFromObjectExpression(objExpr: Record<string, unknown>): void {
    const properties = objExpr.properties;
    if (!Array.isArray(properties)) return;

    for (const prop of properties) {
      if (!prop || typeof prop !== 'object') continue;
      if ((prop as Record<string, unknown>).type !== 'Property') continue;

      const p = prop as Record<string, unknown>;
      const keyNode = p.key as Record<string, unknown> | undefined;
      const valNode = p.value as Record<string, unknown> | undefined;

      if (!keyNode || !valNode) continue;

      // Key: Identifier ('FOO') or string Literal ('"FOO"')
      let key: string | null = null;
      if (keyNode.type === 'Identifier' && typeof keyNode.name === 'string') {
        key = keyNode.name;
      } else if (keyNode.type === 'Literal' && typeof (keyNode as Record<string, unknown>).value === 'string') {
        key = (keyNode as Record<string, unknown>).value as string;
      }
      if (key === null) continue;

      // Value must be a string Literal
      if (valNode.type === 'Literal' && typeof (valNode as Record<string, unknown>).value === 'string') {
        result.push({ key, value: (valNode as Record<string, unknown>).value as string });
      }
    }
  }

  /**
   * Walk the AST looking for:
   *   module.exports = { … }
   *   export default { … }
   */
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;

    const n = node as Record<string, unknown>;

    // ExpressionStatement: module.exports = { … }
    if (
      n.type === 'ExpressionStatement' &&
      n.expression &&
      typeof n.expression === 'object'
    ) {
      const expr = n.expression as Record<string, unknown>;
      if (
        expr.type === 'AssignmentExpression' &&
        expr.left &&
        typeof expr.left === 'object'
      ) {
        const left = expr.left as Record<string, unknown>;
        if (
          left.type === 'MemberExpression' &&
          left.object &&
          typeof left.object === 'object' &&
          (left.object as Record<string, unknown>).type === 'Identifier' &&
          (left.object as Record<string, unknown>).name === 'module' &&
          left.property &&
          typeof left.property === 'object' &&
          (left.property as Record<string, unknown>).type === 'Identifier' &&
          (left.property as Record<string, unknown>).name === 'exports' &&
          expr.right &&
          typeof expr.right === 'object' &&
          (expr.right as Record<string, unknown>).type === 'ObjectExpression'
        ) {
          extractFromObjectExpression(expr.right as Record<string, unknown>);
          return; // stop — we found what we need
        }
      }
    }

    // ExportDefaultDeclaration: export default { … }
    if (
      n.type === 'ExportDefaultDeclaration' &&
      n.declaration &&
      typeof n.declaration === 'object' &&
      (n.declaration as Record<string, unknown>).type === 'ObjectExpression'
    ) {
      extractFromObjectExpression(n.declaration as Record<string, unknown>);
      return;
    }

    // Recurse into children
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object') walk(item);
        }
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  }

  walk(ast);

  return result;
}

// ---------------------------------------------------------------------------
// parseAuthJson — Hermes/OpenCode auth.json parser
// ---------------------------------------------------------------------------

/**
 * Parse a Hermes/OpenCode auth.json file that uses a `credential_pool`
 * structure.  Returns a ParseResult with only the recognised API-key
 * credentials (skips OAuth tokens, missing access_tokens, and unmapped
 * providers).
 */
export function parseAuthJson(content: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { keys: [], skipped: [] };
  }

  // Only plain objects are valid
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { keys: [], skipped: [] };
  }

  const obj = parsed as Record<string, unknown>;
  if (!('credential_pool' in obj)) {
    return { keys: [], skipped: [] };
  }

  const credentialPool = obj['credential_pool'];
  if (typeof credentialPool !== 'object' || credentialPool === null || Array.isArray(credentialPool)) {
    return { keys: [], skipped: [] };
  }

  const keys: ParsedKey[] = [];
  const skipped: string[] = [];

  for (const [providerName, credentials] of Object.entries(credentialPool)) {
    if (!Array.isArray(credentials)) {
      skipped.push(`${providerName}: not an array`);
      continue;
    }

    for (const cred of credentials) {
      if (typeof cred !== 'object' || cred === null) {
        continue;
      }

      const credObj = cred as Record<string, unknown>;

      // Skip credentials where auth_type exists and is not 'api_key'
      if ('auth_type' in credObj && credObj.auth_type !== 'api_key') {
        skipped.push(`${providerName}/${credObj.label ?? credObj.id}: auth_type is ${credObj.auth_type}`);
        continue;
      }

      // Skip credentials without an access_token
      if (!('access_token' in credObj) || typeof credObj.access_token !== 'string' || credObj.access_token === '') {
        skipped.push(`${providerName}/${credObj.label ?? credObj.id}: no access_token`);
        continue;
      }

      const label = typeof credObj.label === 'string' ? credObj.label
        : typeof credObj.id === 'string' ? credObj.id
        : 'unknown';

      const accessToken = credObj.access_token;

      // Look up provider in AUTH_JSON_PROVIDER_MAP
      const mappedPlatform = AUTH_JSON_PROVIDER_MAP[providerName];

      let platform: string;
      let prefix: string;

      if (mappedPlatform) {
        platform = mappedPlatform;
        // Derive prefix from PREFIX_MAP (e.g. 'google' → 'GOOGLE_')
        const prefixEntry = Object.entries(PREFIX_MAP).find(([, v]) => v === mappedPlatform);
        prefix = prefixEntry ? prefixEntry[0] : `${mappedPlatform.toUpperCase()}_`;
      } else {
        platform = 'unknown';
        prefix = `${providerName.toUpperCase()}_`;
        skipped.push(`${providerName}/${label}: no platform mapping`);
      }

      keys.push({
        rawKey: `${label}=${accessToken}`,
        prefix,
        platform,
      });
    }
  }

  return { keys, skipped };
}

// ---------------------------------------------------------------------------
// Prefix helpers
// ---------------------------------------------------------------------------

/**
 * Extract the platform env-var prefix from a key name.
 *
 * Strategy:
 *  1. If the key begins with a recognised PREFIX_MAP entry → return that prefix.
 *  2. Otherwise, extract everything up to the first underscore, but only
 *     if the remainder of the key itself contains at least one underscore
 *     (i.e. the key has the shape `PREFIX_REST_WITH_UNDERSCORE`).
 *  3. Otherwise → ''.
 */
function extractPrefix(key: string): string {
  const firstUnderscore = key.indexOf('_');
  if (firstUnderscore === -1) return '';

  const candidate = key.slice(0, firstUnderscore + 1);

  // Known prefix → use it
  if (candidate in PREFIX_MAP) return candidate;

  // Unknown prefix → only extract when there is more structure
  // (a second underscore in the remainder)
  const rest = key.slice(firstUnderscore + 1);
  if (rest.includes('_')) return candidate;

  return '';
}

/**
 * Resolve the platform name for a prefix; returns the name or 'unknown'.
 */
function resolvePlatform(prefix: string): string {
  return detectPlatform(prefix) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// looksLikeApiKey — value-based heuristic to filter out non-API-key values
// ---------------------------------------------------------------------------

/**
 * Returns true when the given value *looks* like an API key (or an opaque
 * credential token).  This is intentionally permissive — it only rejects
 * values that are **clearly** not keys:
 *
 *  - Shorter than 8 characters
 *  - Boolean literals (`true`, `false`, `yes`, `no`)
 *  - Pure numbers (integers and decimals)
 *  - URLs (`http://…`, `https://…`)
 *  - Values without any alphabetic character
 */
export function looksLikeApiKey(value: string): boolean {
  if (value.length < 8) return false;

  const lower = value.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'yes' || lower === 'no') return false;

  // Pure number (integer or decimal)
  if (/^-?\d+(\.\d+)?$/.test(value)) return false;

  // URL
  if (/^https?:\/\//.test(lower)) return false;

  // Docker image / file path (no API key format uses '/')
  if (value.includes('/')) return false;

  // Must contain at least one alphabetic character
  if (!/[a-zA-Z]/.test(value)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers for parseKeysFromFile
// ---------------------------------------------------------------------------

/**
 * Parse a `.env` file (or unknown/file extension → env fallback).
 */
function parseEnvFile(text: string): ParseResult {
  const pairs = parseDotEnv(text);
  const keys: ParsedKey[] = [];
  const skipped: string[] = [];

  for (const { key, value } of pairs) {
    const prefix = extractPrefix(key);
    const platform = resolvePlatform(prefix);

    // Known platform prefix → always include (prefix match is stronger evidence)
    if (platform !== 'unknown') {
      keys.push({ rawKey: `${key}=${value}`, prefix, platform });
      continue;
    }

    // Unknown prefix → check if value looks like an API key
    if (looksLikeApiKey(value)) {
      keys.push({ rawKey: `${key}=${value}`, prefix, platform });
    } else {
      skipped.push(`${key}=${value}: value does not look like an API key`);
    }
  }

  return { keys, skipped };
}

/**
 * Parse a `.json` file. Falls back to .env parsing when the content is
 * not a valid JSON object.
 */
function parseJsonFile(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return parseEnvFile(text);
  }

  // Non-object JSON → .env fallback
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return parseEnvFile(text);
  }

  // Hermes/OpenCode auth.json detection — delegate to parseAuthJson
  if ('credential_pool' in (parsed as Record<string, unknown>)) {
    return parseAuthJson(text);
  }

  const keys: ParsedKey[] = [];
  const skipped: string[] = [];

  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') {
      keys.push({
        rawKey: `${k}=${v}`,
        prefix: extractPrefix(k),
        platform: resolvePlatform(extractPrefix(k)),
      });
    } else {
      skipped.push(k);
    }
  }

  return { keys, skipped };
}

/**
 * Parse a `.js` file. Falls back to .env parsing only when the content
 * does NOT contain `module.exports = …` or `export default …`.
 */
function parseJsFile(text: string): ParseResult {
  let ast: unknown;
  try {
    ast = parse(text, { ecmaVersion: 2022, sourceType: 'module' });
  } catch {
    return parseEnvFile(text);
  }

  const keys: ParsedKey[] = [];
  const skipped: string[] = [];
  let foundExport = false;

  function extractObjectProps(objExpr: Record<string, unknown>): void {
    foundExport = true;
    const properties = objExpr.properties;
    if (!Array.isArray(properties)) return;

    for (const prop of properties) {
      if (!prop || typeof prop !== 'object') continue;
      if ((prop as Record<string, unknown>).type !== 'Property') continue;

      const p = prop as Record<string, unknown>;
      const keyNode = p.key as Record<string, unknown> | undefined;
      const valNode = p.value as Record<string, unknown> | undefined;

      if (!keyNode || !valNode) continue;

      // Key: Identifier or string Literal
      let key: string | null = null;
      if (keyNode.type === 'Identifier' && typeof keyNode.name === 'string') {
        key = keyNode.name;
      } else if (keyNode.type === 'Literal' && typeof (keyNode as Record<string, unknown>).value === 'string') {
        key = (keyNode as Record<string, unknown>).value as string;
      }
      if (key === null) continue;

      // Value must be a string Literal
      if (valNode.type === 'Literal' && typeof (valNode as Record<string, unknown>).value === 'string') {
        const val = (valNode as Record<string, unknown>).value as string;
        keys.push({
          rawKey: `${key}=${val}`,
          prefix: extractPrefix(key),
          platform: resolvePlatform(extractPrefix(key)),
        });
      } else {
        skipped.push(key);
      }
    }
  }

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;

    const n = node as Record<string, unknown>;

    // ExpressionStatement: module.exports = …
    if (n.type === 'ExpressionStatement' && n.expression && typeof n.expression === 'object') {
      const expr = n.expression as Record<string, unknown>;
      if (
        expr.type === 'AssignmentExpression' &&
        expr.left &&
        typeof expr.left === 'object'
      ) {
        const left = expr.left as Record<string, unknown>;
        if (
          left.type === 'MemberExpression' &&
          left.object &&
          typeof left.object === 'object' &&
          (left.object as Record<string, unknown>).type === 'Identifier' &&
          (left.object as Record<string, unknown>).name === 'module' &&
          left.property &&
          typeof left.property === 'object' &&
          (left.property as Record<string, unknown>).type === 'Identifier' &&
          (left.property as Record<string, unknown>).name === 'exports'
        ) {
          foundExport = true;
          // Only extract when the right-hand side is an ObjectExpression
          if (
            expr.right &&
            typeof expr.right === 'object' &&
            (expr.right as Record<string, unknown>).type === 'ObjectExpression'
          ) {
            extractObjectProps(expr.right as Record<string, unknown>);
          }
          return;
        }
      }
    }

    // ExportDefaultDeclaration: export default …
    if (n.type === 'ExportDefaultDeclaration') {
      foundExport = true;
      if (
        n.declaration &&
        typeof n.declaration === 'object' &&
        (n.declaration as Record<string, unknown>).type === 'ObjectExpression'
      ) {
        extractObjectProps(n.declaration as Record<string, unknown>);
      }
      return;
    }

    // Recurse into children
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object') walk(item);
        }
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  }

  walk(ast);

  // If the file had no export pattern at all, return empty.
  // (The content was successfully parsed as JavaScript – it's not a .env file.)
  if (!foundExport) {
    return { keys: [], skipped: [] };
  }

  return { keys, skipped };
}

// ---------------------------------------------------------------------------
// parseKeysFromFile — orchestrator
// ---------------------------------------------------------------------------

export function parseKeysFromFile(content: string, filename: string): ParseResult {
  // 1. Strip BOM
  let text = content;
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // 2. Normalise CRLF → LF
  text = text.replace(/\r\n/g, '\n');

  // 3. Detect format by filename extension (case-insensitive)
  const dotIdx = filename.lastIndexOf('.');
  const ext = dotIdx >= 0 ? filename.slice(dotIdx).toLowerCase() : '';

  if (ext === '.json' || ext === '.jsonc') {
    return parseJsonFile(text);
  }

  if (ext === '.js') {
    return parseJsFile(text);
  }

  // .env or unknown/empty extension → .env parser
  return parseEnvFile(text);
}
