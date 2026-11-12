# Performance: measurements and budget

Measured on `main` at `d265f99` (Nov 11, 2026), on a Windows desktop (x64, Node 24.22).
Phones run this JavaScript 3 to 5 times slower, so every desktop number below should be read
times 3 to 5 for the iPhone shell. Nothing in the product was changed to get these numbers.

The audit was stopped early. What is still open is listed under
[Not measured yet](#not-measured-yet), so that another session can pick it up.

## How to reproduce

The scripts are in `scripts/perf/`. They import `src/core` (and two pure helpers of
`src/map`) directly; Node 22.12+ runs the `.ts` files as they are. No network, no token.

| What | Command |
| --- | --- |
| Bundle sizes | `npm run build` (the table Vite prints) |
| Per-tick cost | `node scripts/perf/tick.mjs` |
| Per-check and per-plan cost | `node scripts/perf/check.mjs` (about 4 minutes: the last table is slow on purpose) |
| Renders and map updates per second | `npm i --no-save jsdom`, then `npx vitest run --config scripts/perf/vitest.config.ts --silent=false --reporter=verbose` |

The test route is synthetic (`scripts/perf/lib.mjs`, `syntheticDirections`): three routes of
60 km with 3000 vertices each, a step every 1.5 km, an intersection every 200 m, banner and
voice instructions and the `congestion,duration` annotations, shaped like a Directions v5
answer. It starts in Charlotte so that the real bundled signal tiles apply. It is not a real
answer: sizes of real answers depend on the roads.

Run the scripts one at a time on an idle machine. Timings taken while something else was
running came out up to 50% higher.

## 1. Bundle

`npm run build`:

| File | Raw | Gzip |
| --- | --- | --- |
| `index-*.js` (the only entry chunk: app + React + Mapbox GL JS) | 1,716.95 kB | 479.54 kB |
| `index-*.css` (app CSS + `mapbox-gl.css`) | 58.66 kB | 8.35 kB |
| `worker-*.js` (Mapbox GL worker) | 779.07 kB | not printed by Vite |
| 10 small Mapbox style chunks (`standard.main`, `hd.main`, `lite.main`, `debug`, ...) | 2.4 to 91 kB each, 425 kB together | 1.2 to 26 kB each |
| `index.html` | 0.96 kB | 0.47 kB |

- **Mapbox GL is not split from the app.** `src/map/MapView.tsx:2` imports
  `mapbox-gl/esm` statically and `vite.config.ts` has no `manualChunks`, so the app, React
  and Mapbox share one hashed file. Any app change makes every user download the 480 kB again.
- **Nothing is lazy.** There is no `import()` anywhere in `src`. `DriveDiagnosticsPanel`
  (shell only, behind a button), `ReplayPanel` (development only) and `LiveDriveView` are
  all in the entry chunk.
- **First paint** waits for the whole entry chunk (1.7 MB to parse) and the CSS; nothing
  else blocks it. `src/main.tsx` does no awaited work before `createRoot().render()`.
- How much of the entry chunk is the app's own code: not measured yet.

## 2. Per-tick cost (once a second while driving)

`node scripts/perf/tick.mjs`: a whole 60 km drive, 4003 fixes at 1 Hz.

| Call | Median | p95 |
| --- | --- | --- |
| `liveStep` on a fix (tracking + guidance + poll gate) | 0.29 ms | 0.39 ms |
| of which `trackFix` (walks all 3000 segments, `src/core/tracking.ts:186`) | 0.29 ms | 0.39 ms |
| `liveStep` on a tick | 0.0002 ms | 0.0003 ms |
| `dueAnnouncement`, `nextTurn`, `armGuidance` | under 0.001 ms | under 0.001 ms |
| `liveView` | 0.0006 ms | 0.001 ms |
| Map overlay: `lineFrom` + `driveFeatures` + stringify (median over the drive; the line shrinks) | 0.36 ms | 0.56 ms |
| **One second of driving, all of the above** | **0.65 ms** | **0.96 ms** |

The pure logic is well inside the 4 ms budget (about 3 to 5 ms on a phone at p95). Nothing
here is over. What the tick hands to the map is the cost that matters: see section 3.

## 3. React and the map during a drive

`scripts/perf/renders.test.tsx`: the real `App` in jsdom, one minute of driving, Mapbox
replaced by a recorder. Per second of driving:

| What | Per second | Note |
| --- | --- | --- |
| `MapView` renders | 1.00 | props changed: `drive`, `follow` |
| `LiveDriveView` renders | 1.00 | `state`, `view`, and `dev`, `onRestart` (new objects every render) |
| `PlanPanel` renders | 1.00 | hidden during a drive; `places`, `onSwap`, `onReset` are new every render |
| `RoutePanel` renders | 1.00 | hidden during a drive; `onStartDrive`, `startDriveExtra`, `children` |
| `DrivePanel` renders | 1.00 | hidden during a drive; `sim` |
| `setData('drive')` | 1.00 | **66.4 kB, 2972 points per call**: the whole rest of the route, to move one dot |
| `setData('routes')` | 0.02 | 200.6 kB, 9000 points, once per check (expected) |
| `setData('route-signals')` | 0 | |
| `map.easeTo` | 1.00 | 1100 ms linear ease per fix |

- The harness delivers the fix and the 1 s timers in one `act`, so React batches them into
  one commit. In a browser the fix (`setState` in `useLiveDrive.ts:146`) and the hook's own
  1 s interval (`useLiveDrive.ts:184`) land separately: expect up to 2 renders of everything
  per second.
- No component is wrapped in `memo`, and `App` owns the drive state, so every fix renders
  the whole tree, the three hidden panels included (`src/App.tsx:184-266`).
- Every fix: `App.tsx:170` builds `lineFrom(route, along)` (which recomputes `alongRouteM`
  for the whole route: 3000 haversines and a new array), `driveFeatures` copies it again,
  and `MapView.tsx:298-302` sends it all to the map, whose worker re-tiles the whole line.
  Only the car moved.
- `trackFix` allocates one `Pass` object and one point per segment per fix (about 6000
  small objects a second on this route).

The cost of `setData` inside Mapbox (worker re-tiling, GPU upload) is not measured yet: it
needs a real browser.

## 4. Per-check cost (every 60 s) and per-plan cost

`node scripts/perf/check.mjs`. The answer is 850.2 kB of JSON (136.8 kB gzipped) for three
routes; signal data is 8 bundled tiles with 1190 points. A check 2 km into the drive.

| Call | Median | p95 |
| --- | --- | --- |
| `JSON.parse` of the answer | 3.30 ms | 3.69 ms |
| `parseDirections` (adapter, 3 routes with annotations) | 1.66 ms | 2.44 ms |
| `signalTilesForRoute` (3 routes) | 1.04 ms | 1.76 ms |
| `withSignalCounts` (3 routes) | 11.4 ms | 13.5 ms |
| `signalsOnRoute` (1 route) | 4.43 ms | 7.43 ms |
| `rankRoutes` | 0.001 ms | 0.002 ms |
| `findCurrentRoute` (covers `matchRest`) | 9.20 ms | 13.0 ms |
| `baselineProbe` (current route among the fresh ones / not) | 8.42 / 15.4 ms | 12.4 / 17.3 ms |
| `decideReroute` | 12.7 ms | 14.7 ms |
| `liveStep` on the `routes` event | 14.3 ms | 27.1 ms |
| `routeFeatures` + stringify for the map | 1.29 ms | 2.41 ms |
| **The whole check** | **37.0 ms** | **49.4 ms** |

The whole check sits right at the 50 ms budget on a desktop, so 110 to 250 ms of blocked
main thread once a minute on a phone. Two things do the same work twice: `baselineProbe`
and `decideReroute` each match the current route against the fresh ones (see #31), and
`withSignalCounts` clusters all 1190 signal points again for each of the three routes
(`src/core/signals.ts:525`).

Per plan:

| Call | Median | p95 |
| --- | --- | --- |
| `selectViaPoints` / `planProbes` | 3.6 ms | 5.8 ms |
| `sameRouteGeometry` (two different 3000-vertex routes) | 6.29 ms | 9.40 ms |
| **`mergeProbeRoutes`, 2 probes that came back on known routes** | **466.9 ms** | **545.5 ms** |
| `mergeProbeRoutes`, 2 probes that are new side streets | 46.4 ms | 119.8 ms |

`mergeProbeRoutes` is the one large overrun. A probe that Mapbox snaps back onto a known
route (the common case, and the reason for the de-duplication) is compared point by point
against every segment of the known route: `everyPointNear` in `src/core/select.ts:13` is
quadratic. It runs inside a `useMemo` during render (`src/useRoutes.ts:224`), once per probe
that arrives. By trip length (measured while other work was running, so about 50% high):
15 km / 750 vertices 66 ms, 30 km 267 ms, 60 km 722 ms, 120 km 1591 ms.

## 5. Network and battery

From the code (defaults in `DEFAULT_LIVE_OPTIONS`, `DEFAULT_PROBE_BUDGET`):

| | Requests |
| --- | --- |
| One plan | 1 Directions + up to 2 probes (800 ms debounce) + `index.json` once + one file per signal tile not yet loaded (8 for the 60 km route) |
| One drive hour | One check per 60 s: 1 Directions request, or 2 when the current route is not among the answers. Capped at 60 per drive, plus 5 kept back for off-route. So at most 60 to 65, however long the drive. |
| Signal tiles during a drive | None after the first check: loaded tiles stay in memory for the session |

- **Answer size with annotations:** 850 kB raw / 137 kB gzipped for the synthetic 3-route
  60 km answer. At 60 checks that is about 8 MB an hour on the wire at most. A real answer
  has not been measured.
- **Standing still:** checks stop after 120 s without movement (`stationaryPauseSec`) and
  while the page is hidden in a browser. The GPS, the 1 s tick, the React renders and the
  66 kB `setData` go on all the same. Probes are made at plan time only, never during a drive.
- **GPS accuracy (shell):** `RouteIQEngine.swift:111-114` asks for
  `kCLLocationAccuracyBestForNavigation`, `distanceFilter = kCLDistanceFilterNone`,
  `pausesLocationUpdatesAutomatically = false`. That is the most power-hungry setting Core
  Location has (Apple recommends it for use while plugged in). Right for navigation; worth a
  decision for a phone that is not on a charger.
- **Screen:** the browser wake lock is taken at Start and released at End, arrival and
  failure (`STOP_EFFECTS` in `core/live.ts`). The shell sets `isIdleTimerDisabled`
  (`RouteIQEngine.swift:353`) through the same two effects, so it is released the same way.
  Battery drain on a device: not measured yet.

## 6. Signal tiles

The bundle is 903 tile files, 1.24 MB in all, the largest 34 kB, plus a 5 kB index. The
60 km route needs 8 tiles: 8 small fetches and the index at the first plan, none later.
Turning the 8 tiles into points (`osmSignalPoints`) takes 0.11 ms. Tiles are 0.1 degree
squares, so a route needs roughly one tile per 7 to 10 km. JSON parse time of the tile
files on their own: not measured yet (the files are small; it is not expected to matter).

## Proposed budget

Desktop numbers, on the synthetic 60 km / 3000-vertex route. "Now" is what was measured.

| Budget | Limit | Now | Status |
| --- | --- | --- | --- |
| Entry JS chunk (app + React, Mapbox split out), gzip | 150 kB | 479.5 kB (Mapbox included) | over |
| Mapbox GL in its own cached chunk | yes | no | over |
| CSS, gzip | 12 kB | 8.35 kB | ok |
| Pure logic per 1 s tick, p95 | 4 ms | 0.96 ms | ok |
| Data handed to the map per fix | 1 kB (the car only) | 66.4 kB | over |
| Component renders per fix: `MapView`, `LiveDriveView` | 1 each | 1 each (2 in a browser) | ok |
| Component renders per fix: hidden panels (`PlanPanel`, `RoutePanel`, `DrivePanel`) | 0 | 1 each | over |
| Whole check per 60 s, p95 | 50 ms (aim for 25 ms) | 49.4 ms | at the limit |
| Any single call in a plan, p95 | 50 ms | 545 ms (`mergeProbeRoutes`) | over |
| Directions requests per drive hour | 65 | at most 60 + 5 | ok |
| Directions requests per plan | 3 | 1 + up to 2 | ok |
| Requests while standing still for over 2 minutes | 0 | 0 | ok |

## Not measured yet

- What the app's own code weighs inside the entry chunk (`npx vite-bundle-visualizer`).
- The cost of `setData` and `easeTo` inside Mapbox GL in a real browser and in WKWebView.
- Render counts in a real browser (jsdom batches the fix and the 1 s timer into one commit).
- A real Directions answer's size with annotations (needs a token; only the synthetic one was sized).
- The e2e run time and the slowest unit tests (`npx vitest run --reporter verbose`).
- JSON parse time of the signal tile files on their own.
- Battery drain on an iPhone, and the cost of the native bridge for an 850 kB answer
  (`src/device/native/http.ts` hands the body over as a string).
