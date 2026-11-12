import { TEST_DRIVE_MULTIPLIERS, TEST_DRIVE_PRESETS, type TestDriveSetup } from './drive/testDrive.ts'

/**
 * The iPhone app's "Test drive": makes "Start drive" follow a made-up car
 * along the selected route instead of the phone's GPS, so a wrong turn, the
 * new route and the voice can be tried at home with the phone locked. The
 * car is moved by the app's native code (device/native/simulated.ts).
 * Presentation only; the script is drive/testDrive.ts.
 */
export function TestDrivePanel({ setup, onChange }: { setup: TestDriveSetup; onChange: (setup: TestDriveSetup) => void }) {
  const preset = TEST_DRIVE_PRESETS.find((p) => p.id === setup.preset)
  return (
    <div className="whatif testdrive">
      <label className="check">
        <input type="checkbox" checked={setup.enabled} onChange={(e) => onChange({ ...setup, enabled: e.target.checked })} />
        <strong>Test drive (simulated GPS)</strong>
      </label>
      {setup.enabled && (
        <>
          <p className="hint">
            Start drive then follows a made-up car from the start of the selected route, not this phone. It keeps driving with
            the phone locked. The route requests to Mapbox are real and count against the request budget.
          </p>
          <div className="drive-row" role="group" aria-label="What the test drive does">
            {TEST_DRIVE_PRESETS.map((p) => (
              <button key={p.id} type="button" aria-pressed={setup.preset === p.id} onClick={() => onChange({ ...setup, preset: p.id })}>
                {p.label}
              </button>
            ))}
          </div>
          {preset !== undefined && <p className="hint">{preset.hint}</p>}
          <div className="drive-row" role="group" aria-label="Test drive speed">
            {TEST_DRIVE_MULTIPLIERS.map((m) => (
              <button key={m} type="button" aria-pressed={setup.multiplier === m} onClick={() => onChange({ ...setup, multiplier: m })}>
                {m}× speed
              </button>
            ))}
          </div>
          {setup.multiplier > 1 && (
            <p className="hint">
              At {setup.multiplier}× the car covers the road {setup.multiplier} times as fast, so "after 1 min" comes after{' '}
              {Math.round(60 / setup.multiplier)} s. The clock and the checks for a faster route stay in real time.
            </p>
          )}
        </>
      )}
    </div>
  )
}
