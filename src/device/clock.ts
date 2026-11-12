/**
 * The live drive's clock (#30). The session compares every fix's time with the
 * last one and with its own clock (`PositionFix.timeMs` is on "a clock that
 * only moves forward"; tracking ignores a fix that is not newer than the last).
 * The wall clock (`Date.now`) can step back: NTP or carrier time correction, or
 * the time changed by hand. After a step back of N seconds, every fix for N
 * seconds would look out of order and the car would stand still on the map.
 *
 * This clock follows the wall clock forward, so time spent with the phone
 * asleep or the page suspended still counts (`performance.now()` does not
 * advance during sleep on Apple devices, w3c/hr-time#115), and absorbs any
 * step back: it carries on from where it was (1 ms later), as if the step had
 * not happened. It never goes backwards.
 */
export function steadyClock(wall: () => number = () => Date.now()): { now: () => number; toWall: (ms: number) => number } {
  let lastWall: number | null = null
  let offset = 0
  let last = -Infinity
  const now = () => {
    const w = wall()
    if (!Number.isFinite(w)) return last === -Infinity ? 0 : last
    // A step back: from now on everything is that much later than the wall clock says, plus
    // 1 ms, so the reading after the step is still later than the one before it (tracking
    // drops a fix that is not newer than the last).
    if (lastWall !== null && w < lastWall) offset += lastWall - w + 1
    lastWall = w
    last = Math.max(last, w + offset)
    return last
  }
  return {
    now,
    /** A time on this clock as the wall clock tells it, for showing a time of day (the arrival time). */
    toWall: (ms: number) => ms - offset,
  }
}

/**
 * The one clock the live drive, the browser's GPS and the iPhone shell's GPS all
 * stamp with, so a fix's time and the session's time can be compared. One shared
 * instance: each step back is absorbed once, for all of them.
 */
export const sessionClock = steadyClock()

/** The session clock's time in milliseconds. */
export const sessionNow = (): number => sessionClock.now()
