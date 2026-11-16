import { useMemo } from 'react'
import { corridorJams, corridorJamWords, jamWords, type DriveRecord } from './core/index.ts'

/**
 * One drive's time crawled in jams on main roads (#227), as the Drives screen
 * shows it: "In jams on main roads: 6 min in 2 jams". Shows only: the rules
 * and the words are in core/jams.ts.
 */
export function JamLine({ drive }: { drive: DriveRecord }) {
  return <p aria-label="Jams">In jams on main roads: {jamWords(drive.jams)}</p>
}

/** The corridor's average jam time per drive, the number the jam-bypass kill line is read from (docs/jam-bypass.md). */
export function CorridorJamLine({ drives, corridor }: { drives: readonly DriveRecord[]; corridor: string }) {
  const jams = useMemo(() => corridorJams(drives, corridor), [drives, corridor])
  return <p aria-label="Jams per drive">In jams on main roads: {corridorJamWords(jams)}</p>
}
