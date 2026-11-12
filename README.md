# RouteIQ (Windows prototype)

A Vite + React + TypeScript web app that shows a Mapbox map with two draggable pins,
starting with a test trip down the US-521 corridor: Uptown Charlotte (origin, blue) to
the intersection of US-521 and SC-160 in Indian Land, South Carolina (destination, red).
The trip can be anywhere: search for a place or an address for either end, use the
device's location as the origin, keep Home, Work and a few named places one tap away,
and pick from the recent destinations (see Planning a trip). The page lays itself out
for a phone at narrow widths.
It draws up to three traffic-aware driving routes between them and lists each
one's ETA, distance, difference from typical time and number of signalized
intersections (from OpenStreetMap), with the
signals on the selected route shown as dots. Counting works on any route. The signal data for North and South Carolina ships with the app, built from
OpenStreetMap extracts, so a trip inside the two states asks no signal server at all; where
signal data cannot be loaded the count is marked partial, never shown as zero. The routes are ranked: best ETA first, with the signal count breaking
ties of 30 seconds or less, and the top one is marked "Recommended". A simulated drive
moves a car along the selected route, asks Mapbox for fresh routes as it goes and changes
route by itself when a faster one holds up (see Rerouting). "Start drive" does the same
for real: it drives the route you picked (a side-street route too), follows the device's position to the destination, checks for faster routes
as you go, switches by itself and says so out loud, with turn prompts (see Live drive).
What comes next is in [PLAN.md](PLAN.md).
To try it on a phone, the same app is published to GitHub Pages at
https://akashdesai93.github.io/routeiq/: setup and a test checklist are in
[docs/phone-testing.md](docs/phone-testing.md).

## Run it on Windows

Open PowerShell (not cmd) and run, adjusting the zip path if yours differs:

```powershell
# 1. Unzip (Unblock-File clears the "downloaded from the internet" flag)
cd $HOME\Downloads
Unblock-File .\routeiq.zip
Expand-Archive .\routeiq.zip -DestinationPath $HOME\dev -Force
cd $HOME\dev\routeiq

# 2. Add your Mapbox PUBLIC token (starts with pk.)
Copy-Item .env.example .env.local
notepad .env.local

# 3. Check prerequisites (read-only, installs nothing)
powershell -NoProfile -ExecutionPolicy Bypass -File .\check-prereqs.ps1

# 4. One time only: let PowerShell run npm. Windows 11 blocks scripts by default,
#    and `npm` in PowerShell is npm.ps1, so without this step npm fails with
#    "running scripts is disabled on this system". RemoteSigned for your user
#    only is Microsoft's recommended setting. (Alternative: type npm.cmd instead of npm.)
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# 5. Install exactly the tested versions, test, and start
npm ci
npm test
npm run dev
```

Then open http://localhost:5173. Open the folder in VS Code with `code .`.

Other scripts: `npm run typecheck`, `npm run lint`, `npm run build`, `npm run preview`,
`npm run build:signals` (rebuilds the OpenStreetMap signal tiles shipped with the app from
extracts on disk); see Data sources.

CI runs on every pull request and every push to `main` from one workflow,
`.github/workflows/gate.yml`. It calls `ci.yml` (`npm ci`, typecheck, lint, tests, the
production build and its size budget, on Node 24 on Ubuntu) and `e2e.yml` (the end-to-end
scenarios, report uploaded as the `e2e-report` artifact) every time, and the Swift tests
and the two macOS builds when their paths change. Its last job, `required`, is the one
status check `main` requires: `main` is protected and every change arrives through a pull
request. See [docs/branch-protection.md](docs/branch-protection.md).

`npm run size` (after a build) checks the bundle-size budget in
`scripts/bundle-budget.json`: the app's own JavaScript, without Mapbox GL JS, and the CSS
may each grow 10 % before CI fails.

## End-to-end scenarios

Each feature the user sees or hears has a scenario that shows it working, named as a
sentence: "I start a drive and it speaks the turns in order, then says I have arrived",
"when a faster route holds up, it switches by itself and tells me once", "when nothing is
faster, it never switches", "a wrong turn: it says I am off the route, finds a new one and
gets me there", "a route outside NC/SC shows a partial light count, never 0", "saved places
and the last trip survive a reload", "with a token Mapbox rejects, it says what to fix",
"when a side street saves time, it is offered and wins", "when a jam builds during the
drive, a side street found mid-drive takes me round it".

```powershell
npx playwright install --only-shell chromium   # once per machine: headless Chromium, about 290 MB
npm run e2e                                    # builds, runs every scenario, about 1 minute
start e2e-report\index.html                    # the one-page report
```

- **What runs:** the production build (`vite build` with a dummy `pk.test` token, plus a
  build with no token for the setup help), served by `vite preview` on a pair of ports picked from the checkout's
  folder (`e2e/ports.ts`; set `E2E_PORT` to choose), so runs in several worktrees at once
  don't collide, in headless Chromium driven by Playwright (`e2e/`). The dev server on 5173 is not touched
  and `.env.local` is never used.
- **Fully offline.** Every request that leaves localhost is answered by the test
  (`e2e/harness.ts`); one that nothing answers fails the scenario. Directions come from a
  made-up road network between the trip's two points (`e2e/world/roads.ts`): three routes
  that share their start and end, answered from wherever the car is, as Mapbox does.
  Some scenarios add a side street Mapbox never offers, reachable only by a request with
  a via point, which is answered along the road nearest the via (as Mapbox snaps it).
  Traffic is a script (`e2e/world/traffic.ts`: "a jam on A from the second check on").
  Search answers from the hand-written fixtures in `tests/fixtures`, the map style is a
  blank one, and Overpass answers as each scenario says.
  `tests/e2eWorld.test.ts` puts the made-up answers through the real adapter, so they
  stay shaped like Mapbox's. Only public landmarks are used; no real responses are
  recorded (Mapbox's terms limit storing their data, and the repository is public).
- **Simulated GPS, voice and clock.** A drive runs on Playwright's fake clock: the made-up
  driver sends a fix every 2 simulated seconds along the route the app chose, follows it
  onto a new route when the app announces one, and can take a wrong turn or wander with
  GPS noise. The voice records every line in order instead of speaking. A 17-minute drive
  takes about 40 seconds.
- **Evidence:** `e2e-report/index.html` shows each scenario with its screenshots, the
  spoken lines with their drive time, what the made-up traffic server answered to each
  route request, and a video. `npm run e2e:report` opens Playwright's own report, with a
  trace of any failure.

## Planning a trip

The panel beside the map (above it on a phone) is the trip input.

- **Search.** Each end of the trip is a search field. Type three characters or more and,
  once typing has paused for 350 ms, up to five suggestions appear, nearest the centre of
  the map first; pick one with a tap, or with the arrow keys and Enter (Enter alone takes
  the first). Escape or leaving the field puts the current place back. Errors are said in
  words under the field: a rejected or URL-restricted token (401, 403), rate limiting
  (429), no connection.
- **Use my location** sets the origin from the browser's Geolocation API: one fix, high
  accuracy, 15 second limit. It is asked for only when the button is pressed, never when
  the page loads. Browsers allow it only on HTTPS or localhost; a refusal, a timeout and
  an unavailable position each get their own message.
- **Saved places.** Home, Work and up to six named places. "Recent and saved places"
  saves the current origin or destination under one of them, renames and removes them. A
  saved place is a button that sets the destination, and both fields list the saved
  places when focused, so one can be the origin too.
- **Recent.** The last eight destinations picked from search, newest first, without
  repeats (the same spot within 50 m, or the same name within 300 m, is one entry). The
  destination field lists them when focused.
- **Last trip.** A reload opens with the trip that was on screen, not the built-in one.
  "Reset to test points" goes back to the built-in trip (Uptown to US-521 and SC-160),
  which is also what a first visit and a cleared device open with.
- **Pins** can still be dragged. A dragged pin shows its coordinates ("Dropped pin
  (35.2271, -80.8431)"), not an address: looking the address up would cost a request per
  drag, so it is not done.
- **Clear saved places and history** removes all of the above from the device.

**The search API.** Mapbox Search Box API, `/suggest` while typing and `/retrieve` for
the suggestion that is picked, called over HTTP (no extra package). It was chosen over
the Geocoding API v6 because v6 does not return points of interest at all (its docs
send POI search to Search Box), and a trip to an airport or a stadium is the common
case. Checked on mapbox.com/pricing and docs.mapbox.com/api/search, Nov 11, 2026:

| | Billed | Free each month | Then |
| --- | --- | --- | --- |
| Search Box `/suggest` + `/retrieve` | per session | 500 sessions (the page's "introductory preview" table; its "standard" table says 2,500) | $3.00 per 1,000 (standard: $11.50) |
| Geocoding v6 forward, temporary | per request, so per keystroke that searches | 100,000 requests | $0.75 per 1,000 |
| Directions | per request | 100,000 requests | $2.00 per 1,000 |

A session is the suggest requests made on one session token (up to 50) and the one
retrieve that ends them; it also ends 180 seconds after a suggest that nothing followed.
So one search costs one session however much is typed: typically 1 to 4 suggest requests
(the debounce and the three-character minimum keep it there) and 1 retrieve. A search
that is abandoned still counts as a session. At the lower free figure that is about 16
searches a day; saved places and recents cost nothing. Requests are also limited to 10
per second. RouteIQ starts a new token after a pick, after 50 suggests, or after 170
idle seconds (`sessionForSuggest` in `src/core/search.ts`). Every request carries
`proximity` (the map centre, rounded to four decimals): without it Mapbox would place
the caller by IP address. `types` leaves out categories and brands, which are not one
place. For a large site the place's first `routable_points` entry (a point on the road
network) is used in preference to the middle of the site.

One thing to settle before this is more than a personal prototype: the Search Box docs
say its results are "only available for temporary use" and to contact Mapbox about
storing positions. Saved places and recents keep a name and a coordinate from a search
result on the device. Mapbox's product for stored results is the Geocoding API with
`permanent=true` ($5.00 per 1,000, no free tier, no POIs).

## Mapbox token

- Create a **new public token** at https://console.mapbox.com/account/access-tokens/
  with the default public scopes. Do not use a secret `sk.` token; the app refuses one.
- A browser token is public by nature: anything prefixed `VITE_` is bundled into the
  page and anyone who opens it can read it. Protect it with a URL restriction instead:
  add `http://localhost:5173` to the token's allowed URLs. Mapbox blocks restricted
  tokens on localhost unless localhost is on the list, and it does not accept IP
  addresses, so use `localhost`, not `127.0.0.1`.
- `.env.local` is git-ignored. Only `.env.example` (a placeholder) is meant for git.
- **The iPhone app** (`native/shell`, below) has no token built in, because its build is a
  public download. It asks for a `pk.` token on first launch, keeps it on the phone only
  (the app's localStorage, key `routeiq.shell.mapboxToken`) and has a "Change token"
  button. It refuses `sk.` tokens and never stores one. A URL-restricted token does not
  work there (the app's pages come from `capacitor://localhost`), so use a separate
  unrestricted public token for the phone.
- The GitHub Pages build (`.github/workflows/pages.yml`) uses its own public token, the
  repo secret `VITE_MAPBOX_TOKEN_PAGES`, URL-restricted to `https://akashdesai93.github.io`.
  It is passed to the build step only and never printed; the build stops if it is missing
  or not a `pk.` token. The site is served under `/routeiq/` (`PAGES_BASE`); local dev,
  preview and e2e keep `/`. See [docs/phone-testing.md](docs/phone-testing.md).

## Contracts

The shapes the Swift port and the iPhone shell depend on (routes, signal tiles and index, the
place book, the reroute options and state, the live events and effects, the native plugin) are
versioned as one: `CORE_CONTRACT_VERSION` in `src/core/contract.ts`, currently 1. What is in it,
the JSON Schemas, and how to change a contract are in [docs/contracts.md](docs/contracts.md).
`tests/contracts.test.ts` fails on a change of shape without a version bump.

## Layout

```
src/core/       Pure TypeScript: route data contracts, geo helpers, test points, route
                facts (delay vs typical), formatting (minutes, miles, signals) and the
                route selection. signals.ts counts the signalized intersections on a
                route from two sources combined only at that moment (the primary
                data and the directions provider's own flags) and says how much
                of the route the count covers (full, partial, none); the rule distances
                live there, in DEFAULT_SIGNAL_MATCH. tiles.ts is the 0.1 degree tile
                arithmetic: which tile a point is in and which tiles a route touches.
                hash.ts gives each route an id from its geometry.
                rank.ts orders the routes and words the reasons: best traffic-aware
                ETA first, signal count only breaks ties within
                DEFAULT_ETA_TIE_WINDOW_SEC (30 s), no per-signal time penalty; a count
                that is not full is treated as unknown.
                select.ts keeps a route you picked selected across refetches and
                otherwise selects the top-ranked one.
                reroute.ts is the switching brain: decideReroute takes the state it
                returned last time, what a poll just found (the time, the position
                along the current route, the speed, the fresh routes) and the
                thresholds, and answers stay or switch with a sentence that can be
                spoken. Time is an input and the state is plain data, so the same
                inputs always give the same answer. All thresholds are in
                DEFAULT_REROUTE_OPTIONS. geo.ts also finds the point and heading a
                distance along a line, and the rest of a line from there.
                places.ts is the place book: Home, Work, named places, recent
                destinations and the last trip, with the rules for adding, renaming,
                removing, telling two places apart, the caps, and reading a stored
                book back without trusting it. search.ts says when typed text is
                worth a request and how requests are grouped into billing sessions.
                tracking.ts turns raw position fixes into a place on the route, with
                an off-route verdict that takes patience. guidance.ts picks the turn
                to show and the announcement that is due. speechQueue.ts is what is
                said when. live.ts is the live drive as a state machine: events in
                (a fix, an answer, a tick, the page hidden), next state and effects
                out (see Live drive).
                No React, Mapbox, DOM or network, so all of it can be ported to Swift
                or served.
src/providers/mapbox/
                adapter.ts: pure Directions API JSON -> RouteCandidate[] (typed failures),
                including every step intersection with its signal flag (intersections),
                Mapbox's own count of the flagged ones (providerSignalCount, a
                cross-check only) and the stretches driven on freeway
                (limitedAccessSpansM, from each step intersection's road class and
                geometry_index).
                client.ts: builds the driving-traffic URL and fetches it (abortable;
                401/403/429/network become readable errors). A request made while
                moving carries the vehicle's heading (`bearings`, origin only).
                searchAdapter.ts: pure Search Box API JSON -> suggestions (`/suggest`)
                and a Place (`/retrieve`), with typed failures.
                searchClient.ts: builds the two URLs and fetches them (abortable, never
                rejects; 401/403/429/network become readable errors).
src/search/     searchRunner.ts: the typing-to-request logic of a search field, with
                the timer passed in: debounce, the three-character minimum, and each
                keystroke aborting the request before it.
src/device/     The browser behind thin wrappers that never throw and can be swapped in
                tests; a native shell replaces the first three.
                geolocation.ts: one fix (currentPosition) and the stream of fixes a
                live drive follows (geolocationSource, on watchPosition).
                speech.ts: the voice, on speechSynthesis.
                wakeLock.ts: the Screen Wake Lock.
                visibility.ts: whether the page is in front.
src/live/       runner.ts: runs a live drive without React or any browser API of its
                own: feeds core/live.ts with fixes, ticks and answers, and carries
                out the effects it returns through whatever it is handed.
src/providers/osm/
                adapter.ts: pure Overpass API JSON -> signal nodes, the tile query, and
                the tile shape used by the cache and by the bundled tile files.
                client.ts: one abortable POST per tile (never rejects), and the polite
                client around it: two requests at a time, one per tile, a pause after a
                busy answer.
                bundle.ts: the pure part of the bundled tiles, shared by the build
                script and the app: which OpenStreetMap tags count as a signal, grouping
                nodes into tile files, the compact "runs per row" tile sets, and the
                index that says which tiles are covered and which have a file.
                coverage.ts: pure geometry for the build: reads an extract's boundary
                (.poly) and finds the tiles that lie entirely inside the boundaries.
                bundleLayer.ts: reads index.json once and then only the tile files it
                lists, from this site itself; a covered tile without signals is answered
                from the index alone. An index that could not be read makes coverage
                'unknown', never "not covered", and is read again after a short wait.
                tileSource.ts: loads tiles through the chain bundled tiles -> device
                cache -> network. A tile the bundle covers in full never reaches the
                cache or the network, and neither does any tile while the bundle's
                index cannot be read; other tiles are cached, refreshed after 30 days,
                and left alone for a while after a failure.
src/storage/    kv.ts: the tiny key-value store the signal data on the device goes
                through: IndexedDB, or memory where IndexedDB is not available.
                local.ts: the synchronous text store for the place book: localStorage,
                or memory without it; a full or blocked store reports the failed write.
                placeBook.ts: loads, saves and clears the place book under one
                versioned key (`routeiq.places.v1`); corrupt data is removed.
src/signalData.ts  Loads the signal data a set of routes needs (the tiles they touch)
                and wires up the sources the app uses, the bundled tiles ahead of the
                device cache and the network. askOnce wraps them for a drive that
                polls: a tile outside the bundle is asked for at most once per
                session, while a bundled tile that could not be read is tried again
                on a later check. forgetOldSignalData deletes the database of the removed
                City of Charlotte list (#13) when the app starts.
src/drive/      simulation.ts: the pure parts of the simulated drive: the simulated
                clock, when a poll is due, the budget of real Directions requests
                and the what-if delay. Decides no route.
                freshRoutes.ts: one check for fresh routes (Directions, signal
                counts, what-if), shared by the simulated and the live drive.
                replay.ts, replaySetup.ts: the development GPS replay, a made-up
                driver that is a position source like the device's GPS.
src/map/        Mapbox GL JS wrapper (draws only, decides nothing): draggable pins,
                route lines, signal dots, and for a simulated drive the car, the route
                being driven and the turn-off of a switch (driveFeatures.ts). pins.ts
                is the one source for pin roles and colors; attribution.ts is the
                OpenStreetMap credit shown on the map.
scripts/        Plain Node 24, no dependencies. The script imports the app's own tile
                arithmetic and adapters, so the files it writes are the shapes the app
                reads.
                build-signal-tiles.mjs: builds the OpenStreetMap signal tiles from
                regional extracts on disk (no network), with lib/osm-pbf.mjs, a minimal
                streaming reader for .osm.pbf files.
public/seed/    The signal data shipped with the app, served as static files and copied
                into the build: osm-signals/ (one JSON file per tile with signals,
                index.json, LICENSE.md: ODbL).
data/           Not in git: the downloaded extracts the tiles are built from.
src/useRoutes.ts   Fetches routes when a pin moves (on drag end), aborts the old request,
                adds signal counts when the signal data arrives, ranks the routes and
                tracks the selected one. Routes never wait for signals.
src/useDriveSim.ts Runs a simulated drive on a timer: moves the car, polls Mapbox from
                its position inside the request budget, loads signal counts for the
                fresh routes (never with retryFailed), asks core/reroute.ts and
                applies a switch. Orchestrates only.
src/useLiveDrive.ts  The live drive as React state: builds a runner per drive with the
                device's GPS (or the development replay) and mirrors its state.
src/LiveDriveView.tsx  The full-screen drive view. ReplayPanel.tsx: the replay control.
src/usePlaceBook.ts  The place book as React state, written to the device on change.
src/usePlaceSearch.ts  Search for one field: the runner, the session token, the pick.
src/PlanPanel.tsx  The trip input: the two search fields (comboboxes), "Use my location",
                the saved-place buttons, swap and reset, and "Recent and saved places".
src/DrivePanel.tsx The "Simulate drive" controls, the thresholds, the what-if control
                (development builds only) and the event log.
src/RoutePanel.tsx Route list in rank order: ETA, distance, signal count, difference from
                typical time, the reason for its place, and a "Recommended" badge on
                the top route. The highlight follows the selection, not the rank.
src/config.ts   Reads and checks VITE_MAPBOX_TOKEN.
src/App.tsx     Page shell; owns origin and destination (search, saved place, location,
                drag, swap, reset) and restores the last trip. Shows setup
                help instead of a map when the token is wrong (missing, secret, or
                rejected by Mapbox with 401/403).
tests/          Vitest: core helpers, route facts and formatting, signal counting, tile
                arithmetic, ranking, route ids and selection, Mapbox and
                OpenStreetMap adapters and clients against hand-written fixtures, the
                Search Box adapter and client (empty, malformed and error bodies,
                URL encoding, proximity order, session tokens), the search runner with
                a hand-fired timer, the place book and its storage (caps, repeats,
                corrupt and blocked storage), the geolocation wrapper, the
                tile cache chain and the whole signal path end to end against a stand-in
                Overpass server (no network anywhere), the bundle (tag rules, tile
                files, index, coverage of boundaries, bundle layer offline, the wait
                after a failed tile), the .osm.pbf reader against a hand-built extract,
                the build script run whole in a temporary folder, a US-521 style corridor trip
                across the state line and a tile edge, the key-value store, token check,
                core-purity guard, App, PlanPanel, RoutePanel and DrivePanel smoke tests.
                reroute.test.ts drives the reroute engine through scripted trips on a
                made-up road network (helpers/driveWorld.ts) with a fake clock:
                oscillating ETAs, a steady gain, a gain that comes too late, cooldown,
                no return, no alternatives, missing data, failed polls, the same
                route drawn differently (the patterns measured on real answers), a
                current route missing from the answers, off route, freeway exits, tiny trips,
                signals, determinism, and seeded random ETAs. drive.test.ts covers the
                simulated clock, the request budget at 1x, 5x and 20x, the what-if
                delay, a whole simulated drive offline, and the once-only signal
                sources. tracking.test.ts (noise, a U-turn, a route that crosses
                itself, poor fixes, off-route patience, arrival), guidance.test.ts
                (banner and voice fields, missing ones, what is due and when),
                live.test.ts (the session: cadence, standing still, off route,
                switching, "Keep previous route", budget, background, failures),
                device.test.ts (the wrappers and the voice's queue) and
                liveReplay.test.ts (whole replayed drives through the runner: a
                traffic change gives exactly one switch and the spoken lines in order).
                e2eWorld.test.ts checks the e2e road network against the real adapter.
e2e/            Playwright end-to-end scenarios (see End-to-end scenarios): *.spec.ts,
                harness.ts (offline router, fake clock, the made-up driver),
                browserStubs.ts (GPS, voice, request counting in the page),
                world/ (the made-up road network and traffic scripts),
                summaryReporter.ts (the one-page report), build.mjs (the test builds).
check-prereqs.ps1  Windows prerequisite check.
```

## Design workspace

`design/` holds the UI design explorations for the iPhone app (the three
directions and the merged direction for #21 and #22), built with the
[Stageshow](https://benji.org/stageshow) skill. It is a separate project with
its own `package.json`: the root `npm ci`, typecheck, lint, tests and e2e do not
touch it.

```
cd design
npm install
npm run dev        # http://127.0.0.1:5273
```

Decisions, stages and export commands are in `design/README.md`; the exports
to look at are in `design/exports/merged/`.

## Data sources

- **Routes and map:** Mapbox Directions API (`driving-traffic`) and Mapbox GL JS, with
  your token.
- **Live congestion along a route:** the same Directions requests (the plan, the drive's
  checks and the side-street probes) send `annotations=congestion,duration`, so every
  route comes back with the congestion (`low`, `moderate`, `heavy`, `severe` or
  `unknown`) and the traffic-aware travel time of each segment of its line. The docs
  ([Directions API, `annotations`](https://docs.mapbox.com/api/navigation/directions/),
  checked Nov 11, 2026) say `congestion` is "only available for the
  `mapbox/driving-traffic` profile", `duration` is "the duration between each pair of
  coordinates", and annotations "must be used in conjunction with `overview=full`" (which
  RouteIQ already sends). The adapter (`src/providers/mapbox/adapter.ts`) carries them into
  `RouteCandidate.segmentTraffic`, one entry per segment. A list that is missing or does
  not have exactly one entry per segment is null, never guessed, and a congestion word
  Mapbox does not document reads as `unknown`. Today only side-street probing uses it
  (see Side-street probing). **Cost:** nothing extra. The Directions API is "billed by
  requests" (docs, Pricing), whatever the parameters, and this is the same request; only
  the response grows, by two arrays the length of the route line.
- **Place search:** Mapbox Search Box API (`/suggest`, `/retrieve`), with the same
  token; see Planning a trip.
- **Traffic signals, primary:** OpenStreetMap, nodes tagged `highway=traffic_signals`.
  © OpenStreetMap contributors, licensed under the Open Database License (ODbL):
  https://www.openstreetmap.org/copyright. The data reaches the app in tiles of a tenth
  of a degree, only for the tiles a route touches, from two places:
  1. **Bundled tiles (primary).** Tiles built from the Geofabrik regional extracts of
     North Carolina and South Carolina (https://download.geofabrik.de/north-america/us/)
     and shipped with the app in `public/seed/osm-signals/`: one file per tile that has a
     signal, in the same shape as the device cache, an `index.json` and a `LICENSE.md`.
     Built Nov 11, 2026 from the extracts of Nov 10, 2026: 22,613 signal nodes in 902
     tile files, 1.2 MB. The index lists the 2,500 tiles that lie ENTIRELY inside the
     two states' extract boundaries (as 51 runs along 44 rows, 5 KB). Inside that set
     the bundle is the whole answer: a tile with a file is read from the app's own
     server, a tile without one is known to have no signals (no file, no request), and
     nothing is ever asked of Overpass or copied into the device cache. Freshness comes
     from rebuilding, not from per-tile refreshes. The panel shows the data's date
     ("Signal data: OpenStreetMap, Nov 2026").

     The index and the tile files are requests to the app's own server, and on a phone
     they can fail like any other (a dropped request, a 5xx, a dead zone). A failed
     read is never taken for "not covered". While the index cannot be read, coverage
     is unknown for every tile: no tile is asked of Overpass, looked up in or written
     to the device cache, and the count is partial (never 0). A covered tile whose
     file cannot be read is likewise missing, not sent on. Nothing retries on a
     timer: the next time routes are counted (a new plan, a check during a drive),
     the file is read again if its wait is over. The wait is 5 seconds, doubling to
     at most a minute while the read keeps failing (`DEFAULT_BUNDLE_RETRY` in
     `src/providers/osm/bundleLayer.ts`), and it is kept for the index and for each
     tile separately, so after a long outage a tile can stay partial for up to about
     two minutes after the server is back. "Retry signals" skips the waits. On the
     plan screen the count therefore stays partial until "Retry signals" is pressed
     or the routes change. Only the server answering 404 or 410 for `index.json`
     means there is no bundle (see below).
  2. **Overpass (backup).** A tile the bundle does not cover in full is loaded from the
     public Overpass API (https://overpass-api.de/api/interpreter, run by FOSSGIS
     volunteers; no key) with the query
     `[out:json][timeout:25];node[highway=traffic_signals](south,west,north,east);out;`.
     That is every tile outside the two states and the tiles on their outer edge: an
     extract is clipped at its boundary, so a tile that pokes into Georgia, Tennessee
     or Virginia would undercount if the bundle were trusted for it. Each such tile is
     fetched once, kept on the device, and refreshed about monthly. The Overpass server
     is shared and often busy, so RouteIQ sends at most two requests at a time, never
     two for the same tile, and after a busy answer (HTTP 429, 502, 503, 504, or no
     answer in 20 seconds) sends nothing for 30 seconds, doubling up to 8 minutes while
     the server stays busy. The pause survives a page reload. On top of that, a tile
     that could not be loaded is not asked for again for 30 seconds (doubling to 8
     minutes), so recounting a route does not retry it each time; "Retry signals" skips
     that wait. When Overpass fails the count is partial; for an edge tile the bundle's
     clipped part still feeds the lower bound.

  What counts as a signal: `highway=traffic_signals`, minus nodes whose
  `traffic_signals=*` says they are not an intersection signal (`blinker`,
  `emergency`, `ramp_meter`, `pedestrian_crossing`, `crossing`, `level_crossing`,
  `bridge` and a few more: see `EXCLUDED_SIGNAL_SUBTYPES`). In the two states that removed 288 of 22,939 nodes
  (105 emergency, 94 blinker, 82 pedestrian_crossing, 7 others). Pedestrian signals
  tagged `highway=crossing` + `crossing=traffic_signals` (10,067 of them) are not
  `highway=traffic_signals` and were never included. Overpass tiles (outside the
  bundle) are filtered by the same rule and list after parsing, so both sources drop
  the same nodes.

  **Rebuilding the tiles** (do it when the date in the panel gets old; monthly is plenty):

  ```powershell
  # 1. Download the extracts, their checksums and their boundaries (about 600 MB) into
  #    data/osm-extracts (git-ignored). Geofabrik asks for nothing but moderation.
  New-Item -ItemType Directory -Force data\osm-extracts | Out-Null
  $base = "https://download.geofabrik.de/north-america/us"
  foreach ($f in "north-carolina-latest.osm.pbf", "north-carolina-latest.osm.pbf.md5", "north-carolina.poly",
                 "south-carolina-latest.osm.pbf", "south-carolina-latest.osm.pbf.md5", "south-carolina.poly") {
    curl.exe -L -o "data\osm-extracts\$f" "$base/$f"
  }
  # 2. Build (about 6 seconds; no network). Stop `npm run dev` first, or keep the app tab
  #    closed: the script rewrites about 900 files under public/.
  npm run build:signals
  npm run build:signals -- --dry-run     # read and report, write nothing
  ```

  The script checks each extract against its `.md5`, streams it once with its own small
  `.osm.pbf` reader (it stops at the end of the nodes, about two thirds of the file),
  prints what it kept and left out by subtype, works out the covered tiles from the
  `.poly` boundaries, and writes through temporary files, the index last. Any other
  Geofabrik extract dropped into the folder with its `.poly` is picked up the same way.
  Exit codes: 0 written, 1 bad arguments, 2 an input is missing, damaged or fails its
  checksum (nothing is written then). Without the bundle (the server answers 404 or 410
  for `index.json`) the app still works: every tile is then loaded from Overpass on
  demand. A server that answers something else for a missing file, such as the Vite dev
  server's page with status 200, leaves coverage unknown instead: counts stay partial
  and Overpass is not asked.
- **Traffic signals, fallback:** the `traffic_signal` flags Mapbox puts on the
  intersections of a route, used only on stretches whose OpenStreetMap tile could not be
  loaded (outside the bundle, with Overpass failing).
- **License:** OpenStreetMap data is ODbL. `public/seed/osm-signals/LICENSE.md` says so
  and also credits Geofabrik for the extract. On screen, the map carries "© OpenStreetMap
  contributors" (linked to the copyright page) in its attribution next to Mapbox's own,
  and the note under the route list credits OpenStreetMap too. A second, City of
  Charlotte list (non-commercial license) was used in earlier versions and removed (#13): it
  added no signal on eight ordinary trips, and its non-commercial license would block a
  distributed app.

How the count works, in this order:

1. Signal points within 60 m of each other are one intersection (OpenStreetMap tags each
   approach of a big junction as a signal of its own).
2. An intersection counts when it lies within 30 m of the route line.
3. It counts only if the route itself has an intersection within 40 m of it, taken from
   the Mapbox steps. A street that passes over or under the route has no intersection
   with it, so its signals are left out. A route without an intersection list skips this
   rule rather than losing every signal.

Counted intersections within 40 m of each other along the route count once. All of
these distances are set in one place, `DEFAULT_SIGNAL_MATCH` in `src/core/signals.ts`.

Each count comes with its coverage. **Full** means every tile the route touches was
loaded: the number is the answer, and "0 signals" really means none. **Partial** means
a tile was missing (a trip outside the bundled states with the Overpass server busy,
or offline): the number is what
OpenStreetMap and the Mapbox flags found between them, shown as
"≥ 9 signals (partial)", a lower bound; hovering it says that data for part of the
route is missing, and a line under the list offers a retry. When nothing is known the
panel says "Signals: unknown". A count that is not full is never shown as a plain number or as
zero, and is not used for ranking.

Freeways: a signal on a ramp or on a street crossing over or under a freeway is not a
stop for someone driving the freeway. Rule 3 removes most of these. One case is left to
a second check: signal data can mark an interchange with a point on the freeway line
itself, right where a ramp joins, and the route does have an "intersection" there. So
Mapbox's road classes are still used: a signal whose position along the route is inside
a stretch of freeway (class motorway or motorway_link), more than 30 m from either end,
is left out. The 30 m keeps the light at the foot of an off-ramp, and the one where a
freeway begins or turns into a street. Known limits: OpenStreetMap is only as complete
as its mappers have made it; a group of signals is formed by chaining points up to 60 m
apart, so two signalized intersections closer than that would count as one; and the
Mapbox flags used on missing stretches are a rough stand-in.

Checked against real data (Nov 2026, the bundle and live routes): at 60 m, Charlotte's
OpenStreetMap signals formed the same intersections as the city's own list (used for
this check only; the city data was removed from the app in #13) in all but two
places, where two signals 54 and 56 m apart become one (N Graham St at W 24th St and
Woodward Ave; Westinghouse Blvd at the I-485 ramp and at I-77/Texland Blvd). At 50 m one
of those remains and one intersection splits in two; at 40 m none is merged but 19 big
intersections split. In Uptown's tight grid the closest distinct signals are 67 m apart
(the 68 to 70 m blocks between 3rd and 6th Streets), so 60 m holds there with little to
spare. Known over-counts that the distances do not fix: a turn on a slip lane beside a
signalized intersection is counted (the route does meet the junction), and a signal at
a ramp beside an expressway that Mapbox classes `trunk`, not `motorway`, can be counted
where the route only passes a ramp fork (seen on E Independence Blvd near Albemarle Rd).

How ranking works: the route with the best traffic-aware ETA comes first. Routes within
30 seconds of it count as tied, and among those the one with fewer signals wins; a
route whose signal count is unknown or partial keeps the place its ETA gives it. No time is added
per signal, because a traffic-aware ETA already includes the usual wait at signals.

## Rerouting (simulated drive)

"Simulate drive" in the panel ("Start simulated drive") puts a car on the selected route and drives it on a
simulated clock at 1x, 5x or 20x. Every 60 seconds of simulated time the app asks
Mapbox for routes from the car's position to the destination, hands them to the reroute
engine, and applies a switch by itself. The event log lists every decision with its
simulated time and the engine's reason, newest first. Pause, Resume and Stop are next to
it; moving a pin, Swap and Reset end the drive. While a drive is on, the route list and
the map show what the last check returned from the car's position, the route being
driven is drawn in black on a white casing with the car on it, and an amber dot marks where a switch
leaves the old route (hollow while the switch is still waiting to be confirmed).
The map gets the route's line only when the route changes; on each fix it gets the car
(a few hundred bytes) and the part behind the car is trimmed off the line
(`line-trim-offset`, src/map/driveLayers.ts), for the live drive too (#94).

The engine (`src/core/reroute.ts`, `decideReroute`) applies these rules in order:

1. A failed check changes nothing but a counter.
2. Off route (the fresh routes start more than 50 m from the current route's line):
   take the best fresh route at once.
3. Like for like: the fresh route that IS the rest of the current route gives the
   current route's fresh ETA, and everything is compared with that. "Is" means the same
   roads from the car to the destination, measured by overlap and not point by point:
   at least 95% of the length of each line within 20 m of the other, no single stretch
   apart longer than 400 m (nor the two lengths differing by more), no point of a
   stretch apart more than 50 m from the other line, both ending at the same place, and
   the first 150 m after the car not compared (nor, for an answer fetched a moment
   before the position was taken, the part behind the car). Route ids are never
   compared between checks. A fresh route that is the same road with a small variation
   (the other lane group at an exit, a corner drawn differently) is the current route
   for this purpose and is never an alternative to it.
4. Current route not among the fresh routes (Mapbox returns three at most): that alone
   is no reason to leave a perfectly good road, so the route and its guidance are kept.
   Its ETA is asked for by one more request, for the current path itself through via
   points along it (see "The request"). If the answer is the current path with traffic
   data, it is the baseline and rules 5 to 10 apply as always: a switch then is an
   ordinary "faster route" with a real saving. If there is no usable answer (the
   request failed, a via point would not snap to a road, or the answer is some other
   road): stay, and the count below is kept as it is. Only when Mapbox finds no route at
   all along the road ahead three times, with no check between them that found the
   current route, is the road taken to be closed and the best fresh route taken (if its turn-off is far
   enough ahead and the cooldown is over), announced as "The road ahead on your route
   looks closed". Off the route (rule 2) is the tracker's verdict and stays as it was.
5. Missing data (no alternative, no travel time, no typical duration to show the time
   includes traffic): stay.
6. Minimum saving: at least 120 seconds AND at least 5% of the time left.
7. No return: a route left less than 10 minutes ago needs twice the minimum saving.
8. Too late: the turn-off (where the alternative leaves the current route, or its
   first maneuver the current route does not share, whichever is sooner) must be at
   least 400 m ahead, at least 20 seconds of driving ahead, and at least 1200 m when
   it is a freeway exit. Ahead of where the driver is when the answer is used: in a
   live drive the distance driven while the request was out (`drivenSinceM`) is taken
   off first (the simulated clock stands still meanwhile).
9. Confirmation: the same alternative has to pass rules 6 to 8 two checks in a row.
10. Cooldown: no second switch within 5 minutes of the last one.

Alternatives are tried in ranking order (best ETA, signals only breaking ties of 30
seconds), so signals can choose between two alternatives that both save enough, but
never justify a switch on their own. A signal count that is partial or unknown has no
say. A side street that a check's own probe found (see Side-street probing, During a
drive) is one more alternative among the fresh routes and goes through the same rules,
with one difference in what it is measured against: its time was asked through a via
point, so the saving is measured against the current path asked the same way, never its
ordinary time, and without such a time it cannot count. Every decision comes with one short sentence fit to be spoken, such as "Staying:
faster route saves only 40 seconds" or "Switching: saves 3 minutes, turn in 0.8 miles".

| Threshold (`DEFAULT_REROUTE_OPTIONS`) | Default |
| --- | --- |
| `minSavingSec` | 120 s |
| `minSavingFraction` | 0.05 (5% of the time left) |
| `confirmPolls` | 2 |
| `cooldownSec` | 300 s |
| `noReturnSec`, `returnSavingFactor` | 600 s, 2x |
| `minLeadDistanceM`, `minLeadTimeSec` | 400 m, 20 s |
| `freewayLeadDistanceM` | 1200 m |
| `routeLostPolls` (checks with no route along the road ahead, none between them finding the current route) | 3 |
| `routeLostWindowSec` (a "no route" answer older than this no longer counts) | 900 s |
| `offRouteM` | 50 m |
| `sameRouteToleranceM` (a point is on the current route: where an alternative turns off) | 10 m |
| `matchToleranceM`, `matchMinOverlap` (a fresh route IS the current one) | 20 m, 0.95 |
| `matchMaxGapM` (longest stretch apart, and largest difference in length) | 400 m |
| `matchMaxDivergenceM` (farthest a point of a stretch apart may be from the other line) | 50 m |
| `matchIgnoreStartM` (not compared after the query point) | 150 m |
| `matchStartSearchM` (where the fresh route starts is looked for on this first stretch of the path ahead, first) | 200 m |
| `baselineViaSpacingM`, `baselineMaxViaPoints` (asking for the current path) | 3000 m, 6 |
| `returnOverlapFraction` | 0.5 |
| `requireTypicalDuration` | true |
| `etaTieWindowSec` | 30 s |

"Reroute settings" in the panel changes them, and the poll interval, for the page's
lifetime; changes apply from the next check.

**Request budget.** A simulated drive makes real Directions requests, so they are
rationed: at most one per 5 real seconds whatever the speed (at 20x that stretches the
check interval to about 100 simulated seconds), and at most 60 per drive, after which
the car drives on without checking. The side-street probes of the checks count against
the same 60 (see Side-street probing, During a drive). The panel shows the count. The simulated clock
stands still while a check is out, so the answer is always for the place the car is at.
The default trip took 25 requests at 20x (Nov 2026, before the checks' side-street
probes, which add up to one a check and 20 a drive); at 1x or 5x it took about 40.

**The request.** A check is the same `driving-traffic` request as the first one, from
the car's position, plus `bearings=<heading>,45;`: the car's heading with 45 degrees
either side for the origin, nothing for the destination, so the routes start in the
direction of travel and not with a U-turn or on the opposite carriageway. No
`depart_at` is sent: without it the profile routes for now on live traffic. Checked in
the Mapbox Directions docs, Nov 2026: `bearings` needs one entry per coordinate and an
entry may be left empty; `radiuses` (how far a coordinate may snap) is left at its
default; `waypoints` and `continue_straight` only matter with intermediate coordinates,
which a check does not have; `avoid_maneuver_radius` (1 to 1000 m, no maneuver that
close to the origin) exists for this case but is not used, because the engine's own
too-late rule gives a reason that can be shown.

**The second request (only when the current route is missing from the answer).** To
get a travel time for one particular path, the request carries points of that path as
extra coordinates and `waypoints=0;N` (N the index of the destination), which names
only the first and last coordinate as waypoints: the ones between guide the path
without adding legs or "arrive" steps ("silent" waypoints; the leg lists them under
`via_waypoints`). Checked in the Mapbox Directions docs, Nov 2026: `waypoints` must
include the first and last index, and every profile, `driving-traffic` included, takes
up to 25 coordinates. `baselineProbe` (`src/core/reroute.ts`) picks the points: on the
stretches of the current path that the fresh routes leave, one every 3 km, six at most,
each with the route's heading as its `bearings` entry; `alternatives=false`. The answer
is used only if it is the current path by the matching of rule 3. Measured on real
answers (Nov 11, 2026): with 2 to 10 via points the answer was the current path in 10
of 13 tries; with more than 8 coordinates in all `duration_typical` came back null,
which the engine refuses to compare, hence the cap of six via points; and the time for
a path asked this way ran 3 to 13% below Mapbox's time for the same path as an
ordinary route (2016 s against 2297 s in the one pair taken minutes apart at the same
place). Why is not known. It makes the current route look slightly better than it is,
so the bias is towards staying. The request counts
against the budget and is made only when a check leaves room for it.

**Signals during a drive.** Fresh routes are counted from the bundled tiles like any
other route. A check never passes `retryFailed`. Outside the bundle the plain tile
source would ask Overpass again for a failed tile every 30 seconds to 8 minutes; a
drive goes through `askOnce` (`src/signalData.ts`), which asks for such a tile at most
once per page session. That rule is for Overpass tiles only. A bundled tile that could
not be read (its file, or the bundle's index, in a dead zone) is not given up on: it
never reaches Overpass, and it is read again on a later check or drive once its short
wait is over (5 seconds, doubling to a minute). Until then its routes stay partial.

**What-if (development builds only).** There is rarely a faster route to be had on
demand, so `npm run dev` shows a boxed control, labelled as simulated: it adds a delay
you choose (5 minutes by default) to the current route's ETA at every check from the
next one on, until a switch or Clear. Log lines made with it are marked `[what-if: ...]`.
It lives in `src/drive/simulation.ts`, outside `src/core`; the engine cannot tell and
applies its normal rules. Note what follows a what-if switch: the delay is gone, the
route just left is truly the faster one again, and the engine goes back to it by its
own rules (after the cooldown and for twice the saving, measured against the travel
time asked for the route it was moved to when Mapbox no longer offers that one).

**Not covered by the simulation.** The car sits exactly on the route line at a steady
speed. What real GPS needs before this engine (positions matched to the route, an
off-route test with patience, a smoothed speed, and the position the directions query
was sent from passed with its answer) is the live drive's job: see Live drive.

**Why the matching is by overlap (measured Nov 11, 2026, mid-afternoon).** Until then
rule 3 wanted every point of both lines within 10 m of the other, and rule 4 left a
route after three checks without a match ("current route is no longer offered"). On
the default trip that fired on the first miles out of Uptown with no traffic change.
So 27 answers were collected from positions along two routes (Uptown to Indian Land;
the airport to UNC Charlotte), with and without `bearings`, and each fresh route was
laid over the rest of the route being driven:

| What came back | Answers | Old match | Share within 10 / 20 / 30 m | Where it differed |
| --- | --- | --- | --- | --- |
| The current path exactly | 17 | yes | 100 / 100 / 100% | nowhere (under 3 m, start included) |
| The current path, the other lane group at one freeway exit (first 3.3 km of the default trip, the only route returned) | 5 | no | 86 / 98 / 99.6% | three stretches of 160 to 280 m, 22 to 39 m apart, 21 to 24 km ahead |
| The current path, one corner drawn differently (second route, from 11 km on) | 5 | no | 100 / 100 / 100% by length | one vertex 14.1 m off |
| A different route (the second answer, when there was one) | 19 | no | 3 to 72% within 20 m | one or two stretches, 2.7 to 45 km in all |

Mapbox returned the route being driven every time; the 10 m all-or-nothing test
rejected it in 10 of 27. `bearings` made no difference to any answer, the start never
snapped more than 2.5 m away, and the number of vertices differed without harm. With
the rule above all 27 match and none of the 19 different routes does. A replay of the
default trip at 20x then made 24 checks and no switch (the old test would have missed
the first three and switched); with the what-if delay it made one, "Switching to a
faster route. Saves 2 minutes. Turn in 3.5 miles." The current route was genuinely
missing from an answer only after that what-if switch, on a route Mapbox itself
ranked slower: that is the case rule 4 now handles by asking.

**How far apart counts (#41).** The overlap rule measured how long two lines run apart,
not how far apart, so a fresh route that left the current one for a single stretch
under 400 m that also fit in the 5% allowance (one city block around, on a trip with
more than some 7 km left) counted as the current route. No point of a stretch apart may
now be more than 50 m (`matchMaxDivergenceM`) from the other line: above the farthest
drawing difference measured (39 m, the other lane group at an exit), below a street one
block over. So when Mapbox routes round one closed block, that answer is another route,
the current path is asked for with a via point on the block itself, and three "no route"
answers take the detour.

**Known limit: closures between via points.** The via points sit on the stretches the
fresh routes leave, one every 3 km. When the fresh routes leave the current path for a
long way and the closure is short, the points can miss it, and Mapbox routes through them
and around the closure: "another road". That says nothing either way, so the engine stays
(no ETA shown), and the count of "no route" answers is kept, not started over (it used to
be, so such a closure never added up). The closure is taken only once three checks in all
have put a point on it; until then, or if none does, the driver finds out at the closure
and the off-route rule takes over from there. `tests/reroute.test.ts` pins these cases.

**Old "no route" answers age out (#68).** Each "no route" answer is kept with the time
of its check, and only those from the last 15 minutes (`routeLostWindowSec`) count
toward the three. Without it, one answer early in a long drive, then a quarter of an
hour of "another road" answers, then two more, made three, though the first was about a
road long since passed. The window only ever takes answers away, so it can delay a
closure switch, never bring one sooner: three answers within 15 minutes switch exactly
as before. At the 60 s check interval that is room for 15 checks; a poll interval set
above 7.5 minutes would let no three answers fit, and a closure would then be found at
the closure itself (off route). The e2e scenario "when a block ahead is closed, it
reroutes around it" drives it end to end: a block of Main Corridor closes, Mapbox stops
offering it, the drive's check of its own path comes back "no route" three times, and
the drive changes to East Loop with "The road ahead on your route looks closed."

**Routes that cross themselves (#74).** Where the fresh route starts is looked for on the
first 200 m of the path ahead (`matchStartSearchM`, from 50 m behind the car), and on the
rest only when nothing there is within 20 m (`matchToleranceM`). It used to be the nearest point of the whole
path: under a cloverleaf bridge the later pass over it can be a meter nearer the snapped
start than the road being driven, the comparison then started after the loop, the
lengths differed by more than 400 m, and the current route went "unconfirmed" (a spent
check, and a lost confirmation). 200 m is shorter than a cloverleaf loop; a loop back to the same spot within 150 m of the car would still be in the window.
The tracker had the same flaw on a drive's first fix only (later fixes already take the
pass that fits the progress so far): of passes about as near (15 m), it now takes the
first in driving order.

**Matching cost (#51).** The comparison walks both lines in 10 m steps. Each step looks
only at the segments of the other line in the 3 x 3 grid cells (50 m wide, a bounding-box
index built per comparison) around it, and the match stops at the first stretch that
rules it out. On a synthetic 100 km route (5000 vertices, three alternatives 2 to 4 km
apart for 45% of the way) `findCurrentRoute` went from about 730 ms to 3 ms on desktop
Node. The test counts the work (segment checks and grid entries) and pins it at no more
than twice the old vertex-by-vertex matcher's; measured, it is 2% of it (0.5% when the
current route is among the answers).

## Route hand-off (Google Maps and Waze)

The selected route in the list has two links, "Open in Google Maps" and "Open in Waze".
Both open in a new tab (on a phone, the app when it is installed). Google Maps and Waze
both run on CarPlay, so this is the way to drive a RouteIQ-chosen route in the car before
RouteIQ has a CarPlay app of its own.

**Google Maps** chooses its own route between two points, so RouteIQ pins it with
waypoints (`handoffWaypoints`, src/core/handoff.ts, pure). The accepted route is sampled
every 25 m and compared with each alternative; wherever an alternative leaves it for at
least 300 m, a point goes on the accepted route 150 m past the split, where the
alternative cannot be (never in a short stretch the alternative shares with it). One
point serves every alternative it rules out. When there are more splits than Google
allows, each alternative's longest divergence is pinned first, so as many alternatives
as possible are ruled out, and the rest go to the next longest divergences.
No point goes within 500 m of either end, along the route or in a straight line. Routes
with no split (identical roads, or no alternatives) get no waypoints.

The link uses the official Maps URLs directions form
(`https://www.google.com/maps/dir/?api=1&origin=…&destination=…&travelmode=driving&waypoints=…`),
with coordinates as `lat,lng` to six decimals and every value percent-encoded, so the
comma is `%2C` and the pipe between waypoints is `%7C`. Limits from the docs: up to three
waypoints in a mobile browser and nine elsewhere, and 2,048 characters per URL. RouteIQ
uses three on anything that looks like a phone or tablet, nine otherwise, and if a URL
would pass 2,048 characters it drops waypoints least decisive first. Source:
[Google Maps URLs, Directions](https://developers.google.com/maps/documentation/urls/get-started#directions-action)
(checked Nov 11, 2026).

**Google treats waypoints as stops.** A route through them uses the roads RouteIQ chose,
but between the points Google picks its own turns, and it announces each point as a stop
on the way. It pins the road choice, not every turn. Splits RouteIQ never saw (Mapbox
returns at most three routes) are not pinned either.

**Waze** deep links take a destination and nothing else
(`https://waze.com/ul?ll=lat%2Clng&navigate=yes`), so the Waze link starts navigation to
the destination and Waze picks the whole route. Source:
[Waze deep links](https://developers.google.com/waze/deeplinks) (checked Nov 11, 2026).

| `DEFAULT_HANDOFF_OPTIONS` | Default | Meaning |
| --- | --- | --- |
| `maxWaypoints` | 3 | Most waypoints (the UI passes 3 on mobile, 9 elsewhere; never more than 9) |
| `sampleStepM` | 25 m | Spacing of the samples along the accepted route |
| `sharedToleranceM` | 30 m | A sample this close to an alternative counts as shared with it |
| `minDivergenceM` | 300 m | Shortest divergence that counts as a split |
| `minSharedM` | 200 m | A shared stretch shorter than this (a crossing) does not end a divergence |
| `afterSplitM` | 150 m | How far past the split the waypoint goes |
| `endpointClearanceM` | 500 m | No waypoint this close to the origin or destination |
| `maxUrlLength` | 2048 | Google Maps URL length cap |
| `coordinateDecimals` | 6 | Decimals in URL coordinates (about 0.1 m) |

## Side-street probing

Mapbox Directions returns at most three routes, so a faster cut-through outside them is
never seen. The plan screen widens the search with via points: `selectViaPoints`
(src/core/probe.ts, pure) picks a few points just off the fastest route, and once the
three routes are on screen the app asks Mapbox for origin → via → destination for each,
then ranks what comes back with the other routes, by the same rules
(ETA first, signals only inside 30 s), so a side street wins only on ETA. A probed route
is marked "via side streets" in the route list.

- **Selection.** When a probed route comes back faster and the user has not picked a
  route, the selection moves to it (it is now the recommended one), and a polite live
  region says so: "Faster route found via side streets, saves N min." (`sideStreetNotice`,
  src/core/probe.ts: minutes against the best route Mapbox offered, rounded; "under a
  minute" below 30 s; a probe that won only on the signal tie-break is not called faster).
  The pointer over the route list or Start drive, or keyboard focus on either, counts as a
  pick of the route selected then, so a route that joins (and reorders the list) cannot
  move the selection under a tap or a Start drive already on its way.
- **Signal counts.** While a probed route's signal tiles load, the routes already counted
  keep their counts (and their tie-break); only the new route shows "Counting signals…".

- **When.** Probes go out 800 ms after the main routes arrive (`debounceMs`). The main
  routes never wait for them: they show, rank and get their signal counts first, and a
  probed route joins the list (and the ranking) when it comes back. A pin move, a picked
  place or a retry cancels the wait and aborts any probe in flight, and an answer for the
  old trip that arrives anyway is ignored.
- **How many.** At most `requestsPerPlan` (2) probe requests per plan, cut from
  `selectViaPoints`' order. A trip with nothing to probe (freeway-only, or under 3 km)
  makes none. A drive's checks probe too, on a budget of their own (During a drive, below).
- **The request.** `fetchProbeRoute` (src/providers/mapbox/client.ts): `driving-traffic`,
  the three coordinates, `waypoints=0;2` and no alternatives. With `waypoints` naming only
  the origin and the destination, the via is a silent waypoint: Mapbox's docs say the
  parameter can "guide the path of the route without introducing additional legs"
  ([Directions API, `waypoints`](https://docs.mapbox.com/api/navigation/directions/),
  checked Nov 11, 2026), so the answer is one leg, with no stop or "arrive" at the via,
  and its ETA is a drive straight through. It also sends `radiuses=unlimited;250;unlimited`
  (`viaRadiusM`): the docs say "There must be as many radiuses as there are coordinates in
  the request", each "any number greater than 0 or the string unlimited", and "A NoSegment
  error is returned if no routable road is located within the radius"
  ([Directions API, `radiuses`](https://docs.mapbox.com/api/navigation/directions/#optional-parameters),
  checked Nov 11, 2026). A via in a field or a lake then comes back as NoSegment instead of
  snapping onto the nearest road, which is often the fastest route itself (a billed request
  for a certain repeat) or a dead end. The origin and destination may move as far as they must.
- **Failures are dropped.** A via too far from a road (`NoSegment`, HTTP 200 per the
  docs' error table), no route, rate limiting, an HTTP or network error or an abort makes
  that probe come back empty. Nothing is shown and the plan is untouched.
- **Repeats are dropped.** Mapbox snaps a via onto the nearest road, and that is often a
  route already on screen. `mergeProbeRoutes` (src/core/probe.ts) keeps a probed route
  only when its path differs from every route in the list (`sameRouteGeometry`, 10 m, the
  same test that keeps a picked route selected; ids are not compared), and tags it
  `source: 'probe'`.
- **Dead-end spurs are dropped.** A probed route that passes within 10 m of every point of
  a route already in the list, that route sampled every `coverSampleM` (10 m), is that route
  plus a spur or loop out to the via: never faster, and not a side street. `coversRoute`
  checks one way only, so the probe's extra roads are allowed, and the sampling between
  vertices keeps a real cut-through that leaves a long straight segment.
- **The comparison is linear.** Both tests walk along the line and look at the few
  segments after the last one a point was near; only a miss measures further (the whole
  line for the first 8 misses, then a segment grid, `segmentGrid` in src/core/geo.ts, the
  one the reroute matcher uses). A point counts as near only when a segment really is
  within 10 m, so the answers are those of measuring every segment (#93: a 60 km plan
  went from about 0.4 s to under 5 ms on a desktop).

| `DEFAULT_PROBE_BUDGET` | Default | Meaning |
| --- | --- | --- |
| `requestsPerPlan` | 2 | Most probe requests per plan (never more than `maxPoints`; under 1 turns probing off) |
| `debounceMs` | 800 ms | How long the main routes must stay put before the probes go out |

What a plan costs in Directions requests (100,000 free a month, then $2.00 per 1,000; see
Planning a trip):

| | Requests |
| --- | --- |
| Main routes (Mapbox's up to three) | 1 |
| Side-street probes | 0 to 2 (0 for freeway-only trips, trips under 3 km, or when the pins move again within 800 ms) |
| A whole plan | at most 3 |

**During a drive** (PLAN step 11c, #5; live and simulated drives alike). A check can
also find a side street the plan did not, or one that only pays once a jam builds:
after the check's fresh routes (and its path check, when one is made) are in,
`checkProbes` (src/core/probe.ts, pure) picks the via points by the rules below, from the
car: beside the route being driven as the check found it, clear of every fresh route and
of the path check's answer, none within 1 km of the car or the destination. A check that
did not find the route being driven (not offered, and its path check failed or brought
back another road) makes no probe: the engine compares nothing then (route-unconfirmed),
and a probe could come back as the current path and stand in for it. Nor does a check on a
route that is not held up: no jam reported on it ahead (a point aimed at one,
`congestedSpanM`) and less than `minDelaySec` (2 minutes) over its typical time. A side
street cannot save what the traffic is not costing, and a probe costs a request.
`fetchFreshRoutes` (src/drive/freshRoutes.ts) asks for each point from the car, with its
heading as `bearings`, the via with its 250 m radius, to the destination. A probed route
that is a new path joins the fresh routes (`mergeCheckProbes`: the plan screen's repeat and
dead-end-spur rules, against the fresh routes and the path check's answer), tagged
`source: 'probe'` with the via it was asked through, and `decideReroute` judges it by the
rules every alternative goes through: 2 minutes and 5 % saved, two checks in a row, the
lead distance, the cooldown, no return. No threshold changed.

- **Like for like (#81).** Mapbox's time for a path asked through via points ran 3 to 13 %
  below its time for the same path as an ordinary route (Rerouting, The second request). A
  probed route is asked through a via, so it is never measured against the current route's
  ordinary time: `decideReroute` compares it only with the current path asked the same way,
  through via points (`observation.baseline`), and never with more than its ordinary time
  when the check has both (a path check can read high too; the lower is the safe one).
  When the check made no path check (the
  current route was among the fresh routes), one is made after a probe that found a new
  path: through points of the current path where the probed routes leave it
  (`baselineProbe`). Without its answer (no room, a failed request, another road back) the
  probed route cannot count on that check, not even towards confirmation: "a side street
  may be faster, but its time could not be compared like for like" (`probe-unconfirmed`),
  and a confirmation in progress starts over. An equal-time side street therefore saves
  nothing however low both via-asked times come back (`tests/reroute.test.ts`, 3 to 13 %).
  Probed routes are also never taken as the current route, the off-route pick or the
  route-lost pick, which have no saving to compare. What is left: the probe goes through
  one via, the path check through one to six, and whether the bias depends on the count
  is not measured (#81).
- **Time limit.** The probes and the path check they need have `timeoutSec` (8 s) in all;
  then they are cancelled and the check answers with the fresh routes alone, so a slow
  or hung probe never holds a check up longer than that. Whatever the delay, the engine
  judges the answer where the car is when it is used: the distance driven since the
  request was sent (`drivenSinceM`, from the tracker) is taken off every turn-off, for the
  too-late rule and for what is said (Rerouting, rule 8).

- **Which point.** One probe per check by default, so the points take turns check by
  check (`round`): one side of a stretch, then the other. While the engine is confirming
  (or holding through its cooldown) a probed route, the next check asks through that
  route's own via first (`keep`), since a confirmation needs the same route on
  consecutive checks and the points move with the car. A failed check keeps it, as the
  engine keeps its confirmation; anything else that ends the confirmation, a switch or
  "Keep previous route" included, drops it. The kept via is dropped too once it is within
  the endpoint clearance of the car or the destination, behind the car, or on a road a
  check now offers.
- **Budget.** Probes share the drive's request budget (`maxRequests`, 60) and never take
  the request a check's path check may need: a probe goes out only while, after the check
  itself, one request would still be left for that path check (`checkProbeAllowance`). At
  most `requestsPerDrive` (20) probes a drive, so most of the budget stays for the checks.
  A search for a new route (off the route) and the first route never probe. Nothing to
  probe (under 3 km left, freeway only, a route not held up) costs nothing. Every request
  is counted as it is sent (the shell reports it: `request-sent`), so the requests of a
  check that is cancelled before it answers (End, off the route, "Keep previous route")
  count too, and 60 and 20 are exact.
- **Said as such.** A switch onto a probed route says "Switching to a faster route via side
  streets. Saves 4 minutes. Turn in 1.1 miles." and the banner "Switched to a faster route
  via side streets: saves 4 minutes"; the simulated drive's log adds "(via side streets)".
- **Diagnostics.** In the iPhone shell's drive diagnostics a probe is logged as
  "request N (probe)" and a path check as "request N (path check)", with a count of each.
  A probe that finds no road (NoSegment) or no route is a normal answer, not a fault.

| `DEFAULT_DRIVE_PROBE_BUDGET` | Default | Meaning |
| --- | --- | --- |
| `requestsPerCheck` | 1 | Most probe requests per check (under 1 turns probing off during a drive) |
| `requestsPerDrive` | 20 | Most probe requests per drive, out of `maxRequests` (60) |
| `minDelaySec` | 120 s | A route with no jam reported ahead is probed only when it is this far over its typical time |
| `timeoutSec` | 8 s | How long a check's probes and the path check they need may take in all |

What a check costs: 1 request, plus 1 for the path check when the route being driven is
not among the fresh routes, plus 0 or 1 probe, plus 1 path check after a probe that found
a new path when none was made yet: 3 at most. Only checks on a held-up route probe; the 20
probes then last about 20 such checks, after which a check costs 1 or 2.

How the points are chosen: the fastest candidate's surface-street stretches (everything
outside its freeway spans, with the first and last kilometer cut off) are taken slowest
first, by Mapbox's live congestion (`segmentTraffic`, see Data sources): a stretch with at
least `minCongestedM` (300 m) of `heavy` or `severe` traffic (`congestedLevels`; congested
runs `congestionGapM`, 200 m, or less apart count as one jam) comes first, the most
congested first, and is probed beside the middle of its longest jam. The other stretches
follow, longest first, each probed at its middle. A route without congestion data, or with
none at those levels (`moderate` and `unknown` are never a jam), is the old rule unchanged:
the longest stretch stands in for the slowest. Each point is placed square to the route, on
both sides. A point that
lands near any known route is moved further out or dropped, since it would only repeat
that route, and a point within the endpoint clearance of the origin or destination in a
straight line is skipped too (a stretch can bend back toward an end). Within a stretch the
side with more room from the other known routes goes first. The first side of every stretch
comes before any second side, so a small budget spreads over the trip. Unknown road kinds
count as surface street, and so does a freeway span with a NaN bound or no length. Freeway-only
trips and trips under 3 km get no points. Each point says which jam it aims at
(`congestedSpanM`, null when it was placed without traffic data). The per-segment
durations are carried but not used for the choice yet.

| `DEFAULT_PROBE_OPTIONS` | Default | Meaning |
| --- | --- | --- |
| `maxPoints` | 3 | Most via points returned (each one is a Directions request later) |
| `minTripM` | 3000 m | Shorter trips get no probes |
| `endpointClearanceM` | 1000 m | No probing this close to the origin or destination (along the route for the stretch, straight-line for the point) |
| `minStretchM` | 1500 m | Shortest surface-street stretch worth probing |
| `offsetsM` | 500, 800 m | Distances from the route tried per side, nearest first |
| `clearOfRoutesM` | 250 m | A point this close to any known route is not used |
| `headingWindowM` | 150 m | Route heading at the probe spot is taken over ± this |
| `viaRadiusM` | 250 m | How far Mapbox may move the via onto a road (`radiuses`); no more than `clearOfRoutesM`, so a via never snaps back onto a known route |
| `coverSampleM` | 10 m | A known route is sampled this often when checking whether a probe covers it (dead-end spur) |
| `congestedLevels` | heavy, severe | Mapbox congestion levels that count as a jam to aim at |
| `congestionGapM` | 200 m | Congested runs this close together or closer are one jam |
| `minCongestedM` | 300 m | A stretch needs this much congested road to be aimed at by the data; below it, it is ordered by length |

## Live drive

"Start drive" at the top of the route list is the one tap. After it nothing needs
touching: RouteIQ asks for the location permission, starts on the route you picked,
follows the car, checks Mapbox for faster routes,
changes route by itself and announces it, speaks the turn prompts, and at the
destination stops and shows a short summary (trip time, the switches and why).

**It drives the route you picked** (#66). The route selected on the plan screen goes
with the Start tap: the recommended one, a slower one picked on purpose, or a side-street
route the plan's probes found (`source: 'probe'`). When the first good fix is on that
route's line (the tracker's own test, `offRouteM` 50 m), the drive starts on it with no
request of its own, and the plan's answer counts as the first one: the first check goes
out a poll interval (60 s) later. A first fix that is not on it (the trip was planned
from somewhere else) plans a route from there, as before. From then on the engine judges
the picked route like any other. Mapbox does not offer a side street by itself, so a
check from the car usually lacks it; the existing path check (`baselineProbe`, one more
request through via points along the route being driven) gives its like-for-like ETA,
and when that cannot be had (no budget, a failed request, another road back) the route
is unconfirmed, not lost: the drive stays on it, and only "no route along the road
ahead" `routeLostPolls` times in a row counts against it. No threshold changed.
Each check may also probe one side street of its own (#5, see Side-street probing, During
a drive), so a drive can still move onto a side street the plan did not recommend. The
probes come out of the same 60 requests, so on a long drive the checks run out up to a
third sooner (20 probes at most).

**The limit of the web version.** A browser only runs a page while it is in front with
the screen on. Lock the phone or switch to another app and the position, the checks and
the voice stop. RouteIQ holds the screen awake where the browser allows it, and when the
page comes back it says "RouteIQ was paused for N s while in the background" and
rechecks the routes at once; it cannot do more than that. Driving with a locked phone
needs the native app (PLAN.md). It also needs HTTPS (or localhost) to be given a
position at all.

**The iPhone shell app (`native/shell`).** The same web app inside an installable
Capacitor shell, so a drive continues with the phone locked or another app in front.
Install steps and the pre-drive check: [docs/phone-install.md](docs/phone-install.md).
Nobody has run it on a device yet; that document lists what is unverified. What changes
inside the shell, and only there (the web app picks this at run time when the shell's
plugin `RouteIQNative` is present, `src/device/native`):

- **Position:** `CLLocationManager` with background updates (navigation accuracy,
  automotive activity, never paused by iOS, blue indicator shown) in place of
  `watchPosition`. "Use my location" asks the same plugin once.
- **Voice:** `AVSpeechSynthesizer` behind the same queue rules, with an audio session
  that lowers music while a line plays and releases it after.
- **Screen:** `isIdleTimerDisabled` in place of the Wake Lock API.
- **A hidden page is not a pause.** In a browser the session stops asking for routes
  while the page is hidden; in the shell it is never told the page was hidden, so the
  checks go on. The rule in `core/live.ts` is unchanged.
- **The clock's ticks.** iOS may hold back a web page's timers while locked, so the
  session's once-a-second tick is driven by each native position fix and by a native
  one-second timer event, as well as by `setInterval`; whichever comes first counts, at
  most one tick per second (`src/device/native/pulse.ts`).
- **Route requests** (Mapbox Directions: the plan, the checks during a drive, the
  side-street probes) are made by iOS (`URLSession`, the plugin's `httpGet`) instead of
  the web view's `fetch`, which iOS may hold back while the phone is locked. The
  Directions client has one injectable transport (`setDirectionsTransport` in
  `src/providers/mapbox/client.ts`, `fetch` by default); the shell sets the native one
  at startup (`src/main.tsx`, `src/device/native/http.ts`). Same URL, same error
  messages, an abort cancels the native request. The native side takes
  `https://api.mapbox.com/` addresses only, follows no redirect, gives up after 20 s
  and never logs an address. Search and map tiles stay on the web view.
- **Drive diagnostics** (top bar, and behind More in the drive view; shell only): a log
  with Share (the iOS share sheet) and Copy buttons of what iOS let the app do: fixes and
  ticks received and the longest wait between them, route requests with their times,
  spoken lines started and finished, and when the app went to the background. Counts and
  timings only (`src/device/native/diagnostics.ts`). Its text is written to the app's
  storage when a drive ends and every 30 s during one, and shown as "Last drive" after
  the app was closed (`src/device/native/lastDrive.ts`).
- **Test drive (simulated GPS)** (under Start drive, shell only): a made-up car drives the
  selected route in place of the GPS, so a drive can be tried at home with the phone
  locked. Presets: follow the route, a wrong turn after 1 min (a made-up side street
  square to the route, at least 600 m and 45 s long, so the tracker calls it off the
  route), turn around after 1 min; at 1x (15 m/s) or 3x speed, on the real clock. The
  web side writes the script (`src/drive/testDrive.ts`, `DEFAULT_TEST_DRIVE_OPTIONS`);
  the plugin's `startSimulatedRoute` moves the car on a native timer, one fix a second
  marked `simulated`. The real GPS stays on to keep the app running, and its positions
  are discarded. The drive view shows a SIMULATED GPS badge and the diagnostics say so.
  Route requests are real and count against the request budget. The browser's
  development replay is separate and unchanged.
- **Phone lab** (shell only, off unless started over USB with `-routeiqLab`): the PC runs
  a drive on the real phone with nobody touching it, and checks what the app did while
  it was in the background or the phone asleep. [docs/phone-lab.md](docs/phone-lab.md).

The unsigned `.ipa` is built by `.github/workflows/shell-ios.yml`, which fails if a
Mapbox token is found anywhere in the app.

**The drive view** replaces the planning layout, full screen, in the approved design
(`design/README.md`): black glass on the map, condensed figures (Barlow Condensed, with
Inter for sentences; both bundled with the app, never fetched). A turn card sits over
the top of the map: the distance to the next maneuver is the hero, with its arrow and
the street to turn onto under it. Where the road just carries on it reads "Continue on
<road>", and "Continue straight" when no turn is listed at all; the hero is a distance
either way. The map follows the car, heading up, with the route being driven, the car
and the turn-off of a switch. The sheet below has one line, the minutes left (large)
and the arrival time (smaller), and two 60 px buttons, More and End: two figures read
at a glance. **More** opens the rest: the lights on the route being driven (a number
only for a full count, "≥ N data missing" for a partial one, "Unknown" otherwise, never
0 when unsure), the miles left, the automatic switch, the voice (Mute), one quiet line
with the engine's latest reason, "checked N s ago" and the request count, and in the
iPhone app "Drive diagnostics". Every control is 44 px or more, the cards keep clear of
the phone's safe areas, and the one animation is off under `prefers-reduced-motion`.
After a switch a banner stays for 8 seconds with one large button, "Keep previous
route". Doing nothing accepts the switch. Pressing it goes back to the route just left
and tells the engine not to offer the other one again for `noReturnSec` (10 minutes).

**Position tracking** (`src/core/tracking.ts`, thresholds in `DEFAULT_TRACKING_OPTIONS`):

| Rule | Default |
| --- | --- |
| A fix with a worse accuracy is ignored | `maxAccuracyM` 50 m |
| Off the line: farther from the route than | `offRouteM` 50 m |
| Off the route: off the line for this long, or this many good fixes in a row, never on one fix | `offRoutePatienceSec` 8 s, `offRouteFixes` 3 |
| Arrived: this close to the destination, along the route or (on its last 400 m) in a straight line | `arrivalRadiusM` 40 m |
| A fix that snaps up to this far behind is noise: the car stays put | `backwardToleranceM` 30 m |
| A fix farther back (a U-turn), or farther ahead than 50 m/s allows, is believed after this many in a row | `jumpFixes` 3 |

A fix is matched to a pass of the route within 50 m of it; where the route comes by the
same spot twice (a loop ramp, an out-and-back), the pass that fits the progress so far
is taken, not the globally nearest point. Speed is the device's when it gives one,
otherwise the progress between fixes, smoothed either way. Heading is the device's
while moving, otherwise the route's own direction at the car.

**When it checks** (`src/core/live.ts`, `DEFAULT_LIVE_OPTIONS`): every 60 seconds of
real time (`pollIntervalSec`), never two requests within 10 seconds, not while the car
has stood still for more than 2 minutes (the first check goes out when it moves again),
not while the page is hidden, not from a position older than 10 seconds (a tunnel) or
one that is off the route line, and at most 60 requests per drive (the count is on
screen; the same setting as the simulated drive). A check is asked from the car's point
on the route with its heading as `bearings` (left out below 2 m/s, where a heading
means nothing), and the answer goes to the same `decideReroute` as the simulated drive,
together with the place the request was sent from. Off the route (the tracker's
verdict, never one fix) a new route is asked for at once from the device's own
position, whatever was asked a moment ago; if the car is still off after that (a car
park), again only every 30 seconds and not while it stands still. Five requests are
kept in reserve for that. If the car is back on the route line by the time that answer
comes, the answer is taken like any check (minimum saving, confirmation, cooldown, lead),
not as off-route. Signal counts come through the drive's once-only sources
(`askOnce`): bundled tiles, never an Overpass retry on a check.

**Turn guidance.** Requests carry `steps=true`, `banner_instructions=true`,
`voice_instructions=true` and `voice_units=imperial` (Mapbox Directions docs, checked
Nov 11, 2026: both instruction parameters need `steps=true`, no profile is excluded,
`voice_units` is `imperial` (default), `british_imperial` or `metric`). In the response
each step has `bannerInstructions[]` (`distanceAlongGeometry`, `primary` with `text`,
`type`, `modifier`, `components`; `secondary`; `sub`) and `voiceInstructions[]`
(`distanceAlongGeometry`, `announcement`, `ssmlAnnouncement`). `distanceAlongGeometry`
is meters BEFORE the maneuver at the end of that step. The adapter turns this into one
entry per maneuver (`RouteCandidate.guidance`): banner text, type and modifier, and the
announcements with the distance along the route at which each is due. The plain
`announcement` is spoken; the SSML is for another speech engine and is ignored. Where a
step has no banner or voice instruction, simple ones are made from the step's own
`instruction` ("In 0.4 miles, turn left onto ...", then the instruction 90 m before)
and the entry is marked `synthesized`. `src/core/guidance.ts` picks the turn to show
and the announcement that is due; each is spoken once, a backlog after a gap is dropped
except for its newest line, and a new route starts with a fresh cursor.

**Voice** (`src/device/speech.ts`, rules in `src/core/speechQueue.ts`): the browser's
speech synthesis. Spoken: the turn prompts, every decision that changes the route
("Switching to a faster route. Saves 3 minutes. Turn in 0.8 miles."), "You are off the
route. Finding a new one.", the new route after that, and the arrival. Decisions to
stay are never spoken. One line is spoken and at most one waits: a route change cuts
off a turn prompt that is still more than 200 m from its turn, and waits behind one
that is not; of two lines waiting, the more important stays, and of equals the newer.
One line is marked as having to be heard: "You are off the route. Finding a new one."
If it is still waiting when the new route is announced a second later, it is not
replaced: the announcement is said straight after it as part of the same line, so
the driver hears why the route changed, and there are still never more than two lines.
Phone browsers only speak after a tap, so the Start tap itself says "RouteIQ started"
(silently when muted, so that unmuting works later).

**GPS replay (development builds only).** The browser on a PC has no GPS worth the name,
so `npm run dev` shows a boxed control under Start drive, labelled as simulated: a
made-up car starts at the origin pin and drives whatever route the session is on,
through the SAME code path as the device's GPS (`src/drive/replay.ts` is a position
source like any other), at 1x, 5x or 20x, with optional noise, dropouts, a stop, a
tunnel and a wrong turn. During a replay the whole session runs on the replay's clock,
real requests stay 5 real seconds apart, the clock stands still while a request is out,
and the drive view shows the speed buttons and a what-if button (+10 minutes on the
current route).

**Not verified on a real phone.** Everything above was tested with scripted and replayed
positions. Real GPS noise in a car, speech and the wake lock on iOS Safari, audio over
CarPlay or Bluetooth, and battery use have not been tried. The checklist for the first
real-phone test is [docs/phone-testing.md](docs/phone-testing.md).

## Pinned versions (checked Nov 11, 2026)

| Package | Version | Note |
| --- | --- | --- |
| Node.js | 24 or 26 LTS recommended | Vitest 5 needs `^22.12.0 \|\| ^24 \|\| >=26` (Vite 8 alone allows 20.19+); Node 20 is end of life |
| vite | 8.3.7 | `create-vite` 9.3.4 react-ts template |
| react / react-dom | 19.3.1 | |
| @vitejs/plugin-react | 6.3.0 | peer `vite ^8` |
| typescript | 7.0.2 | as the Vite template ships it |
| mapbox-gl | 3.34.2 | imported from `mapbox-gl/esm` per Mapbox's npm guide; ships its own types |
| vitest | 5.1.0 | peer `vite ^6.4 \|\| ^7 \|\| ^8` |
| @playwright/test | 1.65.0 | e2e only; about 19 MB in node_modules, plus Chromium headless shell (about 290 MB, once per machine) |

`package-lock.json` includes the Windows native builds (rolldown, lightningcss, oxlint,
TypeScript), so `npm ci` installs the same tree that was tested.

## Privacy

**The hosted test site** (GitHub Pages, https://akashdesai93.github.io/routeiq/) sends
Mapbox exactly what local development sends, described below; nothing else is added.
GitHub Pages serves static files only: it receives no trip data, and the app sends
nothing to GitHub. Like any web server it sees the visitor's IP address when the page
and its files (the bundled signal tiles among them) are loaded.

**Your location.** Outside a live drive (next paragraph) the device's location is read
only when you press "Use my location": once, never on page load and never in the
background. It becomes the origin
pin, so it goes to Mapbox as the origin of the route request, like any pin. It is not
written to the device: the stored last trip leaves out an origin that came from the
device's location, and such a place never enters the recent list. The one exception is
your own doing: saving that origin as Home, Work or a named place stores its
coordinates like any saved place.

**During a live drive** ("Start drive") the device's position is read continuously,
from the tap until End or arrival, and only while the page is in front. It is held in
memory and nowhere else: it never becomes a pin, never enters the place book, the
recents or the last trip, is never logged, and is gone when the drive ends. What leaves
the device is what a route needs: the position (snapped to the route when on it) and
the heading go to Mapbox as the origin of each route request, at most 60 times a drive
plus a few when off the route. When an answer does not contain the route being driven,
one of those requests also carries up to six points of that route ahead of the car
(points of a route Mapbox itself returned), to ask for its travel time; so does the
request a side-street probe needs to be compared like for like. A side-street
probe of a check (at most one per check and 20 per drive, within the same 60, and only on
a held-up route) sends the
same origin, heading and destination with one point in between: a point 500 or 800 m
beside a route Mapbox itself returned, made on the device from that route (or the via of
an earlier probe of this drive). Spoken text is
made on the device by the browser's own
speech engine; RouteIQ sends it nowhere. The development replay uses a made-up position
that starts at the origin pin, not the device's.

**In the iPhone shell app** the same holds, with one difference: the position is read
for the whole drive, also while the phone is locked or another app is in front (that is
what the app is for; iOS shows its blue location indicator meanwhile). The native code
hands each position to the app's memory and keeps none: it writes no log and no file.
The shell adds no network call: route requests are the same requests to Mapbox as in a
browser, only sent by the app's native code (so they go out with the phone locked),
which accepts `https://api.mapbox.com/` addresses and nothing else, follows no redirect
and never logs or stores an address or an answer. Search and map tiles are the web
app's requests to Mapbox, as in a browser. Spoken text is made on the phone by iOS. The
Mapbox token you paste is stored on the phone only. "Drive diagnostics" keeps counts
and timings (fixes, ticks, route requests, spoken lines, app in front or not): no
position, no address, no token. The last drive's text is also kept in the app's storage
on the phone, and a text that looked as if it held a position, a token or an address is
not written. It leaves the phone only if you share or copy it and send it yourself. In
a test drive the positions are made up from the selected route; the phone's own
position is discarded while one runs and reaches neither the drive nor Mapbox.

**The phone lab** ([docs/phone-lab.md](docs/phone-lab.md)) is off unless the shell app is
started over USB, from a computer the phone trusts, with the launch argument `-routeiqLab`;
opened by hand, the app never has it. With it, a test hook presses the app's own buttons,
and every few seconds one file in the app's temporary folder is replaced with a report for
that computer to pull: the drive diagnostics and which screen is up, as counts, times and
fixed words. No position, address, road name or token is written to it, and the lab makes
no network request of its own. A lab drive over USB starts only where the computer put the
simulated position: the hook asks the phone for its position once, compares it in memory,
and on any other position does not start a drive and says only "not at the simulated
start". In lab mode the web view can be inspected from that computer.

**Opening a route in Google Maps or Waze.** Nothing is sent until you tap one of the two
links. The tap opens a Google or Waze page (or app) with the trip in its address: for
Google, the route's start and end and up to nine points along it; for Waze, the
destination only. If the origin came from "Use my location", the Google link leaves the
origin out and Google starts from its own reading of the device's position, so RouteIQ
does not send that position (the first waypoint is at least 500 m from it). From then on Google's or Waze's own privacy terms apply. RouteIQ logs
and stores none of it; the links are built on the device.

**What you type.** The text typed into a search field is sent to Mapbox (Search Box
API) to find places, once typing pauses and there are three characters or more, together
with the centre of the map rounded to four decimals (to put nearby results first) and a
random session token that groups the requests for billing and says nothing about you.
Picking a suggestion sends that suggestion's id. Nothing typed is logged or stored by
RouteIQ; a destination picked from search is kept in the recent list (below).

**Saved places, recent destinations and the last trip** live only in this browser's
localStorage, under the key `routeiq.places.v1`: names, labels and coordinates. They
are never written to a project file and never sent anywhere, except as the coordinates
of a route request to Mapbox when one of them is an end of the trip. "Clear saved
places and history" removes them, as does clearing the site's data. Where localStorage
is full or blocked the panel says so and they last until the page is closed.

Pin positions go to Mapbox, which is how routes are found. They go nowhere else.
Side-street probes (up to two per plan) send Mapbox the same trip again with one point
in between: a point 500 or 800 m beside the fastest route Mapbox itself returned, made on
the device from that route. It says nothing new about you and goes to Mapbox only, in a
Directions request like the plan's own; it is not stored or logged. A probed route is
counted for signals like any other route: inside the bundled area its tiles are the app's
own files, and outside it a tile the bundle does not cover can be asked of Overpass (the
tile's bounding box only, as below).
During a simulated drive the simulated car's position and heading go to Mapbox the same
way, once per check (and with a probe's via point, as in a live drive); that position is a point on the route already on screen, not
anyone's location. The drive, its log and the reroute settings are kept in memory only.

For signal counts, a trip that stays inside the bundled area (North and South Carolina,
except tiles on the states' outer edge) sends nothing to any signal server: the tiles
are static files of the app itself, fetched from the same server as the page, and what
is fetched is a whole 0.1 degree tile (a square about 9 by 11 km), never a route or a
position. The bundled files hold public map data only; nothing in them describes a user
or a trip. This also holds when those files cannot be read: a failed read of the bundle's
index or of a tile file is retried against the app's own server later, and is never a
reason to ask Overpass. Until the index has been read, no tile is sent to Overpass or
written to the device cache at all, with one exception: when the app's server answers
that there is no index (HTTP 404 or 410), the app was built without the bundle, and
every tile is then treated as outside it. The built-in test places are public intersections and landmarks, never a
private address.

Only for tiles the bundle's index says are outside that area (or for every tile of
an app built without the bundle), the Overpass server (OpenStreetMap data) is sent the
bounding boxes of the tiles a route touches, one request per tile. Nothing else about
the trip is sent: no route line, no pin position, no coordinate finer than a tenth of a
degree, and no cookies. The server sees which tiles were asked for, the page's origin
and, like any server, your IP address. A tile already on the device is not asked for
again until it is a month old, and one that failed is left alone for at least 30
seconds.

No other signal server is contacted. Earlier versions also downloaded a City of
Charlotte list of signals; that source was removed (#13), and the app no longer contacts
the city's server.

The data script is run by hand by a developer, not by the app.
`npm run build:signals` makes no network request at all (the extracts are downloaded
separately, as whole states).

Signal data is kept on the device, in the browser's IndexedDB, so it does not have to be
downloaded again: the OpenStreetMap signal tiles of the areas outside the bundle that
you have routed through (database `routeiq-osm-signals`; bundled tiles are never copied
into it), and a note of when Overpass may next be asked (`routeiq-overpass-pause`). The stored tiles do
show roughly where routes have been looked up on this device, to the nearest tile.
Clearing the site's data in the browser removes all of it. The database earlier
versions kept the City of Charlotte list in (`routeiq-charlotte-signals`) is deleted when
the app starts. Routes and counts
themselves are never stored; the two ends of the last trip are (see above). Where IndexedDB is not available (some private windows)
the same data is held in memory only, for as long as the page is open.
