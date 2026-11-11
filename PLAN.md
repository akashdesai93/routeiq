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
4. **Done: signals.** First built on the City of Charlotte's public signal list
   (removed (#13): OpenStreetMap is now the only signal data). `src/core/signals.ts` counts distinct signalized
   intersections per route with a 20 m tolerance and a 40 m merge distance; the count
   stays unknown when the data is unavailable or does not cover the route. Route ids
   now come from the geometry (`src/core/hash.ts`). Mapbox's `traffic_signal` flags
   are kept as `providerSignalCount` for comparison only.
   Freeway fix (done with step 5): the Mapbox adapter records the stretches driven on
   controlled-access road (`limitedAccessSpansM`, from the road class and
   `geometry_index` of each step intersection), and signals inside them, more than
   30 m from either end, are no longer counted. Still open: `trunk` expressways with
   their own signals are treated as streets, so an overpass there can add a signal.
   Any-route upgrade (part 1 done: logic and data): OpenStreetMap
   `highway=traffic_signals` nodes through Overpass are now the primary source
   everywhere, loaded per 0.1 degree tile for the tiles a route touches
   (`src/core/tiles.ts`, `src/providers/osm`), cached on the device (IndexedDB) and
   refreshed about monthly (see part 3 for the chain as it is now). Mapbox's signal
   flags stand in where a tile is missing (the city list that once filled gaps:
   removed (#13)).
   The count rules are now: group points within 60 m, keep groups within 30 m of the
   route, keep those within 40 m of a route intersection; the freeway spans stay as a
   second check. Each route carries `signalCoverage` (full, partial, none) next to
   `signalCount`; partial is shown as a lower bound, never as zero, and does not rank.
   Part 2 (superseded by part 3): a seed script was to fetch the Charlotte metro box
   (49 tiles) from Overpass in one request and ship it as seed tiles read between the
   device cache and the network. Its OpenStreetMap half never ran, because Overpass
   answered 502/429 all of Nov 11, 2026, and it has been removed (the city snapshot it
   left behind: removed (#13)). The map
   carries the OpenStreetMap credit; labels are "24 signals", "≥ 9 signals (partial)"
   and "Signals: unknown". The default trip is now Uptown to US-521 and SC-160 in
   Indian Land, SC: it crosses the state line, so it needs tiles on both sides.
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
   query) is retired.
   Measured on live routes with the real data: the three rule distances (60 m group,
   30 m to the route, 40 m to a route intersection) stay as they are; see README,
   "Checked against real data". The city list added nothing on eight ordinary
   trips (18 of its 909 points have no OpenStreetMap match within 60 m), so it was
   removed (#13).
   Open for later: the bundle is a snapshot and ages (rebuild it; nothing refreshes
   it tile by tile); 60 m single-linkage grouping merges two pairs of Charlotte
   intersections 54 and 56 m apart; a slip-lane turn beside a signal and a ramp fork
   on a `trunk` expressway can each add a signal. (Done: the city list was removed
   (#13). Done: Overpass tiles are now filtered by
   signal subtype with the same rule and list as bundled tiles, #11.)
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
   400 m / 20 s / 1200 m on freeway, 50 m off route). The current route is matched
   to a fresh candidate by path, never by id: by overlap (95% of the length within
   20 m, no stretch apart over 400 m, the first 150 m not compared), since the same
   road comes back drawn a little differently. A route missing from the answers is
   kept, and its travel time asked for through via points; it is left without a
   saving only when Mapbox finds no route along the road ahead three polls running.
   Every decision has a sentence that can be spoken. In the web
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
   **Done: live drive (web).** "Start drive" feeds the same engine with the device's
   position; one tap, none after. `src/core/tracking.ts` does what the note above
   asked for: fixes matched to a pass of the route (the one that fits the progress so
   far where the route crosses itself), progress that does not run back on noise but
   does on a real U-turn, smoothed speed, an off-route verdict with patience (50 m
   for 8 s or 3 good fixes, never one), arrival within 40 m. `src/core/live.ts` is
   the session as a pure state machine (events in, state and effects out):
   a check every 60 s, never within 10 s, paused when stationary for 2 minutes or
   hidden, at once when off the route; the position each query was sent from goes to
   the engine with its answer; a switch is applied, spoken, and can be undone for 8 s
   ("Keep previous route", which the engine honours through a new `declined` list
   and `declineRoute`). `src/core/guidance.ts` and the Mapbox adapter carry banner
   and voice instructions (`banner_instructions`, `voice_instructions`), made up from
   the steps where missing. `src/core/speechQueue.ts` rules the voice. The browser
   sits behind `src/device` (position watch, speech, wake lock, visibility), and
   `src/live/runner.ts` runs the machine with whatever it is handed. A development
   GPS replay (`src/drive/replay.ts`) drives the same path with noise, dropouts, a
   stop, a tunnel and a wrong turn.
   The limit: a web page only runs in front with the screen on. Open: none of it has
   been tried on a real phone in a car (GPS noise, iOS Safari speech and wake lock,
   audio over CarPlay or Bluetooth, battery); hosting over HTTPS comes first. Settled
   (Nov 11, 2026): the switches "current route is no longer offered" near Uptown
   were the 10 m point-by-point match rejecting the same road drawn a little
   differently (measurements in the README); the match is by overlap now and that
   switch is gone. Still open there: Mapbox's travel time for a path asked through
   via points ran 3 to 13% below its time for the same path as an ordinary route,
   so that baseline leans towards staying; and whether Mapbox answers "no route"
   for a closed road pinned by via points (the one evidence the engine accepts for
   leaving a route without a saving) has not been seen in the wild. A switch said
   aloud while a near turn prompt is speaking waits for it; the "off the route"
   line is now kept until spoken, with the new route said straight after it. Which
   carriageway the car is on is not known. The first route is the best-ranked one
   from the device's position, not the one picked in the list.
   For the native shell: `src/core` (tracking, live, guidance, speechQueue, reroute)
   and `src/live/runner.ts` run as they are, or port one to one; it replaces the
   three device wrappers (position source -> Core Location with background updates,
   speech -> AVSpeechSynthesizer with an audio session that ducks music, wake lock
   -> isIdleTimerDisabled) and the visibility wrapper falls away.
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
   Done (Nov 11, 2026): `handoffWaypoints`, `googleMapsUrl` and `wazeUrl` in
   `src/core/handoff.ts`, thresholds in `DEFAULT_HANDOFF_OPTIONS`, two links on the
   selected route in RoutePanel (README, Route hand-off). Open for later: try the links
   in the iPhone Google Maps app (how many waypoints it really accepts, and whether it
   keeps them when opened from Safari); leg-by-leg Waze (navigate to each pin in turn);
   the native app should use the `comgooglemaps://` and `waze://` schemes when installed.
10. **Contracts frozen.** Version the `src/core` types so Swift or a service can match them.
11. **Proposed: side-street alternatives.** Mapbox returns at most three routes, so a
    faster cut-through that is not among them is never considered. Widen the search:
    - **Via probing (first).** A pure `src/core/probe.ts` picks candidate via points,
      for example on parallel arterials or collectors within a corridor around the
      current route. Mapbox is then asked for origin → via → destination (traffic-aware),
      and each result joins the candidate set with a `source: 'probe'` tag. The request
      budget is rationed like the drive's: a few probes per plan and per reroute check,
      and none on freeway-only trips. Probed routes go through the same ranking and
      reroute rules, so a side street wins only by ETA.
      11a (done, Nov 11, 2026): `selectViaPoints` in `src/core/probe.ts` picks up to
      three points 500 or 800 m to either side of the fastest route's longest
      surface-street stretches, clear of known routes and of both ends, with every
      threshold in `DEFAULT_PROBE_OPTIONS` (README, Side-street probing).
      RouteCandidate has no congestion annotation, so "slowest" is approximated by
      "longest"; adding `annotations=congestion` to the adapter would sharpen it.
      11b (done, Nov 11, 2026, plan screen): `planProbes` cuts the points to
      `DEFAULT_PROBE_BUDGET` (2 requests per plan, 800 ms after the main routes, none
      for freeway-only trips), `fetchProbeRoute` asks origin → via → destination on
      `driving-traffic` with the via as a silent waypoint (`waypoints=0;2`), failures
      (NoSegment included) are dropped, and `mergeProbeRoutes` adds the new paths,
      tagged `source: 'probe'`, dropping any that match a known route by path. Ranking
      is unchanged; RoutePanel marks them "via side streets". e2e:
      `e2e/sidestreets.spec.ts`. Hardened in #63: the via goes with a 250 m
      `radiuses` entry (`viaRadiusM`), a probe that covers a known route (a dead-end
      spur, `coversRoute`, 10 m sampling) is dropped, a probe that takes the top spot
      is announced in a polite live region, pointer or focus on the list or Start
      drive counts as a pick, the other routes keep their signal counts while a probe's
      load, and e2e covers pin-move cancellation, a held answer for the old trip and a
      drive started with a probe recommended. Open for later: probes in the reroute
      engine (#5); the live drive starts from the device's position and does not take
      the plan's pick, so a recommended side street is not what the drive follows.
    - **Guard rails.** Leave out routes that only win by modeled noise: the existing
      minimum saving (120 s and 5%) applies. Optionally penalize many turns or
      residential cut-throughs, behind a setting and with tests.
    - **Later, if probing is not enough:** an own routing engine (Valhalla or OSRM on
      OSM) with live speeds from a traffic feed. That means a server, so it needs a cost
      and privacy decision first.

## Native iPhone + CarPlay (later)

- Swift app on Mapbox Navigation SDK for iOS v3 (current 3.34.2: Swift 5.9+,
  iOS 14+; docs page says Xcode 15+, but the SDK changelog requires Xcode 16.2+ since 3.9), built on GitHub Actions macOS runners; remote Mac only for
  debugging. No local Mac needed.
- Signal data: ship `public/seed` inside the app bundle and read it through the same
  layer chain (bundle files in place of same-origin fetches, a file or SQLite store in
  place of IndexedDB). The tile, index and snapshot JSON shapes are the contract. Two
  states are 904 small files (1.2 MB, about 3 MB on disk in 4 KB blocks): pack them
  into one file (or SQLite) for iOS rather than shipping hundreds of resources, and
  plan how the data is renewed between app releases (a downloadable pack, not Overpass). The
  ODbL license file has to ship with the data and the OpenStreetMap credit has to be
  visible in the app. OpenStreetMap is the only signal dataset (the non-commercial city
  data was removed (#13)), so nothing blocks distributing it.
- CarPlay needs Apple to grant `com.apple.developer.carplay-maps` first. Apple's docs
  say Simulator cannot show a CarPlay app without the entitlement, and Xcode needs a
  CarPlay-enabled provisioning profile, so nothing CarPlay can be tested before the
  grant. CarPlay is not claimed to work until the grant arrives and a native build
  runs in the car.
