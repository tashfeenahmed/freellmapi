import { mkdir, writeFile } from 'node:fs/promises';

const endpoint = 'https://openrouter.ai/api/v1/models';

console.log('Fetching OpenRouter public model catalog...');

const response = await fetch(endpoint, {
  headers: { Accept: 'application/json' },
  signal: AbortSignal.timeout(30000),
});

if (!response.ok) {
  throw new Error(`OpenRouter returned HTTP ${response.status}`);
}

const result = await response.json();

if (!Array.isArray(result.data)) {
  throw new Error('Unexpected OpenRouter response: missing data array');
}

const isZero = value =>
  value !== undefined &&
  value !== null &&
  value !== '' &&
  Number.isFinite(Number(value)) &&
  Number(value) === 0;

const models = result.data
  .filter(model => {
    const pricing = model.pricing ?? {};
    const outputs = model.architecture?.output_modalities ?? [];

    return (
      typeof model.id === 'string' &&
      model.id.endsWith(':free') &&
      outputs.includes('text') &&
      isZero(pricing.prompt) &&
      isZero(pricing.completion) &&
      Object.values(pricing).every(isZero)
    );
  })
  .map(model => ({
    id: model.id,
    name: model.name ?? model.id,
    context_length: model.context_length ?? null,
    max_completion_tokens: model.top_provider?.max_completion_tokens ?? null,
    input_modalities: model.architecture?.input_modalities ?? [],
    output_modalities: model.architecture?.output_modalities ?? [],
    pricing: {
      prompt: model.pricing.prompt,
      completion: model.pricing.completion,
    },
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

if (models.length === 0) {
  throw new Error('No qualifying free chat models found; refusing to overwrite catalog');
}

const catalog = {
  source: endpoint,
  updated_at: new Date().toISOString(),
  count: models.length,
  activation: 'manual-review-required',
  models,
};

await mkdir('generated/free-models', { recursive: true });
await writeFile(
  'generated/free-models/openrouter.json',
  JSON.stringify(catalog, null, 2) + '\n',
);

console.log(`Found ${models.length} explicitly free text models.`);
console.log('Saved generated/free-models/openrouter.json');
