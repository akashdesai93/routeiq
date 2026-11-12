# claude-issue-183-probe-backoff (#183)

Built on PR #176's branch (`claude/diag-check-outcomes`), so this branch also carries #176's
change: `LiveState.lastDecision` gains `routes: number | null` and `savingSec: number | null`
(already ported to `Live.swift` there).

This PR:
- `DriveProbeBudget` gains `losingChecks: number` (3) and `rearmSlowdownChange: number` (0.1).
- `CheckProbeMemory` gains `losing: number` and `losingSlowdown: number | null`.
- New `ProbeSkip` (`'budget' | 'route-not-found' | 'not-held-up' | 'nothing-to-probe' |
  'backing-off'`) and `CheckProbePlan` (`{ points, skipped }`).
- Swift: already ported in this PR (`Probe.checkProbePlan`, `Probe.probeBackoffHolds`, the
  memory and budget fields, `rememberCheckProbes(..., driven:)`), with tests. Nothing left to port.
