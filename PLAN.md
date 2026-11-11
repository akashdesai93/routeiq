# RouteIQ feature plan

Each step lands with tests before the next starts. Pure logic lives in `src/core`.

## Web prototype (Windows)

1. **Done: map shell.** Vite + React + TS, Mapbox map, two Charlotte test points.
2. **Done: routes.** Origin and destination as draggable pins (swap, reset; address
   search came with step 8); Mapbox Directions API, `driving-traffic` profile with alternatives
   (up to two, so three routes at most). A Mapbox adapter in `src/providers/mapbox`
   turns the response into `RouteCandidate`. Fetches on drag end only; polling came
   with the simulated drive (step 6).
3. **Done: route facts.** Traffic-aware ETA, distance, and difference from typical time
   (null when the API gives no typical duration, never guessed). The default selection
   was the lowest ETA until ranking (step 5) replaced it.
4. **Done: signals.** City of Charlotte traffic signal points from its public ArcGIS
   FeatureServer, downloaded whole once per session and matched locally (no route or
   pin position goes to the city). `src/core/signals.ts` counts distinct signalized
   intersections per route with a 20 m tolerance and a 40 m merge distance; the count
   stays unknown when the data is unavailable or does not cover the route. Route ids
   now come from the geometry (`src/core/hash.ts`). Mapbox's `traffic_signal` flags
   are kept as `providerSignalCount` for comparison only. Open issue for later steps:
   signals outside the city's list (other towns, campuses) are missed.
   Freeway fix (done with step 5): the Mapbox adapter records the stretches driven on
   controlled-access road (`limitedAccessSpansM`, from the road class and
   `geometry_index` of each step intersection), and signals inside them, more than
   30 m from either end, are no longer counted. Still open: `trunk` expressways with
   their own signals are treated as streets, so an overpass there can add a signal.
   Any-route upgrade (part 1 done: logic and data): OpenStreetMap
   `highway=traffic_signals` nodes through Overpass are now the primary source
   everywhere, loaded per 0.1 degree tile for the tiles a route touches
   (`src/core/tiles.ts`, `src/providers/osm`), cached on the device (IndexedDB) and
   refreshed about monthly (see part 3 for the chain as it is now). The City of Charlotte
   list only fills gaps, and Mapbox's signal flags stand in where a tile is missing.
   The count rules are now: group points within 60 m, keep groups within 30 m of the
   route, keep those within 40 m of a route intersection; the freeway spans stay as a
   second check. Each route carries `signalCoverage` (full, partial, none) next to
   `signalCount`; partial is shown as a lower bound, never as zero, and does not rank.
   The two datasets are stored apart (different licenses) and merged only in memory.
   Part 2 (superseded by part 3): a seed script was to fetch the Charlotte metro box
   (49 tiles) from Overpass in one request and ship it as seed tiles read between the
   device cache and the network. Its OpenStreetMap half never ran, because Overpass
   answered 502/429 all of Nov 11, 2026, and it has been removed. What remains of it:
   the city list is snapshotted into `public/seed/charlotte-signals` (its own folder
   and license file), and the city client falls back on it when the live server fails. The map
   carries the OpenStreetMap credit; labels are "24 signals", "≥ 9 signals (partial)"
   and "Signals: unknown". The default trip is now Uptown to US-521 and SC-160 in
   Indian Land, SC: it crosses the state line, where the city list ends and
   OpenStreetMap carries the count alone.
   Part 3 (done, Nov 11, 2026): Overpass never answered, so the tiles are now built
   by us. `npm run build:signals` (`scripts/build-signal-tiles.mjs`, with its own
   streaming .osm.pbf reader in `scripts/lib/osm-pbf.mjs`) reads the Geofabrik
   extracts of North and South Carolina from `data/osm-extracts` and writes
   `public/seed/osm-signals`: 22,613 signal nodes in 902 tile files (1.2 MB) and an
   index of the 2,500 tiles that lie entirely inside the two extract boundaries.
   These bundled tiles are PRIMARY and authoritative: the chain is now bundle ->
   device cache -> Overpass, a covered tile never reaches the last two, is never
   refreshed tile by tile and is never copied into IndexedDB, and a covered tile
   without a file is "0 signals" without a request. Overpass is only the backup for
   tiles outside the states or on their clipped outer edge. A tile that failed is
   left alone for 30 s, doubling to 8 minutes (per session), which is what step 6
   needs. The panel shows the data date. The Overpass seed (the metro box, one big
   query) is retired; `npm run seed:charlotte` keeps the city snapshot.
   Measured on live routes with the real data: the three rule distances (60 m group,
   30 m to the route, 40 m to a route intersection) stay as they are; see README,
   "Checked against real data". The city gap-fill added nothing on eight ordinary
   trips (18 of its 909 points have no OpenStreetMap signal within 60 m).
   Open for later: the bundle is a snapshot and ages (rebuild it; nothing refreshes
   it tile by tile); 60 m single-linkage grouping merges two pairs of Charlotte
   intersections 54 and 56 m apart; a slip-lane turn beside a signal and a ramp fork
   on a `trunk` expressway can each add a signal; decide whether the city gap-fill is
   worth its non-commercial license; Overpass tiles are not filtered by signal
   subtype as bundled tiles are.
5. **Done: ranking** (`src/core/rank.ts`). Best traffic-aware ETA first; signal count
   only breaks ties (ETAs within 30 s of the fastest, `DEFAULT_ETA_TIE_WINDOW_SEC`)
   until there is evidence for per-signal wait times. No per-signal time penalty.
   A signal count whose coverage is not full is unknown to the ranking.
   The top-ranked route is the default selection and is marked "Recommended"; each
   route shows the reason for its place.
6. **Done: simulated rerouting.** `src/core/reroute.ts` is the switching brain: a pure
   state machine, `decideReroute(state, observation, options)`, with the time passed
   in and every threshold in `DEFAULT_REROUTE_OPTIONS` (minimum saving 120 s and 5%,
   two confirming polls, 300 s cooldown, 600 s no-return at twice the saving, lead
   400 m / 20 s / 1200 m on freeway, three polls before leaving a route no longer
   offered, 50 m off route). The current route is matched to a fresh candidate by
   path, never by id. Every decision has a sentence that can be spoken. In the web
   app "Simulate drive" moves a car along the selected route at 1x, 5x or 20x, polls
   Mapbox from its position with its heading (`bearings`) every 60 s of simulated
   time, at most one request per 5 real seconds and 60 per drive, switches by itself
   and logs each decision. A development-only what-if control adds a simulated delay
   to the current route so a switch can be watched. Polls never pass `retryFailed`,
   and `askOnce` holds a tile outside the bundle to one attempt per session.
   Open for the native app: the engine expects a position already matched to the
   route (distance along it) and a sane speed. Real GPS needs map matching, an
   off-route test that waits for a few fixes before trusting a jump, smoothed speed,
   and the position each query was sent from kept with its answer (the engine
   forgives 50 m). The off-route rule switches at once with no lead check, on the
   assumption that the provider's route from the true position is drivable. After a
   switch the engine drives the candidate's line as fetched; a native app should
   hand the chosen route to the navigation SDK and report progress along that.
   Lead distances are along the route to the turn-off and take no account of the
   lane the driver is in. With no typical duration on a route the engine stays;
   Mapbox always sent one on `driving-traffic` in testing.
7. **Done: synthetic tests.** `tests/reroute.test.ts` runs scripted drives through the
   engine on a made-up road network with a fake clock, no network: oscillating ETAs
   (no switch), a steady 3 minute gain (one switch after two polls), a gain inside
   the lead distance (refused, then gone), cooldown, no return, no alternatives,
   missing traffic data, failed polls, current route not among the candidates, off
   route, freeway lead, a tiny remaining trip, duplicate signals and partial coverage,
   determinism, and 40 seeded random drives in which switches are never closer
   together than the cooldown. `tests/drive.test.ts` covers the simulated clock, the
   request budget, the what-if delay and a whole simulated drive offline.
8. **Done: go anywhere.** The web version of the phone app's Plan screen
   (`src/PlanPanel.tsx`). Search for either end of the trip through the Mapbox Search
   Box API (`/suggest` + `/retrieve` on a session token; chosen over Geocoding v6,
   which has no POIs): 350 ms debounce, three characters minimum, stale requests
   aborted, results biased to the map centre, five at most, a combobox usable by
   keyboard and touch. "Use my location" as the origin (one-shot Geolocation, only on
   the button). Home, Work, six named places, the last eight destinations and the
   last trip are kept in localStorage only (`src/core/places.ts` for the rules,
   `routeiq.places.v1`), with a control to clear them; the built-in trip stays the
   first-run and Reset trip. At phone width the page is one column: trip input, map,
   routes, with the simulated drive folded away and 44 px tap targets.
   Open for phone use: the page needs HTTPS to locate on a real phone (localhost only
   works on the PC itself), so hosting or a tunnel comes first, and the token's URL
   restriction has to list that host; no live position yet (the origin is one fix,
   there is no blue dot and no following); a dragged pin shows coordinates, not an
   address; the soft keyboard covers part of the suggestion list on a small screen
   (not tried on a real iPhone); no "add to home screen" manifest or offline shell;
   Search Box results are for temporary use by Mapbox's terms, so storing saved
   places from them needs settling (README, Planning a trip). For the native app:
   places belong in app storage (a protected file or the keychain), location comes
   from Core Location with its own permission wording, and search can use the same
   two HTTP calls or Mapbox's Search SDK; `core/places.ts`, `core/search.ts` and the
   two adapters are the parts to port.
9. **Route hand-off** (`src/core/handoff.ts`). After you accept a route, open it in
   another navigation app:
   - **Google Maps (primary).** Pick waypoints along the accepted route that pin
     Google to it (for example points on the roads where the alternatives split).
     Official limit: up to 3 waypoints on mobile browsers, up to 9 elsewhere, and
     2,048 characters per URL. Plan for 3 and test what the iPhone app accepts.
     Google treats waypoints as stops, so this pins the road choice, not every turn.
   - **Waze (secondary).** Waze deep links take one destination (`ll`, `navigate=yes`)
     and no waypoints, so hand-off is destination-only, or leg by leg (navigate to
     the first pin point, then the next).
   - Waypoint selection is a pure function: route geometry plus alternatives in,
     ordered points out, with tests for the limits and URL encoding.
   - Both Google Maps and Waze already run on CarPlay, so hand-off is a way to drive
     a RouteIQ-chosen route in the car before RouteIQ has its own CarPlay entitlement.
10. **Contracts frozen.** Version the `src/core` types so Swift or a service can match them.

## Native iPhone + CarPlay (later)

- Swift app on Mapbox Navigation SDK for iOS v3 (current 3.34.2: Swift 5.9+,
  iOS 14+; docs page says Xcode 15+, but the SDK changelog requires Xcode 16.2+ since 3.9), built on GitHub Actions macOS runners; remote Mac only for
  debugging. No local Mac needed.
- Signal data: ship `public/seed` inside the app bundle and read it through the same
  layer chain (bundle files in place of same-origin fetches, a file or SQLite store in
  place of IndexedDB). The tile, index and snapshot JSON shapes are the contract. Two
  states are 904 small files (1.2 MB, about 3 MB on disk in 4 KB blocks): pack them
  into one file (or SQLite) for iOS rather than shipping hundreds of resources, and
  plan how the data is renewed between app releases (a downloadable pack, not Overpass). Both license
  files have to ship with the data and the credits have to be visible in the app; the
  City of Charlotte data is non-commercial (CC BY-NC-SA 4.0), so a distributed app
  needs the city's agreement or has to leave that folder out.
- CarPlay needs Apple to grant `com.apple.developer.carplay-maps` first. Apple's docs
  say Simulator cannot show a CarPlay app without the entitlement, and Xcode needs a
  CarPlay-enabled provisioning profile, so nothing CarPlay can be tested before the
  grant. CarPlay is not claimed to work until the grant arrives and a native build
  runs in the car.
