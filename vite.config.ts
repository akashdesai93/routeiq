/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The path the site is served under. "/" for local dev, preview and e2e; the GitHub Pages
// workflow sets PAGES_BASE=/routeiq/ (the site lives at https://<owner>.github.io/routeiq/).
// Code that fetches the app's own files builds the URL from import.meta.env.BASE_URL.
const base = process.env.PAGES_BASE || '/'
if (!base.startsWith('/') || !base.endsWith('/')) {
  throw new Error(`PAGES_BASE must start and end with "/" (got "${base}")`)
}

// https://vite.dev/config/
export default defineConfig({
  base,
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
    // Mapbox GL JS in its own file (mapbox-gl-*.js), apart from the app's code: the two
    // change at different times, so the browser keeps the big one cached across app
    // releases, and scripts/check-bundle-size.mjs can hold the app's own code to a budget.
    // Only the three files Mapbox loads up front; the rest it still loads on demand.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'mapbox-gl', test: /mapbox-gl[\\/]dist[\\/]esm[\\/](mapbox-gl|core|shared)\.js$/ }],
        },
      },
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
