import { expect, INDIAN_LAND, test } from './harness.ts'

// Planning a trip: the first screen, search, and what the device remembers.

test('I open the app and get ranked routes with light counts and one Recommended', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  await app.snap('the test trip, planned')

  const routes = page.locator('ol.routes > li')
  await expect(routes).toHaveCount(3)
  await expect(page.getByText('Recommended')).toHaveCount(1)
  await expect(routes.first()).toContainText('Recommended')
  // Every route has a whole light count: a number, not "unknown", "partial" or a guess.
  for (const signals of await page.locator('.route-signals').allTextContents()) expect(signals).toMatch(/^\d+ signals?$/)
  // Ranked fastest first.
  const minutes = (await page.locator('.route-eta').allTextContents()).map((t) => Number.parseInt(t, 10))
  expect(minutes).toEqual([...minutes].sort((a, b) => a - b))
  expect(app.destinations()).toEqual([INDIAN_LAND])
})

test('I search for a place, pick it, and the routes go there', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const destination = page.getByRole('combobox', { name: 'Destination' })
  await destination.click()
  await destination.pressSequentially('Bank of Am')
  const suggestion = page.getByRole('option', { name: /Bank of America Stadium/ })
  await expect(suggestion).toBeVisible()
  await app.snap('suggestions while typing')
  await suggestion.click()
  await expect(destination).toHaveValue(/Bank of America Stadium/)
  await expect.poll(() => app.destinations().length).toBe(2)
  await app.routesReady()
  await app.snap('routes to the stadium')
  const [lng, lat] = app.destinations()[1]!
  // Within a few hundred meters of the stadium (the fixture's routable point), not the old destination.
  expect(Math.abs(lng - -80.8528)).toBeLessThan(0.005)
  expect(Math.abs(lat - 35.2258)).toBeLessThan(0.005)
})

test('saved places and the last trip survive a reload', async ({ app, page }) => {
  await app.open()
  await app.routesReady()
  const destination = page.getByRole('combobox', { name: 'Destination' })
  await destination.click()
  await destination.pressSequentially('Bank of Am')
  await page.getByRole('option', { name: /Bank of America Stadium/ }).click()
  await app.routesReady()
  await page.getByText('Recent and saved places').click()
  await page.getByRole('button', { name: 'Save as Home' }).click()
  await app.snap('the stadium saved as Home')

  await page.reload()
  await app.routesReady()
  await expect(page.getByRole('combobox', { name: 'Destination' })).toHaveValue(/Bank of America Stadium/)
  await expect(page.getByRole('group', { name: 'Go to a saved place' }).getByRole('button', { name: 'Home', exact: true })).toBeVisible()
  await page.getByText('Recent and saved places').click()
  await expect(page.getByRole('list', { name: 'Recent destinations' })).toContainText('Bank of America Stadium')
  await app.snap('after a reload: same trip, Home set, stadium in recents')
})
