import Foundation

// RouteIQ route data contracts, ported from src/core/types.ts.
//
// Rules, as in the TypeScript core:
// - Plain data and pure functions only. No UIKit, SwiftUI, Mapbox or CoreLocation.
// - Units are explicit in field names (Sec, M).
// - Coordinates are always longitude first, latitude second (GeoJSON order), WGS84.

/// A longitude and latitude in decimal degrees. GeoJSON order, not lat/lng.
public struct LngLat: Hashable, Sendable, Codable {
    public var lng: Double
    public var lat: Double

    public init(_ lng: Double, _ lat: Double) {
        self.lng = lng
        self.lat = lat
    }

    // Encoded as a two-element array, like the TypeScript tuple.
    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        lng = try c.decode(Double.self)
        lat = try c.decode(Double.self)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(lng)
        try c.encode(lat)
    }
}

/// A named point, such as a test origin or destination.
public struct Place: Hashable, Sendable {
    public let id: String
    public let label: String
    public let position: LngLat

    public init(id: String, label: String, position: LngLat) {
        self.id = id
        self.label = label
        self.position = position
    }
}

/// Axis-aligned bounding box: west, south, east, north.
public struct BBox: Hashable, Sendable {
    public var west: Double
    public var south: Double
    public var east: Double
    public var north: Double

    public init(_ west: Double, _ south: Double, _ east: Double, _ north: Double) {
        self.west = west
        self.south = south
        self.east = east
        self.north = north
    }
}

/// How much of a route its signalCount speaks for.
/// - `full`: signal data was loaded for every part of the route. The count is
///   the answer, and 0 really means no signals.
/// - `partial`: signal data was missing for part of the route. The count is a
///   rough lower bound. Never shown as a plain number and never used to rank.
/// - `none`: nothing is known. signalCount is nil.
public enum SignalCoverage: String, Hashable, Sendable, Codable {
    case full
    case partial
    case none
}

/// One intersection on a route, as the directions provider lists it.
public struct RouteIntersection: Hashable, Sendable {
    public var location: LngLat
    /// True when the provider flags a traffic signal here.
    public var signal: Bool

    public init(location: LngLat, signal: Bool) {
        self.location = location
        self.signal = signal
    }
}

/// A stretch of a route: meters from the route start to where it begins and ends.
public struct DistanceSpanM: Hashable, Sendable {
    public var startM: Double
    public var endM: Double

    public init(_ startM: Double, _ endM: Double) {
        self.startM = startM
        self.endM = endM
    }
}

public struct Maneuver: Hashable, Sendable {
    /// Distance from the route start to this maneuver, in meters.
    public var atDistanceM: Double
    public var kind: String
    public var location: LngLat

    public init(atDistanceM: Double, kind: String, location: LngLat) {
        self.atDistanceM = atDistanceM
        self.kind = kind
        self.location = location
    }
}

/// One drivable route option, provider-neutral. The Mapbox Navigation SDK
/// adapter in the app fills it; the core ranks and switches on it.
public struct RouteCandidate: Hashable, Sendable {
    /// Derived from the geometry (see Hash), so the same route keeps its id across refetches.
    public var id: String
    /// Polyline of the route, in driving order.
    public var geometry: [LngLat]
    /// Traffic-aware travel time right now, in seconds. NaN when unusable.
    public var durationSec: Double
    /// Typical travel time without live traffic, in seconds. Nil when the provider has none.
    public var typicalDurationSec: Double?
    public var distanceM: Double
    /// Distinct signalized intersections on the route (see Signals). Nil until
    /// counted, and nil whenever nothing is known. Read it with signalCoverage.
    public var signalCount: Int?
    /// How much of the route signalCount speaks for. `.none` exactly when signalCount is nil.
    public var signalCoverage: SignalCoverage
    /// The provider's own count of signal-flagged intersections, a cross-check only.
    public var providerSignalCount: Int?
    /// Every intersection the provider lists along the route, in driving order. Nil when none were sent.
    public var intersections: [RouteIntersection]?
    /// Stretches on controlled-access road, [startM, endM] along `geometry`. Nil when unknown.
    public var limitedAccessSpansM: [DistanceSpanM]?
    /// Upcoming maneuvers, used to block impractical late switches.
    public var maneuvers: [Maneuver]
    /// Turn-by-turn guidance for a live drive: one entry per maneuver, in
    /// driving order, each with what to show and what to say (see Guidance).
    /// Nil when the provider, or a test, has no turn data: the drive then
    /// runs without turn prompts.
    public var guidance: [GuidanceStep]?
    /// Where the route came from. `.probe`: asked for through a via point
    /// beside the fastest route (side-street probing), not one of the
    /// provider's own alternatives. Nil, or `.provider`: the provider offered it.
    public var source: RouteSource?
    /// For a probed route asked for during a drive: the via point it was asked
    /// through, so the next check can ask through the same point while the
    /// reroute engine confirms it. Nil otherwise.
    public var via: LngLat?
    /// Live traffic along the route, one entry per segment of `geometry`
    /// (entry i covers geometry[i] to geometry[i + 1]), from the provider's
    /// per-segment annotations. Nil when the provider sent none; each list
    /// inside is nil on its own when it is missing or does not have exactly
    /// one entry per segment. Never guessed.
    public var segmentTraffic: SegmentTraffic?

    public init(
        id: String,
        geometry: [LngLat],
        durationSec: Double,
        typicalDurationSec: Double?,
        distanceM: Double,
        signalCount: Int? = nil,
        signalCoverage: SignalCoverage = .none,
        providerSignalCount: Int? = nil,
        intersections: [RouteIntersection]? = nil,
        limitedAccessSpansM: [DistanceSpanM]? = nil,
        maneuvers: [Maneuver] = [],
        guidance: [GuidanceStep]? = nil,
        source: RouteSource? = nil,
        via: LngLat? = nil,
        segmentTraffic: SegmentTraffic? = nil
    ) {
        self.id = id
        self.geometry = geometry
        self.durationSec = durationSec
        self.typicalDurationSec = typicalDurationSec
        self.distanceM = distanceM
        self.signalCount = signalCount
        self.signalCoverage = signalCoverage
        self.providerSignalCount = providerSignalCount
        self.intersections = intersections
        self.limitedAccessSpansM = limitedAccessSpansM
        self.maneuvers = maneuvers
        self.guidance = guidance
        self.source = source
        self.via = via
        self.segmentTraffic = segmentTraffic
    }
}

/// How congested one stretch of road is right now, in the provider's words
/// (Mapbox: low, moderate, heavy, severe; `unknown` when it does not know).
public enum CongestionLevel: String, Hashable, Sendable, CaseIterable {
    case low
    case moderate
    case heavy
    case severe
    case unknown
}

/// See RouteCandidate.segmentTraffic. Both lists, when present, have geometry.count - 1 entries.
public struct SegmentTraffic: Hashable, Sendable {
    /// Congestion of each segment. Nil when the provider sent none, or the wrong number of entries.
    public var congestion: [CongestionLevel]?
    /// Traffic-aware travel time of each segment, in seconds. Nil when missing,
    /// the wrong length, or any entry is not a number of 0 or more. Carried for
    /// later use; nothing ranks or probes by it yet.
    public var durationSec: [Double]?

    public init(congestion: [CongestionLevel]?, durationSec: [Double]?) {
        self.congestion = congestion
        self.durationSec = durationSec
    }
}

/// See RouteCandidate.source.
public enum RouteSource: String, Hashable, Sendable {
    case provider
    case probe
}

/// Something to say before a maneuver, and where along the route to say it.
public struct GuidanceAnnouncement: Hashable, Sendable {
    /// Meters from the route start at which it becomes due. Never below 0.
    public var atDistanceM: Double
    /// Plain text for a text-to-speech engine (no SSML).
    public var text: String

    public init(atDistanceM: Double, text: String) {
        self.atDistanceM = atDistanceM
        self.text = text
    }
}

/// One maneuver of a route as the driver is told about it.
public struct GuidanceStep: Hashable, Sendable {
    /// Distance from the route start to the maneuver, in meters.
    public var atDistanceM: Double
    public var location: LngLat
    /// The provider's maneuver type: "turn", "fork", "off ramp", "merge", "roundabout", "arrive", ...
    public var type: String
    /// "left", "slight right", "uturn", "straight", ...; nil when the provider gives none.
    public var modifier: String?
    /// The big line of the turn banner: usually the road to turn onto. Never empty.
    public var primaryText: String
    /// The smaller line under it (a destination or a second road name). Nil when there is none.
    public var secondaryText: String?
    /// What to say on the way to this maneuver, in the order it becomes due.
    public var announcements: [GuidanceAnnouncement]
    /// True when the banner or the announcements were made up here from the
    /// step's plain instruction, because the provider sent no banner or voice
    /// instruction for it.
    public var synthesized: Bool

    public init(
        atDistanceM: Double,
        location: LngLat,
        type: String,
        modifier: String?,
        primaryText: String,
        secondaryText: String?,
        announcements: [GuidanceAnnouncement],
        synthesized: Bool
    ) {
        self.atDistanceM = atDistanceM
        self.location = location
        self.type = type
        self.modifier = modifier
        self.primaryText = primaryText
        self.secondaryText = secondaryText
        self.announcements = announcements
        self.synthesized = synthesized
    }
}

/// One point from a signal data source: a whole signalized intersection, or
/// one signal of several at an intersection (OpenStreetMap tags each approach).
public struct SignalPoint: Hashable, Sendable {
    /// Unique within its source.
    public var id: String
    public var position: LngLat
    /// The source's label, usually the cross streets. Nil when it has none.
    public var name: String?

    public init(id: String, position: LngLat, name: String?) {
        self.id = id
        self.position = position
        self.name = name
    }
}

/// Where a counted signal came from, most trusted first.
public enum SignalSource: String, Hashable, Sendable, CaseIterable {
    /// The main signal data (OpenStreetMap).
    case primary
    /// The directions provider's own flag, used where no signal data was loaded.
    case fallback
}

/// A signalized intersection a route passes through. One entry per pass.
public struct RouteSignal: Hashable, Sendable {
    /// The smallest id of the signal points that make it up.
    public var id: String
    /// The middle of the signal points that make up the intersection.
    public var position: LngLat
    public var name: String?
    public var source: SignalSource
    /// Distance from the route start to the closest point on the route, in meters.
    public var atDistanceM: Double
    /// How far the closest of its points (or their middle) lies from the route line, in meters.
    public var offsetM: Double
    /// Ids of every signal point merged into this entry.
    public var mergedIds: [String]

    public init(id: String, position: LngLat, name: String?, source: SignalSource, atDistanceM: Double, offsetM: Double, mergedIds: [String]) {
        self.id = id
        self.position = position
        self.name = name
        self.source = source
        self.atDistanceM = atDistanceM
        self.offsetM = offsetM
        self.mergedIds = mergedIds
    }
}

/// A route plus why it was ranked where it is. Filled by Rank.rankRoutes.
public struct RankedRoute: Hashable, Sendable {
    public var route: RouteCandidate
    /// 1 is the recommended route; no two routes share a rank.
    public var rank: Int
    /// Short plain-English lines for the UI, most important first. Never empty.
    public var reasons: [String]

    public init(route: RouteCandidate, rank: Int, reasons: [String]) {
        self.route = route
        self.rank = rank
        self.reasons = reasons
    }
}
