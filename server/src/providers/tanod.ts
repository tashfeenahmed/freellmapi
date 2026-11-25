import { proxyFetch } from '../lib/proxy.js';

const sources: Record<string, string> = {
  'small-en': 'BAAI/bge-small-en-v1.5',
  multilingual: 'intfloat/multilingual-e5-small',
};
const error = (message: string, status = 502) => Object.assign(new Error(message), { status });
type WireResponse = {
  model?: {source?: string; alias?: string};
  dimensions?: number;
  data?: {index: number; embedding: number[]}[];
  usage?: {tokens: number};
  labels?: {label: string; score: number}[];
  engine?: string; source_lang?: string; target_lang?: string; text?: string;
};
// Free HTTP only. No credential, checkout request, payment signature, or redirect.
async function call(path: string, payload: unknown, kind: 'chat' | 'decision' | 'embedding', signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(30000);
  const response = await proxyFetch('https://tanod.dev/v1/' + path, {
    method: 'POST', headers: { 'X-Tanod-Free': '1', 'Content-Type': 'application/json' }, redirect: 'error',
    body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }, 'tanod', kind, 30000);
  if (!response.ok) {
    await response.body?.cancel();
    throw error('Tanod free endpoint returned HTTP ' + response.status, response.status === 402 ? 429 : response.status);
  }
  return response.json() as Promise<WireResponse>;
}

export async function tanodEmbed(model: string, inputs: string[], dims: number) {
  if (!Object.hasOwn(sources, model) || dims !== 384 || inputs.length > 64 || inputs.some(s => !s || s.length > 8000)) {
    throw error('Tanod needs a supported 384-dimension model and 1–64 short texts', 400);
  }
  const j = await call('embed', { model, texts: inputs, input_type: 'none', encoding: 'float', normalize: true }, 'embedding');
  // Tanod always identifies the backing model by source; alias is optional in its schema.
  if (j?.model?.source !== sources[model] || (j.model.alias !== undefined && j.model.alias !== model) || j.dimensions !== 384 ||
      !Array.isArray(j.data) || j.data.length !== inputs.length) throw error('Unexpected Tanod embedding model or shape');
  const vectors = j.data.map((d: {index: number; embedding: number[]}, i: number) => {
    if (d?.index !== i || !Array.isArray(d.embedding) || d.embedding.length !== 384 ||
        !d.embedding.every(Number.isFinite) || !d.embedding.some(v => v !== 0)) throw error('Invalid Tanod vector');
    return d.embedding;
  }) as number[][];
  const tokens=j.usage?.tokens;
  return { vectors, inputTokens: typeof tokens==='number' && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null };
}

export async function tanodLabels(text: string, labels: string[], instructions: string, signal?: AbortSignal) {
  if (!text || text.length > 2000 || labels.length < 2 || labels.length > 10 || labels.some(s => !s || s.length > 100) ||
      new Set(labels).size !== labels.length) throw error('Tanod supports 2–10 distinct labels and up to 2,000 characters', 400);
  const template = (instructions.trim() ? instructions.trim() + ' ' : '') + 'This example is about {}.';
  if (template.length > 200 || instructions.includes('{}')) throw error('Unsupported Tanod question instructions', 400);
  const j = await call('classify/zero-shot', { text, labels, hypothesis_template: template, multi_label: true }, 'decision', signal);
  if (j?.model?.source !== 'cross-encoder/nli-deberta-v3-xsmall' || !Array.isArray(j.labels) || j.labels.length !== labels.length) throw error('Unexpected Tanod decision model or shape');
  const scores = new Map<string,number>();
  for (const a of j.labels) {
    if (!labels.includes(a?.label) || scores.has(a.label) || !Number.isFinite(a.score) || a.score < 0 || a.score > 1) throw error('Malformed Tanod label scores');
    scores.set(a.label, a.score);
  }
  return scores;
}

export async function tanodTranslate(input: string, source: string, target: string, signal?: AbortSignal) {
  if (input.length > 5000 || source === target) throw error('Provide up to 5,000 characters and distinct language codes', 400);
  const j = await call('text/translate', { text: input, source, target }, 'chat', signal);
  if (j?.engine !== 'argos-translate (offline)' || j.source_lang !== source || j.target_lang !== target || typeof j.text !== 'string' || !j.text.trim()) throw error('Invalid Tanod translation');
  return j.text as string;
}
export const tanodStatus = (e: unknown) => (e as {status?:number} | null)?.status ?? 502;
