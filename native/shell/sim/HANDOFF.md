# Simulator drive: handoff

Branch `claude/ios-sim-drive`. Goal: run the shell app in the iOS Simulator on a GitHub Actions
macOS runner, feed it a GPS drive with a wrong turn, and upload screenshots, a video and the
Drive diagnostics as the artifact `sim-drive`. Delete this file when the work is done.

## State

**No CI run of `sim-drive.yml` has been made yet.** The last commit says `[skip ci]` on purpose
(the local session was told to stop before the first run). Everything below "works" means
"works on Windows in Chromium with a stand-in plugin", not in a simulator.

### What works (checked locally)

- `npm test` in `native/shell` (19 tests, `tests/sim.test.mjs` are the new ones).
- `npm run build && node sim/prepare.mjs www`: the page script is bundled into
  `www/routeiq-sim.js` and its tag added after the bridge script.
- The whole drive, end to end, against Chromium: `sim/drive.mjs`'s `runDrive` with a stand-in
  device (a Playwright page with a fake `window.RouteIQNative` that emits `fix` and `tick`).
  Result: plan screen, Start drive pressed by the page script, 46 fixes, wrong turn, spoken
  "You are off the route. Finding a new one." then "New route. 19 minutes to your destination.",
  banner "New route from here", the new route followed, Drive diagnostics text read, End.
  All three checks passed. The map drew the made-up roads from the stub's style.
  That harness is not committed (it lived in a scratch folder); it is about 50 lines:
  serve `www/` statically, `addInitScript` a fake plugin, and pass `runDrive` a `device` whose
  `setLocation` calls the fake's `fix`, `startRoute` returns false and `lock` returns null.

### Never run (everything that needs a Mac)

- `.github/workflows/sim-drive.yml` as a whole: the simulator build, boot, install, launch.
- `simctlDevice` in `sim/drive.mjs`: every `xcrun simctl` call, the video, the lock test.
- `node sim/prepare.mjs plist` and whether `NSAllowsLocalNetworking` is enough.
- The page script's first-choice transport (Capacitor's native `CapacitorHttp`).
- The new check in `shell-ios.yml` (no `routeiq-sim` in the phone app, no ATS exception).

## Design decisions (and why)

- **Option (a), a stub server, no secret.** `sim/stub.mjs` answers Directions from
  `e2e/world/roads.ts` (free flow) and serves a map style that draws those roads, so nothing
  needs a token. `MAPBOX_PUBLIC_TOKEN_SIM` is optional and untested (no such secret exists):
  with it the map style comes from Mapbox; routes still come from the stub.
- **No app code hook and no Swift edit.** Instead of a launch argument, a separate script
  (`sim/page.js` -> `www/routeiq-sim.js`) is loaded after the bridge script, in the simulator
  build only. It presets a made-up token in `localStorage` (`routeiq.shell.mapboxToken`), wraps
  `window.RouteIQNative` in a Proxy that overrides `httpGet`/`httpCancel` (answered by the stub)
  and `speak` (recorded, then passed on), and patches `fetch` for the map's style request.
  GPS, ticks, voice and keep-awake stay the real Swift plugin's. So there are no launch
  arguments at all, and no conflict with `claude/issue-86-shell-testing`.
  Cost: the Swift `RouteIQHttp` (URLSession, Mapbox-only) is **not** exercised by this run.
- **Inert in the phone build**: nothing in `src/` or the plugin refers to it; `build-web.mjs`
  fails if `www/` mentions `routeiq-sim`; `shell-ios.yml` greps the finished app for it and
  fails on an `NSAppTransportSecurity` key; `tests/sim.test.mjs` covers these guards.
- **Driver and stub are one process** (`node sim/drive.mjs --udid ...`). The page reports once
  a second to `POST /sim/report` (screen words, counts, spoken lines; no position) and gets
  commands back (`click`, `diagnostics`). The driver reads the app's real Drive diagnostics by
  clicking the top bar's button, which the drive view hides with CSS but `.click()` still presses.
- **Checks** (`judge` in `drive.mjs`): more than 40 fixes and at least 1 answered request (from
  the app's diagnostics text), and spoken off-route then "New route." plus one stub request
  from off every road. The lock test never fails the run.

## Next steps

1. Amend or add a commit without `[skip ci]` and push: the PR then runs `sim-drive.yml`
   (it cannot be dispatched by hand until it is on `main`). Budget: at most 8 runs.
2. Read the run: `gh run view <id> --log-failed`, then `gh run download <id> -n sim-drive`
   and look at the PNGs. `summary.md` has a table of what each screenshot's screen said.
3. Check `shell-ios.yml` still passes on the PR (the new grep and the plutil check).
4. Then: README section in `native/shell/README.md` (how to trigger, what the artifact holds),
   the tracking issue "iOS Simulator drive in CI (screenshots and video)" (labels
   `in-progress,p2,area:native`), `status: agent-sim-drive` on #17, mark the PR ready.

## Where it will most likely break first (my guesses, in order)

1. **The page cannot reach `http://127.0.0.1:8521`.** The page is `capacitor://localhost`.
   The script first uses `Capacitor.nativePromise('CapacitorHttp', 'request', ...)` (native,
   no CORS or mixed-content rules), and falls back to `fetch`. Both need the ATS exception
   from `prepare.mjs plist`. If neither works a red box on the screen says why (see the
   `no-contact` screenshot), and the driver exits 2 after 120 s. Fallbacks: add
   `NSAllowsArbitraryLoadsInWebContent`; or answer Directions inside the page (bundle
   `e2e/world/roads.ts` into `routeiq-sim.js` with esbuild) and keep the server for reports only.
   Unverified detail: the shape of CapacitorHttp's answer (`data` may come back parsed for
   JSON; the script handles a string or an object).
2. **`simctl location start` syntax.** Used: `start --speed=<m/s> --interval=1 <lat,lng> ...`.
   The workflow prints `xcrun simctl location` help in the "Select Xcode" step: check it. If
   the command is refused the driver falls back to `set` once a second by itself (fixes then
   probably carry no speed or course; the app copes). `workflow_dispatch` has a `gps` input.
   A stationary simulated location may deliver only one fix, so the car is never left standing.
3. **The simulator build**: `-sdk iphonesimulator -destination "platform=iOS Simulator,id=$UDID"`
   with `CODE_SIGNING_ALLOWED=NO`, product expected at
   `build/sim-derived/Build/Products/Debug-iphonesimulator/App.app`.
4. **WebGL in the simulator's web view** on a virtual Mac: if Mapbox GL cannot start, the app
   shows "The map could not start" and the drive UI should still work; the driver notes it.
5. **Location permission**: `simctl privacy <udid> grant location-always dev.routeiq.shell`
   is called before the first launch, after install. If a permission alert still shows, the
   screenshots will show it and no fix arrives.
6. **Lock**: AppleScript, Simulator menu Device > Lock, then Home to unlock. Needs
   Simulator.app open (the install step opens it) and the runner letting `osascript` drive
   System Events. Best effort; the summary says what happened.
7. **`recordVideo`** is stopped with SIGINT and given 30 s to finish the file.
8. Node 24 is required: `stub.mjs` and `drive.mjs` import the `.ts` world files directly.
