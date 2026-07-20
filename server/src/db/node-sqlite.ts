import { createRequire } from 'node:module';
import type { Db, DbFactory, DbStatement } from './types.js';

const runtimeRequire = createRequire(import.meta.url);

type NodeSqliteRunResult = {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
};

type NodeSqliteStatement = {
  run(...params: unknown[]): NodeSqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type NodeSqliteDatabase = {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
};

type NodeSqliteModule = {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
};

function loadNodeSqlite(): NodeSqliteModule {
  try {
    return runtimeRequire('node:sqlite') as NodeSqliteModule;
  } catch (cause) {
    throw new Error(
      'Android/Termux requires Node.js 22.13 or newer for the built-in node:sqlite database driver.',
      { cause },
    );
  }
}

function numberResult(value: number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`SQLite returned an integer outside JavaScript's safe range: ${value}`);
  }
  return n;
}

function wrapStatement(statement: NodeSqliteStatement): DbStatement {
  return {
    get: (...params) => statement.get(...params),
    all: (...params) => statement.all(...params),
    run: (...params) => {
      const result = statement.run(...params);
      return {
        changes: numberResult(result.changes),
        lastInsertRowid: numberResult(result.lastInsertRowid),
      };
    },
  };
}

/**
 * `node:sqlite` adapter used on Android, where better-sqlite3 does not publish
 * prebuilt binaries. It exposes only the small synchronous database contract
 * the server uses and implements better-sqlite3-style nested transactions with
 * savepoints.
 */
export const nodeSqliteFactory: DbFactory = (resolvedPath) => {
  const { DatabaseSync } = loadNodeSqlite();
  const raw = new DatabaseSync(resolvedPath);
  let transactionDepth = 0;
  let savepointSequence = 0;

  const database: Db = {
    name: resolvedPath,
    memory: resolvedPath === ':memory:',
    prepare: (sql) => wrapStatement(raw.prepare(sql)),
    exec: (sql) => raw.exec(sql),
    pragma: (source) => raw.prepare(`PRAGMA ${source}`).all(),
    close: () => raw.close(),
    transaction: <F extends (...args: any[]) => unknown>(fn: F): F => {
      const wrapped = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
        const outermost = transactionDepth === 0;
        const savepoint = `freellmapi_tx_${++savepointSequence}`;

        raw.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        transactionDepth += 1;

        try {
          const result = fn.apply(this, args) as ReturnType<F>;
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new Error('SQLite transaction callbacks must be synchronous');
          }
          raw.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          try {
            if (outermost) {
              raw.exec('ROLLBACK');
            } else {
              raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
            }
          } catch {
            // Preserve the original callback/commit error.
          }
          throw error;
        } finally {
          transactionDepth -= 1;
        }
      };
      return wrapped as F;
    },
  };

  return database;
};
