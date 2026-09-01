// Bundles desktop/src/server-host.ts (and through it the whole server) into
// build/server.mjs. esbuild resolves the server's `.js`-suffixed TS imports
// and flattens the @freellmapi/shared workspace symlink — only better-sqlite3
// stays external (native module, electron-rebuilt in desktop/node_modules).
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const githubSha = process.env.GITHUB_SHA;
const hasBuildIdentity = /^[0-9a-f]{40}$/i.test(githubSha ?? '');

await build({
  entryPoints: [path.resolve(__dirname, '../src/server-host.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.resolve(__dirname, '../build/server.mjs'),
  external: ['better-sqlite3'],
  define: {
    'process.env.FREELLMAPI_COMMIT_SHA': JSON.stringify(hasBuildIdentity ? githubSha : ''),
    'process.env.FREELLMAPI_INSTALL_METHOD': JSON.stringify(hasBuildIdentity ? 'desktop' : ''),
  },
  // Some inlined CJS deps (express internals) reference `require` at runtime;
  // give the ESM bundle a working one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
