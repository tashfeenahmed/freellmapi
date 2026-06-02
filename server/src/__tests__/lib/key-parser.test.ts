import { describe, it, expect } from 'vitest';
import {
  PREFIX_MAP,
  parseDotEnv,
  parseJson,
  parseJavaScript,
  detectPlatform,
  parseKeysFromFile,
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
        'VALID_KEY=ok\nINVALID_NO_EQUALS\n# comment\n\nANOTHER_VALID=yes',
        'config.env',
      );
      // INVALID_NO_EQUALS has no '=', so it's likely skipped
      expect(result.keys.length).toBeGreaterThanOrEqual(2);
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
      const result = parseKeysFromFile('TEST_KEY=val', 'some.env');
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].rawKey).toBe('TEST_KEY=val');
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
      const result = parseKeysFromFile('TEST_KEY=val', 'creds.txt');
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].rawKey).toBe('TEST_KEY=val');
    });

    it('uses .env as fallback when no filename is provided', () => {
      const result = parseKeysFromFile('TEST_KEY=val', '');
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
      const result = parseKeysFromFile('API_KEY=val', 'test.env');
      expect(result.keys).toHaveLength(1);
      // No underscore prefix means no platform prefix extracted
      expect(result.keys[0].prefix).toBe('');
    });

    it('handles mix of recognized and unrecognized prefixes', () => {
      const content = [
        'GOOGLE_API_KEY=gkey',
        'OPENAI_API_KEY=skey',
        'GROQ_KEY=gsk',
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
