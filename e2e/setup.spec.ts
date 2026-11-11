import { expect, test } from './harness.ts'
import { NO_TOKEN_PORT } from './ports.ts'

// A token problem shows help with the fix, not a blank or broken map.

test('with no token, it shows setup help instead of a map', async ({ app, page }) => {
  // The second test build has no token at all.
  await app.open({ path: `http://localhost:${NO_TOKEN_PORT}/` })
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
  // Every route request would be refused the same way, so no drive can be started.
  await expect(page.getByRole('button', { name: 'Start drive' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Start simulated drive' })).toBeDisabled()
  // The help takes the map's place: the side panel stays at the right edge.
  const side = (await page.locator('.side').boundingBox())!
  expect(Math.round(side.x + side.width)).toBe(page.viewportSize()!.width)
  await app.snap('setup help: token rejected')
})
