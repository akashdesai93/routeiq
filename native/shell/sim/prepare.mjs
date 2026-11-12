// Turns the phone build into the simulator drive's build. Two steps, each
// after the script it follows:
//
//   npm run build        then   node sim/prepare.mjs www     (adds www/routeiq-sim.js and its script tag)
//   npm run ios:generate then   node sim/prepare.mjs plist   (lets the app reach http://127.0.0.1)
//
// Neither is part of "npm run build" or "npm run ios:generate", and the phone
// workflow runs neither: its app has no simulator script and no exception to
// App Transport Security (shell-ios.yml checks both).
//
// MAPBOX_PUBLIC_TOKEN_SIM (optional, a repository secret): a real public
// token for the map. Route requests are answered by the stub either way.
//
// SIM_MAP (optional, 'off' by default): 'off' makes WebGL unavailable to the
// page, so the app shows "The map could not start" and drives without a map.
// Mapbox GL in the simulator on a hosted macOS runner (no GPU) kills the web
// view's content process, which reloads the page and loses the drive.
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build, parse } from 'plist';
import { injectSim, SIM_FILE } from '../scripts/web-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SIM_PORT ?? 8521);

/** The app may load plain http from this machine, and nothing else changes. */
export function allowLocalHttp(xml) {
  const info = parse(xml);
  info.NSAppTransportSecurity = { NSAllowsLocalNetworking: true };
  return build(info);
}

async function prepareWww() {
  const indexPath = path.join(root, 'www/index.html');
  if (!existsSync(indexPath)) throw new Error('www/index.html is missing. Run "npm run build" first.');
  const token = (process.env.MAPBOX_PUBLIC_TOKEN_SIM ?? '').trim();
  const map = (process.env.SIM_MAP ?? '').trim() || 'off';
  writeFileSync(indexPath, injectSim(readFileSync(indexPath, 'utf8'), `http://127.0.0.1:${port}`, token, { map }));
  await build({
    entryPoints: [path.join(root, 'sim/page.js')],
    outfile: path.join(root, 'www', SIM_FILE),
    bundle: true,
    format: 'iife',
    target: 'safari15',
    logLevel: 'warning',
  });
  console.log(`Simulator drive script added to www/ (stub at http://127.0.0.1:${port}; map: ${map === 'off' ? 'off (no WebGL)' : token === '' ? 'made-up roads, no token' : 'Mapbox, with the secret token'}).`);
}

function preparePlist() {
  const infoPlistPath = path.join(root, 'ios/App/App/Info.plist');
  if (!existsSync(infoPlistPath)) throw new Error('ios/App/App/Info.plist is missing. Run "npm run ios:generate" first.');
  writeFileSync(infoPlistPath, allowLocalHttp(readFileSync(infoPlistPath, 'utf8')));
  if (!existsSync(path.join(root, 'ios/App/App/public', SIM_FILE))) {
    throw new Error(`ios/App/App/public/${SIM_FILE} is missing: run "node sim/prepare.mjs www" before "npm run ios:generate".`);
  }
  console.log('Info.plist: plain http to this machine is allowed (NSAllowsLocalNetworking). Simulator build only.');
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const step = process.argv[2];
  if (step === 'www') await prepareWww();
  else if (step === 'plist') preparePlist();
  else {
    console.error('usage: node sim/prepare.mjs www | plist');
    process.exitCode = 2;
  }
}
