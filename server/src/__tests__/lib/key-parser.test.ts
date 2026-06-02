import { describe, it, expect } from 'vitest';
import {
  PREFIX_MAP,
  parseDotEnv,
  parseJson,
  parseJavaScript,
  detectPlatform,
  parseKeysFromFile,
  parseAuthJson,
  AUTH_JSON_PROVIDER_MAP,
  looksLikeApiKey,
} from '../../lib/key-parser.js';

// =============================================================================
// parseDotEnv — .env format parser
// =============================================================================
describe('parseDotEnv', () => {
  it('parses standard KEY=VALUE lines', () => {
    const result = parseDotEnv('GOOGLE_API_KEY=ai-test-key-123\nGROQ_KEY=gsk_abc123');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: 'GOOGLE_API_KEY', value: 'ai-test-key-123' });
    expect(result[1]).toEqual({ key: 'GROQ_KEY', value: 'gsk_abc123' });
  });

  it('parses quoted values (double quotes)', () => {
    const result = parseDotEnv('KEY="value with spaces"');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'KEY', value: 'value with spaces' });
  });

  it('parses quoted values (single quotes)', () => {
    const result = parseDotEnv("KEY='single quoted value'");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'KEY', value: 'single quoted value' });
  });

  it('handles spaces around the = delimiter', () => {
    const result = parseDotEnv('KEY = value');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'KEY', value: 'value' });
  });

  it('strips inline comments (#)', () => {
    const result = parseDotEnv('KEY=value # this is a comment');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'KEY', value: 'value' });
  });

  it('ignores comment-only lines', () => {
    const result = parseDotEnv('# this is a comment\nKEY=value');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('KEY');
  });

  it('skips blank lines', () => {
    const result = parseDotEnv('KEY1=val1\n\n\nKEY2=val2');
    expect(result).toHaveLength(2);
  });

  it('skips whitespace-only lines', () => {
    const result = parseDotEnv('KEY1=val1\n   \n\t\nKEY2=val2');
    expect(result).toHaveLength(2);
  });

  it('handles BOM prefix (\\uFEFF) at the start of content', () => {
    const result = parseDotEnv('\uFEFFKEY=BOM-value');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'KEY', value: 'BOM-value' });
  });

  it('handles CRLF line endings', () => {
    const result = parseDotEnv('KEY1=val1\r\nKEY2=val2\r\nKEY3=val3');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ key: 'KEY1', value: 'val1' });
    expect(result[1]).toEqual({ key: 'KEY2', value: 'val2' });
    expect(result[2]).toEqual({ key: 'KEY3', value: 'val3' });
  });

  it('deduplicates keys (last value wins)', () => {
    const result = parseDotEnv('KEY=first\nKEY=second\nKEY=third');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'KEY', value: 'third' });
  });

  it('handles empty value (KEY=)', () => {
    const result = parseDotEnv('KEY=');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'KEY', value: '' });
  });

  it('handles empty value with trailing whitespace (KEY= )', () => {
    const result = parseDotEnv('KEY= ');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'KEY', value: '' });
  });

  it('returns empty array for empty input', () => {
    expect(parseDotEnv('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseDotEnv('   \n  \n  ')).toEqual([]);
  });

  it('trims trailing whitespace from values', () => {
    const result = parseDotEnv('KEY=value  ');
    expect(result[0].value).toBe('value');
  });

  it('trims leading whitespace from keys', () => {
    const result = parseDotEnv('  KEY=value');
    expect(result[0].key).toBe('KEY');
  });

  it('preserves internal whitespace in quoted values', () => {
    const result = parseDotEnv('KEY="hello   world"');
    expect(result[0].value).toBe('hello   world');
  });
});

// =============================================================================
// parseJson — JSON format parser
// =============================================================================
describe('parseJson', () => {
  it('parses a flat object with string values', () => {
    const input = JSON.stringify({
      GOOGLE_API_KEY: 'ai-test-key-123',
      GROQ_KEY: 'gsk_abc123',
    });
    const result = parseJson(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: 'GOOGLE_API_KEY', value: 'ai-test-key-123' });
    expect(result[1]).toEqual({ key: 'GROQ_KEY', value: 'gsk_abc123' });
  });

  it('returns empty array for empty object', () => {
    expect(parseJson('{}')).toEqual([]);
  });

  it('skips array values', () => {
    const input = JSON.stringify({
      VALID_KEY: 'ok',
      SKIP_ME: [1, 2, 3],
    });
    const result = parseJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('VALID_KEY');
  });

  it('skips nested objects', () => {
    const input = JSON.stringify({
      FLAT_KEY: 'flat-value',
      NESTED: { inner: 'should-skip' },
    });
    const result = parseJson(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'FLAT_KEY', value: 'flat-value' });
  });

  it('skips null values', () => {
    const input = JSON.stringify({
      GOOD_KEY: 'works',
      NULL_KEY: null,
    });
    const result = parseJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('GOOD_KEY');
  });

  it('skips non-string primitive values (number)', () => {
    const input = JSON.stringify({
      STRING_KEY: 'text',
      NUMBER_KEY: 42,
    });
    const result = parseJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('STRING_KEY');
  });

  it('skips non-string primitive values (boolean)', () => {
    const input = JSON.stringify({
      STRING_KEY: 'text',
      BOOL_KEY: true,
    });
    const result = parseJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('STRING_KEY');
  });

  it('returns empty array when top-level value is not an object (string)', () => {
    expect(parseJson('"just a string"')).toEqual([]);
  });

  it('returns empty array when top-level value is an array', () => {
    expect(parseJson('["a", "b", "c"]')).toEqual([]);
  });

  it('returns empty array when top-level value is a number', () => {
    expect(parseJson('42')).toEqual([]);
  });

  it('returns empty array when top-level value is null', () => {
    expect(parseJson('null')).toEqual([]);
  });

  it('handles keys that are env-var-style with underscores', () => {
    const input = JSON.stringify({ 'MISTRAL_API_KEY': 'mistral-val' });
    const result = parseJson(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: 'MISTRAL_API_KEY', value: 'mistral-val' });
  });
});

// =============================================================================
// parseAuthJson — Hermes/OpenCode auth.json parser
// =============================================================================
describe('parseAuthJson', () => {
  // --- AUTH_JSON_PROVIDER_MAP ---
  describe('AUTH_JSON_PROVIDER_MAP', () => {
    it("maps 'gemini' provider to platform 'google'", () => {
      expect(AUTH_JSON_PROVIDER_MAP.gemini).toBe('google');
    });

    it("maps 'openrouter' provider to platform 'openrouter'", () => {
      expect(AUTH_JSON_PROVIDER_MAP.openrouter).toBe('openrouter');
    });

    it("maps 'ollama-cloud' provider to platform 'ollama'", () => {
      expect(AUTH_JSON_PROVIDER_MAP['ollama-cloud']).toBe('ollama');
    });

    it("maps 'nvidia' provider to platform 'nvidia'", () => {
      expect(AUTH_JSON_PROVIDER_MAP.nvidia).toBe('nvidia');
    });
  });

  // --- Basic detection and extraction ---
  it('extracts API keys from credential_pool structure', () => {
    const authJson = JSON.stringify({
      credential_pool: {
        gemini: [
          { id: '1', label: 'my-gemini-key', auth_type: 'api_key', access_token: 'AIzaSy-test' },
        ],
        openrouter: [
          { id: '2', label: 'my-or-key', auth_type: 'api_key', access_token: 'sk-or-v1-test' },
        ],
      },
    });
    const result = parseAuthJson(authJson);

    // gemini → google
    const googleKeys = result.keys.filter(k => k.platform === 'google');
    expect(googleKeys).toHaveLength(1);
    expect(googleKeys[0].rawKey).toBe('my-gemini-key=AIzaSy-test');

    // openrouter → openrouter
    const orKeys = result.keys.filter(k => k.platform === 'openrouter');
    expect(orKeys).toHaveLength(1);
    expect(orKeys[0].rawKey).toBe('my-or-key=sk-or-v1-test');
  });

  it('returns empty result for JSON without credential_pool', () => {
    const json = JSON.stringify({ KEY: 'val', updated_at: '2026-01-01' });
    const result = parseAuthJson(json);
    expect(result.keys).toHaveLength(0);
    // Normal parseJson would still handle this flat JSON
    const normalResult = parseJson(json);
    expect(normalResult).toHaveLength(2);
  });

  it('returns empty result for non-object JSON (string)', () => {
    expect(parseAuthJson('"string"').keys).toHaveLength(0);
  });

  it('returns empty result for array JSON', () => {
    expect(parseAuthJson('[]').keys).toHaveLength(0);
  });

  // --- Filtering logic ---
  it('skips credentials with auth_type other than api_key', () => {
    const authJson = JSON.stringify({
      credential_pool: {
        'google-gemini-cli': [
          { id: '1', label: 'user@gmail.com', auth_type: 'oauth', access_token: 'ya29.oauth-token' },
        ],
      },
    });
    const result = parseAuthJson(authJson);
    expect(result.keys).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThanOrEqual(1);
  });

  it('skips credentials without access_token', () => {
    const authJson = JSON.stringify({
      credential_pool: {
        openrouter: [
          { id: '1', label: 'no-token-key', auth_type: 'api_key' },
        ],
      },
    });
    const result = parseAuthJson(authJson);
    expect(result.keys).toHaveLength(0);
  });

  // --- Realistic auth.json input ---
  it('parses a realistic auth.json with multiple providers', () => {
    const authJson = JSON.stringify({
      version: 1,
      providers: {},
      active_provider: null,
      updated_at: '2026-05-29T18:11:48.250808+00:00',
      credential_pool: {
        'opencode-zen': [
          { id: '52f84e', label: 'api-key-6', auth_type: 'api_key', access_token: 'sk-fake-opencode-zen-key', base_url: 'https://opencode.ai/zen/v1' },
        ],
        'gemini': [
          { id: '53e827', label: 'digilab.dekrook@gmail.com', auth_type: 'api_key', access_token: 'AIzaSyFakeGoogleKey123456789', base_url: 'https://generativelanguage.googleapis.com/v1beta' },
        ],
        'openrouter': [
          { id: '09ae6c', label: 'aldo.fieuw@gmail.com', auth_type: 'api_key', access_token: 'sk-or-v1-fake-openrouter-key', base_url: 'https://openrouter.ai/api/v1' },
        ],
        'ollama-cloud': [
          { id: '6690fd', label: 'aldo.fieuw@gmail.com', auth_type: 'api_key', access_token: 'fake-ollama-cloud-key', base_url: 'https://ollama.com/v1' },
        ],
        'nvidia': [
          { id: '8571a8', label: 'NVIDIA_API_KEY', auth_type: 'api_key', access_token: 'nvapi-test-key', base_url: 'https://integrate.api.nvidia.com/v1' },
        ],
        'google-gemini-cli': [
          { id: '0b7074', label: 'usful.web@gmail.com', auth_type: 'oauth', access_token: 'ya29.oauth-token', refresh_token: '1//...' },
        ],
        'xai': [
          { id: '7549ec', label: 'aldo.fieuw@gmail.com', auth_type: 'api_key', access_token: 'xai-fake-xai-key-for-test', base_url: 'https://api.x.ai/v1' },
        ],
      },
    });
    const result = parseAuthJson(authJson);

    // Known platform mappings should be extracted
    const openrouterKeys = result.keys.filter(k => k.platform === 'openrouter');
    expect(openrouterKeys).toHaveLength(1);

    const googleKeys = result.keys.filter(k => k.platform === 'google');
    expect(googleKeys).toHaveLength(1); // gemini → google

    const ollamaKeys = result.keys.filter(k => k.platform === 'ollama');
    expect(ollamaKeys).toHaveLength(1); // ollama-cloud → ollama

    const nvidiaKeys = result.keys.filter(k => k.platform === 'nvidia');
    expect(nvidiaKeys).toHaveLength(1);

    // Unmapped providers (opencode-zen, xai) → platform 'unknown'
    const unknownKeys = result.keys.filter(k => k.platform === 'unknown');
    expect(unknownKeys).toHaveLength(2);

    // google-gemini-cli → oauth, skipped entirely
    const gcliKeys = result.keys.filter(k => k.rawKey.includes('usful.web'));
    expect(gcliKeys).toHaveLength(0);

    // updated_at should NOT appear (it's not in credential_pool)
    expect(result.keys.every(k => !k.rawKey.includes('updated_at'))).toBe(true);

    // Total extracted keys: 4 mapped + 2 unknown = 6
    expect(result.keys).toHaveLength(6);
  });

  // --- Integration with parseKeysFromFile ---
  it('wires into parseKeysFromFile for .json files with credential_pool', () => {
    const authJson = JSON.stringify({
      credential_pool: {
        gemini: [
          { id: '1', label: 'my-key', auth_type: 'api_key', access_token: 'AIzaSy-test' },
        ],
        openrouter: [
          { id: '2', label: 'my-or-key', auth_type: 'api_key', access_token: 'sk-or-v1-test' },
        ],
      },
    });
    const result = parseKeysFromFile(authJson, 'auth.json');

    const googleKeys = result.keys.filter(k => k.platform === 'google');
    expect(googleKeys).toHaveLength(1);
    expect(googleKeys[0].rawKey).toBe('my-key=AIzaSy-test');

    const orKeys = result.keys.filter(k => k.platform === 'openrouter');
    expect(orKeys).toHaveLength(1);
    expect(orKeys[0].rawKey).toBe('my-or-key=sk-or-v1-test');
  });

  it('still parses flat JSON without credential_pool via parseKeysFromFile', () => {
    const flatJson = JSON.stringify({ GOOGLE_API_KEY: 'ai-key', GROQ_KEY: 'gsk_abc' });
    const result = parseKeysFromFile(flatJson, 'keys.json');
    expect(result.keys).toHaveLength(2);
    expect(result.keys[0].platform).toBe('google');
    expect(result.keys[1].platform).toBe('groq');
  });
});

// =============================================================================
// parseJavaScript — JS module/export parser
// =============================================================================
describe('parseJavaScript', () => {
  it('parses module.exports = { ... } with string values', () => {
    const input = `
      module.exports = {
        GOOGLE_API_KEY: 'ai-test-key-123',
        GROQ_KEY: "gsk_abc123",
      };
    `;
    const result = parseJavaScript(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: 'GOOGLE_API_KEY', value: 'ai-test-key-123' });
    expect(result[1]).toEqual({ key: 'GROQ_KEY', value: 'gsk_abc123' });
  });

  it('parses export default { ... } with string values', () => {
    const input = `
      export default {
        HF_TOKEN: 'hf_test123',
        NVIDIA_API_KEY: 'nv-abc',
      };
    `;
    const result = parseJavaScript(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: 'HF_TOKEN', value: 'hf_test123' });
    expect(result[1]).toEqual({ key: 'NVIDIA_API_KEY', value: 'nv-abc' });
  });

  it('returns empty array for empty module.exports', () => {
    const result = parseJavaScript('module.exports = {};');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty export default', () => {
    const result = parseJavaScript('export default {};');
    expect(result).toEqual([]);
  });

  it('skips non-object module.exports (number)', () => {
    const result = parseJavaScript('module.exports = 42;');
    expect(result).toEqual([]);
  });

  it('skips non-object module.exports (string)', () => {
    const result = parseJavaScript('module.exports = "hello";');
    expect(result).toEqual([]);
  });

  it('skips non-string values (number) in the exported object', () => {
    const input = `
      module.exports = {
        STRING_KEY: 'good',
        NUMBER_KEY: 42,
      };
    `;
    const result = parseJavaScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('STRING_KEY');
  });

  it('skips non-string values (null) in the exported object', () => {
    const input = `
      module.exports = {
        STRING_KEY: 'good',
        NULL_KEY: null,
      };
    `;
    const result = parseJavaScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('STRING_KEY');
  });

  it('skips non-string values (boolean) in the exported object', () => {
    const input = `
      module.exports = {
        STRING_KEY: 'good',
        BOOL_KEY: true,
      };
    `;
    const result = parseJavaScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('STRING_KEY');
  });

  it('skips non-string values (object) in the exported object', () => {
    const input = `
      module.exports = {
        STRING_KEY: 'good',
        OBJ_KEY: { nested: true },
      };
    `;
    const result = parseJavaScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('STRING_KEY');
  });

  it('returns empty array for script without module.exports or export default', () => {
    const input = 'const x = 1; console.log(x);';
    const result = parseJavaScript(input);
    expect(result).toEqual([]);
  });

  it('parses module.exports spread across multiple lines', () => {
    const input = `module.exports = {
      KEY1: 'val1',
      KEY2: 'val2',
      KEY3: 'val3',
    }`;
    const result = parseJavaScript(input);
    expect(result).toHaveLength(3);
  });
});

// =============================================================================
// PREFIX_MAP — hardcoded prefix-to-platform mapping
// =============================================================================
describe('PREFIX_MAP', () => {
  it('contains exactly 13 recognized prefix mappings', () => {
    expect(Object.keys(PREFIX_MAP)).toHaveLength(13);
  });

  it('maps GOOGLE_ to google', () => {
    expect(PREFIX_MAP.GOOGLE_).toBe('google');
  });

  it('maps GROQ_ to groq', () => {
    expect(PREFIX_MAP.GROQ_).toBe('groq');
  });

  it('maps CEREBRAS_ to cerebras', () => {
    expect(PREFIX_MAP.CEREBRAS_).toBe('cerebras');
  });

  it('maps SAMBANOVA_ to sambanova', () => {
    expect(PREFIX_MAP.SAMBANOVA_).toBe('sambanova');
  });

  it('maps NVIDIA_ to nvidia', () => {
    expect(PREFIX_MAP.NVIDIA_).toBe('nvidia');
  });

  it('maps MISTRAL_ to mistral', () => {
    expect(PREFIX_MAP.MISTRAL_).toBe('mistral');
  });

  it('maps OPENROUTER_ to openrouter', () => {
    expect(PREFIX_MAP.OPENROUTER_).toBe('openrouter');
  });

  it('maps GITHUB_ to github', () => {
    expect(PREFIX_MAP.GITHUB_).toBe('github');
  });

  it('maps COHERE_ to cohere', () => {
    expect(PREFIX_MAP.COHERE_).toBe('cohere');
  });

  it('maps CLOUDFLARE_ to cloudflare', () => {
    expect(PREFIX_MAP.CLOUDFLARE_).toBe('cloudflare');
  });

  it('maps ZHIPU_ to zhipu', () => {
    expect(PREFIX_MAP.ZHIPU_).toBe('zhipu');
  });

  it('maps OLLAMA_ to ollama', () => {
    expect(PREFIX_MAP.OLLAMA_).toBe('ollama');
  });

  it('maps HF_ to huggingface', () => {
    expect(PREFIX_MAP.HF_).toBe('huggingface');
  });
});

// =============================================================================
// detectPlatform — prefix-based platform resolution
// =============================================================================
describe('detectPlatform', () => {
  it('returns google for GOOGLE_ prefix', () => {
    expect(detectPlatform('GOOGLE_')).toBe('google');
  });

  it('returns groq for GROQ_ prefix', () => {
    expect(detectPlatform('GROQ_')).toBe('groq');
  });

  it('returns cerebras for CEREBRAS_ prefix', () => {
    expect(detectPlatform('CEREBRAS_')).toBe('cerebras');
  });

  it('returns sambanova for SAMBANOVA_ prefix', () => {
    expect(detectPlatform('SAMBANOVA_')).toBe('sambanova');
  });

  it('returns nvidia for NVIDIA_ prefix', () => {
    expect(detectPlatform('NVIDIA_')).toBe('nvidia');
  });

  it('returns mistral for MISTRAL_ prefix', () => {
    expect(detectPlatform('MISTRAL_')).toBe('mistral');
  });

  it('returns openrouter for OPENROUTER_ prefix', () => {
    expect(detectPlatform('OPENROUTER_')).toBe('openrouter');
  });

  it('returns github for GITHUB_ prefix', () => {
    expect(detectPlatform('GITHUB_')).toBe('github');
  });

  it('returns cohere for COHERE_ prefix', () => {
    expect(detectPlatform('COHERE_')).toBe('cohere');
  });

  it('returns cloudflare for CLOUDFLARE_ prefix', () => {
    expect(detectPlatform('CLOUDFLARE_')).toBe('cloudflare');
  });

  it('returns zhipu for ZHIPU_ prefix', () => {
    expect(detectPlatform('ZHIPU_')).toBe('zhipu');
  });

  it('returns ollama for OLLAMA_ prefix', () => {
    expect(detectPlatform('OLLAMA_')).toBe('ollama');
  });

  it('returns huggingface for HF_ prefix', () => {
    expect(detectPlatform('HF_')).toBe('huggingface');
  });

  it('returns null for unrecognized prefix (OPENAI_)', () => {
    expect(detectPlatform('OPENAI_')).toBeNull();
  });

  it('returns null for unrecognized prefix (ANTHROPIC_)', () => {
    expect(detectPlatform('ANTHROPIC_')).toBeNull();
  });

  it('returns null for KILO_ (platform exists but no env-var prefix)', () => {
    expect(detectPlatform('KILO_')).toBeNull();
  });

  it('returns null for POLLINATIONS_ (platform exists but no env-var prefix)', () => {
    expect(detectPlatform('POLLINATIONS_')).toBeNull();
  });

  it('returns null for empty string prefix', () => {
    expect(detectPlatform('')).toBeNull();
  });

  it('returns null for unknown gibberish prefix', () => {
    expect(detectPlatform('ZZZZZ_')).toBeNull();
  });

  it('is case-sensitive — lowercase prefix does not match', () => {
    expect(detectPlatform('google_')).toBeNull();
  });
});

// =============================================================================
// looksLikeApiKey — value-based API key heuristic
// =============================================================================
describe('looksLikeApiKey', () => {
  // --- Should return true for known API key formats ---
  it('returns true for sk-or-v1-xxxx (OpenRouter key format)', () => {
    expect(looksLikeApiKey('sk-or-v1-fakekey1234567890abcdef')).toBe(true);
  });

  it('returns true for nvapi-xxxx (NVIDIA key format)', () => {
    expect(looksLikeApiKey('nvapi-fake-nvidia-key-for-test')).toBe(true);
  });

  it('returns true for gsk_xxxx (Groq key format)', () => {
    expect(looksLikeApiKey('gsk_abc123def456ghi789jkl012')).toBe(true);
  });

  it('returns true for AIzaSyxxxx (Google key format)', () => {
    expect(looksLikeApiKey('AIzaSyFakeGoogleKey123456789')).toBe(true);
  });

  it('returns true for ghp_xxxx (GitHub token)', () => {
    expect(looksLikeApiKey('ghp_abc123def456ghi789jkl012mno345')).toBe(true);
  });

  it('returns true for sk-th-xxxx (TokenHub key)', () => {
    expect(looksLikeApiKey('sk-th-abc123def456ghi789jkl012')).toBe(true);
  });

  it('returns true for hf_xxxx (HuggingFace token)', () => {
    expect(looksLikeApiKey('hf_abc123def456ghi789jkl012')).toBe(true);
  });

  it('returns true for 8638891443:AAH-xxxx (Telegram bot token)', () => {
    expect(looksLikeApiKey('8638891443:AAH-abc123def456ghi789jkl012')).toBe(true);
  });

  // --- Should return false for clearly non-API-key values ---
  it('returns false for "true" (boolean)', () => {
    expect(looksLikeApiKey('true')).toBe(false);
  });

  it('returns false for "false" (boolean)', () => {
    expect(looksLikeApiKey('false')).toBe(false);
  });

  it('returns false for "60" (pure number)', () => {
    expect(looksLikeApiKey('60')).toBe(false);
  });

  it('returns false for "300" (pure number)', () => {
    expect(looksLikeApiKey('300')).toBe(false);
  });

  it('returns false for "http://homeassistant.local:8123" (URL)', () => {
    expect(looksLikeApiKey('http://homeassistant.local:8123')).toBe(false);
  });

  it('returns false for "https://example.com" (URL)', () => {
    expect(looksLikeApiKey('https://example.com')).toBe(false);
  });

  it('returns false for "dummy" (5 chars, too short)', () => {
    expect(looksLikeApiKey('dummy')).toBe(false);
  });

  it('returns false for "local" (5 chars)', () => {
    expect(looksLikeApiKey('local')).toBe(false);
  });

  it('returns false for "" (empty string)', () => {
    expect(looksLikeApiKey('')).toBe(false);
  });

  it('returns false for decimal number "3.14"', () => {
    expect(looksLikeApiKey('3.14')).toBe(false);
  });

  it('returns false for negative number "-42"', () => {
    expect(looksLikeApiKey('-42')).toBe(false);
  });

  it('returns false for "yes" (boolean-like)', () => {
    expect(looksLikeApiKey('yes')).toBe(false);
  });

  it('returns false for "no" (boolean-like)', () => {
    expect(looksLikeApiKey('no')).toBe(false);
  });

  it('returns false for value with only digits and special chars (no letters)', () => {
    expect(looksLikeApiKey('1234567890!@#$%^&*()')).toBe(false);
  });
});

// =============================================================================
// parseKeysFromFile — orchestrator combining format detection + parsing + platform detection
// =============================================================================
describe('parseKeysFromFile', () => {
  // --- .env file handling ---
  describe('with .env content', () => {
    it('parses recognized keys and sets platform correctly', () => {
      const result = parseKeysFromFile(
        'GOOGLE_API_KEY=ai-test-key-123\nGROQ_KEY=gsk_abc123',
        'secrets.env',
      );
      expect(result.keys).toHaveLength(2);
      expect(result.skipped).toHaveLength(0);

      expect(result.keys[0]).toMatchObject({
        rawKey: 'GOOGLE_API_KEY=ai-test-key-123',
        prefix: 'GOOGLE_',
        platform: 'google',
      });
      expect(result.keys[1]).toMatchObject({
        rawKey: 'GROQ_KEY=gsk_abc123',
        prefix: 'GROQ_',
        platform: 'groq',
      });
    });

    it('sets platform to "unknown" for unrecognized prefixes (OPENAI_)', () => {
      const result = parseKeysFromFile(
        'OPENAI_API_KEY=sk-test123',
        'keys.env',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);
      expect(result.keys[0]).toMatchObject({
        rawKey: 'OPENAI_API_KEY=sk-test123',
        prefix: 'OPENAI_',
        platform: 'unknown',
      });
    });

    it('sets platform to "unknown" for ANTHROPIC_ prefix', () => {
      const result = parseKeysFromFile(
        'ANTHROPIC_API_KEY=sk-ant-test123',
        'keys.env',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].prefix).toBe('ANTHROPIC_');
      expect(result.keys[0].platform).toBe('unknown');
    });

    it('sets platform to "unknown" for KILO_ prefix (platform without env-var prefix)', () => {
      const result = parseKeysFromFile(
        'KILO_API_KEY=kilo-test',
        'keys.env',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].prefix).toBe('KILO_');
      expect(result.keys[0].platform).toBe('unknown');
    });

    it('sets platform to "unknown" for POLLINATIONS_ prefix (platform without env-var prefix)', () => {
      const result = parseKeysFromFile(
        'POLLINATIONS_API_KEY=poll-test',
        'keys.env',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].prefix).toBe('POLLINATIONS_');
      expect(result.keys[0].platform).toBe('unknown');
    });

    it('reports skipped keys for invalid .env lines', () => {
      const result = parseKeysFromFile(
        'VALID_KEY=sk-test-key\nINVALID_NO_EQUALS\n# comment\n\nANOTHER_VALID=sk-other-key',
        'config.env',
      );
      // INVALID_NO_EQUALS has no '=', so it's likely skipped
      expect(result.keys.length).toBeGreaterThanOrEqual(2);
    });

    it('filters non-API-key values using looksLikeApiKey heuristic', () => {
      const result = parseKeysFromFile(
        [
          'GROQ_API_KEY=gsk_test123',
          'TERMINAL_TIMEOUT=60',
          'BROWSERBASE_PROXIES=true',
          'HASS_URL=http://homeassistant.local:8123',
          'OLLAMAFREEAPI_KEY=dummy',
        ].join('\n'),
        'secrets.env',
      );

      // GROQ_API_KEY has known prefix GROQ_ → always included
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].rawKey).toBe('GROQ_API_KEY=gsk_test123');
      expect(result.keys[0].platform).toBe('groq');

      // The other 4 values should be in skipped
      expect(result.skipped).toHaveLength(4);
      expect(result.skipped[0]).toBe('TERMINAL_TIMEOUT=60: value does not look like an API key');
      expect(result.skipped[1]).toBe('BROWSERBASE_PROXIES=true: value does not look like an API key');
      expect(result.skipped[2]).toBe('HASS_URL=http://homeassistant.local:8123: value does not look like an API key');
      expect(result.skipped[3]).toBe('OLLAMAFREEAPI_KEY=dummy: value does not look like an API key');
    });
  });

  // --- .json file handling ---
  describe('with .json content', () => {
    it('parses recognized keys from JSON', () => {
      const result = parseKeysFromFile(
        JSON.stringify({ GOOGLE_API_KEY: 'ai-key', GROQ_KEY: 'gsk_abc' }),
        'keys.json',
      );
      expect(result.keys).toHaveLength(2);
      expect(result.skipped).toHaveLength(0);
    });

    it('skips null values in JSON', () => {
      const result = parseKeysFromFile(
        JSON.stringify({ GOOD_KEY: 'works', NULL_KEY: null }),
        'config.json',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].rawKey).toBe('GOOD_KEY=works');
      expect(result.skipped).toContain('NULL_KEY');
    });

    it('skips non-string values (number) in JSON', () => {
      const result = parseKeysFromFile(
        JSON.stringify({ STR_KEY: 'text', NUM_KEY: 42 }),
        'config.json',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.skipped).toContain('NUM_KEY');
    });

    it('skips array values in JSON', () => {
      const result = parseKeysFromFile(
        JSON.stringify({ GOOD: 'val', BAD: [1, 2, 3] }),
        'config.json',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.skipped).toContain('BAD');
    });

    it('skips nested objects in JSON', () => {
      const result = parseKeysFromFile(
        JSON.stringify({ GOOD: 'val', BAD: { nested: true } }),
        'config.json',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.skipped).toContain('BAD');
    });

    it('handles empty JSON object', () => {
      const result = parseKeysFromFile('{}', 'empty.json');
      expect(result.keys).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it('handles non-object JSON (top-level string) gracefully', () => {
      const result = parseKeysFromFile('"just a string"', 'bad.json');
      expect(result.keys).toHaveLength(0);
    });
  });

  // --- .js file handling ---
  describe('with .js content', () => {
    it('parses module.exports = { ... }', () => {
      const js = `module.exports = { GOOGLE_API_KEY: 'ai-key', GROQ_KEY: 'gsk_abc' };`;
      const result = parseKeysFromFile(js, 'config.js');
      expect(result.keys).toHaveLength(2);
      expect(result.skipped).toHaveLength(0);
    });

    it('parses export default { ... }', () => {
      const js = `export default { HF_TOKEN: 'hf_test', NVIDIA_API_KEY: 'nv-key' };`;
      const result = parseKeysFromFile(js, 'config.js');
      expect(result.keys).toHaveLength(2);
    });

    it('skips non-string values (number) in JS exports', () => {
      const js = `module.exports = { STR_KEY: 'text', NUM_KEY: 42 };`;
      const result = parseKeysFromFile(js, 'config.js');
      expect(result.keys).toHaveLength(1);
      expect(result.skipped).toContain('NUM_KEY');
    });

    it('skips non-string values (null) in JS exports', () => {
      const js = `module.exports = { STR_KEY: 'text', NULL_KEY: null };`;
      const result = parseKeysFromFile(js, 'config.js');
      expect(result.keys).toHaveLength(1);
      expect(result.skipped).toContain('NULL_KEY');
    });

    it('handles empty module.exports gracefully', () => {
      const result = parseKeysFromFile('module.exports = {};', 'empty.js');
      expect(result.keys).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it('handles non-object module.exports (number) gracefully', () => {
      const result = parseKeysFromFile('module.exports = 42;', 'bad.js');
      expect(result.keys).toHaveLength(0);
    });

    it('handles JS without exports gracefully', () => {
      const result = parseKeysFromFile('const x = 1;', 'noexport.js');
      expect(result.keys).toHaveLength(0);
    });
  });

  // --- Format detection via filename ---
  describe('format detection', () => {
    it('detects .env format by filename', () => {
      const result = parseKeysFromFile('TEST_KEY=sk-test-key-123', 'some.env');
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].rawKey).toBe('TEST_KEY=sk-test-key-123');
    });

    it('detects .json format by filename', () => {
      const result = parseKeysFromFile('{"TEST_KEY":"val"}', 'creds.json');
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].rawKey).toBe('TEST_KEY=val');
    });

    it('detects .js format by filename', () => {
      const result = parseKeysFromFile(
        'module.exports = { TEST_KEY: "val" };',
        'creds.js',
      );
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].rawKey).toBe('TEST_KEY=val');
    });

    it('uses .env as fallback for unknown file extensions', () => {
      const result = parseKeysFromFile('TEST_KEY=sk-test-key-123', 'creds.txt');
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].rawKey).toBe('TEST_KEY=sk-test-key-123');
    });

    it('uses .env as fallback when no filename is provided', () => {
      const result = parseKeysFromFile('TEST_KEY=sk-test-key-123', '');
      expect(result.keys).toHaveLength(1);
    });
  });

  // --- Edge cases ---
  describe('edge cases', () => {
    it('returns empty result for empty content', () => {
      const result = parseKeysFromFile('', 'empty.env');
      expect(result.keys).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it('handles keys without an underscore (no prefix)', () => {
      const result = parseKeysFromFile('API_KEY=sk-test-key-123', 'test.env');
      expect(result.keys).toHaveLength(1);
      // No underscore prefix means no platform prefix extracted
      expect(result.keys[0].prefix).toBe('');
    });

    it('handles mix of recognized and unrecognized prefixes', () => {
      const content = [
        'GOOGLE_API_KEY=sk-google-key-123',
        'OPENAI_API_KEY=sk-test-456',
        'GROQ_KEY=gsk-test-key-789',
      ].join('\n');
      const result = parseKeysFromFile(content, 'mix.env');
      expect(result.keys).toHaveLength(3);

      // GOOGLE_ is recognized
      const googleKey = result.keys.find(k => k.prefix === 'GOOGLE_');
      expect(googleKey?.platform).toBe('google');

      // OPENAI_ is unrecognized
      const openaiKey = result.keys.find(k => k.prefix === 'OPENAI_');
      expect(openaiKey?.platform).toBe('unknown');

      // GROQ_ is recognized
      const groqKey = result.keys.find(k => k.prefix === 'GROQ_');
      expect(groqKey?.platform).toBe('groq');
    });
  });
});
