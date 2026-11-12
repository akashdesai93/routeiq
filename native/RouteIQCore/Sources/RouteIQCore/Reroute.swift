import Foundation

// The switching brain, ported from src/core/reroute.ts: given what a poll just
// returned, should the driver stay on the route being driven or change to
// another one, with no tap.
//
// A pure, deterministic state machine. Time is an input (nowSec), never read
// from a clock; the state is plain data that the caller keeps between polls.

/// Every threshold of the reroute rules, in one place. The initializer's
/// defaults are the values; `RerouteOptions.default` is the documented set.
/// See src/core/reroute.ts for the full commentary on each.
public struct RerouteOptions: Hashable, Sendable {
    /// An alternative must beat the current route's fresh ETA by at least this many seconds...
    public var minSavingSec: Double
    /// ...and by at least this share of the time left on the current route (0.05 is 5%).
    public var minSavingFraction: Double
    /// The same alternative has to win this many polls in a row before a switch. 1 switches on the first.
    public var confirmPolls: Int
    /// After a switch, no other switch for this many seconds.
    public var cooldownSec: Double
    /// A route left less than this many seconds ago is only taken again for a bigger saving.
    public var noReturnSec: Double
    /// Going back to a route left recently needs this many times the minimum saving, seconds and share both.
    public var returnSavingFactor: Double
    /// Never switch when the alternative turns off closer than this, in meters...
    public var minLeadDistanceM: Double
    /// ...or closer than this many seconds of driving at the current speed. The larger applies.
    public var minLeadTimeSec: Double
    /// On a freeway the turn-off is an exit that needs lane changes: at least this far ahead, in meters.
    public var freewayLeadDistanceM: Double
    /// The current route is given up only after the provider, asked for the
    /// current path itself (RerouteObservation.baseline), has answered "no
    /// route that way" this many polls in a row (a closure).
    public var routeLostPolls: Int
    /// The driver is off the current route when the fresh routes start farther than this from its line, in meters.
    public var offRouteM: Double
    /// How close a point must be to the current route's line to be on it, in
    /// meters. Used to find where an alternative turns off and which maneuvers
    /// it shares; whole-route matching uses the match* thresholds.
    public var sameRouteToleranceM: Double
    /// Matching a fresh route to the rest of the current one: how far apart
    /// the two lines may run and still be together, in meters.
    public var matchToleranceM: Double
    /// ...and the share of each line's length that must run within that
    /// distance of the other (0.95 is 95%), measured on the shorter of the two.
    public var matchMinOverlap: Double
    /// ...and no single stretch apart may be longer than this, in meters; nor may the two lengths differ by more.
    public var matchMaxGapM: Double
    /// ...and no point of either line may run farther than this from the other, in meters (#41).
    public var matchMaxDivergenceM: Double
    /// The first meters after the query point are not compared.
    public var matchIgnoreStartM: Double
    /// Asking for the current path's own travel time (baselineProbe): a via
    /// point at least every this many meters along each stretch the fresh routes do not share.
    public var baselineViaSpacingM: Double
    /// ...and no more than this many via points in one request.
    public var baselineMaxViaPoints: Int
    /// An alternative is "going back" to a route left recently when at least this share of its own part runs along it.
    public var returnOverlapFraction: Double
    /// Compare ETAs only when both routes carry a typical duration (traffic data).
    public var requireTypicalDuration: Bool
    /// Passed on to Rank.rankRoutes: ETAs this close are a tie that signals may break.
    public var etaTieWindowSec: Double

    public init(
        minSavingSec: Double = 120,
        minSavingFraction: Double = 0.05,
        confirmPolls: Int = 2,
        cooldownSec: Double = 300,
        noReturnSec: Double = 600,
        returnSavingFactor: Double = 2,
        minLeadDistanceM: Double = 400,
        minLeadTimeSec: Double = 20,
        freewayLeadDistanceM: Double = 1200,
        routeLostPolls: Int = 3,
        offRouteM: Double = 50,
        sameRouteToleranceM: Double = Select.sameRouteToleranceM,
        matchToleranceM: Double = 20,
        matchMinOverlap: Double = 0.95,
        matchMaxGapM: Double = 400,
        matchMaxDivergenceM: Double = 50,
        matchIgnoreStartM: Double = 150,
        baselineViaSpacingM: Double = 3000,
        baselineMaxViaPoints: Int = 6,
        returnOverlapFraction: Double = 0.5,
        requireTypicalDuration: Bool = true,
        etaTieWindowSec: Double = Rank.defaultEtaTieWindowSec
    ) {
        self.minSavingSec = minSavingSec
        self.minSavingFraction = minSavingFraction
        self.confirmPolls = confirmPolls
        self.cooldownSec = cooldownSec
        self.noReturnSec = noReturnSec
        self.returnSavingFactor = returnSavingFactor
        self.minLeadDistanceM = minLeadDistanceM
        self.minLeadTimeSec = minLeadTimeSec
        self.freewayLeadDistanceM = freewayLeadDistanceM
        self.routeLostPolls = routeLostPolls
        self.offRouteM = offRouteM
        self.sameRouteToleranceM = sameRouteToleranceM
        self.matchToleranceM = matchToleranceM
        self.matchMinOverlap = matchMinOverlap
        self.matchMaxGapM = matchMaxGapM
        self.matchMaxDivergenceM = matchMaxDivergenceM
        self.matchIgnoreStartM = matchIgnoreStartM
        self.baselineViaSpacingM = baselineViaSpacingM
        self.baselineMaxViaPoints = baselineMaxViaPoints
        self.returnOverlapFraction = returnOverlapFraction
        self.requireTypicalDuration = requireTypicalDuration
        self.etaTieWindowSec = etaTieWindowSec
    }

    /// The one place the defaults are set.
    public static let `default` = RerouteOptions()

    /// A threshold that is negative or not a number falls back to its default.
    func resolved() -> RerouteOptions {
        let d = RerouteOptions.default
        func numberOr(_ v: Double, _ fallback: Double) -> Double { v.isFinite && v >= 0 ? v : fallback }
        func countOr(_ v: Int, _ fallback: Int) -> Int { max(1, v >= 0 ? v : fallback) }
        return RerouteOptions(
            minSavingSec: numberOr(minSavingSec, d.minSavingSec),
            minSavingFraction: numberOr(minSavingFraction, d.minSavingFraction),
            confirmPolls: countOr(confirmPolls, d.confirmPolls),
            cooldownSec: numberOr(cooldownSec, d.cooldownSec),
            noReturnSec: numberOr(noReturnSec, d.noReturnSec),
            returnSavingFactor: max(1, numberOr(returnSavingFactor, d.returnSavingFactor)),
            minLeadDistanceM: numberOr(minLeadDistanceM, d.minLeadDistanceM),
            minLeadTimeSec: numberOr(minLeadTimeSec, d.minLeadTimeSec),
            freewayLeadDistanceM: numberOr(freewayLeadDistanceM, d.freewayLeadDistanceM),
            routeLostPolls: countOr(routeLostPolls, d.routeLostPolls),
            offRouteM: numberOr(offRouteM, d.offRouteM),
            sameRouteToleranceM: numberOr(sameRouteToleranceM, d.sameRouteToleranceM),
            matchToleranceM: numberOr(matchToleranceM, d.matchToleranceM),
            matchMinOverlap: min(1, numberOr(matchMinOverlap, d.matchMinOverlap)),
            matchMaxGapM: numberOr(matchMaxGapM, d.matchMaxGapM),
            matchMaxDivergenceM: numberOr(matchMaxDivergenceM, d.matchMaxDivergenceM),
            matchIgnoreStartM: numberOr(matchIgnoreStartM, d.matchIgnoreStartM),
            baselineViaSpacingM: max(1, numberOr(baselineViaSpacingM, d.baselineViaSpacingM)),
            baselineMaxViaPoints: countOr(baselineMaxViaPoints, d.baselineMaxViaPoints),
            returnOverlapFraction: numberOr(returnOverlapFraction, d.returnOverlapFraction),
            requireTypicalDuration: requireTypicalDuration,
            etaTieWindowSec: numberOr(etaTieWindowSec, d.etaTieWindowSec)
        )
    }
}

/// What the engine remembers between polls. Plain data: keep it, pass it back.
public struct RerouteState: Hashable, Sendable {
    public struct Pending: Hashable, Sendable {
        public var geometry: [LngLat]
        public var polls: Int

        public init(geometry: [LngLat], polls: Int) {
            self.geometry = geometry
            self.polls = polls
        }
    }

    public struct Abandoned: Hashable, Sendable {
        public var geometry: [LngLat]
        public var atSec: Double

        public init(geometry: [LngLat], atSec: Double) {
            self.geometry = geometry
            self.atSec = atSec
        }
    }

    public struct Declined: Hashable, Sendable {
        public var geometry: [LngLat]
        public var untilSec: Double

        public init(geometry: [LngLat], untilSec: Double) {
            self.geometry = geometry
            self.untilSec = untilSec
        }
    }

    /// The alternative that won the last poll and how many polls in a row it
    /// has won, remembered by its path (ids change from poll to poll).
    public var pending: Pending?
    /// When the last switch was made (the nowSec of that poll). Nil before the first.
    public var lastSwitchAtSec: Double?
    /// The routes left by a switch, each as the path that was still ahead then. Old entries are dropped.
    public var abandoned: [Abandoned]
    /// Polls in a row that failed (no answer). A failed poll changes nothing else.
    public var failedPolls: Int
    /// Polls in a row in which the provider was asked for the current path
    /// itself and found no route that way (see RerouteOptions.routeLostPolls).
    /// A poll that could not ask leaves it as it is; one that finds the
    /// current route sets it back to 0.
    public var lostPolls: Int
    /// Routes the driver turned down ("Keep previous route"), each as the
    /// path that was ahead then and the time until which it is not to be
    /// offered again (see declineRoute). Empty when there are none (the
    /// TypeScript may also leave it out).
    public var declined: [Declined]

    public init(
        pending: Pending? = nil,
        lastSwitchAtSec: Double? = nil,
        abandoned: [Abandoned] = [],
        failedPolls: Int = 0,
        lostPolls: Int = 0,
        declined: [Declined] = []
    ) {
        self.pending = pending
        self.lastSwitchAtSec = lastSwitchAtSec
        self.abandoned = abandoned
        self.failedPolls = failedPolls
        self.lostPolls = lostPolls
        self.declined = declined
    }

    /// The state to start a drive with.
    public static let initial = RerouteState()
}

/// The parts of the route being driven that the engine reads.
public struct DrivenRoute: Hashable, Sendable {
    public var geometry: [LngLat]
    public var maneuvers: [Maneuver]
    public var limitedAccessSpansM: [DistanceSpanM]?

    public init(geometry: [LngLat], maneuvers: [Maneuver] = [], limitedAccessSpansM: [DistanceSpanM]? = nil) {
        self.geometry = geometry
        self.maneuvers = maneuvers
        self.limitedAccessSpansM = limitedAccessSpansM
    }

    public init(_ route: RouteCandidate) {
        self.init(geometry: route.geometry, maneuvers: route.maneuvers, limitedAccessSpansM: route.limitedAccessSpansM)
    }
}

/// What one poll found.
public struct RerouteObservation: Hashable, Sendable {
    /// The time of the poll, in seconds on any clock that only moves forward.
    public var nowSec: Double
    /// The route being driven.
    public var route: DrivenRoute
    /// How far along `route` the driver was when the directions query was
    /// sent, in meters from its start (see Geo.alongRouteM).
    public var positionAlongM: Double
    /// The driver's speed, in meters per second.
    public var speedMps: Double
    /// The routes a directions query from the driver's position just returned.
    /// Nil when the poll failed: nothing is known this time.
    public var candidates: [RouteCandidate]?
    /// How far the driver is from the current route's line, in meters, when
    /// the caller measures it (GPS). Nil: taken from where the fresh routes start.
    public var offRouteM: Double?
    /// What the provider answered when asked for the CURRENT path itself
    /// (through the via points of baselineProbe), for a poll in which none of
    /// `candidates` is the rest of the current route. Nil: not asked, or the
    /// request failed. Empty: asked, and no route that way at all (counts
    /// towards routeLostPolls).
    public var baseline: [RouteCandidate]?
    /// How far the driver has gone along the current route since the query
    /// was sent, in meters, when the caller measures it. Every turn-off is
    /// that much nearer. Nil, or not a positive number: 0.
    public var drivenSinceM: Double?

    public init(
        nowSec: Double,
        route: DrivenRoute,
        positionAlongM: Double,
        speedMps: Double,
        candidates: [RouteCandidate]?,
        offRouteM: Double? = nil,
        baseline: [RouteCandidate]? = nil,
        drivenSinceM: Double? = nil
    ) {
        self.nowSec = nowSec
        self.route = route
        self.positionAlongM = positionAlongM
        self.speedMps = speedMps
        self.candidates = candidates
        self.offRouteM = offRouteM
        self.baseline = baseline
        self.drivenSinceM = drivenSinceM
    }
}

/// Why a decision came out as it did, for logs and tests.
public enum RerouteCode: String, Hashable, Sendable, CaseIterable {
    case pollFailed = "poll-failed"
    case noRoutes = "no-routes"
    case offRoute = "off-route"
    case routeUnconfirmed = "route-unconfirmed"
    case routeLost = "route-lost"
    case noEta = "no-eta"
    case noTrafficData = "no-traffic-data"
    case noAlternative = "no-alternative"
    case currentBest = "current-best"
    case savingTooSmall = "saving-too-small"
    case savingShareTooSmall = "saving-share-too-small"
    case probeUnconfirmed = "probe-unconfirmed"
    case recentlyAbandoned = "recently-abandoned"
    case driverDeclined = "driver-declined"
    case tooLate = "too-late"
    case confirming
    case cooldown
    case fasterRoute = "faster-route"
}

public enum RerouteAction: String, Hashable, Sendable {
    case stay
    case switchRoute = "switch"
}

/// The alternative a decision was about: the one switched to, or the one that came closest.
public struct RerouteAlternative: Hashable, Sendable {
    /// Its id among this poll's candidates. Ids are only good within one poll.
    public var routeId: String
    /// Seconds it saves against the current route's fresh ETA. Nil when that ETA is unknown.
    public var savingSec: Double?
    /// Meters from the driver to where it leaves the current route (or to its own first maneuver, if sooner).
    public var turnInM: Double
    /// That point on the map.
    public var turnAt: LngLat
    /// The lead distance the rules ask for here, in meters.
    public var requiredLeadM: Double
    /// True when the turn-off is on controlled-access road, where the longer lead applies.
    public var onFreeway: Bool
}

/// The fresh travel time of the route being driven (see RerouteDecision.current).
public struct RerouteCurrentEta: Hashable, Sendable {
    public var durationSec: Double
    public var distanceM: Double
    /// True when it came from the request for the current path itself
    /// (RerouteObservation.baseline), not from the fresh routes.
    public var asked: Bool

    public init(durationSec: Double, distanceM: Double, asked: Bool) {
        self.durationSec = durationSec
        self.distanceM = distanceM
        self.asked = asked
    }
}

public struct RerouteDecision: Hashable, Sendable {
    public var action: RerouteAction
    /// With `.switchRoute`: the id of the candidate (of this poll) to drive from now on.
    public var toRouteId: String?
    /// One short plain-English sentence, fit to be spoken aloud.
    public var reason: String
    public var code: RerouteCode
    /// Nil when the decision was not about one particular alternative.
    public var considered: RerouteAlternative?
    /// The fresh travel time of the route being driven, from the driver to
    /// the destination, when this poll gave one: the like-for-like baseline.
    /// Nil when it is unknown, and on a switch.
    public var current: RerouteCurrentEta?
    /// Pass this back with the next observation.
    public var nextState: RerouteState
}

/// Counts the work of matching (findCurrentRoute), for tests and benchmarks:
/// point-to-segment distance checks, and entries put in a segment grid. A
/// count, not a time, so that it is the same on every machine.
public final class MatchMeter {
    public var segmentChecks: Int
    public var gridEntries: Int

    public init(segmentChecks: Int = 0, gridEntries: Int = 0) {
        self.segmentChecks = segmentChecks
        self.gridEntries = gridEntries
    }
}

/// A point for the provider to route through, with the direction of travel there.
public struct BaselineViaPoint: Hashable, Sendable {
    public var point: LngLat
    /// Degrees clockwise from true north.
    public var bearingDeg: Double

    public init(point: LngLat, bearingDeg: Double) {
        self.point = point
        self.bearingDeg = bearingDeg
    }
}

/// What baselineProbe says to ask for.
public struct BaselineProbe: Hashable, Sendable {
    public var via: [BaselineViaPoint]

    public init(via: [BaselineViaPoint]) {
        self.via = via
    }
}

/// The reroute engine. See `decideReroute` for the rules.
public enum Reroute {
    /// "40 seconds", "1.9 minutes", "3 minutes". Rounded down, so a saving is never overstated.
    public static func spokenDuration(_ sec: Double) -> String {
        let s = sec.isFinite ? max(0, sec) : 0
        if s < 90 {
            let whole = s.rounded(.down)
            return whole == 1 ? "1 second" : "\(JS.string(whole)) seconds"
        }
        let tenths = (s / 6).rounded(.down) / 10
        let minutes = tenths < 10 ? tenths : tenths.rounded(.down)
        return minutes == 1 ? "1 minute" : "\(JS.string(minutes)) minutes"
    }

    static let mPerMile = 1609.344
    static let ftPerM = 3.28084

    /// "300 feet", "0.8 miles", "1 mile". Rounded down, so a turn is never said to be farther than it is.
    public static func spokenDistance(_ meters: Double) -> String {
        let m = meters.isFinite ? max(0, meters) : 0
        let tenths = (m / mPerMile * 10).rounded(.down) / 10
        if tenths < 0.1 { return "\(JS.string((m * ftPerM / 50).rounded(.down) * 50)) feet" }
        return tenths == 1 ? "1 mile" : "\(JS.string(tenths)) miles"
    }

    struct Nearest {
        let distanceM: Double
        let index: Int
        let t: Double
    }

    /// The closest point of a line to P: how far it is, and where along the line.
    static func nearestOnLine(_ p: XY, _ line: [XY], _ meter: MatchMeter? = nil) -> Nearest {
        if line.count == 1 { return Nearest(distanceM: hypot(p.x - line[0].x, p.y - line[0].y), index: 0, t: 0) }
        meter?.segmentChecks += line.count - 1
        var best = Nearest(distanceM: .infinity, index: 0, t: 0)
        for i in stride(from: 1, to: line.count, by: 1) {
            let hit = Geo.pointToSegment(p, line[i - 1], line[i])
            if hit.distanceM < best.distanceM { best = Nearest(distanceM: hit.distanceM, index: i - 1, t: hit.t) }
        }
        return best
    }

    static func isNear(_ p: XY, _ line: [XY], _ toleranceM: Double) -> Bool {
        Geo.nearLine(p, line, toleranceM)
    }

    static func apart(_ p: XY, _ q: XY) -> Double { hypot(p.x - q.x, p.y - q.y) }

    static func lengthOf(_ line: ArraySlice<XY>) -> Double {
        var total = 0.0
        var i = line.startIndex + 1
        while i < line.endIndex {
            total += apart(line[i - 1], line[i])
            i += 1
        }
        return total
    }

    static func lengthOf(_ line: [XY]) -> Double { lengthOf(line[...]) }

    /// A bounding-box index of a line's segments: square cells as wide as
    /// `reachM`, each listing the segments that pass through it (a long
    /// segment is cut into pieces no longer than a cell). A point then looks
    /// at the segments of the 3 x 3 cells around it.
    final class SegmentGrid {
        struct Cell: Hashable {
            let x: Double
            let y: Double
        }

        let line: [XY]
        let cellM: Double
        var cells: [Cell: [Int]] = [:]
        let meter: MatchMeter?
        /// Which segments this query has measured already (a segment can be listed in several of its cells).
        var seen: [Int]
        var query = 0

        init(_ line: [XY], reachM: Double, meter: MatchMeter?) {
            self.line = line
            self.meter = meter
            let cellM = JS.max(1, reachM)
            self.cellM = cellM
            seen = Array(repeating: 0, count: line.count)
            func cellOf(_ v: Double) -> Double { (v / cellM).rounded(.down) }
            for i in stride(from: 1, to: line.count, by: 1) {
                let a = line[i - 1]
                let b = line[i]
                let pieces = JS.max(1, (Reroute.apart(a, b) / cellM).rounded(.up))
                var k = 0.0
                while k < pieces {
                    let x0 = a.x + (b.x - a.x) * k / pieces
                    let y0 = a.y + (b.y - a.y) * k / pieces
                    let x1 = a.x + (b.x - a.x) * (k + 1) / pieces
                    let y1 = a.y + (b.y - a.y) * (k + 1) / pieces
                    var ix = cellOf(JS.min(x0, x1))
                    let ixEnd = cellOf(JS.max(x0, x1))
                    while ix <= ixEnd {
                        var iy = cellOf(JS.min(y0, y1))
                        let iyEnd = cellOf(JS.max(y0, y1))
                        while iy <= iyEnd {
                            let key = Cell(x: ix, y: iy)
                            // A segment's pieces come one after another, so it can only be listed twice at the end.
                            if cells[key] == nil {
                                cells[key] = [i]
                                meter?.gridEntries += 1
                            } else if cells[key]!.last != i {
                                cells[key]!.append(i)
                                meter?.gridEntries += 1
                            }
                            iy += 1
                        }
                        ix += 1
                    }
                    k += 1
                }
            }
        }

        /// The distance from `p` to the line when it is at most the grid's
        /// reach, infinity when it is farther. Stops looking at the first
        /// segment within `enoughM`.
        func distanceWithin(_ p: XY, _ enoughM: Double) -> Double {
            query += 1
            var best = Double.infinity
            func cellOf(_ v: Double) -> Double { (v / cellM).rounded(.down) }
            var ix = cellOf(p.x - cellM)
            let ixEnd = cellOf(p.x + cellM)
            while ix <= ixEnd {
                var iy = cellOf(p.y - cellM)
                let iyEnd = cellOf(p.y + cellM)
                while iy <= iyEnd {
                    for i in cells[Cell(x: ix, y: iy)] ?? [] {
                        if seen[i] == query { continue }
                        seen[i] = query
                        meter?.segmentChecks += 1
                        best = JS.min(best, Geo.pointToSegment(p, line[i - 1], line[i]).distanceM)
                        if best <= enoughM { return best }
                    }
                    iy += 1
                }
                ix += 1
            }
            return best <= cellM ? best : .infinity
        }
    }

    /// A stretch of a line, in meters from its start.
    struct Stretch: Hashable {
        var fromM: Double
        var toM: Double
    }

    /// What stretchesApart found.
    struct Apart {
        let stretches: [Stretch]
        let totalM: Double
        let longestM: Double
        let farthestM: Double
    }

    /// The limits under which a comparison can still be "the same route".
    struct ApartLimits {
        let totalM: Double
        let longestM: Double
        let farthestM: Double
    }

    /// Walks `line` from `fromM` meters after its start to its end in steps
    /// of half the tolerance, and reports the stretches that are farther than
    /// the tolerance from `other`. With `limits`, gives up (nil) as soon as
    /// the stretches apart break one of them.
    static func stretchesApart(_ line: [XY], _ other: SegmentGrid, _ fromM: Double, _ toleranceM: Double, _ limits: ApartLimits? = nil) -> Apart? {
        let stepM = JS.max(1, toleranceM / 2)
        var stretches: [Stretch] = []
        var open: Stretch?
        var closedM = 0.0
        var longestM = 0.0
        var farthestM = 0.0
        /// False when a limit is broken.
        func visit(_ p: XY, _ atM: Double, _ weighsM: Double) -> Bool {
            let distanceM = other.distanceWithin(p, toleranceM)
            if distanceM <= toleranceM {
                if let o = open {
                    stretches.append(o)
                    closedM += o.toM - o.fromM
                }
                open = nil
                return true
            }
            if open == nil { open = Stretch(fromM: atM, toM: atM + weighsM) } else { open!.toM = atM + weighsM }
            let openM = open!.toM - open!.fromM
            longestM = JS.max(longestM, openM)
            farthestM = JS.max(farthestM, distanceM)
            guard let limits else { return true }
            return closedM + openM <= limits.totalM && openM <= limits.longestM && farthestM <= limits.farthestM
        }
        var doneM = 0.0
        var nextM = fromM
        for i in stride(from: 1, to: line.count, by: 1) {
            let a = line[i - 1]
            let b = line[i]
            let lengthM = apart(a, b)
            while lengthM > 0 && doneM + lengthM >= nextM {
                let t = (nextM - doneM) / lengthM
                if !visit(XY(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), nextM, stepM) { return nil }
                nextM += stepM
            }
            doneM += lengthM
        }
        if let last = open {
            stretches.append(last)
            closedM += last.toM - last.fromM
        }
        return Apart(stretches: stretches, totalM: closedM, longestM: longestM, farthestM: farthestM)
    }

    /// `line` from the point `at` (of nearestOnLine) on.
    static func fromNearest(_ line: [XY], _ at: Nearest) -> [XY] {
        let a = line[at.index]
        let b = line[at.index + 1]
        return [XY(a.x + (b.x - a.x) * at.t, a.y + (b.y - a.y) * at.t)] + line[(at.index + 1)...]
    }

    /// What both ways of comparing (compareRest, matchRest) measure first.
    struct SetUp {
        let fresh: [XY]
        let rest: [XY]
        let ignoreM: Double
        let limits: ApartLimits
        let lengthsApartM: Double
        let endsTogether: Bool
        let reachM: Double
        let meter: MatchMeter?

        func grids() -> (ofRest: SegmentGrid, ofFresh: SegmentGrid) {
            (SegmentGrid(rest, reachM: reachM, meter: meter), SegmentGrid(fresh, reachM: reachM, meter: meter))
        }
    }

    /// Nil when either line cannot be driven.
    static func setUp(_ path: [XY], _ given: [XY], _ options: RerouteOptions, _ meter: MatchMeter?) -> SetUp? {
        guard let start = given.first, given.count >= 2, path.count >= 2 else { return nil }
        let at = nearestOnLine(start, path, meter)
        let rest = fromNearest(path, at)
        // A fresh route that starts behind the path is compared from where it
        // reaches the path's start, when it does, but only for a straight approach.
        var fresh = given
        if at.index == 0 && at.t == 0 {
            let back = nearestOnLine(path[0], given, meter)
            let cutM = lengthOf(given[0...back.index]) + back.t * apart(given[back.index], given[back.index + 1])
            if back.distanceM <= options.matchToleranceM && cutM <= apart(start, path[0]) + options.matchToleranceM {
                fresh = fromNearest(given, back)
            }
        }
        let freshM = lengthOf(fresh)
        let restM = lengthOf(rest)
        let shorterM = JS.min(freshM, restM)
        if !(shorterM > 0) { return nil }
        // A line shorter than twice the ignored start is still compared over its second half.
        let ignoreM = JS.min(options.matchIgnoreStartM, shorterM / 2)
        let limits = ApartLimits(
            totalM: (1 - options.matchMinOverlap) * (shorterM - ignoreM),
            longestM: options.matchMaxGapM,
            farthestM: options.matchMaxDivergenceM
        )
        return SetUp(
            fresh: fresh,
            rest: rest,
            ignoreM: ignoreM,
            limits: limits,
            lengthsApartM: abs(freshM - restM),
            endsTogether: apart(fresh[fresh.count - 1], rest[rest.count - 1]) <= options.matchToleranceM,
            reachM: JS.max(options.matchToleranceM, options.matchMaxDivergenceM),
            meter: meter
        )
    }

    /// How a fresh route compares with the rest of a path.
    struct RestComparison {
        let same: Bool
        let differenceM: Double
        let restApart: [Stretch]
        let rest: [XY]
    }

    /// Compares `fresh` with the rest of `path`, measuring everything (see
    /// src/core/reroute.ts compareRest for the rule). Nil when either line
    /// cannot be driven.
    static func compareRest(_ path: [XY], _ fresh: [XY], _ options: RerouteOptions, _ meter: MatchMeter? = nil) -> RestComparison? {
        guard let s = setUp(path, fresh, options, meter) else { return nil }
        let (ofRest, ofFresh) = s.grids()
        let freshApart = stretchesApart(s.fresh, ofRest, s.ignoreM, options.matchToleranceM)!
        let restApart = stretchesApart(s.rest, ofFresh, s.ignoreM, options.matchToleranceM)!
        func within(_ found: Apart) -> Bool {
            found.totalM <= s.limits.totalM && found.longestM <= s.limits.longestM && found.farthestM <= s.limits.farthestM
        }
        let same = s.endsTogether && s.lengthsApartM <= options.matchMaxGapM && within(freshApart) && within(restApart)
        return RestComparison(
            same: same,
            differenceM: freshApart.totalM + restApart.totalM + s.lengthsApartM,
            restApart: restApart.stretches,
            rest: s.rest
        )
    }

    /// compareRest's `differenceM` when `fresh` is the rest of `path`, nil
    /// when it is not. Stops as soon as it is decided (#51).
    static func matchRest(_ path: [XY], _ fresh: [XY], _ options: RerouteOptions, _ meter: MatchMeter? = nil) -> Double? {
        guard let s = setUp(path, fresh, options, meter), s.endsTogether, s.lengthsApartM <= options.matchMaxGapM else { return nil }
        let (ofRest, ofFresh) = s.grids()
        guard let freshApart = stretchesApart(s.fresh, ofRest, s.ignoreM, options.matchToleranceM, s.limits) else { return nil }
        guard let restApart = stretchesApart(s.rest, ofFresh, s.ignoreM, options.matchToleranceM, s.limits) else { return nil }
        return freshApart.totalM + restApart.totalM + s.lengthsApartM
    }

    /// True when `fresh` is the rest of `path`.
    static func continuesPath(_ path: [XY], _ fresh: [XY], _ options: RerouteOptions) -> Bool {
        matchRest(path, fresh, options) != nil
    }

    /// Of `routes`, the position of the one that is the rest of `path`: the
    /// closest when more than one is; of equals, the first. Nil when none is.
    static func closestToPath(
        _ path: [XY],
        _ routes: [RouteCandidate],
        _ project: (LngLat) -> XY,
        _ options: RerouteOptions,
        _ meter: MatchMeter? = nil
    ) -> Int? {
        var best: (index: Int, differenceM: Double)?
        for (i, route) in routes.enumerated() {
            guard let differenceM = matchRest(path, route.geometry.filter(Geo.isValidLngLat).map(project), options, meter) else { continue }
            if best == nil || differenceM < best!.differenceM { best = (i, differenceM) }
        }
        return best?.index
    }

    /// Everything the rules need to know about the lines of one poll, on one flat plane.
    struct Plane {
        let project: (LngLat) -> XY
        /// The current route from the driver's position (less a little slack) on.
        let ahead: [XY]
        let toleranceM: Double
    }

    /// The current route from a little behind the reported position on.
    static func aheadOf(_ geometry: [LngLat], _ positionAlongM: Double, _ slackM: Double) -> [LngLat] {
        Geo.lineFrom(geometry.filter(Geo.isValidLngLat), JS.max(0, positionAlongM - slackM))
    }

    static func planeOf(_ observation: RerouteObservation, _ toleranceM: Double, _ slackM: Double) -> Plane? {
        let ahead = aheadOf(observation.route.geometry, observation.positionAlongM, slackM)
        guard let origin = ahead.first else { return nil }
        let project = Geo.localProjector(origin)
        return Plane(project: project, ahead: ahead.map(project), toleranceM: toleranceM)
    }

    /// Which fresh candidate IS the rest of the route being driven: the like-
    /// for-like baseline. Matched by path only (never by id), by the overlap
    /// rule of compareRest. When more than one matches, the closest. Nil when
    /// none does. `meter`, when given, is counted up with the work done; the
    /// answer is the same with or without it.
    public static func findCurrentRoute(
        _ route: [LngLat],
        positionAlongM: Double,
        candidates: [RouteCandidate],
        options: RerouteOptions = .default,
        meter: MatchMeter? = nil
    ) -> RouteCandidate? {
        let opts = options.resolved()
        let ahead = aheadOf(route, positionAlongM, opts.offRouteM)
        guard let origin = ahead.first else { return nil }
        let project = Geo.localProjector(origin)
        return closestToPath(ahead.map(project), candidates, project, opts, meter).map { candidates[$0] }
    }

    /// When a poll's fresh routes do not include the rest of the route being
    /// driven: the via points along the current path to ask for it with one
    /// more directions request, whose answer goes into
    /// RerouteObservation.baseline. On the stretches no fresh route runs
    /// along, one in the middle of a short stretch and one every
    /// `baselineViaSpacingM` of a long one; at most `baselineMaxViaPoints`,
    /// thinned evenly. Nil when no request is needed or none can be made.
    public static func baselineProbe(
        _ route: [LngLat],
        positionAlongM: Double,
        candidates: [RouteCandidate],
        options: RerouteOptions = .default
    ) -> BaselineProbe? {
        let opts = options.resolved()
        let usable = candidates.filter { $0.geometry.filter(Geo.isValidLngLat).count >= 2 }
        if usable.isEmpty { return nil }
        let aheadLine = aheadOf(route, positionAlongM, opts.offRouteM)
        guard let origin = aheadLine.first else { return nil }
        let project = Geo.localProjector(origin)
        let ahead = aheadLine.map(project)
        if closestToPath(ahead, usable, project, opts) != nil { return nil }

        // Where along the current path (in meters before its end) a via point is wanted.
        var wanted: [Double] = []
        for ranked in Rank.rankRoutes(usable, etaTieWindowSec: opts.etaTieWindowSec) {
            guard let compared = compareRest(ahead, ranked.route.geometry.filter(Geo.isValidLngLat).map(project), opts) else { continue }
            let restM = lengthOf(compared.rest)
            for stretch in compared.restApart {
                let fromM = stretch.fromM
                let toM = stretch.toM
                let count = JS.max(1, ((toM - fromM) / opts.baselineViaSpacingM).rounded(.up))
                var k = 0.0
                while k < count {
                    let beforeEndM = restM - (fromM + (toM - fromM) * (k + 0.5) / count)
                    // One point pins a place, however many fresh routes leave the path there.
                    if !wanted.contains(where: { abs($0 - beforeEndM) < opts.baselineViaSpacingM / 2 }) { wanted.append(beforeEndM) }
                    k += 1
                }
            }
        }
        if wanted.isEmpty { return nil }
        // In driving order; too many: every n-th, so that they stay spread over the whole way.
        wanted = wanted.jsSorted { JS.compare($1, $0) }
        let keep = min(wanted.count, opts.baselineMaxViaPoints)
        let aheadM = Geo.alongRouteM(aheadLine).last ?? 0
        var via: [BaselineViaPoint] = []
        for k in 0..<keep {
            let pick = Int(((Double(k) + 0.5) * Double(wanted.count) / Double(keep)).rounded(.down))
            if let on = Geo.pointAtDistance(aheadLine, aheadM - wanted[pick]) {
                via.append(BaselineViaPoint(point: on.point, bearingDeg: on.bearingDeg))
            }
        }
        return via.isEmpty ? nil : BaselineProbe(via: via)
    }

    struct Split {
        let atM: Double
        let at: LngLat
        let index: Int
    }

    /// Where a candidate leaves the current route ahead of the driver, as meters along the candidate.
    static func divergence(_ line: [LngLat], _ xy: [XY], _ plane: Plane) -> Split? {
        guard let firstOff = xy.firstIndex(where: { !isNear($0, plane.ahead, plane.toleranceM) }) else { return nil }
        let index = max(0, firstOff - 1)
        return Split(atM: Geo.alongRouteM(Array(line[0...index])).last ?? 0, at: line[index], index: index)
    }

    static func isEndpointManeuver(_ m: Maneuver) -> Bool {
        // JavaScript startsWith: by UTF-16 code units, not canonical equivalence.
        m.kind.utf16.starts(with: "depart".utf16) || m.kind.utf16.starts(with: "arrive".utf16)
    }

    /// The candidate's first maneuver that the current route does not also make.
    static func firstOwnManeuver(_ candidate: RouteCandidate, _ current: [Maneuver], _ plane: Plane) -> Maneuver? {
        let shared = current.filter { !isEndpointManeuver($0) }.map { (kind: $0.kind, at: plane.project($0.location)) }
        for m in candidate.maneuvers {
            if isEndpointManeuver(m) || !m.atDistanceM.isFinite || !Geo.isValidLngLat(m.location) { continue }
            let at = plane.project(m.location)
            if !shared.contains(where: { JS.Key($0.kind) == JS.Key(m.kind) && apart($0.at, at) <= plane.toleranceM }) { return m }
        }
        return nil
    }

    static func insideSpan(_ spans: [DistanceSpanM]?, _ atM: Double) -> Bool {
        guard let spans else { return false }
        return spans.contains { atM >= $0.startM - 1 && atM <= $0.endM + 1 }
    }

    /// The share of a candidate's own part (not on the current route) that runs along `other`.
    static func shareAlong(_ xy: [XY], _ fromIndex: Int, _ plane: Plane, _ other: [XY]) -> Double {
        var ownM = 0.0
        var alongOtherM = 0.0
        var previousOwn = false
        for i in stride(from: fromIndex + 1, to: xy.count, by: 1) {
            let own = !isNear(xy[i], plane.ahead, plane.toleranceM)
            if own || previousOwn {
                let lengthM = apart(xy[i - 1], xy[i])
                ownM += lengthM
                if isNear(xy[i - 1], other, plane.toleranceM) && isNear(xy[i], other, plane.toleranceM) { alongOtherM += lengthM }
            }
            previousOwn = own
        }
        return ownM > 0 ? alongOtherM / ownM : 0
    }

    /// One alternative, measured against the current route.
    struct Measured {
        let candidate: RouteCandidate
        let xy: [XY]
        let alternative: RerouteAlternative
        let divergedAtIndex: Int
    }

    /// Where and how soon the driver would have to act to take `candidate`,
    /// and the lead the rules ask for there. Nil when it never leaves the current route.
    static func measure(
        _ candidate: RouteCandidate,
        _ savingSec: Double?,
        _ currentManeuvers: [Maneuver],
        _ currentSpans: [DistanceSpanM]?,
        _ speedMps: Double,
        _ plane: Plane,
        _ options: RerouteOptions,
        _ drivenM: Double
    ) -> Measured? {
        let line = candidate.geometry.filter(Geo.isValidLngLat)
        let xy = line.map(plane.project)
        guard let split = divergence(line, xy, plane) else { return nil }
        // Geometry alone can see the split late: an exit ramp runs within a few
        // meters of the freeway for its first stretch. The maneuver says where the
        // driver really has to act, so the sooner of the two is used.
        let own = firstOwnManeuver(candidate, currentManeuvers, plane)
        let byManeuver = own.map { $0.atDistanceM < split.atM } ?? false
        let askedTurnInM = byManeuver ? JS.max(0, own!.atDistanceM) : split.atM
        // From where the driver is now: the turn-off came nearer while the answer was out.
        let turnInM = JS.max(0, askedTurnInM - drivenM)
        let turnAt = byManeuver ? own!.location : split.at
        // Freeway when the road at the turn-off is controlled-access on the candidate's
        // own record, or else on the current route's. Unknown road class is not freeway.
        let onFreeway = insideSpan(candidate.limitedAccessSpansM ?? currentSpans, askedTurnInM)
        let speed = speedMps.isFinite && speedMps > 0 ? speedMps : 0
        let requiredLeadM = JS.max(JS.max(options.minLeadDistanceM, speed * options.minLeadTimeSec), onFreeway ? options.freewayLeadDistanceM : 0)
        return Measured(
            candidate: candidate,
            xy: xy,
            alternative: RerouteAlternative(
                routeId: candidate.id, savingSec: savingSec, turnInM: turnInM, turnAt: turnAt,
                requiredLeadM: requiredLeadM, onFreeway: onFreeway
            ),
            divergedAtIndex: split.index
        )
    }

    /// The limited-access spans of the route being driven, re-measured from the driver's position.
    static func spansAhead(_ spans: [DistanceSpanM]?, _ positionAlongM: Double) -> [DistanceSpanM]? {
        guard let spans else { return nil }
        return spans
            .filter { $0.endM > positionAlongM }
            .map { DistanceSpanM(JS.max(0, $0.startM - positionAlongM), $0.endM - positionAlongM) }
    }

    static func usableEta(_ route: RouteCandidate) -> Bool {
        route.durationSec.isFinite && route.durationSec >= 0
    }

    /// Decides, after one poll, whether to stay on the route being driven or
    /// to switch to another one. Call it once per poll with the state the last
    /// call returned (`RerouteState.initial` at the start of a drive). On
    /// `.switchRoute` the caller starts driving the candidate `toRouteId` and
    /// from then on reports positions along that route.
    ///
    /// The rules, in order (see src/core/reroute.ts for the full commentary):
    /// 1. Failed poll: stay; only failedPolls changes.
    /// 2. No usable routes: stay.
    /// 3. Off route: take the top-ranked fresh (provider) route at once.
    /// 4. The fresh candidate that IS the rest of the current route (by overlap) is the baseline.
    /// 5. Current route not offered: the answer to the request for the current
    ///    path itself (observation.baseline) is the baseline when it is that
    ///    path. No answer, or another path: stay, count kept. "No route that
    ///    way" `routeLostPolls` times: take the best fresh route that passes
    ///    the too-late guard, after the cooldown.
    /// 6. Missing travel time or traffic data: stay; such alternatives are passed over.
    /// 7. Alternatives are tried in rank order (signals only break ETA ties).
    /// 8. Minimum saving: `minSavingSec` AND `minSavingFraction` of the baseline.
    ///    A probe is compared only with the current path asked through via
    ///    points, never more than its ordinary time ('probe-unconfirmed' without one).
    /// 9. No return: going back to a route left within `noReturnSec` needs
    ///    `returnSavingFactor` times both. A declined route is not offered until its time is up.
    /// 10. Too late: the turn-off, from where the driver is now, must be at least the required lead ahead.
    /// 11. Confirmation: the same winner for `confirmPolls` polls in a row.
    /// 12. Cooldown: no switch within `cooldownSec` of the last one.
    ///
    /// Pure: no clock, no randomness, no I/O. Never traps on odd input.
    public static func decideReroute(_ state: RerouteState, _ observation: RerouteObservation, options: RerouteOptions = .default) -> RerouteDecision {
        let opts = options.resolved()
        let nowSec = observation.nowSec
        func stay(
            _ code: RerouteCode,
            _ reason: String,
            _ nextState: RerouteState,
            _ considered: RerouteAlternative? = nil,
            _ current: RerouteCurrentEta? = nil
        ) -> RerouteDecision {
            RerouteDecision(action: .stay, toRouteId: nil, reason: "Staying: \(reason)", code: code, considered: considered, current: current, nextState: nextState)
        }

        // Rule 1.
        guard let rawCandidates = observation.candidates else {
            var next = state
            next.failedPolls = JS.increment(state.failedPolls)
            let failedPolls = next.failedPolls
            return stay(
                .pollFailed,
                failedPolls == 1 ? "could not check for faster routes" : "could not check for faster routes, \(failedPolls) tries in a row",
                next
            )
        }

        // What every answered poll does to the state, whatever is decided.
        var base = state
        base.failedPolls = 0
        base.abandoned = state.abandoned.filter { nowSec - $0.atSec < opts.noReturnSec }
        base.declined = state.declined.filter { $0.untilSec > nowSec }
        var noWinner = base
        noWinner.pending = nil

        // Rule 2.
        let candidates = rawCandidates.filter { $0.geometry.filter(Geo.isValidLngLat).count >= 2 }
        let maybePlane = planeOf(observation, opts.sameRouteToleranceM, opts.offRouteM)
        guard !candidates.isEmpty, let plane = maybePlane else {
            return stay(.noRoutes, "no routes available right now", noWinner)
        }
        // A route without a travel time ranks last (see Rank) and is never switched to.
        let ranked = Rank.rankRoutes(candidates, etaTieWindowSec: opts.etaTieWindowSec).map(\.route)
        // Side-street probes are compared only with a time for the current path
        // asked the same way (rule 8), and are never the current route, the
        // off-route pick or the route-lost pick.
        func isProbe(_ c: RouteCandidate) -> Bool { c.source == .probe }
        let providedIndices = ranked.indices.filter { !isProbe(ranked[$0]) }
        let provided = providedIndices.map { ranked[$0] }
        let drivenM: Double
        if let d = observation.drivenSinceM, d.isFinite, d > 0 { drivenM = d } else { drivenM = 0 }

        func switchTo(_ code: RerouteCode, _ reason: String, _ to: RouteCandidate, _ considered: RerouteAlternative?) -> RerouteDecision {
            RerouteDecision(
                action: .switchRoute,
                toRouteId: to.id,
                reason: "Switching: \(reason)",
                code: code,
                considered: considered,
                current: nil,
                nextState: RerouteState(
                    pending: nil,
                    lastSwitchAtSec: nowSec,
                    abandoned: base.abandoned + [RerouteState.Abandoned(
                        geometry: Geo.lineFrom(observation.route.geometry, observation.positionAlongM),
                        atSec: nowSec
                    )],
                    failedPolls: 0,
                    lostPolls: 0,
                    declined: base.declined
                )
            )
        }

        // Rule 3. Measured against the whole route, the part already driven included:
        // fresh routes that start on the route but behind the driver are a stale
        // answer, not a driver who left the route.
        let startsAt = plane.project(candidates[0].geometry.filter(Geo.isValidLngLat)[0])
        let offBy: Double
        if let measured = observation.offRouteM, measured.isFinite {
            offBy = measured
        } else {
            offBy = nearestOnLine(startsAt, observation.route.geometry.filter(Geo.isValidLngLat).map(plane.project)).distanceM
        }
        if offBy > opts.offRouteM {
            return switchTo(.offRoute, "off the planned route, taking the fastest route from here", provided.first ?? ranked[0], nil)
        }

        let sinceSwitchSec = base.lastSwitchAtSec.map { nowSec - $0 } ?? .infinity
        let coolingDown = sinceSwitchSec < opts.cooldownSec
        let abandonedLines = base.abandoned.map { (atSec: $0.atSec, xy: $0.geometry.filter(Geo.isValidLngLat).map(plane.project)) }
        /// The route left most recently that this alternative goes back to, if any.
        func returnsTo(_ m: Measured) -> (atSec: Double, xy: [XY])? {
            abandonedLines
                .filter { shareAlong(m.xy, m.divergedAtIndex, plane, $0.xy) >= opts.returnOverlapFraction }
                .jsSorted { JS.compare($1.atSec, $0.atSec) }
                .first
        }
        let declinedLines = base.declined.map { $0.geometry.filter(Geo.isValidLngLat).map(plane.project) }
        /// True when this alternative is a route the driver turned down a moment ago (see declineRoute).
        func wasDeclined(_ m: Measured) -> Bool {
            declinedLines.contains { shareAlong(m.xy, m.divergedAtIndex, plane, $0) >= opts.returnOverlapFraction }
        }
        func tooLate(_ a: RerouteAlternative) -> Bool { a.turnInM < a.requiredLeadM }
        func tooLateReason(_ a: RerouteAlternative, _ what: String) -> String {
            "\(what) turns off in \(spokenDistance(a.turnInM)), too late to take safely"
        }
        func turnPhrase(_ a: RerouteAlternative) -> String { "turn in \(spokenDistance(a.turnInM))" }

        // Rule 4.
        func isCurrent(_ c: RouteCandidate) -> Bool {
            continuesPath(plane.ahead, c.geometry.filter(Geo.isValidLngLat).map(plane.project), opts)
        }
        // Positions in `ranked` stand in for the TypeScript's object identity.
        let offeredIndex = closestToPath(plane.ahead, provided, plane.project, opts).map { providedIndices[$0] }
        // Rule 5: not offered, so the answer to the request for the current path itself, if there is one.
        let baseline = observation.baseline?.filter { $0.geometry.filter(Geo.isValidLngLat).count >= 2 }
        // The current path asked through via points, matched: the baseline's
        // pick whether or not the current route was also offered.
        let askedIndex = baseline.flatMap { closestToPath(plane.ahead, $0, plane.project, opts) }
        let maybeCurrent: RouteCandidate?
        if let offeredIndex {
            maybeCurrent = ranked[offeredIndex]
        } else if let askedIndex, let baseline {
            maybeCurrent = baseline[askedIndex]
        } else {
            maybeCurrent = nil
        }

        guard let current = maybeCurrent else {
            // Only "no route that way" is evidence against the road ahead, and adds to the count.
            // Not asked, or answered with another path: no evidence either way, and the count is
            // kept. Only a poll that finds the current route again starts it over.
            let lostPolls = baseline?.isEmpty == true ? JS.increment(base.lostPolls) : base.lostPolls
            var lost = noWinner
            lost.lostPolls = lostPolls
            guard let baseline, baseline.isEmpty else {
                return stay(
                    .routeUnconfirmed,
                    baseline == nil
                        ? "current route is not among the fresh routes, and its travel time could not be checked"
                        : "current route is not among the fresh routes, and asking for it brought back another road",
                    lost
                )
            }
            if lostPolls < opts.routeLostPolls {
                return stay(.routeUnconfirmed, "the road ahead could not be routed, check \(lostPolls) of \(opts.routeLostPolls)", lost)
            }
            if coolingDown {
                return stay(.cooldown, "switched routes \(spokenDuration(sinceSwitchSec)) ago, and the road ahead can no longer be routed", lost)
            }
            let spans = spansAhead(observation.route.limitedAccessSpansM, observation.positionAlongM)
            var closest: RerouteAlternative?
            for candidate in provided where usableEta(candidate) {
                guard let m = measure(candidate, nil, observation.route.maneuvers, spans, observation.speedMps, plane, opts, drivenM) else { continue }
                if wasDeclined(m) { continue }
                if closest == nil { closest = m.alternative }
                if tooLate(m.alternative) { continue }
                return switchTo(.routeLost, "the road ahead can no longer be routed, \(turnPhrase(m.alternative))", candidate, m.alternative)
            }
            guard let closest else {
                return stay(.routeLost, "the road ahead can no longer be routed, and there is no other route to take", lost)
            }
            return stay(.tooLate, tooLateReason(closest, "the road ahead can no longer be routed, but the other route"), lost, closest)
        }
        var found = base
        found.lostPolls = 0
        var foundNoWinner = found
        foundNoWinner.pending = nil
        // Only a time that may be compared (rule 6) is passed on as the current route's ETA.
        func comparableEta(_ c: RouteCandidate) -> Bool { usableEta(c) && (!opts.requireTypicalDuration || c.typicalDurationSec != nil) }
        let known: RerouteCurrentEta? = comparableEta(current)
            ? RerouteCurrentEta(durationSec: current.durationSec, distanceM: current.distanceM, asked: offeredIndex == nil)
            : nil

        // The current path's time asked through via points, like a probe's. Probes are compared with it and nothing else.
        let viaCurrent: RouteCandidate? = askedIndex.flatMap { i in baseline.flatMap { comparableEta($0[i]) ? $0[i] : nil } }

        // Rule 6.
        let baselineSec = current.durationSec
        if !usableEta(current) { return stay(.noEta, "no travel time for the current route", foundNoWinner, nil, known) }
        if opts.requireTypicalDuration && current.typicalDurationSec == nil {
            return stay(.noTrafficData, "no traffic data for the current route", foundNoWinner, nil, known)
        }
        let others = ranked.indices.filter { $0 != offeredIndex && !isCurrent(ranked[$0]) }.map { ranked[$0] }
        if others.isEmpty { return stay(.noAlternative, "no other route available right now", foundNoWinner, nil, known) }
        let comparable = others.filter(comparableEta)
        if comparable.isEmpty { return stay(.noTrafficData, "no comparable travel time for the other routes", foundNoWinner, nil, known) }

        // Rules 7 to 10: the first alternative, in rank order, that passes them all.
        var firstPassing: Measured?
        var refusal: (code: RerouteCode, reason: String, considered: RerouteAlternative)?
        for candidate in comparable {
            // Like for like: a probed route against the current path asked the same way, through via points.
            guard let against = isProbe(candidate) ? viaCurrent : current else {
                // No such time this check: a side street that looks faster cannot count, not even towards confirmation.
                if candidate.durationSec < baselineSec,
                   let m = measure(candidate, nil, current.maneuvers, current.limitedAccessSpansM, observation.speedMps, plane, opts, drivenM),
                   refusal == nil {
                    refusal = (
                        code: .probeUnconfirmed,
                        reason: "a side street may be faster, but its time could not be compared like for like",
                        considered: m.alternative
                    )
                }
                continue
            }
            // Never more than the current route's ordinary time either: a path check can read high too.
            let fromSec = isProbe(candidate) ? JS.min(against.durationSec, baselineSec) : against.durationSec
            let savingSec = fromSec - candidate.durationSec
            if savingSec <= 0 { continue }
            guard let m = measure(candidate, savingSec, current.maneuvers, current.limitedAccessSpansM, observation.speedMps, plane, opts, drivenM) else { continue }
            let a = m.alternative
            func refuse(_ code: RerouteCode, _ reason: String) {
                if refusal == nil { refusal = (code: code, reason: reason, considered: a) }
            }
            if savingSec < opts.minSavingSec {
                refuse(.savingTooSmall, "faster route saves only \(spokenDuration(savingSec))")
                continue
            }
            if savingSec < opts.minSavingFraction * fromSec {
                refuse(.savingShareTooSmall, "faster route saves only \(spokenDuration(savingSec)) of the remaining \(spokenDuration(fromSec))")
                continue
            }
            if wasDeclined(m) {
                refuse(.driverDeclined, "faster route saves \(spokenDuration(savingSec)), but you chose to keep this route")
                continue
            }
            if let left = returnsTo(m),
               savingSec < opts.returnSavingFactor * opts.minSavingSec
                || savingSec < opts.returnSavingFactor * opts.minSavingFraction * fromSec {
                refuse(
                    .recentlyAbandoned,
                    "faster route is the one we left \(spokenDuration(nowSec - left.atSec)) ago, and it saves only \(spokenDuration(savingSec))"
                )
                continue
            }
            if tooLate(a) {
                refuse(.tooLate, tooLateReason(a, "faster route"))
                continue
            }
            firstPassing = m
            break
        }

        guard let winner = firstPassing else {
            guard let refused = refusal else { return stay(.currentBest, "current route is still the fastest", foundNoWinner, nil, known) }
            return stay(refused.code, refused.reason, foundNoWinner, refused.considered, known)
        }

        // Rule 11.
        let a = winner.alternative
        let saves = "saves \(spokenDuration(a.savingSec ?? 0))"
        let sameAsPending = found.pending.map {
            continuesPath($0.geometry.filter(Geo.isValidLngLat).map(plane.project), winner.xy, opts)
        } ?? false
        let polls = sameAsPending ? JS.increment(found.pending!.polls) : 1
        var confirmed = found
        confirmed.pending = RerouteState.Pending(geometry: winner.candidate.geometry, polls: polls)
        if polls < opts.confirmPolls {
            return stay(.confirming, "faster route \(saves), confirming, check \(polls) of \(opts.confirmPolls)", confirmed, a, known)
        }
        // Rule 12.
        if coolingDown {
            return stay(.cooldown, "faster route \(saves), but we switched routes \(spokenDuration(sinceSwitchSec)) ago", confirmed, a, known)
        }
        return switchTo(.fasterRoute, "\(saves), \(turnPhrase(a))", winner.candidate, a)
    }

    /// The driver said no to a switch ("Keep previous route"): the state to
    /// carry on with, in which `geometryAhead` (the turned-down route, from
    /// the driver on) is not switched to again before `untilSec`. Pass the
    /// state from BEFORE the switch; a confirmation in progress is dropped.
    public static func declineRoute(_ state: RerouteState, _ geometryAhead: [LngLat], untilSec: Double) -> RerouteState {
        var next = state
        next.pending = nil
        // Counting lost polls is a confirmation in progress too: start it again.
        next.lostPolls = 0
        next.declined = state.declined + [RerouteState.Declined(geometry: geometryAhead, untilSec: untilSec)]
        return next
    }
}
