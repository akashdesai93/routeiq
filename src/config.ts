export type TokenStatus =
  | { kind: 'ok'; token: string }
  | { kind: 'missing' }
  | { kind: 'secret' }
  | { kind: 'malformed' }

/**
 * Checks the Mapbox token Vite injected from .env.local.
 * Only public tokens ("pk.") belong in a browser app.
 */
export function checkToken(raw: string | undefined): TokenStatus {
  const token = raw?.trim() ?? ''
  if (token === '' || token === 'pk.your_public_token_here') return { kind: 'missing' }
  if (token.startsWith('sk.')) return { kind: 'secret' }
  if (!token.startsWith('pk.')) return { kind: 'malformed' }
  return { kind: 'ok', token }
}

/** The origin the page is served from (the token's URL restriction must allow it); the dev server's outside a browser. */
function pageOrigin(): string {
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://localhost:5173'
}

/**
 * Turns the HTTP status of a failed Mapbox request into setup help, or null
 * when the error is not about the token (a dropped tile, for example).
 */
export function tokenErrorHelp(status: number | undefined, origin: string = pageOrigin()): string | null {
  if (status === 401)
    return 'Mapbox rejected the token (401). Check VITE_MAPBOX_TOKEN in .env.local is a valid, active public token, then restart npm run dev.'
  if (status === 403)
    return `Mapbox refused the token for this page (403). If the token has URL restrictions, add ${origin} to its allowed URLs.`
  return null
}

export const tokenStatus: TokenStatus = checkToken(import.meta.env.VITE_MAPBOX_TOKEN)
