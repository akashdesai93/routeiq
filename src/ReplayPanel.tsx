import { REPLAY_MULTIPLIERS } from './drive/replay.ts'
import type { ReplaySetup } from './drive/replaySetup.ts'

const TOGGLES: readonly { key: 'noise' | 'dropouts' | 'stop' | 'tunnel' | 'wrongTurn'; label: string }[] = [
  { key: 'noise', label: 'Noise (6 m)' },
  { key: 'dropouts', label: 'Dropouts (20 s and 25 s without fixes)' },
  { key: 'stop', label: 'A 45 s stop after 1.5 km' },
  { key: 'tunnel', label: 'A tunnel from 6 km to 7.5 km' },
  { key: 'wrongTurn', label: 'A wrong turn after 3 km' },
]

/**
 * Development only, like the what-if control: makes "Start drive" run on a
 * replayed driver that starts at the origin pin, through the same code as
 * the device's GPS. Presentation only; the driver is drive/replay.ts.
 */
export function ReplayPanel({ setup, onChange }: { setup: ReplaySetup; onChange: (setup: ReplaySetup) => void }) {
  return (
    <div className="whatif replay">
      <label className="check">
        <input type="checkbox" checked={setup.enabled} onChange={(e) => onChange({ ...setup, enabled: e.target.checked })} />
        <strong>GPS replay (development, simulated position)</strong>
      </label>
      {setup.enabled && (
        <>
          <p className="hint">Start drive then follows a made-up car from the origin pin, not this device.</p>
          <div className="drive-row" role="group" aria-label="Replay speed">
            {REPLAY_MULTIPLIERS.map((m) => (
              <button key={m} type="button" aria-pressed={setup.multiplier === m} onClick={() => onChange({ ...setup, multiplier: m })}>
                {m}×
              </button>
            ))}
          </div>
          {TOGGLES.map(({ key, label }) => (
            <label key={key} className="check">
              <input type="checkbox" checked={setup[key]} onChange={(e) => onChange({ ...setup, [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </>
      )}
    </div>
  )
}
