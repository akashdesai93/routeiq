import Foundation
import XCTest
// @testable for the memberwise initialisers of RerouteDecision and RerouteAlternative,
// which the rememberCheckProbes cases build by hand (the TS writes them as object literals).
@testable import RouteIQCore

// Mirrors tests/probe.test.ts, assertion for assertion: side-street probing (PLAN step 11),
// where via points go and how a drive probes. The network is DriveWorld.swift's made-up one.

/// The fastest is A (straight east 20 km); B runs 1 km north of it, C 1 km south.
private enum ProbeFx {
    typealias RouteName = DriveWorld.RouteName

    static func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }

    static func fixtureRoutes(_ name: String) throws -> [RouteCandidate] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let body = try JSONValue.parse(Data(contentsOf: root.appendingPathComponent("tests/fixtures/\(name)")))
        return try XCTUnwrap(Directions.parse(body).routes, "expected routes")
    }

    static func world(_ name: RouteName, _ durationSec: Double, _ extra: DriveWorld.Patch? = nil) -> RouteCandidate {
        guard let route = DriveWorld.candidate(name, at(0, 0), durationSec, extra) else { preconditionFailure("no route \(name)") }
        return route
    }

    static func lineDistanceM(_ point: LngLat, _ line: [LngLat]) -> Double {
        let project = Geo.localProjector(point)
        var best = Double.infinity
        for i in stride(from: 1, to: line.count, by: 1) {
            best = min(best, Geo.pointToSegment(project(point), project(line[i - 1]), project(line[i])).distanceM)
        }
        return best
    }

    static func WORLD() -> [RouteCandidate] { [world(.A, 1200), world(.B, 1300), world(.C, 1250)] }

    /// A copy of `r` with a different id and geometry: the TS `{ ...r, id, geometry }`.
    static func with(_ r: RouteCandidate, id: String? = nil, geometry: [LngLat]? = nil) -> RouteCandidate {
        var c = r
        if let id { c.id = id }
        if let geometry { c.geometry = geometry }
        return c
    }

    static func spans(_ s: [(Double, Double)]?) -> [DistanceSpanM]? { s.map { $0.map { DistanceSpanM($0.0, $0.1) } } }

    /// A's geometry with per-segment congestion: a segment whose middle lies in one
    /// of `jams` (meters along A, which runs straight east) is at `level`, every
    /// other one is low.
    static func jammedA(_ durationSec: Double, _ jams: [(Double, Double)], _ level: CongestionLevel = .heavy) -> RouteCandidate {
        var route = world(.A, durationSec)
        let along = Geo.alongRouteM(route.geometry)
        let congestion: [CongestionLevel] = along.dropFirst().enumerated().map { i, end in
            let mid = (along[i] + end) / 2
            return jams.contains { mid > $0.0 && mid < $0.1 } ? level : .low
        }
        route.segmentTraffic = SegmentTraffic(congestion: congestion, durationSec: nil)
        return route
    }

    /// The points without the base route's id: the test world numbers its routes as they are made.
    static func placed(_ points: [ViaPoint]) -> [ViaPoint] {
        points.map { p in
            var q = p
            q.baseRouteId = ""
            return q
        }
    }

    static func expectWellPlaced(_ points: [ViaPoint], _ candidates: [RouteCandidate], file: StaticString = #filePath, line: UInt = #line) {
        let o = ProbeOptions.default
        for p in points {
            guard let base = candidates.first(where: { $0.id == p.baseRouteId }) else {
                XCTFail("no base \(p.baseRouteId)", file: file, line: line)
                continue
            }
            for c in candidates {
                XCTAssertGreaterThanOrEqual(lineDistanceM(p.position, c.geometry), o.clearOfRoutesM, file: file, line: line)
            }
            XCTAssertGreaterThanOrEqual(Geo.distanceM(p.position, base.geometry[0]), o.endpointClearanceM, file: file, line: line)
            XCTAssertGreaterThanOrEqual(Geo.distanceM(p.position, base.geometry[base.geometry.count - 1]), o.endpointClearanceM, file: file, line: line)
            XCTAssertTrue(o.offsetsM.contains(p.offsetM), file: file, line: line)
            // The point sits square to the route, at its offset (to within a few meters of projection error).
            XCTAssertLessThan(abs(lineDistanceM(p.position, base.geometry) - p.offsetM), 5, file: file, line: line)
            let lengthM = Geo.alongRouteM(base.geometry).last!
            XCTAssertGreaterThanOrEqual(p.targetSpanM.startM, o.endpointClearanceM, file: file, line: line)
            XCTAssertLessThanOrEqual(p.targetSpanM.endM, lengthM - o.endpointClearanceM, file: file, line: line)
            XCTAssertGreaterThanOrEqual(p.targetSpanM.endM - p.targetSpanM.startM, o.minStretchM, file: file, line: line)
            XCTAssertNotEqual(p.reason, "", file: file, line: line)
        }
    }

    /// The JS `Math.round` of a span's bounds, as [start, end].
    static func rounded(_ s: DistanceSpanM) -> [Double] { [(s.startM + 0.5).rounded(.down), (s.endM + 0.5).rounded(.down)] }
}

// MARK: - describe('selectViaPoints')

final class ProbeTests: XCTestCase {
    private typealias Fx = ProbeFx

    private func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }
    private func world(_ name: DriveWorld.RouteName, _ durationSec: Double, _ extra: DriveWorld.Patch? = nil) -> RouteCandidate {
        Fx.world(name, durationSec, extra)
    }

    // it('probes both sides of the longest surface stretch of the fastest route')
    func testSelectViaPoints_probesBothSidesOfTheLongestSurfaceStretchOfTheFastestRoute() throws {
        let candidates = Fx.WORLD()
        let points = Probe.selectViaPoints(candidates)
        XCTAssertEqual(points.count, 2)
        XCTAssertTrue(points.allSatisfy { $0.baseRouteId == candidates[0].id })
        XCTAssertEqual(Set(points.map(\.side)), Set([ProbeSide.left, .right]))
        // The middle of the stretch [1 km, 19 km], 500 m north (left) and south (right).
        let left = try XCTUnwrap(points.first { $0.side == .left })
        XCTAssertLessThan(Geo.distanceM(left.position, at(10000, 500)), 2)
        XCTAssertLessThan(Geo.distanceM(try XCTUnwrap(points.first { $0.side == .right }).position, at(10000, -500)), 2)
        XCTAssertEqual(left.targetSpanM.startM, 1000, accuracy: 0.5)
        XCTAssertTrue(left.reason.contains("left"))
        Fx.expectWellPlaced(points, candidates)
    }

    // it('takes left and right from the direction of travel')
    func testSelectViaPoints_takesLeftAndRightFromTheDirectionOfTravel() throws {
        // A driven west: left is now south.
        let west = Fx.with(world(.A, 1200), id: "west", geometry: Array(world(.A, 1200).geometry.reversed()))
        let left = try XCTUnwrap(Probe.selectViaPoints([west]).first { $0.side == .left })
        XCTAssertLessThan(Geo.distanceM(left.position, at(10000, -500)), 2)
        // A diagonal route north-east: left is to the north-west of it.
        let diagonal = Fx.with(world(.A, 1200), id: "diag", geometry: [at(0, 0), at(10000, 10000)])
        let diagLeft = try XCTUnwrap(Probe.selectViaPoints([diagonal]).first { $0.side == .left })
        let d = 500 / 2.0.squareRoot()
        XCTAssertLessThan(Geo.distanceM(diagLeft.position, at(5000 - d, 5000 + d)), 2)
    }

    // it('is deterministic and does not depend on candidate order')
    func testSelectViaPoints_isDeterministicAndDoesNotDependOnCandidateOrder() {
        let candidates = Fx.WORLD()
        let once = Probe.selectViaPoints(candidates)
        XCTAssertEqual(Probe.selectViaPoints(candidates), once)
        XCTAssertEqual(Probe.selectViaPoints(Array(candidates.reversed())), once)
    }

    // it('breaks an equal-duration tie by the smaller id, whatever the order')
    func testSelectViaPoints_breaksAnEqualDurationTieByTheSmallerIdWhateverTheOrder() {
        // Same ETA: 'a' (A, straight) must be the base over 'b' (D, north detour), in either order.
        let a = Fx.with(world(.A, 1200), id: "a")
        let b = Fx.with(world(.D, 1200), id: "b")
        for candidates in [[a, b], [b, a]] {
            let points = Probe.selectViaPoints(candidates)
            XCTAssertGreaterThan(points.count, 0)
            XCTAssertTrue(points.allSatisfy { $0.baseRouteId == "a" })
        }
    }

    // it('orders sides by room even when another candidate has a NaN coordinate')
    func testSelectViaPoints_ordersSidesByRoomEvenWhenAnotherCandidateHasANaNCoordinate() {
        // B runs 1 km north of A, so the right (south) side has more room and comes first.
        let candidates = [world(.A, 1200), world(.B, 1300)]
        XCTAssertEqual(Probe.selectViaPoints(candidates).map(\.side), [.right, .left])
        var geometry = world(.C, 1250).geometry
        geometry[3] = LngLat(.nan, .nan)
        let broken = Fx.with(world(.C, 1250), id: "broken", geometry: geometry)
        XCTAssertEqual(Probe.selectViaPoints(candidates + [broken]).map(\.side), [.right, .left])
    }

    // it('merges overlapping freeway spans and ignores empty, reversed or NaN ones')
    func testSelectViaPoints_mergesOverlappingFreewaySpansAndIgnoresEmptyReversedOrNaNOnes() {
        let spansOf = { (limitedAccessSpansM: [DistanceSpanM]?) -> [DistanceSpanM] in
            Probe.selectViaPoints([self.world(.A, 1200) { $0.limitedAccessSpansM = limitedAccessSpansM }], options: ProbeOptions(maxPoints: 10))
                .map(\.targetSpanM)
        }
        let whole: [[Double]] = [[1000, 19000], [1000, 19000]]
        // [3, 8] and [5, 12] km overlap into one freeway from 3 to 12 km: stretches [12, 19] and [1, 3] km.
        let overlapping = spansOf(Fx.spans([(5000, 12000), (3000, 8000)]))
        XCTAssertEqual(overlapping.map(Fx.rounded), [[12000, 19000], [1000, 3000], [12000, 19000], [1000, 3000]])
        XCTAssertEqual(spansOf(Fx.spans([(4000, 6000), (4500, 5500)])).map(Fx.rounded), [[6000, 19000], [1000, 4000], [6000, 19000], [1000, 4000]])
        XCTAssertEqual(spansOf([]), spansOf(nil))
        for spans: [(Double, Double)] in [[(5000, 5000)], [(8000, 3000)], [(2000, .nan)], [(.nan, 6000)]] as [[(Double, Double)]] {
            XCTAssertEqual(spansOf(Fx.spans(spans)).map(Fx.rounded), whole)
        }
    }

    // it("uses the segment's own heading at a hairpin")
    func testSelectViaPoints_usesTheSegmentsOwnHeadingAtAHairpin() throws {
        // East 10 km, north 100 m, back west 10 km. A freeway over the last 1.04 km puts the probe spot
        // on the short northbound link, 30 m up it, where the ±150 m chord is much shorter than the window.
        var hairpin = Fx.with(world(.A, 1200), id: "hairpin", geometry: [at(0, 0), at(10000, 0), at(10000, 100), at(0, 100)])
        hairpin.limitedAccessSpansM = [DistanceSpanM(19060, 20100)]
        let points = Probe.selectViaPoints([hairpin])
        // Heading north: right is east. The chord would tilt it and land on the eastbound leg.
        XCTAssertEqual(points.map(\.side), [.right])
        XCTAssertEqual(points.map(\.offsetM), [500])
        XCTAssertLessThan(Geo.distanceM(try XCTUnwrap(points.first).position, at(10500, 30)), 2)
    }

    // it('spreads a small budget over stretches before taking second sides, and respects maxPoints')
    func testSelectViaPoints_spreadsASmallBudgetOverStretchesBeforeTakingSecondSidesAndRespectsMaxPoints() {
        // A freeway span from 8 to 12 km splits A into two surface stretches: [1, 8] and [12, 19] km.
        let candidates = [world(.A, 1200) { $0.limitedAccessSpansM = [DistanceSpanM(8000, 12000)] }]
        let all = Probe.selectViaPoints(candidates, options: ProbeOptions(maxPoints: 10))
        XCTAssertEqual(all.count, 4)
        let two = Probe.selectViaPoints(candidates, options: ProbeOptions(maxPoints: 2))
        XCTAssertEqual(two, Array(all.prefix(2)))
        XCTAssertNotEqual(two[0].targetSpanM, two[1].targetSpanM)
        XCTAssertEqual(Probe.selectViaPoints(candidates, options: ProbeOptions(maxPoints: 1)).count, 1)
        XCTAssertEqual(Probe.selectViaPoints(candidates, options: ProbeOptions(maxPoints: 0)), [])
        XCTAssertLessThanOrEqual(Probe.selectViaPoints(candidates).count, ProbeOptions.default.maxPoints)
        Fx.expectWellPlaced(all, candidates)
    }

    // it('returns nothing for a freeway-only trip')
    func testSelectViaPoints_returnsNothingForAFreewayOnlyTrip() {
        let freeway = world(.A, 900) { $0.limitedAccessSpansM = [DistanceSpanM(0, 20000)] }
        XCTAssertEqual(Probe.selectViaPoints([freeway]), [])
        // Short surface ends at the ramps do not count: they fall inside the endpoint clearance.
        XCTAssertEqual(Probe.selectViaPoints([world(.A, 900) { $0.limitedAccessSpansM = [DistanceSpanM(600, 19400)] }]), [])
    }

    // it('returns nothing for a tiny trip')
    func testSelectViaPoints_returnsNothingForATinyTrip() throws {
        XCTAssertEqual(Probe.selectViaPoints(try Fx.fixtureRoutes("directions.freeway.json")), [])
        let short = try XCTUnwrap(DriveWorld.candidate(.A, at(18000, 0), 120))
        XCTAssertEqual(Probe.selectViaPoints([short]), [])
    }

    // it('moves out, or drops the point, when an existing route already runs there')
    func testSelectViaPoints_movesOutOrDropsThePointWhenAnExistingRouteAlreadyRunsThere() throws {
        // An alternative running 500 m north of A along the probe spot pushes the left point out to 800 m.
        let near = Fx.with(world(.A, 1300), id: "near", geometry: [at(0, 0), at(5000, 500), at(15000, 500), at(20000, 0)])
        let candidates = [world(.A, 1200), near]
        let points = Probe.selectViaPoints(candidates)
        XCTAssertEqual(try XCTUnwrap(points.first { $0.side == .left }).offsetM, 800)
        Fx.expectWellPlaced(points, candidates)
        // With a single 500 m offset the left side has nowhere to go.
        let only500 = Probe.selectViaPoints(candidates, options: ProbeOptions(offsetsM: [500]))
        XCTAssertEqual(only500.map(\.side), [.right])
    }

    // it('never places points near the origin or destination')
    func testSelectViaPoints_neverPlacesPointsNearTheOriginOrDestination() throws {
        // A 3.5 km trip: its only stretch is [1, 2.5] km, so the probe spot is 1.75 km from each end.
        let short = try XCTUnwrap(DriveWorld.candidate(.A, at(16500, 0), 300))
        let points = Probe.selectViaPoints([short])
        XCTAssertGreaterThan(points.count, 0)
        Fx.expectWellPlaced(points, [short])
        // A clearance bigger than half the trip leaves nothing to probe.
        XCTAssertEqual(Probe.selectViaPoints([short], options: ProbeOptions(endpointClearanceM: 1800)), [])
    }

    // it('works on the Mapbox fixtures')
    func testSelectViaPoints_worksOnTheMapboxFixtures() throws {
        for name in ["directions.ok.json", "directions.corridor.json"] {
            let candidates = try Fx.fixtureRoutes(name)
            let points = Probe.selectViaPoints(candidates)
            XCTAssertGreaterThan(points.count, 0, name)
            XCTAssertLessThanOrEqual(points.count, ProbeOptions.default.maxPoints, name)
            // The fastest route is the base: in directions.ok.json that is the second one (840 s).
            // The first of the shortest durations, as the TS stable sort leaves it.
            var fastest = candidates[0]
            for c in candidates.dropFirst() where c.durationSec < fastest.durationSec { fastest = c }
            XCTAssertTrue(points.allSatisfy { $0.baseRouteId == fastest.id }, name)
            Fx.expectWellPlaced(points, candidates)
        }
    }

    // it('treats unknown road kinds as surface street')
    func testSelectViaPoints_treatsUnknownRoadKindsAsSurfaceStreet() {
        XCTAssertEqual(Probe.selectViaPoints([world(.A, 1200) { $0.limitedAccessSpansM = nil }]).count, 2)
    }

    // it('survives degenerate input')
    func testSelectViaPoints_survivesDegenerateInput() {
        XCTAssertEqual(Probe.selectViaPoints([]), [])
        let dot = Fx.with(world(.A, 10), id: "dot", geometry: [at(10000, 0)])
        XCTAssertEqual(Probe.selectViaPoints([dot]), [])
        let empty = Fx.with(world(.A, 10), id: "empty", geometry: [])
        XCTAssertEqual(Probe.selectViaPoints([empty]), [])
        let nan = Fx.with(world(.A, .nan), id: "nan")
        XCTAssertEqual(Probe.selectViaPoints([nan]), [])
        // Unusable candidates are never the base, and a single-point one does not break the clearance check.
        let points = Probe.selectViaPoints([dot, empty, nan, world(.A, 1200)])
        XCTAssertEqual(points.count, 2)
        XCTAssertTrue(points.allSatisfy { $0.baseRouteId.hasPrefix("A-") })
    }
}

// MARK: - describe('selectViaPoints with live traffic (segmentTraffic)')

final class ProbeTestsWithTraffic: XCTestCase {
    private typealias Fx = ProbeFx

    private func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }
    private func world(_ name: DriveWorld.RouteName, _ durationSec: Double) -> RouteCandidate { Fx.world(name, durationSec) }
    private func withSpans(_ r: RouteCandidate, _ s: [(Double, Double)]) -> RouteCandidate {
        var c = r
        c.limitedAccessSpansM = Fx.spans(s)
        return c
    }

    // it('aims at the middle of the jam, not the middle of the stretch')
    func testSelectViaPointsWithLiveTraffic_aimsAtTheMiddleOfTheJamNotTheMiddleOfTheStretch() throws {
        // Heavy traffic from 3 to 5 km on A's one surface stretch [1, 19] km.
        let candidates = [Fx.jammedA(1200, [(3000, 5000)]), world(.B, 1300), world(.C, 1250)]
        let points = Probe.selectViaPoints(candidates)
        XCTAssertEqual(points.count, 2)
        for p in points {
            let jam = try XCTUnwrap(p.congestedSpanM)
            XCTAssertEqual(jam.startM, 3000, accuracy: 0.5)
            XCTAssertEqual(jam.endM, 5000, accuracy: 0.5)
            XCTAssertEqual(p.atDistanceM, 4000, accuracy: 0.5)
            XCTAssertEqual(p.targetSpanM.startM, 1000, accuracy: 0.5)
            XCTAssertTrue(p.reason.contains("2.0 km jam on surface street (3.0 km to 5.0 km from the start)"), p.reason)
        }
        XCTAssertLessThan(Geo.distanceM(try XCTUnwrap(points.first { $0.side == .left }).position, at(4000, 500)), 2)
        XCTAssertLessThan(Geo.distanceM(try XCTUnwrap(points.first { $0.side == .right }).position, at(4000, -500)), 2)
        Fx.expectWellPlaced(points, candidates)
    }

    // it('takes the congested stretch first, even when another one is longer')
    func testSelectViaPointsWithLiveTraffic_takesTheCongestedStretchFirstEvenWhenAnotherOneIsLonger() throws {
        // A freeway span from 6 to 10 km leaves two surface stretches: [1, 6] km and [10, 19] km.
        let plain = withSpans(world(.A, 1200), [(6000, 10000)])
        // Without traffic data the longer one goes first.
        XCTAssertEqual(try XCTUnwrap(Probe.selectViaPoints([plain], options: ProbeOptions(maxPoints: 1)).first).atDistanceM, 14500, accuracy: 0.5)
        // A severe jam from 2 to 3 km puts the shorter one first.
        let jammed = withSpans(Fx.jammedA(1200, [(2000, 3000)], .severe), [(6000, 10000)])
        let points = Probe.selectViaPoints([jammed], options: ProbeOptions(maxPoints: 4))
        XCTAssertEqual(points.map { ($0.atDistanceM + 0.5).rounded(.down) }, [2500, 14500, 2500, 14500])
        XCTAssertEqual(points.map { $0.congestedSpanM == nil }, [false, true, false, true])
        Fx.expectWellPlaced(points, [jammed])
    }

    // it('orders congested stretches by how much of each is congested')
    func testSelectViaPointsWithLiveTraffic_ordersCongestedStretchesByHowMuchOfEachIsCongested() {
        // 0.5 km jammed on the short stretch, 1 km on the long one.
        let jammed = withSpans(Fx.jammedA(1200, [(2000, 2500), (15000, 16000)]), [(6000, 10000)])
        let points = Probe.selectViaPoints([jammed], options: ProbeOptions(maxPoints: 2))
        XCTAssertEqual(points.map { ($0.atDistanceM + 0.5).rounded(.down) }, [15500, 2250])
    }

    // it('joins jams a short gap apart, and aims at the longest jam of a stretch')
    func testSelectViaPointsWithLiveTraffic_joinsJamsAShortGapApartAndAimsAtTheLongestJamOfAStretch() throws {
        // Heavy at 3–4 km and 4.25–5.5 km, low for the 250 m between.
        let jammed = Fx.jammedA(1200, [(3000, 4000), (4250, 5500)])
        // Default gap (200 m): two jams, the longer one is aimed at.
        let apart = try XCTUnwrap(Probe.selectViaPoints([jammed]).first)
        XCTAssertEqual(try XCTUnwrap(apart.congestedSpanM).startM, 4250, accuracy: 0.5)
        XCTAssertEqual(apart.atDistanceM, 4875, accuracy: 0.5)
        // A 300 m gap joins them into one jam from 3 to 5.5 km.
        let joined = try XCTUnwrap(Probe.selectViaPoints([jammed], options: ProbeOptions(congestionGapM: 300)).first)
        XCTAssertEqual(try XCTUnwrap(joined.congestedSpanM).startM, 3000, accuracy: 0.5)
        XCTAssertEqual(joined.atDistanceM, 4250, accuracy: 0.5)
    }

    // it('counts only the configured levels as congested; moderate and unknown are not jams')
    func testSelectViaPointsWithLiveTraffic_countsOnlyTheConfiguredLevelsAsCongestedModerateAndUnknownAreNotJams() throws {
        let fallback = Fx.placed(Probe.selectViaPoints(Fx.WORLD()))
        for level in [CongestionLevel.moderate, .unknown, .low] {
            let points = Probe.selectViaPoints([Fx.jammedA(1200, [(3000, 5000)], level), world(.B, 1300), world(.C, 1250)])
            XCTAssertEqual(Fx.placed(points), fallback, level.rawValue)
        }
        // Unknown is never a jam, even when it is listed.
        let unknown = Probe.selectViaPoints(
            [Fx.jammedA(1200, [(3000, 5000)], .unknown), world(.B, 1300), world(.C, 1250)],
            options: ProbeOptions(congestedLevels: [.unknown, .heavy, .severe])
        )
        XCTAssertEqual(Fx.placed(unknown), fallback)
        // With moderate counted, the same route is aimed at by the data.
        let moderate = Probe.selectViaPoints(
            [Fx.jammedA(1200, [(3000, 5000)], .moderate)],
            options: ProbeOptions(congestedLevels: [.moderate, .heavy, .severe])
        )
        XCTAssertEqual(try XCTUnwrap(moderate.first).atDistanceM, 4000, accuracy: 0.5)
    }

    // it('ignores a jam shorter than minCongestedM, and one inside the endpoint clearance')
    func testSelectViaPointsWithLiveTraffic_ignoresAJamShorterThanMinCongestedMAndOneInsideTheEndpointClearance() {
        let fallback = Fx.placed(Probe.selectViaPoints(Fx.WORLD()))
        // One 250 m segment of heavy traffic.
        XCTAssertEqual(Fx.placed(Probe.selectViaPoints([Fx.jammedA(1200, [(4000, 4250)]), world(.B, 1300), world(.C, 1250)])), fallback)
        // Heavy for the first and last kilometer only: cut off with the clearance.
        XCTAssertEqual(Fx.placed(Probe.selectViaPoints([Fx.jammedA(1200, [(0, 1000), (19000, 20000)]), world(.B, 1300), world(.C, 1250)])), fallback)
    }

    // it('falls back to the longest stretch, unchanged, when the traffic data is missing or does not fit')
    func testSelectViaPointsWithLiveTraffic_fallsBackToTheLongestStretchUnchangedWhenTheTrafficDataIsMissingOrDoesNotFit() throws {
        let fallback = Fx.placed(Probe.selectViaPoints(Fx.WORLD()))
        XCTAssertTrue(fallback.allSatisfy { $0.congestedSpanM == nil })
        let jammed = Fx.jammedA(1200, [(3000, 5000)])
        let congestion = try XCTUnwrap(jammed.segmentTraffic?.congestion)
        func withTraffic(_ t: SegmentTraffic?) -> RouteCandidate {
            var c = jammed
            c.segmentTraffic = t
            return c
        }
        let variants: [RouteCandidate] = [
            withTraffic(nil),
            // The TS `segmentTraffic: undefined`: Swift has only nil, so this repeats the case above.
            withTraffic(nil),
            withTraffic(SegmentTraffic(congestion: nil, durationSec: nil)),
            // One entry short: it cannot be placed on the line.
            withTraffic(SegmentTraffic(congestion: Array(congestion.dropFirst()), durationSec: nil)),
        ]
        for a in variants {
            XCTAssertEqual(Fx.placed(Probe.selectViaPoints([a, world(.B, 1300), world(.C, 1250)])), fallback)
        }
    }

    // it('counts only congested road toward minCongestedM, not the gaps a jam is joined across')
    func testSelectViaPointsWithLiveTraffic_countsOnlyCongestedRoadTowardMinCongestedMNotTheGapsAJamIsJoinedAcross() throws {
        // Two 250 m segments of heavy traffic 250 m apart: 500 m of jam with the gap, 500 m congested.
        let two = Fx.jammedA(1200, [(4000, 4250), (4500, 4750)])
        let joined = ProbeOptions(congestionGapM: 300)
        XCTAssertNotNil(try XCTUnwrap(Probe.selectViaPoints([two], options: joined).first).congestedSpanM)
        // Raise the bar to 600 m: the joined jam is 750 m long, but only 500 m of it is congested.
        var higher = joined
        higher.minCongestedM = 600
        XCTAssertNil(try XCTUnwrap(Probe.selectViaPoints([two], options: higher).first).congestedSpanM)
    }

    // it('splits a jam across a freeway span into the two stretches it touches')
    func testSelectViaPointsWithLiveTraffic_splitsAJamAcrossAFreewaySpanIntoTheTwoStretchesItTouches() throws {
        // Heavy from 4 to 13 km; the freeway from 6 to 10 km leaves 2 km of it on [1, 6] and 3 km on [10, 19].
        let jammed = withSpans(Fx.jammedA(1200, [(4000, 13000)]), [(6000, 10000)])
        let points = Probe.selectViaPoints([jammed], options: ProbeOptions(maxPoints: 2))
        XCTAssertEqual(try points.map { Fx.rounded(try XCTUnwrap($0.congestedSpanM)) }, [[10000, 13000], [4000, 6000]])
    }

    // it('is deterministic with traffic data too')
    func testSelectViaPointsWithLiveTraffic_isDeterministicWithTrafficDataToo() {
        let candidates = [Fx.jammedA(1200, [(3000, 5000), (12000, 13000)]), world(.B, 1300), world(.C, 1250)]
        XCTAssertEqual(Probe.selectViaPoints(candidates), Probe.selectViaPoints(Array(candidates.reversed())))
    }

    // it('aims at the congested stretch on the Mapbox fixture with annotations')
    func testSelectViaPointsWithLiveTraffic_aimsAtTheCongestedStretchOnTheMapboxFixtureWithAnnotations() throws {
        let candidates = try Fx.fixtureRoutes("directions.congestion.json")
        let points = Probe.selectViaPoints(candidates)
        XCTAssertGreaterThan(points.count, 0)
        // The fastest route's heavy and severe segments are its 2nd and 3rd.
        let base = candidates[0]
        let along = Geo.alongRouteM(base.geometry)
        let clear = ProbeOptions.default.endpointClearanceM
        for p in points {
            XCTAssertEqual(p.baseRouteId, base.id)
            let jam = try XCTUnwrap(p.congestedSpanM)
            XCTAssertEqual(jam.startM, max(along[1], clear), accuracy: 0.5)
            XCTAssertEqual(jam.endM, min(along[3], along[along.count - 1] - clear), accuracy: 0.5)
        }
        Fx.expectWellPlaced(points, candidates)
    }
}

// MARK: - describe('side-street probes during a drive (PLAN step 11c, #5)')

final class ProbeTestsDuringADrive: XCTestCase {
    private typealias Fx = ProbeFx

    private func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }

    /// The car on A, 1 km along: what a check from there returns.
    private var here: LngLat { at(1000, 0) }
    /// Held up: 5 minutes over its typical time, so a check probes.
    private func freshA() -> RouteCandidate { DriveWorld.candidate(.A, here, 1500) { $0.typicalDurationSec = 1200 }! }
    private func freshB() -> RouteCandidate { DriveWorld.candidate(.B, here, 1600)! }
    private lazy var route: RouteCandidate = Fx.world(.A, 1700)

    private func checkProbes(
        route: RouteCandidate? = nil,
        alongM: Double = 1000,
        fresh: [RouteCandidate],
        baseline: [RouteCandidate]? = nil,
        memory: CheckProbeMemory = .initial,
        allowed: Double,
        budget: DriveProbeBudget = .default
    ) -> [LngLat] {
        Probe.checkProbes(CheckProbeInput(
            route: (route ?? self.route).geometry, alongM: alongM, fresh: fresh, baseline: baseline,
            memory: memory, allowed: allowed, budget: budget
        ))
    }

    // it('has one documented budget')
    func testSideStreetProbesDuringADrive_hasOneDocumentedBudget() {
        XCTAssertEqual(DriveProbeBudget.default, DriveProbeBudget(requestsPerCheck: 1, requestsPerDrive: 20, minDelaySec: 120, timeoutSec: 8, losingChecks: 3, rearmSlowdownChange: 0.1))
    }

    // it('holds after 3 losing checks in a row, until the pace ahead changes by 0.1 of the slowdown') (#183)
    func testBackoff_holdsAfter3LossesInARowUntilTheSlowdownAheadChanges() {
        func m(_ losing: Int, _ slowdown: Double?) -> CheckProbeMemory { CheckProbeMemory(losing: losing, losingSlowdown: slowdown) }
        XCTAssertFalse(Probe.probeBackoffHolds(m(2, 1.6), slowdownNow: 1.6))
        XCTAssertTrue(Probe.probeBackoffHolds(m(3, 1.6), slowdownNow: 1.6))
        XCTAssertTrue(Probe.probeBackoffHolds(m(3, 1.6), slowdownNow: 1.69))
        XCTAssertFalse(Probe.probeBackoffHolds(m(3, 1.6), slowdownNow: 1.71))
        XCTAssertFalse(Probe.probeBackoffHolds(m(3, 1.6), slowdownNow: 1.49))
        XCTAssertTrue(Probe.probeBackoffHolds(m(3, 1.6), slowdownNow: 1.51))
        XCTAssertFalse(Probe.probeBackoffHolds(m(3, nil), slowdownNow: 3))
        XCTAssertFalse(Probe.probeBackoffHolds(m(3, nil), slowdownNow: nil))
        XCTAssertTrue(Probe.probeBackoffHolds(m(3, 1.6), slowdownNow: nil))
        XCTAssertFalse(Probe.probeBackoffHolds(m(5, 1.6), slowdownNow: 1.6, budget: DriveProbeBudget(losingChecks: 6)))
    }

    private func plan(fresh: [RouteCandidate]? = nil, route: RouteCandidate? = nil, alongM: Double = 1000, memory: CheckProbeMemory = .initial, allowed: Double = 1) -> CheckProbePlan {
        Probe.checkProbePlan(CheckProbeInput(route: (route ?? self.route).geometry, alongM: alongM, fresh: fresh ?? [freshA(), freshB()], memory: memory, allowed: allowed))
    }

    // describe('checkProbePlan: why a check sends no probe (#183)'), it('each reason, in the order the rules are asked')
    func testCheckProbePlan_eachReasonInTheOrderTheRulesAreAsked() {
        let backedOff = CheckProbeMemory(losing: 3, losingSlowdown: 1.25)
        XCTAssertNil(plan().skipped)
        XCTAssertEqual(plan().points.count, 1)
        XCTAssertEqual(plan(fresh: [], allowed: 0).skipped, .budget)
        XCTAssertEqual(plan(fresh: []).skipped, .routeNotFound)
        XCTAssertEqual(plan(route: Fx.world(.C, 1700), alongM: 9000).skipped, .routeNotFound)
        let onTime = [DriveWorld.candidate(.A, here, 1500) { $0.typicalDurationSec = 1450 }!, freshB()]
        XCTAssertEqual(plan(fresh: onTime).skipped, .notHeldUp)
        XCTAssertEqual(plan(fresh: onTime, memory: backedOff).skipped, .notHeldUp)
        let allFreeway = [DriveWorld.candidate(.A, here, 1500) { $0.typicalDurationSec = 1200; $0.limitedAccessSpansM = [DistanceSpanM(0, 30_000)] }!, freshB()]
        XCTAssertEqual(plan(fresh: allFreeway).skipped, .nothingToProbe)
        XCTAssertEqual(plan(memory: backedOff), CheckProbePlan(points: [], skipped: .backingOff))
        XCTAssertNil(plan(memory: CheckProbeMemory(losing: 3, losingSlowdown: 1.14)).skipped)
        XCTAssertEqual(plan(memory: CheckProbeMemory(losing: 3, losingSlowdown: 1.16)).skipped, .backingOff)
        // The via of a side street being confirmed is asked even when backing off, or with nothing new to probe beside.
        let keep = at(9000, -500)
        XCTAssertEqual(plan(memory: CheckProbeMemory(keep: keep, losing: 3, losingSlowdown: 1.25)), CheckProbePlan(points: [keep], skipped: nil))
        XCTAssertEqual(plan(fresh: allFreeway, memory: CheckProbeMemory(keep: keep)), CheckProbePlan(points: [keep], skipped: nil))
    }

    // MARK: describe('checkProbeAllowance: probes share the drive request budget')

    private func allowance(_ requestsUsed: Double, _ probesUsed: Double, _ maxRequests: Double, _ budget: DriveProbeBudget = .default) -> Int {
        Probe.checkProbeAllowance(requestsUsed: requestsUsed, probesUsed: probesUsed, maxRequests: maxRequests, budget: budget)
    }

    // it('one probe per check, with room left over for the check of the current path')
    func testCheckProbeAllowance_oneProbePerCheckWithRoomLeftOverForTheCheckOfTheCurrentPath() {
        // 60 requests: this check is the 10th.
        XCTAssertEqual(allowance(10, 3, 60), 1)
        // The 59th request: one is left, and it is the path check's.
        XCTAssertEqual(allowance(59, 3, 60), 0)
        XCTAssertEqual(allowance(58, 3, 60), 1)
        XCTAssertEqual(allowance(60, 3, 60), 0)
    }

    // it('stops at the per-drive cap')
    func testCheckProbeAllowance_stopsAtThePerDriveCap() {
        XCTAssertEqual(allowance(30, 19, 60), 1)
        XCTAssertEqual(allowance(30, 20, 60), 0)
        XCTAssertEqual(allowance(30, 25, 60), 0)
    }

    // it('takes a budget of its own, rounded down; under 1 or not a number turns probing off')
    func testCheckProbeAllowance_takesABudgetOfItsOwnRoundedDownUnder1OrNotANumberTurnsProbingOff() {
        XCTAssertEqual(allowance(1, 0, 60, DriveProbeBudget(requestsPerCheck: 2)), 2)
        XCTAssertEqual(allowance(1, 0, 60, DriveProbeBudget(requestsPerCheck: 2.9)), 2)
        XCTAssertEqual(allowance(1, 0, 60, DriveProbeBudget(requestsPerCheck: 0.5)), 0)
        XCTAssertEqual(allowance(1, 0, 60, DriveProbeBudget(requestsPerCheck: .nan)), 0)
        XCTAssertEqual(allowance(1, 0, 60, DriveProbeBudget(requestsPerDrive: 0)), 0)
        XCTAssertEqual(allowance(.nan, 0, 60), 0)
        // Two probes on the 58th request: only one fits before the path check's room.
        XCTAssertEqual(allowance(58, 0, 60, DriveProbeBudget(requestsPerCheck: 2)), 1)
    }

    // MARK: describe('checkProbes: where a check probes')

    // it('beside the route being driven, from the car, by the plan screen rules')
    func testCheckProbes_besideTheRouteBeingDrivenFromTheCarByThePlanScreenRules() {
        let fresh = [freshA(), freshB()]
        let vias = checkProbes(fresh: fresh, allowed: 3)
        XCTAssertEqual(vias, Probe.selectViaPoints(fresh).map(\.position))
        XCTAssertEqual(vias.count, 2)
        // Clear of the car by the endpoint clearance, and of every known route.
        for via in vias {
            XCTAssertGreaterThanOrEqual(Geo.distanceM(via, here), ProbeOptions.default.endpointClearanceM)
            for c in fresh { XCTAssertGreaterThanOrEqual(Fx.lineDistanceM(via, c.geometry), ProbeOptions.default.clearOfRoutesM) }
        }
    }

    // it('beside the route being driven even when another fresh route is faster')
    func testCheckProbes_besideTheRouteBeingDrivenEvenWhenAnotherFreshRouteIsFaster() throws {
        let fresh = [DriveWorld.candidate(.A, here, 1600) { $0.typicalDurationSec = 1300 }!, DriveWorld.candidate(.B, here, 1400)!]
        let vias = checkProbes(fresh: fresh, allowed: 1)
        // Beside A (y = 0), not beside B (1 km north): 500 m to the south, where there is more room.
        let y = Geo.localProjector(at(0, 0))(try XCTUnwrap(vias.first)).y
        XCTAssertEqual(y, -500, accuracy: 5)
        // With the current route not found (and no answer for it), nothing: the engine compares nothing this check,
        // and a probe could come back as the current path and stand in for it.
        XCTAssertEqual(checkProbes(route: Fx.world(.C, 1700), alongM: 9000, fresh: fresh, allowed: 1), [])
    }

    // it('the points take turns, check by check')
    func testCheckProbes_thePointsTakeTurnsCheckByCheck() {
        let fresh = [freshA(), freshB()]
        let all = checkProbes(fresh: fresh, allowed: 3)
        let turn = { (round: Int) in self.checkProbes(fresh: fresh, memory: CheckProbeMemory(round: round), allowed: 1) }
        XCTAssertEqual([turn(0), turn(1), turn(2), turn(3)], [[all[0]], [all[1]], [all[0]], [all[1]]])
    }

    // it('the via of a side street being confirmed comes first, and a point at the same place is not asked twice')
    func testCheckProbes_theViaOfASideStreetBeingConfirmedComesFirstAndAPointAtTheSamePlaceIsNotAskedTwice() {
        let fresh = [freshA(), freshB()]
        let all = checkProbes(fresh: fresh, allowed: 3)
        let keep = at(9000, -500)
        XCTAssertEqual(checkProbes(fresh: fresh, memory: CheckProbeMemory(round: 1, keep: keep), allowed: 1), [keep])
        let two = checkProbes(fresh: fresh, memory: CheckProbeMemory(keep: keep), allowed: 2)
        XCTAssertEqual(two.first, keep)
        XCTAssertEqual(two.count, 2)
        // A kept via right beside one of the points replaces it.
        let near = LngLat(all[0].lng + 0.0001, all[0].lat)
        XCTAssertEqual(checkProbes(fresh: fresh, memory: CheckProbeMemory(keep: near), allowed: 3), [near, all[1]])
    }

    // it('a kept via that is behind the car, too close to it or to the end, or on a known road is dropped')
    func testCheckProbes_aKeptViaThatIsBehindTheCarTooCloseToItOrToTheEndOrOnAKnownRoadIsDropped() {
        let fresh = [freshA(), freshB()]
        let plain = checkProbes(fresh: fresh, allowed: 1)
        let keeping = { (keep: LngLat) in self.checkProbes(fresh: fresh, memory: CheckProbeMemory(keep: keep), allowed: 1) }
        XCTAssertEqual(keeping(at(500, -500)), plain) // behind the car
        XCTAssertEqual(keeping(at(1600, -500)), plain) // within 1 km of it
        XCTAssertEqual(keeping(at(19500, -500)), plain) // within 1 km of the destination
        XCTAssertEqual(keeping(at(9000, 1000)), plain) // on B
        XCTAssertEqual(keeping(LngLat(.nan, 35)), plain)
    }

    // it('nothing when nothing may be asked, there are no routes, or nothing is left to probe')
    func testCheckProbes_nothingWhenNothingMayBeAskedThereAreNoRoutesOrNothingIsLeftToProbe() throws {
        let fresh = [freshA(), freshB()]
        XCTAssertEqual(checkProbes(fresh: fresh, allowed: 0), [])
        XCTAssertEqual(checkProbes(fresh: [], allowed: 1), [])
        // 2.5 km from the end: under the 3 km a probe needs, and a kept via is not asked either.
        let near = try XCTUnwrap(DriveWorld.candidate(.A, at(17500, 0), 400) { $0.typicalDurationSec = 100 })
        XCTAssertEqual(checkProbes(alongM: 17500, fresh: [near], memory: CheckProbeMemory(keep: at(19000, -500)), allowed: 1), [])
    }

    // it('only when the route being driven is held up: a jam reported ahead, or 2 minutes over its typical time')
    func testCheckProbes_onlyWhenTheRouteBeingDrivenIsHeldUpAJamReportedAheadOr2MinutesOverItsTypicalTime() {
        let plain = { (a: RouteCandidate) in self.checkProbes(fresh: [a, self.freshB()], allowed: 1) }
        let a = { (typical: Double?) in DriveWorld.candidate(.A, self.here, 1500) { $0.typicalDurationSec = typical }! }
        XCTAssertEqual(plain(a(1500)), [])
        XCTAssertEqual(plain(a(nil)), [])
        XCTAssertEqual(plain(a(1381)), [])
        XCTAssertEqual(plain(a(1380)).count, 1)
        // A jam Mapbox reports on it ahead, with no delay over the typical time: probed, beside the jam.
        var jammed = a(1500)
        let congestion: [CongestionLevel] = jammed.geometry.dropFirst().indices.map { i -> CongestionLevel in
            let k = i - 1
            return k >= 20 && k < 30 ? .severe : .low
        }
        jammed.segmentTraffic = SegmentTraffic(congestion: congestion, durationSec: nil)
        XCTAssertEqual(plain(jammed).count, 1)
        // The threshold is the budget's.
        XCTAssertEqual(checkProbes(fresh: [a(1450), freshB()], allowed: 1, budget: DriveProbeBudget(minDelaySec: 30)).count, 1)
    }

    // it('keeps clear of the answer for the current path too')
    func testCheckProbes_keepsClearOfTheAnswerForTheCurrentPathToo() {
        // A is not offered; the path check answered with it.
        let vias = checkProbes(fresh: [freshB()], baseline: [freshA()], allowed: 3)
        XCTAssertGreaterThan(vias.count, 0)
        for via in vias { XCTAssertGreaterThanOrEqual(Fx.lineDistanceM(via, freshA().geometry), ProbeOptions.default.clearOfRoutesM) }
    }

    // MARK: describe('mergeCheckProbes')

    // it('adds a new path after the fresh routes, tagged; drops one that is a fresh route or the current path asked for')
    func testMergeCheckProbes_addsANewPathAfterTheFreshRoutesTaggedDropsOneThatIsAFreshRouteOrTheCurrentPathAskedFor() {
        let a = freshA()
        let b = freshB()
        let s = DriveWorld.candidate(.S, here, 1400) { $0.via = DriveWorld.at(9000, -500) }!
        let again = DriveWorld.candidate(.A, here, 1450) { $0.via = DriveWorld.at(9000, 500) }!
        let merged = Probe.mergeCheckProbes([b], [a], [again, s])
        XCTAssertEqual(merged.map(\.id), [b.id, s.id])
        XCTAssertEqual(merged[1].source, .probe)
        XCTAssertEqual(merged[1].via, s.via)
        XCTAssertEqual(Probe.mergeCheckProbes([a, b], nil, []), [a, b])
    }

    // MARK: describe('rememberCheckProbes')

    private func sideStreet() -> RouteCandidate {
        DriveWorld.candidate(.S, here, 1400) { $0.source = .probe; $0.via = DriveWorld.at(9000, -500) }!
    }

    /// The TS `confirming(id)` literal; reason, code and current are not part of it, so they are filled with fixed values.
    private func confirming(_ id: String, _ s: RouteCandidate) -> RerouteDecision {
        RerouteDecision(
            action: .stay,
            toRouteId: nil,
            reason: "",
            code: .confirming,
            considered: RerouteAlternative(routeId: id, savingSec: 200, turnInM: 5000, turnAt: at(6000, 0), requiredLeadM: 400, onFreeway: false),
            current: nil,
            nextState: RerouteState(pending: RerouteState.Pending(geometry: s.geometry, polls: 1))
        )
    }

    // it('keeps the via of the side street being confirmed, and counts the probes')
    func testRememberCheckProbes_keepsTheViaOfTheSideStreetBeingConfirmedAndCountsTheProbes() {
        let s = sideStreet()
        let b = freshB()
        XCTAssertEqual(Probe.rememberCheckProbes(.initial, 1, confirming(s.id, s), [b, s]), CheckProbeMemory(used: 1, round: 1, keep: s.via))
    }

    // it('drops it when the route being confirmed is not a probed one, nothing is pending, or on a switch')
    func testRememberCheckProbes_dropsItWhenTheRouteBeingConfirmedIsNotAProbedOneNothingIsPendingOrOnASwitch() {
        let s = sideStreet()
        let b = freshB()
        let memory = CheckProbeMemory(used: 4, round: 4, keep: s.via)
        XCTAssertNil(Probe.rememberCheckProbes(memory, 1, confirming(b.id, s), [b, s]).keep)
        var none = confirming(s.id, s)
        none.nextState = .initial
        XCTAssertNil(Probe.rememberCheckProbes(memory, 1, none, [b, s]).keep)
        var switched = confirming(s.id, s)
        switched.action = .switchRoute
        XCTAssertNil(Probe.rememberCheckProbes(memory, 1, switched, [b, s]).keep)
    }

    // it('counts a loss only for a side street that came back, was compared like for like and did not hold up (#183)')
    func testRememberCheckProbes_countsALossOnlyForASideStreetComparedLikeForLike() {
        let s = sideStreet()
        let b = freshB()
        let lost = RerouteDecision(action: .stay, toRouteId: nil, reason: "", code: .savingTooSmall, considered: nil, current: nil, probeCompared: true, nextState: .initial)
        let driven = (route: route.geometry, alongM: 1000.0, baseline: [RouteCandidate]?.none, rerouteOptions: RerouteOptions.default)
        let once = Probe.rememberCheckProbes(.initial, 1, lost, [freshA(), b, s], driven: driven)
        XCTAssertEqual([Double(once.losing), once.losingSlowdown ?? -1], [1, 1.25])
        // Nothing compared like for like tells nothing, whatever the code says.
        for code in [RerouteCode.savingTooSmall, .probeUnconfirmed, .noTrafficData, .noEta, .routeUnconfirmed, .currentBest] {
            var d = lost
            d.code = code
            d.probeCompared = false
            XCTAssertEqual(Probe.rememberCheckProbes(once, 1, d, [freshA(), b, s], driven: driven).losing, 1, code.rawValue)
        }
        XCTAssertEqual(Probe.rememberCheckProbes(once, 0, lost, [freshA(), b, s], driven: driven).losing, 1)
        // The slowdown ahead not known: not a loss.
        XCTAssertEqual(Probe.rememberCheckProbes(once, 1, lost, [freshA(), b, s]).losing, 1)
        let untyped = DriveWorld.candidate(.A, here, 1500) { $0.typicalDurationSec = nil }!
        XCTAssertEqual(Probe.rememberCheckProbes(once, 1, lost, [untyped, b, s], driven: driven).losing, 1)
        XCTAssertEqual(Probe.rememberCheckProbes(once, 1, confirming(s.id, s), [b, s]).losing, 0)
    }

    // it('a failed check keeps it, as the engine keeps its confirmation; a check without probes takes no turn')
    func testRememberCheckProbes_aFailedCheckKeepsItAsTheEngineKeepsItsConfirmationACheckWithoutProbesTakesNoTurn() {
        let s = sideStreet()
        let b = freshB()
        let memory = CheckProbeMemory(used: 4, round: 4, keep: s.via)
        let failed = RerouteDecision(action: .stay, toRouteId: nil, reason: "", code: .pollFailed, considered: nil, current: nil, nextState: .initial)
        XCTAssertEqual(Probe.rememberCheckProbes(memory, 0, failed, nil), memory)
        XCTAssertEqual(Probe.rememberCheckProbes(memory, 0, confirming(s.id, s), [b, s]), CheckProbeMemory(used: 4, round: 4, keep: s.via))
    }
}
