// Every threshold of the fleet scripts, in one place (CLAUDE.md, rule 4). docs/orchestrator.md
// names the same numbers; change both together.
export const DEFAULT_ORCH_OPTIONS = Object.freeze({
  /** How far back #17 comments are read (by updated_at, so an edited heartbeat is always seen). */
  windowHours: 48,
  /** The orchestrator heartbeat is stale after this: the understudy acts. */
  heartbeatStaleMin: 90,
  /** ...and after this the alert issue opens. */
  heartbeatAlertMin: 180,
  /** A session that is working, waiting or blocked and has not posted for this long is silent. */
  sessionSilentHours: 2,
  /** A red or conflicting PR with no push for this long is orphaned. */
  prIdleHours: 2,
  /** A claim younger than this belongs to someone else (claim before fix). */
  claimFreshHours: 2,
  /** A dispatched session that has not posted a status after this long is reported. */
  dispatchSilentHours: 1,
  /** Characters kept of a free-text field in events and the board. */
  textMax: 140,
})
