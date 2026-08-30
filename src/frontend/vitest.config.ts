// Standalone vitest config so tests don't load vite.config.ts (whose React +
// Tailwind plugins are pointless for unit tests). Most tests are plain
// TypeScript and run in the default node environment — no jsdom.
//
// The exception is the chart-axis render test, which mounts a real recharts
// chart to prove the axis props actually reach recharts. That single file
// opts into jsdom with an `@vitest-environment jsdom` docblock, so we only pay
// for a DOM where one is genuinely needed.
//
// Two things about that jsdom dependency are deliberate and easy to undo by
// accident:
//
//   * It is declared in the *root* package.json, not this one. vitest itself
//     hoists to the root node_modules, and vitest resolves an environment
//     package relative to its own location — it never looks inside
//     client/node_modules. A client-level jsdom that npm chooses to nest
//     (which it does, depending on how the rest of the tree deduplicates)
//     makes the run die with "Cannot find package 'jsdom'".
//   * It is pinned to ^27. jsdom 28+ depends on undici, and undici 8 both
//     declares `engines: >=22.19.0` and calls worker_threads.markAsUncloneable
//     unguarded — a function Node 20 does not have. Since the repo supports
//     Node >=20.18 and CI runs the suite on Node 20, that combination fails
//     at import time with "webidl.util.markAsUncloneable is not a function".
//     jsdom 27 has no undici dependency at all.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // esbuild only reads the *nearest* tsconfig.json, and ours is a solution
  // file (`files: []` + project references), so `jsx: react-jsx` from
  // tsconfig.app.json never reaches it. Say it here instead.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
