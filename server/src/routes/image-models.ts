import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';

export const imageModelsRouter = Router();

/**
 * Minimal shape of the OpenRouter /api/frontend/models response we care about.
 * Only fields used by the Image models tab are typed here.
 */
interface OpenRouterImageModel {
  slug: string;
  name: string;
  short_name: string;
  author: string;
  author_display_name: string;
  description: string;
  context_length: number;
  input_modalities: string[];
  output_modalities: string[];
  has_text_output: boolean;
  supports_reasoning: boolean;
  endpoint?: {
    is_free: boolean;
    pricing?: { prompt: string; completion: string };
    limit_rpm?: number | null;
    limit_rpd?: number | null;
    provider_display_name?: string;
    provider_slug?: string;
    model_variant_slug?: string;
  };
}

/**
 * Fetch image-capable models from OpenRouter's public catalog.
 * Filters to models whose output_modalities include "image".
 * Cached in-memory for 10 minutes to avoid hammering the API.
 */
let cacheFree: { data: ImageModel[]; ts: number } | null = null;
let cacheAll: { data: ImageModel[]; ts: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Check whether an image model slug is known to be free.
 *  Used by the proxy passthrough path to reject paid image models —
 *  image generation never bills the user's OpenRouter credits.
 *  Matches against both the display slug (model_variant_slug) and the
 *  raw OpenRouter slug to handle both client-visible and API forms. (#image-gen) */
export async function isFreeImageModel(slug: string): Promise<boolean> {
  const now = Date.now();
  if (!cacheFree || now - cacheFree.ts >= CACHE_TTL_MS) {
    try {
      await refreshCacheFree();
    } catch (err: any) {
      console.warn('[ImageModels] isFreeImageModel: failed to refresh cache, rejecting conservatively:', err?.message ?? err);
      return false;
    }
  }
  return cacheFree!.data.some(m => m.slug === slug || m.rawSlug === slug);
}

async function refreshCacheFree(): Promise<ImageModel[]> {
  const resp = await fetch('https://openrouter.ai/api/frontend/models', {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`OpenRouter returned ${resp.status}`);

  const body = (await resp.json()) as { data?: OpenRouterImageModel[] };
  const all: OpenRouterImageModel[] = Array.isArray(body) ? body : (body.data ?? []);

  const free = all.filter(m => {
    if (!m.output_modalities?.includes('image') || m.output_modalities.length === 0) return false;
    return m.endpoint?.is_free === true;
  });

  const db = getDb();
  const keyPlatforms = new Set(
    (db.prepare(
      "SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')",
    ).all() as { platform: string }[]).map(r => r.platform),
  );

  const data = free.map(m => ({
    slug: m.endpoint?.model_variant_slug ?? m.slug,
    // For isFreeImageModel broad matching: the raw OpenRouter slug
    // so clients sending either form still match.
    rawSlug: m.slug,
    name: m.name,
    shortName: m.short_name,
    author: m.author,
    authorDisplayName: m.author_display_name ?? m.author ?? m.short_name.split(':')[0] ?? m.slug.split('/')[0],
    description: m.description ?? '',
    contextLength: m.context_length ?? 0,
    inputModalities: m.input_modalities ?? [],
    outputModalities: m.output_modalities ?? [],
    supportsReasoning: m.supports_reasoning ?? false,
    isFree: true,
    pricing: m.endpoint?.pricing ?? null,
    rpmLimit: m.endpoint?.limit_rpm ?? null,
    rpdLimit: m.endpoint?.limit_rpd ?? null,
    providerDisplayName: m.endpoint?.provider_display_name ?? m.author ?? 'Unknown',
    providerSlug: m.endpoint?.provider_slug ?? m.author ?? 'unknown',
    hasKey: keyPlatforms.has('openrouter'),
  }));

  cacheFree = { data, ts: Date.now() };
  return data;
}

interface ImageModel {
  slug: string;
  /** Raw OpenRouter slug (before model_variant_slug substitution).
   *  Used by isFreeImageModel for broad matching against either form. */
  rawSlug?: string;
  name: string;
  shortName: string;
  author: string;
  authorDisplayName: string;
  description: string;
  contextLength: number;
  inputModalities: string[];
  outputModalities: string[];
  supportsReasoning: boolean;
  isFree: boolean;
  pricing: { prompt: string; completion: string } | null;
  rpmLimit: number | null;
  rpdLimit: number | null;
  providerDisplayName: string;
  providerSlug: string;
  /** Whether we have a key for OpenRouter in the local DB.
   *  All image models currently route through OpenRouter exclusively;
   *  if a non-OpenRouter image model is ever added, this must become
   *  per-model (keyed on providerSlug, not a single platform check). */
  hasKey: boolean;
}

imageModelsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    // ?free_only=0 includes paid models (requires user's own OpenRouter key)
    const freeOnly = req.query.free_only !== '0';

    if (freeOnly) {
      // Reuse the shared free-only cache (also used by isFreeImageModel).
      if (!cacheFree || now - cacheFree.ts >= CACHE_TTL_MS) {
        await refreshCacheFree();
      }
      res.json(cacheFree!.data);
      return;
    }

    // Paid-model list — separate cache, fetched on demand.
    if (cacheAll && now - cacheAll.ts < CACHE_TTL_MS) {
      res.json(cacheAll.data);
      return;
    }

    const resp = await fetch('https://openrouter.ai/api/frontend/models', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      res.status(502).json({ error: { message: `OpenRouter API returned ${resp.status}` } });
      return;
    }

    const body = (await resp.json()) as { data?: OpenRouterImageModel[] };
    const all: OpenRouterImageModel[] = Array.isArray(body) ? body : (body.data ?? []);

    const imageModels = all.filter(m => {
      if (!m.output_modalities?.includes('image') || m.output_modalities.length === 0) return false;
      return true;
    });

    const db = getDb();
    const keyPlatforms = new Set(
      (db.prepare(
        "SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')",
      ).all() as { platform: string }[]).map(r => r.platform),
    );

    const result: ImageModel[] = imageModels.map(m => ({
      slug: m.endpoint?.model_variant_slug ?? m.slug,
      name: m.name,
      shortName: m.short_name,
      author: m.author,
      authorDisplayName: m.author_display_name ?? m.author ?? m.short_name.split(':')[0] ?? m.slug.split('/')[0],
      description: m.description ?? '',
      contextLength: m.context_length ?? 0,
      inputModalities: m.input_modalities ?? [],
      outputModalities: m.output_modalities ?? [],
      supportsReasoning: m.supports_reasoning ?? false,
      isFree: m.endpoint?.is_free ?? false,
      pricing: m.endpoint?.pricing ?? null,
      rpmLimit: m.endpoint?.limit_rpm ?? null,
      rpdLimit: m.endpoint?.limit_rpd ?? null,
      providerDisplayName: m.endpoint?.provider_display_name ?? m.author ?? 'Unknown',
      providerSlug: m.endpoint?.provider_slug ?? m.author ?? 'unknown',
      hasKey: keyPlatforms.has('openrouter'),
    }));

    cacheAll = { data: result, ts: now };
    res.json(result);
  } catch (err: any) {
    console.error('[ImageModels] Failed to fetch from OpenRouter:', err?.message ?? err);
    res.status(502).json({ error: { message: 'Failed to fetch image models from OpenRouter' } });
  }
});
