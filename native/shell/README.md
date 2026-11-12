# RouteIQ iPhone shell

The web app (the repository root) inside an installable Capacitor 8 app, so a drive keeps going
while the iPhone is locked or another app is in front. Owner's guide, with install steps and what
is still unverified on a device: [docs/phone-install.md](../../docs/phone-install.md).

This folder has its own `package.json`. It adds no dependency to the web app.

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| Swift plugin `RouteIQNative` | `shell-native/ios/Sources/RouteIQNativePlugin/` | `CLLocationManager` with background updates, `AVSpeechSynthesizer` with a ducking audio session, `isIdleTimerDisabled`, and `URLSession` for route requests. Adapted from the probe (`native/probe` on branch `native-probe`). Positions are handed to the page and never logged or stored. |
| Bridge script | `src/bridge.js` | Loaded before the web app; puts the plugin on `window.RouteIQNative`. |
| Web adapters | `../../src/device/native/` | Position source, speaker, screen lock, "never hidden", the tick source for the live runner, the Directions transport and the drive diagnostics, used when the plugin is present. Tested with a fake plugin in `../../tests/nativeShell.test.tsx`, `../../tests/shellHttp.test.ts` and `../../e2e/shell.spec.ts`. |
| Token screen | `../../src/ShellRoot.tsx` | The build has no Mapbox token; the app asks for a `pk.` token on the phone. |
| Build scripts | `scripts/` | `build-web.mjs` builds the web app into `www/` with no token and searches the output for tokens; `generate-ios.mjs` creates and patches the Xcode project. |
| Cloud build | `../../.github/workflows/shell-ios.yml` | Unsigned `RouteIQ-unsigned.ipa`. |

Plugin methods: `startLocation`, `stopLocation`, `getCurrentPosition`, `speak({ text })` (resolves
when the line ends), `cancelSpeech`, `keepAwake({ on })`, `httpGet({ id, url, timeoutMs })`,
`httpCancel({ id })`. Events: `fix` (`lng`, `lat`, `accuracy`, and `speed`, `course`, `timestamp`
when known), `locationError` (`kind`), `tick` (once a second while the location stream is on),
`appState` (`state`: `active`, `inactive` or `background`).

### Route requests while locked

A web view's own `fetch` may be held back by iOS while the phone is locked, so inside the shell the
Mapbox Directions client does not use it. `../../src/main.tsx` swaps the client's transport
(`setDirectionsTransport` in `../../src/providers/mapbox/client.ts`) for
`../../src/device/native/http.ts`, which calls the plugin's `httpGet`: a `URLSession` data task in
`RouteIQHttp.swift`. Search and map tiles stay on the web view (they are used with the app in
front); the signal tiles are files inside the app.

- **Only Mapbox.** `httpGet` takes `https://api.mapbox.com/` addresses and rejects anything else
  with `not-allowed` (checked on the web side and again in Swift, as text and as a parsed URL).
  Redirects are not followed.
- **Time limit and cancel.** The whole request has `timeoutMs` (20 s; 1 to 60 s accepted). Aborting
  on the web side calls `httpCancel` with the request's id, which cancels the `URLSession` task.
  The web side also gives up 5 s after the limit if the native side never answers.
- **Answers.** Any HTTP status resolves with `{ status, body, ms }`, so 401, 403 and 429 read the
  same as in a browser. No answer rejects with `cancelled`, `timeout` or `network`.
- **Nothing is logged.** The address holds the token and the position. No Swift file logs or
  stores it, and an error is passed on as its kind only (`tests/shell.test.mjs` checks the source).

### Drive diagnostics

**Drive diagnostics** in the app's top bar opens a small log with a **Copy** button
(`../../src/DriveDiagnosticsPanel.tsx`, `../../src/device/native/diagnostics.ts`): fixes and ticks
received and the longest wait between them, route requests sent and answered with their times,
spoken lines started and finished, and when the app went to the background and came back. It is
in memory only, and holds counts, times of day and whole milliseconds: no position, no address, no
token (`../../tests/shellHttp.test.ts` checks that by pattern). A long wait between ticks while in
the background means iOS did not run the web code.

### Ticks while locked

The live runner asks the session "is anything due?" once a second. In a browser that is
`setInterval`. iOS may slow or hold back a page's timers while the phone is locked, so in the shell
the tick fires from whichever of these comes first, at most once a second: a position fix, the
plugin's native one-second `tick` event, or `setInterval` (`../../src/device/native/pulse.ts`).

### Why the Xcode project is not in git

As in the probe: `ios/` is generated on the build machine (`npx cap add ios`, then
`scripts/info-plist.mjs` adds the background modes `location` and `audio` and the location texts).
The Swift plugin is picked up as a local Swift package. The build fails early if the plugin, an
Info.plist key or the web app is missing, and again if the plugin's code is not in the app binary.

## Local checks (Windows, no Mac)

```bash
npm.cmd ci                      # in the repository root, once
cd native/shell
npm.cmd ci
npm.cmd test
npm.cmd run build               # the web app into www/, no token
npm.cmd run ios:generate        # the Xcode project into ios/
```

Compiling needs the cloud build.

## Simulator drive in CI (screenshots and video)

`.github/workflows/sim-drive.yml` runs this app in the iOS Simulator on a GitHub macOS runner,
drives it along the made-up road network of the e2e scenarios (`e2e/world/roads.ts`) with a
wrong turn, and uploads the evidence as the artifact **`sim-drive`**.

- **When it runs:** on every pull request that touches `native/shell/**`, `src/device/native/**`
  or the workflow itself. Once it is on `main` it can also be started by hand (Actions >
  "Simulator drive" > Run workflow) with three inputs: `gps` (`start`: `simctl location start`
  moves the simulator itself; `set`: the driver sets a position each second), `map` (`off` by
  default, see below) and `device` (empty: a plain iPhone on the newest runtime).
- **No secret.** Route requests are answered by a stub server on the runner (`sim/stub.mjs`).
  The optional `MAPBOX_PUBLIC_TOKEN_SIM` secret only changes the map (and only with `map: on`).
- **What the artifact holds:** numbered screenshots (`01-plan.png` ... `09-after-end.png`),
  `video.mp4` of the whole run, `summary.md` (the checks, a table of what each screenshot's
  screen said, the spoken lines and the route requests), `diagnostics.txt` (the app's own Drive
  diagnostics text), `spoken.txt`, `directions.json`, `reports.jsonl` (what the page script
  reported once a second), `result.json`, `app-log.txt` (the app's simulator log) and
  `xcodebuild-sim.log`. The job summary on the run page shows `summary.md`.
- **The checks** (the job fails when one does not hold): more than 40 GPS fixes and at least one
  answered route request in the app's Drive diagnostics; the app says "You are off the route"
  and then "New route…", with a route request from off every road. The lock test (Simulator
  menu Device > Lock) is best effort and never fails the run.
- **The map is off by default.** Mapbox GL in the simulator on a runner without a GPU kills the
  web view's content process; the page then reloads and the drive is lost. With `map: off` the
  page script makes WebGL unavailable, the app shows "The map could not start" and the drive
  works without a map. `map: on` is there to try again on another runner or Xcode.
- **Nothing of this reaches the phone build.** The page script (`sim/page.js`, bundled into
  `www/routeiq-sim.js`) and the plain-http exception (`NSAllowsLocalNetworking`) are added by
  `node sim/prepare.mjs www` and `node sim/prepare.mjs plist`, which only this workflow runs.
  `build-web.mjs` and `shell-ios.yml` fail if either is found in the phone app.
- **Not covered:** the Swift `RouteIQHttp` path to Mapbox (the page script answers route
  requests through Capacitor's native HTTP to the stub instead), real Mapbox tiles, and the
  phone's own GPS and background behaviour (`docs/phone-install.md`, and the plugged-in drive in
  `docs/phone-sim-location.md` cover those).

Run it locally on a Mac with a booted simulator:

```bash
npm ci && npm run build && node sim/prepare.mjs www
npm run ios:generate && node sim/prepare.mjs plist
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -derivedDataPath build/sim-derived CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted build/sim-derived/Build/Products/Debug-iphonesimulator/App.app
node sim/drive.mjs --udid <udid> --out build/sim-drive
```

Never run `prepare.mjs` before a build you put on a phone.
