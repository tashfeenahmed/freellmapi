#!/usr/bin/env node
// scan-free-models.ts — semi-automated free-model scanner
//
// Probes the OpenAI-compatible /v1/models endpoints of the common free LLM
// providers and prints a candidate model list annotated against the current
// catalog, so a human can see at a glance which models are new candidates
// (replaces hand-written Model Request issues like #767).
//
// Usage:
//   SCAN_GROQ_KEY=... SCAN_OPENROUTER_KEY=... node scripts/scan-free-models.ts
//
// Design: semi-automated on purpose — "discover + annotate", never auto-write.
// Free-tier availability churns (#722: Cloudflare Kimi moved to paid; OpenRouter
// `:free` rotates), so the output is a candidate list for a human to confirm
// before anything lands in the catalog.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Provider = {
  name: string;
  baseUrl: string;
  keyEnv?: string;
};

// OpenAI-compatible /v1/models endpoints of the common free providers. Providers
// with a keyEnv require a key; keyless ones (ollama.com/v1 anonymous) can be
// probed without one.
const PROVIDERS: Provider[] = [
  { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'SCAN_GROQ_KEY' },
  { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'SCAN_OPENROUTER_KEY' },
  { name: 'ollama-cloud', baseUrl: 'https://ollama.com/v1', keyEnv: 'SCAN_OLLAMA_KEY' },
  { name: 'nvidia-nim', baseUrl: 'https://integrate.api.nvidia.com/v1', keyEnv: 'SCAN_NVIDIA_KEY' },
  { name: 'mistral', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'SCAN_MISTRAL_KEY' },
  { name: 'cloudflare', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1', keyEnv: 'SCAN_CLOUDFLARE_KEY' },
  { name: 'opencode-zen', baseUrl: 'https://api.opencode.ai/v1', keyEnv: 'SCAN_OPENCODE_KEY' },
  { name: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'SCAN_CEREBRAS_KEY' },
];

/** Read the catalog's model ids from the baseline migrations file, so scan
 *  output can be annotated "already in catalog" vs "new candidate". */
function readCatalogModelIds(): Set<string> {
  const migrationsPath = resolve(
    process.cwd(),
    'server/src/db/migrations/20260101_000000_legacy_baseline.ts',
  );
  const ids = new Set<string>();
  try {
    const src = readFileSync(migrationsPath, 'utf8');
    // additions rows look like: ['platform', 'model:id', 'Display name', ...]
    const rowRe = /\[\s*'[a-z0-9-]+'\s*,\s*'([^']+)'\s*,/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(src)) !== null) {
      ids.add(m[1]!);
    }
  } catch {
    // Catalog file missing (not in a checkout) — fall back to no annotations.
  }
  return ids;
}

async function scanProvider(p: Provider): Promise<string[]> {
  const key = p.keyEnv ? process.env[p.keyEnv] : undefined;
  if (p.keyEnv && !key) {
    return [];
  }
  const res = await fetch(`${p.baseUrl}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return [];
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map(m => m.id).sort();
}

async function main(): Promise<void> {
  const catalogIds = readCatalogModelIds();
  let newCandidates = 0;

  for (const p of PROVIDERS) {
    const models = await scanProvider(p);
    if (models.length === 0) {
      console.log(`[${p.name}] skipped (no ${p.keyEnv ?? 'key'} or probe failed)`);
      continue;
    }
    console.log(`\n=== ${p.name} (${models.length} models) ===`);
    for (const id of models) {
      const freeHint = id.includes(':free') || id.includes('-free');
      const inCatalog = catalogIds.has(id);
      if (!inCatalog) newCandidates += 1;
      const tags = [
        freeHint ? 'free' : '',
        inCatalog ? 'in catalog' : 'NEW CANDIDATE',
      ].filter(Boolean).join(' | ');
      console.log(`  ${id}${tags ? `  ← ${tags}` : ''}`);
    }
  }

  console.log(`\nScan done: ${newCandidates} new candidate(s) not in the catalog.`);
  console.log('Manually review against the catalog before adding (see CONTRIBUTING.md catalog conventions).');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
