import { expect, test } from './harness.ts'

// A token problem shows help with the fix, not a blank or broken map.

test('with no token, it shows setup help instead of a map', async ({ app, page }) => {
  // The build on port 4318 has no token at all.
  await app.open({ path: 'http://localhost:4318/' })
  await expect(page.getByText('.env.local').first()).toBeVisible()
  await expect(page.locator('[data-testid="map"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start drive' })).toHaveCount(0)
  await app.snap('setup help: no token')
})

test('with a token Mapbox rejects, it says what to fix', async ({ app, page }) => {
  app.outside.mapboxStatus = 401
  await app.open()
  await expect(page.getByText('Mapbox rejected the token (401)').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Recommended')).toHaveCount(0)
  await app.snap('setup help: token rejected')
})
