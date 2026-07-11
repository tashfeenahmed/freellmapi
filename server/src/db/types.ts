export interface DbStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes: number };
}

export interface Db {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  // Mirrors better-sqlite3's pattern: transaction() wraps fn and returns a
  // callable with the same signature. The F extends constraint covers both
  // zero-arg transactions and the parameterised form used in routes/embeddings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<F extends (...args: any[]) => unknown>(fn: F): F;
  pragma(source: string): unknown;
  // Optional file metadata, populated when the backing store is better-sqlite3
  // (the default factory passes the raw handle through). Consumers that need a
  // filesystem location (e.g. the dev encryption-key file) must treat absence
  // as "no file backing" and fall back accordingly.
  readonly name?: string;
  readonly memory?: boolean;
}

/** Factory that opens (or creates) a database at the given resolved path and
 *  returns it as a Db. Pragmas and migrations are applied by the caller. */
export type DbFactory = (resolvedPath: string) => Db;
