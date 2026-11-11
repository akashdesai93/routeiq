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
| `JS.swift` | (none) | JavaScript number and string semantics the TypeScript relies on |

Not ported yet:

- `places.ts` and `search.ts`: saved places and search sessions, needed when the app gets a Plan
  screen.
- the web app's live-drive modules being added on `main`.

## Running the tests

There is no Swift toolchain on the Windows PC. CI runs them:
[`.github/workflows/native-core.yml`](../../.github/workflows/native-core.yml) on
`ubuntu-24.04`, which ships Swift 6.4. Anywhere with Swift 5.9 or newer:

```bash
cd native/RouteIQCore && swift test
```

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
- **`tileIdAt` on a non-finite coordinate** returns `"NaN_NaN"` instead of trapping. Valid
  coordinates are unaffected.
- **`formatLatLng`** uses `printf`-style rounding. It differs from `toFixed(4)` only on an exact
  binary tie at the fifth decimal, which no real coordinate is. A negative zero would print as
  `-0.0000`.
- **The Directions parser** takes a `JSONValue`, which keeps `true` and `1` apart exactly like
  JavaScript `typeof`. The rule "only a literal `true` is a traffic signal" holds.
