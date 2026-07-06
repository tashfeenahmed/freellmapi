import { describe, expect, it } from 'vitest';
import {
  AUTH_JSON_PROVIDER_MAP,
  detectPlatform,
  looksLikeApiKey,
  parseAuthJson,
  parseDotEnv,
  parseJson,
  parseKeysFromFile,
  stripJsoncComments,
  stripTrailingCommas,
} from '../../lib/key-parser.js';

describe('key parser', () => {
  it('parses dotenv key/value files', () => {
    expect(parseDotEnv('GOOGLE_API_KEY="ai-test"\nGROQ_API_KEY=gsk-test # comment')).toEqual([
      { key: 'GOOGLE_API_KEY', value: 'ai-test' },
      { key: 'GROQ_API_KEY', value: 'gsk-test' },
    ]);
  });

  it('parses flat JSON string values', () => {
    expect(parseJson(JSON.stringify({ MISTRAL_API_KEY: 'mist-test', PORT: 3001 }))).toEqual([
      { key: 'MISTRAL_API_KEY', value: 'mist-test' },
    ]);
  });

  it('strips JSONC comments and trailing commas', () => {
    const jsonc = '{\n // comment\n "GROQ_API_KEY": "gsk-test",\n}';
    expect(JSON.parse(stripTrailingCommas(stripJsoncComments(jsonc)))).toEqual({
      GROQ_API_KEY: 'gsk-test',
    });
  });

  it('detects current provider prefixes', () => {
    expect(detectPlatform('GOOGLE_')).toBe('google');
    expect(detectPlatform('OLLAMA_CLOUD_')).toBe('ollama');
    expect(detectPlatform('SAMBANOVA_')).toBeNull();
  });

  it('parses Hermes/OpenCode auth.json provider names', () => {
    expect(AUTH_JSON_PROVIDER_MAP['ollama-cloud']).toBe('ollama');
    const result = parseAuthJson(JSON.stringify({
      credential_pool: {
        gemini: [{ id: '1', label: 'Gemini', auth_type: 'api_key', access_token: 'AIza-test' }],
        github: [{ id: '2', label: 'GitHub', auth_type: 'oauth', access_token: 'gho-test' }],
      },
    }));
    expect(result.keys).toEqual([
      { rawKey: 'Gemini=AIza-test', prefix: 'GOOGLE_', platform: 'google' },
    ]);
    expect(result.skipped[0]).toContain('auth_type is oauth');
  });

  it('keeps unknown but key-like values for preview', () => {
    const result = parseKeysFromFile('ANTHROPIC_API_KEY=sk-ant-test-value\nPORT=3001', 'keys.env');
    expect(result.keys).toEqual([
      { rawKey: 'ANTHROPIC_API_KEY=sk-ant-test-value', prefix: 'ANTHROPIC_', platform: null },
    ]);
    expect(result.skipped).toEqual(['PORT: value does not look like an API key']);
  });

  it('filters obvious non-key values', () => {
    expect(looksLikeApiKey('true')).toBe(false);
    expect(looksLikeApiKey('https://example.com')).toBe(false);
    expect(looksLikeApiKey('sk-valid-token')).toBe(true);
  });
});
