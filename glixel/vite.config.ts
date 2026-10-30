import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// GLIXEL is served by the FreeLLMAPI server at /glixel, so every built asset
// URL lives under that base. envDir stays at this folder (which has no .env):
// unlike the dashboard, nothing here reads the repository's root .env into the
// bundle. Only PORT is read from it, here in the config, to aim the dev proxy.
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), 'PORT')
  const serverPort = process.env.PORT ?? rootEnv.PORT ?? 3001

  return {
    plugins: [react(), tailwindcss()],
    base: '/glixel/',
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5174,
      proxy: {
        '/api': `http://127.0.0.1:${serverPort}`,
      },
    },
  }
})
