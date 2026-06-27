// Type surface of the esbuild-produced server bundle. At compile time TS
// resolves `./server.mjs` to this declaration; at runtime build/main.mjs
// resolves it to the sibling build/server.mjs (kept external in build:main).
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';

export interface StartOptions {
  dbPath: string;
  clientDist: string;
  host: string;
  preferredPort: number;
}

export interface ServerHandle {
  server: Server;
  port: number;
}

export function startServer(opts: StartOptions): Promise<ServerHandle>;
export function ensureSessionToken(): string;
export function getDb(): Database.Database;
export function getUnifiedApiKey(): string;
