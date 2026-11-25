import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The core also holds Node-only code (the optional Atomiq provider's file storage). The app
// never loads it, so its Node imports are pointed at an empty module for the bundler.
const stub = fileURLToPath(new URL('./src/stubs/node.ts', import.meta.url))

export default defineConfig({
  resolve: { alias: { 'node:fs/promises': stub, 'node:path': stub } },
  server: { port: 5173, strictPort: true },
  build: { target: 'es2023', chunkSizeWarningLimit: 2500 },
})
