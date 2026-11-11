// Generates the Xcode project (ios/) from scratch and applies the probe's
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iosDir = path.join(root, 'ios');
const infoPlistPath = path.join(iosDir, 'App/App/Info.plist');
const packageSwiftPath = path.join(iosDir, 'App/CapApp-SPM/Package.swift');
const nativeConfigPath = path.join(iosDir, 'App/App/capacitor.config.json');

if (!existsSync(path.join(root, 'www/app.js'))) {
  throw new Error('www/app.js is missing. Run "npm run build" first.');
}

rmSync(iosDir, { recursive: true, force: true });
const cap = path.join(root, 'node_modules/@capacitor/cli/bin/capacitor');
execFileSync(process.execPath, [cap, 'add', 'ios'], { cwd: root, stdio: 'inherit' });

writeFileSync(infoPlistPath, patchInfoPlist(readFileSync(infoPlistPath, 'utf8')));
checkInfoPlist(readFileSync(infoPlistPath, 'utf8'));

// Fail here, with a clear message, rather than deep inside xcodebuild.
const packageSwift = readFileSync(packageSwiftPath, 'utf8');
for (const product of ['RouteiqProbeNative', 'CapacitorCommunityBackgroundGeolocation']) {
  if (!packageSwift.includes(`.product(name: "${product}"`)) {
    throw new Error(`CapApp-SPM/Package.swift does not link ${product}`);
  }
}
const classes = JSON.parse(readFileSync(nativeConfigPath, 'utf8')).packageClassList ?? [];
for (const name of ['ProbeNativePlugin', 'BackgroundGeolocation']) {
  if (!classes.includes(name)) {
    throw new Error(`Plugin class ${name} was not registered (packageClassList: ${classes.join(', ')})`);
  }
}
if (!existsSync(path.join(iosDir, 'App/App/public/app.js'))) {
  throw new Error('The web bundle was not copied into the iOS project.');
}

console.log('iOS project generated and patched:');
console.log(`  plugins: ${classes.join(', ')}`);
console.log('  Info.plist: background modes location + audio, location usage strings');
