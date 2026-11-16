// Speeds for a scripted drive (DriveOptions.speedMps): cruising, with crawls at set times.

/** One crawl: from simulated second `fromSec`, for `forSec` seconds, at `mps` meters per second. */
export interface Crawl {
  readonly fromSec: number
  readonly forSec: number
  readonly mps: number
}

/**
 * The car's speed by simulated second: `cruiseMps`, except during each crawl. Use even seconds:
 * the fake GPS sends a fix every two.
 */
export function crawling(crawls: readonly Crawl[], cruiseMps = 25): (sec: number) => number {
  return (sec) => crawls.find((c) => sec >= c.fromSec && sec < c.fromSec + c.forSec)?.mps ?? cruiseMps
}
