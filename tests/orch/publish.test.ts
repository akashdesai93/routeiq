import { describe, expect, it } from 'vitest'
import { alertAction, hasMorningToday, keysOf } from '../../scripts/orch/publish.mjs'

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
