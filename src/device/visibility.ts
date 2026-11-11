/** The part of `document` that is used, so a test can hand in a stand-in. */
export interface VisibilityDocumentLike {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** Whether the page is in front. A live drive in a browser only runs while it is. */
export interface PageVisibility {
  isHidden(): boolean
  /** Calls `listener` with the new answer whenever it changes; returns the function that stops that. */
  subscribe(listener: (hidden: boolean) => void): () => void
}

function defaultDocument(): VisibilityDocumentLike | null {
  try {
    return (globalThis as { document?: VisibilityDocumentLike }).document ?? null
  } catch {
    return null
  }
}

/** The Page Visibility API, or "always in front" where there is none. */
export function pageVisibility(doc: VisibilityDocumentLike | null = defaultDocument()): PageVisibility {
  const isHidden = () => doc !== null && doc.visibilityState === 'hidden'
  return {
    isHidden,
    subscribe(listener) {
      if (doc === null) return () => {}
      const onChange = () => listener(isHidden())
      doc.addEventListener('visibilitychange', onChange)
      return () => doc.removeEventListener('visibilitychange', onChange)
    },
  }
}
