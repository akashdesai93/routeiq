import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, parse } from 'plist';
import { hasSimHook, injectBridge, injectSim, SIM_FILE } from '../scripts/web-checks.mjs';
import { patchInfoPlist } from '../scripts/info-plist.mjs';
import { allowLocalHttp } from '../sim/prepare.mjs';
import { install, readDiagnostics, simBase, simRoute, withoutToken } from '../sim/page.js';
import { pickDevice } from '../sim/pick-device.mjs';
import { Car, firstM, judge, OFF_ROUTE_LINE } from '../sim/drive.mjs';

// The simulator drive (sim/): a page script and a plain-http exception that
// exist in the simulator build only. These tests are the guard on that.

const BUILT = injectBridge(`<!doctype html>
<html lang="en">
  <head>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`);

test('the phone build has no simulator script: the build check finds one, and nothing in the build adds one', () => {
  assert.equal(hasSimHook(BUILT), false);
  assert.equal(hasSimHook(injectSim(BUILT, 'http://127.0.0.1:8521')), true);
  // The scripts of the phone build never call the simulator's.
  for (const file of ['build-web.mjs', 'generate-ios.mjs', 'info-plist.mjs']) {
    const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
    assert.equal(/injectSim|from '[^']*sim\/|allowLocalHttp|NSAppTransportSecurity/.test(source), false, file);
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.values(pkg.scripts).some((s) => s.includes('sim/')), false);
  // build-web.mjs fails on it, and the phone workflow searches the finished app.
  assert.match(readFileSync(new URL('../scripts/build-web.mjs', import.meta.url), 'utf8'), /hasSimHook\(text\)[\s\S]*throw new Error\(`The simulator drive's script is in the web build/);
  const workflow = readFileSync(new URL('../../../.github/workflows/shell-ios.yml', import.meta.url), 'utf8');
  assert.match(workflow, /grep -r -a -l 'routeiq-sim' "\$APP"/);
  assert.match(workflow, /NSAppTransportSecurity/);
});

test('the app itself knows nothing of the simulator drive', () => {
  // No hook in the web app or the Swift plugin: the script wraps the plugin from outside.
  for (const file of ['../../../src/main.tsx', '../../../src/ShellRoot.tsx', '../../../src/device/native/index.ts', '../../../src/device/native/http.ts', '../src/bridge.js']) {
    assert.equal(hasSimHook(readFileSync(new URL(file, import.meta.url), 'utf8')), false, file);
  }
  const http = readFileSync(new URL('../shell-native/ios/Sources/RouteIQNativePlugin/RouteIQHttp.swift', import.meta.url), 'utf8');
  assert.equal(/127\.0\.0\.1|localhost|targetEnvironment/.test(http), false);
});

test('the simulator script is added once, after the bridge, and only for a stub on this machine', () => {
  const html = injectSim(BUILT, 'http://127.0.0.1:8521');
  assert.match(html, /routeiq-native\.js"><\/script>\s*<script src="\/routeiq-sim\.js" data-base="http:\/\/127\.0\.0\.1:8521"><\/script>/);
  assert.equal(SIM_FILE, 'routeiq-sim.js');
  assert.throws(() => injectSim(html, 'http://127.0.0.1:8521'), /already/);
  assert.throws(() => injectSim(BUILT, 'https://example.com'), /this machine/);
  assert.throws(() => injectSim(BUILT, 'http://127.0.0.1.example.com:80'), /this machine/);
  assert.throws(() => injectSim(BUILT, 'http://127.0.0.1:8521', 'sk.secret'), /public token/);
  assert.match(injectSim(BUILT, 'http://127.0.0.1:8521', 'pk.abc.def'), /data-token="pk\.abc\.def"/);
  assert.match(injectSim(BUILT, 'http://127.0.0.1:8521', '', { map: 'off' }), /data-map="off"/);
  assert.doesNotMatch(injectSim(BUILT, 'http://127.0.0.1:8521'), /data-map/);
  assert.throws(() => injectSim(BUILT, 'http://127.0.0.1:8521', '', { map: 'maybe' }), /"on" or "off"/);
});

test('the page script does nothing without a stub on this machine', () => {
  assert.equal(simBase('http://127.0.0.1:8521'), 'http://127.0.0.1:8521');
  assert.equal(simBase('http://localhost:8521'), 'http://localhost:8521');
  for (const bad of [undefined, '', 'https://api.mapbox.com', 'http://192.168.1.5:8521', 'http://127.0.0.1:8521/x', 'http://127.0.0.1:8521@evil.example']) {
    assert.equal(simBase(bad), null);
  }
  // Nothing of the page is touched: any use of `win` would throw here.
  const untouched = new Proxy({}, { get: () => assert.fail('the page was touched'), set: () => assert.fail('the page was changed') });
  assert.equal(install(untouched, { dataset: {} }), false);
  assert.equal(install(untouched, { dataset: { base: 'https://example.com' } }), false);
  assert.equal(install(untouched, null), false);
});

test('route requests go to the stub without the token; with a real token the map is left to Mapbox', () => {
  const directions = 'https://api.mapbox.com/directions/v5/mapbox/driving-traffic/-80.8,35.2;-80.9,35.0?alternatives=true&access_token=pk.abc&steps=true';
  for (const mapStub of [true, false]) {
    assert.deepEqual(simRoute(directions, { mapStub }), { kind: 'stub', path: '/directions/v5/mapbox/driving-traffic/-80.8,35.2;-80.9,35.0?alternatives=true&steps=true' });
    assert.deepEqual(simRoute('https://overpass-api.de/api/interpreter', { mapStub }), { kind: 'busy' });
    assert.equal(simRoute('capacitor://localhost/seed/osm-signals/index.json', { mapStub }), null);
    assert.equal(simRoute('https://example.com/', { mapStub }), null);
  }
  const style = 'https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=pk.abc';
  assert.deepEqual(simRoute(style, { mapStub: true }), { kind: 'stub', path: '/styles/v1/mapbox/streets-v12' });
  assert.deepEqual(simRoute('https://events.mapbox.com/events/v2?access_token=pk.abc', { mapStub: true }), { kind: 'quiet' });
  assert.equal(simRoute(style, { mapStub: false }), null);
  assert.equal(simRoute('https://events.mapbox.com/events/v2', { mapStub: false }), null);
  assert.equal(withoutToken('/a?access_token=pk.abc'), '/a');
  assert.equal(withoutToken('/a'), '/a');
});

test('only the simulator build may load plain http, and only from this machine', () => {
  const phone = patchInfoPlist(build({ CFBundleDisplayName: 'RouteIQ' }));
  assert.equal(parse(phone).NSAppTransportSecurity, undefined);
  assert.deepEqual(parse(allowLocalHttp(phone)).NSAppTransportSecurity, { NSAllowsLocalNetworking: true });
});

const DIAGNOSTICS = `RouteIQ drive diagnostics
log started 08:00:00, now 08:03:00, app active, gps on
fixes: 151 (12 while not active), longest gap 2 s
ticks: 160 (14 while not active), longest gap 1 s
requests: 4 sent (0 while not active), 4 answered, 0 failed, 0 cancelled, 0 waiting
request time: average 20 ms, longest 31 ms
speech: 3 lines started, 3 finished, 0 cut off or failed
events (oldest first):
08:00:01 gps on [active]`;

test('the checks read the app\'s own diagnostics, the spoken lines and the stub\'s log', () => {
  assert.deepEqual(readDiagnostics(DIAGNOSTICS), { fixes: 151, fixesAway: 12, fixGapSec: 2, ticks: 160, ticksAway: 14, tickGapSec: 1, sent: 4, sentAway: 0, answered: 4, failed: 0 });
  assert.equal(readDiagnostics('nothing'), null);
  const good = { diagnostics: DIAGNOSTICS, spoken: ['RouteIQ started', OFF_ROUTE_LINE, 'New route. 15 minutes to your destination.'], directions: [{ kind: 'routes' }, { kind: 'off-route' }] };
  assert.equal(judge(good).pass, true);
  assert.equal(judge({ ...good, diagnostics: null }).pass, false);
  assert.equal(judge({ ...good, minFixes: 151 }).pass, false);
  assert.equal(judge({ ...good, spoken: ['New route. 15 minutes to your destination.', OFF_ROUTE_LINE] }).pass, false);
  assert.equal(judge({ ...good, spoken: ['RouteIQ started'] }).pass, false);
  assert.equal(judge({ ...good, directions: [{ kind: 'routes' }] }).pass, false);
  assert.equal(judge({ ...good, diagnostics: DIAGNOSTICS.replace('4 answered', '0 answered') }).pass, false);
});

test('the simulated car moves along its line at its speed and stops at the end', () => {
  let now = 0;
  const car = new Car([-80.8431, 35.2271], () => now);
  assert.deepEqual(car.position(), [-80.8431, 35.2271]);
  const line = [[-80.8431, 35.2271], [-80.8431, 35.2181]]; // about 1000 m south
  car.follow(line, 25);
  now = 20_000;
  assert.ok(Math.abs(car.drivenM() - 500) < 1);
  assert.equal(car.done(), false);
  assert.ok(Math.abs(car.position()[1] - 35.2226) < 0.0002);
  now = 60_000;
  assert.equal(car.done(), true);
  assert.deepEqual(firstM(line, 5000), line);
  assert.ok(Math.abs(firstM(line, 500).at(-1)[1] - 35.2226) < 0.0002);
});

test('a plain iPhone on the newest iOS runtime is picked', () => {
  const list = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ udid: 'old', name: 'iPhone 16', isAvailable: true }],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
        { udid: 'pad', name: 'iPad Air', isAvailable: true },
        { udid: 'pro', name: 'iPhone 17 Pro', isAvailable: true },
        { udid: 'plain', name: 'iPhone 17', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-26-2': [{ udid: 'watch', name: 'Apple Watch', isAvailable: true }],
    },
  };
  assert.equal(pickDevice(list).udid, 'plain');
  assert.equal(pickDevice(list, 'iPhone 17 Pro').udid, 'pro');
  assert.equal(pickDevice(list, 'iPhone 16').udid, 'old');
  assert.equal(pickDevice({ devices: {} }), null);
});

test('the stub hands a result only to the command that waits for it, and a bad report never stops it', async () => {
  const { startStub } = await import('../sim/stub.mjs');
  const stub = await startStub({ port: 0 });
  const post = (body) =>
    fetch(`http://127.0.0.1:${stub.port}/sim/report`, { method: 'POST', body, signal: AbortSignal.timeout(2_000) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const pending = stub.send('look', {}, 5_000);
    // Reports the page could never send: each is turned away, and none of them stops the stub.
    for (const bad of ['null', '5', '"text"', '[]', '{"results":5}', '{"results":[null]}', '{"results":[1]}']) {
      assert.equal((await post(bad)).status, 400, bad);
    }
    // Ids that name no waiting command (inherited names, other types, a command never sent) resolve nothing.
    const stray = await post(JSON.stringify({ results: [{ id: 'constructor' }, { id: '__proto__' }, { id: 'hasOwnProperty' }, { id: '1' }, { id: 999 }] }));
    assert.equal(stray.status, 200);
    assert.deepEqual(stray.body.commands.map((c) => c.cmd), ['look']);
    const answered = await post(JSON.stringify({ results: [{ id: stray.body.commands[0].id, ok: true, value: 'seen' }] }));
    assert.equal(answered.status, 200);
    assert.deepEqual(await pending, { id: stray.body.commands[0].id, ok: true, value: 'seen' });
    assert.equal(stub.reports.length, 2);
  } finally {
    await stub.close();
  }
});
