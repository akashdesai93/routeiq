/**
 * RouteIQ route data contracts.
 *
 * Rules for everything under src/core:
 * - Plain data and pure functions only. No React, no Mapbox, no DOM, no fetch.
 * - Units are explicit in field names (Sec, M) so a Swift port or a service
 *   can map them one to one.
 * - Coordinates are always [longitude, latitude] (GeoJSON order), WGS84.
 */

/** [longitude, latitude] in decimal degrees. GeoJSON order, not lat/lng. */
export type LngLat = readonly [lng: number, lat: number]

/** A named point, such as a test origin or destination. */
export interface Place {
  readonly id: string
  readonly label: string
  readonly position: LngLat
}

/** Axis-aligned bounding box: [west, south, east, north]. */
export type BBox = readonly [west: number, south: number, east: number, north: number]

/**
 * One drivable route option, as the app sees it after reading a directions
 * provider. Provider-neutral on purpose: the Mapbox adapter fills it today,
 * the Swift Navigation SDK adapter can fill the same shape later.
 */
export interface RouteCandidate {
  /** Derived from the geometry (see hash.ts), so the same route keeps its id across refetches. */
  readonly id: string
  /** Polyline of the route, [lng, lat] pairs in driving order. */
  readonly geometry: readonly LngLat[]
  /** Traffic-aware travel time right now, in seconds. */
  readonly durationSec: number
  /** Typical travel time without live traffic, in seconds. Null when the provider has none. */
  readonly typicalDurationSec: number | null
  readonly distanceM: number
  /**
   * Distinct signalized intersections on the route (see signals.ts). Null
   * until counted, and null whenever nothing is known about the route's
   * signals. Read it together with signalCoverage: only a 'full' count is the
   * whole answer.
   */
  readonly signalCount: number | null
  /** How much of the route signalCount speaks for. 'none' exactly when signalCount is null. */
  readonly signalCoverage: SignalCoverage
  /**
   * The directions provider's own count of signal-flagged intersections on the
   * route, kept apart from signalCount as a cross-check only: it is not used
   * to rank or shown as the count. Null when the provider sent no
   * intersection data.
   */
  readonly providerSignalCount: number | null
  /**
   * Every intersection the provider lists along the route, in driving order.
   * Used two ways (see signals.ts): a signal only counts when the route has an
   * intersection near it, which leaves out signals on roads passing over or
   * under the route; and the provider's own signal flags stand in where no
   * signal data could be loaded. Null when the provider sent no intersection
   * data, which switches the first rule off rather than dropping every signal.
   */
  readonly intersections: readonly RouteIntersection[] | null
  /**
   * Stretches of the route driven on controlled-access road (freeway mainline
   * and its ramps and connectors), where there are no traffic signals to stop
   * at. Each span is [startM, endM], measured along `geometry` from the route
   * start (see alongRouteM in geo.ts), in driving order, not overlapping.
   * Used to keep signals on streets that cross over or under a freeway out of
   * signalCount (see signals.ts). Null when the provider does not say what
   * kind of road the route is on; an empty list means it says there is none.
   */
  readonly limitedAccessSpansM: readonly DistanceSpanM[] | null
  /** Upcoming maneuvers, used later to block impractical late switches. */
  readonly maneuvers: readonly Maneuver[]
  /**
   * Turn-by-turn guidance for a live drive: one entry per maneuver, in
   * driving order, each with what to show and what to say (see guidance.ts).
   * Left out by a provider, or a test, that has no turn data: the drive then
   * runs without turn prompts.
   */
  readonly guidance?: readonly GuidanceStep[]
  /**
   * Where the route came from. 'probe': asked for through a via point beside
   * the fastest route (side-street probing, see probe.ts), not one of the
   * provider's own alternatives. Left out, or 'provider': the provider offered it.
   */
  readonly source?: RouteSource
}

/** See RouteCandidate.source. */
export type RouteSource = 'provider' | 'probe'

/** Something to say before a maneuver, and where along the route to say it. */
export interface GuidanceAnnouncement {
  /** Meters from the route start at which it becomes due. Never below 0. */
  readonly atDistanceM: number
  /** Plain text for a text-to-speech engine (no SSML). */
  readonly text: string
}

/** One maneuver of a route as the driver is told about it. */
export interface GuidanceStep {
  /** Distance from the route start to the maneuver, in meters. */
  readonly atDistanceM: number
  readonly location: LngLat
  /** The provider's maneuver type: "turn", "fork", "off ramp", "merge", "roundabout", "arrive", ... */
  readonly type: string
  /** "left", "slight right", "uturn", "straight", ...; null when the provider gives none. */
  readonly modifier: string | null
  /** The big line of the turn banner: usually the road to turn onto. Never empty. */
  readonly primaryText: string
  /** The smaller line under it (a destination or a second road name). Null when there is none. */
  readonly secondaryText: string | null
  /** What to say on the way to this maneuver, in the order it becomes due. */
  readonly announcements: readonly GuidanceAnnouncement[]
  /**
   * True when the banner or the announcements were made up here from the
   * step's plain instruction, because the provider sent no banner or voice
   * instruction for it.
   */
  readonly synthesized: boolean
}

/**
 * How much of a route its signalCount speaks for.
 * - 'full': signal data was loaded for every part of the route. The count is
 *   the answer, and 0 really means no signals.
 * - 'partial': signal data was missing for part of the route. The count is
 *   what could be found (with the directions provider's own signal flags
 *   standing in on the missing stretches), so read it as "at least about this
 *   many". Never shown as a plain number and never used to rank.
 * - 'none': nothing is known. signalCount is null.
 */
export type SignalCoverage = 'full' | 'partial' | 'none'

/** One intersection on a route, as the directions provider lists it. */
export interface RouteIntersection {
  readonly location: LngLat
  /** True when the provider flags a traffic signal here. */
  readonly signal: boolean
}

/** A stretch of a route: meters from the route start to where it begins and ends. */
export type DistanceSpanM = readonly [startM: number, endM: number]

export interface Maneuver {
  /** Distance from the route start to this maneuver, in meters. */
  readonly atDistanceM: number
  readonly kind: string
  readonly location: LngLat
}

/**
 * One point from a signal data source. Depending on the source that is a
 * whole signalized intersection or one signal of several at an intersection
 * (OpenStreetMap tags each approach on big junctions).
 */
export interface SignalPoint {
  /** Unique within its source. */
  readonly id: string
  readonly position: LngLat
  /** The source's label, usually the cross streets. Null when it has none. */
  readonly name: string | null
}

/**
 * Where a counted signal came from, most trusted first:
 * - 'primary': the main signal data (OpenStreetMap today).
 * - 'fallback': the directions provider's own flag, used where no signal data was loaded.
 */
export type SignalSource = 'primary' | 'fallback'

/** A signalized intersection a route passes through. One entry per pass. */
export interface RouteSignal {
  /** Id of the intersection: the smallest id of the signal points that make it up. */
  readonly id: string
  /** The middle of the signal points that make up the intersection. */
  readonly position: LngLat
  readonly name: string | null
  readonly source: SignalSource
  /** Distance from the route start to the point on the route closest to the signal, in meters. */
  readonly atDistanceM: number
  /** How far the closest of its signal points (or their middle) lies from the route line, in meters. */
  readonly offsetM: number
  /** Ids of every signal point merged into this entry (one intersection can have several). */
  readonly mergedIds: readonly string[]
}

/** A route plus why it was ranked where it is. Filled by rankRoutes (rank.ts). */
export interface RankedRoute {
  readonly route: RouteCandidate
  /** 1 is the recommended route; no two routes share a rank. */
  readonly rank: number
  /** Short plain-English lines for the UI, most important first. Never empty. */
  readonly reasons: readonly string[]
}
