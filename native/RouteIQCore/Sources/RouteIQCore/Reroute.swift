import Foundation

// The switching brain, ported from src/core/reroute.ts: given what a poll just
// returned, should the driver stay on the route being driven or change to
// another one, with no tap.
//
// A pure, deterministic state machine. Time is an input (nowSec), never read
// from a clock; the state is plain data that the caller keeps between polls.

/// Every threshold of the reroute rules, in one place. The initializer's
/// defaults are the values; `RerouteOptions.default` is the documented set.
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
    /// Polls in a row the current route may be missing from the fresh routes before the best fresh route is taken.
    public var routeLostPolls: Int
    /// The driver is off the current route when the fresh routes start farther than this from its line, in meters.
    public var offRouteM: Double
    /// How far apart two lines may run and still be the same road, in meters.
    public var sameRouteToleranceM: Double
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
        func pollsOr(_ v: Int, _ fallback: Int) -> Int { max(1, v >= 0 ? v : fallback) }
        return RerouteOptions(
            minSavingSec: numberOr(minSavingSec, d.minSavingSec),
            minSavingFraction: numberOr(minSavingFraction, d.minSavingFraction),
            confirmPolls: pollsOr(confirmPolls, d.confirmPolls),
            cooldownSec: numberOr(cooldownSec, d.cooldownSec),
            noReturnSec: numberOr(noReturnSec, d.noReturnSec),
            returnSavingFactor: max(1, numberOr(returnSavingFactor, d.returnSavingFactor)),
            minLeadDistanceM: numberOr(minLeadDistanceM, d.minLeadDistanceM),
            minLeadTimeSec: numberOr(minLeadTimeSec, d.minLeadTimeSec),
            freewayLeadDistanceM: numberOr(freewayLeadDistanceM, d.freewayLeadDistanceM),
            routeLostPolls: pollsOr(routeLostPolls, d.routeLostPolls),
            offRouteM: numberOr(offRouteM, d.offRouteM),
            sameRouteToleranceM: numberOr(sameRouteToleranceM, d.sameRouteToleranceM),
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

    /// The alternative that won the last poll and how many polls in a row it
    /// has won, remembered by its path (ids change from poll to poll).
    public var pending: Pending?
    /// When the last switch was made (the nowSec of that poll). Nil before the first.
    public var lastSwitchAtSec: Double?
    /// The routes left by a switch, each as the path that was still ahead then. Old entries are dropped.
    public var abandoned: [Abandoned]
    /// Polls in a row that failed (no answer).
    public var failedPolls: Int
    /// Polls in a row in which no fresh route was the rest of the current one.
    public var lostPolls: Int

    public init(pending: Pending? = nil, lastSwitchAtSec: Double? = nil, abandoned: [Abandoned] = [], failedPolls: Int = 0, lostPolls: Int = 0) {
        self.pending = pending
        self.lastSwitchAtSec = lastSwitchAtSec
        self.abandoned = abandoned
        self.failedPolls = failedPolls
        self.lostPolls = lostPolls
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

    public init(nowSec: Double, route: DrivenRoute, positionAlongM: Double, speedMps: Double, candidates: [RouteCandidate]?, offRouteM: Double? = nil) {
        self.nowSec = nowSec
        self.route = route
        self.positionAlongM = positionAlongM
        self.speedMps = speedMps
        self.candidates = candidates
        self.offRouteM = offRouteM
    }
}

/// Why a decision came out as it did, for logs and tests.
public enum RerouteCode: String, Hashable, Sendable, CaseIterable {
    case pollFailed = "poll-failed"
    case noRoutes = "no-routes"
    case offRoute = "off-route"
    case routeLostWaiting = "route-lost-waiting"
    case routeLost = "route-lost"
    case noEta = "no-eta"
    case noTrafficData = "no-traffic-data"
    case noAlternative = "no-alternative"
    case currentBest = "current-best"
    case savingTooSmall = "saving-too-small"
    case savingShareTooSmall = "saving-share-too-small"
    case recentlyAbandoned = "recently-abandoned"
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

public struct RerouteDecision: Hashable, Sendable {
    public var action: RerouteAction
    /// With `.switchRoute`: the id of the candidate (of this poll) to drive from now on.
    public var toRouteId: String?
    /// One short plain-English sentence, fit to be spoken aloud.
    public var reason: String
    public var code: RerouteCode
    /// Nil when the decision was not about one particular alternative.
    public var considered: RerouteAlternative?
    /// Pass this back with the next observation.
    public var nextState: RerouteState
}

/// The reroute engine. See `decideReroute` for the rules.
public enum Reroute {
    /// "40 seconds", "1.9 minutes", "3 minutes". Rounded down, so a saving is never overstated.
    static func spokenDuration(_ sec: Double) -> String {
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
    static func spokenDistance(_ meters: Double) -> String {
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
    static func nearestOnLine(_ p: XY, _ line: [XY]) -> Nearest {
        if line.count == 1 { return Nearest(distanceM: hypot(p.x - line[0].x, p.y - line[0].y), index: 0, t: 0) }
        var best = Nearest(distanceM: .infinity, index: 0, t: 0)
        for i in stride(from: 1, to: line.count, by: 1) {
            let hit = Geo.pointToSegment(p, line[i - 1], line[i])
            if hit.distanceM < best.distanceM { best = Nearest(distanceM: hit.distanceM, index: i - 1, t: hit.t) }
        }
        return best
    }

    static func isNear(_ p: XY, _ line: [XY], _ toleranceM: Double) -> Bool {
        for i in stride(from: 1, to: line.count, by: 1) where Geo.pointToSegment(p, line[i - 1], line[i]).distanceM <= toleranceM {
            return true
        }
        return false
    }

    static func apart(_ p: XY, _ q: XY) -> Double { hypot(p.x - q.x, p.y - q.y) }

    /// True when `fresh` is the rest of `path`: it starts on `path` (anywhere
    /// along it), and from there to the end the two follow the same roads.
    static func continuesPath(_ path: [XY], _ fresh: [XY], _ toleranceM: Double) -> Bool {
        guard fresh.count >= 2, path.count >= 2, let start = fresh.first, let end = fresh.last, let pathEnd = path.last else { return false }
        if apart(end, pathEnd) > toleranceM { return false }
        let at = nearestOnLine(start, path)
        if at.distanceM > toleranceM { return false }
        let a = path[at.index]
        let b = path[at.index + 1]
        let joined = XY(a.x + (b.x - a.x) * at.t, a.y + (b.y - a.y) * at.t)
        let rest = [joined] + path[(at.index + 1)...]
        return fresh.allSatisfy { isNear($0, rest, toleranceM) } && rest.allSatisfy { isNear($0, fresh, toleranceM) }
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
        Geo.lineFrom(geometry.filter(Geo.isValidLngLat), max(0, positionAlongM - slackM))
    }

    static func planeOf(_ observation: RerouteObservation, _ toleranceM: Double, _ slackM: Double) -> Plane? {
        let ahead = aheadOf(observation.route.geometry, observation.positionAlongM, slackM)
        guard let origin = ahead.first else { return nil }
        let project = Geo.localProjector(origin)
        return Plane(project: project, ahead: ahead.map(project), toleranceM: toleranceM)
    }

    /// Which fresh candidate IS the rest of the route being driven, matched by
    /// path only (never by id). The first in the given order when several
    /// match. Nil when none does.
    public static func findCurrentRoute(
        _ route: [LngLat],
        positionAlongM: Double,
        candidates: [RouteCandidate],
        toleranceM: Double = Select.sameRouteToleranceM
    ) -> RouteCandidate? {
        let ahead = aheadOf(route, positionAlongM, RerouteOptions.default.offRouteM)
        guard let origin = ahead.first else { return nil }
        let project = Geo.localProjector(origin)
        let path = ahead.map(project)
        return candidates.first { continuesPath(path, $0.geometry.filter(Geo.isValidLngLat).map(project), toleranceM) }
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
        m.kind.hasPrefix("depart") || m.kind.hasPrefix("arrive")
    }

    /// The candidate's first maneuver that the current route does not also make.
    static func firstOwnManeuver(_ candidate: RouteCandidate, _ current: [Maneuver], _ plane: Plane) -> Maneuver? {
        let shared = current.filter { !isEndpointManeuver($0) }.map { (kind: $0.kind, at: plane.project($0.location)) }
        for m in candidate.maneuvers {
            if isEndpointManeuver(m) || !m.atDistanceM.isFinite || !Geo.isValidLngLat(m.location) { continue }
            let at = plane.project(m.location)
            if !shared.contains(where: { $0.kind == m.kind && apart($0.at, at) <= plane.toleranceM }) { return m }
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
        _ options: RerouteOptions
    ) -> Measured? {
        let line = candidate.geometry.filter(Geo.isValidLngLat)
        let xy = line.map(plane.project)
        guard let split = divergence(line, xy, plane) else { return nil }
        // Geometry alone can see the split late: an exit ramp runs within a few
        // meters of the freeway for its first stretch. The maneuver says where the
        // driver really has to act, so the sooner of the two is used.
        let own = firstOwnManeuver(candidate, currentManeuvers, plane)
        let byManeuver = own.map { $0.atDistanceM < split.atM } ?? false
        let turnInM = byManeuver ? max(0, own!.atDistanceM) : split.atM
        let turnAt = byManeuver ? own!.location : split.at
        // Freeway when the road at the turn-off is controlled-access on the candidate's
        // own record, or else on the current route's. Unknown road class is not freeway.
        let onFreeway = insideSpan(candidate.limitedAccessSpansM ?? currentSpans, turnInM)
        let speed = speedMps.isFinite && speedMps > 0 ? speedMps : 0
        let requiredLeadM = max(options.minLeadDistanceM, speed * options.minLeadTimeSec, onFreeway ? options.freewayLeadDistanceM : 0)
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
    /// 3. Off route: take the top-ranked fresh route at once.
    /// 4. The fresh candidate that IS the rest of the current route is the baseline.
    /// 5. Current route not offered: wait `routeLostPolls` polls, then take the
    ///    best fresh route that passes the too-late guard, after the cooldown.
    /// 6. Missing travel time or traffic data: stay; such alternatives are passed over.
    /// 7. Alternatives are tried in rank order (signals only break ETA ties).
    /// 8. Minimum saving: `minSavingSec` AND `minSavingFraction` of the baseline.
    /// 9. No return: going back to a route left within `noReturnSec` needs `returnSavingFactor` times both.
    /// 10. Too late: the turn-off must be at least the required lead ahead.
    /// 11. Confirmation: the same winner for `confirmPolls` polls in a row.
    /// 12. Cooldown: no switch within `cooldownSec` of the last one.
    ///
    /// Pure: no clock, no randomness, no I/O. Never traps on odd input.
    public static func decideReroute(_ state: RerouteState, _ observation: RerouteObservation, options: RerouteOptions = .default) -> RerouteDecision {
        let opts = options.resolved()
        let nowSec = observation.nowSec
        func stay(_ code: RerouteCode, _ reason: String, _ nextState: RerouteState, _ considered: RerouteAlternative? = nil) -> RerouteDecision {
            RerouteDecision(action: .stay, toRouteId: nil, reason: "Staying: \(reason)", code: code, considered: considered, nextState: nextState)
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

        func switchTo(_ code: RerouteCode, _ reason: String, _ to: RouteCandidate, _ considered: RerouteAlternative?) -> RerouteDecision {
            RerouteDecision(
                action: .switchRoute,
                toRouteId: to.id,
                reason: "Switching: \(reason)",
                code: code,
                considered: considered,
                nextState: RerouteState(
                    pending: nil,
                    lastSwitchAtSec: nowSec,
                    abandoned: base.abandoned + [RerouteState.Abandoned(
                        geometry: Geo.lineFrom(observation.route.geometry, observation.positionAlongM),
                        atSec: nowSec
                    )],
                    failedPolls: 0,
                    lostPolls: 0
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
            return switchTo(.offRoute, "off the planned route, taking the fastest route from here", ranked[0], nil)
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
        func tooLate(_ a: RerouteAlternative) -> Bool { a.turnInM < a.requiredLeadM }
        func tooLateReason(_ a: RerouteAlternative, _ what: String) -> String {
            "\(what) turns off in \(spokenDistance(a.turnInM)), too late to take safely"
        }
        func turnPhrase(_ a: RerouteAlternative) -> String { "turn in \(spokenDistance(a.turnInM))" }

        // Rule 4.
        func isCurrent(_ c: RouteCandidate) -> Bool {
            continuesPath(plane.ahead, c.geometry.filter(Geo.isValidLngLat).map(plane.project), opts.sameRouteToleranceM)
        }
        let foundIndex = ranked.firstIndex(where: isCurrent)

        // Rule 5.
        guard let currentIndex = foundIndex else {
            var lost = noWinner
            lost.lostPolls = JS.increment(base.lostPolls)
            let lostPolls = lost.lostPolls
            if lostPolls < opts.routeLostPolls {
                return stay(.routeLostWaiting, "current route is missing from the fresh routes, check \(lostPolls) of \(opts.routeLostPolls)", lost)
            }
            if coolingDown {
                return stay(.cooldown, "switched routes \(spokenDuration(sinceSwitchSec)) ago, and the current route is no longer offered", lost)
            }
            let spans = spansAhead(observation.route.limitedAccessSpansM, observation.positionAlongM)
            var firstMeasured: RerouteAlternative?
            for candidate in ranked where usableEta(candidate) {
                guard let m = measure(candidate, nil, observation.route.maneuvers, spans, observation.speedMps, plane, opts) else { continue }
                if firstMeasured == nil { firstMeasured = m.alternative }
                if tooLate(m.alternative) { continue }
                return switchTo(.routeLost, "current route is no longer offered, \(turnPhrase(m.alternative))", candidate, m.alternative)
            }
            guard let closest = firstMeasured else {
                return stay(.routeLost, "current route is no longer offered, and there is no other route to take", lost)
            }
            return stay(.tooLate, tooLateReason(closest, "current route is no longer offered, but the other route"), lost, closest)
        }
        let current = ranked[currentIndex]
        var found = base
        found.lostPolls = 0
        var foundNoWinner = found
        foundNoWinner.pending = nil

        // Rule 6.
        let baselineSec = current.durationSec
        if !usableEta(current) { return stay(.noEta, "no travel time for the current route", foundNoWinner) }
        if opts.requireTypicalDuration && current.typicalDurationSec == nil {
            return stay(.noTrafficData, "no traffic data for the current route", foundNoWinner)
        }
        let others = ranked.indices.filter { $0 != currentIndex && !isCurrent(ranked[$0]) }.map { ranked[$0] }
        if others.isEmpty { return stay(.noAlternative, "no other route available right now", foundNoWinner) }
        let comparable = others.filter { usableEta($0) && (!opts.requireTypicalDuration || $0.typicalDurationSec != nil) }
        if comparable.isEmpty { return stay(.noTrafficData, "no comparable travel time for the other routes", foundNoWinner) }

        // Rules 7 to 10: the first alternative, in rank order, that passes them all.
        var firstPassing: Measured?
        var refusal: (code: RerouteCode, reason: String, considered: RerouteAlternative)?
        for candidate in comparable {
            let savingSec = baselineSec - candidate.durationSec
            if savingSec <= 0 { continue }
            guard let m = measure(candidate, savingSec, current.maneuvers, current.limitedAccessSpansM, observation.speedMps, plane, opts) else { continue }
            let a = m.alternative
            func refuse(_ code: RerouteCode, _ reason: String) {
                if refusal == nil { refusal = (code: code, reason: reason, considered: a) }
            }
            if savingSec < opts.minSavingSec {
                refuse(.savingTooSmall, "faster route saves only \(spokenDuration(savingSec))")
                continue
            }
            if savingSec < opts.minSavingFraction * baselineSec {
                refuse(.savingShareTooSmall, "faster route saves only \(spokenDuration(savingSec)) of the remaining \(spokenDuration(baselineSec))")
                continue
            }
            if let left = returnsTo(m),
               savingSec < opts.returnSavingFactor * opts.minSavingSec
                || savingSec < opts.returnSavingFactor * opts.minSavingFraction * baselineSec {
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
            guard let refused = refusal else { return stay(.currentBest, "current route is still the fastest", foundNoWinner) }
            return stay(refused.code, refused.reason, foundNoWinner, refused.considered)
        }

        // Rule 11.
        let a = winner.alternative
        let saves = "saves \(spokenDuration(a.savingSec ?? 0))"
        let sameAsPending = found.pending.map {
            continuesPath($0.geometry.filter(Geo.isValidLngLat).map(plane.project), winner.xy, opts.sameRouteToleranceM)
        } ?? false
        let polls = sameAsPending ? JS.increment(found.pending!.polls) : 1
        var confirmed = found
        confirmed.pending = RerouteState.Pending(geometry: winner.candidate.geometry, polls: polls)
        if polls < opts.confirmPolls {
            return stay(.confirming, "faster route \(saves), confirming, check \(polls) of \(opts.confirmPolls)", confirmed, a)
        }
        // Rule 12.
        if coolingDown {
            return stay(.cooldown, "faster route \(saves), but we switched routes \(spokenDuration(sinceSwitchSec)) ago", confirmed, a)
        }
        return switchTo(.fasterRoute, "\(saves), \(turnPhrase(a))", winner.candidate, a)
    }
}
