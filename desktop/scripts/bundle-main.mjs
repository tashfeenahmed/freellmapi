import { build } from 'esbuild';

// The CLI's configuration writers use YAML, whose Node entry includes CJS
// dependencies. Give the bundled desktop ESM entry a real Node require.
await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'],
  external: ['electron', 'electron-updater', './server.mjs'], outfile: 'build/main.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
