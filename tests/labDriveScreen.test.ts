import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkDrawnWithin, DEFAULT_LAB_CHECKS, firstDrawn } from '../scripts/phone/lab/assertions.mjs'
import { BACKGROUND_APP, DEFAULT_LAB_LAUNCH, startsFromBackground } from '../scripts/phone/lab/launch.mjs'
import { readPlan } from '../scripts/phone/lab/queue.mjs'
import { createDriveDiagnostics } from '../src/device/native/diagnostics.ts'
import { LAB_REPORT_MS, startLab, type LabDocument } from '../src/lab/lab.ts'

// #136: the driving screen was black on the iPhone in the phone lab. The phone lab found the
// cause in the lab itself: RouteIQ ended while in front and started again at once (black 4 of
// 4), against started from the background (drawn 5 of 5). These pin the lab's start and the
// check that the driving screen is drawn after Start drive.

const APP = 'dev.routeiq.shell'

describe('the lab starts RouteIQ from the background, never by ending it in front', () => {
  it('every launch that ends the app goes through the background first', () => {
    expect(startsFromBackground(APP, { env: {} })).toBe(true)
    expect(DEFAULT_LAB_LAUNCH.backgroundFirstMs).toBeGreaterThanOrEqual(6000)
  })

  it('bringing a running app back to the front ends nothing, so it needs no detour', () => {
    expect(startsFromBackground(APP, { keep: true, env: {} })).toBe(false)
  })

  it('the background app itself is started directly', () => {
    expect(startsFromBackground(BACKGROUND_APP, { env: {} })).toBe(false)
  })

  it('phone.launch, the one way the lab starts an app, takes that detour before it sends the launch', () => {
    // phone.mjs needs a phone on the cable to run, so this reads it: in launch(), the background
    // launch and the wait come before the app's own launch is sent.
    const phone = readFileSync(new URL('../scripts/phone/lab/phone.mjs', import.meta.url), 'utf8')
    const body = phone.slice(phone.indexOf('async launch(bundleId'), phone.indexOf('async screenshot('))
    const detour = body.indexOf('if (startsFromBackground(bundleId, { keep }))')
    expect(detour).toBeGreaterThan(-1)
    expect(detour).toBeLessThan(body.indexOf('sleep(DEFAULT_LAB_LAUNCH.backgroundFirstMs)'))
    expect(body.indexOf('sleep(DEFAULT_LAB_LAUNCH.backgroundFirstMs)')).toBeLessThan(body.indexOf("bundle: bundleId"))
    // No other place sends a launch.
    expect(phone.split("cmd: 'launch'").length).toBe(3)
  })

  it('only ROUTEIQ_LAB_HOT=1 brings back the start that made the screen black, to reproduce it', () => {
    expect(startsFromBackground(APP, { env: { ROUTEIQ_LAB_HOT: '1' } })).toBe(false)
    expect(startsFromBackground(APP, { env: { ROUTEIQ_LAB_HOT: '0' } })).toBe(true)
  })
})

const flat = (sec: number) => ({ sec, look: { flat: 0.99, shade: 0 } })
const drawn = (sec: number) => ({ sec, look: { flat: 0.4, shade: 230 } })

describe('drive-screen: drawn within 2 s of Start drive, and stays drawn', () => {
  it('drawn in the first screenshot, which comes 2.6 s after the press as on the phone: passes', () => {
    const v = checkDrawnWithin([drawn(2.6), drawn(4), drawn(6.5), drawn(11)])
    expect(v.pass).toBe(true)
  })

  it('black for the whole watch, as with the hot start: fails', () => {
    const v = checkDrawnWithin([flat(2.6), flat(10), flat(20), flat(39)])
    expect(v.pass).toBe(false)
    expect(v.detail).toContain('never drawn')
  })

  it('drawn by itself at 18 s, as in the first run on PR #141: fails, and says when', () => {
    const v = checkDrawnWithin([flat(2.6), flat(9), flat(15), drawn(18.2), drawn(25)])
    expect(v.pass).toBe(false)
    expect(v.detail).toContain('first drawn 18.2 s')
  })

  it('drawn, then black again: fails', () => {
    expect(checkDrawnWithin([drawn(2.6), drawn(4), flat(7), drawn(9)]).pass).toBe(false)
  })

  it('flat only before 2 s (the drive view coming up) is allowed', () => {
    expect(DEFAULT_LAB_CHECKS.maxDrawnSec).toBe(2)
    expect(checkDrawnWithin([flat(1.2), drawn(2.1), drawn(9)]).pass).toBe(true)
  })

  it('a first screenshot too late to see the start cannot pass', () => {
    const v = checkDrawnWithin([drawn(7), drawn(12)])
    expect(v.pass).toBe(false)
    expect(v.notRun).toBe(true)
  })

  it('nothing measured: not run, never a pass', () => {
    const v = checkDrawnWithin([{ sec: 3, look: null }])
    expect(v.pass).toBe(false)
    expect(v.notRun).toBe(true)
  })

  it('firstDrawn says when it was first drawn and when it was last flat', () => {
    expect(firstDrawn([flat(2.6), drawn(18), flat(20), drawn(25)])).toMatchObject({ drawnSec: 18, lastFlatSec: 20, firstSec: 2.6, watchedSec: 25, measured: 4 })
  })
})

describe('the app writes its report the moment it presses Start drive', () => {
  it('so the PC can time the screen from the press', async () => {
    const el = (textContent: string) => ({ textContent, disabled: false, checked: true, clicks: 0, click() {
      this.clicks++
    } })
    const start = { ...el('Start drive'), disabled: true }
    const reports: { text: string; pressed: number }[] = []
    const doc: LabDocument = {
      querySelector: (s) => ({ '.plan': el('plan'), '.testdrive input[type="checkbox"]': el('') } as Record<string, unknown>)[s] ?? null,
      querySelectorAll: (s) => (s === 'button' ? [start] : s === '.routes > li' ? [el('Route')] : []),
    }
    let nowMs = 1_000_000
    let beat = () => {}
    await startLab({
      plugin: {
        lab: () => Promise.resolve({ enabled: true, scenario: 'testdrive' }),
        labReport: ({ text }) => (reports.push({ text, pressed: start.clicks }), Promise.resolve()),
      },
      diagnostics: createDriveDiagnostics(() => nowMs),
      target: { document: doc },
      now: () => nowMs,
      every: (_ms, fn) => {
        beat = fn
      },
    })
    nowMs += 1000
    beat() // the periodic report goes out; Start drive is not enabled yet
    expect(reports.length).toBe(1)
    start.disabled = false
    expect(LAB_REPORT_MS).toBeGreaterThan(1000)
    nowMs += 1000 // well before the next periodic report (every LAB_REPORT_MS)
    beat()
    const atPress = reports.filter((r) => r.pressed === 1)
    expect(start.clicks).toBe(1)
    expect(atPress.length).toBeGreaterThan(0)
    expect(atPress[0].text).toContain('pressed "Start drive"')
  })
})

describe('the queue gives every build the screen-drawn check', () => {
  const plan = (builds: unknown[]) => JSON.stringify({ rollback: 'good.ipa', builds })
  const there = () => true

  it('refuses a build whose runs leave drive-screen out', () => {
    const read = readPlan(plan([{ name: 'pr', ipa: 'pr.ipa', runs: [['--scenario', 'starts-and-plans']] }]), there)
    expect((read as { error?: string }).error).toContain('drive-screen')
  })

  it('unless the plan says why', () => {
    expect(readPlan(plan([{ name: 'pr', ipa: 'pr.ipa', runs: [['--scenario', 'starts-and-plans']], noDriveScreen: 'cannot start a drive' }]), there)).not.toHaveProperty('error')
  })

  it('the default runs have it', () => {
    expect(readPlan(plan([{ name: 'main', ipa: 'main.ipa' }]), there)).not.toHaveProperty('error')
  })
})
