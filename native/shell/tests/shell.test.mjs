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
  assert.equal(/@objc\(/.test(readFileSync(new URL('RouteIQSimulation.swift', dir), 'utf8')), false);
  assert.equal(/@objc\(/.test(readFileSync(new URL('RouteIQStillness.swift', dir), 'utf8')), false);
});

test('positions and request addresses are never logged or stored by the native code', () => {
  const dir = new URL('../shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith('.swift'));
  assert.deepEqual(names.sort(), ['RouteIQEngine.swift', 'RouteIQHttp.swift', 'RouteIQNativePlugin.swift', 'RouteIQSimulation.swift', 'RouteIQStillness.swift']);
  for (const name of names) {
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

test('battery work never lowers the GPS: the drive keeps BestForNavigation, no distance filter, never paused (#98)', () => {
  const dir = new URL('../shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url);
  const engine = readFileSync(new URL('RouteIQEngine.swift', dir), 'utf8');
  // The owner's decision on #98: the accuracy stays, and so does what keeps the app running when locked.
  assert.match(engine, /manager\.desiredAccuracy = kCLLocationAccuracyBestForNavigation/);
  assert.equal(engine.match(/\.distanceFilter = /g)?.length, 1);
  assert.match(engine, /manager\.distanceFilter = kCLDistanceFilterNone/);
  assert.equal(engine.match(/\.pausesLocationUpdatesAutomatically = /g)?.length, 1);
  assert.match(engine, /manager\.pausesLocationUpdatesAutomatically = false/);
  assert.match(engine, /manager\.activityType = \.automotiveNavigation/);
  // Only the drive's stream asks for BestForNavigation; one-shot "Use my location" asks for Best. Nothing asks for less.
  assert.equal(/kCLLocationAccuracy(HundredMeters|Kilometer|ThreeKilometers|NearestTenMeters|Reduced)/.test(engine), false);
  // A fix and a tick reach the web app only through the standing-still rule (RouteIQStillness).
  assert.match(engine, /guard stillness\.fix\(/);
  assert.match(engine, /guard self\.stillness\.tick\(/);
  assert.equal(engine.match(/onFix\?\(fix\)/g)?.length, 2, 'onFix only inside forward()');
});
