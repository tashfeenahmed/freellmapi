import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { getProviderTimeoutMs, getProvider } from '../../providers/index.js';

/**
 * Per-provider HTTP timeout override (PROVIDER_TIMEOUT_<PLATFORM>).
 *
 * Resolution model: the env var is read once, at module-load time, when
 * providers/index.ts registers each provider. Changing the env var at
 * runtime has NO effect on already-registered providers — a restart is
 * required. This mirrors PROVIDER_DAILY_REQUEST_CAP_<PLATFORM> (services/
 * ratelimit.ts), which is also a startup-only knob.
 *
 * The exported `getProviderTimeoutMs()` helper is the single source of
 * truth: every provider registration calls it, and it reads the env var
 * directly. Tests exercise the helper directly (no module re-import).
 */
describe('PROVIDER_TIMEOUT_<PLATFORM> env override', () => {
  let originals: Record<string, string | undefined> = {};

  beforeEach(() => {
    originals = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('PROVIDER_TIMEOUT_')) originals[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('PROVIDER_TIMEOUT_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originals)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it('returns the built-in defaults when no env var is set', () => {
    expect(getProviderTimeoutMs('google')).toBe(60_000);
    expect(getProviderTimeoutMs('nvidia')).toBe(90_000);
    expect(getProviderTimeoutMs('ollama')).toBe(120_000);
    expect(getProviderTimeoutMs('aihorde')).toBe(120_000);
    expect(getProviderTimeoutMs('custom')).toBe(120_000);
    expect(getProviderTimeoutMs('groq')).toBe(15_000);
    expect(getProviderTimeoutMs('openrouter')).toBe(15_000);
    expect(getProviderTimeoutMs('mistral')).toBe(15_000);
    expect(getProviderTimeoutMs('cohere')).toBe(15_000);
    expect(getProviderTimeoutMs('cloudflare')).toBe(15_000);
  });

  it('honours the env var when set to a positive integer', () => {
    process.env.PROVIDER_TIMEOUT_GROQ = '30000';
    expect(getProviderTimeoutMs('groq')).toBe(30_000);
  });

  it('treats 0 as a valid "disabled" timeout, not as the fallback default', () => {
    // 0 disables the timeout entirely — useful for hosts with very long cold
    // starts (e.g. local llama.cpp). Distinct from "unset" (use the default).
    process.env.PROVIDER_TIMEOUT_GROQ = '0';
    expect(getProviderTimeoutMs('groq')).toBe(0);
  });

  it('falls back to the default on garbage, negative, or empty values', () => {
    process.env.PROVIDER_TIMEOUT_GROQ = 'not-a-number';
    expect(getProviderTimeoutMs('groq')).toBe(15_000);
    process.env.PROVIDER_TIMEOUT_GROQ = '-1';
    expect(getProviderTimeoutMs('groq')).toBe(15_000);
    process.env.PROVIDER_TIMEOUT_GROQ = '';
    expect(getProviderTimeoutMs('groq')).toBe(15_000);
  });

  it('overrides providers that have a non-default built-in default', () => {
    // google defaults to 60s; env var can lower it.
    process.env.PROVIDER_TIMEOUT_GOOGLE = '20000';
    expect(getProviderTimeoutMs('google')).toBe(20_000);
    // nvidia defaults to 90s; env var can raise it.
    process.env.PROVIDER_TIMEOUT_NVIDIA = '180000';
    expect(getProviderTimeoutMs('nvidia')).toBe(180_000);
    // ollama / aihorde / custom default to 120s; env var can lower them.
    process.env.PROVIDER_TIMEOUT_OLLAMA = '60000';
    expect(getProviderTimeoutMs('ollama')).toBe(60_000);
    process.env.PROVIDER_TIMEOUT_AIHORDE = '240000';
    expect(getProviderTimeoutMs('aihorde')).toBe(240_000);
    process.env.PROVIDER_TIMEOUT_CUSTOM = '60000';
    expect(getProviderTimeoutMs('custom')).toBe(60_000);
  });

  it('honours overrides for cohere / cloudflare (regression — used to be hardcoded)', () => {
    // Before the constructor refactor, CohereProvider and CloudflareProvider
    // called fetchWithTimeout with no third argument, silently falling back
    // to BaseProvider's 15s default. Setting PROVIDER_TIMEOUT_* had no effect
    // on them. After: the registration wires getProviderTimeoutMs() through.
    process.env.PROVIDER_TIMEOUT_COHERE = '45000';
    expect(getProviderTimeoutMs('cohere')).toBe(45_000);
    process.env.PROVIDER_TIMEOUT_CLOUDFLARE = '60000';
    expect(getProviderTimeoutMs('cloudflare')).toBe(60_000);
  });

  it('uses the generic 15s default for unrecognised platforms', () => {
    // Defensive: a future platform registered without an explicit default
    // should still get the same 15s the OpenAICompatProvider constructor uses.
    expect(getProviderTimeoutMs('huggingface')).toBe(15_000);
    expect(getProviderTimeoutMs('cerebras')).toBe(15_000);
  });

  it('registry still contains every built-in provider with the expected name', () => {
    // Sanity check that the registration block still runs end-to-end.
    // (If a register() call threw, getProvider() would return undefined.)
    expect(getProvider('groq')?.name).toBe('Groq');
    expect(getProvider('google')?.name).toBe('Google AI Studio');
    expect(getProvider('nvidia')?.name).toBe('NVIDIA NIM');
    expect(getProvider('ollama')?.name).toBe('Ollama Cloud');
    expect(getProvider('cohere')?.name).toBe('Cohere');
    expect(getProvider('cloudflare')?.name).toBe('Cloudflare Workers AI');
    expect(getProvider('aihorde')?.name).toBe('AI Horde');
  });
});