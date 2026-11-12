import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { alertAction, hasMorningToday, keysOf, publish } from '../../scripts/orch/publish.mjs'

// The alert issue is how the owner hears that the fleet needs them (docs/orchestrator.md). It
// must open when something is wrong, stay one issue, ping only when something new goes wrong
// (not every hour), and close when all is clear.

const alert = (keys: string[]) => ({ ok: keys.length === 0, keys, body: `${keys.map((k) => `- ${k} text`).join('\n')}\n<!-- alert-keys: ${keys.join(',')} -->` })
const issue = (state: string, keys: string[]) => ({ number: 170, state, body: alert(keys).body })

describe('alertAction', () => {
  it('opens the alert when something is wrong and there is none', () => {
    expect(alertAction(null, alert(['heartbeat']))).toEqual({ action: 'create', comment: null })
  })
  it('reopens the same issue rather than opening another', () => {
    expect(alertAction(issue('closed', ['main']), alert(['heartbeat']))).toMatchObject({ action: 'reopen' })
  })
  it('updates silently while the same problems persist', () => {
    expect(alertAction(issue('open', ['heartbeat', 'orphan-159']), alert(['orphan-159', 'heartbeat']))).toEqual({ action: 'update', comment: null })
  })
  it('comments when a new problem appears', () => {
    const a = alertAction(issue('open', ['heartbeat']), alert(['heartbeat', 'main']))
    expect(a.action).toBe('update')
    expect(a.comment).toMatch(/^New since the last check: main/)
  })
  it('updates silently when a problem goes away but others remain', () => {
    expect(alertAction(issue('open', ['heartbeat', 'main']), alert(['heartbeat']))).toEqual({ action: 'update', comment: null })
  })
  it('closes when all is clear, and does nothing when it is already closed', () => {
    expect(alertAction(issue('open', ['main']), alert([]))).toMatchObject({ action: 'close' })
    expect(alertAction(issue('closed', ['main']), alert([]))).toEqual({ action: 'none', comment: null })
    expect(alertAction(null, alert([]))).toEqual({ action: 'none', comment: null })
  })
})

describe('keysOf', () => {
  it('reads the keys back in order, and none from a body without them', () => {
    expect(keysOf('x\n<!-- alert-keys: main,heartbeat -->')).toEqual(['heartbeat', 'main'])
    expect(keysOf('hand-written')).toEqual([])
  })
})

describe('hasMorningToday', () => {
  it('posts the morning report once per UTC day', () => {
    const c = [{ body: 'status: x' }, { body: 'morning report · 2026-11-12\n\n**On the phone**' }]
    expect(hasMorningToday(c, '2026-11-12T11:23:00Z')).toBe(true)
    expect(hasMorningToday(c, '2026-11-13T11:23:00Z')).toBe(false)
  })
})

describe('publish --dry-run', () => {
  // A "change nothing" dispatch of board.yml must not write to GitHub at all: not the board,
  // not the alert issue or its label, not a comment. Every GitHub call goes through the gh
  // stub here; a write is any call with -X other than GET.
  const folder = (alerts: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-test-'))
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ generated_at: '2026-11-12T11:23:00Z', health: { alerts } }))
    writeFileSync(join(dir, 'board.md'), 'board')
    writeFileSync(join(dir, 'alert.md'), alert(alerts).body)
    writeFileSync(join(dir, 'morning.md'), 'morning report · 2026-11-12')
    return dir
  }
  const run = (alerts: string[], existing: unknown[], dry: boolean) => {
    const calls: string[][] = []
    const gh = (args: string[]) => {
      calls.push(args)
      if (args.some((a) => a.includes('/issues?labels='))) return JSON.stringify(existing)
      if (args.some((a) => a.includes('/comments?since='))) return '[]'
      return '{}'
    }
    const argv = ['--dir', folder(alerts), '--board', '--alert', '--morning', ...(dry ? ['--dry-run'] : [])]
    publish(argv, { gh, log: () => {}, env: { GITHUB_REPOSITORY: 'o/r' }, now: '2026-11-12T11:23:00Z' })
    const writes = calls.filter((a) => a.includes('-X') && a[a.indexOf('-X') + 1] !== 'GET')
    return { writes: writes.map((a) => `${a[a.indexOf('-X') + 1]} ${a[a.indexOf('-X') + 2]}`) }
  }
  const cases: [string, string[], unknown[]][] = [
    ['opening a new alert (and its label)', ['heartbeat'], []],
    ['reopening a closed alert', ['heartbeat'], [{ number: 170, state: 'closed', body: alert(['main']).body }]],
    ['commenting on a new problem', ['heartbeat', 'main'], [{ number: 170, state: 'open', body: alert(['heartbeat']).body }]],
    ['closing when all is clear', [], [{ number: 170, state: 'open', body: alert(['main']).body }]],
  ]
  it.each(cases)('writes nothing when %s', (_, alerts, existing) => {
    expect(run(alerts, existing, true).writes).toEqual([])
  })
  it('does write the same steps without --dry-run (so the check above can see writes)', () => {
    expect(run(['heartbeat'], [], false).writes).toEqual([
      'PATCH repos/o/r/issues/17',
      'POST repos/o/r/labels',
      'POST repos/o/r/issues',
      'POST repos/o/r/issues/17/comments',
    ])
  })
})
