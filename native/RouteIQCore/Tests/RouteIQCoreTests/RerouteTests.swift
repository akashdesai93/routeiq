import Foundation
import XCTest
import RouteIQCore

// Mirrors tests/reroute.test.ts, assertion for assertion, except the describe
// "line helpers the engine and the simulated drive share" (in GeoTests.swift) and
// "side streets found by probes during a drive", which needs probe.ts (ported with Probe.swift).
// Scripted drives through the reroute engine on a fake clock and a made-up road
// network (see DriveWorld.swift). No network, no timers; every position is invented.

/// Helpers that escaping closures (eta, tamper) can call without capturing the test case.
private enum RerouteFx {
    typealias RouteName = DriveWorld.RouteName
    typealias PollContext = DriveWorld.PollContext

    /// The TS `fixed(etas)`: ETAs by route name; a name left out is not offered.
    static func fixed(_ etas: KeyValuePairs<RouteName, Double>) -> (RouteName, PollContext) -> Double? {
        { name, _ in etas.first(where: { $0.key == name })?.value }
    }

    /// The TS `signals(signalCount, signalCoverage = 'full')`, as a patch.
    static func signals(_ signalCount: Int, _ signalCoverage: SignalCoverage = .full) -> DriveWorld.Patch {
        { route in
            route.signalCount = signalCount
            route.signalCoverage = signalCoverage
        }
    }

    /// `{ signalCount: null, signalCoverage: 'none' }`.
    static let noSignals: DriveWorld.Patch = { route in
        route.signalCount = nil
        route.signalCoverage = SignalCoverage.none
    }

    /// A small seeded generator (mulberry32), so the "random" drives are the same on every run.
    static func seeded(_ seed: UInt32) -> () -> Double {
        var a = seed
        return {
            a = a &+ 0x6D2B_79F5
            var t = a
            t = (t ^ (t >> 15)) &* (t | 1)
            t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
            return Double(t ^ (t >> 14)) / 4_294_967_296
        }
    }

    /// The JS `/^(Staying|Switching): \S/`.
    static func hasReasonShape(_ reason: String) -> Bool {
        for prefix in ["Staying: ", "Switching: "] where reason.hasPrefix(prefix) {
            guard let next = reason.dropFirst(prefix.count).first else { return false }
            return !next.isWhitespace
        }
        return false
    }
}

final class RerouteTests: XCTestCase {
    private typealias RouteName = DriveWorld.RouteName
    private typealias DriveScript = DriveWorld.DriveScript
    private typealias DriveLog = DriveWorld.DriveLog
    private typealias PollRecord = DriveWorld.PollRecord
    private typealias Switch = DriveWorld.Switch
    private typealias Patch = DriveWorld.Patch

    // MARK: - Helpers (as in the TS file)

    private func at(_ xM: Double, _ yM: Double) -> LngLat { DriveWorld.at(xM, yM) }

    private func candidate(_ name: RouteName, _ from: LngLat, _ durationSec: Double, _ extra: Patch? = nil) -> RouteCandidate? {
        DriveWorld.candidate(name, from, durationSec, extra)
    }

    private func drive(_ script: DriveScript) -> DriveLog { DriveWorld.drive(script) }

    private func nameOf(_ route: RouteCandidate) -> RouteName { DriveWorld.nameOf(route) }

    /// The route name in a candidate id, the TS `nameOf({ id })`; nil when there is no id.
    private func idName(_ id: String?) -> String? {
        guard let id else { return nil }
        return id.split(separator: "-", omittingEmptySubsequences: false).first.map { String($0) }
    }

    /// The poll at index `i`, failing (not trapping) when the drive was shorter.
    private func pollAt(_ log: DriveLog, _ i: Int) throws -> PollRecord {
        let found: PollRecord? = log.polls.indices.contains(i) ? log.polls[i] : nil
        return try XCTUnwrap(found, "the drive has no poll \(i)")
    }

    /// The JS `Array.prototype.slice(start, end)`, clamped, never trapping.
    private func slice<T>(_ array: [T], _ start: Int, _ end: Int? = nil) -> [T] {
        let from = min(max(start, 0), array.count)
        let to = min(max(end ?? array.count, from), array.count)
        return Array(array[from..<to])
    }

    /// One poll while driving the main road A, `xM` meters along it. `etas` in
    /// the TS key order; `extra` changes the candidate of a route, by name.
    private func pollOnA(
        xM: Double,
        etas: KeyValuePairs<RouteName, Double>,
        speedMps: Double = 5,
        nowSec: Double = 0,
        state: RerouteState = .initial,
        options: RerouteOptions = .default,
        extra: [RouteName: Patch] = [:],
        baseline: KeyValuePairs<RouteName, Double>? = nil
    ) -> RerouteDecision {
        let here = at(xM, 0)
        func made(_ etas: KeyValuePairs<RouteName, Double>) -> [RouteCandidate] {
            etas.compactMap { entry in candidate(entry.key, here, entry.value, extra[entry.key]) }
        }
        let candidates = made(etas)
        let routeGeometry = candidate(.A, at(0, 0), 2000)?.geometry ?? []
        return Reroute.decideReroute(
            state,
            RerouteObservation(
                nowSec: nowSec,
                route: DrivenRoute(geometry: routeGeometry, maneuvers: [], limitedAccessSpansM: nil),
                positionAlongM: xM,
                speedMps: speedMps,
                candidates: candidates,
                baseline: baseline.map(made)
            ),
            options: options
        )
    }

    /// Switch on the first winning poll, for tests that are about one rule only.
    private let noConfirm = RerouteOptions(confirmPolls: 1)

    // MARK: - describe('reroute thresholds')

    // it('has one documented set of defaults')
    func testRerouteThresholds_hasOneDocumentedSetOfDefaults() {
        let d = RerouteOptions.default
        XCTAssertEqual(d.minSavingSec, 120)
        XCTAssertEqual(d.minSavingFraction, 0.05)
        XCTAssertEqual(d.confirmPolls, 2)
        XCTAssertEqual(d.cooldownSec, 300)
        XCTAssertEqual(d.noReturnSec, 600)
        XCTAssertEqual(d.returnSavingFactor, 2)
        XCTAssertEqual(d.minLeadDistanceM, 400)
        XCTAssertEqual(d.minLeadTimeSec, 20)
        XCTAssertEqual(d.freewayLeadDistanceM, 1200)
        XCTAssertEqual(d.routeLostPolls, 3)
        XCTAssertEqual(d.offRouteM, 50)
        XCTAssertEqual(d.sameRouteToleranceM, 10)
        XCTAssertEqual(d.matchToleranceM, 20)
        XCTAssertEqual(d.matchMinOverlap, 0.95)
        XCTAssertEqual(d.matchMaxGapM, 400)
        XCTAssertEqual(d.matchMaxDivergenceM, 50)
        XCTAssertEqual(d.matchIgnoreStartM, 150)
        XCTAssertEqual(d.baselineViaSpacingM, 3000)
        XCTAssertEqual(d.baselineMaxViaPoints, 6)
        XCTAssertEqual(d.returnOverlapFraction, 0.5)
        XCTAssertEqual(d.requireTypicalDuration, true)
        XCTAssertEqual(d.etaTieWindowSec, 30)
        // The default-argument call is the same set.
        XCTAssertEqual(RerouteOptions(), d)
    }

    // it('falls back to the default for a threshold that is negative or not a number')
    func testRerouteThresholds_fallsBackToTheDefaultForAThresholdThatIsNegativeOrNotANumber() {
        let odd = RerouteOptions(minSavingSec: .nan, confirmPolls: 0, minLeadDistanceM: -1)
        // 150 s saved clears the default 120 s; confirmPolls 0 is read as 1.
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 2000, .B: 1850], options: odd).action, .switchRoute)
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 2000, .B: 1890], options: odd).code, .savingTooSmall)
        XCTAssertEqual(pollOnA(xM: 4700, etas: [.A: 2000, .B: 1850], options: odd).code, .tooLate)
    }

    // MARK: - describe('findCurrentRoute: which fresh candidate is the rest of the current route')

    // it('matches by path, never by id, from wherever the driver is')
    func testFindCurrentRoute_matchesByPathNeverByIdFromWhereverTheDriverIs() throws {
        let driven = try XCTUnwrap(candidate(.B, at(0, 0), 2000))
        let here = at(3000, 0)
        let fresh = [
            try XCTUnwrap(candidate(.A, here, 1500)),
            try XCTUnwrap(candidate(.B, here, 1600)),
            try XCTUnwrap(candidate(.C, here, 1700)),
        ]
        XCTAssertFalse(fresh.map(\.id).contains(driven.id))
        XCTAssertEqual(idName(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: fresh)?.id), "B")
        // The same id on another road proves nothing.
        var impostor = fresh[0]
        impostor.id = driven.id
        XCTAssertNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [impostor, fresh[2]]))
    }

    // it('tolerates the few meters a provider moves points between polls, and fewer or more vertices')
    func testFindCurrentRoute_toleratesTheFewMetersAProviderMovesPointsBetweenPollsAndFewerOrMoreVertices() throws {
        let driven = try XCTUnwrap(candidate(.B, at(0, 0), 2000))
        let fresh = try XCTUnwrap(candidate(.B, at(3000, 0), 1600))
        let nudged = fresh.geometry.enumerated().map { i, p in LngLat(p.lng, p.lat + (i % 2 == 0 ? 3.0 : -3.0) / 111_195) }
        let count = fresh.geometry.count
        let thinned = fresh.geometry.enumerated().filter { i, _ in i % 2 == 0 || i == count - 1 }.map { $0.element }
        var withNudged = fresh
        withNudged.geometry = nudged
        var withThinned = fresh
        withThinned.geometry = thinned
        XCTAssertNotNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [withNudged]))
        XCTAssertNotNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [withThinned]))
        // The next street over is not the same route.
        var shifted = fresh
        shifted.geometry = fresh.geometry.map { p in LngLat(p.lng, p.lat + 30 / 111_195) }
        XCTAssertNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [shifted]))
        // Nor is a route that stops short of the destination.
        var short = fresh
        short.geometry = Array(fresh.geometry.dropLast(4))
        XCTAssertNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [short]))
        XCTAssertNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: []))
    }

    // MARK: - describe('the same route, drawn differently (patterns measured on real answers)')

    // The shapes below are the ones measured on real answers (README, "Why the matching is by
    // overlap"), redrawn by hand on the made-up plane. Every position is invented.
    private typealias Corner = (x: Double, y: Double)

    private func line(_ corners: [Corner]) -> [LngLat] { corners.map { at($0.x, $0.y) } }

    /// A fresh route along the corners, as a provider would return it.
    private func fresh(_ corners: [Corner], _ durationSec: Double = 1500) throws -> RouteCandidate {
        var c = try XCTUnwrap(candidate(.A, at(0, 0), durationSec))
        c.id = "fresh-\(corners.count)-\(JS.string(durationSec))"
        c.geometry = line(corners)
        c.distanceM = Geo.alongRouteM(c.geometry).last ?? 0
        c.maneuvers = []
        return c
    }

    /// The main road A, straight east, being driven; the car is 3 km along it.
    private func onA() throws -> RouteCandidate { try XCTUnwrap(candidate(.A, at(0, 0), 2000)) }
    private let here3km = 3000.0

    private func isCurrent(_ corners: [Corner]) throws -> Bool {
        Reroute.findCurrentRoute(try onA().geometry, positionAlongM: here3km, candidates: [try fresh(corners)]) != nil
    }

    /// North one 125 m block at xM (or `sideM` to the side), east `blocks` blocks, and back down to the main road.
    private func around(_ xM: Double, _ blocks: Double, _ sideM: Double = 125) -> [Corner] {
        [(xM, 0), (xM, sideM), (xM + 125 * blocks, sideM), (xM + 125 * blocks, 0)]
    }

    private var oneBlock: [Corner] { [(here3km, 0)] + around(10000, 1) + [(20000, 0)] }

    private func poll(_ route: RouteCandidate, _ positionAlongM: Double, _ speedMps: Double, _ candidates: [RouteCandidate], nowSec: Double = 0, state: RerouteState = .initial) -> RerouteDecision {
        Reroute.decideReroute(state, RerouteObservation(nowSec: nowSec, route: DrivenRoute(route), positionAlongM: positionAlongM, speedMps: speedMps, candidates: candidates))
    }

    // it('different vertex density: a bend drawn with 4 points or with 46 is the same road')
    func testDrawnDifferently_differentVertexDensityABendDrawnWith4PointsOrWith46IsTheSameRoad() throws {
        // East for 2 km, a quarter circle of 300 m radius to the north, then north.
        func bend(_ stepDeg: Double) -> [Corner] {
            var arc: [Corner] = []
            var deg = -90.0
            while deg <= 0 {
                arc.append((2000 + 300 * cos(deg * Double.pi / 180), 300 + 300 * sin(deg * Double.pi / 180)))
                deg += stepDeg
            }
            return arc + [(2300, 5000)]
        }
        let driven = line([(0, 0)] + bend(2))
        // The coarse drawing cuts 10.2 m inside the fine one at each chord: more than the old 10 m, vertex by vertex.
        let coarse = try fresh([(500, 0)] + bend(30))
        XCTAssertEqual(Reroute.findCurrentRoute(driven, positionAlongM: 500, candidates: [coarse]), coarse)
        // And the other way round: driving the coarse drawing, offered the fine one.
        let fine = try fresh([(500, 0)] + bend(2))
        XCTAssertEqual(Reroute.findCurrentRoute(line([(0, 0)] + bend(30)), positionAlongM: 500, candidates: [fine]), fine)
    }

    // it('a different first 150 m: snapped to the parallel street, joining a block later')
    func testDrawnDifferently_aDifferentFirst150mSnappedToTheParallelStreetJoiningABlockLater() throws {
        XCTAssertTrue(try isCurrent([(here3km, 40), (3120, 40), (3140, 0), (20000, 0)]))
        // The same beginning that never joins is another road.
        XCTAssertFalse(try isCurrent([(here3km, 40), (19980, 40), (20000, 0)]))
    }

    // it('a divided road: the other drawing of the carriageway, 14 m to the side for 6 km')
    func testDrawnDifferently_aDividedRoadTheOtherDrawingOfTheCarriageway14mToTheSideFor6km() throws {
        XCTAssertTrue(try isCurrent([(here3km, 0), (6000, 0), (6010, 14), (11990, 14), (12000, 0), (20000, 0)]))
    }

    // it('one corner cut 14 m inside the old one')
    func testDrawnDifferently_oneCornerCut14mInsideTheOldOne() throws {
        let onB = try XCTUnwrap(candidate(.B, at(0, 0), 2000))
        // B turns north at 5 km; the fresh drawing starts the turn 20 m early.
        let cut = try fresh([(here3km, 0), (4980, 0), (5000, 20), (5000, 1000), (15000, 1000), (15000, 0), (20000, 0)])
        XCTAssertEqual(Reroute.findCurrentRoute(onB.geometry, positionAlongM: here3km, candidates: [cut]), cut)
    }

    // it('the other lane group at a freeway exit: three short stretches up to 39 m apart')
    func testDrawnDifferently_theOtherLaneGroupAtAFreewayExitThreeShortStretchesUpTo39mApart() throws {
        let exit: [Corner] = [
            (here3km, 0), (9000, 0), (9030, 22), (9270, 22), (9300, 0), (9420, 0), (9440, 39), (9580, 39), (9600, 0),
            (9750, 0), (9770, 38), (9910, 38), (9930, 0), (20000, 0),
        ]
        XCTAssertTrue(try isCurrent(exit))
        // It is the current route for the ETA, and never an alternative to it, whatever time it claims.
        let decision = poll(try onA(), here3km, 20, [try fresh(exit, 1400), try XCTUnwrap(candidate(.A, at(here3km, 0), 2000))])
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .noAlternative)
        XCTAssertEqual(decision.current?.durationSec, 2000)
        XCTAssertEqual(decision.current?.asked, false)
        // Offered alone, its time is the current route's time.
        let alone = poll(try onA(), here3km, 20, [try fresh(exit, 1400)])
        XCTAssertEqual(alone.action, .stay)
        XCTAssertEqual(alone.code, .noAlternative)
        XCTAssertEqual(alone.current?.durationSec, 1400)
    }

    // it('a genuinely different route that shares four fifths is still a different route')
    func testDrawnDifferently_aGenuinelyDifferentRouteThatSharesFourFifthsIsStillADifferentRoute() throws {
        // 17 km to go; for 4 km of them it runs on the next road, 300 m north.
        let detour: [Corner] = [(here3km, 0), (10000, 0), (10000, 300), (14000, 300), (14000, 0), (20000, 0)]
        XCTAssertFalse(try isCurrent(detour))
        // Even a frontage road 30 m to the side, for the same 4 km.
        XCTAssertFalse(try isCurrent([(here3km, 0), (10000, 0), (10010, 30), (13990, 30), (14000, 0), (20000, 0)]))
        // And a 700 m detour that would fit inside the 5% allowance of a long route: one stretch apart is too long.
        XCTAssertFalse(try isCurrent([(here3km, 0), (10000, 0), (10000, 100), (10500, 100), (10500, 0), (20000, 0)]))
        // A route that overshoots and comes back along the same road is never apart, but it is longer.
        XCTAssertFalse(try isCurrent([(here3km, 0), (10000, 0), (10000, 15), (9000, 15), (9000, 0), (20000, 0)]))
        // So it is weighed as an alternative: five minutes faster than the current route, it starts a confirmation.
        let decision = poll(try onA(), here3km, 20, [try XCTUnwrap(candidate(.A, at(here3km, 0), 2000)), try fresh(detour, 1700)])
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .confirming)
        let considered = try XCTUnwrap(decision.considered)
        XCTAssertEqual(considered.savingSec, 300)
        XCTAssertEqual(considered.turnInM, 7000, accuracy: 50)
    }

    // Where the overlap rule's loose side ends (#41): no point of a stretch apart may run farther
    // than matchMaxDivergenceM (50 m) from the other line.
    // it('one block around is another route, on a long trip too (#41)')
    func testDrawnDifferently_oneBlockAroundIsAnotherRouteOnALongTripToo() throws {
        // 17 km to go, about 340 m of the fresh line apart: inside the length and share limits, 125 m to the side.
        XCTAssertFalse(try isCurrent(oneBlock))
        // The divergence cap, either side of 50 m: 300 m of road 45 m to the side is still a drawing of
        // the same road; 60 m is the next street.
        XCTAssertTrue(try isCurrent([(here3km, 0)] + around(10000, 2.4, 45) + [(20000, 0)]))
        XCTAssertFalse(try isCurrent([(here3km, 0)] + around(10000, 2.4, 60) + [(20000, 0)]))
        XCTAssertNotNil(Reroute.findCurrentRoute(
            try onA().geometry, positionAlongM: here3km,
            candidates: [try fresh([(here3km, 0)] + around(10000, 2.4, 60) + [(20000, 0)])],
            options: RerouteOptions(matchMaxDivergenceM: 70)
        ))
        // Two blocks, or one with 5 km to go, were already another route.
        XCTAssertFalse(try isCurrent([(here3km, 0)] + around(10000, 2) + [(20000, 0)]))
        XCTAssertNil(Reroute.findCurrentRoute(try onA().geometry, positionAlongM: 15000, candidates: [try fresh([(15000, 0)] + around(17000, 1) + [(20000, 0)])]))
        // So it is weighed as an alternative like any other: five minutes faster, it starts a confirmation.
        let both = poll(try onA(), here3km, 20, [try fresh(oneBlock, 1700), try XCTUnwrap(candidate(.A, at(here3km, 0), 2000))])
        XCTAssertEqual(both.action, .stay)
        XCTAssertEqual(both.code, .confirming)
        XCTAssertEqual(both.considered?.savingSec, 300)
    }

    // it('a closed block ahead: the provider routes round it, the block itself is asked for, and three "no route" answers take the detour (#41)')
    func testDrawnDifferently_aClosedBlockAheadTheBlockItselfIsAskedForAndThreeNoRouteAnswersTakeTheDetour() throws {
        // Every check, the provider's only answer goes round the block at 10 km; the main road is closed there.
        var state = RerouteState.initial
        var decisions: [RerouteDecision] = []
        let route = try onA()
        for p in 0..<3 {
            let x = here3km + 600 * Double(p)
            let detour = try fresh([(x, 0)] + around(10000, 1) + [(20000, 0)], 1700)
            // Not the current route any more, so its time is asked for, with one via point: on the closed block itself.
            let probe = try XCTUnwrap(Reroute.baselineProbe(route.geometry, positionAlongM: x, candidates: [detour]))
            XCTAssertEqual(probe.via.count, 1)
            let viaX = Geo.alongRouteM([at(0, 0), try XCTUnwrap(probe.via.first).point])[1]
            XCTAssertGreaterThan(viaX, 10000)
            XCTAssertLessThan(viaX, 10125)
            // The provider finds no route through it.
            let decision = Reroute.decideReroute(state, RerouteObservation(
                nowSec: 60 * Double(p), route: DrivenRoute(route), positionAlongM: x, speedMps: 10, candidates: [detour], baseline: []
            ))
            decisions.append(decision)
            state = decision.nextState
        }
        XCTAssertEqual(decisions.map(\.code), [.routeUnconfirmed, .routeUnconfirmed, .routeLost])
        XCTAssertEqual(decisions[2].action, .switchRoute)
        XCTAssertEqual(decisions[2].toRouteId, try fresh(oneBlock, 1700).id)
        XCTAssertTrue(decisions[2].reason.hasPrefix("Switching: the road ahead can no longer be routed, turn in "), decisions[2].reason)
    }

    // it('a confirmation carries on when the same alternative comes back drawn a little differently')
    func testDrawnDifferently_aConfirmationCarriesOnWhenTheSameAlternativeComesBackDrawnALittleDifferently() throws {
        let route = try onA()
        let first = poll(route, 1000, 15, [try XCTUnwrap(candidate(.A, at(1000, 0), 2000)), try XCTUnwrap(candidate(.B, at(1000, 0), 1700))])
        XCTAssertEqual(first.action, .stay)
        XCTAssertEqual(first.code, .confirming)
        // B again a minute later, its corner at 5 km cut 14 m inside: still the route being confirmed.
        let redrawn = try fresh([(1900, 0), (4980, 0), (5000, 20), (5000, 1000), (15000, 1000), (15000, 0), (20000, 0)], 1650)
        let second = poll(route, 1900, 15, [try XCTUnwrap(candidate(.A, at(1900, 0), 1950)), redrawn], nowSec: 60, state: first.nextState)
        XCTAssertEqual(second.action, .switchRoute)
        XCTAssertEqual(second.code, .fasterRoute)
        XCTAssertEqual(second.toRouteId, redrawn.id)
        // Another road in its place starts the count again.
        let other = poll(route, 1900, 15, [try XCTUnwrap(candidate(.A, at(1900, 0), 1950)), try XCTUnwrap(candidate(.C, at(1900, 0), 1650))], nowSec: 60, state: first.nextState)
        XCTAssertEqual(other.action, .stay)
        XCTAssertEqual(other.code, .confirming)
        XCTAssertEqual(other.nextState.pending?.polls, 1)
    }

    // it('route gone from the answers while the driver is on the road: stays; gone and off the road: a new route at once')
    func testDrawnDifferently_routeGoneFromTheAnswersWhileOnTheRoadStaysGoneAndOffTheRoadANewRouteAtOnce() throws {
        let others = [try XCTUnwrap(candidate(.B, at(here3km, 0), 1500)), try XCTUnwrap(candidate(.C, at(here3km, 0), 1600))]
        var observation = RerouteObservation(nowSec: 0, route: DrivenRoute(try onA()), positionAlongM: here3km, speedMps: 15, candidates: others)
        var state = RerouteState.initial
        for p in 0..<10 {
            observation.nowSec = Double(p) * 60
            let decision = Reroute.decideReroute(state, observation)
            XCTAssertEqual(decision.action, .stay)
            XCTAssertEqual(decision.code, .routeUnconfirmed)
            state = decision.nextState
        }
        // The tracker says the car has left the route: that, not the list of routes, is the reason to change.
        observation.nowSec = 600
        observation.offRouteM = 80
        let off = Reroute.decideReroute(state, observation)
        XCTAssertEqual(off.action, .switchRoute)
        XCTAssertEqual(off.code, .offRoute)
        XCTAssertEqual(off.toRouteId, others[0].id)
    }

    // MARK: - describe('baselineProbe: how to ask for the current route when it is not offered')

    /// Where along the main road each via point is, to the nearest 100 m (the stretches are found in 10 m steps).
    private func xOf(_ via: [BaselineViaPoint]) -> [Double] {
        via.map { (Geo.alongRouteM([at(0, 0), $0.point])[1] / 100).rounded() * 100 }
    }

    // it('asks nothing when the current route is among the fresh routes, or there are none')
    func testBaselineProbe_asksNothingWhenTheCurrentRouteIsAmongTheFreshRoutesOrThereAreNone() throws {
        let here = at(3000, 0)
        XCTAssertNil(Reroute.baselineProbe(try onA().geometry, positionAlongM: 3000, candidates: [try XCTUnwrap(candidate(.A, here, 1500)), try XCTUnwrap(candidate(.B, here, 1400))]))
        XCTAssertNil(Reroute.baselineProbe(try onA().geometry, positionAlongM: 3000, candidates: []))
    }

    // it('puts via points on the stretches the fresh routes leave, with the heading of travel')
    func testBaselineProbe_putsViaPointsOnTheStretchesTheFreshRoutesLeaveWithTheHeadingOfTravel() throws {
        let here = at(3000, 0)
        // B leaves the main road between 5 and 15 km, C between 8 and 12 km: one set of points pins both.
        let probe = try XCTUnwrap(Reroute.baselineProbe(try onA().geometry, positionAlongM: 3000, candidates: [try XCTUnwrap(candidate(.B, here, 1400)), try XCTUnwrap(candidate(.C, here, 1450))]))
        XCTAssertEqual(xOf(probe.via), [6300, 8800, 11300, 13700])
        for v in probe.via {
            XCTAssertEqual(v.bearingDeg, 90, accuracy: 0.5)
            // On the main road itself.
            XCTAssertLessThan(abs(v.point.lat - at(0, 0).lat) * 111_195, 1)
        }
        // A short loop near the end gets a point of its own.
        let withE = try XCTUnwrap(Reroute.baselineProbe(try onA().geometry, positionAlongM: 3000, candidates: [try XCTUnwrap(candidate(.B, here, 1400)), try XCTUnwrap(candidate(.E, here, 1450))]))
        XCTAssertEqual(xOf(withE.via), [6300, 8800, 11300, 13700, 19000])
    }

    // it('never more than the cap, spread over the way')
    func testBaselineProbe_neverMoreThanTheCapSpreadOverTheWay() throws {
        let here = at(3000, 0)
        let probe = try XCTUnwrap(Reroute.baselineProbe(
            try onA().geometry, positionAlongM: 3000,
            candidates: [try XCTUnwrap(candidate(.B, here, 1400)), try XCTUnwrap(candidate(.E, here, 1450))],
            options: RerouteOptions(baselineMaxViaPoints: 2)
        ))
        XCTAssertEqual(xOf(probe.via), [8800, 13700])
    }

    // MARK: - describe('scripted drives')

    // it('oscillating ETAs: A and B trade places every poll, and nothing ever switches')
    func testScriptedDrives_oscillatingEtasAAndBTradePlacesEveryPollAndNothingEverSwitches() throws {
        let log = drive(DriveScript(polls: 14, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return context.poll % 2 == 0 ? 1800 : 2200
            default: return nil
            }
        }))
        XCTAssertEqual(log.polls.count, 14)
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(log.codes, (0..<14).map { $0 % 2 == 0 ? "confirming" : "current-best" })
        XCTAssertEqual(try pollAt(log, 0).decision.reason, "Staying: faster route saves 3.3 minutes, confirming, check 1 of 2")
        XCTAssertEqual(try pollAt(log, 1).decision.reason, "Staying: current route is still the fastest")
    }

    // it('oscillating winners: a different alternative wins each poll, and nothing ever switches')
    func testScriptedDrives_oscillatingWinnersADifferentAlternativeWinsEachPollAndNothingEverSwitches() {
        let log = drive(DriveScript(polls: 14, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return context.poll % 2 == 0 ? 1700 : 1950
            case .C: return context.poll % 2 == 0 ? 1950 : 1700
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(Set(log.codes), ["confirming"])
        XCTAssertTrue(log.polls.allSatisfy { $0.decision.nextState.pending?.polls == 1 })
    }

    // it('a steady 3 minute gain: exactly one switch, on the second poll that confirms it')
    func testScriptedDrives_aSteady3MinuteGainExactlyOneSwitchOnTheSecondPollThatConfirmsIt() throws {
        let log = drive(DriveScript(polls: 20, eta: RerouteFx.fixed([.A: 2000, .B: 1820, .C: 2100])))
        XCTAssertEqual(log.switches, [Switch(nowSec: 60, from: .A, to: .B)])
        XCTAssertEqual(slice(log.codes, 0, 2), ["confirming", "faster-route"])
        XCTAssertEqual(try pollAt(log, 0).decision.reason, "Staying: faster route saves 3 minutes, confirming, check 1 of 2")
        // 4.7 km before the turn-off, in words to speak.
        let switched = try pollAt(log, 1).decision
        XCTAssertEqual(switched.reason, "Switching: saves 3 minutes, turn in 2.9 miles")
        let considered = try XCTUnwrap(switched.considered)
        // toMatchObject({ savingSec: 180, requiredLeadM: 400, onFreeway: false })
        XCTAssertEqual(considered.savingSec, 180)
        XCTAssertEqual(considered.requiredLeadM, 400)
        XCTAssertEqual(considered.onFreeway, false)
        XCTAssertEqual(considered.turnInM, 4700, accuracy: 0.5)
        XCTAssertEqual(considered.turnAt.lng, at(5000, 0).lng, accuracy: 0.5e-6)
        // From then on the old route is the slower alternative, and once B is alone on its own road there is none.
        XCTAssertEqual(Set(slice(log.codes, 2)), ["current-best", "no-alternative"])
    }

    // it('needs as many confirming polls as confirmPolls says')
    func testScriptedDrives_needsAsManyConfirmingPollsAsConfirmPollsSays() {
        let steady = DriveScript(polls: 8, eta: RerouteFx.fixed([.A: 2000, .B: 1820]))
        var once = steady
        once.options = RerouteOptions(confirmPolls: 1)
        var four = steady
        four.options = RerouteOptions(confirmPolls: 4)
        XCTAssertEqual(drive(once).switches.map(\.nowSec), [0])
        XCTAssertEqual(drive(four).switches.map(\.nowSec), [180])
    }

    // it('a gain that appears inside the lead distance is refused, and then the turn-off is behind')
    func testScriptedDrives_aGainThatAppearsInsideTheLeadDistanceIsRefusedAndThenTheTurnOffIsBehind() throws {
        let log = drive(DriveScript(startAlongM: 4000, polls: 8, eta: { name, context in
            // The gain shows up at the fourth poll, 100 m before the turn-off.
            switch name {
            case .A: return 2000
            case .B: return context.poll >= 3 ? 1700 : 2050
            case .C: return 2100
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(log.codes, [
            "current-best", "current-best", "current-best", "too-late",
            "current-best", "current-best", "current-best", "current-best",
        ])
        let refused = try pollAt(log, 3).decision
        XCTAssertEqual(refused.reason, "Staying: faster route turns off in 300 feet, too late to take safely")
        let considered = try XCTUnwrap(refused.considered)
        XCTAssertEqual(considered.turnInM, 100, accuracy: 0.5)
        XCTAssertEqual(considered.requiredLeadM, 400)
        // Past 5 km only C is still ahead.
        XCTAssertNil(try pollAt(log, 4).decision.nextState.pending)
    }

    // it('a confirmed gain is still refused when the second poll comes too close to the turn-off')
    func testScriptedDrives_aConfirmedGainIsStillRefusedWhenTheSecondPollComesTooCloseToTheTurnOff() {
        let log = drive(DriveScript(startAlongM: 4050, polls: 5, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return context.poll >= 1 ? 1700 : 2050
            default: return nil
            }
        }))
        // 650 m ahead: confirming. 350 m and 50 m ahead: too late. Then B is behind and nothing is left.
        XCTAssertEqual(log.codes, ["current-best", "confirming", "too-late", "too-late", "no-alternative"])
        XCTAssertEqual(log.switches, [])
    }

    // it('cooldown: a second, better route has to wait five minutes after a switch')
    func testScriptedDrives_cooldownASecondBetterRouteHasToWaitFiveMinutesAfterASwitch() throws {
        let log = drive(DriveScript(polls: 10, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return 1820
            case .D: return context.poll >= 2 ? 1500 : nil
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [
            Switch(nowSec: 60, from: .A, to: .B),
            Switch(nowSec: 360, from: .B, to: .D),
        ])
        XCTAssertEqual(log.codes, [
            "confirming", "faster-route", "confirming", "cooldown", "cooldown",
            "cooldown", "faster-route", "current-best", "current-best", "current-best",
        ])
        XCTAssertEqual(try pollAt(log, 3).decision.reason, "Staying: faster route saves 5.3 minutes, but we switched routes 2 minutes ago")
    }

    // it('no return: the route just left needs twice the saving, until ten minutes have passed')
    func testScriptedDrives_noReturnTheRouteJustLeftNeedsTwiceTheSavingUntilTenMinutesHavePassed() throws {
        let log = drive(DriveScript(polls: 14, eta: { name, context in
            // After the switch to B, A comes back 150 s faster: enough for a new route, not for a return.
            switch name {
            case .B: return 1820
            case .A: return context.poll >= 2 ? 1670 : 2000
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [
            Switch(nowSec: 60, from: .A, to: .B),
            Switch(nowSec: 720, from: .B, to: .A),
        ])
        // Refused from 120 s to 600 s, the cooldown having ended long before; free again at 660 s.
        XCTAssertEqual(slice(log.codes, 2, 11), Array(repeating: "recently-abandoned", count: 9))
        XCTAssertEqual(slice(log.codes, 11, 13), ["confirming", "faster-route"])
        XCTAssertEqual(
            try pollAt(log, 2).decision.reason,
            "Staying: faster route is the one we left 60 seconds ago, and it saves only 2.5 minutes"
        )
        XCTAssertEqual(try pollAt(log, 11).stateBefore.abandoned.count, 1)
        XCTAssertEqual(try pollAt(log, 11).decision.nextState.abandoned.count, 0)
    }

    // it('no return: twice the saving does bring the old route back, after the cooldown')
    func testScriptedDrives_noReturnTwiceTheSavingDoesBringTheOldRouteBackAfterTheCooldown() {
        let log = drive(DriveScript(polls: 9, eta: { name, context in
            switch name {
            case .B: return 1820
            case .A: return context.poll >= 2 ? 1500 : 2000
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [
            Switch(nowSec: 60, from: .A, to: .B),
            Switch(nowSec: 360, from: .B, to: .A),
        ])
        XCTAssertEqual(slice(log.codes, 2, 7), ["confirming", "cooldown", "cooldown", "cooldown", "faster-route"])
    }

    // it('a third route that is not the one left is not held to the return rule')
    func testScriptedDrives_aThirdRouteThatIsNotTheOneLeftIsNotHeldToTheReturnRule() {
        // On B after the switch; C (off the main road farther on) is not offered from B, D is.
        let log = drive(DriveScript(polls: 9, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return 1820
            case .D: return context.poll >= 2 ? 1690 : nil
            default: return nil
            }
        }, options: RerouteOptions(cooldownSec: 0)))
        // 130 s saved: under the doubled minimum, over the plain one.
        XCTAssertEqual(log.switches.map(\.to), [.B, .D])
    }

    // it('no alternatives: stays, every poll')
    func testScriptedDrives_noAlternativesStaysEveryPoll() throws {
        let log = drive(DriveScript(polls: 10, eta: RerouteFx.fixed([.A: 2000])))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(Set(log.codes), ["no-alternative"])
        XCTAssertEqual(try pollAt(log, 0).decision.reason, "Staying: no other route available right now")
    }

    // it('an empty answer: stays')
    func testScriptedDrives_anEmptyAnswerStays() {
        let log = drive(DriveScript(polls: 4, eta: RerouteFx.fixed([.A: 2000, .B: 1500]), tamper: { _, _ in [] }))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(Set(log.codes), ["no-routes"])
    }

    // it('failed polls change nothing but a counter, and a confirmation in progress survives them')
    func testScriptedDrives_failedPollsChangeNothingButACounterAndAConfirmationInProgressSurvivesThem() throws {
        let log = drive(DriveScript(
            polls: 8,
            eta: RerouteFx.fixed([.A: 2000, .B: 1820]),
            tamper: { candidates, context in context.poll >= 1 && context.poll <= 5 ? nil : candidates }
        ))
        XCTAssertEqual(log.codes, [
            "confirming", "poll-failed", "poll-failed", "poll-failed",
            "poll-failed", "poll-failed", "faster-route", "current-best",
        ])
        let afterFirst = try pollAt(log, 0).decision.nextState
        XCTAssertEqual(afterFirst.pending?.polls, 1)
        for failed in 1...5 {
            var expected = afterFirst
            expected.failedPolls = failed
            XCTAssertEqual(try pollAt(log, failed).decision.nextState, expected, "poll \(failed)")
            XCTAssertEqual(try pollAt(log, failed).decision.action, .stay, "poll \(failed)")
        }
        XCTAssertEqual(try pollAt(log, 1).decision.reason, "Staying: could not check for faster routes")
        XCTAssertEqual(try pollAt(log, 3).decision.reason, "Staying: could not check for faster routes, 3 tries in a row")
        XCTAssertEqual(log.switches, [Switch(nowSec: 360, from: .A, to: .B)])
        XCTAssertEqual(try pollAt(log, 6).decision.nextState.failedPolls, 0)
    }

    // The old rule here was "missing from the fresh routes three polls in a row: take the best
    // fresh route". On real drives that fired with nothing wrong, so a route that is merely not
    // offered is no longer a reason to switch: the next four tests replace it.
    // it('current route not among the candidates and nothing else known: stays on it, however long')
    func testScriptedDrives_currentRouteNotAmongTheCandidatesAndNothingElseKnownStaysOnItHoweverLong() throws {
        let log = drive(DriveScript(
            polls: 12,
            eta: RerouteFx.fixed([.A: 2000, .B: 1900, .C: 1950]),
            tamper: { candidates, context in
                context.poll >= 1 ? candidates.filter { DriveWorld.nameOf($0) != .A } : candidates
            }
        ))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(log.codes, ["saving-too-small"] + Array(repeating: "route-unconfirmed", count: 11))
        XCTAssertEqual(
            try pollAt(log, 1).decision.reason,
            "Staying: current route is not among the fresh routes, and its travel time could not be checked"
        )
        // Not being offered is not evidence against the road ahead: nothing counts up.
        XCTAssertEqual(log.polls.map { $0.decision.nextState.lostPolls }, Array(repeating: 0, count: 12))
        XCTAssertNil(try pollAt(log, 5).decision.current)
    }

    // it('current route not among the candidates: its own travel time is asked for, and the usual rules decide')
    func testScriptedDrives_currentRouteNotAmongTheCandidatesItsOwnTravelTimeIsAskedForAndTheUsualRulesDecide() throws {
        // The provider only offers B and C. Asked for the main road itself it says 2000 s, and from the fourth poll 2300 s.
        let log = drive(DriveScript(
            polls: 6,
            eta: RerouteFx.fixed([.B: 1900, .C: 1950]),
            baseline: { _, context in
                // A missing candidate would read as "no route that way": fail loudly instead, as the TS `!` does.
                [DriveWorld.candidate(.A, context.position, context.poll >= 3 ? 2300 : 2000)!]
            }
        ))
        XCTAssertEqual(log.codes, ["saving-too-small", "saving-too-small", "saving-too-small", "confirming", "faster-route", "current-best"])
        let first = try XCTUnwrap(pollAt(log, 0).decision.current)
        XCTAssertEqual(first.durationSec, 2000)
        XCTAssertTrue(first.asked)
        XCTAssertEqual(try pollAt(log, 0).decision.reason, "Staying: faster route saves only 1.6 minutes")
        // A real saving, measured like for like, confirmed over two polls: an ordinary switch.
        XCTAssertEqual(try pollAt(log, 4).decision.reason, "Switching: saves 6.6 minutes, turn in 2.3 miles")
        XCTAssertEqual(try XCTUnwrap(pollAt(log, 4).decision.considered).savingSec, 400)
        XCTAssertEqual(log.switches, [Switch(nowSec: 240, from: .A, to: .B)])
        XCTAssertTrue(log.polls.allSatisfy { $0.decision.nextState.lostPolls == 0 })
    }

    // it('asked for the road ahead three times and no route found that way: takes the best fresh route, and says why')
    func testScriptedDrives_askedForTheRoadAheadThreeTimesAndNoRouteFoundThatWayTakesTheBestFreshRouteAndSaysWhy() throws {
        let log = drive(DriveScript(
            polls: 6,
            eta: RerouteFx.fixed([.A: 2000, .B: 1900, .C: 1950]),
            tamper: { candidates, context in
                context.poll >= 1 ? candidates.filter { DriveWorld.nameOf($0) != .A } : candidates
            },
            // Asked for the main road itself, the provider finds no route along it.
            baseline: { _, context in context.poll >= 1 ? [] : nil }
        ))
        XCTAssertEqual(slice(log.codes, 0, 4), ["saving-too-small", "route-unconfirmed", "route-unconfirmed", "route-lost"])
        XCTAssertEqual(try pollAt(log, 1).decision.reason, "Staying: the road ahead could not be routed, check 1 of 3")
        XCTAssertEqual(try pollAt(log, 3).decision.reason, "Switching: the road ahead can no longer be routed, turn in 2.5 miles")
        XCTAssertNil(try XCTUnwrap(pollAt(log, 3).decision.considered).savingSec)
        XCTAssertEqual(log.switches, [Switch(nowSec: 180, from: .A, to: .B)])
    }

    // it('the road ahead cannot be routed: the route left a moment ago may be the one to take')
    func testScriptedDrives_theRoadAheadCannotBeRoutedTheRouteLeftAMomentAgoMayBeTheOneToTake() throws {
        // On B since the switch at 60 s. Then the provider stops offering B, puts A first, and
        // finds no route when asked for B itself.
        let log = drive(DriveScript(
            polls: 9,
            eta: { name, context in
                switch name {
                case .A: return context.poll >= 2 ? 1700 : 2000
                case .B: return 1820
                case .C: return 1900
                default: return nil
                }
            },
            tamper: { candidates, context in
                context.poll >= 2 ? candidates.filter { DriveWorld.nameOf($0) != .B } : candidates
            },
            baseline: { _, context in context.poll >= 2 ? [] : nil }
        ))
        XCTAssertEqual(slice(log.codes, 0, 8), [
            "confirming",
            "faster-route",
            "route-unconfirmed",
            "route-unconfirmed",
            // Three such answers, but the cooldown (until 360 s) still holds.
            "cooldown",
            "cooldown",
            "route-lost",
            "current-best",
        ])
        XCTAssertEqual(log.switches, [
            Switch(nowSec: 60, from: .A, to: .B),
            Switch(nowSec: 360, from: .B, to: .A),
        ])
        XCTAssertEqual(
            try pollAt(log, 4).decision.reason,
            "Staying: switched routes 3 minutes ago, and the road ahead can no longer be routed"
        )
    }

    // it('forgives a position reported a little further on than where the routes were fetched from')
    func testScriptedDrives_forgivesAPositionReportedALittleFurtherOnThanWhereTheRoutesWereFetchedFrom() throws {
        let route = try XCTUnwrap(candidate(.A, at(0, 0), 2000))
        let fetchedFrom = at(3000, 0)
        func poll(_ positionAlongM: Double) throws -> RerouteDecision {
            Reroute.decideReroute(
                .initial,
                RerouteObservation(
                    nowSec: 0,
                    route: DrivenRoute(route),
                    positionAlongM: positionAlongM,
                    speedMps: 15,
                    candidates: [try XCTUnwrap(candidate(.A, fetchedFrom, 1700)), try XCTUnwrap(candidate(.B, fetchedFrom, 1800))]
                )
            )
        }
        XCTAssertEqual(try poll(3000).code, .currentBest)
        // 40 m on (a second or two of driving): still the same route.
        XCTAssertEqual(try poll(3040).code, .currentBest)
        // 300 m on, the answer is stale. Routes that start a little behind the car are still the
        // same routes, compared like for like.
        let stale = try poll(3300)
        XCTAssertEqual(stale.action, .stay)
        XCTAssertEqual(stale.code, .currentBest)
        // Only a straight approach from behind is left out of the comparison: a route that first
        // drives a kilometer the other way and turns back is not the current route (#41 review).
        func uTurn(_ yM: Double) throws -> RouteCandidate {
            var c = try XCTUnwrap(candidate(.A, fetchedFrom, 1700))
            c.geometry = [at(2900, 0), at(1900, 0), at(1900, yM), at(20000, yM)]
            c.id = "u-turn-\(yM)"
            c.distanceM = Geo.alongRouteM(c.geometry).last ?? 0
            c.maneuvers = []
            return c
        }
        XCTAssertNil(Reroute.findCurrentRoute(route.geometry, positionAlongM: 3000, candidates: [try uTurn(15)]))
        XCTAssertNil(Reroute.findCurrentRoute(route.geometry, positionAlongM: 3000, candidates: [try uTurn(0.1)]))
    }

    // it('the road ahead not routed for one poll only: the count starts again')
    func testScriptedDrives_theRoadAheadNotRoutedForOnePollOnlyTheCountStartsAgain() {
        let log = drive(DriveScript(
            polls: 8,
            eta: RerouteFx.fixed([.A: 2000, .B: 1900]),
            tamper: { candidates, context in
                context.poll % 3 == 1 ? candidates.filter { DriveWorld.nameOf($0) != .A } : candidates
            },
            baseline: { _, context in context.poll % 3 == 1 ? [] : nil }
        ))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(log.codes, [
            "saving-too-small", "route-unconfirmed", "saving-too-small", "saving-too-small",
            "route-unconfirmed", "saving-too-small", "saving-too-small", "route-unconfirmed",
        ])
        XCTAssertEqual(log.polls.map { $0.decision.nextState.lostPolls }, [0, 1, 0, 0, 1, 0, 0, 1])
    }

    // it('"no route" answers add up even with "another road" answers between them; finding the current route starts over (#41)')
    func testScriptedDrives_noRouteAnswersAddUpEvenWithAnotherRoadAnswersBetweenThemFindingTheCurrentRouteStartsOver() {
        // A closure between via points: some checks the points miss it and the provider routes round it
        // through them (another road), some checks a point lands on it (no route).
        func lostAt(_ poll: Int) -> Bool { poll % 2 == 0 }
        let log = drive(DriveScript(
            polls: 5,
            eta: RerouteFx.fixed([.A: 2000, .B: 1900]),
            tamper: { candidates, _ in candidates.filter { DriveWorld.nameOf($0) != .A } },
            baseline: { candidates, context in lostAt(context.poll) ? [] : candidates.filter { DriveWorld.nameOf($0) == .B } }
        ))
        XCTAssertEqual(log.polls.map { $0.decision.nextState.lostPolls }, [1, 1, 2, 2, 0])
        XCTAssertEqual(log.codes, ["route-unconfirmed", "route-unconfirmed", "route-unconfirmed", "route-unconfirmed", "route-lost"])
        XCTAssertEqual(log.switches.count, 1)
        // The current route offered again between them: the count starts over, and nothing switches.
        let found = drive(DriveScript(
            polls: 5,
            eta: RerouteFx.fixed([.A: 2000, .B: 1900]),
            tamper: { candidates, context in context.poll == 3 ? candidates : candidates.filter { DriveWorld.nameOf($0) != .A } },
            baseline: { candidates, context in
                context.poll == 3 ? nil : lostAt(context.poll) ? [] : candidates.filter { DriveWorld.nameOf($0) == .B }
            }
        ))
        XCTAssertEqual(found.polls.map { $0.decision.nextState.lostPolls }, [1, 1, 2, 0, 1])
        XCTAssertEqual(found.switches, [])
    }

    // it('a poll that could not ask for the current path neither adds to the count nor clears it')
    func testScriptedDrives_aPollThatCouldNotAskForTheCurrentPathNeitherAddsToTheCountNorClearsIt() {
        let state = RerouteState(lostPolls: 2)
        let notAsked = pollOnA(xM: 1000, etas: [.B: 1500], state: state)
        XCTAssertEqual(notAsked.action, .stay)
        XCTAssertEqual(notAsked.code, .routeUnconfirmed)
        XCTAssertEqual(notAsked.nextState.lostPolls, 2)
        // "No route through these points" is the answer that counts: the third in a row.
        let third = pollOnA(xM: 1000, etas: [.B: 1500], state: state, baseline: [:])
        XCTAssertEqual(third.action, .switchRoute)
        XCTAssertEqual(third.code, .routeLost)
        // Answered with another road (the via points did not pin the path): no evidence either way,
        // and the count is kept (#41).
        let otherRoad = pollOnA(xM: 1000, etas: [.B: 1500], state: state, baseline: [.B: 1500])
        XCTAssertEqual(otherRoad.action, .stay)
        XCTAssertEqual(otherRoad.code, .routeUnconfirmed)
        XCTAssertEqual(otherRoad.reason, "Staying: current route is not among the fresh routes, and asking for it brought back another road")
        XCTAssertEqual(otherRoad.nextState.lostPolls, 2)
        // An answer that is the current path but has no typical duration is not compared, and is not shown as its ETA.
        let noTraffic = pollOnA(xM: 1000, etas: [.B: 1500], extra: [.A: { $0.typicalDurationSec = nil }], baseline: [.A: 2400])
        XCTAssertEqual(noTraffic.action, .stay)
        XCTAssertEqual(noTraffic.code, .noTrafficData)
        XCTAssertNil(noTraffic.current)
    }

    // it('the road ahead cannot be routed and the only other route turns off too soon: stays')
    func testScriptedDrives_theRoadAheadCannotBeRoutedAndTheOnlyOtherRouteTurnsOffTooSoonStays() {
        let lost = pollOnA(xM: 4700, etas: [.B: 1500], options: RerouteOptions(routeLostPolls: 1), baseline: [:])
        XCTAssertEqual(lost.action, .stay)
        XCTAssertEqual(lost.code, .tooLate)
        XCTAssertEqual(
            lost.reason,
            "Staying: the road ahead can no longer be routed, but the other route turns off in 0.1 miles, too late to take safely"
        )
        // Inside the cooldown it waits as well.
        var cooledState = RerouteState.initial
        cooledState.lastSwitchAtSec = 0
        let cooling = pollOnA(xM: 1000, etas: [.B: 1500], nowSec: 100, state: cooledState, options: RerouteOptions(routeLostPolls: 1), baseline: [:])
        XCTAssertEqual(cooling.action, .stay)
        XCTAssertEqual(cooling.code, .cooldown)
        let taken = pollOnA(xM: 1000, etas: [.B: 1500], options: RerouteOptions(routeLostPolls: 1), baseline: [:])
        XCTAssertEqual(taken.action, .switchRoute)
        XCTAssertEqual(taken.code, .routeLost)
        // Without the answer to that request there is no switch, whatever routeLostPolls says.
        let notAsked = pollOnA(xM: 1000, etas: [.B: 1500], options: RerouteOptions(routeLostPolls: 1))
        XCTAssertEqual(notAsked.action, .stay)
        XCTAssertEqual(notAsked.code, .routeUnconfirmed)
    }

    // it('off route: takes the best fresh route at once, cooldown or not')
    func testScriptedDrives_offRouteTakesTheBestFreshRouteAtOnceCooldownOrNot() throws {
        func offRoad(_ id: String, _ durationSec: Double) throws -> RouteCandidate {
            var c = try XCTUnwrap(candidate(.A, at(3000, 0), durationSec))
            c.id = id
            c.geometry = [at(3000, 200), at(3400, 200), at(20000, 0)]
            return c
        }
        var cooling = RerouteState.initial
        cooling.lastSwitchAtSec = 990
        let decision = Reroute.decideReroute(
            cooling,
            RerouteObservation(
                nowSec: 1000,
                route: DrivenRoute(try XCTUnwrap(candidate(.A, at(0, 0), 2000))),
                positionAlongM: 3000,
                speedMps: 10,
                candidates: [try offRoad("slow", 1900), try offRoad("fast", 1700)]
            )
        )
        XCTAssertEqual(decision.action, .switchRoute)
        XCTAssertEqual(decision.code, .offRoute)
        XCTAssertEqual(decision.toRouteId, "fast")
        XCTAssertEqual(decision.reason, "Switching: off the planned route, taking the fastest route from here")
        XCTAssertEqual(decision.nextState.lastSwitchAtSec, 1000)
        // The caller's own measurement (GPS) wins over where the fresh routes start.
        let measured = Reroute.decideReroute(
            .initial,
            RerouteObservation(
                nowSec: 0,
                route: DrivenRoute(try XCTUnwrap(candidate(.A, at(0, 0), 2000))),
                positionAlongM: 3000,
                speedMps: 10,
                candidates: [try XCTUnwrap(candidate(.A, at(3000, 0), 1700))],
                offRouteM: 80
            )
        )
        XCTAssertEqual(measured.code, .offRoute)
    }

    // MARK: - describe('missing data')

    // it('no typical (traffic) duration on the current route: stays')
    func testMissingData_noTypicalTrafficDurationOnTheCurrentRouteStays() {
        let decision = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1500], options: noConfirm,
            extra: [.A: { $0.typicalDurationSec = nil }]
        )
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .noTrafficData)
        XCTAssertEqual(decision.reason, "Staying: no traffic data for the current route")
    }

    // it('no typical duration on the alternative: it is passed over')
    func testMissingData_noTypicalDurationOnTheAlternativeItIsPassedOver() {
        let decision = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1500], options: noConfirm,
            extra: [.B: { $0.typicalDurationSec = nil }]
        )
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .noTrafficData)
        // Another alternative with full data is still considered.
        let other = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1500, .C: 1800], options: noConfirm,
            extra: [.B: { $0.typicalDurationSec = nil }]
        )
        XCTAssertEqual(other.action, .switchRoute)
        XCTAssertEqual(idName(other.toRouteId), "C")
    }

    // it('compares without typical durations only when told to')
    func testMissingData_comparesWithoutTypicalDurationsOnlyWhenToldTo() {
        let decision = pollOnA(
            xM: 1000,
            etas: [.A: 2000, .B: 1500],
            options: RerouteOptions(confirmPolls: 1, requireTypicalDuration: false),
            extra: [.A: { $0.typicalDurationSec = nil }, .B: { $0.typicalDurationSec = nil }]
        )
        XCTAssertEqual(decision.action, .switchRoute)
    }

    // it('no travel time at all: stays')
    func testMissingData_noTravelTimeAtAllStays() {
        let current = pollOnA(xM: 1000, etas: [.A: 2000, .B: 1500], options: noConfirm, extra: [.A: { $0.durationSec = .nan }])
        XCTAssertEqual(current.action, .stay)
        XCTAssertEqual(current.code, .noEta)
        let other = pollOnA(xM: 1000, etas: [.A: 2000, .B: 1500], options: noConfirm, extra: [.B: { $0.durationSec = .nan }])
        XCTAssertEqual(other.action, .stay)
        XCTAssertEqual(other.code, .noTrafficData)
    }

    // it('candidates without a line to drive are ignored')
    func testMissingData_candidatesWithoutALineToDriveAreIgnored() {
        let lonePoint = at(1000, 0)
        let decision = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1500],
            extra: [.A: { $0.geometry = [] }, .B: { $0.geometry = [lonePoint] }]
        )
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .noRoutes)
    }

    // MARK: - describe('minimum saving')

    // it('120 seconds is the floor, to the second')
    func testMinimumSaving_120SecondsIsTheFloorToTheSecond() {
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 2000, .B: 1880.5], options: noConfirm).code, .savingTooSmall)
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 2000, .B: 1880], options: noConfirm).action, .switchRoute)
        XCTAssertEqual(
            pollOnA(xM: 1000, etas: [.A: 2000, .B: 1960], options: noConfirm).reason,
            "Staying: faster route saves only 40 seconds"
        )
    }

    // it('a long leg: 2.5 minutes on 90 is under 5% and not worth it')
    func testMinimumSaving_aLongLeg25MinutesOn90IsUnder5PercentAndNotWorthIt() {
        let long = pollOnA(xM: 1000, etas: [.A: 5400, .B: 5250], options: noConfirm)
        XCTAssertEqual(long.action, .stay)
        XCTAssertEqual(long.code, .savingShareTooSmall)
        XCTAssertEqual(long.reason, "Staying: faster route saves only 2.5 minutes of the remaining 90 minutes")
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 5400, .B: 5130], options: noConfirm).action, .switchRoute)
    }

    // it('a tiny remaining trip: a third of the time saved is still only a minute')
    func testMinimumSaving_aTinyRemainingTripAThirdOfTheTimeSavedIsStillOnlyAMinute() {
        let tiny = pollOnA(xM: 17500, etas: [.A: 200, .E: 140], options: noConfirm)
        XCTAssertEqual(tiny.action, .stay)
        XCTAssertEqual(tiny.code, .savingTooSmall)
        XCTAssertEqual(tiny.reason, "Staying: faster route saves only 60 seconds")
        // And a real gain near the end is no use when the turn is 300 m away.
        let close = pollOnA(xM: 18200, etas: [.A: 400, .E: 250], options: noConfirm)
        XCTAssertEqual(close.action, .stay)
        XCTAssertEqual(close.code, .tooLate)
    }

    // MARK: - describe('too-late maneuver guard')

    // it('asks for 20 seconds of driving when that is more than 400 m')
    func testTooLateManeuverGuard_asksFor20SecondsOfDrivingWhenThatIsMoreThan400m() throws {
        let slow = pollOnA(xM: 4400, etas: [.A: 2000, .B: 1700], speedMps: 10, options: noConfirm)
        XCTAssertEqual(slow.action, .switchRoute)
        XCTAssertEqual(try XCTUnwrap(slow.considered).requiredLeadM, 400)
        let fast = pollOnA(xM: 4400, etas: [.A: 2000, .B: 1700], speedMps: 35, options: noConfirm)
        XCTAssertEqual(fast.action, .stay)
        XCTAssertEqual(fast.code, .tooLate)
        let considered = try XCTUnwrap(fast.considered)
        XCTAssertEqual(considered.requiredLeadM, 700)
        XCTAssertEqual(considered.turnInM, 600, accuracy: 0.5)
    }

    // it('freeway: the exit has to be 1200 m ahead')
    func testTooLateManeuverGuard_freewayTheExitHasToBe1200mAhead() throws {
        // B leaves the main road 800 m ahead, and the road up to there is freeway.
        let onFreeway = pollOnA(
            xM: 4200, etas: [.A: 2000, .B: 1700], options: noConfirm,
            extra: [.B: { $0.limitedAccessSpansM = [DistanceSpanM(0, 800)] }]
        )
        XCTAssertEqual(onFreeway.action, .stay)
        XCTAssertEqual(onFreeway.code, .tooLate)
        let freewayConsidered = try XCTUnwrap(onFreeway.considered)
        XCTAssertEqual(freewayConsidered.onFreeway, true)
        XCTAssertEqual(freewayConsidered.requiredLeadM, 1200)
        XCTAssertEqual(onFreeway.reason, "Staying: faster route turns off in 0.4 miles, too late to take safely")
        // The same turn from a street is fine.
        let onStreet = pollOnA(
            xM: 4200, etas: [.A: 2000, .B: 1700], options: noConfirm,
            extra: [.B: { $0.limitedAccessSpansM = [] }]
        )
        XCTAssertEqual(onStreet.action, .switchRoute)
        // Freeway that ends before the turn-off does not count.
        let leftIt = pollOnA(
            xM: 4200, etas: [.A: 2000, .B: 1700], options: noConfirm,
            extra: [.B: { $0.limitedAccessSpansM = [DistanceSpanM(0, 300)] }]
        )
        XCTAssertEqual(leftIt.action, .switchRoute)
        // With room to spare the exit is taken.
        let early = pollOnA(
            xM: 3700, etas: [.A: 2000, .B: 1700], options: noConfirm,
            extra: [.B: { $0.limitedAccessSpansM = [DistanceSpanM(0, 1300)] }]
        )
        XCTAssertEqual(early.action, .switchRoute)
        let earlyConsidered = try XCTUnwrap(early.considered)
        XCTAssertEqual(earlyConsidered.onFreeway, true)
        XCTAssertEqual(earlyConsidered.requiredLeadM, 1200)
    }

    // it('freeway: falls back on the current route when the alternative does not say what road it is')
    func testTooLateManeuverGuard_freewayFallsBackOnTheCurrentRouteWhenTheAlternativeDoesNotSayWhatRoadItIs() throws {
        let decision = pollOnA(
            xM: 4200,
            etas: [.A: 2000, .B: 1700],
            options: noConfirm,
            extra: [.A: { $0.limitedAccessSpansM = [DistanceSpanM(0, 15800)] }, .B: { $0.limitedAccessSpansM = nil }]
        )
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .tooLate)
        XCTAssertEqual(try XCTUnwrap(decision.considered).onFreeway, true)
    }

    // it('uses the first maneuver of its own when that comes before the lines part')
    func testTooLateManeuverGuard_usesTheFirstManeuverOfItsOwnWhenThatComesBeforeTheLinesPart() throws {
        // An exit lane that runs beside the main road: the lines only part 1000 m ahead, the exit is at 300 m.
        let here = at(4000, 0)
        let exitManeuver = Maneuver(atDistanceM: 300, kind: "off ramp right", location: at(4300, 0))
        func withExit(_ c: RouteCandidate) -> RouteCandidate {
            var copy = c
            copy.maneuvers = [c.maneuvers[0], exitManeuver] + Array(c.maneuvers.dropFirst())
            return copy
        }
        let driven = DrivenRoute(try XCTUnwrap(candidate(.A, at(0, 0), 2000)))
        let alternative = withExit(try XCTUnwrap(candidate(.B, here, 1700)))
        func poll(_ current: RouteCandidate) -> RerouteDecision {
            Reroute.decideReroute(
                .initial,
                RerouteObservation(nowSec: 0, route: driven, positionAlongM: 4000, speedMps: 5, candidates: [current, alternative]),
                options: noConfirm
            )
        }
        let refused = poll(try XCTUnwrap(candidate(.A, here, 2000)))
        XCTAssertEqual(refused.action, .stay)
        XCTAssertEqual(refused.code, .tooLate)
        let refusedConsidered = try XCTUnwrap(refused.considered)
        XCTAssertEqual(refusedConsidered.turnInM, 300)
        XCTAssertEqual(refusedConsidered.turnAt, at(4300, 0))
        // A maneuver the current route makes too is not the alternative's own.
        let shared = poll(withExit(try XCTUnwrap(candidate(.A, here, 2000))))
        XCTAssertEqual(shared.action, .switchRoute)
        XCTAssertEqual(try XCTUnwrap(shared.considered).turnInM, 1000, accuracy: 0.5)
    }

    // it('refuses an alternative that leaves the route right where the driver is')
    func testTooLateManeuverGuard_refusesAnAlternativeThatLeavesTheRouteRightWhereTheDriverIs() throws {
        let decision = pollOnA(xM: 5000, etas: [.A: 2000, .B: 1500], options: noConfirm)
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .tooLate)
        XCTAssertEqual(try XCTUnwrap(decision.considered).turnInM, 0)
        XCTAssertEqual(decision.reason, "Staying: faster route turns off in 0 feet, too late to take safely")
    }

    // MARK: - describe('signals never decide a switch on their own')

    // it('fewer signals with an equal or nearly equal ETA is not worth a change')
    func testSignalsNeverDecide_fewerSignalsWithAnEqualOrNearlyEqualEtaIsNotWorthAChange() {
        let equal = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 2000], options: noConfirm,
            extra: [.A: RerouteFx.signals(20), .B: RerouteFx.signals(2)]
        )
        XCTAssertEqual(equal.action, .stay)
        XCTAssertEqual(equal.code, .currentBest)
        let close = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1990], options: noConfirm,
            extra: [.A: RerouteFx.signals(20), .B: RerouteFx.signals(2)]
        )
        XCTAssertEqual(close.action, .stay)
        XCTAssertEqual(close.code, .savingTooSmall)
        let log = drive(DriveScript(
            polls: 14,
            eta: RerouteFx.fixed([.A: 2000, .B: 1990]),
            tamper: { candidates, _ in
                candidates.map { c in DriveWorld.patched(c, RerouteFx.signals(DriveWorld.nameOf(c) == .A ? 20 : 2)) }
            }
        ))
        XCTAssertEqual(log.switches, [])
    }

    // it('between alternatives that both save enough, the existing ranking picks: ETA ties go to fewer signals')
    func testSignalsNeverDecide_betweenAlternativesThatBothSaveEnoughTheExistingRankingPicksEtaTiesGoToFewerSignals() {
        let etas: KeyValuePairs<RouteName, Double> = [.A: 2000, .B: 1850, .C: 1870]
        let fewerOnC = pollOnA(
            xM: 1000, etas: etas, options: noConfirm,
            extra: [.B: RerouteFx.signals(20), .C: RerouteFx.signals(5)]
        )
        XCTAssertEqual(idName(fewerOnC.toRouteId), "C")
        // A partial count is unknown to the ranking, so the faster one is taken.
        let partial = pollOnA(
            xM: 1000, etas: etas, options: noConfirm,
            extra: [.B: RerouteFx.signals(20), .C: RerouteFx.signals(5, .partial)]
        )
        XCTAssertEqual(idName(partial.toRouteId), "B")
        // Outside the 30 s tie window signals have no say.
        let clear = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1800, .C: 1870], options: noConfirm,
            extra: [.B: RerouteFx.signals(20), .C: RerouteFx.signals(5)]
        )
        XCTAssertEqual(idName(clear.toRouteId), "B")
    }

    // it('duplicate signals and partial coverage do not change a decision the ETA has made')
    func testSignalsNeverDecide_duplicateSignalsAndPartialCoverageDoNotChangeADecisionTheEtaHasMade() {
        let script = DriveScript(polls: 12, eta: RerouteFx.fixed([.A: 2000, .B: 1820, .C: 2100]))
        let plain = drive(script)
        // [action, code, reason] per poll.
        func outline(_ log: DriveLog) -> [[String]] {
            log.polls.map { [$0.decision.action.rawValue, $0.decision.code.rawValue, $0.decision.reason] }
        }
        let decorations: [(RouteName, DriveWorld.PollContext) -> Patch] = [
            // Every signal counted twice on the faster route.
            { name, _ in RerouteFx.signals(name == .B ? 48 : 24) },
            // Coverage comes and goes from poll to poll.
            { name, context in RerouteFx.signals(name == .B ? 30 : 3, context.poll % 2 == 0 ? .partial : .full) },
            { name, _ in name == .A ? RerouteFx.signals(0) : RerouteFx.noSignals },
            { _, context in RerouteFx.signals(context.poll, .partial) },
        ]
        for (index, decorate) in decorations.enumerated() {
            var decoratedScript = script
            decoratedScript.tamper = { candidates, context in
                candidates.map { c in DriveWorld.patched(c, decorate(DriveWorld.nameOf(c), context)) }
            }
            let decorated = drive(decoratedScript)
            XCTAssertEqual(outline(decorated), outline(plain), "decoration \(index)")
            XCTAssertEqual(decorated.switches, plain.switches, "decoration \(index)")
        }
    }

    // MARK: - describe('determinism')

    /// One poll of a drive with the route ids left out (they are new on every poll by design).
    private struct OutlineRow: Equatable {
        let nowSec: Double
        let on: DriveWorld.RouteName
        let action: RerouteAction
        let code: RerouteCode
        let reason: String
        let nextState: RerouteState
        let turnInM: Double?
    }

    private func determinismOutline(_ log: DriveLog) -> [OutlineRow] {
        log.polls.map { p in
            OutlineRow(
                nowSec: p.nowSec,
                on: p.on,
                action: p.decision.action,
                code: p.decision.code,
                reason: p.decision.reason,
                nextState: p.decision.nextState,
                turnInM: p.decision.considered?.turnInM
            )
        }
    }

    private var determinismScript: DriveScript {
        DriveScript(polls: 14, eta: { name, context in
            switch name {
            case .B: return 1820
            case .A: return context.poll >= 2 ? 1500 : 2000
            case .C: return 1900
            default: return nil
            }
        })
    }

    // it('the same drive gives the same decisions, reasons and states')
    func testDeterminism_theSameDriveGivesTheSameDecisionsReasonsAndStates() {
        XCTAssertEqual(determinismOutline(drive(determinismScript)), determinismOutline(drive(determinismScript)))
    }

    // it('the same call gives the same answer and leaves its inputs alone')
    func testDeterminism_theSameCallGivesTheSameAnswerAndLeavesItsInputsAlone() throws {
        // Swift values cannot be changed through a call, which is what the TS freeze checks;
        // the copies below are compared afterwards all the same.
        let here = at(1000, 0)
        let state = RerouteState(
            pending: RerouteState.Pending(geometry: try XCTUnwrap(candidate(.B, at(700, 0), 1800)).geometry, polls: 1),
            lastSwitchAtSec: nil,
            abandoned: [RerouteState.Abandoned(geometry: try XCTUnwrap(candidate(.C, at(0, 0), 1800)).geometry, atSec: -100)],
            failedPolls: 0,
            lostPolls: 0
        )
        let observation = RerouteObservation(
            nowSec: 60,
            route: DrivenRoute(try XCTUnwrap(candidate(.A, at(0, 0), 2000))),
            positionAlongM: 1000,
            speedMps: 12,
            candidates: [
                try XCTUnwrap(candidate(.A, here, 2000)),
                try XCTUnwrap(candidate(.B, here, 1800)),
                try XCTUnwrap(candidate(.C, here, 1900)),
            ]
        )
        let stateBefore = state
        let observationBefore = observation
        let first = Reroute.decideReroute(state, observation)
        let second = Reroute.decideReroute(state, observation)
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.action, .switchRoute)
        XCTAssertEqual(state, stateBefore)
        XCTAssertEqual(observation, observationBefore)
        // The order the candidates arrive in does not matter either.
        var reversedObservation = observation
        reversedObservation.candidates = observation.candidates.map { Array($0.reversed()) }
        let reversed = Reroute.decideReroute(state, reversedObservation)
        XCTAssertEqual(reversed, first)
    }

    // MARK: - describe('property: seeded random ETAs')

    private struct Run {
        let seed: Int
        let options: RerouteOptions
        let log: DriveWorld.DriveLog
    }

    /// Seeds 1 to 40, built once like the TS describe body.
    private static let runs: [Run] = (1...40).map { (seed: Int) -> Run in
        let nextRandom = RerouteFx.seeded(UInt32(seed))
        let options = RerouteOptions(confirmPolls: seed % 2 == 0 ? 1 : 2, noReturnSec: seed % 3 == 0 ? 0 : 600)
        // Math.round of a positive number: .rounded() rounds its halves up too.
        let script = DriveWorld.DriveScript(polls: 62, eta: { _, _ in (1400 + nextRandom() * 1200).rounded() }, options: options)
        return Run(seed: seed, options: options, log: DriveWorld.drive(script))
    }

    // it('switches never come closer together than the cooldown')
    func testPropertySeededRandomEtas_switchesNeverComeCloserTogetherThanTheCooldown() {
        var switches = 0
        for run in Self.runs {
            switches += run.log.switches.count
            for i in run.log.switches.indices where i > 0 {
                XCTAssertGreaterThanOrEqual(
                    run.log.switches[i].nowSec - run.log.switches[i - 1].nowSec,
                    RerouteOptions.default.cooldownSec,
                    "seed \(run.seed)"
                )
            }
        }
        // The check means something only if the random drives do switch.
        XCTAssertGreaterThan(switches, 40)
    }

    // it('every switch saved enough, with room to make the turn, and says so in one short sentence')
    func testPropertySeededRandomEtas_everySwitchSavedEnoughWithRoomToMakeTheTurnAndSaysSoInOneShortSentence() throws {
        for run in Self.runs {
            for p in run.log.polls {
                let decision = p.decision
                XCTAssertTrue(RerouteFx.hasReasonShape(decision.reason), "seed \(run.seed): \(decision.reason)")
                // JS string length counts UTF-16 code units.
                XCTAssertLessThan(decision.reason.utf16.count, 120)
                XCTAssertEqual(decision.toRouteId == nil, decision.action == .stay)
                if decision.action != .switchRoute { continue }
                XCTAssertEqual(decision.code, .fasterRoute)
                let considered = try XCTUnwrap(decision.considered, "seed \(run.seed)")
                let savingSec = try XCTUnwrap(considered.savingSec, "seed \(run.seed)")
                XCTAssertGreaterThanOrEqual(savingSec, RerouteOptions.default.minSavingSec)
                XCTAssertGreaterThanOrEqual(considered.turnInM, considered.requiredLeadM)
                XCTAssertNil(decision.nextState.pending)
            }
        }
    }

    // it('with the defaults, a route left is not taken again within ten minutes for less than twice the minimum')
    func testPropertySeededRandomEtas_withTheDefaultsARouteLeftIsNotTakenAgainWithinTenMinutesForLessThanTwiceTheMinimum() throws {
        for run in Self.runs {
            if run.options.noReturnSec == 0 { continue }
            let switches = run.log.switches
            for (i, s) in switches.enumerated() {
                let back = switches[0..<i].first { earlier in earlier.from == s.to && s.nowSec - earlier.nowSec < 600 }
                if back == nil { continue }
                let poll = try XCTUnwrap(run.log.polls.first { $0.nowSec == s.nowSec }, "seed \(run.seed)")
                let considered = try XCTUnwrap(poll.decision.considered, "seed \(run.seed)")
                XCTAssertGreaterThanOrEqual(try XCTUnwrap(considered.savingSec), 240, "seed \(run.seed)")
            }
        }
    }
}

// MARK: - describe('a route the driver turned down')

final class RerouteDeclinedTests: XCTestCase {
    private func at(_ xM: Double, _ yM: Double) -> LngLat { DriveWorld.at(xM, yM) }
    private func candidate(_ name: DriveWorld.RouteName, _ from: LngLat, _ durationSec: Double) throws -> RouteCandidate {
        try XCTUnwrap(DriveWorld.candidate(name, from, durationSec))
    }

    // "Keep previous route" in the live drive: declineRoute, then the same faster route at every poll.
    private func offer(_ nowSec: Double, _ state: RerouteState, _ xM: Double) throws -> RerouteDecision {
        let mainRoad = DrivenRoute(geometry: try candidate(.A, at(0, 0), 2000).geometry, maneuvers: [], limitedAccessSpansM: nil)
        return Reroute.decideReroute(state, RerouteObservation(
            nowSec: nowSec, route: mainRoad, positionAlongM: xM, speedMps: 5,
            candidates: [try candidate(.A, at(xM, 0), 2000), try candidate(.B, at(xM, 0), 1500)]
        ))
    }

    // it('is not switched to again until its time is up, whatever it saves')
    func testTurnedDown_isNotSwitchedToAgainUntilItsTimeIsUpWhateverItSaves() throws {
        let b = try candidate(.B, at(900, 0), 1500)
        let declined = Reroute.declineRoute(.initial, b.geometry, untilSec: 600)
        XCTAssertEqual(declined, RerouteState(declined: [RerouteState.Declined(geometry: b.geometry, untilSec: 600)]))
        let first = try offer(60, declined, 1200)
        XCTAssertEqual(first.action, .stay)
        XCTAssertEqual(first.code, .driverDeclined)
        XCTAssertEqual(first.reason, "Staying: faster route saves 8.3 minutes, but you chose to keep this route")
        // No confirmation builds up meanwhile.
        XCTAssertNil(first.nextState.pending)
        let second = try offer(120, first.nextState, 1500)
        XCTAssertEqual(second.code, .driverDeclined)
        // Once the time is up the entry is dropped and the usual rules apply again.
        let later = try offer(600, second.nextState, 3000)
        XCTAssertEqual(later.nextState.declined, [])
        XCTAssertEqual(later.action, .stay)
        XCTAssertEqual(later.code, .confirming)
        let taken = try offer(660, later.nextState, 3300)
        XCTAssertEqual(taken.action, .switchRoute)
        XCTAssertEqual(taken.code, .fasterRoute)
    }

    // it('another faster route is still taken')
    func testTurnedDown_anotherFasterRouteIsStillTaken() throws {
        let c = try candidate(.C, at(900, 0), 1500)
        let first = try offer(60, Reroute.declineRoute(.initial, c.geometry, untilSec: 600), 1200)
        XCTAssertEqual(first.code, .confirming)
        let second = try offer(120, first.nextState, 1500)
        XCTAssertEqual(second.action, .switchRoute)
        XCTAssertEqual(second.code, .fasterRoute)
    }

    // it('drops a route-lost count in progress, so a lost road needs the full count again (#28)')
    func testTurnedDown_dropsARouteLostCountInProgressSoALostRoadNeedsTheFullCountAgain() throws {
        let b = try candidate(.B, at(900, 0), 1500)
        let declined = Reroute.declineRoute(RerouteState(lostPolls: 2), b.geometry, untilSec: 600)
        XCTAssertEqual(declined.lostPolls, 0)
        XCTAssertNil(declined.pending)
    }
}

// MARK: - describe('matching cost on a long route (#51)')

// #51: the overlap matching walked every 10 m of both lines, and every point of a stretch apart
// looked at the whole other line. The cost is counted (segment distance checks plus grid
// entries, see MatchMeter), not timed, so the test says the same on every machine.
final class RerouteMatchingCostTests: XCTestCase {
    private typealias Corner = (x: Double, y: Double)

    /// Through the corners with a vertex every 20 m: 100 km is 5000 vertices.
    private static func dense(_ corners: [Corner]) -> [Corner] {
        var out: [Corner] = [corners[0]]
        for i in 1..<corners.count {
            let (x0, y0) = corners[i - 1]
            let (x1, y1) = corners[i]
            let n = max(1, Int((hypot(x1 - x0, y1 - y0) / 20).rounded()))
            for k in 1...n {
                out.append((x0 + (x1 - x0) * Double(k) / Double(n), y0 + (y1 - y0) * Double(k) / Double(n)))
            }
        }
        return out
    }

    private struct Bumped {
        let xy: [Corner]
        let route: RouteCandidate
    }

    /// A route north (+) or south (-) of the straight line by `bumpM` for the middle 45 %, as meters and as a candidate.
    private static func bumped(_ id: String, _ bumpM: Double, _ durationSec: Double) -> Bumped {
        let xy = dense([(0, 0), (27_500, 0), (27_500, bumpM), (72_500, bumpM), (72_500, 0), (100_000, 0)])
        var route = DriveWorld.candidate(.A, DriveWorld.at(0, 0), durationSec)!
        route.id = id
        route.geometry = xy.map { DriveWorld.at($0.x, $0.y) }
        route.distanceM = Geo.alongRouteM(route.geometry).last ?? 0
        route.maneuvers = []
        return Bumped(xy: xy, route: route)
    }

    // The current route: 100 km east, 1 km north for the middle 45 %. Three alternatives run 2 to
    // 4 km from it for that 45 % (the first just as long, so no length check rules it out), and
    // one is the current route drawn again.
    private static let driven = bumped("driven", 1000, 5000)
    private static let alternatives = [bumped("south-1", -1000, 4800), bumped("south-2", -2000, 4900), bumped("south-3", -3000, 5000)]
    private static let same = bumped("same", 1000, 5100)

    /// The matcher before #35, as a reference for the cost: every vertex of each line within
    /// 10 m of the other, each looked up by scanning the other line from its start.
    private static func oldMatcherChecks(_ path: [Corner], _ candidates: [[Corner]]) -> Int {
        var checks = 0
        func toSegment(_ p: Corner, _ a: Corner, _ b: Corner) -> Double {
            checks += 1
            let dx = b.x - a.x
            let dy = b.y - a.y
            let lengthSq = dx * dx + dy * dy
            let t = lengthSq == 0 ? 0 : min(1, max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
            return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
        }
        func near(_ p: Corner, _ line: [Corner]) -> Bool {
            for i in 1..<line.count where toSegment(p, line[i - 1], line[i]) <= 10 { return true }
            return false
        }
        for fresh in candidates {
            // Where the fresh route starts on the path (one full scan), then both ways, vertex by vertex.
            for i in 1..<path.count { _ = toSegment(fresh[0], path[i - 1], path[i]) }
            if fresh.allSatisfy({ near($0, path) }) && path.allSatisfy({ near($0, fresh) }) { return checks }
        }
        return checks
    }

    private func cost(_ offered: [Bumped]) -> (found: RouteCandidate?, work: Int) {
        let meter = MatchMeter()
        let found = Reroute.findCurrentRoute(Self.driven.route.geometry, positionAlongM: 0, candidates: offered.map(\.route), meter: meter)
        return (found, meter.segmentChecks + meter.gridEntries)
    }

    // it('the current route not among them: at most twice the old cost')
    func testMatchingCost_theCurrentRouteNotAmongThemAtMostTwiceTheOldCost() {
        XCTAssertEqual(Self.driven.xy.count, 5101)
        let (found, work) = cost(Self.alternatives)
        XCTAssertNil(found)
        XCTAssertLessThanOrEqual(work, 2 * Self.oldMatcherChecks(Self.driven.xy, Self.alternatives.map(\.xy)))
    }

    // it('the current route among them, offered last: at most twice the old cost, and found')
    func testMatchingCost_theCurrentRouteAmongThemOfferedLastAtMostTwiceTheOldCostAndFound() {
        let offered = Self.alternatives + [Self.same]
        let (found, work) = cost(offered)
        XCTAssertEqual(found, Self.same.route)
        XCTAssertLessThanOrEqual(work, 2 * Self.oldMatcherChecks(Self.driven.xy, offered.map(\.xy)))
    }

    // it('counting changes nothing: the same answer with or without a meter')
    func testMatchingCost_countingChangesNothingTheSameAnswerWithOrWithoutAMeter() {
        XCTAssertEqual(Reroute.findCurrentRoute(Self.driven.route.geometry, positionAlongM: 0, candidates: (Self.alternatives + [Self.same]).map(\.route)), Self.same.route)
        XCTAssertNil(Reroute.findCurrentRoute(Self.driven.route.geometry, positionAlongM: 0, candidates: Self.alternatives.map(\.route)))
    }
}

// MARK: - describe('the lead is judged where the driver is when the answer is used (#5 review)')

final class RerouteLeadFromTheCarTests: XCTestCase {
    // A slow answer (a probe that drags on weak signal): asked 4.3 km along A, used once the car
    // has gone on. B leaves A at 5 km.
    private func decide(_ drivenSinceM: Double?) throws -> RerouteDecision {
        let here = DriveWorld.at(4300, 0)
        return Reroute.decideReroute(
            .initial,
            RerouteObservation(
                nowSec: 0,
                route: DrivenRoute(geometry: try XCTUnwrap(DriveWorld.candidate(.A, DriveWorld.at(0, 0), 2400)).geometry, maneuvers: [], limitedAccessSpansM: nil),
                positionAlongM: 4300,
                speedMps: 15,
                candidates: [try XCTUnwrap(DriveWorld.candidate(.A, here, 2000)), try XCTUnwrap(DriveWorld.candidate(.B, here, 1700))],
                drivenSinceM: drivenSinceM
            ),
            options: RerouteOptions(confirmPolls: 1)
        )
    }

    // it('a turn-off 700 m from where the check was asked is taken when the answer is quick')
    func testLeadFromTheCar_aTurnOff700mFromWhereTheCheckWasAskedIsTakenWhenTheAnswerIsQuick() throws {
        let quick = try decide(nil)
        XCTAssertEqual(quick.action, .switchRoute)
        XCTAssertEqual(try XCTUnwrap(quick.considered).turnInM, 700, accuracy: 0.5)
        XCTAssertEqual(try decide(0).action, .switchRoute)
    }

    // it('and refused when the car went 375 m while the answer was out: 325 m left is under the 400 m lead')
    func testLeadFromTheCar_andRefusedWhenTheCarWent375mWhileTheAnswerWasOut() throws {
        let late = try decide(375)
        XCTAssertEqual(late.code, .tooLate)
        XCTAssertEqual(try XCTUnwrap(late.considered).turnInM, 325, accuracy: 0.5)
        // The TS regex /turns off in .+, too late to take safely$/.
        XCTAssertNotNil(late.reason.range(of: "turns off in .+, too late to take safely$", options: .regularExpression), late.reason)
    }

    // it('what is said counts from the car too, and a value that is not a distance is 0')
    func testLeadFromTheCar_whatIsSaidCountsFromTheCarTooAndAValueThatIsNotADistanceIs0() throws {
        let on = try decide(200)
        XCTAssertEqual(on.action, .switchRoute)
        XCTAssertEqual(try XCTUnwrap(on.considered).turnInM, 500, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(try decide(.nan).considered).turnInM, 700, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(try decide(-50).considered).turnInM, 700, accuracy: 0.5)
    }
}
