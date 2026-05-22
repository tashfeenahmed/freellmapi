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

  it('handles primitives and null safely', () => {
    expect(sanitizeForGemini(null)).toBe(null);
    expect(sanitizeForGemini(undefined)).toBe(undefined);
    expect(sanitizeForGemini('hello')).toBe('hello');
    expect(sanitizeForGemini(42)).toBe(42);
    expect(sanitizeForGemini(true)).toBe(true);
  });
});
