import { defineConfig, devices } from '@playwright/test'

// End-to-end scenarios: the production build in headless Chromium, fully
// offline (see e2e/harness.ts). `npm run e2e` builds and runs them.
// Ports 4317 and 4318, so a dev server on 5173 is never in the way.

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
    baseURL: 'http://localhost:4317',
    viewport: { width: 1280, height: 800 },
    video: 'on',
    trace: 'retain-on-failure',
    // Same answers everywhere: US English, Eastern time.
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
  webServer: [
    {
      command: 'npx vite preview --outDir dist-e2e --port 4317 --strictPort',
      url: 'http://localhost:4317',
      reuseExistingServer: false,
    },
    {
      command: 'npx vite preview --outDir dist-e2e-notoken --port 4318 --strictPort',
      url: 'http://localhost:4318',
      reuseExistingServer: false,
    },
  ],
})
