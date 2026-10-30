import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Same `@` → src alias as vite.config.ts.
  resolve: {
    alias: { '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src') },
  },
  // tsconfig.json is a solution file, so say the JSX mode here.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Same memory Storage shim as the dashboard (see the file).
    setupFiles: ['./vitest.setup-storage.ts'],
  },
})
