import test from 'node:test';
import assert from 'node:assert/strict';
import plist from 'plist';
import { checkInfoPlist, patchInfoPlist } from '../scripts/info-plist.mjs';

const TEMPLATE = plist.build({
  CFBundleDisplayName: 'RouteIQ Probe',
  UILaunchStoryboardName: 'LaunchScreen',
});

test('patch adds both background modes and both location usage strings', () => {
  const info = plist.parse(patchInfoPlist(TEMPLATE));
  assert.deepEqual(info.UIBackgroundModes, ['location', 'audio']);
  assert.ok(info.NSLocationWhenInUseUsageDescription.length > 20);
  assert.ok(info.NSLocationAlwaysAndWhenInUseUsageDescription.length > 20);
  assert.equal(info.UIFileSharingEnabled, true);
  assert.equal(info.CFBundleDisplayName, 'RouteIQ Probe');
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
