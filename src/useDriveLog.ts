import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_DRIVE_LOG,
  endDrive,
  endJams,
  JAM_RECORDER_IDLE,
  observeDrive,
  observeJams,
  recordDrive,
  type DriveLog,
  type DriveRecord,
  type JamRecorder,
  type JamRecorderStep,
} from './core/index.ts'
import { shellDiagnostics } from './device/native/diagnostics.ts'
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
 */
export function useDriveLog(store: TextStore, trip: () => { otherAppSec: number | null }): DriveLogState {
  const [log, setLog] = useState<DriveLog>(() => loadDriveLog(store))
  const [stored, setStored] = useState(true)
  const latest = useRef(log)
  const recorder = useRef<JamRecorder>(JAM_RECORDER_IDLE)
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
      // The drive diagnostics say the same in one line: totals only, never where.
      shellDiagnostics.jams(record.jams)
    },
    [store],
  )
  const apply = useCallback(
    (step: JamRecorderStep) => {
      recorder.current = step.recorder
      if (step.write !== null) write(step.write)
    },
    [write],
  )

  const observer = useMemo<DriveObserver>(() => {
    // Made once: a tick passes it along and it is never called.
    const context = () => ({ ...tripRef.current(), hourOf: localHour })
    return {
      start: () => {
        recorder.current = JAM_RECORDER_IDLE
      },
      change: (state, nowMs) => {
        // The jam meter (#227) runs beside the recorder and fills in each record it writes.
        const step = observeJams(recorder.current, state, nowMs, (drive) => observeDrive(drive, state, nowMs, context))
        if (step.recorder !== recorder.current) apply(step)
      },
      end: (state, nowMs) => apply(endJams(recorder.current, nowMs, (drive) => endDrive(drive, state, nowMs))),
    }
  }, [apply])

  const clear = useCallback(() => {
    latest.current = EMPTY_DRIVE_LOG
    setLog(EMPTY_DRIVE_LOG)
    setStored(clearDriveLog(store))
  }, [store])

  return { log, storageNote: stored ? null : NOT_STORED, observer, clear }
}
