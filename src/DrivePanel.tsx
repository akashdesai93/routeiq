import { useState } from 'react'
import { DEFAULT_REROUTE_OPTIONS, formatDistance, formatDuration, type RerouteOptions } from './core/index.ts'
import {
  DEFAULT_DRIVE_SETTINGS,
  formatSimClock,
  MIN_POLL_INTERVAL_SEC,
  MIN_REQUEST_GAP_MS,
  SPEED_MULTIPLIERS,
} from './drive/simulation.ts'
import type { DriveSim } from './useDriveSim.ts'

interface DrivePanelProps {
  sim: DriveSim
  /** Shows the what-if control. A development aid: the app passes import.meta.env.DEV. */
  showWhatIf?: boolean
}

/** The reroute thresholds the settings area exposes. `scale` turns the stored value into the number shown. */
const THRESHOLDS: readonly { key: keyof RerouteOptions; label: string; scale?: number }[] = [
  { key: 'minSavingSec', label: 'Minimum saving (seconds)' },
  { key: 'minSavingFraction', label: 'Minimum saving (% of time left)', scale: 100 },
  { key: 'confirmPolls', label: 'Checks in a row before switching' },
  { key: 'cooldownSec', label: 'Cooldown after a switch (seconds)' },
  { key: 'noReturnSec', label: 'No return to a route left (seconds)' },
  { key: 'minLeadDistanceM', label: 'Minimum distance to the turn (meters)' },
  { key: 'minLeadTimeSec', label: 'Minimum time to the turn (seconds)' },
  { key: 'freewayLeadDistanceM', label: 'Minimum distance to a freeway exit (meters)' },
  { key: 'routeLostPolls', label: 'Checks before leaving a route no longer offered' },
]

function NumberSetting({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="setting">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        // Rounded for display only: 0.05 x 100 is not exactly 5.
        value={Math.round(value * 1000) / 1000}
        onChange={(e) => {
          const n = e.target.valueAsNumber
          if (Number.isFinite(n) && n >= 0) onChange(n)
        }}
      />
    </label>
  )
}

/**
 * The "Simulate drive" controls, the thresholds, the what-if control and the
 * event log. Presentation only: the drive is run by useDriveSim, the
 * decisions and their wording come from src/core/reroute.ts.
 */
export function DrivePanel({ sim, showWhatIf = false }: DrivePanelProps) {
  const [whatIfMin, setWhatIfMin] = useState(5)
  const { status, view, settings, rerouteOptions } = sim
  const active = status !== 'idle'
  const log = view === null ? [] : [...view.log].reverse()

  return (
    <section className="drive" aria-label="Simulated drive">
      <h3>Simulate drive</h3>
      <div className="drive-row" role="group" aria-label="Simulation speed">
        {SPEED_MULTIPLIERS.map((m) => (
          <button key={m} type="button" aria-pressed={sim.multiplier === m} onClick={() => sim.setMultiplier(m)}>
            {m}×
          </button>
        ))}
      </div>
      <div className="drive-row">
        {!active && (
          <button type="button" onClick={sim.start} disabled={!sim.canStart}>
            Start drive
          </button>
        )}
        {status === 'running' && (
          <button type="button" onClick={sim.pause}>
            Pause
          </button>
        )}
        {status === 'paused' && (
          <button type="button" onClick={sim.resume}>
            Resume
          </button>
        )}
        {status === 'arrived' && (
          <button type="button" onClick={sim.start} disabled={!sim.canStart}>
            Drive again
          </button>
        )}
        {active && (
          <button type="button" onClick={sim.stop}>
            Stop
          </button>
        )}
      </div>
      {view === null ? (
        <p className="hint">
          A simulated car drives the selected route and changes route by itself when a faster one holds up. It asks
          Mapbox for fresh routes every {settings.pollIntervalSec} s of simulated time: at most one request per{' '}
          {MIN_REQUEST_GAP_MS / 1000} real seconds and {settings.maxRequests} per drive.
        </p>
      ) : (
        <p className="drive-status" role="status">
          {status === 'arrived' ? 'Arrived' : status === 'paused' ? 'Paused' : view.polling ? 'Checking routes…' : 'Driving'}
          {' · '}simulated time {formatSimClock(view.simTimeSec)}
          {' · '}
          {formatDistance(view.remainingM)} to go
          <br />
          Directions requests: {view.requestsUsed} of {settings.maxRequests} (at most one per{' '}
          {MIN_REQUEST_GAP_MS / 1000} s)
        </p>
      )}

      {showWhatIf && (
        <div className="whatif">
          <strong>What-if (simulated, not real traffic)</strong>
          <div className="drive-row">
            <label className="setting">
              <span>Delay on the current route (minutes)</span>
              <input
                type="number"
                min={1}
                max={60}
                value={whatIfMin}
                onChange={(e) => {
                  const n = e.target.valueAsNumber
                  if (Number.isFinite(n) && n > 0) setWhatIfMin(Math.min(60, n))
                }}
              />
            </label>
          </div>
          <div className="drive-row">
            <button type="button" disabled={!active} onClick={() => sim.setWhatIfDelaySec(whatIfMin * 60)}>
              Add delay from the next check
            </button>
            {sim.whatIfDelaySec > 0 && (
              <button type="button" onClick={() => sim.setWhatIfDelaySec(0)}>
                Clear
              </button>
            )}
          </div>
          {sim.whatIfDelaySec > 0 && (
            <p className="hint" role="status">
              Simulated: +{formatDuration(sim.whatIfDelaySec)} on the current route's ETA at every check, until a
              switch or Clear.
            </p>
          )}
        </div>
      )}

      <details className="drive-settings">
        <summary>Reroute settings</summary>
        <NumberSetting
          label={`Check every (simulated seconds, at least ${MIN_POLL_INTERVAL_SEC})`}
          value={settings.pollIntervalSec}
          onChange={(n) => sim.setSettings({ ...settings, pollIntervalSec: Math.max(MIN_POLL_INTERVAL_SEC, n) })}
        />
        <NumberSetting
          label="Directions requests per drive (at most)"
          value={settings.maxRequests}
          onChange={(n) => sim.setSettings({ ...settings, maxRequests: Math.round(n) })}
        />
        {THRESHOLDS.map(({ key, label, scale = 1 }) => (
          <NumberSetting
            key={key}
            label={label}
            value={(rerouteOptions[key] as number) * scale}
            onChange={(n) => sim.setRerouteOptions({ ...rerouteOptions, [key]: n / scale })}
          />
        ))}
        <button
          type="button"
          className="link"
          onClick={() => {
            sim.setSettings(DEFAULT_DRIVE_SETTINGS)
            sim.setRerouteOptions(DEFAULT_REROUTE_OPTIONS)
          }}
        >
          Reset to defaults
        </button>
        <p className="hint">Changes apply from the next check.</p>
      </details>

      {log.length > 0 && (
        <ol className="drive-log" aria-label="Drive log, newest first">
          {log.map((entry) => (
            <li key={entry.id} className={`drive-log-${entry.kind}`}>
              <span className="drive-log-time">{formatSimClock(entry.simTimeSec)}</span> {entry.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
