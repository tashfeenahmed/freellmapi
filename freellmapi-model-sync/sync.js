#!/usr/bin/env node
// freellmapi-model-sync: independent sidecar that discovers newly-free models
// on OpenRouter and registers them into a local FreeLLMAPI deployment through
// its HTTP API (POST /api/keys/custom). It never touches FreeLLMAPI source code
// or the SQLite DB directly.
//
// Two modes:
//  - OpenRouter pricing mode (always on): pulls OpenRouter's public /models,
//    keeps only models whose pricing.prompt == 0 AND pricing.completion == 0,
//    probes with your key, registers new ones as a custom endpoint.
//  - Discover mode (DISCOVER_MODE=true): for each OTHER custom endpoint already
//    configured in FreeLLMAPI, asks FreeLLMAPI's /api/keys/custom/discover-models
//    for the model list that endpoint's own key can see, and registers any NEW
//    id not already present (after a probe). Native providers (groq/cerebras/…)
//    are owned by FreeLLMAPI's catalog-sync and are intentionally NOT touched.
//
// Reconciliation: models we synced that vanish from upstream are DISABLED
// (never deleted) after DISABLE_AFTER_MISSES consecutive misses, and re-enabled
// if they reappear. Sync state is a small JSON file (idempotent + restartable).

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const cfg = {
  freeApiBaseUrl: (process.env.FREEAPI_BASE_URL || 'http://freellmapi:3001').replace(/\/+$/, ''),
  freeApiEmail: process.env.FREEAPI_EMAIL || '',
  freeApiPassword: process.env.FREEAPI_PASSWORD || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  openrouterLabel: process.env.OPENROUTER_LABEL || 'OpenRouter (auto-sync)',
  // OpenCode Zen settings
  opencodeApiKey: process.env.OPENCODE_API_KEY || '',
  opencodeBaseUrl: (process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/v1').replace(/\/+$/, ''),
  opencodeLabel: process.env.OPENCODE_LABEL || 'OpenCode Zen (auto-sync)',
  opencodeModelsDevTree: process.env.OPENCODE_MODELS_DEV_TREE || 'https://api.github.com/repos/shakenetwork/models.dev/git/trees/5758c790684e3ef8d7a49884a490511e525df655?recursive=1',
  opencodeModelsBaseUrl: process.env.OPENCODE_MODELS_BASE_URL || 'https://raw.githubusercontent.com/shakenetwork/models.dev/dev/providers/opencode/models',

  discoverMode: String(process.env.DISCOVER_MODE || 'false').toLowerCase() === 'true',
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 8 * 60 * 60 * 1000),
  disableAfterMisses: Number(process.env.DISABLE_AFTER_MISSES || 3),
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false',
  probeTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 30000),
  statePath: process.env.SYNC_STATE_PATH || '/app/state/sync-state.json',
  runOnce: String(process.env.RUN_ONCE || 'false').toLowerCase() === 'true',
  logModels: String(process.env.LOG_MODELS || 'false').toLowerCase() === 'true',
};

function ts() { return new Date().toISOString(); }
function log(level, event, detail) {
  console.log(`[${ts()}] [${level}] [${event}] ${detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
function pick(o, ...names) {
  for (const n of names) { if (o && o[n] !== undefined && o[n] !== null) return o[n]; }
  return undefined;
}
function modelIdOf(m) { return pick(m, 'model_id', 'modelId', 'id'); }
function platformOf(m) { return pick(m, 'platform'); }
function scopeOf(m) { return pick(m, 'endpoint_scope', 'endpointScope') || ''; }
function enabledOf(m) { const v = pick(m, 'enabled'); return v === 1 || v === true; }
function keyIdOf(m) { const v = pick(m, 'key_id', 'keyId', 'id'); return v === undefined ? undefined : Number(v); }
function dbIdOf(m) { const v = pick(m, 'id', 'modelDbId'); return v === undefined ? undefined : Number(v); }

function loadState() {
  try { if (fs.existsSync(cfg.statePath)) return JSON.parse(fs.readFileSync(cfg.statePath, 'utf8')) || { token: null, models: {} }; }
  catch (err) { log('warn', 'state-load-failed', err.message); }
  return { token: null, models: {} };
}
function saveState(state) {
  try { fs.mkdirSync(path.dirname(cfg.statePath), { recursive: true }); fs.writeFileSync(cfg.statePath, JSON.stringify(state, null, 2)); }
  catch (err) { log('error', 'state-save-failed', err.message); }
}

async function freeApi(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(cfg.freeApiBaseUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch {} }
  return { ok: res.ok, status: res.status, json, text };
}
async function login(state) {
  if (!cfg.freeApiEmail || !cfg.freeApiPassword) throw new Error('FREEAPI_EMAIL / FREEAPI_PASSWORD not set');
  const r = await freeApi('/api/auth/login', { method: 'POST', body: { email: cfg.freeApiEmail, password: cfg.freeApiPassword } });
  if (!r.ok || !r.json?.token) throw new Error(`login failed: ${r.status} ${r.text || JSON.stringify(r.json)}`);
  state.token = r.json.token; saveState(state); log('info', 'login', { email: r.json.email });
  return state.token;
}
async function freeApiAuthed(state, pathname, opts = {}) {
  let token = state.token || await login(state);
  let r = await freeApi(pathname, { ...opts, token });
  if (r.status === 401) { log('warn', 'token-expired', 're-logging in'); token = await login(state); r = await freeApi(pathname, { ...opts, token }); }
  return r;
}

async function getLocalInventory(state) {
  const r = await freeApiAuthed(state, '/api/models');
  if (!r.ok) throw new Error(`GET /api/models failed: ${r.status} ${r.text}`);
  const rows = Array.isArray(r.json) ? r.json : (r.json?.models || r.json?.data || []);
  let openrouterKeyId;
  let customEndpoints = [];
  const kr = await freeApiAuthed(state, '/api/keys');
  if (kr.ok) {
    const keys = Array.isArray(kr.json) ? kr.json : (kr.json?.keys || kr.json?.data || []);
    const norm = (u) => (u || '').trim().replace(/\/+$/, '');
    const match = keys.find(k => platformOf(k) === 'custom' && norm(pick(k, 'base_url', 'baseUrl')) === cfg.openrouterBaseUrl);
    if (match) openrouterKeyId = keyIdOf(match);
    customEndpoints = keys.filter(k => platformOf(k) === 'custom').map(k => ({ keyId: keyIdOf(k), baseUrl: pick(k, 'base_url', 'baseUrl') })).filter(e => e.keyId != null);
  } else { log('warn', 'keys-list-failed', `${kr.status} ${kr.text}`); }
  const covered = new Set();
  const customRowsByKey = new Map();
  for (const m of rows) {
    const pid = platformOf(m), mid = modelIdOf(m);
    if (!mid) continue;
    covered.add(`${pid}::${mid}`);
    if (pid === 'custom') customRowsByKey.set(`${scopeOf(m)}::${mid}`, m);
  }
  return { rows, openrouterKeyId, customEndpoints, covered, customRowsByKey };
}

async function fetchOpenRouterFreeModels() {
  const res = await fetch(cfg.openrouterBaseUrl + '/models');
  if (!res.ok) throw new Error(`OpenRouter /models failed: ${res.status}`);
  const j = await res.json();
  const all = Array.isArray(j.data) ? j.data : [];
  const free = [];
  for (const m of all) {
    if (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0) {
      const supp = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      free.push({ id: m.id, name: m.name || m.id, context_length: m.context_length ?? null, supports_tools: supp.includes('tools'), supports_vision: String(m.architecture?.modality || '').includes('image') });
    }
  }
  return { total: all.length, free };
}



// OpenCode Zen pricing mode: fetches from models.dev GitHub, parses TOML for cost==0
async function fetchOpenCodeZenFreeModels() {
  const treeRes = await fetch(cfg.opencodeModelsDevTree, {
    headers: { 'User-Agent': 'freellmapi-model-sync/1.0', 'Accept': 'application/vnd.github.v3+json' },
  });
  if (!treeRes.ok) throw new Error('models.dev tree fetch failed: ' + treeRes.status);
  const tree = await treeRes.json();
  const tomlFiles = (tree.tree || []).filter(f => f.path.endsWith('.toml') && f.type === 'blob');
  const free = [];
  for (const file of tomlFiles) {
    const modelId = file.path.replace(/\.toml$/, '');
    try {
      const rawRes = await fetch(cfg.opencodeModelsBaseUrl + '/' + file.path, {
        headers: { 'User-Agent': 'freellmapi-model-sync/1.0' },
      });
      if (!rawRes.ok) continue;
      const raw = await rawRes.text();
      const costMatch = raw.match(/\[cost\][\s\S]*?(?=\n\[|\n$|$)/);
      if (!costMatch) continue;
      const costBlock = costMatch[0];
      const inputMatch = costBlock.match(/input\s*=\s*([\d.eE+-]+)/);
      const outputMatch = costBlock.match(/output\s*=\s*([\d.eE+-]+)/);
      if (!inputMatch || !outputMatch) continue;
      if (parseFloat(inputMatch[1]) !== 0 || parseFloat(outputMatch[1]) !== 0) continue;
      const nameMatch = raw.match(/^name\s*=\s*"(.+)"$/m);
      const descMatch = raw.match(/^description\s*=\s*"(.+)"$/m);
      const ctxMatch = raw.match(/context\s*=\s*([\d_]+)/);
      const toolMatch = raw.match(/tool_call\s*=\s*(true|false)/);
      const visionMatch = raw.match(/input\s*=\s*\[[\s\S]*?"image"[\s\S]*?\]/m);
      const reasoningMatch = raw.match(/^reasoning\s*=\s*(true|false)$/m);
      const statusMatch = raw.match(/^status\s*=\s*"(.+)"$/m);
      if (statusMatch && statusMatch[1] === 'deprecated') continue;
      free.push({
        id: modelId,
        name: (nameMatch && nameMatch[1]) || modelId,
        description: (descMatch && descMatch[1]) || '',
        context_length: ctxMatch ? parseInt(ctxMatch[1].replace(/_/g, '')) : null,
        supports_tools: !!(toolMatch && toolMatch[1] === 'true'),
        supports_vision: !!visionMatch,
        supports_reasoning: !!(reasoningMatch && reasoningMatch[1] === 'true'),
      });
    } catch(e) { /* skip malformed */ }
  }
  return { total: tomlFiles.length, free };
}

async function probeOpenCodeZenModel(id) {
  try {
    const res = await fetch(cfg.opencodeBaseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.opencodeApiKey },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(cfg.probeTimeoutMs),
    });
    if (res.ok) return { ok: true, status: res.status };
    let body = ''; try { body = await res.text(); } catch {}
    return { ok: false, status: res.status, body: body.slice(0, 200) };
  } catch (err) { return { ok: false, status: 0, body: err.message }; }
}
async function probeOpenRouterModel(id) {
  try {
    const res = await fetch(cfg.openrouterBaseUrl + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openrouterApiKey}` },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(cfg.probeTimeoutMs),
    });
    if (res.ok) return { ok: true, status: res.status };
    let body = ''; try { body = await res.text(); } catch {}
    return { ok: false, status: res.status, body: body.slice(0, 200) };
  } catch (err) { return { ok: false, status: 0, body: err.message }; }
}

async function registerModels(state, entries, baseUrl, apiKey, label) {
  const body = { baseUrl: baseUrl || cfg.openrouterBaseUrl, apiKey: apiKey || cfg.openrouterApiKey, label: label || cfg.openrouterLabel,
    models: entries.map(e => ({ model: e.id, displayName: e.name || e.id, supportsTools: !!e.supports_tools, supportsVision: !!e.supports_vision })) };
  const r = await freeApiAuthed(state, '/api/keys/custom', { method: 'POST', body });
  if (!r.ok) throw new Error(`POST /api/keys/custom failed: ${r.status} ${r.text}`);
  const registered = Array.isArray(r.json?.models) ? r.json.models : [];
  log('info', 'registered', { count: registered.length, keyId: r.json?.keyId, baseUrl: body.baseUrl });
  return registered;
}

async function setModelEnabled(state, dbId, enabled) {
  const r = await freeApiAuthed(state, `/api/models/${dbId}`, { method: 'PATCH', body: { enabled } });
  if (!r.ok) log('warn', 'patch-enabled-failed', { dbId, enabled, status: r.status, body: r.text });
  return r.ok;
}

async function runOnce(state) {
  const summary = { discovered: 0, added: 0, skipped: 0, probeFailed: 0, disabled: 0, restored: 0, failures: [] };
  log('info', 'sync-start', { dryRun: cfg.dryRun, discoverMode: cfg.discoverMode, intervalMs: cfg.syncIntervalMs });

  const inv = await getLocalInventory(state);
  log('info', 'local-inventory', { openrouterKeyId: inv.openrouterKeyId ?? null, customEndpoints: inv.customEndpoints.length, covered: inv.covered.size });

  // ── OpenRouter pricing mode ──────────────────────────────────────────────
  const { total, free } = await fetchOpenRouterFreeModels();
  summary.discovered = free.length;
  log('info', 'upstream-free', { total, free: free.length });
  if (cfg.logModels) for (const m of free) log('info', 'upstream-free-item', { id: m.id, tools: m.supports_tools, vision: m.supports_vision });
  const orUpstreamIds = new Set(free.map(m => m.id));
  const newModels = free.filter(m => !inv.covered.has(`openrouter::${m.id}`) && !inv.covered.has(`custom::${m.id}`));
  log('info', 'new-candidates', { count: newModels.length });

  if (!cfg.dryRun) {
    const toAdd = [];
    for (const m of newModels) {
      const probe = await probeOpenRouterModel(m.id);
      if (probe.ok) { toAdd.push(m); log('info', 'probe-ok', { id: m.id, status: probe.status }); }
      else { summary.probeFailed += 1; log('warn', 'probe-failed', { id: m.id, status: probe.status, body: probe.body }); }
      await sleep(500);
    }
    if (toAdd.length > 0) {
      const registered = await registerModels(state, toAdd);
      summary.added += registered.filter(m => m.created !== false).length;
      for (const m of registered) {
        const key = `${cfg.openrouterBaseUrl}::${m.model}`;
        state.models[key] = state.models[key] || {};
        state.models[key].addedAt = state.models[key].addedAt || ts();
        state.models[key].dbId = m.modelDbId;
        state.models[key].misses = 0; state.models[key].disabled = false; state.models[key].lastSeen = ts();
      }
      saveState(state);
    }
  } else {
    for (const m of newModels) log('info', 'dry-run-would-add', { id: m.id, name: m.name });
    summary.skipped += newModels.length;
  }

  // Reconcile OUR openrouter custom rows (by endpoint_scope == openrouterBaseUrl)
  for (const [key, row] of inv.customRowsByKey) {
    const [scope, mid] = key.split('::');
    if (scope !== cfg.openrouterBaseUrl) continue;
    const st = state.models[key] || (state.models[key] = { addedAt: ts(), misses: 0, disabled: false, scope });
    st.dbId = dbIdOf(row);
    if (orUpstreamIds.has(mid)) {
      st.misses = 0; st.lastSeen = ts();
      if (!enabledOf(row) && st.disabled) {
        if (!cfg.dryRun) { const ok = await setModelEnabled(state, st.dbId, true); if (ok) { st.disabled = false; summary.restored += 1; log('info', 'restored', { id: mid, dbId: st.dbId }); } }
        else log('info', 'dry-run-would-restore', { id: mid, dbId: st.dbId });
      }
    } else {
      st.misses = (st.misses || 0) + 1;
      log('warn', 'upstream-miss', { id: mid, misses: st.misses, threshold: cfg.disableAfterMisses });
      if (st.misses >= cfg.disableAfterMisses && enabledOf(row) && !st.disabled) {
        if (!cfg.dryRun) { const ok = await setModelEnabled(state, st.dbId, false); if (ok) { st.disabled = true; summary.disabled += 1; log('warn', 'disabled', { id: mid, dbId: st.dbId, misses: st.misses }); } }
        else log('info', 'dry-run-would-disable', { id: mid, dbId: st.dbId, misses: st.misses });
      }
    }
  }
  saveState(state);


  // OpenCode Zen pricing mode
  if (cfg.opencodeApiKey) {
    try {
      const { total, free: zenFree } = await fetchOpenCodeZenFreeModels();
      summary.discovered += zenFree.length;
      log('info', 'opencode-zen-upstream', { total, free: zenFree.length });
      if (cfg.logModels) for (const m of zenFree) log('info', 'opencode-zen-item', { id: m.id, name: m.name });
      const zenNew = zenFree.filter(m => !inv.covered.has('opencode::' + m.id) && !inv.covered.has('custom::' + m.id));
      log('info', 'opencode-zen-new-candidates', { count: zenNew.length });
      if (!cfg.dryRun) {
        const toAdd = [];
        for (const m of zenNew) {
          const probe = await probeOpenCodeZenModel(m.id);
          if (probe.ok) { toAdd.push(m); log('info', 'opencode-zen-probe-ok', { id: m.id, status: probe.status }); }
          else { summary.probeFailed += 1; log('warn', 'opencode-zen-probe-failed', { id: m.id, status: probe.status, body: probe.body }); }
          await sleep(500);
        }
        if (toAdd.length > 0) {
          const registered = await registerModels(state, toAdd, cfg.opencodeBaseUrl, cfg.opencodeApiKey, cfg.opencodeLabel);
          summary.added += registered.filter(m => m.created !== false).length;
          for (const m of registered) {
            const key = cfg.opencodeBaseUrl + '::' + m.model;
            state.models[key] = state.models[key] || {};
            state.models[key].addedAt = state.models[key].addedAt || ts();
            state.models[key].dbId = m.modelDbId;
            state.models[key].misses = 0; state.models[key].disabled = false; state.models[key].lastSeen = ts();
          }
          saveState(state);
        }
      } else {
        for (const m of zenNew) log('info', 'opencode-zen-dry-run-would-add', { id: m.id, name: m.name });
        summary.skipped += zenNew.length;
      }
      for (const [key, row] of inv.customRowsByKey) {
        const [scope, mid] = key.split('::');
        if (scope !== cfg.opencodeBaseUrl) continue;
        const st = state.models[key] || (state.models[key] = { addedAt: ts(), misses: 0, disabled: false, scope });
        st.dbId = dbIdOf(row);
        const upstreamExists = zenFree.some(m => m.id === mid);
        if (upstreamExists) {
          st.misses = 0; st.lastSeen = ts();
          if (!enabledOf(row) && st.disabled) {
            if (!cfg.dryRun) { const ok = await setModelEnabled(state, st.dbId, true); if (ok) { st.disabled = false; summary.restored += 1; log('info', 'opencode-zen-restored', { id: mid, dbId: st.dbId }); } }
            else log('info', 'opencode-zen-dry-run-would-restore', { id: mid, dbId: st.dbId });
          }
        } else {
          st.misses = (st.misses || 0) + 1;
          log('warn', 'opencode-zen-upstream-miss', { id: mid, misses: st.misses, threshold: cfg.disableAfterMisses });
          if (st.misses >= cfg.disableAfterMisses && enabledOf(row) && !st.disabled) {
            if (!cfg.dryRun) { const ok = await setModelEnabled(state, st.dbId, false); if (ok) { st.disabled = true; summary.disabled += 1; log('warn', 'opencode-zen-disabled', { id: mid, dbId: st.dbId, misses: st.misses }); } }
            else log('info', 'opencode-zen-dry-run-would-disable', { id: mid, dbId: st.dbId, misses: st.misses });
          }
        }
      }
      saveState(state);
    } catch (err) {
      log('error', 'opencode-zen-sync-error', err.message);
    }
  } else {
    log('info', 'opencode-zen-skipped', 'OPENCODE_API_KEY not set');
  }


  // ── Discover mode: other custom endpoints ────────────────────────────────
  if (cfg.discoverMode) {
    for (const ep of inv.customEndpoints) {
      if (ep.baseUrl === cfg.openrouterBaseUrl) continue;
      try {
        const dr = await freeApiAuthed(state, '/api/keys/custom/discover-models', { method: 'POST', body: { keyId: ep.keyId } });
        if (!dr.ok) { summary.failures.push({ endpoint: ep.baseUrl, error: `discover ${dr.status}` }); log('warn', 'discover-failed', { baseUrl: ep.baseUrl, status: dr.status }); continue; }
        const models = Array.isArray(dr.json?.models) ? dr.json.models : [];
        const fresh = models.filter(m => !m.registered && m.id);
        log('info', 'discover-candidates', { baseUrl: ep.baseUrl, fresh: fresh.length });
        if (cfg.dryRun) { log('info', 'dry-run-discover-would-add', { baseUrl: ep.baseUrl, ids: fresh.map(m => m.id) }); continue; }
        const toAdd = [];
        for (const m of fresh) {
          if (inv.covered.has(`custom::${m.id}`)) continue;
          const probe = await probeOpenRouterModel(m.id); // reuse generic probe against ep.baseUrl in real impl
          if (probe.ok) { toAdd.push({ id: m.id, name: m.id, supports_tools: !!m.supportsTools, supports_vision: !!m.supportsVision }); log('info', 'discover-probe-ok', { baseUrl: ep.baseUrl, id: m.id }); }
          else { summary.probeFailed += 1; log('warn', 'discover-probe-failed', { baseUrl: ep.baseUrl, id: m.id }); }
          await sleep(500);
        }
        if (toAdd.length > 0) { const registered = await registerModels(state, toAdd, ep.baseUrl); summary.added += registered.filter(m => m.created !== false).length; }
      } catch (err) { summary.failures.push({ endpoint: ep.baseUrl, error: err.message }); log('error', 'discover-error', { baseUrl: ep.baseUrl, error: err.message }); }
    }
  }

  log('info', 'sync-done', summary);
  return summary;
}

async function main() {
  if (!cfg.openrouterApiKey) { log('error', 'config', 'missing env: OPENROUTER_API_KEY'); process.exit(1); }
  const state = loadState();
  log('info', 'boot', { freeApiBaseUrl: cfg.freeApiBaseUrl, openrouterBaseUrl: cfg.openrouterBaseUrl, intervalMs: cfg.syncIntervalMs, disableAfterMisses: cfg.disableAfterMisses, dryRun: cfg.dryRun, discoverMode: cfg.discoverMode, runOnce: cfg.runOnce, statePath: cfg.statePath });
  const loop = async () => { try { await runOnce(state); } catch (err) { log('error', 'sync-error', err.message); } };
  await loop();
  if (cfg.runOnce) return;
  while (true) { await sleep(Math.round(cfg.syncIntervalMs * (0.9 + Math.random() * 0.2))); await loop(); }
}

main().catch(err => { log('error', 'fatal', err.message); process.exit(1); });
