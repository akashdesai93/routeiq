import Foundation
import XCTest
import RouteIQCore
import RouteIQKit

final class RoutePlanTests: XCTestCase {
    static func route(_ id: String, _ durationSec: Double, signals: Int? = nil, typical: Double? = nil) -> RouteCandidate {
        RouteCandidate(
            id: id,
            geometry: [LngLat(-80.84, 35.22), LngLat(-80.83, 35.15)],
            durationSec: durationSec,
            typicalDurationSec: typical,
            distanceM: 9300,
            signalCount: signals,
            signalCoverage: signals == nil ? .none : .full
        )
    }

    func testRowsFollowTheRankingAndPutEachRouteIntoWords() {
        // Within 30 s of the fastest with fewer signals: the calmer route is recommended.
        let rows = RoutePlan.rows(for: [Self.route("fast", 900, signals: 14, typical: 780), Self.route("calm", 920, signals: 11)])
        XCTAssertEqual(rows.map(\.id), ["calm", "fast"])
        XCTAssertEqual(rows.map(\.rank), [1, 2])
        XCTAssertTrue(rows[0].isRecommended)
        XCTAssertFalse(rows[1].isRecommended)
        XCTAssertEqual(rows[0].reason, "Within 30 s of the fastest, 3 fewer signals")
        XCTAssertEqual(rows[1].eta, "15 min")
        XCTAssertEqual(rows[1].distance, "5.8 mi")
        XCTAssertEqual(rows[1].delay, "2 min slower than typical")
        XCTAssertEqual(rows[0].delay, "No typical time available")
        XCTAssertEqual(rows[0].signals, "11 signals")
        XCTAssertEqual(rows[0].geometry.count, 2)
    }

    func testSignalsStayUnknownUntilSignalDataIsLoaded() {
        let rows = RoutePlan.rows(for: [Self.route("a", 900)])
        XCTAssertEqual(rows.first?.signals, "Signals: unknown")
        XCTAssertEqual(rows.first?.reason, "Only route found")
    }

    func testTheDemoTripParsesIntoRankedRows() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/directions.ok.json"))
        guard case .routes(let rows) = RoutePlan.from(Directions.parse(data: data)) else {
            return XCTFail("expected routes")
        }
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows.map(\.rank), [1, 2, 3])
        XCTAssertEqual(Set(rows.map(\.id)).count, 3)
        // The fixture's second route (840 s) is the fastest, so it leads, whatever order Mapbox sent.
        XCTAssertEqual(rows.map(\.eta), ["14 min", "15 min", "17 min"])
        XCTAssertEqual(rows[0].reason, "Fastest right now")
        XCTAssertEqual(rows[0].delay, "About the typical time")
        XCTAssertEqual(rows[2].delay, "No typical time available")
        // The provider's own signal flags are a cross-check, never the count.
        XCTAssertEqual(rows.map(\.signals), Array(repeating: "Signals: unknown", count: 3))
    }

    func testFailuresBecomeAMessageAndACancelledRequestShowsNothing() {
        XCTAssertEqual(RoutePlan.from(.failure(.network, "Could not reach Mapbox.")), .failed("Could not reach Mapbox."))
        XCTAssertEqual(RoutePlan.from(.failure(.aborted, "Route request cancelled.")), .loading)
    }

    func testTheDemoTripIsBetweenTwoPublicTestPoints() {
        XCTAssertEqual(DemoTrip.origin.id, "uptown")
        XCTAssertEqual(DemoTrip.destination.id, "southpark")
    }

    func testOnlyAPublicTokenIsAccepted() {
        XCTAssertEqual(MapboxToken.check(" pk.abc "), .ok("pk.abc"))
        XCTAssertEqual(MapboxToken.check(nil), .missing)
        XCTAssertEqual(MapboxToken.check(""), .missing)
        XCTAssertEqual(MapboxToken.check("pk.your_public_token_here"), .missing)
        // An Info.plist value whose build setting was never filled in.
        XCTAssertEqual(MapboxToken.check("$(MBX_ACCESS_TOKEN)"), .missing)
        XCTAssertEqual(MapboxToken.check("sk.abc"), .secret)
        XCTAssertEqual(MapboxToken.check("abc"), .malformed)
        XCTAssertNil(MapboxToken.help(.ok("pk.abc")))
        XCTAssertNotNil(MapboxToken.help(.secret))
    }
}
