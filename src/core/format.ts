import type { LngLat, SignalCoverage } from './types.ts'

const M_PER_MILE = 1609.344
const FT_PER_MILE = 5280
const NOT_AVAILABLE = 'n/a'

/** "14 min", "1 h 5 min". Rounds to the minute and never shows less than 1 min. */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return NOT_AVAILABLE
  const totalMin = Math.max(1, Math.round(sec / 60))
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min === 0 ? `${h} h` : `${h} h ${min} min`
}

/** US units: "5.8 mi", "12 mi", or feet (to the nearest 10) under a tenth of a mile. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return NOT_AVAILABLE
  const miles = meters / M_PER_MILE
  if (miles < 0.1) return `${Math.round((miles * FT_PER_MILE) / 10) * 10} ft`
  const tenths = Math.round(miles * 10) / 10
  return tenths < 10 ? `${tenths.toFixed(1)} mi` : `${Math.round(miles)} mi`
}

/**
 * Words for the difference from typical time (see delayVsTypicalSec).
 * Null means the provider gave no typical time, and says so.
 */
export function formatDelay(delaySec: number | null): string {
  if (delaySec === null || !Number.isFinite(delaySec)) return 'No typical time available'
  if (Math.round(delaySec / 60) === 0) return 'About the typical time'
  return delaySec > 0
    ? `${formatDuration(delaySec)} slower than typical`
    : `${formatDuration(-delaySec)} faster than typical`
}

/**
 * "14 signals", "1 signal", "0 signals" when the count covers the whole
 * route (a full count of zero is an answer, and reads like the others). With
 * partial coverage the count is a lower bound and says so:
 * "≥ 9 signals (partial)". Anything else is "Signals: unknown": a null count,
 * no coverage, or a partial count of zero, which would tell the reader
 * nothing. A count that is not known in full is never shown as a plain number.
 */
export function formatSignalCount(count: number | null, coverage: SignalCoverage = 'full'): string {
  if (count === null || !Number.isInteger(count) || count < 0 || coverage === 'none') return 'Signals: unknown'
  if (coverage === 'partial') {
    if (count === 0) return 'Signals: unknown'
    return `≥ ${count} ${count === 1 ? 'signal' : 'signals'} (partial)`
  }
  return count === 1 ? '1 signal' : `${count} signals`
}

/**
 * One line that explains a signal count that is not the whole answer, for a
 * tooltip next to it. Null for a full count, which needs no explaining.
 */
export function signalCountNote(count: number | null, coverage: SignalCoverage = 'full'): string | null {
  const label = formatSignalCount(count, coverage)
  if (label === 'Signals: unknown') return 'Signal data for this route could not be loaded.'
  if (coverage === 'partial') return 'Signal data for part of this route is missing, so this is a lower bound.'
  return null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * The month a dataset dates from, for a footnote: "Nov 2026". Takes
 * milliseconds since 1970 and reads them in UTC, so the same data shows the
 * same month everywhere. Null when there is no usable date.
 */
export function formatDataMonth(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  const date = new Date(ms)
  const month = MONTHS[date.getUTCMonth()]
  return month === undefined ? null : `${month} ${date.getUTCFullYear()}`
}

/** Latitude first, the way people read coordinates: "35.2271, -80.8431". */
export function formatLatLng([lng, lat]: LngLat): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
}
