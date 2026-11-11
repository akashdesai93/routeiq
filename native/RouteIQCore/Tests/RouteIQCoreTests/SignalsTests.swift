import Foundation
import XCTest
import RouteIQCore

// Mirrors tests/signals.test.ts: the signalsOnRoute, limited-access spans,
// clusterSignals, rule (c), withSignalCounts (three describes),
// geometryHash/routeIdFromGeometry and sameRouteGeometry/resolveSelectedId
// describes. The signalFeatures describe and the one "map draws it once"
// assertion are map-layer code, not core, and are not mirrored here. The geo
// helpers and formatSignalCount describes are covered by GeoTests and FormatTests.
//
// Test method names are test_<describe>_<it>. toBeCloseTo(v, d) becomes
// XCTAssertEqual(a, v, accuracy: 0.5 * 10^-d).
final class SignalsTests: XCTestCase {
    // MARK: - Helpers (as in the TS test file)

    // Test geometry is laid out in meters around a point in Charlotte, then turned
    // into coordinates, so distances in the tests read as what they are.
    private var here: LngLat { LngLat(-80.84, 35.2) }
    private var mPerDegree: Double { (6_371_008.8 * Double.pi) / 180 }
    private var mPerDegreeLng: Double { mPerDegree * cos((here.lat * Double.pi) / 180) }

    /// The point `eastM` meters east and `northM` meters north of HERE.
    private func at(_ eastM: Double, _ northM: Double) -> LngLat {
        LngLat(here.lng + eastM / mPerDegreeLng, here.lat + northM / mPerDegree)
    }

    private func signal(_ id: String, _ eastM: Double, _ northM: Double) -> SignalPoint {
        SignalPoint(id: id, position: at(eastM, northM), name: "signal \(id)")
    }

    /// One kilometer due north from HERE.
    private var north1km: [LngLat] { [at(0, 0), at(0, 1000)] }

    private func route(_ id: String, _ geometry: [LngLat], _ durationSec: Double = 600) -> RouteCandidate {
        RouteCandidate(
            id: id,
            geometry: geometry,
            durationSec: durationSec,
            typicalDurationSec: nil,
            distanceM: 1000,
            signalCount: nil,
            signalCoverage: SignalCoverage.none,
            providerSignalCount: nil,
            intersections: nil,
            limitedAccessSpansM: nil,
            maneuvers: []
        )
    }

    /// Signal data with the primary tiles loaded for every one of the given routes.
    private func loadedFor(_ routes: [RouteCandidate], _ primary: [SignalPoint], _ gapFill: [SignalPoint]? = nil) -> SignalData {
        SignalData(
            primary: primary,
            primaryTileIds: Set(routes.flatMap { Signals.signalTilesForRoute($0.geometry) }),
            gapFill: gapFill
        )
    }

    private func ids(_ found: RouteSignals) -> [String] {
        found.signals.map(\.id)
    }

    /// TS `[r.signalCount, r.signalCoverage]`.
    private struct CountAndCoverage: Equatable, CustomStringConvertible {
        let count: Int?
        let coverage: SignalCoverage
        var description: String { "[\(count.map { String($0) } ?? "null"), \(coverage.rawValue)]" }
    }

    private func cc(_ count: Int?, _ coverage: SignalCoverage) -> CountAndCoverage {
        CountAndCoverage(count: count, coverage: coverage)
    }

    private func countAndCoverage(_ r: RouteCandidate) -> CountAndCoverage {
        CountAndCoverage(count: r.signalCount, coverage: r.signalCoverage)
    }

    private func isLowerHex16(_ s: String) -> Bool {
        s.count == 16 && s.allSatisfy { "0123456789abcdef".contains($0) }
    }

    // MARK: - describe('signalsOnRoute')

    func test_signalsOnRoute_documentsItsDefaultsInOnePlace() {
        // The three rule distances (group 60 m, route 30 m, intersection 40 m), then the
        // gap-fill distance, the along-route merge and the freeway margin.
        let d = SignalMatchOptions.default
        XCTAssertEqual(d, SignalMatchOptions(
            clusterRadiusM: 60,
            toleranceM: 30,
            intersectionRadiusM: 40,
            gapFillRadiusM: 60,
            mergeRadiusM: 40,
            limitedAccessMarginM: 30
        ))
        XCTAssertEqual(d.clusterRadiusM, 60)
        XCTAssertEqual(d.toleranceM, 30)
        XCTAssertEqual(d.intersectionRadiusM, 40)
        XCTAssertEqual(d.gapFillRadiusM, 60)
        XCTAssertEqual(d.mergeRadiusM, 40)
        XCTAssertEqual(d.limitedAccessMarginM, 30)
    }

    func test_signalsOnRoute_countsAPointJustInsideTheToleranceAndNotOneJustOutside() {
        // The tolerance is 30 m now (it was 20 m when the city list was the only source).
        let inside = signal("inside", 29.9, 300)
        let outside = signal("outside", -30.1, 700)
        let found = Signals.signalsOnRoute(north1km, [outside, inside])
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.signals.count, 1)
        guard let only = found.signals.first else { return XCTFail("no signal found") }
        XCTAssertEqual(only.id, "inside")
        XCTAssertEqual(only.name, "signal inside")
        XCTAssertEqual(only.position, inside.position)
        XCTAssertEqual(only.source, SignalSource.primary)
        XCTAssertEqual(only.offsetM, 29.9, accuracy: 0.05)
        XCTAssertEqual(only.atDistanceM, 300, accuracy: 0.5)
        XCTAssertEqual(only.mergedIds, ["inside"])
    }

    func test_signalsOnRoute_appliesTheTolerancePastTheEndsOfTheRouteToo() {
        // The one that is too far is also far from the others, so grouping plays no part.
        let justPastEnd = signal("past-end", 0, 1029)
        let tooFarPastEnd = signal("too-far", 0, 1100)
        let beforeStart = signal("before-start", 0, -29)
        let found = Signals.signalsOnRoute(north1km, [justPastEnd, tooFarPastEnd, beforeStart])
        XCTAssertEqual(ids(found), ["before-start", "past-end"])
        guard found.signals.count == 2 else { return XCTFail("expected two signals") }
        XCTAssertEqual(found.signals[0].atDistanceM, 0)
        XCTAssertEqual(found.signals[1].atDistanceM, 1000, accuracy: 0.5)
    }

    func test_signalsOnRoute_honorsTheToleranceItIsGiven() {
        let s = [signal("a", 40, 500)]
        XCTAssertEqual(Signals.signalsOnRoute(north1km, s).count, 0)
        XCTAssertEqual(Signals.signalsOnRoute(north1km, s, options: SignalMatchOptions(toleranceM: 45)).count, 1)
        // Zero, negative or NaN means "exactly on the line", never "anywhere".
        let tolerances: [Double] = [0, -5, Double.nan]
        for toleranceM in tolerances {
            let options = SignalMatchOptions(toleranceM: toleranceM, mergeRadiusM: 40)
            XCTAssertEqual(Signals.signalsOnRoute(north1km, [signal("near", 1, 600)], options: options).count, 0, "toleranceM \(toleranceM)")
        }
    }

    func test_signalsOnRoute_countsDuplicateSignalPointsAtOneIntersectionOnce() {
        // Two heads of the same intersection, on either side of the road, 5 m apart along it.
        let east = signal("east", 12, 400)
        let west = signal("west", -8, 405)
        let next = signal("next", 3, 470)
        let found = Signals.signalsOnRoute(north1km, [east, next, west])
        XCTAssertEqual(found.count, 2)
        guard found.signals.count == 2 else { return XCTFail("expected two signals") }
        let first = found.signals[0]
        let second = found.signals[1]
        // The two heads are grouped first (rule a): the entry is the group, named by its
        // smallest id, placed at the middle of its points, and it remembers its members.
        XCTAssertEqual(first.id, "east")
        XCTAssertEqual(first.mergedIds, ["east", "west"])
        XCTAssertEqual(first.position.lat, at(2, 402.5).lat, accuracy: 5e-10)
        XCTAssertEqual(first.atDistanceM, 402.5, accuracy: 0.5)
        XCTAssertEqual(first.offsetM, 2, accuracy: 0.5)
        XCTAssertEqual(second.id, "next")
    }

    func test_signalsOnRoute_mergesOnlyWithinTheMergeRadiusMeasuredAlongTheRoute() {
        // Grouping is switched off here (clusterRadiusM 0) so that only the along-route merge is at work.
        let ungrouped = SignalMatchOptions(clusterRadiusM: 0)
        let points = [signal("a", 5, 400), signal("b", -5, 439), signal("c", 5, 481)]
        // a-b are 39 m apart (one intersection); c is 81 m from a, so it stands alone.
        XCTAssertEqual(Signals.signalsOnRoute(north1km, points, options: ungrouped).signals.map(\.mergedIds), [["a", "b"], ["c"]])
        // The radius is measured from the first point of a group, so it cannot chain a-b-c together.
        let chain = [signal("a", 5, 400), signal("b", -5, 430), signal("c", 5, 460)]
        XCTAssertEqual(Signals.signalsOnRoute(north1km, chain, options: ungrouped).signals.map(\.mergedIds), [["a", "b"], ["c"]])
        XCTAssertEqual(Signals.signalsOnRoute(north1km, points, options: SignalMatchOptions(clusterRadiusM: 0, mergeRadiusM: 100)).count, 1)
        XCTAssertEqual(Signals.signalsOnRoute(north1km, points, options: SignalMatchOptions(clusterRadiusM: 0, mergeRadiusM: 0)).count, 3)
        // With grouping on (the default) the same chain is one intersection: each point is within 60 m of the next.
        XCTAssertEqual(Signals.signalsOnRoute(north1km, chain).signals.map(\.mergedIds), [["a", "b", "c"]])
    }

    func test_signalsOnRoute_countsOnePassOnceHoweverManyShortSegmentsRunPastTheSignal() {
        // A vertex every 5 m: about eight segments lie within 20 m of the signal.
        let dense: [LngLat] = (0..<201).map { i in at(0, Double(i) * 5) }
        let s = [signal("a", 6, 502)]
        let narrow = SignalMatchOptions(toleranceM: 20, mergeRadiusM: 0)
        XCTAssertEqual(Signals.signalsOnRoute(dense, s).count, 1)
        XCTAssertEqual(Signals.signalsOnRoute(dense, s, options: narrow).count, 1)
        guard let pass = Signals.signalsOnRoute(dense, s).signals.first else { return XCTFail("no signal found") }
        XCTAssertEqual(pass.atDistanceM, 502, accuracy: 0.5)
        // Repeated vertices (zero-length segments) change nothing.
        let stutter: [LngLat] = dense.flatMap { p in [p, p] }
        XCTAssertEqual(Signals.signalsOnRoute(stutter, s, options: narrow).count, 1)
    }

    func test_signalsOnRoute_countsASignalTwiceWhenALoopingRoutePassesItTwice() {
        // North through the intersection at (0, 150), around the block, then west through it again.
        let loop = [at(0, 0), at(0, 300), at(200, 300), at(200, 150), at(-100, 150)]
        let crossing = signal("crossing", 4, 153)
        let found = Signals.signalsOnRoute(loop, [crossing])
        XCTAssertEqual(found.count, 2)
        XCTAssertEqual(ids(found), ["crossing", "crossing"])
        guard found.signals.count == 2 else { return XCTFail("expected two passes") }
        XCTAssertEqual(found.signals[0].atDistanceM, 153, accuracy: 0.5)
        // 300 north + 200 east + 150 south + 196 west.
        XCTAssertEqual(found.signals[1].atDistanceM, 846, accuracy: 0.5)
        // "The map draws it once" (signalFeatures) is map-layer code and is not mirrored.
    }

    func test_signalsOnRoute_countsASignalAtACornerOnceThoughBothLegsOfTheTurnAreNearIt() {
        let turn = [at(0, 0), at(0, 500), at(500, 500)]
        let found = Signals.signalsOnRoute(turn, [signal("corner", 8, 492)])
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(
            Signals.signalsOnRoute(turn, [signal("corner", 8, 492)], options: SignalMatchOptions(toleranceM: 20, mergeRadiusM: 0)).count,
            1
        )
    }

    func test_signalsOnRoute_returnsSignalsInDrivingOrder() {
        let points = [signal("late", 0, 900), signal("early", 0, 100), signal("middle", 0, 500)]
        XCTAssertEqual(ids(Signals.signalsOnRoute(north1km, points)), ["early", "middle", "late"])
        let southbound = Array(north1km.reversed())
        XCTAssertEqual(ids(Signals.signalsOnRoute(southbound, points)), ["late", "middle", "early"])
    }

    func test_signalsOnRoute_isEmptyForEmptyOrUnusableInputs() {
        let s = [signal("a", 0, 500)]
        // TS `{ signals: [], count: 0 }`.
        let empty = RouteSignals.none
        XCTAssertTrue(empty.signals.isEmpty)
        XCTAssertEqual(empty.count, 0)
        XCTAssertEqual(Signals.signalsOnRoute([], s), empty)
        XCTAssertEqual(Signals.signalsOnRoute([at(0, 500)], s), empty)
        XCTAssertEqual(Signals.signalsOnRoute(north1km, []), empty)
        XCTAssertEqual(Signals.signalsOnRoute([], []), empty)
        XCTAssertEqual(Signals.signalsOnRoute([LngLat(Double.nan, 35), LngLat(200, 35)], s), empty)
        // Bad points are ignored, not fatal.
        let messy = [at(0, 0), LngLat(Double.nan, Double.nan), at(0, 1000)]
        let badSignal = SignalPoint(id: "bad", position: LngLat(-80.84, 91), name: nil)
        XCTAssertEqual(ids(Signals.signalsOnRoute(messy, [badSignal] + s)), ["a"])
    }

    func test_signalsOnRoute_handlesARouteThatLeavesTheCity() {
        // 200 km north, far past every signal, as two long segments.
        let farAway = [at(0, 0), at(0, 1000), at(0, 200_000)]
        let inTown = [signal("a", 10, 300), signal("b", -10, 800), signal("off", 500, 500)]
        let found = Signals.signalsOnRoute(farAway, inTown)
        XCTAssertEqual(ids(found), ["a", "b"])
        // And one that never comes near the signals at all.
        let elsewhere = [at(50_000, 50_000), at(60_000, 60_000)]
        XCTAssertEqual(Signals.signalsOnRoute(elsewhere, inTown).count, 0)
    }

    func test_signalsOnRoute_agreesWithABruteForceCountOnACitySizedInput() {
        // Deterministic pseudo-random layout: 5,000 signals over 30 x 30 km, a 3,000-vertex wandering route.
        // The TS LCG `(Math.imul(seed, 1664525) + 1013904223) >>> 0` is UInt32 wrapping arithmetic.
        var seed: UInt32 = 12345
        func nextRandom() -> Double {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            return Double(seed) / 4_294_967_296
        }
        var signals: [SignalPoint] = []
        signals.reserveCapacity(5000)
        for i in 0..<5000 {
            // Arguments are evaluated left to right in both languages: east first, then north.
            let eastM = nextRandom() * 30_000
            let northM = nextRandom() * 30_000
            signals.append(signal("s\(i)", eastM, northM))
        }
        var line: [LngLat] = []
        line.reserveCapacity(3000)
        var x = 2000.0
        var y = 2000.0
        for _ in 0..<3000 {
            line.append(at(x, y))
            x += nextRandom() * 16 - 2
            y += nextRandom() * 16 - 2
        }
        // No grouping and no merging: every signal point is judged on its own, as the brute force does.
        let options = SignalMatchOptions(clusterRadiusM: 0, toleranceM: 60, mergeRadiusM: 0)
        let found = Signals.signalsOnRoute(line, signals, options: options)

        // Brute force: every signal against every segment. The two use slightly
        // different plane origins, so signals within a meter of the limit are left
        // out of the comparison.
        let project = Geo.localProjector(here)
        let xy = line.map(project)
        let foundIds = Set(found.signals.map(\.id))
        var surelyOn = 0
        for s in signals {
            let p = project(s.position)
            var nearest = Double.infinity
            for i in 1..<xy.count {
                nearest = min(nearest, Geo.pointToSegment(p, xy[i - 1], xy[i]).distanceM)
            }
            if nearest <= options.toleranceM - 1 {
                surelyOn += 1
                XCTAssertTrue(foundIds.contains(s.id), "\(s.id) at \(nearest) m")
            } else if nearest > options.toleranceM + 1 {
                XCTAssertFalse(foundIds.contains(s.id), "\(s.id) at \(nearest) m")
            }
        }
        XCTAssertGreaterThan(surelyOn, 5)
    }

    // MARK: - describe('signalsOnRoute with limited-access spans')

    /// The middle of the kilometer, 200 m to 800 m, is freeway.
    private var freeway: RouteContext { RouteContext(limitedAccessSpansM: [DistanceSpanM(200, 800)]) }

    func test_limitedAccessSpans_ignoresASignalInTheMiddleOfAFreewaySpanAndKeepsTheOnesOnStreets() {
        let points = [signal("before", 5, 100), signal("overpass", 5, 500), signal("after", 5, 900)]
        XCTAssertEqual(ids(Signals.signalsOnRoute(north1km, points)), ["before", "overpass", "after"])
        let found = Signals.signalsOnRoute(north1km, points, options: SignalMatchOptions.default, context: freeway)
        XCTAssertEqual(ids(found), ["before", "after"])
        XCTAssertEqual(found.count, 2)
    }

    func test_limitedAccessSpans_keepsASignalJustPastTheEndOfASpanAndJustBeforeItsStart() {
        let points = [signal("on-ramp light", 0, 195), signal("ramp-end light", 0, 805)]
        XCTAssertEqual(Signals.signalsOnRoute(north1km, points, options: SignalMatchOptions.default, context: freeway).count, 2)
    }

    func test_limitedAccessSpans_keepsASignalWithinTheMarginInsideEitherEndAndDropsOneBeyondIt() {
        let context = freeway
        func countAt(_ northM: Double, _ limitedAccessMarginM: Double? = nil) -> Int {
            let options = limitedAccessMarginM.map { SignalMatchOptions(limitedAccessMarginM: $0) } ?? SignalMatchOptions()
            return Signals.signalsOnRoute(north1km, [signal("s", 0, northM)], options: options, context: context).count
        }
        // Default margin 30 m: 229 m is within it, 231 m is not; the same at the far end.
        let edges: [Double] = [229, 231, 769, 771]
        XCTAssertEqual(edges.map { countAt($0) }, [1, 0, 0, 1])
        // The margin can be set; 0, a negative or NaN means none.
        let nearEnds: [Double] = [205, 795]
        XCTAssertEqual(nearEnds.map { countAt($0, 0) }, [0, 0])
        XCTAssertEqual(countAt(205, -10), 0)
        XCTAssertEqual(countAt(205, Double.nan), 0)
        XCTAssertEqual(countAt(260, 100), 1)
        // A span shorter than twice the margin hides nothing.
        XCTAssertEqual(
            Signals.signalsOnRoute(
                north1km,
                [signal("s", 0, 500)],
                options: SignalMatchOptions.default,
                context: RouteContext(limitedAccessSpansM: [DistanceSpanM(480, 530)])
            ).count,
            1
        )
    }

    func test_limitedAccessSpans_behavesExactlyAsBeforeWithNullOrEmptySpans() {
        let points = [signal("a", 5, 100), signal("b", -12, 500), signal("b2", 12, 510), signal("c", 5, 900)]
        let plain = Signals.signalsOnRoute(north1km, points)
        XCTAssertEqual(plain.count, 3)
        XCTAssertEqual(
            Signals.signalsOnRoute(north1km, points, options: SignalMatchOptions.default, context: RouteContext(limitedAccessSpansM: nil)),
            plain
        )
        XCTAssertEqual(
            Signals.signalsOnRoute(north1km, points, options: SignalMatchOptions.default, context: RouteContext(limitedAccessSpansM: [])),
            plain
        )
        XCTAssertEqual(Signals.signalsOnRoute(north1km, points, options: SignalMatchOptions.default), plain)
    }

    func test_limitedAccessSpans_handlesSeveralSpansAndJudgesEachPassOfALoopingRouteOnItsOwn() {
        let points = [signal("one", 0, 150), signal("two", 0, 450), signal("three", 0, 850)]
        let spans = RouteContext(limitedAccessSpansM: [DistanceSpanM(100, 200), DistanceSpanM(400, 500), DistanceSpanM(700, 1000)])
        XCTAssertEqual(ids(Signals.signalsOnRoute(north1km, points, options: SignalMatchOptions.default, context: spans)), [String]())
        // North past the signal on a street, then around and across the same spot on a freeway:
        // only the street pass counts.
        let loop = [at(0, 0), at(0, 1000), at(300, 1000), at(300, 500), at(-200, 500)]
        let crossing = [signal("s", 0, 500)]
        XCTAssertEqual(Signals.signalsOnRoute(loop, crossing).signals.map { Int($0.atDistanceM.rounded()) }, [500, 2100])
        let found = Signals.signalsOnRoute(
            loop,
            crossing,
            options: SignalMatchOptions.default,
            context: RouteContext(limitedAccessSpansM: [DistanceSpanM(1500, 2300)])
        )
        XCTAssertEqual(found.signals.map { Int($0.atDistanceM.rounded()) }, [500])
    }

    func test_limitedAccessSpans_measuresSpansTheWayAlongRouteMDoes() {
        let line = [at(0, 0), at(300, 400), at(300, 1000)]
        let along = Geo.alongRouteM(line)
        XCTAssertEqual(along.count, 3)
        guard along.count == 3 else { return XCTFail("expected three distances") }
        XCTAssertEqual(along[0], 0)
        XCTAssertEqual(along[1], 500, accuracy: 0.5)
        XCTAssertEqual(along[2], 1100, accuracy: 0.5)
        XCTAssertEqual(Geo.alongRouteM([]), [Double]())
        // A signal 700 m along, on the second leg, is inside a span given in those meters.
        let s = [signal("s", 300, 600)]
        guard let pass = Signals.signalsOnRoute(line, s).signals.first else { return XCTFail("no signal found") }
        XCTAssertEqual(pass.atDistanceM, 700, accuracy: 0.5)
        let onSecondLeg = RouteContext(limitedAccessSpansM: [DistanceSpanM(along[1], along[2])])
        XCTAssertEqual(Signals.signalsOnRoute(line, s, options: SignalMatchOptions.default, context: onSecondLeg).count, 0)
    }

    // MARK: - describe('clusterSignals (rule a)')

    func test_clusterSignals_groupsTheSignalHeadsOfOneJunctionAndLeavesTheNextJunctionAlone() {
        // Four heads on the corners of a big junction, 30 m apart, and a single signal 100 m up the road.
        let heads = [signal("ne", 15, 515), signal("nw", -15, 515), signal("se", 15, 485), signal("sw", -15, 485)]
        let clusters = Signals.clusterSignals(heads + [signal("up the road", 0, 615)])
        XCTAssertEqual(clusters.map(\.memberIds), [["ne", "nw", "se", "sw"], ["up the road"]])
        guard clusters.count == 2 else { return XCTFail("expected two clusters") }
        let junction = clusters[0]
        // Named by its smallest id, placed in the middle of its points.
        XCTAssertEqual(junction.id, "ne")
        XCTAssertEqual(junction.name, "signal ne")
        XCTAssertEqual(junction.source, SignalSource.primary)
        XCTAssertEqual(junction.members.count, 4)
        XCTAssertEqual(junction.position.lng, at(0, 500).lng, accuracy: 5e-10)
        XCTAssertEqual(junction.position.lat, at(0, 500).lat, accuracy: 5e-10)
        XCTAssertEqual(clusters[1].position, at(0, 615))
    }

    func test_clusterSignals_uses60mByDefault_59mApartIsOneIntersection61mIsTwo() {
        XCTAssertEqual(Signals.clusterSignals([signal("a", 0, 0), signal("b", 0, 59)]).count, 1)
        XCTAssertEqual(Signals.clusterSignals([signal("a", 0, 0), signal("b", 0, 61)]).count, 2)
        XCTAssertEqual(Signals.clusterSignals([signal("a", 0, 0), signal("b", 0, 61)], radiusM: 70).count, 1)
        // A chain: a-b and b-c are within reach, so a and c are one intersection though 100 m apart.
        XCTAssertEqual(Signals.clusterSignals([signal("a", 0, 0), signal("c", 0, 100), signal("b", 0, 50)]).count, 1)
        // A radius of 0, a negative one or NaN groups nothing.
        let radii: [Double] = [0, -5, Double.nan]
        for radius in radii {
            XCTAssertEqual(Signals.clusterSignals([signal("a", 0, 0), signal("b", 0, 1)], radiusM: radius).count, 2, "radius \(radius)")
        }
    }

    func test_clusterSignals_doesNotDependOnInputOrderUsesARepeatedPointOnceAndDropsUnusableOnes() {
        let points = [signal("d", 300, 0), signal("b", 20, 0), signal("a", 0, 0), signal("c", 320, 10)]
        let expected = Signals.clusterSignals(points)
        XCTAssertEqual(expected.map(\.memberIds), [["a", "b"], ["c", "d"]])
        XCTAssertEqual(Signals.clusterSignals(Array(points.reversed())), expected)
        // The same node arriving from two tiles, and a point that is not on the map.
        let bad = SignalPoint(id: "bad", position: LngLat(-80.84, 91), name: nil)
        let repeated = points[2]
        XCTAssertEqual(Signals.clusterSignals(points + [repeated, bad]), expected)
        XCTAssertEqual(Signals.clusterSignals([]), [SignalCluster]())
    }

    // MARK: - describe('signalsOnRoute rule (c): the route must have an intersection at the signal')

    /// A signal the route drives through at 300 m, and one on a road that crosses over the route at 600 m.
    private var ruleCCrossing: SignalPoint { signal("crossing", 0, 300) }
    private var ruleCOverpass: SignalPoint { signal("overpass", 5, 600) }

    func test_ruleC_dropsASignalWhereTheRouteHasNoIntersectionOfItsOwn() {
        let crossing = ruleCCrossing
        let overpass = ruleCOverpass
        let intersections = [at(0, 0), at(0, 300), at(0, 1000)]
        XCTAssertEqual(ids(Signals.signalsOnRoute(north1km, [crossing, overpass])), ["crossing", "overpass"])
        XCTAssertEqual(
            ids(Signals.signalsOnRoute(north1km, [crossing, overpass], options: SignalMatchOptions.default, context: RouteContext(intersections: intersections))),
            ["crossing"]
        )
    }

    func test_ruleC_reaches40mFromTheSignalAndTheDistanceCanBeSet() {
        let overpass = ruleCOverpass
        func countAt(_ northM: Double, _ intersectionRadiusM: Double? = nil) -> Int {
            let options = intersectionRadiusM.map { SignalMatchOptions(intersectionRadiusM: $0) } ?? SignalMatchOptions()
            return Signals.signalsOnRoute(north1km, [overpass], options: options, context: RouteContext(intersections: [at(0, northM)])).count
        }
        // The overpass signal is 5 m to the side, so 39 m and 41 m along the road are just inside and just outside.
        let norths: [Double] = [561, 559, 639, 641]
        XCTAssertEqual(norths.map { countAt($0) }, [1, 0, 1, 0])
        XCTAssertEqual(countAt(500, 120), 1)
        XCTAssertEqual(countAt(600, 0), 0)
    }

    func test_ruleC_isSkippedNotFailedForARouteWithNoIntersectionList() {
        let crossing = ruleCCrossing
        let overpass = ruleCOverpass
        // TS null, undefined and []: nil given, left out, and empty.
        let contexts = [RouteContext(intersections: nil), RouteContext(), RouteContext(intersections: [])]
        for context in contexts {
            XCTAssertEqual(
                ids(Signals.signalsOnRoute(north1km, [crossing, overpass], options: SignalMatchOptions.default, context: context)),
                ["crossing", "overpass"]
            )
        }
    }

    func test_ruleC_acceptsAnIntersectionNearAnySignalPointOfTheGroupOrItsMiddle() {
        // Two heads 50 m apart along the route; the only route intersection is 35 m past the second.
        let heads = [signal("first", 0, 300), signal("second", 0, 350)]
        XCTAssertEqual(
            Signals.signalsOnRoute(north1km, heads, options: SignalMatchOptions.default, context: RouteContext(intersections: [at(0, 385)])).count,
            1
        )
        XCTAssertEqual(
            Signals.signalsOnRoute(north1km, heads, options: SignalMatchOptions.default, context: RouteContext(intersections: [at(0, 395)])).count,
            0
        )
    }

    // MARK: - describe('withSignalCounts')

    private var town: [SignalPoint] { [signal("a", 0, 300), signal("b", 0, 800)] }
    private var insideRoute: RouteCandidate { route("inside", north1km) }

    func test_withSignalCounts_fillsTheCountAndTheCoverageAndKeepsOrderAndEveryOtherField() {
        let inside = insideRoute
        let other = route("other", [at(1000, 0), at(1000, 1000)], 500)
        let counted = Signals.withSignalCounts([inside, other], loadedFor([inside, other], town))
        let routes = counted.routes
        XCTAssertEqual(routes.map(\.id), ["inside", "other"])
        XCTAssertEqual(routes.map { countAndCoverage($0) }, [cc(2, .full), cc(0, .full)])
        guard routes.count == 2 else { return XCTFail("expected two routes") }
        var expectedInside = inside
        expectedInside.signalCount = 2
        expectedInside.signalCoverage = .full
        XCTAssertEqual(routes[0], expectedInside)
        XCTAssertEqual(counted.signalsByRouteId["inside"]?.map(\.id), ["a", "b"])
        XCTAssertEqual(counted.signalsByRouteId["other"], [RouteSignal]())
        // With every tile loaded, zero is a real zero and is shown as one.
        XCTAssertEqual(Format.formatSignalCount(routes[1].signalCount, routes[1].signalCoverage), "0 signals")
        // The input is not changed.
        XCTAssertNil(inside.signalCount)
    }

    func test_withSignalCounts_leavesTheRoutesUntouchedWhileNothingHasBeenLoadedYet() {
        let inside = insideRoute
        let counted = Signals.withSignalCounts([inside], nil)
        XCTAssertEqual(counted.routes, [inside])
        guard let first = counted.routes.first else { return XCTFail("no route") }
        XCTAssertEqual(countAndCoverage(first), cc(nil, SignalCoverage.none))
        XCTAssertEqual(counted.signalsByRouteId.count, 0)
    }

    func test_withSignalCounts_saysNoneWithNoCountWhenNothingAtAllIsKnownAboutARoute() {
        let inside = insideRoute
        let nothing = SignalData(primary: [], primaryTileIds: [], gapFill: nil)
        XCTAssertEqual(Signals.withSignalCounts([inside], nothing).routes.map { countAndCoverage($0) }, [cc(nil, SignalCoverage.none)])
        // Stray points do not help: without its tile loaded, the data says nothing about what else is there.
        var stray = nothing
        stray.primary = town
        XCTAssertEqual(Signals.withSignalCounts([inside], stray).routes.map { countAndCoverage($0) }, [cc(nil, SignalCoverage.none)])
    }

    // Replaces "leaves the count unknown for a route that leaves the area the data covers": the box
    // around the city list is gone. What matters now is whether the tiles a route needs were loaded,
    // and a route with some of them missing gets a partial count rather than none.
    func test_withSignalCounts_marksARoutePartialNeverZeroAsIfKnownWhenATileItNeedsIsMissing() {
        let inside = insideRoute
        // 50 km north: far outside the tiles loaded for the short route.
        let leaving = route("leaving", [at(0, 0), at(0, 1000), at(0, 50_000)])
        let counted = Signals.withSignalCounts([leaving, inside], loadedFor([inside], town))
        let routes = counted.routes
        XCTAssertEqual(routes.map { countAndCoverage($0) }, [cc(2, .partial), cc(2, .full)])
        guard let first = routes.first else { return XCTFail("no route") }
        XCTAssertEqual(Format.formatSignalCount(first.signalCount, first.signalCoverage), "≥ 2 signals (partial)")
        // What was found is still there to draw.
        XCTAssertEqual(counted.signalsByRouteId["leaving"]?.map(\.id), ["a", "b"])
        // Nothing found and data missing: the count is 0 but partial, and is never shown as "0 signals".
        guard let empty = Signals.withSignalCounts([leaving], loadedFor([inside], [])).routes.first else { return XCTFail("no route") }
        XCTAssertEqual(countAndCoverage(empty), cc(0, .partial))
        XCTAssertEqual(Format.formatSignalCount(empty.signalCount, empty.signalCoverage), "Signals: unknown")
    }

    func test_withSignalCounts_appliesTheLimitedAccessSpansOfEachRoute() {
        let inside = insideRoute
        var freewayRoute = inside
        freewayRoute.id = "freeway"
        freewayRoute.limitedAccessSpansM = [DistanceSpanM(200, 1000)]
        let counted = Signals.withSignalCounts([inside, freewayRoute], loadedFor([inside], town))
        // Signal a (300 m) is deep in the span. Signal b (800 m) is too: the span runs to the route end.
        XCTAssertEqual(counted.routes.map(\.signalCount), [2, 0])
        XCTAssertEqual(counted.signalsByRouteId["freeway"], [RouteSignal]())
        // A span that ends just before b: the light at the foot of the ramp stays.
        var ramp = inside
        ramp.id = "ramp"
        ramp.limitedAccessSpansM = [DistanceSpanM(0, 790)]
        XCTAssertEqual(Signals.withSignalCounts([ramp], loadedFor([inside], town)).signalsByRouteId["ramp"]?.map(\.id), ["b"])
    }

    func test_withSignalCounts_appliesRuleCWithTheIntersectionsOfEachRoute() {
        let inside = insideRoute
        func listed(_ northM: Double...) -> [RouteIntersection] {
            northM.map { m in RouteIntersection(location: at(0, m), signal: false) }
        }
        var through = inside
        through.id = "through"
        through.intersections = listed(0, 300, 800, 1000)
        var under = inside
        under.id = "under"
        under.intersections = listed(0, 300, 1000)
        let counted = Signals.withSignalCounts([inside, through, under], loadedFor([inside], town))
        // No list: the rule is skipped. Signal b has no route intersection on the third route.
        XCTAssertEqual(counted.routes.map(\.signalCount), [2, 2, 1])
    }

    func test_withSignalCounts_passesItsOptionsThrough() {
        let inside = insideRoute
        let wide = Signals.withSignalCounts(
            [inside],
            loadedFor([inside], town + [signal("far", 45, 500)]),
            options: SignalMatchOptions(toleranceM: 50)
        )
        XCTAssertEqual(wide.routes.first?.signalCount, 3)
    }

    // MARK: - describe('withSignalCounts: primary data first, gap-fill data only where it has nothing')

    /// Two heads of one junction at 300 m, from the primary source.
    private var gapPrimary: [SignalPoint] { [signal("osm-east", 10, 300), signal("osm-west", -10, 300)] }

    func test_withSignalCountsGapFill_ignoresAGapFillPointNearAPrimaryIntersectionAndAddsOneFarFromAny() {
        let inside = insideRoute
        let primary = gapPrimary
        let city = [
            signal("city-same-junction", 5, 320),
            signal("city-missing-from-primary", 0, 700),
            // Nowhere near the route: makes no difference to anything.
            signal("city-elsewhere", 20_000, 20_000),
        ]
        let counted = Signals.withSignalCounts([inside], loadedFor([inside], primary, city))
        XCTAssertEqual(counted.routes.map { countAndCoverage($0) }, [cc(2, .full)])
        XCTAssertEqual(
            counted.signalsByRouteId["inside"]?.map { [$0.id, $0.source.rawValue] },
            [["osm-east", "primary"], ["city-missing-from-primary", "gapFill"]]
        )
        // Gap-fill only ever adds: the primary intersection is exactly what it is without the city list.
        let alone = Signals.withSignalCounts([inside], loadedFor([inside], primary)).signalsByRouteId["inside"] ?? []
        XCTAssertEqual(counted.signalsByRouteId["inside"]?.first, alone.first)
        XCTAssertEqual(alone.count, 1)
    }

    func test_withSignalCountsGapFill_measuresNearFromEveryPointOfThePrimaryIntersection_60mByDefault() {
        let inside = insideRoute
        let single = [signal("osm", 0, 300)]
        func countAt(_ northM: Double, _ gapFillRadiusM: Double? = nil) -> Int? {
            let options = gapFillRadiusM.map { SignalMatchOptions(gapFillRadiusM: $0) } ?? SignalMatchOptions()
            return Signals.withSignalCounts(
                [inside],
                loadedFor([inside], single, [signal("city", 0, northM)]),
                options: options
            ).routes.first?.signalCount
        }
        let norths: [Double] = [359, 361]
        XCTAssertEqual(norths.map { countAt($0) }, [1, 2])
        XCTAssertEqual(countAt(400, 120), 1)
        // The along-route merge (40 m) is still the last word: with no gap-fill distance at all,
        // a city point 30 m up the road is the same stop.
        XCTAssertEqual(countAt(330, 0), 1)
    }

    func test_withSignalCountsGapFill_neverLetsTheGapFillDataDecideTheCoverage() {
        let inside = insideRoute
        let town = [signal("a", 0, 300), signal("b", 0, 800)]
        func resultOf(_ data: SignalData) -> [CountAndCoverage] {
            Signals.withSignalCounts([inside], data).routes.map { countAndCoverage($0) }
        }
        // A route nowhere near the city's points is still fully covered by its tiles
        // (the old rule called anything outside the box around the city list unknown).
        XCTAssertEqual(resultOf(loadedFor([inside], town, [signal("city", 300_000, 300_000)])), [cc(2, .full)])
        // The city list failing to load changes nothing either.
        XCTAssertEqual(resultOf(loadedFor([inside], town, nil)), [cc(2, .full)])
        // City list only, no tile loaded: a lower bound, so partial, never full.
        XCTAssertEqual(
            resultOf(SignalData(primary: [], primaryTileIds: [], gapFill: [signal("city", 0, 300)])),
            [cc(1, .partial)]
        )
    }

    // MARK: - describe('withSignalCounts across tiles')

    // A road running east along latitude 35.25, across the tile edge at longitude -80.8.
    private var westTile: String { "-809_352" }
    private var eastTile: String { "-808_352" }
    private var road: [LngLat] { [LngLat(-80.81, 35.25), LngLat(-80.79, 35.25)] }

    private func osm(_ id: Int, _ lng: Double) -> SignalPoint {
        SignalPoint(id: "osm-\(id)", position: LngLat(lng, 35.25), name: nil)
    }

    func test_withSignalCountsAcrossTiles_needsExactlyTheTwoTilesTheRoadIsIn() {
        XCTAssertEqual(Signals.signalTilesForRoute(road), [eastTile, westTile])
    }

    func test_withSignalCountsAcrossTiles_countsAnIntersectionWhoseSignalsStraddleTheTileEdgeOnce() {
        // One junction on the edge: a head 14 m west of it and one 14 m east, so in different tiles.
        let west = osm(1, -80.80015)
        let east = osm(2, -80.79985)
        XCTAssertEqual([Tiles.tileIdAt(west.position), Tiles.tileIdAt(east.position)], [westTile, eastTile])
        let crossing = route("crossing", road)
        let both = SignalData(primary: [west, east], primaryTileIds: [westTile, eastTile], gapFill: nil)
        let counted = Signals.withSignalCounts([crossing], both)
        XCTAssertEqual(counted.routes.map { countAndCoverage($0) }, [cc(1, .full)])
        XCTAssertEqual(counted.signalsByRouteId["crossing"]?.first?.mergedIds, ["osm-1", "osm-2"])
        // A node on the edge comes back from both tiles: the same node twice is still one signal.
        var twice = both
        twice.primary = [west, east, west, east]
        XCTAssertEqual(Signals.withSignalCounts([crossing], twice).routes.map { countAndCoverage($0) }, [cc(1, .full)])
        // With only the west tile loaded, the half that is known counts once, and the count is partial.
        let half = SignalData(primary: [west], primaryTileIds: [westTile], gapFill: nil)
        XCTAssertEqual(Signals.withSignalCounts([crossing], half).routes.map { countAndCoverage($0) }, [cc(1, .partial)])
    }

    func test_withSignalCountsAcrossTiles_fallsBackOnTheProviderSignalFlagsOnlyInTilesWhoseDataIsMissing() {
        let intersections = [
            // West tile: one the primary data has, one it does not (the primary data wins there).
            RouteIntersection(location: LngLat(-80.807, 35.25), signal: true),
            RouteIntersection(location: LngLat(-80.804, 35.25), signal: true),
            // East tile: two flagged approaches of one junction 9 m apart, then a plain intersection.
            RouteIntersection(location: LngLat(-80.795, 35.25), signal: true),
            RouteIntersection(location: LngLat(-80.7949, 35.25), signal: true),
            RouteIntersection(location: LngLat(-80.792, 35.25), signal: false),
        ]
        var crossing = route("crossing", road)
        crossing.intersections = intersections
        crossing.providerSignalCount = 4
        let primary = [osm(7, -80.807)]

        let westOnly = SignalData(primary: primary, primaryTileIds: [westTile], gapFill: nil)
        let counted = Signals.withSignalCounts([crossing], westOnly)
        XCTAssertEqual(counted.routes.map { countAndCoverage($0) }, [cc(2, .partial)])
        XCTAssertEqual(counted.signalsByRouteId["crossing"]?.map(\.source), [SignalSource.primary, SignalSource.fallback])
        // The provider's own count is left as it was: a cross-check, not the answer.
        XCTAssertEqual(counted.routes.first?.providerSignalCount, 4)

        // Both tiles loaded (the east one has no signals): the flags are not used at all.
        var both = westOnly
        both.primaryTileIds = [westTile, eastTile]
        XCTAssertEqual(Signals.withSignalCounts([crossing], both).routes.map { countAndCoverage($0) }, [cc(1, .full)])

        // No tile loaded: every flag stands in, grouped like any other signal points. Still partial.
        let noData = SignalData(primary: [], primaryTileIds: [], gapFill: nil)
        XCTAssertEqual(Signals.withSignalCounts([crossing], noData).routes.map { countAndCoverage($0) }, [cc(3, .partial)])

        // A gap-fill point at a flagged junction is the same junction, not one more.
        var withCity = westOnly
        withCity.gapFill = [SignalPoint(id: "city-1", position: LngLat(-80.79495, 35.2501), name: "A_B")]
        XCTAssertEqual(Signals.withSignalCounts([crossing], withCity).routes.map { countAndCoverage($0) }, [cc(2, .partial)])
    }

    // MARK: - describe('geometryHash and routeIdFromGeometry')

    private var hashLine: [LngLat] {
        [LngLat(-80.8431, 35.2271), LngLat(-80.8436, 35.2201), LngLat(-80.8295, 35.1527)]
    }

    func test_geometryHash_givesTheSameIdForTheSameGeometryEveryTime() {
        let a = hashLine
        XCTAssertEqual(Hash.routeIdFromGeometry(a), Hash.routeIdFromGeometry(a.map { p in LngLat(p.lng, p.lat) }))
        let id = Hash.routeIdFromGeometry(a)
        XCTAssertTrue(id.hasPrefix("route-") && isLowerHex16(String(id.dropFirst("route-".count))), id)
        XCTAssertTrue(isLowerHex16(Hash.geometryHash(a)), Hash.geometryHash(a))
        // Pinned, so a change to the hash (which would break stored ids) is noticed.
        XCTAssertEqual(Hash.geometryHash([LngLat(0, 0), LngLat(1, 1)]), "959a2e13ba3e6f92")
        XCTAssertEqual(Hash.geometryHash([]), "4b95f51520c34f4c")
        XCTAssertEqual(Hash.routeIdFromGeometry([LngLat(-80.8431, 35.2271), LngLat(-80.8295, 35.1527)]), "route-6156bfd75b6b0cbe")
    }

    func test_geometryHash_givesDifferentIdsForDifferentGeometry() {
        let a = hashLine
        let hashes = Set<String>([
            Hash.geometryHash(a),
            Hash.geometryHash(Array(a.reversed())),
            Hash.geometryHash(Array(a.prefix(2))),
            Hash.geometryHash(a + [a[2]]),
            Hash.geometryHash(a.map { p in LngLat(p.lat, p.lng) }),
            Hash.geometryHash([LngLat(-80.8431, 35.2271), LngLat(-80.8436, 35.2202), LngLat(-80.8295, 35.1527)]),
            Hash.geometryHash([LngLat(-80.843101, 35.2271), LngLat(-80.8436, 35.2201), LngLat(-80.8295, 35.1527)]),
            Hash.geometryHash([]),
        ])
        XCTAssertEqual(hashes.count, 8)
    }

    func test_geometryHash_ignoresDifferencesFarBelowAMeter() {
        let a = hashLine
        let nudged = a.map { p in LngLat(p.lng + 2e-8, p.lat - 2e-8) }
        XCTAssertEqual(Hash.geometryHash(nudged), Hash.geometryHash(a))
    }

    func test_geometryHash_doesNotCollideAcrossManyNearbyRoutes() {
        var hashes = Set<String>()
        for i in 0..<2000 {
            hashes.insert(Hash.geometryHash([at(0, 0), at(Double(i), 500), at(0, 1000)]))
        }
        XCTAssertEqual(hashes.count, 2000)
    }

    // MARK: - describe('sameRouteGeometry and resolveSelectedId')

    private var selectPath: [LngLat] { [at(0, 0), at(0, 400), at(300, 400), at(300, 900)] }
    /// The same roads as Mapbox returned them minutes later: an extra vertex, points under a meter off.
    private var selectJittered: [LngLat] {
        [at(0, 0), at(0.4, 200), at(0, 400.6), at(300, 400), at(300.5, 650), at(300, 900)]
    }
    /// Shares the start and end but takes the next street over for a stretch.
    private var selectAlternative: [LngLat] { [at(0, 0), at(0, 400), at(150, 400), at(150, 900), at(300, 900)] }

    func test_sameRouteGeometry_matchesTheSamePathWithSlightlyDifferentPointsAndNothingElse() {
        let path = selectPath
        let jittered = selectJittered
        let alternative = selectAlternative
        XCTAssertTrue(Select.sameRouteGeometry(path, path))
        XCTAssertTrue(Select.sameRouteGeometry(path, jittered))
        XCTAssertTrue(Select.sameRouteGeometry(jittered, path))
        XCTAssertFalse(Select.sameRouteGeometry(path, alternative))
        XCTAssertFalse(Select.sameRouteGeometry(path, Array(path.reversed())))
        XCTAssertFalse(Select.sameRouteGeometry(path, Array(path.prefix(3))))
        XCTAssertFalse(Select.sameRouteGeometry(path, []))
        XCTAssertFalse(Select.sameRouteGeometry([], []))
        // A lane's width apart is the same route only if the tolerance says so.
        let eastM: [Double] = [12, 12, 312, 312]
        let northM: [Double] = [0, 412, 412, 900]
        let shifted = path.indices.map { i in at(eastM[i], northM[i]) }
        XCTAssertFalse(Select.sameRouteGeometry(path, shifted))
        XCTAssertTrue(Select.sameRouteGeometry(path, shifted, toleranceM: 30))
    }

    func test_resolveSelectedId_keepsThePickedRouteSelectedWhileItKeepsComingBack() {
        let path = selectPath
        let jittered = selectJittered
        let fast = route("fast", selectAlternative, 500)
        let picked = route("picked", path, 700)
        XCTAssertEqual(Select.resolveSelectedId([fast, picked], picked: picked), "picked")
        // Refetched: same roads, new points, so a new id. Still the selected one.
        let again = route(Hash.routeIdFromGeometry(jittered), jittered, 720)
        XCTAssertNotEqual(again.id, Hash.routeIdFromGeometry(path))
        XCTAssertEqual(Select.resolveSelectedId([fast, again], picked: picked), again.id)
    }

    func test_resolveSelectedId_fallsBackToTheTopRankedRouteWhenThereIsNoPickOrItIsGone() {
        let path = selectPath
        let fast = route("fast", selectAlternative, 500)
        let slow = route("slow", [at(0, 0), at(-300, 500), at(300, 900)], 900)
        XCTAssertEqual(Select.resolveSelectedId([slow, fast], picked: nil), "fast")
        XCTAssertEqual(Select.resolveSelectedId([slow, fast], picked: route("gone", path)), "fast")
        XCTAssertNil(Select.resolveSelectedId([], picked: route("gone", path)))
        XCTAssertNil(Select.resolveSelectedId([], picked: nil))
        // Top-ranked is not always the fastest: within the tie window, fewer signals wins.
        var calm = slow
        calm.id = "calm"
        calm.durationSec = 520
        calm.signalCount = 4
        calm.signalCoverage = .full
        var busy = fast
        busy.signalCount = 9
        busy.signalCoverage = .full
        XCTAssertEqual(Select.resolveSelectedId([busy, calm], picked: nil), "calm")
        XCTAssertEqual(Select.resolveSelectedId([busy, calm], picked: nil, etaTieWindowSec: 10), "fast")
        // A pick still beats the ranking.
        XCTAssertEqual(Select.resolveSelectedId([busy, calm], picked: busy), "fast")
    }
}
