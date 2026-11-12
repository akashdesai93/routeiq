import { tokenErrorHelp } from '../../config.ts'

/** The part of `fetch` a Mapbox client uses: any HTTP answer resolves, no answer or an abort rejects. */
export type MapboxFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>

/** A failure every Mapbox API shares, worded by the client for its own API. */
export interface MapboxFailure {
  readonly ok: false
  readonly kind: 'aborted' | 'network' | 'token' | 'rate-limit'
  readonly message: string
}

/** The user-facing words for the failures a client does not parse itself. */
export interface MapboxMessages {
  readonly aborted: string
  readonly network: string
  readonly rateLimit: string
}

/**
 * One GET to a Mapbox API. Never rejects: no answer, an abort (checked again
 * after the answer), a token problem (401, 403) and rate limiting (429) come
 * back as a MapboxFailure; any other answer as its status and JSON body (null
 * when the body is not JSON).
 */
export async function mapboxGet(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: MapboxFetch,
  messages: MapboxMessages,
): Promise<{ readonly status: number; readonly body: unknown } | MapboxFailure> {
  let status: number
  let body: unknown = null
  try {
    const response = await fetchImpl(url, { signal })
    status = response.status
    // Error bodies below 500 are JSON too ({ code, message }); anything else stays null.
    body = await response.json().catch(() => null)
  } catch {
    if (signal?.aborted) return { ok: false, kind: 'aborted', message: messages.aborted }
    // The thrown error is deliberately not shown: it adds nothing for the user, and can quote the URL.
    return { ok: false, kind: 'network', message: messages.network }
  }
  if (signal?.aborted) return { ok: false, kind: 'aborted', message: messages.aborted }
  const tokenHelp = tokenErrorHelp(status)
  if (tokenHelp !== null) return { ok: false, kind: 'token', message: tokenHelp }
  if (status === 429) return { ok: false, kind: 'rate-limit', message: messages.rateLimit }
  return { status, body }
}

/** Belt and braces: an API message that echoes the request must not show the token. */
export function redactToken<T extends { readonly ok: true } | { readonly ok: false; readonly message: string }>(result: T, token: string): T {
  if (result.ok || token === '' || !result.message.includes(token)) return result
  return { ...result, message: result.message.replaceAll(token, '[token]') }
}
