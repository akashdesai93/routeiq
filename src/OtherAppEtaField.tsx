import { useId } from 'react'

interface Props {
  value: string
  /** Why the text is not an ETA; null when it is one, or empty. */
  problem: string | null
  onChange: (value: string) => void
}

/**
 * The owner notes what another app (Google Maps, Waze) predicted for the same
 * trip, before Start drive. It goes into the drive log only, so the Drives
 * screen can compare both predictions with the real time. Optional.
 */
export function OtherAppEtaField({ value, problem, onChange }: Props) {
  const id = useId()
  return (
    <div className="other-eta">
      <label htmlFor={id}>Other app's ETA (minutes)</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        placeholder="optional, e.g. 19"
        autoComplete="off"
        maxLength={8}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problem !== null}
      />
      {problem !== null && (
        <p className="field-status failed" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
