// Checks and edits on the built web app before it goes into the iPhone shell.
// Pure functions over text, so they are tested without building anything.

/** The script the shell loads before the web app, and the tag that loads it. */
export const BRIDGE_FILE = 'routeiq-native.js';
const BRIDGE_TAG = `<script src="/${BRIDGE_FILE}"></script>`;

/**
 * Adds the bridge script to the built index.html, ahead of the app's own
 * module script, so the plugin is in place when the app starts. A classic
 * script in <head> runs before any module script.
 * @param {string} html
 * @returns {string}
 */
export function injectBridge(html) {
  if (html.includes(BRIDGE_TAG)) return html;
  if (!html.includes('</head>')) throw new Error('index.html has no </head> to put the bridge script before');
  if (!/<script[^>]+type="module"/.test(html)) throw new Error('index.html has no module script: is this the built app?');
  return html.replace('</head>', `  ${BRIDGE_TAG}\n  </head>`);
}

// A Mapbox token is "pk." or "sk." followed by a JWT-like body, which always
// starts with "eyJ" (base64 of '{"'). Help texts such as "starts with pk." do
// not match.
const TOKEN = /\b([ps]k)\.eyJ[A-Za-z0-9_-]{8,}/g;

/**
 * The Mapbox tokens found in a built file. The shell is built in public and
 * its .ipa is a public download, so there must be none.
 * @param {string} text
 * @returns {string[]} what was found, shortened so a log never shows a whole token.
 */
export function findTokens(text) {
  return [...text.matchAll(TOKEN)].map((m) => `${m[0].slice(0, 6)}… (${m[0].length} characters)`);
}

/**
 * True when URLs in the built index.html start at the site root, which is
 * where Capacitor serves the app from (capacitor://localhost/).
 * @param {string} html
 */
export function usesRootPaths(html) {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  return refs.length > 0 && refs.every((ref) => ref.startsWith('/') && !ref.startsWith('//'));
}

/**
 * The simulator drive's page script (sim/, the CI run in the iOS Simulator):
 * it answers route requests from a made-up road network on the build machine
 * and presses Start drive by itself. Only sim/prepare.mjs adds it to www/,
 * after this build, and it must never be in an app that goes on a phone.
 */
export const SIM_FILE = 'routeiq-sim.js';

/**
 * True when a built file loads or mentions the simulator drive's script. The
 * phone build fails on it (build-web.mjs), and the finished app is searched
 * again in .github/workflows/shell-ios.yml.
 * @param {string} text
 */
export function hasSimHook(text) {
  return text.includes('routeiq-sim');
}

/**
 * Adds the simulator drive's script to a built index.html, right after the
 * bridge script (it wraps the plugin the bridge puts on the page). `base` is
 * where the stub server listens; only this machine itself is accepted.
 * @param {string} html
 * @param {string} base
 * @param {string} [token] a real public token for the map, when the run has one
 * @returns {string}
 */
export function injectSim(html, base, token = '') {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(base)) throw new Error('The stub server must be on this machine: http://127.0.0.1:<port>');
  if (token !== '' && !/^pk\.[A-Za-z0-9._-]+$/.test(token)) throw new Error('The map token for the simulator must be a public token (pk.)');
  if (hasSimHook(html)) throw new Error('index.html already loads the simulator drive script');
  if (!html.includes(BRIDGE_TAG)) throw new Error('index.html has no bridge script: run "npm run build" first');
  const tokenPart = token === '' ? '' : ` data-token="${token}"`;
  return html.replace(BRIDGE_TAG, `${BRIDGE_TAG}\n    <script src="/${SIM_FILE}" data-base="${base}"${tokenPart}></script>`);
}
