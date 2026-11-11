// Public surface of the framework-free core. UI code imports from here only.
export type {
  BBox,
  DistanceSpanM,
  LngLat,
  Maneuver,
  Place,
  RankedRoute,
  RouteCandidate,
  RouteIntersection,
  RouteSignal,
  SignalCoverage,
  SignalPoint,
  SignalSource,
} from './types.ts'
export {
  allWithin,
  alongRouteM,
  bearingDeg,
  boundsOf,
  distanceM,
  isValidLngLat,
  lineFrom,
  localProjector,
  pointAtDistance,
  pointToSegment,
  type PointOnLine,
  type XY,
} from './geo.ts'
export { delayVsTypicalSec } from './facts.ts'
export {
  formatDataMonth,
  formatDelay,
  formatDistance,
  formatDuration,
  formatLatLng,
  formatSignalCount,
  signalCountNote,
} from './format.ts'
export { geometryHash, routeIdFromGeometry } from './hash.ts'
export {
  DEFAULT_ETA_TIE_WINDOW_SEC,
  rankRoutes,
  recommendedRouteId,
  type RankOptions,
} from './rank.ts'
export {
  decideReroute,
  DEFAULT_REROUTE_OPTIONS,
  findCurrentRoute,
  INITIAL_REROUTE_STATE,
  type RerouteAlternative,
  type RerouteCode,
  type RerouteDecision,
  type RerouteObservation,
  type RerouteOptions,
  type RerouteState,
} from './reroute.ts'
export {
  resolveSelectedId,
  SAME_ROUTE_TOLERANCE_M,
  sameRouteGeometry,
} from './select.ts'
export {
  clusterSignals,
  DEFAULT_SIGNAL_MATCH,
  signalsOnRoute,
  signalTilesForRoute,
  withSignalCounts,
  type CountedRoutes,
  type RouteContext,
  type RouteSignals,
  type SignalCluster,
  type SignalData,
  type SignalMatchOptions,
} from './signals.ts'
export { TILE_SIZE_DEG, tileBounds, tileIdAt, tilesForRoute } from './tiles.ts'
export { DEFAULT_TRIP, INDIAN_LAND, SOUTHPARK, TEST_PLACES, UPTOWN_CHARLOTTE } from './testPoints.ts'
