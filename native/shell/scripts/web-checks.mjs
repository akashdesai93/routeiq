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
