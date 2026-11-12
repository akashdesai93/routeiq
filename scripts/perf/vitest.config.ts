// The render-count harness only (docs/performance.md): npx vitest run --config scripts/perf/vitest.config.ts
// Needs jsdom, which is not a dependency of the app: npm i --no-save jsdom
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react()],
  test: {
    include: ['scripts/perf/**/*.test.tsx'],
    environment: 'jsdom',
    testTimeout: 120_000,
  },
})
