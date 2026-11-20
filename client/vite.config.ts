import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'node:url'

const clientRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(clientRoot, '..'), '')
  const serverPort = env.PORT ?? process.env.PORT ?? 3001

  return {
    plugins: [react(), tailwindcss()],
    base: process.env.VITE_BASE ?? '/',
    envDir: path.resolve(clientRoot, '..'),
    define: {
      __SERVER_PORT__: JSON.stringify(String(serverPort)),
    },
    resolve: {
      alias: {
        '@': path.resolve(clientRoot, './src'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(clientRoot, 'index.html'),
          seez: path.resolve(clientRoot, 'seez.html'),
          seezAdmin: path.resolve(clientRoot, 'seez-admin.html'),
        },
      },
    },
    server: {
      proxy: {
        // Force IPv4 — on Windows + Node 17+, `localhost` resolves to ::1 first,
        // which can collide with wslrelay / Docker Desktop listeners on the same port.
        '/api': `http://127.0.0.1:${serverPort}`,
        '/v1': `http://127.0.0.1:${serverPort}`,
      },
    },
  }
})
