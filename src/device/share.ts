/**
 * Handing text on: the share sheet where the web view offers one (Safari on
 * the iPhone, the shell's web view where iOS allows it), the clipboard
 * otherwise. Nothing is sent anywhere by this module itself: the owner picks
 * where the text goes, or pastes it.
 */

interface ShareNavigator {
  share?: (data: { title?: string; text?: string }) => Promise<void>
  clipboard?: { writeText: (text: string) => Promise<void> }
}

function nav(): ShareNavigator | null {
  try {
    return (globalThis.navigator as ShareNavigator | undefined) ?? null
  } catch {
    return null
  }
}

/** True when there is a share sheet to open. */
export function canShare(): boolean {
  return typeof nav()?.share === 'function'
}

/** Opens the share sheet. 'cancelled' when the owner closed it; 'failed' when it could not open. */
export async function shareText(title: string, text: string): Promise<'shared' | 'cancelled' | 'failed'> {
  const share = nav()?.share
  if (typeof share !== 'function') return 'failed'
  try {
    await share.call(nav(), { title, text })
    return 'shared'
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed'
  }
}

/** The clipboard, where the web view offers it; selecting `field` and "copy" otherwise. Rejects when neither works. */
export async function copyText(text: string, field: HTMLTextAreaElement | null): Promise<void> {
  try {
    const clipboard = nav()?.clipboard
    if (clipboard !== undefined) {
      await clipboard.writeText(text)
      return
    }
  } catch {
    // Not allowed here: try the selection.
  }
  if (field === null) throw new Error('nothing to select')
  field.focus()
  field.select()
  field.setSelectionRange(0, field.value.length)
  if (!document.execCommand('copy')) throw new Error('copy refused')
}
