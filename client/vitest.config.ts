import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Client test harness — bootstrapped Week 28 (t_d98f3679).
// jsdom env because components touch localStorage / matchMedia / fetch.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Mirrors the vite.config.ts define so components reading __SERVER_PORT__
  // (api-usage, KeysPage, ModelDetailPage) resolve it under vitest too.
  define: {
    __SERVER_PORT__: JSON.stringify('3001'),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // jsdom only wires up window.localStorage when a document URL is set.
    testEnvironmentOptions: { url: 'http://localhost/' },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/vitest.d.ts',
        'src/i18n/**',
        // Build/tooling output — not testable app source. Excluding keeps the
        // headline number an honest measure of src/ coverage.
        'dev/**',
        'dist/**',
        '*.config.{js,ts}',
        'eslint.config.js',
        'scripts/**',
      ],
    },
  },
})
