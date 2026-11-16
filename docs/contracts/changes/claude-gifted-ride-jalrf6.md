# claude-gifted-ride-jalrf6 (#227)

- `RouteCandidate` gains `roadKindSpansM?: readonly RoadKindSpan[] | null`: the kind of road of
  each stretch (`RoadKind`: `'main' | 'side'`), as `{ startM, endM, kind }` along the geometry.
  A stretch no span covers, and a route where it is null or left out, is of unknown kind.
- `DriveRecord` gains `jams: DriveJams | null`: the time crawled in jams on main roads. Null
  for a drive recorded before jams were measured (not measured, never "no jams").
- New types from `src/core/jams.ts`: `DriveJams` (`list`, at most
  `DEFAULT_JAM_OPTIONS.maxJamsKept`, and totals over every jam: `count`, `jamSec`,
  `unknownSec`) and `LoggedJam` (`atSec`, `durationSec`, `drivenM`; no position).
- The stored log stays version 1: a record without `jams` reads back with `jams: null`.
- The CSV export gains one column at the end: `jam_min` (blank unless known in full).
- Swift: add the fields; fill `roadKindSpansM` in the Mapbox adapter from
  `mapbox_streets_v8.class` of the road leaving each intersection (main: motorway, trunk,
  primary, secondary, tertiary and their links, or `classes` containing `motorway`; side:
  street, street_limited, service; anything else unknown), with the freeway fixture case in
  `tests/mapbox.test.ts` as the spec. Port `jams.ts` (`meterJamFix`, `driveJams`, `roadKindAt`,
  `parseDriveJams`, `knownJamSec`, `jamWords`, `corridorJams`) and `jamLog.ts` (`observeJams`,
  `endJams`) with `tests/jams.test.ts` as the spec.
- Rules the port must keep: slow driving on a road of unknown kind is unknown time, never a
  jam and never 0, and a crawl that is partly unknown is unknown as a whole; nothing is
  measured before the car first reaches `setOffSpeedMps`; a crawl under way is closed at
  arrival and at End (at its last fix when that is older than `maxFixGapSec`), and is unknown
  time in a record written mid-drive; after a gap of more than `maxFixGapSec` between fixes a
  crawl stays known only when progress along the same route was under `jamSpeedMps`;
  `drivenM` is stored to 100 m.
