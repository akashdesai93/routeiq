// Types for run.mjs, so the tests can import it. The script itself is plain JavaScript.

import type { Verdict } from './assertions.mjs'

export const SCENARIOS: Readonly<Record<string, string>>
export const USAGE: string

export interface LabRunOptions {
  scenario: string
  fix: string | null
  lock: boolean
  ownerUnlocksAfter: boolean
  inApp: boolean
  gps: boolean
  awaySec: number
  minutes: number
  fromM: number | null
  speed: number
  pushWeb: boolean
  web: boolean
  out: string
}

export function parseArgs(argv: readonly string[]): LabRunOptions | { error: string }

export function summaryMarkdown(run: {
  scenario: string
  options: string
  device: { model: string; ios: string }
  app: string
  steps: readonly string[]
  checks: readonly Verdict[]
  metrics?: readonly (readonly [string, string | number])[]
  samples: readonly Record<string, unknown>[]
  simulated: { from: string; to: string; cleared: boolean } | null
  files: readonly string[]
  result: string
}): string
