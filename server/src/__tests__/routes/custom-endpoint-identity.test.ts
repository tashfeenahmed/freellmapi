import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { routePinnedModel, routeRequest, resolveModelGroupCandidates, refreshStatsCache, getRoutingScores, writeObservedSpeedRanks, resetSpeedRankWriteback } from '../../services/router.js';
import { setCooldown, isOnCooldown, clearCooldownsForKey } from '../../services/ratelimit.js';
import { getModelGroups, resolveRequestedIdToMembers, setUnifyOverrides } from '../../services/model-groups.js';
import { noteModelRetirementSignal, resetModelRetirementObservations } from '../../services/model-retirement.js';
import { endpointHandle, qualifiedModelMemberId } from '../../lib/endpoint-scope.js';
import { logRequest } from '../../lib/request-log.js';
import { buildModelListing } from '../../services/model-listing.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Per-endpoint model identity (#651). Two relays that both offer
// `deepseek-v3.1` used to collapse into ONE models row: one enabled flag, one
// reliability/speed bucket. Relay A going bad took relay B's copy down with it
// (#619). These cases pin that the two copies are now genuinely separate — and,
// just as important, that an install with a SINGLE relay behaves exactly as
// before.

const RELAY_A = 'http://127.0.0.1:18091/v1';
const RELAY_B = 'http://127.0.0.1:18092/v1';
const SHARED_MODEL = 'deepseek-v3.1';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const post = (app: Express, path: string, body: unknown) => request(app, 'POST', path, body);
const get = (app: Express, path: string) => request(app, 'GET', path);
const patch = (app: Express, path: string, body: unknown) => request(app, 'PATCH', path, body);

interface Row { id: number; key_id: number | null; enabled: number; endpoint_scope: string; speed_rank: number }

function rowsFor(modelId: string): Row[] {
  return getDb().prepare(
    "SELECT id, key_id, enabled, endpoint_scope, speed_rank FROM models WHERE platform = 'custom' AND model_id = ? ORDER BY id",
  ).all(modelId) as Row[];
}

function rowOn(scope: string, modelId = SHARED_MODEL): Row {
  const row = rowsFor(modelId).find(r => r.endpoint_scope === scope);
  if (!row) throw new Error(`no ${modelId} row on ${scope}`);
  return row;
}

/** Log `n` requests against one model + key, so the stats cache has something to see. */
function logRequests(modelDbId: number, modelId: string, keyId: number, status: 'success' | 'error', n: number, latencyMs = 500) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO requests (platform, model_id, model_db_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
    VALUES ('custom', ?, ?, ?, ?, 100, 100, ?, ?, 'chat')
  `);
  for (let i = 0; i < n; i++) {
    stmt.run(modelId, modelDbId, keyId, status, latencyMs, status === 'error' ? 'upstream timeout' : null);
  }
}

async function registerBothRelays(app: Express) {
  await post(app, '/api/keys/custom', {
    baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a', label: 'Relay A',
  });
  await post(app, '/api/keys/custom', {
    baseUrl: RELAY_B, model: SHARED_MODEL, apiKey: 'key-b', label: 'Relay B',
  });
}

describe('per-endpoint identity for custom relay models (#651)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    resetModelRetirementObservations();
    resetSpeedRankWriteback();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  describe('separate rows', () => {
    it('gives each endpoint its own row for the same model id', async () => {
      await registerBothRelays(app);

      const rows = rowsFor(SHARED_MODEL);
      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.endpoint_scope)).toEqual([RELAY_A, RELAY_B]);
      // Each binds to its OWN endpoint's credential, not the last one added.
      expect(new Set(rows.map(r => r.key_id)).size).toBe(2);
    });

    it('re-registering on one endpoint updates that row only', async () => {
      await registerBothRelays(app);
      const before = rowsFor(SHARED_MODEL);

      await post(app, '/api/keys/custom', {
        baseUrl: RELAY_A, models: [{ model: SHARED_MODEL, displayName: 'DeepSeek via A' }],
      });

      const after = rowsFor(SHARED_MODEL);
      expect(after.map(r => r.id)).toEqual(before.map(r => r.id));
      const names = getDb().prepare(
        "SELECT endpoint_scope, display_name FROM models WHERE platform = 'custom' AND model_id = ? ORDER BY id",
      ).all(SHARED_MODEL) as { endpoint_scope: string; display_name: string }[];
      expect(names).toEqual([
        { endpoint_scope: RELAY_A, display_name: 'DeepSeek via A' },
        { endpoint_scope: RELAY_B, display_name: SHARED_MODEL },
      ]);
    });

    it('disables one endpoint\'s copy without touching the other', async () => {
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);

      expect((await patch(app, `/api/models/${a.id}`, { enabled: false })).status).toBe(200);

      expect(rowsFor(SHARED_MODEL).find(r => r.id === a.id)!.enabled).toBe(0);
      expect(rowsFor(SHARED_MODEL).find(r => r.id === b.id)!.enabled).toBe(1);
      // The still-good relay keeps serving.
      const route = routePinnedModel(b.id);
      expect(route).not.toBeNull();
      expect(route!.apiKey).toBe('key-b');
      route!.release?.();
      expect(routePinnedModel(a.id)).toBeNull();
    });

    it('deleting one endpoint\'s copy leaves the other registered', async () => {
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);

      expect((await request(app, 'DELETE', `/api/models/custom/${a.id}`)).status).toBe(200);

      const rows = rowsFor(SHARED_MODEL);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.endpoint_scope).toBe(RELAY_B);
    });
  });

  describe('independent stats and cooldowns', () => {
    it('does not let one relay\'s failures drag down the other\'s score', async () => {
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);

      logRequests(a.id, SHARED_MODEL, a.key_id!, 'error', 40);
      logRequests(b.id, SHARED_MODEL, b.key_id!, 'success', 40);
      refreshStatsCache(getDb(), true);

      const scores = getRoutingScores().scores;
      const scoreA = scores.find(s => s.modelDbId === a.id)!;
      const scoreB = scores.find(s => s.modelDbId === b.id)!;

      expect(scoreA.reliability).toBeLessThan(0.2);
      expect(scoreB.reliability).toBeGreaterThan(0.8);
      expect(scoreB.score).toBeGreaterThan(scoreA.score);
    });

    it('writes an observed speed rank per endpoint rather than one shared number', async () => {
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);

      // Relay A answers slowly, relay B quickly — same model id, same tokens.
      logRequests(a.id, SHARED_MODEL, a.key_id!, 'success', 40, 20_000);
      logRequests(b.id, SHARED_MODEL, b.key_id!, 'success', 40, 200);
      refreshStatsCache(getDb(), true);
      writeObservedSpeedRanks(getDb());

      const slow = rowsFor(SHARED_MODEL).find(r => r.id === a.id)!.speed_rank;
      const fast = rowsFor(SHARED_MODEL).find(r => r.id === b.id)!.speed_rank;
      expect(fast).toBeLessThan(slow);
    });

    it('keeps cooldowns per endpoint', async () => {
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);

      setCooldown('custom', SHARED_MODEL, a.key_id!, 60_000);

      expect(isOnCooldown('custom', SHARED_MODEL, a.key_id!)).toBe(true);
      expect(isOnCooldown('custom', SHARED_MODEL, b.key_id!)).toBe(false);
      expect(routePinnedModel(a.id)).toBeNull();
      const route = routePinnedModel(b.id);
      expect(route).not.toBeNull();
      route!.release?.();

      // The cooldown map is process-local and outlives the in-memory DB, so
      // hand it back before the next case reuses these key ids.
      clearCooldownsForKey(a.key_id!);
    });

    it('records the concrete model row selected for each relay', async () => {
      await registerBothRelays(app);
      const b = rowOn(RELAY_B);

      logRequest('custom', SHARED_MODEL, b.key_id!, 'success', 10, 20, 30, null);

      const logged = getDb().prepare(`
        SELECT model_db_id FROM requests
         WHERE platform = 'custom' AND model_id = ?
         ORDER BY id DESC LIMIT 1
      `).get(SHARED_MODEL) as { model_db_id: number };
      expect(logged.model_db_id).toBe(b.id);
    });

    it('counts an end-of-life signal against one endpoint only', async () => {
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);
      const eol = Object.assign(new Error('HTTP 404: model no longer available'), { status: 404 });

      // The route each relay hands to the failure path carries ITS endpoint, so
      // the retirement heuristic counts corroboration per relay instead of
      // pooling two unrelated relays' 404s into one verdict.
      const routeA = routePinnedModel(a.id)!;
      const routeB = routePinnedModel(b.id)!;
      expect(routeA.endpointScope).toBe(RELAY_A);
      expect(routeB.endpointScope).toBe(RELAY_B);
      routeA.release?.();
      routeB.release?.();

      // Two 'probable' signals are needed to act; feeding one to each endpoint
      // must not add up to a verdict against either. (User-added models are
      // never auto-retired anyway — that guard is asserted in
      // services/model-retirement.test.ts — so both stay on.)
      noteModelRetirementSignal(
        { modelDbId: a.id, platform: 'custom', modelId: SHARED_MODEL, endpointScope: routeA.endpointScope }, eol, {},
      );
      noteModelRetirementSignal(
        { modelDbId: b.id, platform: 'custom', modelId: SHARED_MODEL, endpointScope: routeB.endpointScope }, eol, {},
      );

      expect(rowsFor(SHARED_MODEL).map(r => r.enabled)).toEqual([1, 1]);
    });
  });

  describe('naming', () => {
    it('routes an endpoint-qualified id to that endpoint\'s row', async () => {
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);
      const groups = getModelGroups();

      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#${endpointHandle(RELAY_A)}`, groups))
        .toEqual([a.id]);
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#${endpointHandle(RELAY_B)}`, groups))
        .toEqual([b.id]);
      // The endpoint URL itself works too, for anyone pasting what they typed
      // into the dashboard.
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#${RELAY_B}`, groups)).toEqual([b.id]);
      // An endpoint that doesn't serve it is not a match.
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#nope.example.com`, groups)).toBeNull();
    });

    it('keeps a bare model id reaching BOTH relays after one is renamed', async () => {
      // Display name is presentation, not identity. Renaming relay A's copy
      // moves it into a different display-name group — that must not make it
      // (or its sibling) unreachable by the bare id every client already uses.
      await registerBothRelays(app);
      await post(app, '/api/keys/custom', {
        baseUrl: RELAY_A, models: [{ model: SHARED_MODEL, displayName: 'DeepSeek via A' }],
      });
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);

      const groups = getModelGroups();
      // Precondition: the rename really did split them across groups.
      expect(new Set(groups.filter(g => g.members.some(m => m.model_id === SHARED_MODEL))
        .map(g => g.groupKey)).size).toBe(2);

      expect(resolveRequestedIdToMembers(SHARED_MODEL, groups)?.sort())
        .toEqual([a.id, b.id].sort());
      // And the platform-qualified form still reaches both too.
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}`, groups)?.sort())
        .toEqual([a.id, b.id].sort());
    });

    it('routes a bare id to the renamed relay when the other one is cooled down', async () => {
      // The failover a bare id is supposed to give you, across a display-name
      // boundary: relay B is benched, so the request has to land on relay A.
      await registerBothRelays(app);
      await post(app, '/api/keys/custom', {
        baseUrl: RELAY_A, models: [{ model: SHARED_MODEL, displayName: 'DeepSeek via A' }],
      });
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);

      setCooldown('custom', SHARED_MODEL, b.key_id!, 60_000);
      try {
        const ids = resolveRequestedIdToMembers(SHARED_MODEL, getModelGroups())!;
        const route = routeRequest(1000, undefined, undefined, false, false, undefined,
          resolveModelGroupCandidates(ids));
        expect(route.modelDbId).toBe(a.id);
        route.release?.();
      } finally {
        clearCooldownsForKey(b.key_id!);
      }
    });

    it('splits only the named relay when a split override uses its qualified id', async () => {
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);
      const qualifiedA = qualifiedModelMemberId('custom', SHARED_MODEL, RELAY_A)!;

      setUnifyOverrides({ merges: [], splits: [{ member: qualifiedA }] });

      const groups = getModelGroups();
      const groupOf = (id: number) => groups.find(g => g.members.some(m => m.model_db_id === id))!;
      expect(groupOf(a.id).groupKey).not.toBe(groupOf(b.id).groupKey);
      expect(groupOf(a.id).members.map(m => m.model_db_id)).toEqual([a.id]);
      expect(groupOf(b.id).members.map(m => m.model_db_id)).toEqual([b.id]);

      // Splitting for display still must not shrink what the bare id reaches.
      expect(resolveRequestedIdToMembers(SHARED_MODEL, groups)?.sort())
        .toEqual([a.id, b.id].sort());
    });

    it('honours a split saved in the pre-#651 plain form', async () => {
      // Upgrading must not orphan an existing override: the stored key is the
      // unqualified member id, and nothing rewrites it on read.
      await registerBothRelays(app);
      const a = rowOn(RELAY_A);
      const b = rowOn(RELAY_B);

      setUnifyOverrides({ merges: [], splits: [{ member: `custom:${SHARED_MODEL}` }] });

      const groups = getModelGroups();
      // An unqualified key names BOTH relays, so they share one split group —
      // exactly what it meant before #651, left alone rather than reinterpreted.
      const groupOf = (id: number) => groups.find(g => g.members.some(m => m.model_db_id === id))!;
      expect(groupOf(a.id).groupKey).toBe(groupOf(b.id).groupKey);
      expect(groupOf(a.id).groupKey).toContain('__split__');
      expect(groupOf(a.id).members.map(m => m.model_db_id).sort()).toEqual([a.id, b.id].sort());

      // And the bare id still reaches both, so the split stays cosmetic.
      expect(resolveRequestedIdToMembers(SHARED_MODEL, groups)?.sort())
        .toEqual([a.id, b.id].sort());
    });

    it('keeps a bare model id working — it spans both relays', async () => {
      await registerBothRelays(app);
      const groups = getModelGroups();
      const ids = resolveRequestedIdToMembers(SHARED_MODEL, groups);
      expect(ids?.sort()).toEqual([rowOn(RELAY_A).id, rowOn(RELAY_B).id].sort());
    });

    it('advertises exactly one catalog entry for a duplicated model id', async () => {
      await registerBothRelays(app);
      // The public listing is still ONE logical model — clients that copied the
      // id keep working, and the two relays are its failover set.
      const listed = buildModelListing().models.filter(m => m.id === SHARED_MODEL);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.platforms).toEqual(['custom']);
    });

    it('leaves a single-endpoint install completely un-qualified', async () => {
      await post(app, '/api/keys/custom', {
        baseUrl: RELAY_A, model: 'solo-model', apiKey: 'key-a', label: 'Relay A',
      });
      const groups = getModelGroups();
      const soloId = rowsFor('solo-model')[0]!.id;

      // Bare id and the plain platform:model_id form both still resolve.
      expect(resolveRequestedIdToMembers('solo-model', groups)).toEqual([soloId]);
      expect(resolveRequestedIdToMembers('custom:solo-model', groups)).toEqual([soloId]);

      // And the dashboard is told there is nothing to disambiguate.
      const listed = (await get(app, '/api/models')).body as any[];
      const row = listed.find(m => m.modelId === 'solo-model');
      expect(row.qualifiedModelId).toBe(`custom:solo-model#${endpointHandle(RELAY_A)}`);
      const catalogRow = listed.find(m => m.platform !== 'custom');
      expect(catalogRow.endpointScope).toBeNull();
      expect(catalogRow.qualifiedModelId).toBeNull();
    });

    it('surfaces the endpoint on every duplicated row so the dashboard can label it', async () => {
      await registerBothRelays(app);
      const listed = (await get(app, '/api/fallback')).body as any[];
      const dupes = listed.filter(m => m.modelId === SHARED_MODEL);

      expect(dupes).toHaveLength(2);
      expect(dupes.map(d => d.endpointScope).sort()).toEqual([RELAY_A, RELAY_B]);
      expect(dupes.map(d => d.keyLabel).sort()).toEqual(['Relay A', 'Relay B']);
      expect(dupes.map(d => d.qualifiedModelId).sort()).toEqual([
        qualifiedModelMemberId('custom', SHARED_MODEL, RELAY_A),
        qualifiedModelMemberId('custom', SHARED_MODEL, RELAY_B),
      ].sort());
    });
  });
});
