import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import plist from 'plist';
import { checkInfoPlist, patchInfoPlist } from '../scripts/info-plist.mjs';
import { findTokens, injectBridge, usesRootPaths } from '../scripts/web-checks.mjs';

const TEMPLATE = plist.build({
  CFBundleDisplayName: 'RouteIQ',
  UILaunchStoryboardName: 'LaunchScreen',
});

test('patch adds both background modes and both location usage strings', () => {
  const info = plist.parse(patchInfoPlist(TEMPLATE));
  assert.deepEqual(info.UIBackgroundModes, ['location', 'audio']);
  assert.ok(info.NSLocationWhenInUseUsageDescription.length > 20);
  assert.ok(info.NSLocationAlwaysAndWhenInUseUsageDescription.length > 20);
  assert.equal(info.CFBundleDisplayName, 'RouteIQ');
});

test('patch is idempotent and keeps modes that were already there', () => {
  const withMode = plist.build({ UIBackgroundModes: ['fetch', 'audio'] });
  const once = patchInfoPlist(withMode);
  const twice = patchInfoPlist(once);
  assert.equal(once, twice);
  assert.deepEqual(plist.parse(twice).UIBackgroundModes, ['fetch', 'audio', 'location']);
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
});

test('positions are never logged or stored by the native code', () => {
  const dir = new URL('../shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url);
  for (const name of ['RouteIQNativePlugin.swift', 'RouteIQEngine.swift']) {
    const swift = readFileSync(new URL(name, dir), 'utf8');
    for (const banned of ['print(', 'NSLog(', 'os_log', 'Logger(', 'FileManager', 'write(to']) {
      assert.equal(swift.includes(banned), false, `${name} uses ${banned}`);
    }
  }
});
