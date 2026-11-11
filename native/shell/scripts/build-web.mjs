// Builds the real web app (the repository root) into www/ for the shell, with
// NO Mapbox token, and adds the bridge script that hands it the native plugin.
//
//   (repository root) npm ci
//   (native/shell)    npm ci && npm run build
//
// The token: this build is public (the .ipa is a public download from GitHub
// Actions), so VITE_MAPBOX_TOKEN is forced empty here, which wins over a
// developer's .env.local, and the output is searched for tokens afterwards.
// The app asks for the token on the phone instead (src/ShellRoot.tsx).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BRIDGE_FILE, findTokens, injectBridge, usesRootPaths } from './web-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
const www = path.join(root, 'www');
const vite = path.join(repo, 'node_modules/vite/bin/vite.js');

if (!existsSync(vite)) {
  throw new Error('The web app\'s dependencies are missing. Run "npm ci" in the repository root first.');
}

// Capacitor serves www/ at capacitor://localhost/, so the default base "/" is
// right: /assets/..., and the bundled signal tiles at /seed/osm-signals/...
execFileSync(process.execPath, [vite, 'build', '--outDir', www, '--emptyOutDir', '--logLevel', 'warn'], {
  cwd: repo,
  stdio: 'inherit',
  // PAGES_BASE is the GitHub Pages build's sub-path; the shell always serves from the root.
  env: { ...process.env, VITE_MAPBOX_TOKEN: '', PAGES_BASE: '' },
});

await build({
  entryPoints: [path.join(root, 'src/bridge.js')],
  outfile: path.join(www, BRIDGE_FILE),
  bundle: true,
  format: 'iife',
  target: 'safari15',
  logLevel: 'info',
});

const indexPath = path.join(www, 'index.html');
const html = injectBridge(readFileSync(indexPath, 'utf8'));
if (!usesRootPaths(html)) throw new Error('www/index.html refers to files outside the site root; the shell serves from "/".');
writeFileSync(indexPath, html);

// The bundled signal tiles must have come along: the app fetches them from /seed/osm-signals/.
const tiles = path.join(www, 'seed/osm-signals');
if (!existsSync(path.join(tiles, 'index.json'))) throw new Error('www/seed/osm-signals/index.json is missing: the signal tiles were not built in.');
const tileCount = readdirSync(tiles).filter((name) => name.endsWith('.json')).length - 1;
if (tileCount < 1) throw new Error('www/seed/osm-signals has an index but no tiles.');

// No token in anything that ships.
const leaks = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(js|mjs|css|html|json|map|txt)$/.test(name)) {
      for (const hit of findTokens(readFileSync(file, 'utf8'))) leaks.push(`${path.relative(www, file)}: ${hit}`);
    }
  }
};
walk(www);
if (leaks.length > 0) throw new Error(`A Mapbox token was built into www/. Nothing may ship with one:\n  ${leaks.join('\n  ')}`);

console.log(`Web app built into www/: no token, bridge script added, ${tileCount} signal tiles.`);
