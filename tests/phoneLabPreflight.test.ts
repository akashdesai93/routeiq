import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildProblem, isQuietHour, labWindowFrom, preflight, quietHoursProblem, readLabWindow, SILENT_SCENARIOS, waitAllowance } from '../scripts/phone/lab/preflight.mjs'
import { labStartProblem } from '../scripts/phone/lab/queue.mjs'
import { SCENARIOS } from '../scripts/phone/lab/run.mjs'

// The phone lab's hard rules (docs/phone-lab.md, "Preflight and hard rules"). Each one is a
// thing that happened on the first night with the owner's own phone.

describe('quiet hours: the phone spoke aloud at night', () => {
  it('refuses a drive scenario between 22:00 and 07:00', () => {
    expect(quietHoursProblem(23, 'locked-wrong-turn', false)).toMatch(/quiet hours/)
    expect(quietHoursProblem(6, 'drive-screen', false)).toMatch(/quiet hours/)
  })
  it('allows it in the day, a silent scenario at night, and a drive when the owner said so', () => {
    expect(quietHoursProblem(7, 'locked-wrong-turn', false)).toBeNull()
    expect(quietHoursProblem(21, 'background-soak', false)).toBeNull()
    expect(quietHoursProblem(2, 'starts-and-plans', false)).toBeNull()
    expect(quietHoursProblem(2, 'locked-wrong-turn', true)).toBeNull()
  })
  it('keeps a scenario nobody listed as silent quiet at night (a new drive scenario added to run.mjs)', () => {
    expect(quietHoursProblem(23, 'some-new-drive', false)).toMatch(/quiet hours/)
    // Every scenario run.mjs has, except the silent ones, is held at night.
    for (const name of Object.keys(SCENARIOS)) expect(quietHoursProblem(23, name, false) === null, name).toBe(SILENT_SCENARIOS.includes(name))
  })
  it('handles a window that does not cross midnight', () => {
    expect(isQuietHour(13, { quietFromHour: 12, quietToHour: 14 })).toBe(true)
    expect(isQuietHour(15, { quietFromHour: 12, quietToHour: 14 })).toBe(false)
  })
})

describe('no auto-start on unlock: the owner may be picking the phone up to leave', () => {
  const now = new Date(2026, 10, 12, 23, 0)
  it('refuses --wait-unlocked without the time the owner gave', () => {
    expect(waitAllowance(8, null, now)).toEqual({ error: expect.stringMatching(/needs --until HH:MM/) })
  })
  it('waits only until that time, even if more hours were asked for', () => {
    expect(waitAllowance(8, '06:30', now)).toEqual({ ms: 7.5 * 3_600_000 })
    expect(waitAllowance(1, '06:30', now)).toEqual({ ms: 3_600_000 })
  })
  it('needs no time when it does not wait', () => {
    expect(waitAllowance(0, null, now)).toEqual({ ms: 0 })
  })
})

describe('lab window: nobody had said the lab could use the phone', () => {
  const now = '2026-11-12T04:00:00Z'
  it('refuses with no window, or after it ended', () => {
    expect(preflight({ now, hour: 12, window: null }).ok).toBe(false)
    expect(preflight({ now, hour: 12, window: { until: '2026-11-12T03:59:00Z' } }).problems[0]).toMatch(/ended/)
    expect(preflight({ now, hour: 12, window: { until: '2026-11-12T06:00:00Z' } }).ok).toBe(true)
  })
  it('reads the newest window from #17, across midnight, with voice ok', () => {
    const w = labWindowFrom([
      { created_at: '2026-11-12T01:00:00Z', body: 'lab-window: until 02:00 UTC' },
      { created_at: '2026-11-12T23:10:00Z', body: 'lab-window: until 06:30 UTC · voice ok' },
      { created_at: '2026-11-12T23:20:00Z', body: 'status: x' },
    ])
    expect(w).toEqual({ opened_at: '2026-11-12T23:10:00Z', until: '2026-11-13T06:30:00.000Z', voice_ok: true })
  })
  it('lets a window with voice ok run a drive at night', () => {
    expect(preflight({ now, hour: 23, scenario: 'locked-wrong-turn', window: { until: '2026-11-12T06:00:00Z', voice_ok: true } }).ok).toBe(true)
    expect(preflight({ now, hour: 23, scenario: 'locked-wrong-turn', window: { until: '2026-11-12T06:00:00Z' } }).ok).toBe(false)
  })
})

describe('build freshness: the lab tested stale builds', () => {
  it('refuses a build of another commit than the PR head', () => {
    expect(buildProblem('566555f0000', 'b539360aaaa')).toMatch(/566555f.*b539360/)
    expect(buildProblem('b539360', 'b539360aaaa')).toBeNull()
  })
  it('refuses a prefix too short to name one commit', () => {
    expect(buildProblem('b', 'b539360aaaa')).toMatch(/at least 7/)
    expect(buildProblem('b539360aaaa', 'b53936')).toMatch(/at least 7/)
    expect(buildProblem('not-a-sha', 'b539360aaaa')).toMatch(/at least 7/)
  })
})

describe('no hardware buttons: pressing the side button locked the phone with its passcode', () => {
  it('no lab script sends a button press or a touch', () => {
    const dir = 'scripts/phone/lab'
    for (const f of readdirSync(dir).filter((x) => /\.(mjs|py|ps1)$/.test(x))) {
      const code = readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|#|\*)/.test(l)).join('\n')
      expect(code, f).not.toMatch(/hid['",\s]+button|button['",\s]+lock|universal-hid-service/i)
    }
  })
})

describe('the queue checks the window itself: a lab agent that skips the preflight is still stopped', () => {
  const now = new Date('2026-11-12T04:00:00Z')
  const board = (comments: { body: string; created_at: string }[]) => () => comments
  it('refuses to install with no window on #17', () => {
    expect(labStartProblem(board([{ created_at: '2026-11-12T01:00:00Z', body: 'status: x' }]), 'o/r', now)).toMatch(/No lab window/)
  })
  it('refuses when the window ended while it waited for an unlock', () => {
    expect(labStartProblem(board([{ created_at: '2026-11-12T01:00:00Z', body: 'lab-window: until 03:30 UTC' }]), 'o/r', now)).toMatch(/ended/)
  })
  it('starts inside an open window', () => {
    expect(labStartProblem(board([{ created_at: '2026-11-12T01:00:00Z', body: 'lab-window: until 06:30 UTC' }]), 'o/r', now)).toBeNull()
  })
  it('refuses when #17 cannot be read: no answer is not a yes', () => {
    const down = () => {
      throw new Error('gh: HTTP 502')
    }
    expect(labStartProblem(down, 'o/r', now)).toMatch(/Could not read the lab window/)
    expect(readLabWindow(down, 'o/r', now.toISOString())).toEqual({ error: expect.stringMatching(/HTTP 502/) })
  })

  // #204: on a busy night #17 has more than 100 comments in a day; the window was on page 2.
  const statuses = (n: number) => Array.from({ length: n }, (_, i) => ({ created_at: '2026-11-12T02:00:00Z', body: `status: cloud-x${i}` }))
  const paged = (pages: { body: string; created_at: string }[][]) => (path: string) => {
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1)
    if (/[?&]per_page=100\b/.test(path) === false) throw new Error(`asked for ${path}`)
    return pages[page - 1] ?? []
  }
  it('finds a window on the second page of #17\'s comments', () => {
    const window = { created_at: '2026-11-12T03:00:00Z', body: 'lab-window: until 06:30 UTC' }
    expect(labStartProblem(paged([statuses(100), [window, ...statuses(3)]]), 'o/r', now)).toBeNull()
    expect(readLabWindow(paged([statuses(100), statuses(100), [window]]), 'o/r', now.toISOString())).toEqual({ window: { opened_at: window.created_at, until: '2026-11-12T06:30:00.000Z', voice_ok: false } })
  })
  it('takes the newest window across pages, and refuses when a later page cannot be read', () => {
    const closed = { created_at: '2026-11-12T01:00:00Z', body: 'lab-window: until 03:30 UTC' }
    const open = { created_at: '2026-11-12T03:00:00Z', body: 'lab-window: until 06:30 UTC' }
    expect(labStartProblem(paged([[closed, ...statuses(99)], [open]]), 'o/r', now)).toBeNull()
    const pageTwoDown = (path: string) => {
      if (/[?&]page=2\b/.test(path)) throw new Error('gh: HTTP 502')
      return [open, ...statuses(99)]
    }
    expect(readLabWindow(pageTwoDown, 'o/r', now.toISOString())).toEqual({ error: expect.stringMatching(/HTTP 502/) })
  })
  it('refuses, and stops asking, when #17 has more pages than it may read', () => {
    let asked = 0
    const endless = () => {
      asked++
      return statuses(100)
    }
    expect(readLabWindow(endless, 'o/r', now.toISOString())).toEqual({ error: expect.stringMatching(/More than 2000 comments/) })
    expect(asked).toBe(20)
  })
})
