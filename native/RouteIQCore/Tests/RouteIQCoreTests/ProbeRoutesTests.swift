import Foundation
import XCTest
import RouteIQCore

// Mirrors tests/probeRoutes.test.ts, assertion for assertion.
// Side-street probing, PLAN step 11b: how many probes a plan may make, and how
// probed routes join the provider's routes. The network (DriveWorld.swift)
// runs 20 km east: A straight, B 1 km north of it, C 1 km south, D further north still.

private enum ProbeRoutesFx {
    typealias RouteName = DriveWorld.RouteName

    static func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }

    static func route(_ name: RouteName, _ durationSec: Double, _ extra: DriveWorld.Patch? = nil) -> RouteCandidate {
        guard let r = DriveWorld.candidate(name, at(0, 0), durationSec, extra) else { preconditionFailure("no route \(name)") }
        return r
    }

    /// Mapbox's three routes: A fastest.
    static func PROVIDER() -> [RouteCandidate] { [route(.A, 1200), route(.B, 1300), route(.C, 1250)] }

    /// The same path as `r` drawn again: a new id, a vertex added in every segment, every point moved by under a meter.
    static func redrawn(_ r: RouteCandidate, _ extra: DriveWorld.Patch? = nil) -> RouteCandidate {
        func nudge(_ p: LngLat, _ k: Int) -> LngLat { LngLat(p.lng + (k % 2 == 0 ? 5e-6 : -5e-6), p.lat + 4e-6) }
        var geometry: [LngLat] = []
        for (i, p) in r.geometry.enumerated() {
            if i > 0 {
                let prev = r.geometry[i - 1]
                geometry.append(nudge(LngLat((prev.lng + p.lng) / 2, (prev.lat + p.lat) / 2), i))
            }
            geometry.append(nudge(p, i + 1))
        }
        var out = r
        out.id = "\(r.id)-probe"
        out.geometry = geometry
        extra?(&out)
        return out
    }

    static func counted(_ r: RouteCandidate, _ n: Int) -> RouteCandidate {
        var c = r
        c.signalCount = n
        c.signalCoverage = .full
        return c
    }

    static let freewayFrom8To12: DriveWorld.Patch = { $0.limitedAccessSpansM = [DistanceSpanM(8000, 12000)] }
}

final class ProbeRoutesTests: XCTestCase {
    private typealias Fx = ProbeRoutesFx

    private func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }
    private func route(_ name: DriveWorld.RouteName, _ durationSec: Double, _ extra: DriveWorld.Patch? = nil) -> RouteCandidate {
        Fx.route(name, durationSec, extra)
    }

    // MARK: - describe('DEFAULT_PROBE_BUDGET')

    // it('allows two probe requests per plan, sent 800 ms after the main routes settle')
    func testDefaultProbeBudget_allowsTwoProbeRequestsPerPlanSent800msAfterTheMainRoutesSettle() {
        XCTAssertEqual(ProbeBudget.default, ProbeBudget(requestsPerPlan: 2, debounceMs: 800))
    }

    // MARK: - describe('planProbes')

    // it('spends at most the budget, taking selectViaPoints in its order')
    func testPlanProbes_spendsAtMostTheBudgetTakingSelectViaPointsInItsOrder() {
        // A freeway from 8 to 12 km leaves two surface stretches: four points on offer.
        let split = [route(.A, 1200, Fx.freewayFrom8To12)]
        let all = Probe.selectViaPoints(split, options: ProbeOptions(maxPoints: 10))
        XCTAssertEqual(all.count, 4)
        XCTAssertEqual(Probe.planProbes(split), Array(all.prefix(Int(ProbeBudget.default.requestsPerPlan))))
        XCTAssertEqual(Probe.planProbes(split, budget: ProbeBudget(requestsPerPlan: 1)), Array(all.prefix(1)))
        XCTAssertEqual(Probe.planProbes(split, budget: ProbeBudget(requestsPerPlan: 2.9)).count, 2)
    }

    // it('never goes past ProbeOptions.maxPoints, whatever the budget')
    func testPlanProbes_neverGoesPastProbeOptionsMaxPointsWhateverTheBudget() {
        let split = [route(.A, 1200, Fx.freewayFrom8To12)]
        XCTAssertEqual(Probe.planProbes(split, budget: ProbeBudget(requestsPerPlan: 10)).count, ProbeOptions.default.maxPoints)
    }

    // it('makes no request when the budget is under one, or not a finite number')
    func testPlanProbes_makesNoRequestWhenTheBudgetIsUnderOneOrNotAFiniteNumber() {
        for requestsPerPlan in [0, -1, 0.5, Double.nan, Double.infinity] {
            XCTAssertEqual(Probe.planProbes(Fx.PROVIDER(), budget: ProbeBudget(requestsPerPlan: requestsPerPlan)), [], "\(requestsPerPlan)")
        }
    }

    // it('makes no request for a freeway-only trip, a short trip or no routes')
    func testPlanProbes_makesNoRequestForAFreewayOnlyTripAShortTripOrNoRoutes() {
        XCTAssertEqual(Probe.planProbes([route(.A, 900) { $0.limitedAccessSpansM = [DistanceSpanM(0, 20000)] }]), [])
        // Surface ends at the ramps fall inside the endpoint clearance: still freeway-only.
        XCTAssertEqual(Probe.planProbes([route(.A, 900) { $0.limitedAccessSpansM = [DistanceSpanM(800, 19200)] }]), [])
        XCTAssertEqual(Probe.planProbes([route(.A, 1200)], budget: .default, options: ProbeOptions(minTripM: 25_000)), [])
        XCTAssertEqual(Probe.planProbes([]), [])
    }

    // it('is deterministic')
    func testPlanProbes_isDeterministic() {
        let provider = Fx.PROVIDER()
        XCTAssertEqual(Probe.planProbes(provider), Probe.planProbes(Array(provider.reversed())))
        XCTAssertEqual(Probe.planProbes(provider).count, 2)
    }

    // MARK: - describe('mergeProbeRoutes')

    // it('adds a new path, tagged probe, after the provider routes, which stay as they came')
    func testMergeProbeRoutes_addsANewPathTaggedProbeAfterTheProviderRoutesWhichStayAsTheyCame() {
        let provider = Fx.PROVIDER()
        let d = route(.D, 1400)
        let merged = Probe.mergeProbeRoutes(provider, [d])
        XCTAssertEqual(Array(merged.prefix(3)), provider)
        XCTAssertTrue(merged.prefix(3).allSatisfy { $0.source == nil })
        XCTAssertEqual(merged.count, 4)
        var tagged = d
        tagged.source = .probe
        XCTAssertEqual(merged[3], tagged)
    }

    // it('drops a probe that snapped back onto a known route, matched by path and not by id')
    func testMergeProbeRoutes_dropsAProbeThatSnappedBackOntoAKnownRouteMatchedByPathAndNotById() {
        let provider = Fx.PROVIDER()
        let again = Fx.redrawn(provider[0])
        XCTAssertNotEqual(again.id, provider[0].id)
        XCTAssertEqual(Probe.mergeProbeRoutes(provider, [again]), provider)
        // A faster ETA does not save it: it is still the same roads.
        XCTAssertEqual(Probe.mergeProbeRoutes(provider, [Fx.redrawn(provider[1]) { $0.durationSec = 100 }]), provider)
    }

    // it('keeps a path that leaves a known route for only a short loop')
    func testMergeProbeRoutes_keepsAPathThatLeavesAKnownRouteForOnlyAShortLoop() {
        // E is A with a 300 m loop north near the end: different roads, so a different route.
        let merged = Probe.mergeProbeRoutes(Fx.PROVIDER(), [route(.E, 1260)])
        XCTAssertEqual(merged.count, 4)
        XCTAssertEqual(merged[3].source, .probe)
    }

    // it('keeps only the first of two probes on the same path')
    func testMergeProbeRoutes_keepsOnlyTheFirstOfTwoProbesOnTheSamePath() {
        let d = route(.D, 1400)
        let merged = Probe.mergeProbeRoutes(Fx.PROVIDER(), [d, Fx.redrawn(d) { $0.durationSec = 1100 }])
        XCTAssertEqual(merged.count, 4)
        XCTAssertEqual(merged[3].id, d.id)
    }

    // it('drops a probe with no usable travel time or line')
    func testMergeProbeRoutes_dropsAProbeWithNoUsableTravelTimeOrLine() {
        let d = route(.D, 1400)
        func changed(_ patch: DriveWorld.Patch) -> RouteCandidate {
            var c = d
            patch(&c)
            return c
        }
        let bad = [
            changed { $0.durationSec = .nan },
            changed { $0.durationSec = .infinity },
            changed { $0.geometry = [d.geometry[0]] },
            changed { $0.geometry = Array(d.geometry.prefix(3)) + [LngLat(.nan, 35)] },
        ]
        let provider = Fx.PROVIDER()
        XCTAssertEqual(Probe.mergeProbeRoutes(provider, bad), provider)
    }

    // it('drops a dead-end spur: the known route with an out-and-back to the via')
    func testMergeProbeRoutes_dropsADeadEndSpurTheKnownRouteWithAnOutAndBackToTheVia() {
        // A as far as 10 km, 500 m north up a dead end and back, then on along A.
        let provider = Fx.PROVIDER()
        let a = provider[0]
        var spur = a
        spur.id = "A-spur"
        spur.durationSec = 1320
        spur.geometry = [at(0, 0), at(5000, 0), at(10_000, 0), at(10_000, 500), at(10_000, 0), at(15_000, 0), at(20_000, 0)]
        XCTAssertTrue(Probe.coversRoute(spur.geometry, a.geometry))
        XCTAssertEqual(Probe.mergeProbeRoutes(provider, [spur]), provider)
    }

    // it('keeps a cut-through that leaves a known route along a segment with no vertices of its own')
    func testMergeProbeRoutes_keepsACutThroughThatLeavesAKnownRouteAlongASegmentWithNoVerticesOfItsOwn() {
        // The known route is one straight segment, start to end: its two vertices are both on E's line.
        var straight = route(.A, 1200)
        straight.geometry = [at(0, 0), at(20_000, 0)]
        let e = route(.E, 1260)
        // Sampled every 10 m, A's stretch under E's loop (18.5 to 19.5 km) is not on E.
        XCTAssertFalse(Probe.coversRoute(e.geometry, straight.geometry))
        // Its vertices alone would have taken E for "A plus a detour".
        XCTAssertTrue(Probe.coversRoute(e.geometry, straight.geometry, toleranceM: 10, sampleM: 0))
        let merged = Probe.mergeProbeRoutes([straight], [e])
        XCTAssertEqual(merged.count, 2)
        XCTAssertEqual(merged[1].source, .probe)
    }

    // it('samples every 10 m (DEFAULT_PROBE_OPTIONS.coverSampleM) and snaps the via within 250 m (viaRadiusM)')
    func testMergeProbeRoutes_samplesEvery10mAndSnapsTheViaWithin250m() {
        XCTAssertEqual(ProbeOptions.default.coverSampleM, 10)
        XCTAssertEqual(ProbeOptions.default.viaRadiusM, 250)
        // No farther than clearOfRoutesM: a via can never snap back onto a known route.
        XCTAssertLessThanOrEqual(ProbeOptions.default.viaRadiusM, ProbeOptions.default.clearOfRoutesM)
    }

    // it('with no probes is the provider routes')
    func testMergeProbeRoutes_withNoProbesIsTheProviderRoutes() {
        let provider = Fx.PROVIDER()
        XCTAssertEqual(Probe.mergeProbeRoutes(provider, []), provider)
        XCTAssertEqual(Probe.mergeProbeRoutes([], [route(.D, 1400)]).count, 1)
    }

    // MARK: - describe('probed routes are ranked by the same ETA-first rules')

    // it('a probed route that is faster wins')
    func testProbedRoutesAreRanked_aProbedRouteThatIsFasterWins() {
        let merged = Probe.mergeProbeRoutes(Fx.PROVIDER(), [route(.D, 1100)])
        let ranked = Rank.rankRoutes(merged)
        XCTAssertEqual(ranked[0].route.source, .probe)
        XCTAssertEqual(ranked[0].reasons, ["Fastest right now"])
        XCTAssertEqual(Rank.recommendedRouteId(merged), merged[3].id)
    }

    // it('a probed route that is slower is not recommended, and says by how much')
    func testProbedRoutesAreRanked_aProbedRouteThatIsSlowerIsNotRecommendedAndSaysByHowMuch() throws {
        let merged = Probe.mergeProbeRoutes(Fx.PROVIDER(), [route(.D, 1400)])
        let ranked = Rank.rankRoutes(merged)
        XCTAssertNil(ranked[0].route.source)
        let last = try XCTUnwrap(ranked.last)
        XCTAssertEqual(last.route.source, .probe)
        XCTAssertEqual(last.reasons, ["3 min slower than the fastest"])
    }

    // it('within 30 s, fewer known signals decide, for a probe as for any route; outside it, signals never do')
    func testProbedRoutesAreRanked_within30sFewerKnownSignalsDecideForAProbeAsForAnyRouteOutsideItSignalsNeverDo() {
        let provider = Fx.PROVIDER().map { Fx.counted($0, 12) }
        let tied = Probe.mergeProbeRoutes(provider, [Fx.counted(route(.D, 1230), 4)])
        XCTAssertEqual(Rank.rankRoutes(tied)[0].route.source, .probe)
        let behind = Probe.mergeProbeRoutes(provider, [Fx.counted(route(.D, 1231), 0)])
        XCTAssertNil(Rank.rankRoutes(behind)[0].route.source)
    }

    // MARK: - describe('sideStreetNotice (the polite announcement when a probe takes the top spot)')

    private func notice(_ probe: RouteCandidate, _ provider: [RouteCandidate] = Fx.PROVIDER()) -> String? {
        Probe.sideStreetNotice(Rank.rankRoutes(Probe.mergeProbeRoutes(provider, [probe])))
    }

    // it('says how much a recommended side street saves against the best provider route, in whole minutes')
    func testSideStreetNotice_saysHowMuchARecommendedSideStreetSavesAgainstTheBestProviderRouteInWholeMinutes() {
        // Against A at 1200 s: 120 s is 2 min, 100 s rounds to 2, 80 s to 1.
        XCTAssertEqual(notice(route(.D, 1080)), "Faster route found via side streets, saves 2 min.")
        XCTAssertEqual(notice(route(.D, 1100)), "Faster route found via side streets, saves 2 min.")
        XCTAssertEqual(notice(route(.D, 1120)), "Faster route found via side streets, saves 1 min.")
    }

    // it('says under a minute for a small saving, and never calls a tie-break win faster')
    func testSideStreetNotice_saysUnderAMinuteForASmallSavingAndNeverCallsATieBreakWinFaster() {
        XCTAssertEqual(notice(route(.D, 1180)), "Faster route found via side streets, saves under a minute.")
        let tied = Rank.rankRoutes(Probe.mergeProbeRoutes(Fx.PROVIDER().map { Fx.counted($0, 12) }, [Fx.counted(route(.D, 1220), 4)]))
        XCTAssertEqual(tied[0].route.source, .probe)
        XCTAssertEqual(Probe.sideStreetNotice(tied), "Route via side streets recommended: about the same time, fewer signals.")
    }

    // it('claims no fewer signals for a probe that leads on distance while its count is unknown')
    func testSideStreetNotice_claimsNoFewerSignalsForAProbeThatLeadsOnDistanceWhileItsCountIsUnknown() {
        // Same ETA as A, shorter, signals not counted yet: first on distance, but nothing is known about its signals.
        let a = Fx.PROVIDER()[0]
        var shorter = route(.D, 1200)
        shorter.distanceM = a.distanceM - 500
        let ranked = Rank.rankRoutes(Probe.mergeProbeRoutes(Fx.PROVIDER(), [shorter]))
        XCTAssertEqual(ranked[0].route.source, .probe)
        XCTAssertEqual(Probe.sideStreetNotice(ranked), "Route via side streets recommended: about the same time.")
    }

    // it('says nothing when the top route is the provider’s own, or there is none to compare with')
    func testSideStreetNotice_saysNothingWhenTheTopRouteIsTheProvidersOwnOrThereIsNoneToCompareWith() {
        XCTAssertNil(notice(route(.D, 1400)))
        XCTAssertNil(Probe.sideStreetNotice(Rank.rankRoutes(Fx.PROVIDER())))
        XCTAssertNil(Probe.sideStreetNotice([]))
        XCTAssertNil(notice(route(.D, 1400), []))
    }
}

// MARK: - describe('comparing long routes (#93)')

// #93: comparing a probed route with the known ones measured every vertex of one line against
// every segment of the other. The comparison now walks along the line and looks further only on
// a miss (Select.everyPointNear). These tests say that the answers are those of the old
// point-by-point comparison, kept here as the reference, and that the work stays linear.
final class ComparingLongRoutesTests: XCTestCase {
    typealias Corner = (x: Double, y: Double)

    /// The comparison before #93, verbatim: every point against every segment.
    static func nearAll(_ points: [XY], _ line: [XY], _ toleranceM: Double) -> Bool {
        points.allSatisfy { p in
            for i in stride(from: 1, to: line.count, by: 1) where Geo.pointToSegment(p, line[i - 1], line[i]).distanceM <= toleranceM { return true }
            return false
        }
    }

    static func oldSameRoute(_ a: [LngLat], _ b: [LngLat], _ toleranceM: Double) -> Bool {
        let lineA = a.filter(Geo.isValidLngLat)
        let lineB = b.filter(Geo.isValidLngLat)
        if lineA.count < 2 || lineB.count < 2 { return false }
        let box = try! Geo.boundsOf(lineA)
        let project = Geo.localProjector(LngLat((box.west + box.east) / 2, (box.south + box.north) / 2))
        let xyA = lineA.map(project)
        let xyB = lineB.map(project)
        func apart(_ p: XY, _ q: XY) -> Double { hypot(p.x - q.x, p.y - q.y) }
        if apart(xyA[0], xyB[0]) > toleranceM || apart(xyA[xyA.count - 1], xyB[xyB.count - 1]) > toleranceM { return false }
        return nearAll(xyA, xyB, toleranceM) && nearAll(xyB, xyA, toleranceM)
    }

    static func oldCovers(_ probe: [LngLat], _ known: [LngLat], _ toleranceM: Double, _ sampleM: Double) -> Bool {
        if probe.count < 2 || known.count < 2 { return false }
        let project = Geo.localProjector(known[0])
        var samples: [LngLat] = []
        for (i, p) in known.enumerated() {
            if i > 0, sampleM.isFinite, sampleM > 0 {
                let prev = known[i - 1]
                let pieces = (Geo.distanceM(prev, p) / sampleM).rounded(.up)
                var k = 1.0
                while k < pieces {
                    samples.append(LngLat(prev.lng + (p.lng - prev.lng) * k / pieces, prev.lat + (p.lat - prev.lat) * k / pieces))
                    k += 1
                }
            }
            samples.append(p)
        }
        return nearAll(samples.map(project), probe.map(project), toleranceM)
    }

    /// A seeded random number from 0 to 1 (the same every run), in JavaScript double arithmetic.
    static func rng(_ seed: Double) -> () -> Double {
        var s = seed
        return {
            s = (s * 1_103_515_245 + 12_345).truncatingRemainder(dividingBy: 2_147_483_648)
            return s / 2_147_483_648
        }
    }

    static func lngLat(_ xy: [Corner]) -> [LngLat] { xy.map { DriveWorld.at($0.x, $0.y) } }

    /// A winding road from the origin, `n` vertices 5 to 60 m apart.
    static func road(_ random: () -> Double, _ n: Int) -> [Corner] {
        var out: [Corner] = [(0, 0)]
        var heading = random() * 2 * Double.pi
        for i in stride(from: 1, to: n, by: 1) {
            heading += (random() - 0.5) * 1.2
            let step = 5 + random() * 55
            let (x, y) = out[i - 1]
            out.append((x + cos(heading) * step, y + sin(heading) * step))
        }
        return out
    }

    /// Ways the same road, or nearly the same, comes back, some within a meter or two of the tolerance.
    static func variants(_ random: () -> Double, _ base: [Corner]) -> [[Corner]] {
        func jitter(_ m: Double) -> [Corner] { base.map { ($0.x + (random() - 0.5) * m, $0.y + (random() - 0.5) * m) } }
        func shifted(_ m: Double) -> [Corner] { base.map { ($0.x + m, $0.y) } }
        var densified: [Corner] = []
        for (i, p) in base.enumerated() {
            densified.append(p)
            if i + 1 < base.count {
                let q = base[i + 1]
                densified.append(((p.x + q.x) / 2 + (random() - 0.5), (p.y + q.y) / 2 + (random() - 0.5)))
            }
        }
        let from = base.count / 3
        let to = (2 * base.count) / 3
        func detour(_ m: Double) -> [Corner] { base.enumerated().map { i, c in i >= from && i <= to ? (c.x, c.y + m) : c } }
        let spur: [Corner] = Array(base[..<to]) + [1.0, 2, 3, 4, 3, 2, 1].map { k in (base[to].x + k * 40, base[to].y + k * 40) } + Array(base[to...])
        // Evaluated in the TS array order, so the random draws come in the same order.
        let j2 = jitter(2)
        let j19 = jitter(19)
        let s95 = shifted(9.5)
        let s105 = shifted(10.5)
        return [
            base, j2, j19, s95, s105, densified,
            base.enumerated().filter { $0.offset % 3 != 1 || $0.offset == base.count - 1 }.map(\.element),
            detour(8), detour(14), detour(200), spur, base.reversed(), Array(base[..<to]), road(random, base.count),
        ]
    }

    // it('gives the same answers as the point-by-point comparison')
    func testComparingLongRoutes_givesTheSameAnswersAsThePointByPointComparison() {
        let random = Self.rng(93)
        var compared = 0
        var same = 0
        var covered = 0
        for _ in 0..<4 {
            let base = Self.road(random, 30 + Int((random() * 50).rounded(.down)))
            let lines = Self.variants(random, base).map(Self.lngLat)
            for a in lines {
                for b in lines {
                    for toleranceM in [5, Select.sameRouteToleranceM, 30] {
                        let wasSame = Self.oldSameRoute(a, b, toleranceM)
                        XCTAssertEqual(Select.sameRouteGeometry(a, b, toleranceM: toleranceM), wasSame)
                        if wasSame { same += 1 }
                        for sampleM in [0, ProbeOptions.default.coverSampleM] {
                            let wasCovered = Self.oldCovers(a, b, toleranceM, sampleM)
                            XCTAssertEqual(Probe.coversRoute(a, b, toleranceM: toleranceM, sampleM: sampleM), wasCovered)
                            if wasCovered { covered += 1 }
                        }
                        compared += 1
                    }
                }
            }
        }
        // Both answers come up often enough for the comparison to mean something.
        XCTAssertEqual(compared, 4 * 14 * 14 * 3)
        XCTAssertGreaterThan(same, compared / 10)
        XCTAssertLessThan(same, compared / 2)
        XCTAssertGreaterThan(covered, compared / 5)
        XCTAssertLessThan(covered, compared)
    }

    // A 100 km plan, 5000 vertices a route: three routes from the provider, two probes that
    // came back on two of them and one new side street.
    static let lineA: [Corner] = road(rng(7), 5000)
    static let lineB: [Corner] = lineA.enumerated().map { i, c in i > 1500 && i < 3500 ? (c.x, c.y + 1000) : c }
    static let lineC: [Corner] = lineA.enumerated().map { i, c in i > 1000 && i < 4000 ? (c.x, c.y - 800) : c }
    static let lineS: [Corner] = lineA.enumerated().map { i, c in i > 2000 && i < 2400 ? (c.x, c.y - 300) : c }

    static func asRoute(_ id: String, _ xy: [Corner], _ durationSec: Double) -> RouteCandidate {
        var r = DriveWorld.candidate(.A, DriveWorld.at(0, 0), durationSec)!
        r.id = id
        r.geometry = lngLat(xy)
        r.distanceM = Geo.alongRouteM(r.geometry).last ?? 0
        r.maneuvers = []
        return r
    }

    static let known = [asRoute("a", lineA, 5000), asRoute("b", lineB, 5100), asRoute("c", lineC, 5200)]
    static let backOnKnown = [
        asRoute("probe-b", lineB.map { ($0.x + 2, $0.y - 1) }, 5150),
        asRoute("probe-c", lineC.map { ($0.x - 1, $0.y + 2) }, 5250),
    ]
    static let sideStreet = asRoute("probe-s", lineS, 4900)
    static let vertices = 6 * 5000

    static func shuffled(_ seed: Double) -> [XY] {
        var out = lineA.map { XY($0.x, $0.y) }
        let pick = rng(seed)
        var i = out.count - 1
        while i > 0 {
            let j = Int((pick() * Double(i + 1)).rounded(.down))
            out.swapAt(i, j)
            i -= 1
        }
        return out
    }

    // it('a 100 km plan: linear work, at most 10 checks a vertex (about 5.6 now)')
    func testComparingLongRoutes_a100kmPlanLinearWorkAtMost10ChecksAVertex() {
        let meter = MatchMeter()
        let merged = Probe.mergeProbeRoutes(Self.known, Self.backOnKnown + [Self.sideStreet], toleranceM: Select.sameRouteToleranceM, coverSampleM: ProbeOptions.default.coverSampleM, meter: meter)
        XCTAssertEqual(merged.map(\.id), ["a", "b", "c", "probe-s"])
        // The comparison before #93 measured every vertex against every segment: millions here.
        XCTAssertLessThanOrEqual(meter.segmentChecks + meter.gridEntries, 10 * Self.vertices)
    }

    // it('a probe drawn the other way: still linear')
    func testComparingLongRoutes_aProbeDrawnTheOtherWayStillLinear() {
        let meter = MatchMeter()
        let reversed = Array(Self.known[0].geometry.reversed())
        XCTAssertTrue(Probe.coversRoute(reversed, Self.known[0].geometry, toleranceM: Select.sameRouteToleranceM, sampleM: ProbeOptions.default.coverSampleM, meter: meter))
        XCTAssertLessThanOrEqual(meter.segmentChecks + meter.gridEntries, 25 * 5000)
    }

    // it('points in no order along the line: the grid takes over, still linear')
    func testComparingLongRoutes_pointsInNoOrderAlongTheLineTheGridTakesOverStillLinear() {
        let meter = MatchMeter()
        let line = Self.lineA.map { XY($0.x, $0.y) }
        let shuffled = Self.shuffled(11)
        XCTAssertTrue(Select.everyPointNear(shuffled, line, Select.sameRouteToleranceM, meter))
        XCTAssertFalse(Select.everyPointNear(shuffled + [XY(0, 500)], line, Select.sameRouteToleranceM))
        XCTAssertGreaterThan(meter.gridEntries, 0)
        XCTAssertLessThanOrEqual(meter.segmentChecks + meter.gridEntries, 30 * 5000)
    }

    // it('once the grid has taken over, a point just past the tolerance is still off the line')
    func testComparingLongRoutes_onceTheGridHasTakenOverAPointJustPastTheToleranceIsStillOffTheLine() {
        // The grid only picks which segments to measure; it must give the same answer as measuring
        // every segment, right at the tolerance, or a route 1 m off another is taken for it.
        let line = Self.lineA.map { XY($0.x, $0.y) }
        let shuffled = Self.shuffled(13)
        func nearest(_ p: XY) -> Double {
            (1..<line.count).reduce(Double.infinity) { min($0, Geo.pointToSegment(p, line[$1 - 1], line[$1]).distanceM) }
        }
        var answers: [Bool] = []
        for overM in [-0.5, 0.5, 1, 2, 4] {
            for i in [500, 1500, 2500, 3500, 4500] {
                let p = XY(line[i].x, line[i].y + Select.sameRouteToleranceM + overM)
                let expected = nearest(p) <= Select.sameRouteToleranceM
                // The shuffled line first, so that the walk has missed often enough for the grid to answer p.
                XCTAssertEqual(Select.everyPointNear(shuffled + [p], line, Select.sameRouteToleranceM), expected, "\(overM) m over at \(i)")
                answers.append(expected)
            }
        }
        XCTAssertTrue(answers.contains(true))
        XCTAssertTrue(answers.contains(false))
    }

    // it('counting changes nothing: the same answer with or without a meter')
    func testComparingLongRoutes_countingChangesNothingTheSameAnswerWithOrWithoutAMeter() {
        XCTAssertEqual(Probe.mergeProbeRoutes(Self.known, Self.backOnKnown + [Self.sideStreet]).map(\.id), ["a", "b", "c", "probe-s"])
    }
}
