import { describe, expect, it } from 'vitest';
import {
  AUTH_JSON_PROVIDER_MAP,
  detectPlatform,
  looksLikeApiKey,
  parseAuthJson,
  parseCsv,
  parseDotEnv,
  parseExportJson,
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

  it('parses FreeLLMAPI export JSON format', () => {
    const exportJson = JSON.stringify({
      version: 1,
      exportedAt: '2026-07-06T12:00:00Z',
      source: 'freellmapi',
      keys: [
        { platform: 'google', key: 'AIza-test-key', label: 'Google Key' },
        { platform: 'groq', key: 'gsk-test-key', label: 'Groq Key' },
      ],
    });
    const result = parseExportJson(exportJson);
    expect(result).not.toBeNull();
    expect(result!.keys).toHaveLength(2);
    expect(result!.keys[0]).toEqual({ rawKey: 'Google Key=AIza-test-key', prefix: 'GOOGLE_', platform: 'google' });
    expect(result!.keys[1]).toEqual({ rawKey: 'Groq Key=gsk-test-key', prefix: 'GROQ_', platform: 'groq' });
    expect(result!.skipped).toHaveLength(0);
  });

  it('returns null for non-export JSON', () => {
    expect(parseExportJson('{"foo":"bar"}')).toBeNull();
    expect(parseExportJson('[1,2,3]')).toBeNull();
    expect(parseExportJson('not json')).toBeNull();
  });

  it('parses CSV format with header', () => {
    const csv = 'platform,key,label\n"google","AIza-test","Google Key"\n"groq","gsk-test","Groq Key"\n';
    expect(parseCsv(csv)).toEqual([
      { key: 'GOOGLE_KEY', value: 'AIza-test' },
      { key: 'GROQ_KEY', value: 'gsk-test' },
    ]);
  });

  it('parses CSV format without header', () => {
    const csv = 'google,AIza-test,Google Key\n';
    expect(parseCsv(csv)).toEqual([
      { key: 'GOOGLE_KEY', value: 'AIza-test' },
    ]);
  });

  it('handles export JSON via parseKeysFromFile', () => {
    const exportJson = JSON.stringify({
      version: 1,
      exportedAt: '2026-07-06T12:00:00Z',
      source: 'freellmapi',
      keys: [
        { platform: 'mistral', key: 'mist-test', label: 'Mistral Key' },
      ],
    });
    const result = parseKeysFromFile(exportJson, 'freellmapi-keys.json');
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]).toEqual({ rawKey: 'Mistral Key=mist-test', prefix: 'MISTRAL_', platform: 'mistral' });
  });

  it('handles CSV via parseKeysFromFile', () => {
    const csv = 'platform,key,label\n"nvidia","nv-test","Nvidia Key"\n';
    const result = parseKeysFromFile(csv, 'freellmapi-keys.csv');
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]).toEqual({ rawKey: 'NVIDIA_KEY=nv-test', prefix: 'NVIDIA_', platform: 'nvidia' });
  });
});
