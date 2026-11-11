// The ports the e2e test builds are served on. Several checkouts (worktrees of
// other sessions) can run `npm run e2e` at once, so each checkout gets its own
// pair, picked from its folder path: the same folder always gets the same
// ports. Set E2E_PORT to choose them yourself (that port and the next one).
// Never 5173, the dev server's.

import { createHash } from 'node:crypto'

function basePort(): number {
  const chosen = Number.parseInt(process.env.E2E_PORT ?? '', 10)
  if (Number.isInteger(chosen) && chosen > 1024 && chosen < 65535) return chosen
  const hash = createHash('sha256').update(process.cwd().toLowerCase()).digest()
  // An even port from 4300 to 5098; 5173 is out of reach.
  return 4300 + (hash.readUInt16BE(0) % 400) * 2
}

/** The build with the dummy pk.test token. */
export const APP_PORT = basePort()
/** The build with no token, for the setup help. */
export const NO_TOKEN_PORT = APP_PORT + 1
