import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

// Design screenshots (npm run design:shots): every screen and state of the app at
// iPhone sizes, through the same offline harness as the e2e scenarios
// (e2e/harness.ts: made-up roads, stubbed GPS, voice and clock, no network).
// Not part of `npm run e2e` or CI: it asserts nothing and only writes pictures to
// design-shots/<size>/ for a design review (.claude/skills/ux-review).

const phone = { isMobile: true, hasTouch: true, deviceScaleFactor: Number(process.env.SHOTS_SCALE ?? 2) }

export default defineConfig({
  ...base,
  testMatch: '**/*.shots.ts',
  outputDir: 'design-shots/results',
  reporter: [['list']],
  use: { ...base.use, video: 'off', trace: 'off' },
  projects: [
    { name: 'iphone-390', use: { ...phone, viewport: { width: 390, height: 844 } } },
    { name: 'iphone-430', use: { ...phone, viewport: { width: 430, height: 932 } } },
    { name: 'landscape-844', use: { ...phone, viewport: { width: 844, height: 390 } } },
  ],
})
