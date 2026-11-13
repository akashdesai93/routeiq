import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config.ts'

// The tap scenarios (#203) in WebKit, the engine closest to the iPhone's web view, at an
// iPhone's size with touch: every scenario tagged @tap, through the same offline harness as
// the Chromium run (e2e/harness.ts). `npm run e2e:webkit` runs it; CI runs it in its own job
// of e2e.yml, sharded with Playwright's --shard.
//
// Not "every scenario twice": the long drives prove the engine and the voice, which do not
// depend on the browser, and they are CPU-bound. What WebKit can get wrong is a tap that
// lands on the wrong element, a control covered by another, or a layout that hides one.

export default defineConfig({
  ...base,
  grep: /@tap/,
  outputDir: 'e2e-report/webkit/results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e-report/webkit/playwright', open: 'never' }],
    ['./e2e/summaryReporter.ts', { outputFile: 'e2e-report/webkit/index.html' }],
  ],
  projects: [
    {
      name: 'webkit-iphone',
      // iPhone 15: 393 x 659 CSS pixels in Safari's window, touch, the iPhone's WebKit.
      // No service worker: in WebKit, Playwright's router never sees what the app's offline
      // worker (src/device/offline.ts) fetches, so those requests went to the real Mapbox (and
      // came back 401 for the dummy token). The iPhone shell has no service worker either.
      // The harness fails any response that did not come through its router (e2e/harness.ts).
      use: { ...base.use, ...devices['iPhone 15'], locale: 'en-US', timezoneId: 'America/New_York', serviceWorkers: 'block' },
    },
  ],
})
