#!/usr/bin/env node
// The phone lab's preflight (docs/phone-lab.md, "Preflight and hard rules"). The rules that
// went wrong on the first night, as checks: it spoke aloud at night, it started the moment the
// phone was unlocked, it tested stale builds, and it ran with nobody having said it could.
//
//   node scripts/phone/lab/preflight.mjs [--scenario <name>] [--voice-ok] [--build-sha <sha> --head-sha <sha>]
//
// Exit 0 when the lab may run now, 1 with the reasons when it may not. It reads the newest
// `lab-window:` comment on #17 (docs/orchestrator.md) through `gh api`.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_LAB_RULES = Object.freeze({
  /** Quiet hours on the PC's clock (the owner's time): no scenario that speaks. */
  quietFromHour: 22,
  quietToHour: 7,
})

/** The scenarios that start a drive, and so speak at the phone's media volume. */
export const SPEAKING_SCENARIOS = Object.freeze(['locked-wrong-turn', 'background-soak', 'drive-screen'])

export function isQuietHour(hour, rules = DEFAULT_LAB_RULES) {
  return rules.quietFromHour > rules.quietToHour ? hour >= rules.quietFromHour || hour < rules.quietToHour : hour >= rules.quietFromHour && hour < rules.quietToHour
}

/** A reason not to run this scenario now, or null. `hour` is the PC's local hour. */
export function quietHoursProblem(hour, scenario, voiceOk, rules = DEFAULT_LAB_RULES) {
  if (!SPEAKING_SCENARIOS.includes(scenario) || voiceOk || !isQuietHour(hour, rules)) return null
  return `${scenario} speaks, and it is quiet hours (${rules.quietFromHour}:00 to ${rules.quietToHour}:00). Run it in the day, or pass --voice-ok when the owner has said the phone may speak (volume down, nobody asleep near it).`
}

/** A reason the window does not allow a run, or null. window: { until, voice_ok } | null. */
export function windowProblem(window, now) {
  if (!window) return 'No lab window: the owner has not said the lab may use the phone. The orchestrator posts "lab-window: until HH:MM UTC" on #17 when they do.'
  if (new Date(now).getTime() >= new Date(window.until).getTime()) return `The lab window ended at ${window.until}.`
  return null
}

/** A reason the build is not the PR's current code, or null. */
export function buildProblem(buildSha, headSha) {
  if (!buildSha || !headSha) return null
  const a = buildSha.toLowerCase()
  const b = headSha.toLowerCase()
  return a.startsWith(b) || b.startsWith(a) ? null : `The build is of ${a.slice(0, 7)}, but the PR is now at ${b.slice(0, 7)}: test a build of the current head.`
}

/**
 * How long queue.mjs may wait for the phone to be unlocked. Waiting for an unlock is only
 * allowed until a time the owner gave: someone unlocking the phone in the morning may be
 * picking it up to leave with it. → { ms } or { error }.
 */
export function waitAllowance(waitHours, untilHHMM, now) {
  if (!waitHours) return { ms: 0 }
  if (!untilHHMM) return { error: '--wait-unlocked needs --until HH:MM (the PC\'s time): the owner says until when the lab may start by itself.' }
  const m = /^(\d{1,2}):(\d{2})$/.exec(untilHHMM)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { error: `--until ${untilHHMM}: give a time like 06:30` }
  const end = new Date(now)
  end.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (end.getTime() <= new Date(now).getTime()) end.setDate(end.getDate() + 1)
  return { ms: Math.min(waitHours * 3_600_000, end.getTime() - new Date(now).getTime()) }
}

/** The newest lab window on the board: "lab-window: until HH:MM UTC[ · voice ok]". */
export function labWindowFrom(comments) {
  let found = null
  for (const c of comments) {
    const m = /^lab-window:\s*(?:until\s+)?(\d{1,2}):(\d{2})\s*(?:UTC|Z)?\s*(·\s*voice ok)?\s*$/im.exec(String(c.body || '').split('\n')[0])
    if (!m) continue
    const at = new Date(c.created_at)
    const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), Number(m[1]), Number(m[2])))
    if (end <= at) end.setUTCDate(end.getUTCDate() + 1)
    if (!found || c.created_at > found.opened_at) found = { opened_at: c.created_at, until: end.toISOString(), voice_ok: !!m[3] }
  }
  return found
}

export function preflight({ now, hour, scenario, voiceOk, window, buildSha, headSha }) {
  const problems = [
    windowProblem(window, now),
    scenario ? quietHoursProblem(hour, scenario, voiceOk || !!window?.voice_ok) : null,
    buildProblem(buildSha, headSha),
  ].filter(Boolean)
  return { ok: problems.length === 0, problems }
}

function main(argv) {
  const arg = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : null
  }
  const repo = process.env.GITHUB_REPOSITORY || 'akashdesai93/routeiq'
  const now = new Date()
  const since = new Date(now.getTime() - 24 * 3600e3).toISOString()
  const comments = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/issues/17/comments?since=${since}&per_page=100`], { encoding: 'utf8' }))
  const result = preflight({ now: now.toISOString(), hour: now.getHours(), scenario: arg('--scenario'), voiceOk: argv.includes('--voice-ok'), window: labWindowFrom(comments), buildSha: arg('--build-sha'), headSha: arg('--head-sha') })
  if (result.ok) console.log('preflight: the lab may run now')
  else for (const p of result.problems) console.log(`preflight: ${p}`)
  console.log('Also check by eye: the phone is on the cable and unlocked, Sideloadly is open with no window of its own, nothing asks for a password or trust. Any prompt: stop and report; never answer it.')
  return result.ok ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2))
