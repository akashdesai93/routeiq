# claude-diag-check-outcomes (#175)

- `LiveState.lastDecision` gains `routes` (how many routes the check's answer had; null when
  none came back or the previous route was kept) and `savingSec` (the considered alternative's
  like-for-like saving, `RerouteAlternative.savingSec`; 0 for `current-best`, null when the
  engine could not compare). Read by the drive diagnostics; the reroute engine is unchanged.
- Swift: already ported in this pull request (`Live.swift`'s `LiveState.Decision` gains
  `routes: Int?` and `savingSec: Double?`). The version bump is left to the port bump.
