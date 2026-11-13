import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_DRIVE_LOG,
  endDrive,
  observeDrive,
  RECORDER_IDLE,
  recordDrive,
  type DriveLog,
  type DriveRecord,
  type DriveRecorder,
  type RecorderStep,
  type RouteCandidate,
} from './core/index.ts'
import { createRouteLights, type RouteLightsCache } from './drive/routeLights.ts'
import type { LiveObserver } from './live/runner.ts'
import type { TextStore } from './storage/local.ts'
import { clearDriveLog, loadDriveLog, saveDriveLog } from './storage/driveLog.ts'

/** What the live drive tells the log: the runner's observer (live/runner.ts), isolated there. `change` is cheap unless a switch or the arrival is in it. */
export type DriveObserver = LiveObserver

export interface DriveLogState {
  log: DriveLog
  /** Set when the device would not store the log; null when all is well. */
  storageNote: string | null
  observer: DriveObserver
  /** Removes every drive from the device. */
  clear: () => void
}

const NOT_STORED = 'This device would not store the drive log (storage is full or blocked). It will last until the app is closed.'

/** The local hour, as the device's clock and time zone see it. */
const localHour = (ms: number) => new Date(ms).getHours()

/**
 * The private drive log as React state: read from the device once, written
 * on a switch and at the end of a drive (the rules are in core/driveLog.ts).
 * `trip` is read when the drive begins on its first route: the other app's
 * ETA, if noted. The corridor comes from the drive's own state, in memory.
 * The stops (core/stops.ts) are measured on every fix; the lights of each
 * route the drive goes onto are loaded once, to tell a wait at a light.
 */
export function useDriveLog(store: TextStore, trip: () => { otherAppSec: number | null }, lights?: RouteLightsCache): DriveLogState {
  const [log, setLog] = useState<DriveLog>(() => loadDriveLog(store))
  const [stored, setStored] = useState(true)
  const latest = useRef(log)
  const recorder = useRef<DriveRecorder>(RECORDER_IDLE)
  const tripRef = useRef(trip)
  useEffect(() => {
    tripRef.current = trip
  })

  const write = useCallback(
    (record: DriveRecord) => {
      const next = recordDrive(latest.current, record)
      latest.current = next
      setLog(next)
      setStored(saveDriveLog(store, next))
    },
    [store],
  )
  const apply = useCallback(
    (step: RecorderStep) => {
      recorder.current = step.recorder
      if (step.write !== null) write(step.write)
    },
    [write],
  )

  const lightsRef = useRef<RouteLightsCache | null>(lights ?? null)
  // The route the drive was last seen on: its lights are loaded when it changes.
  const onRoute = useRef<RouteCandidate | null>(null)
  const observer = useMemo<DriveObserver>(() => {
    // Made once: a tick passes it along and it is never called.
    const context = () => ({ ...tripRef.current(), hourOf: localHour })
    const routeLights = (lightsRef.current ??= createRouteLights())
    return {
      start: () => {
        recorder.current = RECORDER_IDLE
        onRoute.current = null
      },
      change: (state, nowMs) => {
        if (state.route !== onRoute.current) {
          onRoute.current = state.route
          if (state.route !== null) routeLights.want(state.route)
        }
        const step = observeDrive(recorder.current, state, nowMs, context, {}, routeLights.lightsOf)
        if (step.recorder !== recorder.current) apply(step)
      },
      end: (state, nowMs) => apply(endDrive(recorder.current, state, nowMs, routeLights.lightsOf)),
    }
  }, [apply])

  const clear = useCallback(() => {
    latest.current = EMPTY_DRIVE_LOG
    setLog(EMPTY_DRIVE_LOG)
    setStored(clearDriveLog(store))
  }, [store])

  return { log, storageNote: stored ? null : NOT_STORED, observer, clear }
}
