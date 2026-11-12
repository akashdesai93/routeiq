import { describe, expect, it } from 'vitest'
import type { RouteIQNativePlugin } from '../src/device/native/plugin.ts'
import { nativeScreen } from '../src/device/native/screen.ts'
import type { PageVisibility } from '../src/device/visibility.ts'

// When the iPhone shell counts its screen as unseen, so nothing is drawn (#98). Being
// wrong one way wastes battery; the other way leaves a stale screen in front of the driver.

function fakes() {
  const appState = new Set<(change: { state?: string }) => void>()
  const plugin = {
    addListener: (event: string, listener: (change: { state?: string }) => void) => {
      if (event === 'appState') appState.add(listener)
      return Promise.resolve({ remove: async () => void appState.delete(listener) })
    },
  } as unknown as RouteIQNativePlugin
  let pageHidden = false
  const pageListeners = new Set<(hidden: boolean) => void>()
  const page: PageVisibility = {
    isHidden: () => pageHidden,
    subscribe: (l) => {
      pageListeners.add(l)
      return () => pageListeners.delete(l)
    },
  }
  return {
    plugin,
    page,
    app: (state: string) => [...appState].forEach((l) => l({ state })),
    setPage: (hidden: boolean) => {
      pageHidden = hidden
      pageListeners.forEach((l) => l(hidden))
    },
    appListeners: () => appState.size,
  }
}

describe('nativeScreen: whether the shell draws', () => {
  it('is hidden in the background (locked, or another app in front) and seen again when active', () => {
    const f = fakes()
    const screen = nativeScreen(f.plugin, f.page)
    const told: boolean[] = []
    screen.subscribe((hidden) => told.push(hidden))
    f.app('inactive')
    expect(screen.isHidden()).toBe(false)
    f.app('background')
    expect(screen.isHidden()).toBe(true)
    f.app('active')
    expect(screen.isHidden()).toBe(false)
    expect(told).toEqual([true, false])
  })

  it('is hidden when only the web view says so, and seen only when neither says hidden', () => {
    const f = fakes()
    const screen = nativeScreen(f.plugin, f.page)
    const told: boolean[] = []
    screen.subscribe((hidden) => told.push(hidden))
    f.setPage(true)
    expect(screen.isHidden()).toBe(true)
    f.app('background')
    f.setPage(false)
    expect(screen.isHidden()).toBe(true)
    f.app('active')
    expect(screen.isHidden()).toBe(false)
    expect(told).toEqual([true, false])
  })

  it('lets go of the appState listener when the last subscriber stops', async () => {
    const f = fakes()
    const screen = nativeScreen(f.plugin, f.page)
    const stop = screen.subscribe(() => {})
    expect(f.appListeners()).toBe(1)
    stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.appListeners()).toBe(0)
  })
})
