# claude-issue-183-probe-budget (#183)

- `DriveProbeBudget` gains `arrivalReserve: number` (default 1.5): before a probe, one request
  per poll interval of the expected time left, times this, is kept back for the plain checks.
- Swift: already ported in this PR (`DriveProbeBudget.arrivalReserve`,
  `Probe.plainCheckReserve`, `Probe.checkProbeAllowance(..., reserve:)`,
  `Live.remainingDriveSec`), with tests. Nothing left to port.
