import { DEFAULT_REPLAY_PLAN, type ReplayMultiplier, type ReplayPlan } from './replay.ts'

/** What the development replay is set to do. Kept by App for the page's lifetime. */
export interface ReplaySetup {
  /** True: "Start drive" uses the replayed driver in place of the device's GPS. */
  readonly enabled: boolean
  readonly multiplier: ReplayMultiplier
  readonly noise: boolean
  readonly dropouts: boolean
  readonly stop: boolean
  readonly tunnel: boolean
  readonly wrongTurn: boolean
}

export const DEFAULT_REPLAY_SETUP: ReplaySetup = {
  enabled: false,
  multiplier: 5,
  noise: true,
  dropouts: false,
  stop: false,
  tunnel: false,
  wrongTurn: false,
}

/** The replay plan a setup stands for. The distances are meters driven; the times are seconds of drive time. */
export function replayPlanOf(setup: ReplaySetup, speedMps: number): ReplayPlan {
  return {
    ...DEFAULT_REPLAY_PLAN,
    speedMps,
    noiseM: setup.noise ? 6 : 0,
    dropoutsSec: setup.dropouts
      ? [
          [90, 110],
          [400, 425],
        ]
      : [],
    stop: setup.stop ? { atM: 1500, forSec: 45 } : null,
    tunnel: setup.tunnel ? { fromM: 6000, toM: 7500 } : null,
    excursion: setup.wrongTurn ? { atM: 3000, offsetM: 150, maxSec: 90 } : null,
  }
}
