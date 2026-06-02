/**
 * Routing simulation — exercises the real routeRequest() against an in-memory
 * DB seeded with synthetic traffic, so you can SEE how each strategy distributes
 * requests and how the bandit adapts when a model starts failing.
 *
 *   cd server && npm run build && node dist/scripts/routing-sim.js
 */
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.DEV_MODE = 'true';

import { initDb, getDb } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import {
  routeRequest, refreshStatsCache, setRoutingStrategy, getRoutingScores,
} from '../services/router.js';
import type { RoutingStrategy } from '../services/scoring.js';

interface Profile {
  platform: string; modelId: string; name: string;
  intelligenceRank: number; sizeLabel: string; budget: string;
  // synthetic history
  successes: number; failures: number; outTokens: number; latencyMs: number; ttfbMs: number;
}

// Deliberately no model that wins on every axis — so each strategy's weight
// vector picks a DIFFERENT winner (that's the whole point of the redesign).
const PROFILES: Profile[] = [
  // Frontier intelligence, good-not-great reliability, genuinely slow → wins SMARTEST.
  { platform: 'google', modelId: 'gemini-x', name: 'Frontier-Smart', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', successes: 22, failures: 4, outTokens: 200, latencyMs: 5000, ttfbMs: 2500 },
  // Small/dumb but blazing fast and reliable → wins FASTEST.
  { platform: 'groq', modelId: 'llama-fast', name: 'Speed-King', intelligenceRank: 9, sizeLabel: 'Small', budget: '~50M', successes: 27, failures: 3, outTokens: 1100, latencyMs: 700, ttfbMs: 110 },
  // Middling intel/speed but rock-solid reliability → wins RELIABLE.
  { platform: 'openrouter', modelId: 'rock', name: 'Rock-Solid', intelligenceRank: 5, sizeLabel: 'Medium', budget: '~50M', successes: 40, failures: 1, outTokens: 250, latencyMs: 2000, ttfbMs: 1500 },
  // Large/smart but flaky — high intelligence dragged down by failures.
  { platform: 'cerebras', modelId: 'smart-flaky', name: 'Smart-Flaky', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', successes: 18, failures: 14, outTokens: 500, latencyMs: 1500, ttfbMs: 600 },
];

function seed() {
  const db = getDb();
  db.exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
  const insModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
    VALUES (?, ?, ?, ?, 1, ?, 100000, 1000000, 100000000, 1000000000, ?, 1)
  `);
  const insFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  const insHist = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?)
  `);

  PROFILES.forEach((p, i) => {
    insModel.run(p.platform, p.modelId, p.name, p.intelligenceRank, p.sizeLabel, p.budget);
    const id = (db.prepare('SELECT id FROM models WHERE platform=? AND model_id=?').get(p.platform, p.modelId) as { id: number }).id;
    insFb.run(id, i + 1);
    const { encrypted, iv, authTag } = encrypt(`key-${p.platform}`);
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'sim', ?, ?, ?, 'healthy', 1)`)
      .run(p.platform, encrypted, iv, authTag);
    for (let s = 0; s < p.successes; s++) insHist.run(p.platform, p.modelId, 'success', p.outTokens, p.latencyMs, null, p.ttfbMs);
    for (let f = 0; f < p.failures; f++) insHist.run(p.platform, p.modelId, 'error', 0, p.latencyMs, 'sim-fail', p.ttfbMs);
  });
}

function distribution(runs: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < runs; i++) {
    const r = routeRequest(100);
    counts.set(r.displayName, (counts.get(r.displayName) ?? 0) + 1);
  }
  return counts;
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`.padStart(6);
}

function printDistribution(title: string, counts: Map<string, number>, runs: number) {
  console.log(`\n  ${title}`);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted) {
    const bar = '█'.repeat(Math.round((n / runs) * 30));
    console.log(`    ${name.padEnd(22)} ${pct(n, runs)}  ${bar}`);
  }
}

function printScores() {
  const { scores } = getRoutingScores();
  console.log('    model                  rel  spd  int  guard  score');
  for (const s of scores) {
    const guard = s.headroom * s.rateLimit;
    console.log(
      `    ${s.displayName.padEnd(22)} ` +
      `${Math.round(s.reliability * 100).toString().padStart(3)}  ` +
      `${Math.round(s.speed * 100).toString().padStart(3)}  ` +
      `${Math.round(s.intelligence * 100).toString().padStart(3)}  ` +
      `${guard.toFixed(2).padStart(5)}  ` +
      `${s.score.toFixed(3)}`,
    );
  }
}

function main() {
  initDb(':memory:');
  seed();
  const RUNS = 2000;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  ROUTING SIMULATION  —  4 models, 2000 requests per strategy');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('\n  Synthetic profiles:');
  for (const p of PROFILES) {
    const rate = (p.successes / (p.successes + p.failures) * 100).toFixed(0);
    const tps = (p.outTokens * 1000 / p.latencyMs).toFixed(0);
    console.log(`    ${p.name.padEnd(22)} ${p.sizeLabel.padEnd(9)} success ${rate}%  ${tps} tok/s  ${p.ttfbMs}ms ttfb`);
  }

  const strategies: RoutingStrategy[] = ['priority', 'balanced', 'smartest', 'fastest', 'reliable'];
  for (const strat of strategies) {
    setRoutingStrategy(strat);
    refreshStatsCache(getDb(), true);
    if (strat === 'balanced') { console.log('\n  ── balanced score breakdown ──'); printScores(); }
    printDistribution(`Strategy: ${strat.toUpperCase()}`, distribution(RUNS), RUNS);
  }

  // ── Adaptation: the favored model under 'balanced' suddenly starts failing ──
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  ADAPTATION  —  inject a failure burst into the top model');
  console.log('══════════════════════════════════════════════════════════════');
  setRoutingStrategy('balanced');
  refreshStatsCache(getDb(), true);
  const before = distribution(RUNS);
  printDistribution('Before (balanced, steady state)', before, RUNS);

  // Find the current favorite and slam it with fresh failures.
  const fav = [...before.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const favProfile = PROFILES.find(p => p.name === fav)!;
  const db = getDb();
  const insHist = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, 1, 'error', 0, 0, 1000, 'outage', NULL)
  `);
  for (let i = 0; i < 300; i++) insHist.run(favProfile.platform, favProfile.modelId);
  console.log(`\n  → Injected 300 fresh failures into "${fav}" (simulated outage)…`);
  refreshStatsCache(getDb(), true);
  printScores();
  printDistribution('After (balanced, post-outage)', distribution(RUNS), RUNS);
  console.log('');
}

main();
