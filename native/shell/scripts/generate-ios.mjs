// Generates the Xcode project (ios/) from scratch and applies the shell's
// settings. Runs on any OS; only the xcodebuild step afterwards needs a Mac.
//
//   npm run build && npm run ios:generate
//
// ios/ is not committed: it is fully determined by package-lock.json,
// capacitor.config.json and this script.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkInfoPlist, patchInfoPlist } from './info-plist.mjs';
import { BRIDGE_FILE } from './web-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iosDir = path.join(root, 'ios');
const infoPlistPath = path.join(iosDir, 'App/App/Info.plist');
const packageSwiftPath = path.join(iosDir, 'App/CapApp-SPM/Package.swift');
const nativeConfigPath = path.join(iosDir, 'App/App/capacitor.config.json');

if (!existsSync(path.join(root, 'www', BRIDGE_FILE))) {
  throw new Error(`www/${BRIDGE_FILE} is missing. Run "npm run build" first.`);
}

rmSync(iosDir, { recursive: true, force: true });
const cap = path.join(root, 'node_modules/@capacitor/cli/bin/capacitor');
// "cap add ios" creates the project and syncs: copies www/ and links the plugin.
execFileSync(process.execPath, [cap, 'add', 'ios'], { cwd: root, stdio: 'inherit' });

writeFileSync(infoPlistPath, patchInfoPlist(readFileSync(infoPlistPath, 'utf8')));
checkInfoPlist(readFileSync(infoPlistPath, 'utf8'));

// Fail here, with a clear message, rather than deep inside xcodebuild.
const packageSwift = readFileSync(packageSwiftPath, 'utf8');
if (!packageSwift.includes('.product(name: "RouteiqShellNative"')) {
  throw new Error('CapApp-SPM/Package.swift does not link RouteiqShellNative');
}
const classes = JSON.parse(readFileSync(nativeConfigPath, 'utf8')).packageClassList ?? [];
if (!classes.includes('RouteIQNativePlugin')) {
  throw new Error(`Plugin class RouteIQNativePlugin was not registered (packageClassList: ${classes.join(', ')})`);
}
for (const file of ['index.html', BRIDGE_FILE, 'seed/osm-signals/index.json']) {
  if (!existsSync(path.join(iosDir, 'App/App/public', file))) {
    throw new Error(`The web app was not copied into the iOS project (public/${file} is missing).`);
  }
}

console.log('iOS project generated and patched:');
console.log(`  plugins: ${classes.join(', ')}`);
console.log('  Info.plist: background modes location + audio, location usage strings');
