import { useEffect, useMemo, useRef, useState } from 'react'
import { shellDiagnostics, type DriveDiagnostics } from './device/native/diagnostics.ts'
import { readLastDrive } from './device/native/lastDrive.ts'
import { copyText, pluginShare } from './device/share.ts'
import type { TextStore } from './storage/local.ts'

interface Props {
  log?: Pick<DriveDiagnostics, 'text' | 'startedAtMs'>
  onClose: () => void
  /** Swapped out in tests. Resolves when the text is on the clipboard. */
  copy?: (text: string) => Promise<void>
  /** Opens the phone's share sheet with the text. Default: the shell's plugin; without one there is no Share button. */
  share?: ((text: string) => Promise<unknown>) | null
  /** Where the last drive's diagnostics are kept (device/native/lastDrive.ts). Left out: none are shown. */
  store?: TextStore
}

function savedAt(ms: number): string {
  return new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

type Note = 'none' | 'copied' | 'copy-failed' | 'share-failed'

const NOTES: Readonly<Record<Note, string>> = {
  none: 'Counts and timings only: no positions, no token. The last drive is also kept on this phone.',
  copied: 'Copied. Paste it into a message.',
  'copy-failed': 'Could not copy. Press and hold the text, Select All, then Copy.',
  'share-failed': 'Could not open the share sheet. Use Copy instead.',
}

/**
 * The iPhone app's "Drive diagnostics": what iOS let the app do during a
 * drive, as counts and timings (see device/native/diagnostics.ts: no
 * position and no token is ever in it). For reading after or during a drive
 * and sending on with Share or Copy. After the app was closed and opened
 * again, the drive before that is still here as "Last drive". Shows nothing
 * by itself: ShellApp opens it.
 */
export function DriveDiagnosticsPanel({ log = shellDiagnostics, onClose, copy, share, store }: Props) {
  const [text, setText] = useState(() => log.text())
  const [note, setNote] = useState<Note>('none')
  const field = useRef<HTMLTextAreaElement>(null)
  // The drive before the app was last closed: what was saved before this log began.
  const last = useMemo(() => {
    const kept = store === undefined ? null : readLastDrive(store)
    return kept !== null && kept.savedAtMs < log.startedAtMs ? kept : null
  }, [store, log])
  const [showLast, setShowLast] = useState(last !== null)
  const sharing = useMemo(() => (share === undefined ? pluginShare() : share), [share])
  // The counts move on while the panel is open.
  useEffect(() => {
    const id = setInterval(() => setText(log.text()), 2000)
    return () => clearInterval(id)
  }, [log])

  const viewingLast = showLast && last !== null
  const shown = viewingLast ? last.text : text
  /** What Copy and Share send: the last drive as it was saved, or the log as it is this moment. */
  const current = () => {
    if (viewingLast) return last.text
    const now = log.text()
    setText(now)
    return now
  }
  const onCopy = () => {
    void (copy ?? ((t: string) => copyText(t, field.current)))(current()).then(
      () => setNote('copied'),
      () => setNote('copy-failed'),
    )
  }
  const onShare = () => {
    if (sharing === null) return
    void sharing(current()).then(
      () => setNote('none'),
      () => setNote('share-failed'),
    )
  }

  return (
    <section className="diagnostics" aria-label="Drive diagnostics">
      <div className="diagnostics-head">
        <strong>Drive diagnostics</strong>
        {sharing !== null && (
          <button type="button" onClick={onShare}>
            Share
          </button>
        )}
        <button type="button" onClick={onCopy}>
          Copy
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {last !== null && (
        <div className="diagnostics-which" role="group" aria-label="Which drive">
          <button type="button" aria-pressed={viewingLast} onClick={() => setShowLast(true)}>
            Last drive (saved {savedAt(last.savedAtMs)})
          </button>
          <button type="button" aria-pressed={!viewingLast} onClick={() => setShowLast(false)}>
            Since the app opened
          </button>
        </div>
      )}
      <p className="diagnostics-note" role="status">
        {NOTES[note]}
      </p>
      <textarea ref={field} className="diagnostics-text" readOnly value={shown} rows={16} aria-label="Diagnostics text" />
    </section>
  )
}
