import { useMemo, useRef, useState } from 'react'
import {
  corridorLabels,
  driveLogCsv,
  errorWords,
  formatDistance,
  formatWait,
  hourLabel,
  otherAppErrorSec,
  predictionErrorSec,
  summarizeDriveLog,
  worstLights,
  type CorridorSummary,
  type DriveLog,
  type DriveRecord,
  type DriveStops,
  type ErrorGroup,
  type PartTime,
  type RouteSource,
} from './core/index.ts'
import { canShare, copyText, shareText } from './device/share.ts'

interface Props {
  log: DriveLog
  storageNote: string | null
  onClear: () => void
  onClose: () => void
}

const minutes = (sec: number) => `${Math.round(sec / 60)} min`
/** Signed, with a real minus sign: "−1 min". */
const signedMinutes = (sec: number) => {
  const m = Math.round(sec / 60)
  return `${m < 0 ? '−' : ''}${Math.abs(m)} min`
}

const OUTCOME: Record<DriveRecord['outcome'], string> = {
  arrived: 'Arrived',
  ended: 'Ended early',
  unfinished: 'Not finished (the app was closed during the drive)',
}

const SOURCE: Record<RouteSource, string> = { provider: 'Mapbox routes', probe: 'Side-street routes' }

function lights(drive: DriveRecord): string {
  if (drive.signals === null) return 'lights unknown'
  return drive.signals.partial ? `≥ ${drive.signals.count} lights (partial)` : `${drive.signals.count} lights`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function partLine(name: string, part: PartTime): string {
  return `${name}: predicted ${part.predictedSec === null ? 'unknown' : minutes(part.predictedSec)} · took ${minutes(part.actualSec)}`
}

/** Where the car stood still (#196): moving against stopped, the lights, the worst ones, street against freeway. */
function StopsBlock({ stops, actualSec }: { stops: DriveStops; actualSec: number }) {
  const worst = worstLights(stops)
  const parts = stops.parts
  return (
    <div className="drive-stops" aria-label="Stops">
      <p>
        Moving {formatWait(Math.max(0, actualSec - stops.stoppedSec))} · Stopped {formatWait(stops.stoppedSec)}
        {stops.count > 0 ? ` (${plural(stops.count, 'stop', 'stops')})` : ' (no stops)'}
      </p>
      {stops.count > 0 && (
        <p>
          At lights: {stops.lightStops === 0 ? 'none' : `${formatWait(stops.lightSec)} at ${plural(stops.lightStops, 'light', 'lights')}`}
          {stops.unknownStops > 0 && ` · ${plural(stops.unknownStops, 'stop', 'stops')} where lights are unknown`}
        </p>
      )}
      {worst.length > 0 && (
        <p>
          Worst {worst.length === 1 ? 'light' : 'lights'}:{' '}
          {worst.map((s) => `${formatWait(s.durationSec)}, ${s.drivenM === null ? `${minutes(s.atSec)}` : formatDistance(s.drivenM)} in`).join(" · ")}
        </p>
      )}
      {parts !== null && (
        <p className="hint">
          {partLine('Streets', parts.surface)}
          {(parts.freeway.actualSec > 0 || (parts.freeway.predictedSec ?? 0) > 0) && ` · ${partLine('Freeway', parts.freeway)}`}
        </p>
      )}
    </div>
  )
}

function DriveItem({ drive, label }: { drive: DriveRecord; label: string }) {
  const error = predictionErrorSec(drive)
  const otherError = otherAppErrorSec(drive)
  const kept = drive.switches.filter((s) => s.accepted)
  const declined = drive.switches.length - kept.length
  return (
    <li className="drive-item">
      <div className="drive-head">
        <strong>{new Date(drive.startedAtMs).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>
        <span>Corridor {label}</span>
        <span className={`drive-outcome ${drive.outcome}`}>{OUTCOME[drive.outcome]}</span>
      </div>
      <p>
        Predicted {minutes(drive.predictedSec)} · Took {minutes(drive.actualSec)}
        {error !== null && ` (${errorWords(error)})`}
      </p>
      {drive.otherAppSec !== null && (
        <p>
          Other app {minutes(drive.otherAppSec)}
          {otherError !== null && ` (${errorWords(otherError).replace('predicted', 'it said')})`}
        </p>
      )}
      {drive.stops !== null && <StopsBlock stops={drive.stops} actualSec={drive.actualSec} />}
      {drive.switches.length > 0 && (
        <p>
          {kept.length === 1 ? '1 switch' : `${kept.length} switches`}
          {kept.map((s, i) => (
            <span key={i}>
              {i === 0 ? ': ' : '; '}
              {s.claimedSavingSec === null
                ? s.code === 'off-route'
                  ? 'new route after leaving the route'
                  : 'no saving claimed'
                : `claimed ${minutes(s.claimedSavingSec)}, made ${s.realisedSavingSec === null ? 'unknown' : signedMinutes(s.realisedSavingSec)}`}
            </span>
          ))}
          {declined > 0 && ` · ${declined} turned down`}
        </p>
      )}
      <p className="hint">
        {formatDistance(drive.distanceM)} · {lights(drive)} · {drive.routeSource === 'probe' ? 'side-street route' : 'Mapbox route'}
        {drive.offRouteEvents > 0 && ` · off the route ${drive.offRouteEvents}×`} · {drive.requests} requests
      </p>
    </li>
  )
}

function sourceLine(group: ErrorGroup<RouteSource>): string {
  const m = Math.round(group.medianErrorSec / 60)
  const how = m === 0 ? 'about right' : m > 0 ? `under-estimated by ${m} min` : `over-estimated by ${-m} min`
  return `${SOURCE[group.key]}: ${how} (median of ${group.drives})`
}

function CorridorBlock({ summary }: { summary: CorridorSummary }) {
  return (
    <section className="corridor" aria-label={`Corridor ${summary.label}`}>
      <h3>Corridor {summary.label}</h3>
      <p className="hint">
        {summary.drives === 1 ? '1 drive' : `${summary.drives} drives`}, {summary.arrived} arrived
      </p>
      {summary.medianErrorSec === null ? (
        <p>No arrived drives yet: only arrived drives are compared.</p>
      ) : (
        <>
          <p>Median: {errorWords(summary.medianErrorSec)}.</p>
          <table aria-label={`Corridor ${summary.label} by hour`}>
            <thead>
              <tr>
                <th>Start</th>
                <th>Drives</th>
                <th>Median</th>
              </tr>
            </thead>
            <tbody>
              {summary.byHour.map((h) => (
                <tr key={h.key}>
                  <td>{hourLabel(h.key)}</td>
                  <td>{h.drives}</td>
                  <td>{errorWords(h.medianErrorSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="corridor-sources">
            {summary.bySource.map((g) => (
              <li key={g.key}>{sourceLine(g)}</li>
            ))}
            {summary.otherApp !== null && (
              <li>
                Other app: {errorWords(summary.otherApp.medianErrorSec).replace('predicted', 'it said')} (median of {summary.otherApp.drives})
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  )
}

/**
 * The Drives screen: the private drive log (#107), newest drive first, then
 * a summary per corridor. Export hands the log on as CSV (share sheet or
 * clipboard); Clear removes it from the device. Shows only: the log and its
 * rules are in core/driveLog.ts, the storage in src/storage/driveLog.ts.
 */
export function DrivesPanel({ log, storageNote, onClear, onClose }: Props) {
  const labels = useMemo(() => corridorLabels(log), [log])
  const summaries = useMemo(() => summarizeDriveLog(log), [log])
  const newestFirst = useMemo(() => [...log.drives].reverse(), [log])
  const [exporting, setExporting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const csv = useMemo(() => (exporting ? driveLogCsv(log) : ''), [exporting, log])

  const onCopy = () =>
    void copyText(csv, field.current).then(
      () => setNote('Copied. Paste it into a message or a spreadsheet.'),
      () => setNote('Could not copy. Press and hold the text, Select All, then Copy.'),
    )
  const onShare = () =>
    void shareText('RouteIQ drive log', csv).then((r) => setNote(r === 'failed' ? 'Could not open the share sheet. Use Copy instead.' : null))

  return (
    <section className="drives" aria-label="Drives">
      <div className="drives-head">
        <strong>Drives</strong>
        {log.drives.length > 0 && (
          <button type="button" aria-pressed={exporting} onClick={() => setExporting((e) => !e)}>
            Export
          </button>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">
        Kept on this device only, and never sent anywhere. No positions or addresses: each trip is a corridor letter, from
        its two ends rounded to about a kilometre.
      </p>
      {storageNote !== null && (
        <p className="field-status failed" role="alert">
          {storageNote}
        </p>
      )}

      {exporting && (
        <div className="drives-export">
          <div className="plan-row">
            {canShare() && (
              <button type="button" onClick={onShare}>
                Share
              </button>
            )}
            <button type="button" onClick={onCopy}>
              Copy
            </button>
          </div>
          {note !== null && <p role="status">{note}</p>}
          <textarea ref={field} readOnly value={csv} rows={6} aria-label="Drive log as CSV" />
        </div>
      )}

      {log.drives.length === 0 ? (
        <p>No drives yet. Drives made with Start drive are listed here, with the time predicted at the start and the time they really took.</p>
      ) : (
        <>
          <ol className="drive-list" aria-label="Past drives">
            {newestFirst.map((d) => (
              <DriveItem key={d.id} drive={d} label={labels.get(d.corridor) ?? '?'} />
            ))}
          </ol>
          <h2>By corridor</h2>
          {summaries.map((s) => (
            <CorridorBlock key={s.corridor} summary={s} />
          ))}
          <div className="plan-row">
            {confirmClear ? (
              <>
                <span>Remove every drive from this device?</span>
                <button
                  type="button"
                  onClick={() => {
                    onClear()
                    setConfirmClear(false)
                    setExporting(false)
                  }}
                >
                  Yes, clear it
                </button>
                <button type="button" onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmClear(true)}>
                Clear drive log
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
