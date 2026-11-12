// Merges the CI shards' blob reports into the same two reports a whole run writes
// (playwright.config.ts): e2e-report/index.html and e2e-report/playwright.
// Run from the repository root: `npx playwright merge-reports --config e2e/merge.config.ts blob-report`.
import { resolve } from 'node:path'

export default {
  testDir: '.',
  reporter: [
    ['html', { outputFolder: resolve('e2e-report/playwright'), open: 'never' }],
    ['./summaryReporter.ts', { outputFile: 'e2e-report/index.html' }],
  ],
}
