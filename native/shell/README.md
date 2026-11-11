# RouteIQ iPhone shell

The web app (the repository root) inside an installable Capacitor 8 app, so a drive keeps going
while the iPhone is locked or another app is in front. Owner's guide, with install steps and what
is still unverified on a device: [docs/phone-install.md](../../docs/phone-install.md).

This folder has its own `package.json`. It adds no dependency to the web app.

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| Swift plugin `RouteIQNative` | `shell-native/ios/Sources/RouteIQNativePlugin/` | `CLLocationManager` with background updates, `AVSpeechSynthesizer` with a ducking audio session, `isIdleTimerDisabled`. Adapted from the probe (`native/probe` on branch `native-probe`). Positions are handed to the page and never logged or stored. |
| Bridge script | `src/bridge.js` | Loaded before the web app; puts the plugin on `window.RouteIQNative`. |
| Web adapters | `../../src/device/native/` | Position source, speaker, screen lock, "never hidden" and the tick source for the live runner, used when the plugin is present. Tested with a fake plugin in `../../tests/nativeShell.test.tsx` and `../../e2e/shell.spec.ts`. |
| Token screen | `../../src/ShellRoot.tsx` | The build has no Mapbox token; the app asks for a `pk.` token on the phone. |
| Build scripts | `scripts/` | `build-web.mjs` builds the web app into `www/` with no token and searches the output for tokens; `generate-ios.mjs` creates and patches the Xcode project. |
| Cloud build | `../../.github/workflows/shell-ios.yml` | Unsigned `RouteIQ-unsigned.ipa`. |

Plugin methods: `startLocation`, `stopLocation`, `getCurrentPosition`, `speak({ text })` (resolves
when the line ends), `cancelSpeech`, `keepAwake({ on })`. Events: `fix` (`lng`, `lat`, `accuracy`,
and `speed`, `course`, `timestamp` when known), `locationError` (`kind`), `tick` (once a second
while the location stream is on).

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
