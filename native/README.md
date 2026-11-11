# RouteIQ native iPhone app: build plan

The product is a native iOS app in Swift/SwiftUI on the **Mapbox Navigation SDK for iOS v3**. The
SDK handles map matching, turn-by-turn voice, running with the phone locked, continuous
alternative routes and CarPlay. RouteIQ's own logic decides which route to drive and switches to
it with no tap. The web prototype at the repository root stays as the lab where that logic is
designed. Its `src/core` is the spec, and this folder ports it to Swift.

There is no Mac. Everything compiles on GitHub Actions. Facts about the SDK below were read from
Mapbox, Apple and GitHub documentation on 2026-11-11. They are not from memory. Where the docs
disagree or say nothing, this plan says so.

## Architecture

```
native/
  RouteIQCore/        pure Swift package: the ported brain (Foundation only, builds on Linux)
  RouteIQ/            the app (milestone 2): SwiftUI target, project generated in CI from a spec
    App/              SwiftUI screens, app lifecycle
    Navigation/       the adapter between Mapbox Navigation SDK routes and RouteIQCore
    Resources/        signal tiles (packed), licenses, Info.plist, entitlements
    CarPlay/          CarPlay scene (milestone 6, only after Apple grants the entitlement)
```

1. **`RouteIQCore`** (done, milestone 1) is a Swift package with no UIKit, SwiftUI, CoreLocation
   or Mapbox in it. It is a one-to-one port of `src/core`:
   - types
   - geo helpers
   - tile ids
   - signal counting with its three radii, clustering, gap-fill and freeway spans
   - ranking
   - route identity and geometry matching
   - the reroute decision engine with every threshold
   - formatting
   - the Directions JSON parser from `src/providers/mapbox/adapter.ts`

   Because it needs no Apple frameworks, its tests run on a cheap Linux runner. See
   [RouteIQCore/README.md](RouteIQCore/README.md).
2. **The app target** is SwiftUI on `MapboxNavigationCore` + `MapboxNavigationUIKit`, version
   3.34.2 through Swift Package Manager. Its minimum is iOS 17, owner to confirm; the SDK itself
   supports iOS 14+. It needs Xcode 16.2 or newer: the SDK README says 16.0, its CHANGELOG says
   16.2 since 3.9.0, and the `macos-15` runner defaults to 16.4.
3. **The Navigation adapter** is thin glue, and the only place that knows both worlds:
   - **In.** `NavigationRoutes.mainRoute` and `alternativeRoutes` (MapboxDirections `Route`:
     `shape`, `expectedTravelTime`, `typicalTravelTime`, `distance`, legs, steps, and
     `Intersection.trafficSignal`) become `RouteCandidate`s. The simplest faithful path:
     `Route` is Codable, so it is encoded back to Directions JSON and read by
     `Directions.parse`. The freeway spans, signal flags and maneuvers then come out exactly as
     the web app computes them.
   - **Poll.** The SDK's `continuousAlternatives` publisher (`AlternativesStatus.Events.Updated`)
     and `routeProgress` replace the web app's 60 s Directions polling. Those requests happen
     inside a navigation session, so they are covered by the trip price. The alternatives
     refresh interval is configurable (`AlternativeRoutesDetectionConfig.refreshIntervalSeconds`,
     default 5 min, minimum 30 s).
   - **Decide.** Each update becomes a `RerouteObservation` for `Reroute.decideReroute`. Inputs:
     the position along the route from `RouteProgress`, the speed, and the current route's
     remaining ETA as one of the candidates.
   - **Apply.** On `.switchRoute`, call `navigation().selectAlternativeRoute(with: routeId)`. The
     docs describe it as programmatic switching between continuous alternatives.
   - **SDK decisions off.** The SDK must not switch on its own:
     - `fasterRouteDetectionConfig = nil`, or `fasterRouteApproval = .manually { _ in false }`.
       Its default is `.automatically`.
     - `alternativeRoutesDetectionConfig.acceptionPolicy = .unfiltered`, so RouteIQ sees every
       alternative.
     - Keep the SDK's own off-route reroute (`rerouteConfig.detectsReroute = true`). Losing the
       route is the SDK's job; choosing between good routes is RouteIQ's.

   Unverified, to test on the phone:
   - Alternatives start at the fork, not at the driver. The adapter has to join "main route up
     to the fork" and "alternative from the fork" (`infoFromDeviationPoint`,
     `mainRouteIntersection`).
   - Whether `selectAlternativeRoute` reports `SwitchedToAlternative`.
   - Whether `startActiveGuidance(with:)` replaces routes in place during guidance.
4. **Signal tiles** are bundled as app resources: the same `public/seed/osm-signals` data,
   packed into one file instead of 900 small ones. The tile, index and snapshot JSON shapes are
   the contract. The OpenStreetMap license file ships with the data, and the credit is visible
   in the app.

   The City of Charlotte gap-fill list is **CC BY-NC-SA 4.0 (non-commercial)**. It stays out of
   any build that other people get, unless the city agrees.
5. **Voice** uses the SDK's `RouteVoiceController` (Mapbox Voice API, falling back to
   `AVSpeechSynthesizer`). RouteIQ speaks its own switch sentence, the decision's `reason`,
   through the same synthesizer, so it ducks other audio the same way. `UIBackgroundModes` must
   contain `audio` and `location`, or the SDK asserts in debug builds.
6. **CarPlay (later)** uses the SDK's `CarPlayManager` behind a `CPTemplateApplicationSceneDelegate`
   scene. Set `startFreeDriveAutomatically = false`: otherwise connecting CarPlay starts a
   billable Free Drive.

### Settled decisions

- **Linux CI for the core.** The core has no Apple frameworks, so Linux is enough. Linux minutes
  cost about a tenth of macOS minutes on a private repository ($0.006 vs $0.062 per minute), and
  `ubuntu-24.04` ships Swift 6.4.2.
- **Xcode project generated from a checked-in spec in CI**, with XcodeGen or similar, decided in
  milestone 2. The generated `.xcodeproj` is never committed; the native-probe branch does the
  same with Capacitor.
- **Location stays on the device.** Nothing about where the owner drives is logged or sent
  anywhere but Mapbox's routing APIs.

## Milestones

Each one lands with tests before the next starts.

| # | Milestone | Done looks like |
| --- | --- | --- |
| 1 | **RouteIQCore** | Package under `native/RouteIQCore`; XCTest cases mirror the Vitest suites of the ported modules; `native-core.yml` is green on Linux. |
| 2 | **App skeleton, unsigned** | XcodeGen spec checked in (`native/RouteIQ/project.yml`). CI on `macos-15` generates the project, resolves the Mapbox SDKs, builds an **unsigned** `.ipa` and uploads it as an artifact. The first screen shows a Mapbox map with the routes between Uptown Charlotte and SouthPark (public test points), ranked by RouteIQCore, with ETA, distance, difference from typical and the reason for each route's place. The Directions client and the screen's data live in `RouteIQKit`, tested on Windows and Linux. Signal counts read "unknown" until 2b. |
| 2b | **Bundled signal data** | The OpenStreetMap signal tiles are packed into one app resource with their license, and every route on the first screen shows its signal count. |
| 3 | **Guidance on the phone** | Sideloaded build (free Apple ID) starts turn-by-turn on the chosen route; voice and location continue with the phone locked; Mapbox simulation (`locationSource: .simulation`) works in the simulator. |
| 4 | **Zero-tap switching** | Adapter feeds `continuousAlternatives` to `decideReroute`. A simulated drive switches once on a steady 3 minute gain and never on oscillating ETAs, as in the web tests. The switch sentence is spoken, and a drive log stays on the device. |
| 5 | **TestFlight** | Signed build uploaded from CI with the App Store Connect API key. Needs owner items 1–4 below. |
| 6 | **CarPlay** | Map and guidance on the car screen. Needs the entitlement grant (item 5). |

## What CI runs

| Workflow | Runner | When | What |
| --- | --- | --- | --- |
| `native-core.yml` | `ubuntu-24.04` (Linux, cheap) | push or PR touching `native/RouteIQCore/**` or `tests/fixtures/**` | `swift build --build-tests`, `swift test` |
| `native-app.yml` (milestone 2) | `macos-15` (10x price) | push touching `native/RouteIQ/**`, or by hand | generate project, build unsigned `.ipa`, artifact |
| `native-testflight.yml` (milestone 5) | `macos-15` | by hand only | archive, sign, upload to TestFlight |

macOS runs are kept rare on purpose: path filters, no scheduled runs, and cancel-in-progress.
GitHub Free on a private repository includes $12 of compute a month. That buys about 2,000 Linux
minutes, or about 190 macOS minutes. A public repository would make all of it free, but whether
to make it public is the owner's decision.

## Mapbox cost

Navigation SDK for mobile, metered plan, free each month:

- **100 monthly active users** and **1,000 trips**.
- After that, $0.30 per MAU and $0.08 per trip.
- Each leg of an Active Guidance session is a trip. A trip only counts after a 30 s grace period.
- Reroutes stay inside their trip.
- Directions, refresh and voice requests during a session are included.
- The first route request *before* guidance starts is billed separately, as a Directions request
  (100,000 a month free).
- Simulated devices count as MAUs.

One driver is far inside the free tier.

## Before the owner pays (free Apple ID, 7-day installs)

**Can be done now:**

- milestones 1 and 2
- building the unsigned `.ipa` in CI
- sideloading it from Windows with a free Apple ID (see `native/probe/README.md` on the
  `native-probe` branch for the tools and their trade-offs)
- trying the map, routing, voice, background location and RouteIQ's switching on a real drive

Free-account limits: the install stops opening after 7 days unless re-signed, and there are at
most 3 sideloaded apps.

**Cannot be done before paying:**

- TestFlight, or any install that lasts beyond 7 days without re-signing
- an App Store Connect API key
- requesting or using the CarPlay entitlement. Apple's docs say the CarPlay simulator cannot show
  the app without it, so **nothing CarPlay can be tested before the grant.**
- giving the app to anyone else

---

## OWNER CHECKLIST

Only the owner can do these: they involve money, accounts, signing identities or secrets. Do them
in this order. Never paste a secret token, password or key into a chat or a commit. Each one goes
straight from the website you create it on into GitHub's secret settings.

1. **Enrol in the Apple Developer Program** ($99/year, as an individual).
   *Why:* needed for TestFlight, installs that last longer than 7 days, App Store Connect API
   keys, and before the CarPlay entitlement can be requested. Until then, builds are tested by
   sideloading.

2. **Choose the app name and bundle identifier, then create the App ID.** In Certificates, IDs &
   Profiles > Identifiers > App IDs, create an explicit App ID such as `dev.routeiq.app`. The
   probe uses `dev.routeiq.probe` as a placeholder. Turn on no capabilities yet.
   *Why:* the bundle id is permanent once on TestFlight, and signing, the CarPlay request and
   App Store Connect all hang off it. **Decision needed:** the name shown under the icon and the
   exact bundle id.

3. **Mapbox tokens.**
   - **Public token (`pk.`) for the app:** create a new one on the Mapbox account page with the
     default public scopes. Add it as GitHub Actions secret `MAPBOX_PUBLIC_TOKEN`: repo
     Settings > Secrets and variables > Actions > New repository secret. CI writes it into the
     app's `MBXAccessToken` at build time, and it never goes in git. *Why:* the app calls Mapbox
     with it.
   - **Secret download token, only if it turns out to be needed:** a secret token (`sk.`) with
     **only** the `DOWNLOADS:READ` scope, added as secret `MAPBOX_DOWNLOADS_TOKEN`. Never paste it
     into chat. The app never uses it; it would only let CI download the SDK binaries.

     *Why it may not be needed:* Mapbox's install guide still says the SDK download needs this
     token in `~/.netrc`. The SDK README says stable 3.x releases do not, and a check on
     2026-11-11 found the 3.34.2 binaries download without credentials. The milestone 2 workflow
     will try without it first and use the secret only if it exists.

4. **App Store Connect API key, for TestFlight uploads.** In App Store Connect > Users and Access >
   Integrations > App Store Connect API, create a key with the **App Manager** role. Then add
   three secrets:
   - `ASC_KEY_ID`
   - `ASC_ISSUER_ID`
   - `ASC_KEY_P8`: the downloaded `.p8` file's contents. It can be downloaded only once.

   Also create the app record in App Store Connect with the bundle id from item 2.
   *Why:* CI signs and uploads builds with this key, so no Mac and no Apple ID password are ever
   needed in CI.

5. **Request the CarPlay navigation entitlement**
   (`com.apple.developer.carplay-maps`) as soon as item 1 is done. Use
   https://developer.apple.com/contact/request/carplay/ (Apple ID sign-in); you agree to the
   CarPlay Entitlement Addendum there. *Why:* Apple grants it per app and reviews each request.
   It is not guaranteed and can take weeks. Once granted, enable it on the App ID and CI builds
   new profiles. Draft text for the form (edit freely):

   > **App name:** RouteIQ (working title)
   >
   > **Category:** Navigation (turn-by-turn driving directions)
   >
   > **What the app does:** RouteIQ is a turn-by-turn driving navigation app for iPhone. It plans
   > a driving route with live traffic, gives spoken turn-by-turn guidance, and while the driver
   > is under way keeps comparing the current route with live alternatives. When another route
   > is reliably faster (by at least two minutes and 5%, confirmed over consecutive checks, and
   > only when the turn-off is far enough ahead to take safely), it switches to it automatically
   > and announces the change by voice, so the driver never has to touch the phone. It also counts
   > the traffic signals on each route to choose between routes with the same arrival time.
   >
   > **Why it is a navigation app:** its core function is real-time, turn-by-turn route guidance
   > for drivers: a moving map, maneuver instructions, spoken prompts, arrival times and automatic
   > rerouting. It is built on the Mapbox Navigation SDK for iOS, which provides the guidance
   > engine and CarPlay map templates. In CarPlay it would use a `CPMapTemplate` base view for
   > the map only, with maneuvers, trip previews and voice prompts through the standard CarPlay
   > navigation templates, and no other content.
   >
   > **Why CarPlay matters for it:** the automatic switching is designed to be zero-touch while
   > driving. Showing guidance on the car's screen instead of the phone is the safe way to use it.

   Not confirmed: Apple's CarPlay Developer Guide (a PDF over 10 MB) could not be read from here.
   Check its navigation-app requirements before submitting.

6. **Later, decisions only the owner can make:**
   - whether to make the repository public (all Actions minutes become free, and the code becomes
     visible)
   - whether the City of Charlotte data may ship (it is non-commercial)
   - when to let other people use the app (Mapbox MAUs, privacy policy, App Review)

When an item is done, say which one. Nothing that needs a token or signing is built until then.
