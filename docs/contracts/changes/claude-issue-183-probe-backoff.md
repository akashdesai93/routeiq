# claude-issue-183-probe-backoff (#183)

- `DriveProbeBudget` gains `losingChecks: number` (3) and `rearmSlowdownChange: number` (0.1).
- `CheckProbeMemory` gains `losing: number` and `losingSlowdown: number | null`.
- `RerouteDecision` gains `probeCompared?: boolean`: true when a probed route was compared like
  for like this poll (the back-off counts only those as losses).
- New `ProbeSkip` (`'budget' | 'route-not-found' | 'not-held-up' | 'nothing-to-probe' |
  'backing-off'`) and `CheckProbePlan` (`{ points, skipped }`).
- Swift: already ported in this PR (`Probe.checkProbePlan`, `Probe.probeBackoffHolds`, the
  memory and budget fields, `rememberCheckProbes(..., driven:)`, `RerouteDecision.probeCompared`),
  with tests. Nothing left to port.
