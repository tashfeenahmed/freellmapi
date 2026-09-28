import { describe, it, expect } from 'vitest';
import { sanitizeForGemini } from '../../lib/gemini-wire.js';

describe('sanitizeForGemini type unions', () => {
  it('collapses a nullable union into a type plus nullable at the top level', () => {
    // Google's Schema proto rejects a repeated `type` with
    // "Proto field is not repeating, cannot start list", so every schema built
    // by a `.nullable()` helper 400s unless the union is collapsed.
    expect(sanitizeForGemini({ type: ['number', 'null'] })).toEqual({
      type: 'number',
      nullable: true,
    });
  });

  it('collapses nullable unions nested in properties, items, and anyOf branches', () => {
    const input = {
      type: 'object',
      properties: {
        age: { type: ['integer', 'null'], description: 'Age in years' },
        address: {
          type: ['object', 'null'],
          properties: {
            street: { type: ['string', 'null'] },
          },
        },
        aliases: {
          type: 'array',
          items: { type: ['string', 'null'] },
        },
        contact: {
          anyOf: [
            { type: ['string', 'null'] },
            { type: 'object', properties: { email: { type: ['string', 'null'] } } },
          ],
        },
      },
      required: ['age'],
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        age: { type: 'integer', description: 'Age in years', nullable: true },
        address: {
          type: 'object',
          nullable: true,
          properties: {
            street: { type: 'string', nullable: true },
          },
        },
        aliases: {
          type: 'array',
          items: { type: 'string', nullable: true },
        },
        contact: {
          anyOf: [
            { type: 'string', nullable: true },
            { type: 'object', properties: { email: { type: 'string', nullable: true } } },
          ],
        },
      },
      required: ['age'],
    });
  });

  it('keeps the first concrete member of a union that carries no null', () => {
    expect(sanitizeForGemini({ type: ['string', 'number'] })).toEqual({ type: 'string' });
  });

  it('drops type entirely for a null-only union', () => {
    expect(sanitizeForGemini({ type: ['null'], description: 'always empty' })).toEqual({
      description: 'always empty',
      nullable: true,
    });
  });

  it('leaves a single-string type and an explicit nullable flag untouched', () => {
    expect(sanitizeForGemini({ type: 'string', nullable: true })).toEqual({
      type: 'string',
      nullable: true,
    });
  });

  it('does not treat a property literally named "type" as a type union', () => {
    const input = {
      type: 'object',
      properties: {
        type: { type: ['string', 'null'], enum: ['a', 'b'] },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['a', 'b'], nullable: true },
      },
    });
  });
});

describe('sanitizeForGemini $ref handling', () => {
  it('inlines a $ref that points into $defs', () => {
    const input = {
      type: 'object',
      $defs: {
        Address: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
      properties: {
        home: { $ref: '#/$defs/Address' },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        home: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    });
  });

  it('inlines a $ref into legacy definitions and sanitizes the target', () => {
    const input = {
      type: 'object',
      definitions: {
        Count: { type: ['integer', 'null'], exclusiveMinimum: 0, 'x-note': 'hi' },
      },
      properties: {
        count: { $ref: '#/definitions/Count', description: 'How many' },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer', nullable: true, description: 'How many' },
      },
    });
  });

  it('reuses a definition across sibling properties', () => {
    const input = {
      type: 'object',
      $defs: { Name: { type: 'string', minLength: 1 } },
      properties: {
        first: { $ref: '#/$defs/Name' },
        last: { $ref: '#/$defs/Name' },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        first: { type: 'string', minLength: 1 },
        last: { type: 'string', minLength: 1 },
      },
    });
  });

  it('drops an orphan $ref and leaves a permissive schema behind', () => {
    const input = {
      type: 'object',
      properties: {
        missing: { $ref: '#/$defs/Nope' },
        remote: { $ref: 'https://example.com/schema.json', description: 'kept' },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        missing: {},
        remote: { description: 'kept' },
      },
    });
  });

  it('stops expanding a self-referential definition', () => {
    const input = {
      type: 'object',
      $defs: {
        Node: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            child: { $ref: '#/$defs/Node' },
          },
        },
      },
      properties: { root: { $ref: '#/$defs/Node' } },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        root: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            child: {},
          },
        },
      },
    });
  });
});

describe('sanitizeForGemini vendor extensions and pass-through', () => {
  it('strips x-* keys at every depth while keeping x-prefixed property names', () => {
    const input = {
      type: 'object',
      'x-tool-version': 3,
      properties: {
        'x-request-id': {
          type: ['string', 'null'],
          'X-Legacy-Hint': 'stripped case-insensitively',
        },
        nested: {
          type: 'object',
          properties: { mode: { type: 'string', 'x-provider': 'local' } },
        },
      },
      required: ['x-request-id'],
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        'x-request-id': { type: 'string', nullable: true },
        nested: {
          type: 'object',
          properties: { mode: { type: 'string' } },
        },
      },
      required: ['x-request-id'],
    });
  });

  it('passes an already-valid schema through unchanged', () => {
    const input = {
      type: 'object',
      description: 'Look up the weather',
      properties: {
        city: { type: 'string', description: 'City name', enum: ['Karachi', 'Lahore'] },
        days: { type: 'integer', minimum: 1, maximum: 7 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
        detail: { type: 'object', nullable: true, properties: { units: { type: 'string' } } },
      },
      required: ['city'],
    };
    // Byte-identical, not merely deep-equal: nothing may be reordered or
    // re-synthesized on a schema Gemini already accepts.
    expect(JSON.stringify(sanitizeForGemini(input))).toBe(JSON.stringify(input));
  });
});

describe('sanitizeForGemini items shapes (#1334)', () => {
  // Gemini requires `items` on every ARRAY ("…items: missing field" otherwise)
  // and rejects a list-valued `items`; `items: {}` and `items: { anyOf }` are
  // accepted. Shapes below were checked against the live API.
  it('reproduces #1334: a nested array whose tuple lived in prefixItems gets items', () => {
    const out = sanitizeForGemini({
      type: 'object',
      properties: {
        query: {
          type: 'object',
          properties: {
            where: {
              type: 'array',
              items: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }, {}] },
            },
          },
        },
      },
    }) as any;
    expect(out.properties.query.properties.where).toEqual({ type: 'array', items: { type: 'array', items: {} } });
  });

  it('turns prefixItems into an anyOf over its members', () => {
    const out = sanitizeForGemini({
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'integer' }],
    }) as Record<string, unknown>;
    expect(out.items).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
  });

  it('collapses a tuple items array into anyOf over its members', () => {
    const out = sanitizeForGemini({
      type: 'array',
      items: [{ type: 'string' }, { type: 'integer' }],
    }) as Record<string, unknown>;
    expect(out.items).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
  });

  it('unwraps a single-member tuple and keeps its keywords', () => {
    const out = sanitizeForGemini({
      type: 'array',
      items: [{ type: 'string', enum: ['a', 'b'] }],
    }) as Record<string, unknown>;
    expect(out.items).toEqual({ type: 'string', enum: ['a', 'b'] });
  });

  it('adds items: {} to an array that has none', () => {
    expect(sanitizeForGemini({ type: 'array' })).toEqual({ type: 'array', items: {} });
    expect(sanitizeForGemini({ type: ['array', 'null'] })).toEqual({ type: 'array', nullable: true, items: {} });
  });

  it('keeps an empty items object instead of dropping it', () => {
    expect(sanitizeForGemini({ type: 'array', items: {} })).toEqual({ type: 'array', items: {} });
  });

  it('maps boolean, null and schema-less tuple items to items: {}', () => {
    expect(sanitizeForGemini({ type: 'array', items: true })).toEqual({ type: 'array', items: {} });
    expect(sanitizeForGemini({ type: 'array', items: null })).toEqual({ type: 'array', items: {} });
    expect(sanitizeForGemini({ type: 'array', items: [{ type: 'string' }, true] })).toEqual({ type: 'array', items: {} });
  });

  it('does not treat parameters named items or type as keywords', () => {
    const input = { type: 'object', properties: { items: { type: 'string' }, type: { type: 'string' } } };
    expect(sanitizeForGemini(input)).toEqual(input);
  });

  it('leaves non-array schemas without items alone', () => {
    expect(sanitizeForGemini({ type: 'string' })).toEqual({ type: 'string' });
  });

  it('keeps a normal single-schema items untouched', () => {
    const input = { type: 'array', items: { type: 'string', description: 'tag' } };
    expect(JSON.stringify(sanitizeForGemini(input))).toBe(JSON.stringify(input));
  });
});
