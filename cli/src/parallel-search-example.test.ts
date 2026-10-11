import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderFile } from './config-files.js';

const example = JSON.parse(fs.readFileSync(
  new URL('../../examples/opencode/parallel-search.json', import.meta.url),
  'utf8',
));

describe('OpenCode Parallel search example', () => {
  it('adds search without replacing inference settings or other MCP servers', () => {
    const existing = {
      model: 'freellmapi/my-selected-model',
      provider: { freellmapi: { options: { apiKey: '{env:FREELLMAPI_API_KEY}' } } },
      mcp: { personal: { type: 'local', command: ['my-server'], enabled: false } },
    };
    const generated = { path: '/unused/opencode.json', format: 'json' as const, value: example };
    const merged = renderFile(generated, JSON.stringify(existing));
    expect(JSON.parse(merged)).toEqual({
      ...existing,
      $schema: example.$schema,
      mcp: { ...existing.mcp, ...example.mcp },
    });
    expect(renderFile(generated, merged)).toBe(merged);
  });

  it('uses anonymous remote MCP with a bounded discovery timeout', () => {
    expect(Object.keys(example).sort()).toEqual(['$schema', 'mcp']);
    expect(Object.keys(example.mcp)).toEqual(['parallel_search']);
    const server = example.mcp.parallel_search;
    expect(server.type).toBe('remote');
    expect(server.url).toBe('https://search.parallel.ai/mcp');
    expect(server.oauth).toBe(false);
    expect(server.enabled).toBe(true);
    expect(server.headers).toEqual({ 'User-Agent': 'FreeLLMAPI/parallel-search-example' });
    expect(server.timeout).toBeGreaterThan(0);
    expect(server.timeout).toBeLessThanOrEqual(30000);
  });
});
