import { describe, it, expect } from 'vitest';
import { parseModelCatalog, readCappedBody, MAX_CATALOG_BYTES, MAX_DISCOVERED_MODELS, ModelDiscoveryError } from '../../services/model-discovery.js';

// #488: relays that speak "OpenAI-compatible" agree on the chat route and then
// each invent their own /models envelope. Parsing has to be tolerant or the
// Fetch-models button reads as broken against half the endpoints people use.

describe('parseModelCatalog tolerance (#488)', () => {
  it('reads the canonical OpenAI envelope', () => {
    expect(parseModelCatalog({
      object: 'list',
      data: [
        { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
        { id: 'sonnet-5', object: 'model', owned_by: 'anthropic' },
      ],
    })).toEqual([
      { id: 'gpt-4o-mini', ownedBy: 'openai' },
      { id: 'sonnet-5', ownedBy: 'anthropic' },
    ]);
  });

  it('reads a bare array of objects', () => {
    expect(parseModelCatalog([{ id: 'a' }, { id: 'b' }]).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('reads a bare array of strings', () => {
    expect(parseModelCatalog(['b', 'a']).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('reads an array of strings under data', () => {
    expect(parseModelCatalog({ data: ['a', 'b'] }).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('reads the Ollama-style models/name envelope', () => {
    expect(parseModelCatalog({
      models: [{ name: 'qwen3:4b', model: 'qwen3:4b' }, { name: 'llama3:8b' }],
    }).map(m => m.id)).toEqual(['llama3:8b', 'qwen3:4b']);
  });

  it('reads a nested data.models envelope', () => {
    expect(parseModelCatalog({ data: { models: [{ id: 'nested' }] } }).map(m => m.id)).toEqual(['nested']);
  });

  it('falls back through the id aliases relays use', () => {
    expect(parseModelCatalog({
      data: [{ model_id: 'via-model-id' }, { slug: 'via-slug' }, { modelId: 'via-model-id-camel' }],
    }).map(m => m.id).sort()).toEqual(['via-model-id', 'via-model-id-camel', 'via-slug']);
  });

  it('picks up owner aliases and defaults to null', () => {
    const byId = new Map(parseModelCatalog({
      data: [
        { id: 'a', organization: 'org-a' },
        { id: 'b', provider: 'prov-b' },
        { id: 'c', publisher: 'pub-c' },
        { id: 'd' },
      ],
    }).map(m => [m.id, m.ownedBy]));
    expect(byId.get('a')).toBe('org-a');
    expect(byId.get('b')).toBe('prov-b');
    expect(byId.get('c')).toBe('pub-c');
    expect(byId.get('d')).toBeNull();
  });

  // #685 details are aimed at OpenRouter first — it is what people actually
  // point a custom base_url at — so the fixtures below are shaped like the real
  // /api/v1/models rows: prices are STRINGS of USD per TOKEN, and the modality
  // signal is buried one level down under `architecture`.
  it('reads an OpenRouter row: per-token string prices and nested modalities (#685)', () => {
    const [m] = parseModelCatalog({
      data: [
        {
          id: 'anthropic/claude-3.5-sonnet',
          name: 'Anthropic: Claude 3.5 Sonnet',
          context_length: 200000,
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            modality: 'text+image->text',
          },
          pricing: { prompt: '0.00000125', completion: '0.000002', request: '0', image: '0' },
        },
      ],
    });
    expect(m).toEqual({
      id: 'anthropic/claude-3.5-sonnet',
      ownedBy: null,
      contextWindow: 200000,
      priceNote: '$1.25/M in $2/M out',
      isFree: false,
      vision: true,
    });
  });

  it('calls an OpenRouter zero-priced model free rather than "$0" (#685)', () => {
    const [m] = parseModelCatalog({
      data: [
        {
          id: 'deepseek/deepseek-r1:free',
          context_length: 163840,
          architecture: { input_modalities: ['text'], modality: 'text->text' },
          pricing: { prompt: '0', completion: '0', request: '0' },
        },
      ],
    });
    expect(m).toEqual({
      id: 'deepseek/deepseek-r1:free',
      ownedBy: null,
      contextWindow: 163840,
      priceNote: 'free',
      isFree: true,
      vision: false,
    });
  });

  it('accepts a relay that ships ctx_len and a plain "free" price string (#685)', () => {
    // A generic relay, not Ollama: real /api/tags ships neither field.
    const [m] = parseModelCatalog({
      models: [{ name: 'qwen3-4b', ctx_len: 32768, price: 'Free' }],
    });
    expect(m).toEqual({ id: 'qwen3-4b', ownedBy: null, contextWindow: 32768, priceNote: 'free', isFree: true });
  });

  it('caps a chatty price string so it cannot crowd out the model id (#685)', () => {
    const [m] = parseModelCatalog({
      data: [{ id: 'chatty', price: 'promo: $0.15 per million in, $0.60 per million out' }],
    });
    expect(m.priceNote!.length).toBeLessThanOrEqual(40);
    expect(m.priceNote!.endsWith('…')).toBe(true);
    expect(m.isFree).toBe(false);
  });

  it('keeps a minimal envelope shape when details are absent (#685)', () => {
    const [m] = parseModelCatalog({ data: [{ id: 'bare' }] });
    expect(m).toEqual({ id: 'bare', ownedBy: null });
    expect(Object.keys(m).sort()).toEqual(['id', 'ownedBy']);
  });

  it('drops blanks, non-strings and duplicates', () => {
    expect(parseModelCatalog({
      data: ['dup', { id: 'dup' }, { id: '   ' }, { id: 42 }, null, 'kept'],
    }).map(m => m.id)).toEqual(['dup', 'kept']);
  });

  it('drops absurdly long ids instead of storing them', () => {
    expect(parseModelCatalog({ data: [{ id: 'x'.repeat(400) }, { id: 'ok' }] }).map(m => m.id)).toEqual(['ok']);
  });

  it('returns nothing for a payload with no recognizable list', () => {
    expect(parseModelCatalog({ error: 'nope' })).toEqual([]);
    expect(parseModelCatalog('plain text')).toEqual([]);
    expect(parseModelCatalog(null)).toEqual([]);
  });

  it('caps the list so a hostile relay cannot flood the picker', () => {
    const huge = Array.from({ length: MAX_DISCOVERED_MODELS + 50 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}` }));
    expect(parseModelCatalog({ data: huge })).toHaveLength(MAX_DISCOVERED_MODELS);
  });
});

describe('readCappedBody (#488)', () => {
  it('reads a normal body', async () => {
    const res = new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } });
    expect(await readCappedBody(res)).toBe('{"data":[]}');
  });

  it('rejects a declared content-length over the cap without reading it', async () => {
    const res = new Response('{}', {
      headers: { 'content-length': String(MAX_CATALOG_BYTES + 1) },
    });
    await expect(readCappedBody(res)).rejects.toBeInstanceOf(ModelDiscoveryError);
  });

  it('rejects a body that runs past the cap while streaming', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_CATALOG_BYTES + chunk.length) {
          controller.close();
          return;
        }
        sent += chunk.length;
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    await expect(readCappedBody(new Response(body))).rejects.toBeInstanceOf(ModelDiscoveryError);
  });
});

// #1051: an upstream that returns bare ids gives visionOf nothing to read, so
// a VL model arrives looking exactly like a chat one. The id is the only
// signal left.
describe('vision inferred from the model id (#1051)', () => {
  it('flags a VL model an upstream ships with no modality metadata', () => {
    expect(parseModelCatalog({
      data: [{ id: 'Qwen/Qwen2.5-VL-72B-Instruct' }],
    })).toEqual([
      { id: 'Qwen/Qwen2.5-VL-72B-Instruct', ownedBy: null, vision: true },
    ]);
  });

  it('reads the version digits some VL ids carry', () => {
    const [m] = parseModelCatalog({ data: [{ id: 'deepseek-ai/deepseek-vl2' }] });
    expect(m.vision).toBe(true);
  });

  it('flags the named vision families', () => {
    const ids = ['llava-1.5-7b', 'OpenGVLab/InternVL2-8B', 'mistralai/Pixtral-12B', 'llama-3.2-11b-vision'];
    for (const id of ids) {
      const [m] = parseModelCatalog({ data: [{ id }] });
      expect(m.vision, id).toBe(true);
    }
  });

  it('flags a bare string entry the same way', () => {
    expect(parseModelCatalog(['Qwen2-VL-7B'])).toEqual([
      { id: 'Qwen2-VL-7B', ownedBy: null, vision: true },
    ]);
  });

  it('does not read `vl` out of a longer token', () => {
    // A relay that puts its own stack in the id must not read as multimodal.
    for (const id of ['vllm-proxy/qwen3-4b', 'acme-vlab-7b']) {
      const [m] = parseModelCatalog({ data: [{ id }] });
      expect(m.vision, id).toBeUndefined();
    }
  });

  it('leaves a text-only id with no vision key at all', () => {
    expect(parseModelCatalog({ data: [{ id: 'qwen3-4b' }] })).toEqual([
      { id: 'qwen3-4b', ownedBy: null },
    ]);
  });

  it('keeps an explicit upstream false over the id marker', () => {
    const [m] = parseModelCatalog({
      data: [{ id: 'some-vl-router', vision: false }],
    });
    expect(m.vision).toBe(false);
  });

  it('keeps upstream modality metadata authoritative when present', () => {
    const [m] = parseModelCatalog({
      data: [{ id: 'plain-chat-model', architecture: { input_modalities: ['text', 'image'] } }],
    });
    expect(m.vision).toBe(true);
  });
});

// #1051, the non-vision half: SiliconFlow-style upstreams answer /v1/models
// with bare ids, so a diffusion, whisper or video model used to register as a
// chat model and 404 forever. The id (or explicit type metadata) now yields a
// `kind`; absent kind still means "chat as far as anyone can tell".
describe('non-chat kind inferred from the model id (#1051)', () => {
  const kindOf = (id: string) => parseModelCatalog({ data: [{ id }] })[0]!.kind;

  it('classifies the SiliconFlow ids from the issue', () => {
    expect(kindOf('stabilityai/stable-diffusion-3-5-large')).toBe('image');
    expect(kindOf('black-forest-labs/FLUX.1-dev')).toBe('image');
    expect(kindOf('Kwai-Kolors/Kolors')).toBe('image');
    expect(kindOf('FunAudioLLM/SenseVoiceSmall')).toBe('transcription');
    expect(kindOf('FunAudioLLM/CosyVoice2-0.5B')).toBe('audio');
    expect(kindOf('Wan-AI/Wan2.2-T2V-A14B')).toBe('video');
    expect(kindOf('Wan-AI/Wan2.2-I2V-A14B')).toBe('video');
  });

  it('classifies the common whisper/tts/video families', () => {
    expect(kindOf('whisper-large-v3')).toBe('transcription');
    expect(kindOf('openai/whisper-large-v3-turbo')).toBe('transcription');
    expect(kindOf('gpt-tts-1')).toBe('audio');
    expect(kindOf('Lightricks/LTX-Video-0.9.5')).toBe('video');
    expect(kindOf('tencent/HunyuanVideo')).toBe('video');
    expect(kindOf('sdxl-turbo')).toBe('image');
    expect(kindOf('sd3-medium')).toBe('image');
    expect(kindOf('dall-e-3')).toBe('image');
  });

  it('classifies embedding ids, including bare `embed` tokens', () => {
    expect(kindOf('text-embedding-3-small')).toBe('embedding');
    expect(kindOf('nomic-embed-text')).toBe('embedding');
    expect(kindOf('BAAI/bge-m3')).toBe('embedding');
  });

  it('leaves chat models without a kind key at all', () => {
    expect(parseModelCatalog({ data: [{ id: 'qwen3-4b' }] })).toEqual([
      { id: 'qwen3-4b', ownedBy: null },
    ]);
    expect(kindOf('deepseek-chat')).toBeUndefined();
    expect(kindOf('claude-sonnet-5')).toBeUndefined();
  });

  it('a VL model stays a chat model that sees, never a media model', () => {
    const [m] = parseModelCatalog({ data: [{ id: 'Qwen/Qwen2.5-VL-72B-Instruct' }] });
    expect(m.vision).toBe(true);
    expect(m.kind).toBeUndefined();
  });

  it('does not read markers out of longer tokens', () => {
    expect(kindOf('sdk-helper-7b')).toBeUndefined();       // sdk is not sd
    expect(kindOf('tootsie-8b')).toBeUndefined();          // no tts token
    expect(kindOf('wandering-llama-3b')).toBeUndefined();  // wandering is not wan
    expect(kindOf('videosaurus')).toBe('video');           // but a video token anywhere counts
  });

  it('classifies bare string entries the same way', () => {
    expect(parseModelCatalog(['whisper-1'])).toEqual([
      { id: 'whisper-1', ownedBy: null, kind: 'transcription' },
    ]);
  });

  it('prefers explicit upstream type metadata over the id', () => {
    const [m] = parseModelCatalog({ data: [{ id: 'mystery-model-9', type: 'text-to-image' }] });
    expect(m.kind).toBe('image');
    const [n] = parseModelCatalog({ data: [{ id: 'plain-9', object: 'embedding' }] });
    expect(n.kind).toBe('embedding');
  });

  it("ignores OpenAI's uninformative object:'model'", () => {
    const [m] = parseModelCatalog({ data: [{ id: 'gpt-x', object: 'model' }] });
    expect(m.kind).toBeUndefined();
  });
});
