# claude-issue-196-stops (#196)

- `DriveRecord` gains `stops: DriveStops | null`: where the car stood still on the drive, and
  street against freeway time. Null for a drive recorded before stops were measured (not
  measured, never "no stops").
- New types from `src/core/stops.ts`: `DriveStops` (the stop list, at most
  `DEFAULT_STOP_OPTIONS.maxStopsKept`, and totals over every stop: count, time stopped, stops
  and time at lights, stops whose place is unknown, and `parts`), `LoggedStop` (`atSec`,
  `durationSec`, `drivenM`, `place`, `road`; no position), `PartTime`, `StopPlace`
  (`'light' | 'none' | 'unknown'`) and `RoadPart` (`'surface' | 'freeway' | 'unknown'`).
- The stored log stays version 1: a record without `stops` reads back with `stops: null`.
- The CSV export gains three columns at the end: `stopped_min`, `light_stops`, `light_wait_min`
  (blank when not measured).
- Swift: add the fields to the drive log record and port `stops.ts` (`meterFix`, `driveStops`,
  `stopPlace`, `predictedParts`) with `tests/stops.test.ts` as the spec. The meter is fed
  every fix the web engine sees; its lights come from the route's counted signals.
