# claude-issue-197-switch-moment (#197)

- `LiveState.offer` gains what the driver needs to take it: `route` (the offered
  `RouteCandidate`, as the check gave it), `turnAlongM` (its turn-off, meters along the route
  being driven), `step` (its `GuidanceStep` at the turn-off, the step nearest it within
  `heldTurnMatchM`; null when none) and `onFreeway` (from `RerouteAlternative.onFreeway`).
- `LiveState` gains `withdrawn: { untilMs, tooLate } | null`: the calm banner after an offer
  ended without a switch, shown for `switchBannerSec`. Never spoken.
- `LiveEvent` gains `{ type: 'take-offer', nowMs }` ("Take it"): switches at once to
  `offer.route`, exactly like the engine's switch (spoken `switchLine` with the live distance
  to the turn-off, banner, undo), with the engine state from `takeRoute`. A check that is out
  is cancelled. Ignored with no offer, off the route, or while a switch banner shows.
  `lastDecision.code` gains `'taken-offer'`.
- `SwitchMoment` 'pending' gains `turn: { arrow, distanceM, primaryText }` (arrow and text null
  when `step` is null) and `canTake: true`; a new stage `'withdrawn'` (`title`:
  `WITHDRAWN_TITLE.tooLate` or `.notFaster`, `canKeep: false`).
- Rules the port must keep: on every on-route fix, an offer whose turn-off is nearer than
  `requiredLead(speed, onFreeway)` ends at once (offer and turn cleared, `engine.pending`
  cleared, `withdrawn.tooLate`); a check that does not renew an offer ends it
  (`withdrawn.tooLate` only for code 'too-late').
- Reroute: new pure `requiredLead(speedMps, onFreeway, options)` (the lead `measure` already
  used) and `takeRoute(state, leftAhead, nowSec)` (the state after a switch; `decideReroute`'s
  own switches now use the same function). No threshold changed.
- Swift: not ported here. Port `Live.swift` and `Reroute.swift` with the new tests in
  `tests/live.test.ts` ("taking or losing a faster route on offer") and `tests/reroute.test.ts`
  ("the lead a turn-off needs") as the spec.
