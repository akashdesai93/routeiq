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
        maneuvers: [Maneuver] = []
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
    /// A second dataset that only adds what the first lacks (City of Charlotte).
    case gapFill
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
