import { RECORDER_IDLE, type DriveRecord, type DriveRecorder, type RecorderStep } from './driveLog.ts'
import { driveJams, meterJamFix, startJamMeter, type JamMeter, type JamOptions } from './jams.ts'
import type { LiveState } from './live.ts'

/**
 * The drive log's recorder with the jam meter beside it (#227): every write
 * of a drive's record carries the jams measured so far (DriveRecord.jams).
 * The recorder's own rules (driveLog.ts) are untouched: it is run through
 * `step`, and this only feeds the meter and fills in the record.
 */
export interface JamRecorder {
  readonly drive: DriveRecorder
  /** The jams measured so far (jams.ts). In memory only. Null while no drive is being recorded. */
  readonly meter: JamMeter | null
}

export const JAM_RECORDER_IDLE: JamRecorder = { drive: RECORDER_IDLE, meter: null }

export interface JamRecorderStep {
  readonly recorder: JamRecorder
  /** The record to write now, with its jams. Null: nothing to write. */
  readonly write: DriveRecord | null
}

/**
 * One change of the live drive's state at `nowMs`. `step` runs the drive
 * log's recorder on it (observeDrive). The meter starts when the record
 * begins, is handed each new fix, and ends with the record. On a tick the
 * same recorder comes back, with nothing to write.
 */
export function observeJams(
  recorder: JamRecorder,
  state: LiveState,
  nowMs: number,
  step: (drive: DriveRecorder) => RecorderStep,
  options: Partial<JamOptions> = {},
): JamRecorderStep {
  const out = step(recorder.drive)
  const began = recorder.drive.draft === null && out.recorder.draft !== null
  const before = began ? startJamMeter(nowMs) : recorder.meter
  const measured = before === null ? null : meterJamFix(before, state, nowMs, options)
  // The drive is over once its record is written with an outcome: the slow run under way ends there.
  const write = out.write === null ? null : withJams(out.write, measured, nowMs, out.write.outcome !== 'unfinished', options)
  const meter = out.recorder.draft === null ? null : measured
  if (out.recorder === recorder.drive && meter === recorder.meter && write === null) return { recorder, write: null }
  return { recorder: { drive: out.recorder, meter }, write }
}

/** The End tap (or the drive view closed). `step` runs the drive log's endDrive. */
export function endJams(recorder: JamRecorder, nowMs: number, step: (drive: DriveRecorder) => RecorderStep, options: Partial<JamOptions> = {}): JamRecorderStep {
  const out = step(recorder.drive)
  return {
    recorder: { drive: out.recorder, meter: null },
    write: out.write === null ? null : withJams(out.write, recorder.meter, nowMs, true, options),
  }
}

function withJams(record: DriveRecord, meter: JamMeter | null, nowMs: number, final: boolean, options: Partial<JamOptions>): DriveRecord {
  // No meter: not measured, never "no jams".
  return { ...record, jams: meter === null ? null : driveJams(meter, nowMs, final, options) }
}
