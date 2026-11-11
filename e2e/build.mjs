// Builds the app twice for the e2e scenarios, with made-up tokens only:
// - dist-e2e:          a well-formed dummy public token (pk.test). Every Mapbox
//                      request is answered by the test's router, never by Mapbox.
// - dist-e2e-notoken:  no token, to show the setup help.
// A value set here wins over .env.local, so a real token is never built in.
import { spawnSync } from 'node:child_process'

const builds = [
  { outDir: 'dist-e2e', token: 'pk.test' },
  { outDir: 'dist-e2e-notoken', token: 'pk.your_public_token_here' },
]
for (const { outDir, token } of builds) {
  // One command string with a shell, so `npx` resolves to npx.cmd on Windows too.
  const result = spawnSync(`npx vite build --outDir ${outDir} --emptyOutDir --logLevel warn`, {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, VITE_MAPBOX_TOKEN: token },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
