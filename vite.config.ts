/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to localhost only, so the dev server is not reachable from your network.
    host: 'localhost',
    port: 5173,
    strictPort: true,
    // design/ is a separate project with its own dev server; don't watch it.
    watch: { ignored: ['**/design/**'] },
  },
  // Only scan the app's own page for dependencies, not design/index.html.
  optimizeDeps: { entries: ['index.html'] },
  build: {
    // Mapbox GL JS alone is about 1.5 MB minified, so the default 500 kB warning always fires.
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
