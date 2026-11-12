import { checkToken, type TokenStatus } from './config.ts'
import type { TextStore } from './storage/local.ts'

/**
 * The Mapbox token of the iPhone shell. The shell is built in public (its
 * .ipa is a public download), so no token is built in: the owner pastes a
 * public token on the phone once, and it is kept on that phone only, in the
 * app's own storage. It is sent nowhere but to Mapbox, as every request's
 * access token.
 */
export const SHELL_TOKEN_KEY = 'routeiq.shell.mapboxToken'

/** The token kept on this device, checked the same way as a built-in one. */
export function readShellToken(store: TextStore): TokenStatus {
  return checkToken(store.read(SHELL_TOKEN_KEY) ?? undefined)
}

export type SaveTokenResult =
  | { readonly ok: true; readonly token: string }
  /** 'storage': the token is fine but the device would not keep it. Nothing was stored for the other kinds either. */
  | { readonly ok: false; readonly kind: 'missing' | 'secret' | 'malformed' | 'storage' }

/** Keeps a pasted token, when it is a public one (pk.). A secret token (sk.) is refused and never stored. */
export function saveShellToken(store: TextStore, raw: string): SaveTokenResult {
  const status = checkToken(raw)
  if (status.kind !== 'ok') return { ok: false, kind: status.kind }
  if (!store.write(SHELL_TOKEN_KEY, status.token)) return { ok: false, kind: 'storage' }
  return { ok: true, token: status.token }
}

export const SHELL_TOKEN_PROBLEM: Readonly<Record<Exclude<SaveTokenResult, { ok: true }>['kind'], string>> = {
  missing: 'Paste your Mapbox public token first.',
  secret: 'That is a secret token (sk.). It is not stored. Paste a public token, which starts with pk.',
  malformed: 'That does not look like a Mapbox public token. It should start with pk.',
  storage: 'This phone would not store the token. Free some storage and try again.',
}
