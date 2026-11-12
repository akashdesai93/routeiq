# RouteIQCore

RouteIQCore is a Swift port of the web prototype's `src/core`, the framework-free brain of
RouteIQ. It also includes the Directions JSON parser from `src/providers/mapbox/adapter.ts`. It
uses Foundation only, so it builds and tests on Linux as well as on Apple platforms.

The Vitest suites under `tests/` are the spec. The XCTest cases in `Tests/RouteIQCoreTests` mirror
them assertion for assertion: same inputs, same expected values. The Directions tests read the
same JSON fixtures straight from `tests/fixtures`.

| Swift | Ported from | Tests mirror |
| --- | --- | --- |
| `Types.swift` | `types.ts` | (used everywhere) |
| `Geo.swift` | `geo.ts` | `core.test.ts` (geo), parts of `signals.test.ts` and `reroute.test.ts` |
| `Hash.swift` | `hash.ts` | `signals.test.ts` (geometryHash, pinned values) |
| `Tiles.swift` | `tiles.ts` | `tiles.test.ts` |
| `Signals.swift` | `signals.ts` | `signals.test.ts` |
| `Rank.swift` | `rank.ts` | `rank.test.ts` |
| `Select.swift` | `select.ts` | `signals.test.ts` (sameRouteGeometry, resolveSelectedId) |
| `Reroute.swift` | `reroute.ts` | `reroute.test.ts` with `helpers/driveWorld.ts` |
| `Format.swift` | `format.ts`, `facts.ts` | `routeFacts.test.ts`, `signals.test.ts` (formatSignalCount) |
| `TestPoints.swift` | `testPoints.ts` | `core.test.ts` |
| `Directions.swift`, `JSONValue.swift` | `providers/mapbox/adapter.ts` | `mapbox.test.ts` (parseDirections) |
| `RouteIQKit/DirectionsClient.swift` | `providers/mapbox/client.ts` (fetchDirections) | `mapbox.test.ts` (fetchDirections), with a fake transport |
| `RouteIQKit/SignalBundle.swift` | `providers/osm/bundle.ts`, `bundleLayer.ts`, `signalData.ts` (bundle only) | Parity: `Tests/RouteIQKitTests/Fixtures/signal-parity.json`, the web app's own counts on the real bundle |
| `JS.swift` | (none) | JavaScript number and string semantics the TypeScript relies on |

## Contract version

The web app's core contracts are versioned (`CORE_CONTRACT_VERSION`, `src/core/contract.ts`, and
[docs/contracts.md](../../docs/contracts.md)). The current version is **1**.

This port does not match version 1 yet. It predates the first frozen version and lags `main`
(#33). Among the things missing:
- `RouteCandidate.segmentTraffic` and `RouteCandidate.source`;
- `RerouteState.declined` and `declineRoute`;
- `RerouteOptions.matchMaxDivergenceM`;
- the guidance steps;
- the live drive (`LiveOptions`, `LiveState`, `LiveEvent`, `LiveEffect`);
- the place book.

When it catches up, write the version it matches here. From then on, compare
`docs/contracts/core-contract.json` (`declarations`, one line per type) with the Swift types when
the version changes. The `history` there lists every version with its hash.

Not ported yet:

- `places.ts` and `search.ts`: saved places and search sessions, needed when the app gets a Plan
  screen.
- the web app's live-drive modules being added on `main`.

## The signal parity reference

`Tests/RouteIQKitTests/Fixtures/signal-parity.json` holds the signal counts the web app's own
TypeScript gives on the bundled tiles. That covers the three Directions fixtures, a route that
leaves the Carolinas, and three clipped edge tiles. `SignalBundleParityTests` requires the Swift
counts to match exactly. The test also checks the bundle's data date, so it fails when
`public/seed/osm-signals` is rebuilt. Regenerate the reference then, from the repository root,
with Node 24:

```bash
node native/scripts/signal-parity-reference.mjs > native/RouteIQCore/Tests/RouteIQKitTests/Fixtures/signal-parity.json
```

## Running the tests

CI runs them with
[`.github/workflows/native-core.yml`](../../.github/workflows/native-core.yml) on
`ubuntu-24.04`, which ships Swift 6.4. Anywhere with Swift 5.9 or newer:

```bash
cd native/RouteIQCore && swift test
```

**On the Windows PC.** Swift 6.4.2 is installed with `winget install --id Swift.Toolchain`,
next to Visual Studio 2022 with the C++ x64 tools and the Windows 11 SDK (22621). Run swift
from an "x64 Native Tools Command Prompt for VS 2022", so that `link.exe` and the C headers
are found. Open the prompt after the install, so it picks up the installer's `SDKROOT`
variable. In a shell started before the install, set `SDKROOT` to
`%LOCALAPPDATA%\Programs\Swift\Platforms\6.4.2\Windows.platform\Developer\SDKs\Windows.sdk\`.
Without it, swift fails with "unable to load standard library". Use the classic build system: in 6.4.2 the default one does not find the
Windows C headers (`'stdlib.h' file not found`).

```bat
cd native\RouteIQCore
swift test --build-system native
```

On 2026-11-11 all 159 tests passed there in about 9 s. The suite also caught each of three
bugs planted on purpose:
- the minimum saving set to 119 s
- Swift rounding in place of JavaScript rounding in the route id hash
- the 30 s tie window made exclusive

## Same behaviour as the TypeScript, on purpose

The port reproduces JavaScript semantics wherever the result depends on them:

- **Rounding.** `Math.round` rounds halves toward +infinity; Swift's `.rounded()` rounds them away
  from zero. Tile ids and hashes use `JS.round`.
- **Hash arithmetic.** `x | 0` and `>>> 0` truncate and wrap the way JavaScript does, so
  `geometryHash` gives the same 16 hex digits. The pinned values in the tests prove it.
- **Sorting and ordering.** `Array.prototype.sort` is stable, and strings compare by UTF-16 code
  units.
- **Insertion order.** Where the TypeScript walks a `Map` in insertion order, the Swift keeps an
  explicit order list next to a dictionary.

## Differences from the TypeScript

All are about types, not about decisions:

- **Counts are `Int?`.** `RouteCandidate.signalCount` and `providerSignalCount` are `Int?`. The
  TypeScript `number | null` can also be NaN or 2.5, which every consumer treats like null; Swift
  cannot express those values. Durations and distances stay `Double`, so NaN still means "no
  usable travel time".
- **Options take explicit values.** They are structs whose initializer defaults are the documented
  values, instead of `Partial<...>` objects. A value that is negative or NaN still falls back the
  same way. `confirmPolls` and `routeLostPolls` are `Int`, so a fractional poll count cannot be
  given; the TypeScript rounds one.
- **Route identity.** Swift structs are values, so `rankRoutes` works with positions instead of
  object identity. The result is the same, including for two equal routes.
- **The Directions parser** takes a `JSONValue`, which keeps `true` and `1` apart exactly like
  JavaScript `typeof`. The rule "only a literal `true` is a traffic signal" holds.
  `Directions.parse(data:)` decodes through `JSONDecoder`, which is stricter than `JSON.parse`. A
  number too large for a Double (`1e400`) or a lone surrogate escape (`"\ud800"`) makes the whole
  body malformed. JavaScript would read it as Infinity, or keep the odd string. Mapbox sends
  neither.
- **`hypot`** comes from the platform C library, not V8's own algorithm. The two can differ in the
  last bit, which matters only for a point within a billionth of a meter of a tolerance edge.
  Tests compare such distances with an accuracy, as the Vitest suites do with `toBeCloseTo`.

An independent review checked these edge cases against the TypeScript, and the Swift now matches:

- `Math.min` and `Math.max` propagating NaN
- `tileIdAt` on infinite or huge coordinates, one axis at a time
- leading zeros in a tile id
- `toFixed(4)` rounding ties up, with no sign on negative zero
- `Number#toString` for large and small numbers
- Date months in the proleptic Gregorian calendar
- string keys compared by UTF-16 code units
- poll counters that cannot overflow
- grid cells that cannot overflow for an absurd tolerance
