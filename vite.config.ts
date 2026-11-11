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
  },
  build: {
    // Mapbox GL JS alone is about 1.5 MB minified, so the default 500 kB warning always fires.
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
