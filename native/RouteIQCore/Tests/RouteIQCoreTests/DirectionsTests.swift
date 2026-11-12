import Foundation
import XCTest
import RouteIQCore

// Mirrors describe('parseDirections') in tests/mapbox.test.ts, assertion for
// assertion. buildDirectionsUrl and fetchDirections are network client code
// and are not ported. The JSON fixtures are read straight from the repository
// folder tests/fixtures; no test here touches the network.
final class DirectionsTests: XCTestCase {
    // MARK: - Helpers

    struct Unexpected: Error, CustomStringConvertible {
        let description: String
    }

    /// tests/fixtures/<name>, resolved from this file: the repo root is five path
    /// components above native/RouteIQCore/Tests/RouteIQCoreTests/DirectionsTests.swift.
    func fixture(_ name: String) throws -> JSONValue {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let url = root.appendingPathComponent("tests").appendingPathComponent("fixtures").appendingPathComponent(name)
        return try JSONValue.parse(Data(contentsOf: url))
    }

    func routesOf(_ result: Directions.Result) throws -> [RouteCandidate] {
        guard case .ok(let routes) = result else { throw Unexpected(description: "expected routes, got \(result)") }
        return routes
    }

    func failureOf(_ result: Directions.Result) throws -> (kind: Directions.ErrorKind, message: String) {
        guard case .failure(let kind, let message) = result else { throw Unexpected(description: "expected a failure") }
        return (kind, message)
    }

    /// array[index], failing the test instead of trapping when it is out of range.
    func item<T>(_ array: [T], _ index: Int) throws -> T {
        guard array.indices.contains(index) else {
            throw Unexpected(description: "index \(index) out of range for \(array.count) elements")
        }
        return array[index]
    }

    /// body.routes[index] of a fixture (OK.routes[0] in TypeScript).
    func rawRoute(_ body: JSONValue, _ index: Int) throws -> JSONValue {
        try item(try XCTUnwrap(body["routes"]?.arrayValue), index)
    }

    /// parseDirections({ code: 'Ok', routes })
    func parseRoutes(_ routes: [JSONValue]) -> Directions.Result {
        let body: JSONValue = ["code": "Ok", "routes": .array(routes)]
        return Directions.parse(body)
    }

    /// The first parsed route of { code: 'Ok', routes: [route] }.
    func firstOf(_ route: JSONValue) throws -> RouteCandidate {
        try item(try routesOf(parseRoutes([route])), 0)
    }

    func ll(_ lng: Double, _ lat: Double) -> LngLat { LngLat(lng, lat) }

    func ix(_ lng: Double, _ lat: Double, _ signal: Bool) -> RouteIntersection {
        RouteIntersection(location: LngLat(lng, lat), signal: signal)
    }

    /// TS: (lng, traffic_signal?) => ({ location: [lng, 35.2], traffic_signal }). An omitted flag is undefined: no key.
    func intersectionAt(_ lng: Double, _ trafficSignal: JSONValue? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["location": [.number(lng), 35.2]]
        if let flag = trafficSignal { o["traffic_signal"] = flag }
        return .object(o)
    }

    /// TS: (intersections) => ({ distance: 100, maneuver: { type: 'turn', location: [-80.84, 35.2] }, intersections })
    func stepWith(_ intersections: JSONValue) -> JSONValue {
        let maneuver: JSONValue = ["type": "turn", "location": [-80.84, 35.2]]
        return .object(["distance": 100, "maneuver": maneuver, "intersections": intersections])
    }

    /// TS: { steps: [...] }
    func leg(_ steps: [JSONValue]) -> JSONValue {
        .object(["steps": .array(steps)])
    }

    // MARK: - describe('parseDirections')

    // it('turns each route into a RouteCandidate')
    func test_parseDirections_turnsEachRouteIntoARouteCandidate() throws {
        let ok = try fixture("directions.ok.json")
        let routes = try routesOf(Directions.parse(ok))
        XCTAssertEqual(routes.count, 3)
        let first = try item(routes, 0)
        XCTAssertEqual(first.durationSec, 900.4)
        XCTAssertEqual(first.typicalDurationSec, 780.1)
        XCTAssertEqual(first.distanceM, 9300.5)
        // Mapbox never fills the city signal count; that comes from Signals.
        XCTAssertEqual(routes.map(\.signalCount), [nil, nil, nil])
        XCTAssertEqual(first.geometry.count, 5)
        XCTAssertEqual(first.geometry.first, ll(-80.8431, 35.2271))
        XCTAssertEqual(first.geometry.last, ll(-80.8295, 35.1527))
    }

    // it('leaves typical duration null when Mapbox sends none')
    func test_parseDirections_leavesTypicalDurationNullWhenMapboxSendsNone() throws {
        let ok = try fixture("directions.ok.json")
        let routes = try routesOf(Directions.parse(ok))
        XCTAssertEqual(try item(routes, 1).typicalDurationSec, 860)
        XCTAssertNil(try item(routes, 2).typicalDurationSec)
    }

    // it('places maneuvers at the cumulative distance of the steps before them')
    func test_parseDirections_placesManeuversAtTheCumulativeDistanceOfTheStepsBeforeThem() throws {
        let ok = try fixture("directions.ok.json")
        let maneuvers = try item(try routesOf(Directions.parse(ok)), 0).maneuvers
        XCTAssertEqual(maneuvers.map(\.kind), ["depart", "turn left", "fork slight right", "arrive right"])
        XCTAssertEqual(maneuvers.map(\.atDistanceM), [0, 800.5, 6800.5, 9300.5])
        XCTAssertEqual(try item(maneuvers, 1).location, ll(-80.8436, 35.2201))
    }

    // it('keeps counting distance across legs')
    func test_parseDirections_keepsCountingDistanceAcrossLegs() throws {
        let ok = try fixture("directions.ok.json")
        func step(_ distance: Double, _ lng: Double) -> JSONValue {
            let maneuver: JSONValue = ["type": "turn", "modifier": "left", "location": [.number(lng), 35.2]]
            return .object(["distance": .number(distance), "maneuver": maneuver])
        }
        let legs: JSONValue = [
            leg([step(100, -80.84), step(50, -80.83)]),
            leg([step(25, -80.82)]),
        ]
        let route = try rawRoute(ok, 0).merging(["legs": legs])
        let maneuvers = try firstOf(route).maneuvers
        XCTAssertEqual(maneuvers.map(\.atDistanceM), [0, 100, 150])
    }

    // it('works with a single route and no alternatives')
    func test_parseDirections_worksWithASingleRouteAndNoAlternatives() throws {
        let ok = try fixture("directions.ok.json")
        let routes = try routesOf(parseRoutes([try rawRoute(ok, 1)]))
        XCTAssertEqual(routes.count, 1)
        XCTAssertEqual(try item(routes, 0).id, try item(try routesOf(Directions.parse(ok)), 1).id)
    }

    // it('tolerates missing legs, steps and odd maneuvers')
    func test_parseDirections_toleratesMissingLegsStepsAndOddManeuvers() throws {
        let ok = try fixture("directions.ok.json")
        let base = try rawRoute(ok, 0)
        let noLegs = try firstOf(base.removing("legs"))
        XCTAssertEqual(noLegs.maneuvers, [])

        let oddSteps: [JSONValue] = [
            7,
            ["distance": 100],
            ["distance": "far", "maneuver": ["location": [-80.84, 35.22]]],
            ["distance": 40, "maneuver": ["type": "turn", "modifier": "right", "location": [999, 35]]],
            ["distance": -5, "maneuver": ["type": "arrive", "location": [-80.83, 35.15]]],
        ]
        let oddLegs: JSONValue = [
            JSONValue.null,
            ["steps": "nope"],
            leg(oddSteps),
        ]
        let maneuvers = try firstOf(base.merging(["legs": oddLegs])).maneuvers
        XCTAssertEqual(maneuvers, [
            Maneuver(atDistanceM: 100, kind: "unknown", location: ll(-80.84, 35.22)),
            Maneuver(atDistanceM: 140, kind: "arrive", location: ll(-80.83, 35.15)),
        ])
    }

    // it('drops bad points from a geometry and bad routes from the list')
    func test_parseDirections_dropsBadPointsFromAGeometryAndBadRoutesFromTheList() throws {
        let ok = try fixture("directions.ok.json")
        let base = try rawRoute(ok, 0)
        func line(_ coordinates: JSONValue) -> JSONValue {
            base.merging(["geometry": .object(["type": "LineString", "coordinates": coordinates])])
        }
        let mixed: JSONValue = [[-80.84, 35.22], [nil, 35.2], [-80.83], "x", [-80.83, 95], [-80.83, 35.15]]
        let onePoint: JSONValue = [[-80.84, 35.22]]
        let candidates: [JSONValue] = [
            line(mixed),
            line([]),
            line(onePoint),
            base.merging(["geometry": "encoded_polyline_string"]),
            base.removing("geometry"),
            base.merging(["duration": "soon"]),
            base.merging(["distance": -1]),
            JSONValue.null,
        ]
        let routes = try routesOf(parseRoutes(candidates))
        XCTAssertEqual(routes.count, 1)
        XCTAssertEqual(try item(routes, 0).geometry, [ll(-80.84, 35.22), ll(-80.83, 35.15)])
    }

    // it('derives each route id from its geometry, not its place in the response')
    func test_parseDirections_derivesEachRouteIdFromItsGeometryNotItsPlaceInTheResponse() throws {
        let ok = try fixture("directions.ok.json")
        let routes = try routesOf(Directions.parse(ok))
        for r in routes {
            XCTAssertEqual(r.id, Hash.routeIdFromGeometry(r.geometry))
            XCTAssertNotNil(r.id.range(of: "^route-[0-9a-f]{16}$", options: .regularExpression), r.id)
        }
        XCTAssertEqual(Set(routes.map(\.id)).count, 3)
        // The same routes in another order, as a refetch can return them, keep their ids.
        let reordered = try routesOf(parseRoutes([try rawRoute(ok, 2), try rawRoute(ok, 0), try rawRoute(ok, 1)]))
        XCTAssertEqual(reordered.map(\.id), [try item(routes, 2).id, try item(routes, 0).id, try item(routes, 1).id])
        // Times change with traffic; the id does not.
        let later = try routesOf(parseRoutes([try rawRoute(ok, 0).merging(["duration": 1234])]))
        XCTAssertEqual(try item(later, 0).id, try item(routes, 0).id)
    }

    // it('keeps ids unique if two routes in one response share a geometry')
    func test_parseDirections_keepsIdsUniqueIfTwoRoutesInOneResponseShareAGeometry() throws {
        let ok = try fixture("directions.ok.json")
        let r0 = try rawRoute(ok, 0)
        let r1 = try rawRoute(ok, 1)
        let twins = try routesOf(parseRoutes([r0, r1, r0, r0]))
        let id = Hash.routeIdFromGeometry(try item(twins, 0).geometry)
        XCTAssertEqual(twins.map(\.id), [id, try item(twins, 1).id, "\(id)-2", "\(id)-3"])
    }

    // it('counts intersections Mapbox flags as traffic signals, apart from signalCount')
    func test_parseDirections_countsIntersectionsMapboxFlagsAsTrafficSignalsApartFromSignalCount() throws {
        let ok = try fixture("directions.ok.json")
        let routes = try routesOf(Directions.parse(ok))
        // Two flagged intersections in the steps of the first route; the others carry no intersections at all.
        XCTAssertEqual(routes.map(\.providerSignalCount), [2, nil, nil])
        XCTAssertNil(try item(routes, 0).signalCount)
        // Nothing is known about signals until the signal data has been matched.
        XCTAssertEqual(routes.map(\.signalCoverage), [SignalCoverage.none, SignalCoverage.none, SignalCoverage.none])
    }

    // it('lists every intersection with its location and signal flag, in driving order')
    func test_parseDirections_listsEveryIntersectionWithItsLocationAndSignalFlagInDrivingOrder() throws {
        let ok = try fixture("directions.ok.json")
        let base = try rawRoute(ok, 0)
        func listOf(_ legs: JSONValue) throws -> [RouteIntersection]? {
            try firstOf(base.merging(["legs": legs])).intersections
        }

        let twoLegs: JSONValue = [
            leg([stepWith([intersectionAt(-80.84), intersectionAt(-80.83, true)]), stepWith([intersectionAt(-80.82, false)])]),
            leg([stepWith([intersectionAt(-80.81, true)])]),
        ]
        XCTAssertEqual(try listOf(twoLegs), [
            ix(-80.84, 35.2, false),
            ix(-80.83, 35.2, true),
            ix(-80.82, 35.2, false),
            ix(-80.81, 35.2, true),
        ])
        // The end of one step is the start of the next: listed once, and flagged if either copy is.
        let repeated: JSONValue = [
            leg([stepWith([intersectionAt(-80.84), intersectionAt(-80.83)]), stepWith([intersectionAt(-80.83, true), intersectionAt(-80.82)])]),
        ]
        XCTAssertEqual(try listOf(repeated), [
            ix(-80.84, 35.2, false),
            ix(-80.83, 35.2, true),
            ix(-80.82, 35.2, false),
        ])
        // Only a literal true is a signal; entries without a usable location are left out.
        let oddEntries: JSONValue = [
            intersectionAt(-80.84, "true"),
            ["traffic_signal": true],
            ["location": [999, 0]],
            7,
            nil,
        ]
        XCTAssertEqual(try listOf([leg([stepWith(oddEntries)])]), [ix(-80.84, 35.2, false)])
        // Intersections listed but empty is a known "none"; no lists at all is unknown.
        XCTAssertEqual(try listOf([leg([stepWith([])])]), [])
        XCTAssertNil(try listOf([leg([["distance": 100]])]))
        XCTAssertNil(try firstOf(base.removing("legs")).intersections) // legs: undefined
        // The hand-written fixtures: the first route of each carries intersections.
        XCTAssertEqual(try routesOf(Directions.parse(ok)).map { $0.intersections?.count }, [5, nil, nil])
        let freeway = try item(try routesOf(Directions.parse(try fixture("directions.freeway.json"))), 0)
        let freewayIntersections = try XCTUnwrap(freeway.intersections)
        XCTAssertEqual(freewayIntersections.filter(\.signal).count, try XCTUnwrap(freeway.providerSignalCount))
    }

    // it('counts signal flags across steps and legs, and tells none from no data')
    func test_parseDirections_countsSignalFlagsAcrossStepsAndLegsAndTellsNoneFromNoData() throws {
        let ok = try fixture("directions.ok.json")
        let base = try rawRoute(ok, 0)
        func flagCount(_ legs: JSONValue) throws -> Int? {
            try firstOf(base.merging(["legs": legs])).providerSignalCount
        }

        let threeFlags: JSONValue = [
            leg([stepWith([intersectionAt(-80.84), intersectionAt(-80.83, true)]), stepWith([intersectionAt(-80.82, true)])]),
            leg([stepWith([intersectionAt(-80.81, true)])]),
        ]
        XCTAssertEqual(try flagCount(threeFlags), 3)
        // Intersections listed but none flagged: a real zero.
        let noneFlagged: JSONValue = [
            leg([stepWith([intersectionAt(-80.84), intersectionAt(-80.83, false)]), stepWith([])]),
        ]
        XCTAssertEqual(try flagCount(noneFlagged), 0)
        // No intersections lists at all (steps=false, or another profile): unknown, not zero.
        let bareStep: JSONValue = ["distance": 100, "maneuver": ["type": "turn", "location": [-80.84, 35.2]]]
        XCTAssertNil(try flagCount([leg([bareStep])]))
        XCTAssertNil(try flagCount([leg([])]))
        XCTAssertNil(try firstOf(base.removing("legs")).providerSignalCount) // legs: undefined
        XCTAssertNil(try flagCount("legs"))
        // Only a literal true counts.
        let notTrue: JSONValue = [
            intersectionAt(-80.84, "true"),
            intersectionAt(-80.83, 1),
            intersectionAt(-80.82, JSONValue.null),
            7,
            nil,
            "x",
        ]
        XCTAssertEqual(try flagCount([leg([stepWith(notTrue)])]), 0)
        // The same flagged point ending one step and starting the next is one signal...
        let sharedPoint: JSONValue = [
            leg([stepWith([intersectionAt(-80.84), intersectionAt(-80.83, true)]), stepWith([intersectionAt(-80.83, true), intersectionAt(-80.82)])]),
        ]
        XCTAssertEqual(try flagCount(sharedPoint), 1)
        // ...but passing it again later in the route is a second one.
        let passedTwice: JSONValue = [
            leg([stepWith([intersectionAt(-80.83, true), intersectionAt(-80.82), intersectionAt(-80.83, true)])]),
        ]
        XCTAssertEqual(try flagCount(passedTwice), 2)
        // A flag without a usable location still counts.
        let noLocation: JSONValue = [
            ["traffic_signal": true],
            ["traffic_signal": true, "location": [999, 0]],
        ]
        XCTAssertEqual(try flagCount([leg([stepWith(noLocation)])]), 2)
        // Odd legs and steps are skipped, as for maneuvers.
        let oddLegs: JSONValue = [
            nil,
            ["steps": "nope"],
            leg([7, stepWith("nope"), stepWith([intersectionAt(-80.84, true)])]),
        ]
        XCTAssertEqual(try flagCount(oddLegs), 1)
    }

    // it('finds the stretch driven on freeway, ramps tagged motorway_link included')
    func test_parseDirections_findsTheStretchDrivenOnFreewayRampsTaggedMotorwayLinkIncluded() throws {
        let routes = try routesOf(Directions.parse(try fixture("directions.freeway.json")))
        let freeway = try item(routes, 0)
        let surface = try item(routes, 1)
        // Points are 0.001 degrees of latitude apart, 111.19 m. The on-ramp
        // (motorway_link) starts at point 2; the road leaving point 6 is the
        // off-ramp to a street (tertiary_link), so the span closes there.
        // Point 5 is marked only by classes: ["motorway"]; either field is enough.
        let spans = try XCTUnwrap(freeway.limitedAccessSpansM)
        XCTAssertEqual(spans.count, 1)
        let span = try item(spans, 0)
        XCTAssertEqual(span.startM, 2 * 111.19, accuracy: 0.5) // toBeCloseTo(_, 0)
        XCTAssertEqual(span.endM, 6 * 111.19, accuracy: 0.5)
        // A route with intersection data and no freeway (a trunk road in a tunnel is not one): known to have none.
        XCTAssertEqual(surface.limitedAccessSpansM, [])
        // The signal flags are still counted as before.
        XCTAssertEqual(freeway.providerSignalCount, 2)
    }

    // it('leaves the freeway spans unknown unless the intersection data is exactly as expected')
    func test_parseDirections_leavesTheFreewaySpansUnknownUnlessTheIntersectionDataIsExactlyAsExpected() throws {
        let freewayBody = try fixture("directions.freeway.json")
        let base = try rawRoute(freewayBody, 0)
        let coordinates = try XCTUnwrap(base["geometry"]?["coordinates"]?.arrayValue)
        let firstLeg = try item(try XCTUnwrap(base["legs"]?.arrayValue), 0)
        let steps = try XCTUnwrap(firstLeg["steps"]?.arrayValue)
        func spansOf(_ route: JSONValue) throws -> [DistanceSpanM]? {
            try firstOf(route).limitedAccessSpansM
        }
        /// TS: { ...step, intersections: [{ ...step.intersections[0], ...change }] } for the step at stepIndex.
        func withIntersection(_ stepIndex: Int, _ change: (JSONValue) -> JSONValue) -> JSONValue {
            var changed: [JSONValue] = []
            for (i, step) in steps.enumerated() {
                if i == stepIndex {
                    let original = step["intersections"]?.arrayValue?.first ?? JSONValue.object([:])
                    changed.append(step.merging(["intersections": .array([change(original)])]))
                } else {
                    changed.append(step)
                }
            }
            return base.merging(["legs": .array([leg(changed)])])
        }

        XCTAssertEqual(try spansOf(base)?.count, 1)
        // No steps or intersections (steps=false): unknown. The hand-written OK fixture has no geometry_index.
        XCTAssertNil(try spansOf(base.removing("legs")))
        XCTAssertNil(try spansOf(base.merging(["legs": []])))
        XCTAssertNil(try spansOf(base.merging(["legs": [leg([["distance": 5]])]])))
        let okRoutes = try routesOf(Directions.parse(try fixture("directions.ok.json")))
        XCTAssertEqual(okRoutes.map(\.limitedAccessSpansM), [nil, nil, nil])
        // A missing, fractional, out-of-range or backward index.
        XCTAssertNil(try spansOf(withIntersection(1) { $0.removing("geometry_index") }))
        XCTAssertNil(try spansOf(withIntersection(1) { $0.merging(["geometry_index": 2.5]) }))
        XCTAssertNil(try spansOf(withIntersection(1) { $0.merging(["geometry_index": 99]) }))
        let secondPoint = try item(coordinates, 1)
        XCTAssertNil(try spansOf(withIntersection(3) { $0.merging(["geometry_index": 1, "location": secondPoint]) }))
        // An index that does not land on the intersection's own location.
        XCTAssertNil(try spansOf(withIntersection(1) { $0.merging(["location": [-80.8402, 35.202]]) }))
        // A bad point dropped from the line would shift every index after it.
        var shifted: [JSONValue] = [try item(coordinates, 0), [999, 0]]
        shifted.append(contentsOf: coordinates.dropFirst())
        XCTAssertNil(try spansOf(base.merging(["geometry": .object(["coordinates": .array(shifted)])])))
    }

    // it('places later legs after earlier ones and joins a freeway span across a waypoint')
    func test_parseDirections_placesLaterLegsAfterEarlierOnesAndJoinsAFreewaySpanAcrossAWaypoint() throws {
        func point(_ i: Int) -> JSONValue {
            [-80.84, .number(35.2 + Double(i) * 0.001)]
        }
        func at(_ legIndex: Int, _ geometryIndex: Int, _ cls: String) -> JSONValue {
            .object([
                "location": point(legIndex * 2 + geometryIndex),
                "geometry_index": .number(Double(geometryIndex)),
                "mapbox_streets_v8": .object(["class": .string(cls)]),
            ])
        }
        func arrive(_ legIndex: Int) -> JSONValue {
            .object(["location": point(legIndex * 2 + 2), "geometry_index": 2])
        }
        func stepOf(_ intersections: [JSONValue]) -> JSONValue {
            .object(["intersections": .array(intersections)])
        }
        let legs: [JSONValue] = [
            leg([stepOf([at(0, 0, "street"), at(0, 1, "motorway")]), stepOf([arrive(0)])]),
            // geometry_index starts again at 0 in the second leg, which begins at point 2.
            leg([stepOf([at(1, 0, "motorway"), at(1, 1, "motorway")]), stepOf([arrive(1)])]),
        ]
        let route: JSONValue = .object([
            "duration": 60,
            "distance": 444,
            "geometry": .object(["coordinates": .array([0, 1, 2, 3, 4].map(point))]),
            "legs": .array(legs),
        ])
        let spans = try XCTUnwrap(try firstOf(route).limitedAccessSpansM)
        // On the freeway from point 1. The first leg's arrival point carries no road class, but the
        // second leg leaves the same point on the freeway, so it is one span, to the end of the route.
        XCTAssertEqual(spans.count, 1)
        let span = try item(spans, 0)
        XCTAssertEqual(span.startM, 111.19, accuracy: 0.5) // toBeCloseTo(_, 0)
        XCTAssertEqual(span.endM, 4 * 111.19, accuracy: 0.5)
    }

    // it('carries per-segment congestion and duration, one entry per segment of the line')
    func test_parseDirections_carriesPerSegmentCongestionAndDurationOneEntryPerSegmentOfTheLine() throws {
        let first = try item(try routesOf(Directions.parse(try fixture("directions.congestion.json"))), 0)
        XCTAssertEqual(first.geometry.count, 5)
        XCTAssertEqual(first.segmentTraffic, SegmentTraffic(
            congestion: [.low, .heavy, .severe, .moderate],
            durationSec: [80.2, 310.5, 402.1, 107.6]
        ))
    }

    // it('reads congestion it does not know as unknown, and drops a list of the wrong length')
    func test_parseDirections_readsCongestionItDoesNotKnowAsUnknownAndDropsAListOfTheWrongLength() throws {
        let routes = try routesOf(Directions.parse(try fixture("directions.congestion.json")))
        // "jammed" and null are not Mapbox levels: unknown, never a guess. Two durations for three segments: none.
        XCTAssertEqual(try item(routes, 1).segmentTraffic, SegmentTraffic(congestion: [.low, .unknown, .unknown], durationSec: nil))
        // No annotation at all (an older response, or a test): nil, not an empty list.
        XCTAssertNil(try item(routes, 2).segmentTraffic)
        XCTAssertEqual(try routesOf(Directions.parse(try fixture("directions.ok.json"))).map(\.segmentTraffic), [nil, nil, nil])
    }

    // it('drops annotations that cannot line up with the geometry')
    func test_parseDirections_dropsAnnotationsThatCannotLineUpWithTheGeometry() throws {
        let route = try rawRoute(try fixture("directions.congestion.json"), 0)
        let leg = try item(try XCTUnwrap(route["legs"]?.arrayValue), 0)
        let annotation = try XCTUnwrap(leg["annotation"])
        let congestion = try XCTUnwrap(annotation["congestion"]?.arrayValue)
        let duration = try XCTUnwrap(annotation["duration"]?.arrayValue)
        func parse(_ r: JSONValue) throws -> SegmentTraffic? { try firstOf(r).segmentTraffic }
        func withAnnotation(_ a: JSONValue) -> JSONValue { route.merging(["legs": .array([leg.merging(["annotation": a])])]) }
        // One entry short.
        XCTAssertEqual(
            try parse(withAnnotation(annotation.merging(["congestion": .array(Array(congestion.dropFirst()))]))),
            SegmentTraffic(congestion: nil, durationSec: duration.compactMap(\.numberValue))
        )
        // A duration that is not a number of 0 or more spoils that list only.
        XCTAssertEqual(
            try parse(withAnnotation(annotation.merging(["duration": [80.2, -1, 402.1, 107.6]]))),
            SegmentTraffic(congestion: [.low, .heavy, .severe, .moderate], durationSec: nil)
        )
        // A bad point dropped from the line would shift every entry after it.
        var coordinates = try XCTUnwrap(route["geometry"]?["coordinates"]?.arrayValue)
        coordinates[2] = ["x", "y"]
        XCTAssertNil(try parse(route.merging(["geometry": ["type": "LineString", "coordinates": .array(coordinates)]])))
        // Not an object, not a list, a leg without one.
        XCTAssertNil(try parse(withAnnotation("congestion")))
        XCTAssertNil(try parse(withAnnotation(["congestion": "heavy", "duration": 3])))
        XCTAssertNil(try parse(route.merging(["legs": [leg, ["steps": []]]])))
    }

    // it('joins the annotations of several legs into one list for the whole line')
    func test_parseDirections_joinsTheAnnotationsOfSeveralLegsIntoOneListForTheWholeLine() throws {
        let route = try rawRoute(try fixture("directions.congestion.json"), 0)
        let leg = try item(try XCTUnwrap(route["legs"]?.arrayValue), 0)
        let legs: JSONValue = [
            leg.merging(["annotation": ["congestion": ["low", "heavy"], "duration": [80.2, 310.5]]]),
            leg.merging(["annotation": ["congestion": ["severe", "moderate"], "duration": [402.1, 107.6]]]),
        ]
        XCTAssertEqual(try firstOf(route.merging(["legs": legs])).segmentTraffic, SegmentTraffic(
            congestion: [.low, .heavy, .severe, .moderate],
            durationSec: [80.2, 310.5, 402.1, 107.6]
        ))
    }

    // it('treats a non-numeric typical duration as missing')
    func test_parseDirections_treatsANonNumericTypicalDurationAsMissing() throws {
        let ok = try fixture("directions.ok.json")
        let routes = try routesOf(parseRoutes([try rawRoute(ok, 0).merging(["duration_typical": "n/a"])]))
        XCTAssertNil(try item(routes, 0).typicalDurationSec)
    }

    // it('reports NoRoute and an empty route list as no-route')
    func test_parseDirections_reportsNoRouteAndAnEmptyRouteListAsNoRoute() throws {
        let noRoute = try fixture("directions.noroute.json")
        XCTAssertEqual(try failureOf(Directions.parse(noRoute)).kind, .noRoute)
        XCTAssertEqual(try failureOf(parseRoutes([])).kind, .noRoute)
        XCTAssertEqual(Directions.ErrorKind.noRoute.rawValue, "no-route")
    }

    // it('reports NoSegment and other error codes with their message')
    func test_parseDirections_reportsNoSegmentAndOtherErrorCodesWithTheirMessage() throws {
        let noSegment: JSONValue = ["code": "NoSegment"]
        XCTAssertEqual(try failureOf(Directions.parse(noSegment)).kind, .noSegment)
        XCTAssertEqual(Directions.ErrorKind.noSegment.rawValue, "no-segment")
        let invalid = try failureOf(Directions.parse(try fixture("directions.invalidinput.json")))
        XCTAssertEqual(invalid.kind, .api)
        XCTAssertTrue(invalid.message.contains("InvalidInput"), invalid.message)
        XCTAssertTrue(invalid.message.contains("Coordinate is invalid"), invalid.message)
        let profile: JSONValue = ["code": "ProfileNotFound"]
        let profileMessage = try failureOf(Directions.parse(profile)).message
        XCTAssertTrue(profileMessage.contains("ProfileNotFound"), profileMessage)
    }

    // it('reports anything else as malformed instead of throwing')
    func test_parseDirections_reportsAnythingElseAsMalformedInsteadOfThrowing() throws {
        // null, undefined, 'Ok', 42, [], {}, { code: 7 }, { code: 'Ok' }, { code: 'Ok', routes: {} }
        let bodies: [JSONValue?] = [
            JSONValue.null,
            nil,
            JSONValue.string("Ok"),
            JSONValue.number(42),
            JSONValue.array([]),
            JSONValue.object([:]),
            JSONValue.object(["code": 7]),
            JSONValue.object(["code": "Ok"]),
            JSONValue.object(["code": "Ok", "routes": JSONValue.object([:])]),
        ]
        for body in bodies {
            XCTAssertEqual(try failureOf(Directions.parse(body)).kind, .malformed, String(describing: body))
        }
        let unusable: JSONValue = ["code": "Ok", "routes": [["duration": 1, "distance": 1]]]
        XCTAssertEqual(try failureOf(Directions.parse(unusable)).kind, .malformed)
    }
}
