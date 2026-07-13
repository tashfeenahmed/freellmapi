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
  test: {
    globals: true,
    environment: 'jsdom',
    // jsdom only wires up window.localStorage when a document URL is set.
    testEnvironmentOptions: { url: 'http://localhost/' },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
})
