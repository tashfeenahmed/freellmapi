import pg from 'pg';
import { execStatement } from './mock-sql.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PostgresDb {
  query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
  getClient(): Promise<pg.PoolClient>;
  transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isMock(): boolean;
}

/**
 * Parses DATABASE_URL or environment variables to configure the PostgreSQL pool.
 * Neon PostgreSQL requires SSL.
 */
export function createPostgresPool(connectionString?: string): pg.Pool {
  const url = connectionString || process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_DATABASE_URL;
  
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is required for PostgreSQL connection.\n' +
      'Example: postgresql://user:password@ep-sample.us-east-2.aws.neon.tech/neondb?sslmode=require'
    );
  }

  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  const needsSsl = !isLocal || url.includes('sslmode=require') || url.includes('neon.tech');

  const poolConfig: pg.PoolConfig = {
    connectionString: url,
    max: Number(process.env.PG_MAX_CONNECTIONS || 10), // Small pool for Render/Neon Free Tier
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };

  if (needsSsl) {
    poolConfig.ssl = {
      rejectUnauthorized: false,
    };
  }

  const createdPool = new Pool(poolConfig);
  const poolAny = createdPool as any;
  poolAny.prepare = (_sql: string) => ({
    get: () => undefined,
    all: () => [],
    run: () => ({ changes: 0, lastInsertRowid: 1 }),
  });
  poolAny.exec = () => {};
  poolAny.transaction = (fn: any) => fn;
  poolAny.pragma = () => [];
  return createdPool;
}

/**
 * Initializes the singleton Postgres pool.
 */
export function initPostgresPool(connectionString?: string): pg.Pool {
  if (pool) {
    return pool;
  }

  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  const useRealPg = Boolean(process.env.USE_REAL_POSTGRES);

  if (isTest && !useRealPg) {
    pool = createInMemoryMockPool() as any;
    return pool!;
  }

  pool = createPostgresPool(connectionString);
  return pool;
}

export function getPostgresPool(): pg.Pool {
  if (!pool) {
    return initPostgresPool();
  }
  return pool;
}

export async function closePostgresPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * In-memory mock pool for running unit tests without an active live Postgres daemon.
 */
function createInMemoryMockPool() {
  const tables = new Map<string, any[]>();
  
  // Initialize standard tables
  tables.set('providers', []);
  tables.set('credentials', []);
  tables.set('models', []);
  tables.set('routing_configuration', []);
  tables.set('analytics_hourly', []);
  tables.set('settings', []);
  tables.set('client_profiles', []);
  tables.set('playground_conversations', []);
  tables.set('migrations', []);
  tables.set('users', []);
  tables.set('sessions', []);
  tables.set('rate_limit_cooldowns', []);
  tables.set('rate_limit_usage', []);
  tables.set('media_models', []);
  tables.set('api_keys', []);
  tables.set('requests', []);
  // Tables restored by 006_compat_tables (see migrations/006_compat_tables.ts).
  tables.set('profiles', []);
  tables.set('profile_models', []);
  tables.set('fallback_config', []);
  tables.set('embedding_models', []);
  tables.set('custom_model_tombstones', []);
  tables.set('quirks', []);
  tables.set('quirk_targets', []);
  tables.set('provider_quota_observations', []);
  tables.set('provider_quota_state', []);
  tables.set('response_cache', []);
  tables.set('idempotency_claims', []);
  tables.set('server_logs', []);
  tables.set('backups', []);
  tables.set('url_tokens', []);

  let idCounter = 1;

  const mockQuery = async (text: string, params: any[] = []): Promise<QueryResult<any>> => {
    const trimmed = text.trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('SELECT 1')) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    if (upper.startsWith('BEGIN') || upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
      return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('CREATE TABLE') || upper.startsWith('CREATE INDEX') || upper.startsWith('ALTER TABLE')) {
      return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('SELECT')) {
      let tableName = 'providers';
      if (upper.includes('FROM MIGRATIONS')) tableName = 'migrations';
      else if (upper.includes('FROM USERS')) tableName = 'users';
      else if (upper.includes('FROM SESSIONS')) tableName = 'sessions';
      else if (upper.includes('FROM SETTINGS')) tableName = 'settings';
      else if (upper.includes('FROM CREDENTIALS')) tableName = 'credentials';
      else if (upper.includes('FROM MODELS')) tableName = 'models';
      else if (upper.includes('FROM ROUTING_CONFIGURATION')) tableName = 'routing_configuration';
      else if (upper.includes('FROM ANALYTICS_HOURLY')) tableName = 'analytics_hourly';
      else if (upper.includes('FROM CLIENT_PROFILES')) tableName = 'client_profiles';
      else if (upper.includes('FROM RATE_LIMIT_COOLDOWNS')) tableName = 'rate_limit_cooldowns';
      else if (upper.includes('FROM RATE_LIMIT_USAGE')) tableName = 'rate_limit_usage';

      const rows = tables.get(tableName) || [];

      // `userCount()` (auth service) asks for COUNT(*); the generic fallback
      // returns the raw rows, and `rows[0].c` would then read as 0 users
      // forever — which would let a declarative `admin` entry re-provision an
      // install that already has an account.
      if (tableName === 'users' && /COUNT\(\*\)\s+AS\s+C\b/i.test(trimmed)) {
        return { rows: [{ c: String(rows.length) }], rowCount: 1 };
      }

      if (upper.includes('FROM CREDENTIALS C') && upper.includes('JOIN PROVIDERS P')) {
        const creds = tables.get('credentials') || [];
        const provs = tables.get('providers') || [];
        const joined = creds
          .filter(c => c.enabled !== false && c.enabled !== 0)
          .map(c => {
            const p = provs.find(pr => Number(pr.id) === Number(c.provider_id));
            return { credential: c, provider: p };
          })
          .filter(j => j.provider != null);

        if (upper.includes('COUNT(*) AS ENABLED_KEYS')) {
          if (upper.includes('GROUP BY P.PROVIDER_KEY')) {
            const map = new Map<string, { platform: string; enabled_keys: number; healthy_keys: number; unknown_keys: number; invalid_keys: number; error_keys: number }>();
            for (const j of joined) {
              const platform = j.provider.provider_key;
              if (!map.has(platform)) {
                map.set(platform, { platform, enabled_keys: 0, healthy_keys: 0, unknown_keys: 0, invalid_keys: 0, error_keys: 0 });
              }
              const entry = map.get(platform)!;
              entry.enabled_keys += 1;
              if (!j.credential.last_health_error) {
                entry.healthy_keys += 1;
              } else {
                entry.invalid_keys += 1;
              }
            }
            return { rows: Array.from(map.values()), rowCount: map.size };
          }
          const healthy = joined.filter(j => !j.credential.last_health_error);
          return {
            rows: [{
              enabled_keys: joined.length,
              ready_upstreams: new Set(healthy.map(j => j.provider.provider_key)).size,
            }],
            rowCount: 1,
          };
        }
      }

      if (tableName === 'rate_limit_cooldowns' && upper.includes('WHERE PLATFORM =')) {
        const matched = rows.find(r => r.platform === params[0] && r.model_id === params[1] && Number(r.key_id) === Number(params[2]));
        return { rows: matched ? [matched] : [], rowCount: matched ? 1 : 0 };
      }

      if (tableName === 'requests' && upper.includes('GROUP BY PLATFORM, MODEL_ID')) {
        const reqs = tables.get('requests') || [];
        const map = new Map<string, any>();
        for (const r of reqs) {
          const key = `${r.platform}:${r.model_id}:${r.key_id ?? 1}`;
          if (!map.has(key)) {
            map.set(key, {
              platform: r.platform,
              model_id: r.model_id,
              key_id: r.key_id ?? 1,
              age_days: 0,
              total: 0,
              successes: 0,
              succ_out: 0,
              succ_lat: 0,
              succ_ttfb_sum: 0,
              succ_ttfb_cnt: 0,
              timeouts: 0,
              timeout_lat: 0,
            });
          }
          const entry = map.get(key)!;
          entry.total += 1;
          if (r.status === 'success') {
            entry.successes += 1;
            entry.succ_out += (r.output_tokens ?? 0);
            entry.succ_lat += (r.latency_ms ?? 0);
            if (r.ttfb_ms != null) {
              entry.succ_ttfb_sum += r.ttfb_ms;
              entry.succ_ttfb_cnt += 1;
            }
          }
        }
        return { rows: Array.from(map.values()), rowCount: map.size };
      }

      if (upper.includes('COUNT(')) {
        return { rows: [{ count: String(rows.length), c: String(rows.length) }], rowCount: 1 };
      }

      if (tableName === 'models') {
        let matched = [...rows];
        if (upper.includes('WHERE PLATFORM =') && upper.includes('MODEL_ID =')) {
          matched = matched.filter(r => (r.platform === params[0] || Number(r.provider_id) === Number(params[0])) && r.model_id === params[1]);
          return { rows: matched, rowCount: matched.length };
        }
        if (upper.includes('WHERE MODEL_ID =')) {
          const val = params[0];
          matched = matched.filter(r => r.model_id === val);
          return { rows: matched, rowCount: matched.length };
        }
      }

      if (tableName === 'providers' && upper.includes('WHERE PROVIDER_KEY =')) {
        const keyVal = params.length > 0 ? params[0] : upper.match(/WHERE PROVIDER_KEY\s*=\s*'([^']+)'/i)?.[1]?.toLowerCase();
        const matched = rows.filter(r => r.provider_key?.toLowerCase() === keyVal);
        return { rows: matched, rowCount: matched.length };
      }
      if (upper.includes('WHERE ID = $1')) {
        const matched = rows.filter(r => Number(r.id) === Number(params[0]));
        return { rows: matched, rowCount: matched.length };
      }
      if (tableName === 'users' && upper.includes('WHERE EMAIL = $1')) {
        const matched = rows.filter(r => r.email === params[0]);
        return { rows: matched, rowCount: matched.length };
      }
      if (tableName === 'sessions' && upper.includes('WHERE TOKEN_HASH = $1')) {
        const matched = rows.filter(r => r.token_hash === params[0]);
        return { rows: matched, rowCount: matched.length };
      }
      if (tableName === 'settings' && upper.includes('WHERE KEY = $1')) {
        const matched = rows.filter(r => r.key === params[0]);
        return { rows: matched, rowCount: matched.length };
      }

      return { rows: [...rows], rowCount: rows.length };
    }

    if (upper.startsWith('INSERT INTO SETTINGS')) {
      const rows = tables.get('settings') || [];
      let key = params[0];
      let value = params[1];
      if (upper.includes("'UNIFIED_API_KEY'")) {
        key = 'unified_api_key';
        value = params[0];
      }
      const existing = rows.find(r => r.key === key);
      if (existing) {
        existing.value = value;
        existing.updated_at = new Date().toISOString();
      } else {
        rows.push({ key, value, updated_at: new Date().toISOString() });
      }
      tables.set('settings', rows);
      return { rows: [], rowCount: 1 };
    }

    if (upper.startsWith('INSERT INTO')) {
      const match = trimmed.match(/INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (match) {
        const tableName = match[1].toLowerCase();
        const cols = match[2].split(',').map(c => c.trim().toLowerCase());
        const vals = match[3].split(',').map(v => v.trim());
        const rows = tables.get(tableName) || [];
        const record: any = { id: idCounter++, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), applied_at: new Date().toISOString() };

        cols.forEach((col, i) => {
          const valExpr = vals[i];
          if (valExpr && valExpr.startsWith('$')) {
            const paramIdx = parseInt(valExpr.substring(1), 10) - 1;
            record[col] = params[paramIdx];
          } else if (valExpr && (valExpr.startsWith("'") || valExpr.startsWith('"'))) {
            record[col] = valExpr.slice(1, -1);
          } else if (valExpr === 'true' || valExpr === 'TRUE') {
            record[col] = true;
          } else if (valExpr === 'false' || valExpr === 'FALSE') {
            record[col] = false;
          } else if (valExpr && !isNaN(Number(valExpr))) {
            record[col] = Number(valExpr);
          } else {
            record[col] = params[i];
          }
        });
        if (record.enabled === undefined) record.enabled = true;
        // The real schema makes `users.email` unique; without the same refusal
        // here a duplicate dashboard account would silently be created in tests.
        if (tableName === 'users' && rows.some(r => r.email === record.email)) {
          const dup: any = new Error('duplicate key value violates unique constraint "users_email_key"');
          dup.code = '23505';
          throw dup;
        }
        rows.push(record);
        tables.set(tableName, rows);
        return { rows: [record], rowCount: 1 };
      }
    }

    if (upper.startsWith('UPDATE CREDENTIALS')) {
      const rows = tables.get('credentials') || [];
      const idParam = params[params.length - 1];
      const row = rows.find(r => Number(r.id) === Number(idParam));
      if (row) {
        row.encrypted_value = params[0];
        row.encrypted_key = params[0];
        row.iv = params[1];
        row.auth_tag = params[2];
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('UPDATE MODELS')) {
      const idParam = params[params.length - 1];
      const rows = tables.get('models') || [];
      const row = rows.find(r => Number(r.id) === Number(idParam));
      if (row) {
        if (upper.includes('DISPLAY_NAME')) {
          row.display_name = params[0];
        }
        if (upper.includes('SUPPORTS_TOOLS')) {
          const idx = upper.includes('DISPLAY_NAME') ? 1 : 0;
          row.supports_tools = params[idx] === true;
        }
        if (upper.includes('CONTEXT_WINDOW')) {
          const idx = params.length - 2;
          row.context_window = params[idx];
        }
        if (upper.includes('ENABLED')) {
          row.enabled = params[0] === true;
        }
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('UPDATE')) {
      return { rows: [], rowCount: 1 };
    }

    if (upper.startsWith('DELETE FROM MODELS')) {
      const rows = tables.get('models') || [];
      if (params.length > 0) {
        const id = params[0];
        const filtered = rows.filter(r => Number(r.id) !== Number(id));
        tables.set('models', filtered);
        return { rows: [], rowCount: rows.length - filtered.length };
      }
      tables.set('models', []);
      return { rows: [], rowCount: rows.length };
    }

    if (upper.startsWith('DELETE FROM CREDENTIALS')) {
      const rows = tables.get('credentials') || [];
      tables.set('credentials', []);
      return { rows: [], rowCount: rows.length };
    }

    if (upper.startsWith('DELETE FROM PROVIDERS')) {
      const rows = tables.get('providers') || [];
      tables.set('providers', []);
      return { rows: [], rowCount: rows.length };
    }

    if (upper.startsWith('DELETE')) {
      const generic = execStatement(tables, trimmed, params, nextId);
      return { rows: generic?.rows ?? [], rowCount: generic?.changes ?? 1 };
    }

    // Anything the hand-written branches above do not recognise: hand it to the
    // small SQL engine, which covers the tables restored by 006_compat_tables
    // and anything else the code writes with plain statements. Without this the
    // mock answered "no rows" for every table the migration had not recreated,
    // which is how those code paths stayed broken and unnoticed.
    const generic = execStatement(tables, trimmed, params, nextId);
    if (generic) return { rows: generic.rows ?? [], rowCount: generic.changes || generic.rows?.length || 0 };

    return { rows: [], rowCount: 0 };
  };

  const nextId = () => idCounter++;

  return {
    query: mockQuery,
    connect: async () => ({
      query: mockQuery,
      release: () => {},
    }),
    on: () => {},
    end: async () => {},
    prepare: (sql: string) => ({
      get: (...args: any[]) => {
        const u = sql.toUpperCase();
        if (u.includes('FROM RATE_LIMIT_COOLDOWNS')) {
          const rows = tables.get('rate_limit_cooldowns') || [];
          return rows.find(r => r.platform === args[0] && r.model_id === args[1] && Number(r.key_id) === Number(args[2]));
        }
        if (u.includes('FROM MODELS')) {
          const rows = tables.get('models') || [];
          if (u.includes('WHERE PLATFORM = ? AND MODEL_ID = ?') || u.includes('WHERE PLATFORM =') && u.includes('MODEL_ID =')) {
            const pKey = args[0];
            const mId = args[1];
            return rows.find(r => (r.platform === pKey || Number(r.provider_id) === Number(pKey)) && r.model_id === mId);
          }
          if (u.includes('WHERE MODEL_ID = ?')) {
            const mId = args[0];
            return rows.find(r => r.model_id === mId);
          }
          return rows[0];
        }
        if (u.includes('FROM CLIENT_PROFILES')) {
          const rows = tables.get('client_profiles') || [];
          if (u.includes('TOKEN_HASH = ?')) {
            return rows.find(r => r.token_hash === args[0]);
          }
          return rows[0];
        }
        if (u.includes('FROM SETTINGS')) {
          const rows = tables.get('settings') || [];
          if (u.includes('KEY = ?')) {
            return rows.find(r => r.key === args[0]);
          }
          return rows[0];
        }
        if (u.includes('FROM API_KEYS')) {
          const rows = tables.get('api_keys') || [];
          if (u.includes('WHERE ID = ?')) {
            return rows.find(r => Number(r.id) === Number(args[0]));
          }
          if (u.includes('WHERE PLATFORM = ?')) {
            return rows.find(r => r.platform === args[0] && r.enabled !== 0 && r.enabled !== false);
          }
          return rows[0];
        }
        if (u.includes('FROM REQUESTS')) {
          const rows = tables.get('requests') || [];
          return rows[rows.length - 1];
        }
        // Not one of the hand-written shapes above: run it for real. This is
        // what makes the tables restored by 006_compat_tables usable in tests
        // instead of silently answering "no rows".
        const generic = execStatement(tables, sql, args, nextId);
        if (generic) return generic.rows?.[0];
        return undefined;
      },
      all: (...args: any[]) => {
        const u = sql.toUpperCase();
        const argList = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        if (u.includes('FROM CLIENT_PROFILES')) {
          return tables.get('client_profiles') || [];
        }
        if (u.includes('FROM SETTINGS')) {
          return tables.get('settings') || [];
        }
        if (u.includes('FROM MEDIA_MODELS')) {
          const rows = tables.get('media_models') || [];
          if (u.includes('WHERE MODALITY = ? AND ENABLED = 1')) {
            const mod = argList[0];
            return rows
              .filter(r => r.modality === mod && (r.enabled === 1 || r.enabled === true))
              .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id - b.id);
          }
          return rows;
        }
        if (u.includes('FROM REQUESTS')) {
          const reqs = tables.get('requests') || [];
          const map = new Map<string, any>();
          for (const r of reqs) {
            const key = `${r.platform}:${r.model_id}:${r.key_id ?? 1}:0`;
            if (!map.has(key)) {
              map.set(key, {
                platform: r.platform,
                model_id: r.model_id,
                key_id: r.key_id ?? 1,
                age_days: 0,
                total: 0,
                successes: 0,
                succ_out: 0,
                succ_lat: 0,
                succ_ttfb_sum: 0,
                succ_ttfb_cnt: 0,
                timeouts: 0,
                timeout_lat: 0,
              });
            }
            const entry = map.get(key)!;
            entry.total += 1;
            if (r.status === 'success') {
              entry.successes += 1;
              entry.succ_out += (r.output_tokens ?? 0);
              entry.succ_lat += (r.latency_ms ?? 0);
              if (r.ttfb_ms != null) {
                entry.succ_ttfb_sum += r.ttfb_ms;
                entry.succ_ttfb_cnt += 1;
              }
            }
          }
          return Array.from(map.values());
        }
        // Not one of the hand-written shapes above: run it for real, so the
        // tables restored by 006_compat_tables actually return their rows.
        const generic = execStatement(tables, sql, argList, nextId);
        if (generic) return generic.rows ?? [];
        return [];
      },
      run: (...args: any[]) => {
        const u = sql.toUpperCase();
        if (u.includes('INSERT INTO CLIENT_PROFILES')) {
          const rows = tables.get('client_profiles') || [];
          const record = {
            id: idCounter++,
            name: args[0],
            token_hash: args[1],
            encrypted_key: args[2],
            iv: args[3],
            auth_tag: args[4],
            system_prompt: args[5] || null,
            enabled: args[6] !== false && args[6] !== 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          rows.push(record);
          tables.set('client_profiles', rows);
          return { changes: 1, lastInsertRowid: record.id };
        }
        if (u.includes('INSERT INTO API_KEYS')) {
          const apiKeys = tables.get('api_keys') || [];
          const creds = tables.get('credentials') || [];
          const provs = tables.get('providers') || [];

          const platform = u.includes("VALUES ('CUSTOM'") ? 'custom' : args[0];
          let prov = provs.find(p => p.provider_key === platform);
          if (!prov) {
            prov = { id: idCounter++, provider_key: platform, display_name: platform, enabled: true };
            provs.push(prov);
          }

          const encKey = u.includes("VALUES ('CUSTOM'") ? args[0] : (args[2] ?? args[1] ?? 'enc');
          const iv = u.includes("VALUES ('CUSTOM'") ? args[1] : (args[3] ?? args[2] ?? 'iv');
          const authTag = u.includes("VALUES ('CUSTOM'") ? args[2] : (args[4] ?? args[3] ?? 'tag');
          const statusVal = u.includes("VALUES ('CUSTOM'") ? 'unknown' : (args[5] ?? 'healthy');
          const enabledVal = u.includes("VALUES ('CUSTOM'") ? true : (args[6] !== 0 && args[6] !== false);

          const cred = {
            id: idCounter++,
            provider_id: prov.id,
            credential_name: args[1] || 'test',
            encrypted_value: encKey,
            encrypted_key: encKey,
            iv,
            auth_tag: authTag,
            circuit_state: statusVal === 'invalid' ? 'DISABLED' : 'HEALTHY',
            enabled: enabledVal && statusVal !== 'invalid',
            last_health_error: statusVal === 'invalid' ? 'Invalid credential' : null,
          };
          creds.push(cred);

          const apiKeyRecord = {
            id: cred.id,
            platform,
            label: u.includes("VALUES ('CUSTOM'") ? 'Local STT' : (args[1] || 'test'),
            encrypted_key: encKey,
            iv,
            auth_tag: authTag,
            status: statusVal,
            enabled: enabledVal ? 1 : 0,
            base_url: u.includes("VALUES ('CUSTOM'") ? args[3] : (args[7] ?? null),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          apiKeys.push(apiKeyRecord);

          tables.set('api_keys', apiKeys);
          tables.set('credentials', creds);
          tables.set('providers', provs);
          return { changes: 1, lastInsertRowid: cred.id };
        }
        if (u.includes('INSERT INTO MEDIA_MODELS')) {
          const rows = tables.get('media_models') || [];
          const record: any = {
            id: idCounter++,
            platform: 'groq',
            model_id: '',
            display_name: '',
            modality: 'transcription',
            priority: 0,
            enabled: 1,
            quota_label: '',
            meta_json: null,
            key_id: null,
          };
          if (u.includes("VALUES ('CUSTOM'") || u.includes("VALUES ('CUSTOM,")) {
            record.platform = 'custom';
            record.model_id = args[0];
            record.display_name = 'Local Whisper';
            record.modality = 'transcription';
            record.priority = 99;
            record.enabled = 1;
            record.quota_label = 'custom endpoint';
            record.key_id = args[1];
          } else if (u.includes("'TRANSCRIPTION'")) {
            record.platform = args[0];
            record.model_id = args[1];
            record.display_name = args[2];
            record.modality = 'transcription';
            record.priority = args[3] ?? 0;
            record.enabled = 1;
            record.quota_label = '';
            record.meta_json = args[4] ?? null;
          }
          rows.push(record);
          tables.set('media_models', rows);
          return { changes: 1, lastInsertRowid: record.id };
        }
        if (u.includes('INSERT INTO REQUESTS')) {
          const rows = tables.get('requests') || [];
          const isHistorySeed = u.includes('TTFB_MS') && !u.includes('REQUEST_TYPE');
          const record = {
            id: idCounter++,
            platform: args[0],
            model_id: args[1],
            key_id: isHistorySeed ? 1 : args[2],
            status: isHistorySeed ? args[2] : args[3],
            input_tokens: 0,
            output_tokens: isHistorySeed ? args[3] : 0,
            latency_ms: isHistorySeed ? args[4] : args[4],
            error: isHistorySeed ? args[5] : args[5],
            ttfb_ms: isHistorySeed ? args[6] : null,
            request_type: isHistorySeed ? 'chat' : (args[6] ?? 'chat'),
            created_at: isHistorySeed ? new Date(Date.now() - 2 * 3600 * 1000).toISOString() : new Date().toISOString(),
          };
          rows.push(record);
          tables.set('requests', rows);
          return { changes: 1, lastInsertRowid: record.id };
        }
        if (u.includes('INSERT INTO MODELS')) {
          const rows = tables.get('models') || [];
          const provs = tables.get('providers') || [];
          const platform = args[0];
          let prov = provs.find(p => p.provider_key === platform);
          if (!prov) {
            prov = { id: idCounter++, provider_key: platform, display_name: platform, enabled: true };
            provs.push(prov);
          }
          const record = {
            id: idCounter++,
            platform: args[0],
            provider_id: prov.id,
            model_id: args[1],
            canonical_name: args[1],
            display_name: args[2],
            intelligence_rank: args[3] ?? 1,
            speed_rank: args[4] ?? 1,
            enabled: true,
            supports_streaming: true,
            supports_tools: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          rows.push(record);
          tables.set('models', rows);
          tables.set('providers', provs);
          return { changes: 1, lastInsertRowid: record.id };
        }
        // Auth tables: test setup clears them between cases. Sessions go first
        // so a stale token can never outlive the account it belonged to.
        if (u.includes('DELETE FROM SESSIONS')) {
          const rows = tables.get('sessions') || [];
          tables.set('sessions', []);
          return { changes: rows.length, lastInsertRowid: 0 };
        }
        if (u.includes('DELETE FROM USERS')) {
          const rows = tables.get('users') || [];
          tables.set('users', []);
          return { changes: rows.length, lastInsertRowid: 0 };
        }
        if (u.includes('DELETE FROM API_KEYS')) {
          const rows = tables.get('api_keys') || [];
          tables.set('api_keys', []);
          tables.set('credentials', []);
          return { changes: rows.length, lastInsertRowid: 0 };
        }
        if (u.includes('DELETE FROM MEDIA_MODELS')) {
          const rows = tables.get('media_models') || [];
          if (u.includes("WHERE MODALITY = 'TRANSCRIPTION'")) {
            const filtered = rows.filter(r => r.modality !== 'transcription');
            tables.set('media_models', filtered);
            return { changes: rows.length - filtered.length, lastInsertRowid: 0 };
          }
          if (u.includes("WHERE PLATFORM IN")) {
            const filtered = rows.filter(r => r.platform !== 'groq' && r.platform !== 'cloudflare');
            tables.set('media_models', filtered);
            return { changes: rows.length - filtered.length, lastInsertRowid: 0 };
          }
          tables.set('media_models', []);
          return { changes: rows.length, lastInsertRowid: 0 };
        }
        if (u.includes('UPDATE MEDIA_MODELS SET ENABLED = 0')) {
          const rows = tables.get('media_models') || [];
          for (const r of rows) {
            if (args[0] && r.model_id === args[0]) r.enabled = 0;
            else if (r.model_id && u.includes(`MODEL_ID = '${r.model_id.toUpperCase()}'`)) r.enabled = 0;
          }
          return { changes: 1, lastInsertRowid: 0 };
        }
        if (u.includes('UPDATE API_KEYS SET BASE_URL = NULL')) {
          const rows = tables.get('api_keys') || [];
          const row = rows.find(r => Number(r.id) === Number(args[0]));
          if (row) row.base_url = null;
          return { changes: 1, lastInsertRowid: 0 };
        }
        // Not one of the hand-written shapes above: execute it for real, so the
        // writes against the tables restored by 006_compat_tables (and any
        // other plain INSERT/UPDATE/DELETE) take effect in tests.
        const generic = execStatement(tables, sql, args, nextId);
        if (generic) return { changes: generic.changes, lastInsertRowid: generic.lastInsertRowid };
        return { changes: 1, lastInsertRowid: 1 };
      },
    }),
    exec: () => {},
    transaction: (fn: any) => fn,
    pragma: () => [],
    _mockTables: tables,
  };
}
