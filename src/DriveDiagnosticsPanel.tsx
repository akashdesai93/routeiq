import { useEffect, useRef, useState } from 'react'
import { shellDiagnostics, type DriveDiagnostics } from './device/native/diagnostics.ts'

interface Props {
  log?: Pick<DriveDiagnostics, 'text'>
  onClose: () => void
  /** Swapped out in tests. Resolves when the text is on the clipboard. */
  copy?: (text: string) => Promise<void>
}

/** The clipboard, where the web view offers it; the old "copy the selection" otherwise. */
async function copyText(text: string, field: HTMLTextAreaElement | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Not offered here: try the selection.
  }
  if (field === null) throw new Error('nothing to select')
  field.focus()
  field.select()
  field.setSelectionRange(0, field.value.length)
  if (!document.execCommand('copy')) throw new Error('copy refused')
}

/**
 * The iPhone app's "Drive diagnostics": what iOS let the app do during a
 * drive, as counts and timings (see device/native/diagnostics.ts: no
 * position and no token is ever in it). For reading after a drive and
 * sending on with Copy. Shows nothing by itself: ShellApp opens it.
 */
export function DriveDiagnosticsPanel({ log = shellDiagnostics, onClose, copy }: Props) {
  const [text, setText] = useState(() => log.text())
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  const field = useRef<HTMLTextAreaElement>(null)
  // The counts move on while the panel is open.
  useEffect(() => {
    const id = setInterval(() => setText(log.text()), 2000)
    return () => clearInterval(id)
  }, [log])

  const onCopy = () => {
    const now = log.text()
    setText(now)
    void (copy ?? ((t: string) => copyText(t, field.current)))(now).then(
      () => setCopied('yes'),
      () => setCopied('failed'),
    )
  }

  return (
    <section className="diagnostics" aria-label="Drive diagnostics">
      <div className="diagnostics-head">
        <strong>Drive diagnostics</strong>
        <button type="button" onClick={onCopy}>
          Copy
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="diagnostics-note" role="status">
        {copied === 'yes'
          ? 'Copied. Paste it into a message.'
          : copied === 'failed'
            ? 'Could not copy. Press and hold the text, Select All, then Copy.'
            : 'Counts and timings only: no positions, no token. Kept until the app is closed.'}
      </p>
      <textarea ref={field} className="diagnostics-text" readOnly value={text} rows={16} aria-label="Diagnostics text" />
    </section>
  )
}
