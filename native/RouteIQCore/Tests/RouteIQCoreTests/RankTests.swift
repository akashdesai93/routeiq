import XCTest
@testable import RouteIQCore

/// Mirrors tests/rank.test.ts (describe "rankRoutes"), assertion for assertion.
final class RankTests: XCTestCase {
    // MARK: - Helpers (as in the TS file)

    /// The TS `route(id, durationSec, signalCount = null, distanceM = 9000)`.
    private static func route(
        _ id: String,
        _ durationSec: Double,
        _ signalCount: Int? = nil,
        _ distanceM: Double = 9000
    ) -> RouteCandidate {
        RouteCandidate(
            id: id,
            geometry: [LngLat(-80.84, 35.22), LngLat(-80.83, 35.15)],
            durationSec: durationSec,
            typicalDurationSec: nil,
            distanceM: distanceM,
            signalCount: signalCount,
            signalCoverage: signalCount == nil ? .none : .full,
            providerSignalCount: nil,
            intersections: nil,
            limitedAccessSpansM: nil,
            maneuvers: []
        )
    }

    private static func ranked(_ routes: [RouteCandidate], _ etaTieWindowSec: Double?) -> [RankedRoute] {
        if let w = etaTieWindowSec {
            return Rank.rankRoutes(routes, etaTieWindowSec: w)
        }
        return Rank.rankRoutes(routes)
    }

    private static func order(_ routes: [RouteCandidate], _ etaTieWindowSec: Double? = nil) -> [String] {
        ranked(routes, etaTieWindowSec).map { $0.route.id }
    }

    private static func reasons(_ routes: [RouteCandidate], _ etaTieWindowSec: Double? = nil) -> [String: [String]] {
        var out: [String: [String]] = [:]
        for r in ranked(routes, etaTieWindowSec) {
            out[r.route.id] = r.reasons
        }
        return out
    }

    /// Every order the same routes can arrive in.
    private static func permutations<T>(_ items: [T]) -> [[T]] {
        if items.count <= 1 { return [items] }
        var result: [[T]] = []
        for i in items.indices {
            var rest = items
            let item = rest.remove(at: i)
            for tail in permutations(rest) {
                result.append([item] + tail)
            }
        }
        return result
    }

    private static func partial(_ id: String, _ durationSec: Double, _ signalCount: Int) -> RouteCandidate {
        var r = route(id, durationSec, signalCount)
        r.signalCoverage = .partial
        return r
    }

    // MARK: - rankRoutes

    // it('has one documented tie window, 30 seconds')
    func testHasOneDocumentedTieWindow30Seconds() {
        XCTAssertEqual(Rank.defaultEtaTieWindowSec, 30)
    }

    // it('puts a clear winner first whatever the signals say')
    func testPutsAClearWinnerFirstWhateverTheSignalsSay() {
        let routes = [Self.route("slow", 1100, 2), Self.route("fast", 900, 30), Self.route("middle", 1000, 0)]
        let result = Rank.rankRoutes(routes)
        XCTAssertEqual(result.map { $0.route.id }, ["fast", "middle", "slow"])
        XCTAssertEqual(result.map { $0.rank }, [1, 2, 3])
        // The routes themselves come back untouched, and the input is not reordered.
        // (TS: toBe identity; here value equality.)
        XCTAssertEqual(result[0].route, routes[1])
        XCTAssertEqual(routes.map { $0.id }, ["slow", "fast", "middle"])
        XCTAssertEqual(Self.reasons(routes), [
            "fast": ["Fastest right now"],
            "middle": ["2 min slower than the fastest"],
            "slow": ["3 min slower than the fastest"],
        ])
    }

    // it('breaks an exact tie on signals, then distance, then id')
    func testBreaksAnExactTieOnSignalsThenDistanceThenId() {
        XCTAssertEqual(Self.order([Self.route("a", 900, 12), Self.route("b", 900, 9)]), ["b", "a"])
        XCTAssertEqual(Self.reasons([Self.route("a", 900, 12), Self.route("b", 900, 9)]), [
            "b": ["Tied for fastest, 3 fewer signals"],
            "a": ["Tied for fastest, 3 more signals than the recommended route"],
        ])
        // Same signals: the shorter one.
        XCTAssertEqual(Self.order([Self.route("a", 900, 9, 9500), Self.route("b", 900, 9, 9000)]), ["b", "a"])
        XCTAssertEqual(Self.reasons([Self.route("a", 900, 9, 9500), Self.route("b", 900, 9, 9000)]), [
            "b": ["Tied for fastest"],
            "a": ["Tied for fastest, same number of signals as the recommended route"],
        ])
        // Same everything: by id, so the answer never depends on the order they came in.
        XCTAssertEqual(Self.order([Self.route("b", 900, 9), Self.route("a", 900, 9)]), ["a", "b"])
    }

    // it('breaks a tie within the window on signals')
    func testBreaksATieWithinTheWindowOnSignals() {
        let routes = [Self.route("fast", 900, 14), Self.route("calm", 920, 11), Self.route("far", 1000, 3)]
        XCTAssertEqual(Self.order(routes), ["calm", "fast", "far"])
        XCTAssertEqual(Self.reasons(routes), [
            "calm": ["Within 30 s of the fastest, 3 fewer signals"],
            "fast": ["Fastest right now, 3 more signals than the recommended route"],
            "far": ["2 min slower than the fastest"],
        ])
        // One signal reads as one signal.
        XCTAssertEqual(Self.reasons([Self.route("fast", 900, 5), Self.route("calm", 910, 4)]), [
            "calm": ["Within 30 s of the fastest, 1 fewer signal"],
            "fast": ["Fastest right now, 1 more signal than the recommended route"],
        ])
        // Same count within the window: the faster one stays first.
        XCTAssertEqual(Self.reasons([Self.route("fast", 900, 7), Self.route("close", 915, 7)]), [
            "fast": ["Fastest right now"],
            "close": ["Within 30 s of the fastest, same number of signals as the recommended route"],
        ])
        // More signals within the window never helps.
        XCTAssertEqual(Self.reasons([Self.route("fast", 900, 7), Self.route("close", 915, 9)]), [
            "fast": ["Fastest right now"],
            "close": ["Within 30 s of the fastest, 2 more signals than the recommended route"],
        ])
    }

    // it('treats exactly 30 s as a tie and 31 s as not')
    func testTreatsExactly30sAsATieAnd31sAsNot() {
        XCTAssertEqual(Self.order([Self.route("fast", 900, 10), Self.route("calm", 930, 5)]), ["calm", "fast"])
        XCTAssertEqual(Self.order([Self.route("fast", 900, 10), Self.route("calm", 931, 5)]), ["fast", "calm"])
        XCTAssertEqual(Self.reasons([Self.route("fast", 900, 10), Self.route("calm", 931, 5)]), [
            "fast": ["Fastest right now"],
            "calm": ["31 s slower than the fastest"],
        ])
        // A fraction over the window is over it.
        XCTAssertEqual(Self.order([Self.route("fast", 900, 10), Self.route("calm", 930.4, 5)]), ["fast", "calm"])
        XCTAssertEqual(
            Self.reasons([Self.route("fast", 900, 10), Self.route("calm", 930.4, 5)])["calm"],
            ["31 s slower than the fastest"]
        )
    }

    // it('takes the window from its options')
    func testTakesTheWindowFromItsOptions() {
        let routes = [Self.route("fast", 900, 10), Self.route("calm", 960, 5)]
        XCTAssertEqual(Self.order(routes), ["fast", "calm"])
        XCTAssertEqual(Self.order(routes, 60), ["calm", "fast"])
        XCTAssertEqual(Self.reasons(routes, 60)["calm"], ["Within 60 s of the fastest, 5 fewer signals"])
        // No window: only exact ties are ties. Nonsense windows mean none.
        let close = [Self.route("fast", 900, 10), Self.route("calm", 901, 5), Self.route("twin", 900, 8)]
        for window in [0.0, -30.0, Double.nan] {
            XCTAssertEqual(Self.order(close, window), ["twin", "fast", "calm"], "window \(window)")
        }
        XCTAssertEqual(Self.reasons(close, 0), [
            "twin": ["Tied for fastest, 2 fewer signals"],
            "fast": ["Tied for fastest, 2 more signals than the recommended route"],
            "calm": ["1 s slower than the fastest"],
        ])
    }

    // it('measures the window from the fastest route only: ties do not chain')
    func testMeasuresTheWindowFromTheFastestRouteOnlyTiesDoNotChain() {
        // A is fastest. B is within 30 s of A with fewer signals. C is within 30 s
        // of B but 45 s behind A, so C is not tied with anything, though it has
        // the fewest signals of all.
        let a = Self.route("A", 1000, 12)
        let b = Self.route("B", 1020, 9)
        let c = Self.route("C", 1045, 2)
        for routes in Self.permutations([a, b, c]) {
            XCTAssertEqual(Self.order(routes), ["B", "A", "C"])
        }
        XCTAssertEqual(Self.reasons([a, b, c]), [
            "B": ["Within 30 s of the fastest, 3 fewer signals"],
            "A": ["Fastest right now, 3 more signals than the recommended route"],
            "C": ["45 s slower than the fastest"],
        ])
    }

    // it('never lets an unknown signal count win or lose a tiebreak')
    func testNeverLetsAnUnknownSignalCountWinOrLoseATiebreak() {
        // Unknown is fastest: a known count cannot beat it on signals.
        XCTAssertEqual(Self.order([Self.route("unknown", 900, nil), Self.route("known", 920, 0)]), ["unknown", "known"])
        // Unknown is slower: it cannot win on signals either.
        XCTAssertEqual(Self.order([Self.route("known", 900, 40), Self.route("unknown", 920, nil)]), ["known", "unknown"])
        // Nothing is said about signals where one side is unknown.
        XCTAssertEqual(Self.reasons([Self.route("unknown", 900, nil), Self.route("known", 920, 0)]), [
            "unknown": ["Fastest right now"],
            "known": ["Within 30 s of the fastest"],
        ])
        // Exact tie with an unknown: distance, then id.
        XCTAssertEqual(
            Self.order([Self.route("known", 900, 3, 9500), Self.route("unknown", 900, nil, 9000)]),
            ["unknown", "known"]
        )
        XCTAssertEqual(Self.order([Self.route("b", 900, 3), Self.route("a", 900, nil)]), ["a", "b"])
    }

    // it('treats a partial signal count as unknown: a lower bound cannot win or lose a tiebreak')
    func testTreatsAPartialSignalCountAsUnknown() {
        // "At least 2" is not fewer than 9: the fastest route stays first.
        XCTAssertEqual(Self.order([Self.route("full", 900, 9), Self.partial("partial", 920, 2)]), ["full", "partial"])
        // And "at least 40" on the fastest route does not lose to a full count of 3.
        XCTAssertEqual(Self.order([Self.partial("partial", 900, 40), Self.route("full", 920, 3)]), ["partial", "full"])
        XCTAssertEqual(Self.reasons([Self.partial("partial", 900, 40), Self.route("full", 920, 3)]), [
            "partial": ["Fastest right now"],
            "full": ["Within 30 s of the fastest"],
        ])
        // The same numbers with full coverage do swap, so it is the coverage that held them.
        XCTAssertEqual(Self.order([Self.route("a", 900, 40), Self.route("b", 920, 3)]), ["b", "a"])
        // Full counts are still compared around a partial one, which keeps the place its ETA gives it.
        XCTAssertEqual(
            Self.order([Self.route("k1", 900, 9), Self.partial("p", 910, 1), Self.route("k2", 920, 4)]),
            ["k2", "p", "k1"]
        )
        // A count marked as covering nothing is unknown too, whatever number it carries.
        var none = Self.route("none", 920, 0)
        none.signalCoverage = .none
        XCTAssertEqual(Self.order([Self.route("full", 900, 9), none]), ["full", "none"])
    }

    // it('still compares the known counts when one tied route is unknown, in every position')
    func testStillComparesTheKnownCountsWhenOneTiedRouteIsUnknownInEveryPosition() {
        // Fastest unknown: it stays first by ETA; the two known ones are ordered by signals.
        XCTAssertEqual(
            Self.order([Self.route("u", 900, nil), Self.route("k1", 910, 9), Self.route("k2", 920, 4)]),
            ["u", "k2", "k1"]
        )
        // Middle unknown: it keeps the second place its ETA gives it, and the known
        // routes swap around it. It is never recommended over the fastest route.
        let middle = [Self.route("k1", 900, 9), Self.route("u", 910, nil), Self.route("k2", 920, 4)]
        XCTAssertEqual(Self.order(middle), ["k2", "u", "k1"])
        XCTAssertEqual(Self.reasons(middle), [
            "k2": ["Within 30 s of the fastest, 5 fewer signals"],
            "u": ["Within 30 s of the fastest"],
            "k1": ["Fastest right now, 5 more signals than the recommended route"],
        ])
        // Slowest unknown: after the known ones it is slower than.
        XCTAssertEqual(
            Self.order([Self.route("k1", 900, 9), Self.route("k2", 910, 4), Self.route("u", 920, nil)]),
            ["k2", "k1", "u"]
        )
        XCTAssertEqual(Self.reasons([Self.route("k1", 900, 9), Self.route("k2", 910, 4), Self.route("u", 920, nil)]), [
            "k2": ["Within 30 s of the fastest, 5 fewer signals"],
            "k1": ["Fastest right now, 5 more signals than the recommended route"],
            "u": ["Within 30 s of the fastest"],
        ])
        // An unknown outside the window is just slower.
        XCTAssertEqual(
            Self.order([Self.route("k1", 900, 9), Self.route("k2", 910, 4), Self.route("u", 990, nil)]),
            ["k2", "k1", "u"]
        )
    }

    // it('is plain ETA order when no signal count is known')
    func testIsPlainEtaOrderWhenNoSignalCountIsKnown() {
        let routes = [Self.route("c", 925), Self.route("a", 900), Self.route("b", 910), Self.route("d", 1200)]
        XCTAssertEqual(Self.order(routes), ["a", "b", "c", "d"])
        XCTAssertEqual(Self.reasons(routes), [
            "a": ["Fastest right now"],
            "b": ["Within 30 s of the fastest"],
            "c": ["Within 30 s of the fastest"],
            "d": ["5 min slower than the fastest"],
        ])
        // NaN is as unknown as null. (TS: signalCount NaN with coverage 'full';
        // the Swift Int? has no NaN, so the count is nil while coverage stays full.)
        var nanCount = Self.route("a", 900, 0)
        nanCount.signalCount = nil
        XCTAssertEqual(nanCount.signalCoverage, .full)
        XCTAssertEqual(Self.order([nanCount, Self.route("b", 910, 0)]), ["a", "b"])
    }

    // it('handles a single route and an empty list')
    func testHandlesASingleRouteAndAnEmptyList() {
        let only = Self.route("only", 500, 7)
        XCTAssertEqual(Rank.rankRoutes([only]), [RankedRoute(route: only, rank: 1, reasons: ["Only route found"])])
        XCTAssertEqual(Rank.rankRoutes([]), [])
        XCTAssertEqual(Rank.recommendedRouteId([only]), "only")
        XCTAssertNil(Rank.recommendedRouteId([]))
    }

    // it('gives the same ranking for every input order')
    func testGivesTheSameRankingForEveryInputOrder() {
        let sets: [[RouteCandidate]] = [
            [Self.route("a", 900, 12), Self.route("b", 900, 12), Self.route("c", 915, 12), Self.route("d", 2000, 0)],
            [Self.route("a", 900, nil), Self.route("b", 905, 3), Self.route("c", 910, nil), Self.route("d", 925, 1)],
            [Self.route("a", 900, 5, 9000), Self.route("b", 900, 5, 9000), Self.route("c", 900, nil, 9000)],
        ]
        for set in sets {
            let expected = Rank.rankRoutes(set)
            XCTAssertEqual(expected.map { $0.rank }, Array(1...set.count))
            for shuffled in Self.permutations(set) {
                XCTAssertEqual(Rank.rankRoutes(shuffled), expected)
            }
        }
    }

    // it('says a slower route in whole minutes, or seconds under a minute')
    func testSaysASlowerRouteInWholeMinutesOrSecondsUnderAMinute() {
        func slower(_ sec: Double) -> [String]? {
            Self.reasons([Self.route("fast", 900), Self.route("slow", 900 + sec)])["slow"]
        }
        XCTAssertEqual(slower(45), ["45 s slower than the fastest"])
        XCTAssertEqual(slower(59), ["59 s slower than the fastest"])
        XCTAssertEqual(slower(60), ["1 min slower than the fastest"])
        XCTAssertEqual(slower(125), ["2 min slower than the fastest"])
        XCTAssertEqual(slower(3900), ["1 h 5 min slower than the fastest"])
    }

    // it('puts a route without a usable travel time last and never recommends it over a real one')
    func testPutsARouteWithoutAUsableTravelTimeLast() {
        let routes = [Self.route("broken", .nan, 0), Self.route("real", 5000, 40)]
        XCTAssertEqual(Self.order(routes), ["real", "broken"])
        XCTAssertEqual(Self.reasons(routes), [
            "real": ["Fastest right now"],
            "broken": ["No travel time available"],
        ])
    }

    // it('recommends the top-ranked route')
    func testRecommendsTheTopRankedRoute() {
        XCTAssertEqual(Rank.recommendedRouteId([Self.route("a", 900), Self.route("b", 840), Self.route("c", 1020)]), "b")
        XCTAssertEqual(Rank.recommendedRouteId([Self.route("fast", 900, 14), Self.route("calm", 920, 11)]), "calm")
        XCTAssertEqual(
            Rank.recommendedRouteId([Self.route("fast", 900, 14), Self.route("calm", 920, 11)], etaTieWindowSec: 0),
            "fast"
        )
    }
}
