import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { build, parse } from 'plist';
import { checkInfoPlist, patchInfoPlist } from '../scripts/info-plist.mjs';
import { findTokens, injectBridge, usesRootPaths } from '../scripts/web-checks.mjs';

const TEMPLATE = build({
  CFBundleDisplayName: 'RouteIQ',
  UILaunchStoryboardName: 'LaunchScreen',
});

test('patch adds both background modes and both location usage strings', () => {
  const info = parse(patchInfoPlist(TEMPLATE));
  assert.deepEqual(info.UIBackgroundModes, ['location', 'audio']);
  assert.ok(info.NSLocationWhenInUseUsageDescription.length > 20);
  assert.ok(info.NSLocationAlwaysAndWhenInUseUsageDescription.length > 20);
  assert.equal(info.CFBundleDisplayName, 'RouteIQ');
});

test('patch is idempotent and keeps modes that were already there', () => {
  const withMode = build({ UIBackgroundModes: ['fetch', 'audio'] });
  const once = patchInfoPlist(withMode);
  const twice = patchInfoPlist(once);
  assert.equal(once, twice);
  assert.deepEqual(parse(twice).UIBackgroundModes, ['fetch', 'audio', 'location']);
});

test('check rejects an unpatched plist and accepts a patched one', () => {
  assert.throws(() => checkInfoPlist(TEMPLATE), /UIBackgroundModes lacks "location"/);
  assert.doesNotThrow(() => checkInfoPlist(patchInfoPlist(TEMPLATE)));
});

const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>RouteIQ</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

test('the bridge script is added once, in the head', () => {
  const once = injectBridge(BUILT);
  assert.match(once, /<script src="\/routeiq-native\.js"><\/script>\s*<\/head>/);
  assert.equal(injectBridge(once), once);
  assert.throws(() => injectBridge('<html><body></body></html>'), /no <\/head>/);
  assert.throws(() => injectBridge('<html><head></head></html>'), /module script/);
});

test('the built page must load everything from the site root', () => {
  assert.equal(usesRootPaths(injectBridge(BUILT)), true);
  assert.equal(usesRootPaths(BUILT.replace('/assets/index-abc.js', './assets/index-abc.js')), false);
  assert.equal(usesRootPaths(BUILT.replace('/assets/index-abc.css', 'https://example.com/x.css')), false);
});

test('a Mapbox token in the build is found, public or secret, and never printed whole', () => {
  const body = 'eyJ1IjoiZXhhbXBsZSIsImEiOiJub3QtYS1yZWFsLXRva2VuIn0.c2lnbmF0dXJl';
  const found = findTokens(`const t="pk.${body}";const s='sk.${body}'`);
  assert.equal(found.length, 2);
  assert.ok(found.every((hit) => !hit.includes(body)));
});

test('help text about tokens is not a token', () => {
  assert.deepEqual(findTokens('It starts with pk. and a secret token (sk.) is refused. pk.test pk.your_public_token_here'), []);
});

test('the Swift files follow the rule the Capacitor CLI relies on', () => {
  const dir = new URL('../shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url);
  const plugin = readFileSync(new URL('RouteIQNativePlugin.swift', dir), 'utf8');
  const engine = readFileSync(new URL('RouteIQEngine.swift', dir), 'utf8');
  // The CLI registers the first Objective-C name annotation of each file as a plugin class.
  assert.equal(plugin.match(/@objc\(([A-Za-z]+)\)/)?.[1], 'RouteIQNativePlugin');
  assert.equal(/@objc\(/.test(engine), false);
  assert.equal(/@objc\(/.test(readFileSync(new URL('RouteIQHttp.swift', dir), 'utf8')), false);
  assert.equal(/@objc\(/.test(readFileSync(new URL('RouteIQLab.swift', dir), 'utf8')), false);
  assert.equal(/@objc\(/.test(readFileSync(new URL('RouteIQSimulation.swift', dir), 'utf8')), false);
});

test('positions and request addresses are never logged or stored by the native code', () => {
  const dir = new URL('../shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith('.swift'));
  assert.deepEqual(names.sort(), ['RouteIQEngine.swift', 'RouteIQHttp.swift', 'RouteIQLab.swift', 'RouteIQNativePlugin.swift', 'RouteIQSimulation.swift']);
  // RouteIQLab.swift writes the phone lab's report file; the tests below hold it to its launch argument.
  for (const name of names.filter((n) => n !== 'RouteIQLab.swift')) {
    const swift = readFileSync(new URL(name, dir), 'utf8');
    for (const banned of ['print(', 'NSLog(', 'os_log', 'Logger(', 'FileManager', 'write(to', 'debugPrint', 'dump(']) {
      assert.equal(swift.includes(banned), false, `${name} uses ${banned}`);
    }
  }
});

test('native route requests go to Mapbox only, are not redirected, and say nothing about the address', () => {
  const dir = new URL('../shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url);
  const http = readFileSync(new URL('RouteIQHttp.swift', dir), 'utf8');
  const plugin = readFileSync(new URL('RouteIQNativePlugin.swift', dir), 'utf8');
  // The one allowed address, checked as text and again as a parsed URL.
  assert.match(http, /static let allowedPrefix = "https:\/\/api\.mapbox\.com\/"/);
  assert.match(http, /text\.hasPrefix\(allowedPrefix\)/);
  assert.match(http, /parts\.host == allowedHost/);
  assert.equal([...http.matchAll(/https?:\/\/[^"\s]+/g)].every((m) => m[0].startsWith('https://api.mapbox.com/')), true);
  // A redirect is answered with "do not follow".
  assert.match(http, /willPerformHTTPRedirection[\s\S]*?completionHandler\(nil\)/);
  // Cancelling really cancels the URLSession task.
  assert.match(http, /entry\.task\?\.cancel\(\)/);
  // An error's own text can hold the URL: only fixed words and the failure's kind are passed on.
  // The request file builds no text at all; the plugin never puts the URL into one.
  assert.equal(http.includes('\\('), false);
  assert.equal(/\\\((url|text|request)\b/.test(plugin), false);
  for (const swift of [http, plugin]) assert.equal(swift.includes('localizedDescription'), false);
  // Both methods are registered with Capacitor.
  assert.match(plugin, /CAPPluginMethod\(name: "httpGet"/);
  assert.match(plugin, /CAPPluginMethod\(name: "httpCancel"/);
});

// The phone lab (docs/phone-lab.md). These read the Swift source, as the tests above do: there
// is no Mac here to run it. What the lab does on a phone is shown by scripts/phone/lab.
const swiftSource = (name) => readFileSync(new URL(`../shell-native/ios/Sources/RouteIQNativePlugin/${name}`, import.meta.url), 'utf8');

/** The body of `static func name(...)` or `func name(...)`, up to the closing brace at its indent. */
function swiftFunction(source, name) {
  const start = source.search(new RegExp(`^( *)(?:@objc |private |static )*func ${name}[(]`, 'm'));
  assert.notEqual(start, -1, `func ${name} not found`);
  const indent = source.slice(start).match(/^ */)[0];
  const end = source.indexOf('\n' + indent + '}\n', start);
  assert.notEqual(end, -1, `end of func ${name} not found`);
  return source.slice(start, end);
}

test('the lab is off without its launch argument: every lab entry point checks it before doing anything', () => {
  const lab = swiftSource('RouteIQLab.swift');
  const plugin = swiftSource('RouteIQNativePlugin.swift');
  // The scenario comes from the launch arguments only (not from stored settings, which outlive a launch).
  const scenario = swiftFunction(lab, 'scenario');
  assert.match(scenario, /arguments\.firstIndex\(of: argument\)/);
  assert.match(scenario, /return nil/);
  assert.equal(lab.includes('UserDefaults'), false);
  // Writing the report and loading a pushed web app both start with "is the lab on?".
  for (const name of ['writeReport', 'webDirectory']) {
    const body = swiftFunction(lab, name);
    const guard = body.indexOf('guard scenario(arguments: arguments) != nil');
    assert.notEqual(guard, -1, `${name} does not check the launch argument`);
    assert.ok(guard < body.indexOf('FileManager'), `${name} touches files before checking the launch argument`);
  }
  // In the plugin: the inspectable web view and the pushed web app sit behind the same check.
  const setUp = swiftFunction(plugin, 'setUpLab');
  const check = setUp.indexOf('guard RouteIQLab.scenario() != nil else { return }');
  assert.notEqual(check, -1);
  assert.ok(check < setUp.indexOf('isInspectable'));
  assert.ok(check < setUp.indexOf('setServerBasePath'));
  assert.equal(plugin.split('isInspectable').length, 2, 'isInspectable is set in one place only');
  assert.equal(plugin.split('setServerBasePath').length, 2, 'the web folder is swapped in one place only');
  // The report goes through writeReport and nowhere else.
  assert.match(swiftFunction(plugin, 'labReport'), /if RouteIQLab\.writeReport\(text\)/);
  assert.equal(plugin.includes('FileManager'), false);
});

test('the lab writes one file in the temporary folder and makes no network request', () => {
  const lab = swiftSource('RouteIQLab.swift');
  assert.equal([...lab.matchAll(/FileManager\.default\.(\w+)/g)].every((m) => ['temporaryDirectory', 'fileExists'].includes(m[1])), true);
  assert.equal([...lab.matchAll(/\.write\(to: (\w+)/g)].map((m) => m[1]).join(), 'file');
  for (const banned of ['URLSession', 'http://', 'https://', 'print(', 'NSLog(', 'os_log', 'Logger(']) {
    assert.equal(lab.includes(banned), false, `RouteIQLab.swift uses ${banned}`);
  }
});

test('the web view is not inspectable by configuration: only the lab turns it on', () => {
  const config = JSON.parse(readFileSync(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(config.ios?.webContentsDebuggingEnabled, undefined);
  assert.equal(config.server, undefined);
});

test('the web view runs edge to edge: the page fills the window and pads itself for the safe areas (#197, #136)', () => {
  // "always" made the scroll view add the safe areas to its insets: the page was 860 points tall in a
  // 922-point window, and the 62 points left showed as a black band under the driving screen's sheet.
  // The page asks for the whole screen (viewport-fit=cover) and keeps clear of the notch and the home
  // indicator with env(safe-area-inset-*) itself.
  const config = JSON.parse(readFileSync(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(config.ios?.contentInset, 'never');
  const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.match(html, /viewport-fit=cover/);
  const live = readFileSync(new URL('../../../src/live.css', import.meta.url), 'utf8');
  assert.match(live, /top: max\(12px, env\(safe-area-inset-top/);
  assert.match(live, /env\(safe-area-inset-bottom/);
});

test('a test drive replaces the GPS positions, marks its own, and ends with the drive', () => {
  const dir = new URL('../shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url);
  const engine = readFileSync(new URL('RouteIQEngine.swift', dir), 'utf8');
  const simulation = readFileSync(new URL('RouteIQSimulation.swift', dir), 'utf8');
  const plugin = readFileSync(new URL('RouteIQNativePlugin.swift', dir), 'utf8');
  // While a simulation is set, a position from the GPS is not handed on.
  assert.match(engine, /if updating && simulation == nil && location\.timestamp/);
  // Every made-up position says so.
  assert.match(simulation, /"simulated": true/);
  // Ending the location stream (End, arrival) ends the simulation and its timer.
  assert.match(engine, /func stopLocation\(\) \{[^}]*?stopSimulatedRoute\(\)/);
  assert.match(engine, /func stopSimulatedRoute\(\) \{\s*simulationTimer\?\.invalidate\(\)\s*simulationTimer = nil\s*simulation = nil/);
  // The timer runs on the main run loop in the common modes, like the tick, and holds the engine weakly.
  assert.match(engine, /let timer = Timer\(timeInterval: 1, repeats: true\) \{ \[weak self\] _ in\s*self\?\.stepSimulation\(\)\s*\}\s*RunLoop\.main\.add\(timer, forMode: \.common\)/);
  // The simulation has no clock, no storage and no network of its own.
  for (const banned of ['Date()', 'UserDefaults', 'URLSession', 'Timer', 'DispatchQueue']) {
    assert.equal(simulation.includes(banned), false, `RouteIQSimulation.swift uses ${banned}`);
  }
  // The points are never put into a message.
  assert.equal(/\\\((points|lng|lat|pair|item)\b/.test(plugin + engine + simulation), false);
  for (const name of ['startSimulatedRoute', 'stopSimulatedRoute', 'share']) {
    assert.match(plugin, new RegExp(`CAPPluginMethod\\(name: "${name}"`));
  }
});

test('sharing hands the text to the share sheet and nowhere else', () => {
  const dir = new URL('../shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url);
  const plugin = readFileSync(new URL('RouteIQNativePlugin.swift', dir), 'utf8');
  assert.match(plugin, /UIActivityViewController\(activityItems: \[text\], applicationActivities: nil\)/);
  assert.equal(plugin.includes('UIPasteboard'), false);
});
