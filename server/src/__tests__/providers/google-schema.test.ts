import { describe, it, expect } from 'vitest';
import { sanitizeForGemini } from '../../providers/google.js';

describe('sanitizeForGemini', () => {
  it('strips top-level JSON-Schema-only fields that Google rejects', () => {
    const input = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'http://example.com/foo.json',
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
  });

  it('strips exclusiveMinimum / exclusiveMaximum recursively in nested properties', () => {
    const input = {
      type: 'object',
      properties: {
        temp_threshold: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100 },
        nested: {
          type: 'object',
          properties: {
            count: { type: 'integer', exclusiveMinimum: 1 },
          },
        },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        temp_threshold: { type: 'number' },
        nested: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
          },
        },
      },
    });
  });

  it('walks through arrays (e.g. anyOf branches)', () => {
    const input = {
      anyOf: [
        { type: 'string', $ref: '#/definitions/foo' },
        { type: 'number', exclusiveMinimum: 0 },
      ],
    };
    expect(sanitizeForGemini(input)).toEqual({
      anyOf: [
        { type: 'string' },
        { type: 'number' },
      ],
    });
  });

  it('removes $defs / definitions / patternProperties / if-then-else', () => {
    const input = {
      type: 'object',
      $defs: { Foo: { type: 'string' } },
      definitions: { Bar: { type: 'integer' } },
      patternProperties: { '^x-': { type: 'string' } },
      if: { properties: { kind: { const: 'A' } } },
      then: { required: ['extra'] },
      else: { required: [] },
      properties: { kind: { type: 'string' } },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: { kind: { type: 'string' } },
    });
  });

  it('passes through supported OpenAPI fields untouched', () => {
    const input = {
      type: 'object',
      description: 'A tool input',
      required: ['city'],
      properties: {
        city: { type: 'string', description: 'City name', enum: ['Karachi', 'Lahore'] },
        items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
      },
    };
    expect(sanitizeForGemini(input)).toEqual(input);
  });

  it('strips additionalProperties (Gemini rejects it with 400)', () => {
    const input = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: {
          type: 'object',
          properties: { street: { type: 'string' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: {
          type: 'object',
          properties: { street: { type: 'string' } },
        },
      },
    });
  });

  it('handles primitives and null safely', () => {
    expect(sanitizeForGemini(null)).toBe(null);
    expect(sanitizeForGemini(undefined)).toBe(undefined);
    expect(sanitizeForGemini('hello')).toBe('hello');
    expect(sanitizeForGemini(42)).toBe(42);
    expect(sanitizeForGemini(true)).toBe(true);
  });

  it('strips examples / const / readOnly / writeOnly (Gemini rejects all with 400)', () => {
    // These fields are emitted by Zod, Pydantic, and most JSON-Schema generators
    // (used by opencode, Continue, Cline tool definitions) but rejected by Google's
    // Gemini and Gemma 4 IT generateContent endpoint with "Invalid JSON payload
    // received. Unknown name 'X' at tools[0].function_declarations[0].parameters".
    const input = {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
          examples: ['ls -la', 'pwd'],
          readOnly: false,
        },
        mode: { type: 'string', const: 'sync' },
        secret: { type: 'string', writeOnly: true },
      },
      required: ['command'],
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        mode: { type: 'string' },
        secret: { type: 'string' },
      },
      required: ['command'],
    });
  });

  it('strips uniqueItems (Gemini rejects arrays with uniqueItems with 400)', () => {
    // Confirmed via live Google AI Studio call:
    // "Invalid JSON payload received. Unknown name 'uniqueItems' at
    //  'tools[0].function_declarations[0].parameters.properties[2].value':
    //  Cannot find field."
    const input = {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          uniqueItems: true,
          minItems: 0,
          maxItems: 10,
        },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          minItems: 0,
          maxItems: 10,
        },
      },
    });
  });

  it('strips composition / structural keywords absent from Google Schema proto', () => {
    // not / allOf / oneOf / prefixItems / contains / propertyNames / multipleOf /
    // dependencies / deprecated are all absent from Google's Schema proto
    // (https://ai.google.dev/api/caching#Schema). Only anyOf is supported.
    const input = {
      type: 'object',
      not: { type: 'null' },
      allOf: [{ type: 'object' }],
      oneOf: [{ type: 'string' }, { type: 'number' }],
      dependencies: { a: ['b'] },
      deprecated: true,
      properties: {
        tuple: { type: 'array', prefixItems: [{ type: 'string' }] },
        bag: { type: 'array', contains: { type: 'string' }, minContains: 1, maxContains: 5 },
        names: { type: 'object', propertyNames: { pattern: '^x_' } },
        count: { type: 'number', multipleOf: 0.5 },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        tuple: { type: 'array' },
        bag: { type: 'array' },
        names: { type: 'object' },
        count: { type: 'number' },
      },
    });
  });
});
