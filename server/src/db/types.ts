import pg from 'pg';

export interface DbStatement {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes: number };
}

export interface Db {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  transaction<F extends (...args: any[]) => unknown>(fn: F): F;
  pragma(source: string): unknown;
  query: pg.Pool['query'];
  readonly name?: string;
  readonly memory?: boolean;
  close?(): void;
}

export type DbFactory = (resolvedPath: string) => Db;
