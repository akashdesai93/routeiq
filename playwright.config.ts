import { defineConfig, devices } from '@playwright/test'
import { APP_PORT, NO_TOKEN_PORT } from './e2e/ports.ts'

// End-to-end scenarios: the production build in headless Chromium (and a small
// WebKit smoke set, see the projects below), fully
// offline (see e2e/harness.ts). `npm run e2e` builds and runs them.
// Each checkout serves the test builds on its own pair of ports (e2e/ports.ts),
// so parallel runs in other worktrees and the dev server on 5173 never collide.

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e-report/results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 3 : undefined,
  timeout: 240_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e-report/playwright', open: 'never' }],
    ['./e2e/summaryReporter.ts', { outputFile: 'e2e-report/index.html' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${APP_PORT}`,
    viewport: { width: 1280, height: 800 },
    video: 'on',
    trace: 'retain-on-failure',
    // Same answers everywhere: US English, Eastern time.
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
  projects: [
    // The whole suite, in Chromium.
    { name: 'chromium', testIgnore: '**/webkit.smoke.spec.ts' },
    // A small smoke set in WebKit, the engine of the iPhone app's web view, at an iPhone's
    // size with touch (#136). Kept small on purpose: CI runs a second browser for it.
    {
      name: 'webkit-iphone',
      testMatch: '**/webkit.smoke.spec.ts',
      // Service workers blocked: in WebKit a page a service worker controls (the offline app
      // shell, #184) fetches round Playwright's routing, so requests would reach the real
      // network. The harness fails any request it never saw (App.unrouted). The offline
      // shell has its own scenario in Chromium (e2e/offline.spec.ts).
      use: { ...devices['iPhone 14'], locale: 'en-US', timezoneId: 'America/New_York', serviceWorkers: 'block' },
    },
  ],
  webServer: [
    {
      command: `npx vite preview --outDir dist-e2e --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite preview --outDir dist-e2e-notoken --port ${NO_TOKEN_PORT} --strictPort`,
      url: `http://localhost:${NO_TOKEN_PORT}`,
      reuseExistingServer: false,
    },
  ],
})
