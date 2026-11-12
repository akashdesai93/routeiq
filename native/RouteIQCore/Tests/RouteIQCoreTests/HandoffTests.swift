import Foundation
import XCTest
import RouteIQCore

// Mirrors tests/handoff.test.ts on the made-up road network of DriveWorld.swift.
final class HandoffTests: XCTestCase {
    private func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }

    private func fixtureRoutes(_ name: String) throws -> [RouteCandidate] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let body = try JSONValue.parse(Data(contentsOf: root.appendingPathComponent("tests/fixtures/\(name)")))
        return try XCTUnwrap(Directions.parse(body).routes, "expected routes")
    }

    private func world(_ name: DriveWorld.RouteName, _ durationSec: Double = 1200) -> RouteCandidate {
        DriveWorld.candidate(name, at(0, 0), durationSec)!
    }

    /// A route through the corners (meters east/north of the made-up origin).
    private func custom(_ id: String, _ corners: [(Double, Double)]) -> RouteCandidate {
        var r = world(.A)
        r.id = id
        r.geometry = corners.map { at($0.0, $0.1) }
        return r
    }

    /// The main road A with a 500 m detour north between startX and endX.
    private func detour(_ id: String, _ startX: Double, _ endX: Double) -> RouteCandidate {
        custom(id, [(0, 0), (startX, 0), (startX, 500), (endX, 500), (endX, 0), (20000, 0)])
    }

    private func lineDistanceM(_ point: LngLat, _ line: [LngLat]) -> Double {
        let project = Geo.localProjector(point)
        var best = Double.infinity
        for i in 1..<line.count {
            best = min(best, Geo.pointToSegment(project(point), project(line[i - 1]), project(line[i])).distanceM)
        }
        return best
    }

    private func expectWellPlaced(_ points: [HandoffWaypoint], _ accepted: RouteCandidate, _ alternatives: [RouteCandidate] = [], line: UInt = #line) {
        let o = HandoffOptions.default
        for p in points {
            // Every route a point claims to rule out really is away from it.
            for id in p.excludesRouteIds {
                if let alt = alternatives.first(where: { $0.id == id }) {
                    XCTAssertGreaterThan(lineDistanceM(p.position, alt.geometry), o.sharedToleranceM, line: line)
                }
            }
            XCTAssertLessThan(lineDistanceM(p.position, accepted.geometry), 1, line: line)
            XCTAssertGreaterThanOrEqual(Geo.distanceM(p.position, accepted.geometry[0]), o.endpointClearanceM, line: line)
            XCTAssertGreaterThanOrEqual(Geo.distanceM(p.position, accepted.geometry[accepted.geometry.count - 1]), o.endpointClearanceM, line: line)
        }
        let along = points.map(\.atDistanceM)
        XCTAssertEqual(along, along.sorted(), line: line)
    }

    /// The waypoints of a Google Maps URL, decoded back to [lng, lat].
    private func urlWaypoints(_ url: String) -> [LngLat] {
        guard let raw = URLComponents(string: url)?.queryItems?.first(where: { $0.name == "waypoints" })?.value else { return [] }
        return raw.split(separator: "|").map { pair in
            let parts = pair.split(separator: ",").map { Double($0)! }
            return LngLat(parts[1], parts[0])
        }
    }

    private func query(_ url: String, _ name: String) -> String? {
        URLComponents(string: url)?.queryItems?.first { $0.name == name }?.value
    }

    /// Twelve alternatives, each leaving A for one detour; detour k is 400 + 70k m long.
    private var MANY: [RouteCandidate] {
        (0..<12).map { k in
            let start = 1000 + 1500 * Double(k)
            return detour("alt-\(k < 10 ? "0" : "")\(k)", start, start + 400 + 70 * Double(k))
        }
    }

    private func names(_ ids: [String]) -> [String] { ids.map { String($0.split(separator: "-")[0]) } }

    // MARK: - describe('handoffWaypoints')

    func testHandoffWaypoints_putsOnePointJustAfterEachSplitOnTheAcceptedRouteInDrivingOrder() {
        let a = world(.A)
        let others = [world(.B), world(.C)]
        let points = Handoff.handoffWaypoints(a, others)
        XCTAssertEqual(points.count, 2)
        guard points.count == 2 else { return }
        expectWellPlaced(points, a, others)
        // B leaves A at 5 km, C at 8 km; each point sits a little past its split.
        XCTAssertGreaterThan(points[0].atDistanceM, 5000)
        XCTAssertLessThan(points[0].atDistanceM, 5300)
        XCTAssertEqual(names(points[0].excludesRouteIds), ["B"])
        XCTAssertEqual(names(points[1].excludesRouteIds), ["C"])
        XCTAssertGreaterThan(points[1].atDistanceM, 8000)
        XCTAssertLessThan(points[1].atDistanceM, 8300)
        XCTAssertGreaterThan(points[0].decisivenessM, points[1].decisivenessM)
    }

    func testHandoffWaypoints_usesOnePointForAlternativesThatLeaveAtTheSamePlace() throws {
        let b = world(.B)
        let others = [world(.A), world(.C), world(.D), world(.BA)]
        let points = Handoff.handoffWaypoints(b, others)
        expectWellPlaced(points, b, others)
        // A and C both leave B at its 5 km corner: one point rules out both.
        let first = try XCTUnwrap(points.first)
        XCTAssertLessThan(first.atDistanceM, 5300)
        XCTAssertTrue(Set(names(first.excludesRouteIds)).isSuperset(of: ["A", "C"]))
        // D and BA leave further along the north road and get their own points.
        XCTAssertGreaterThanOrEqual(points.count, 2)
        XCTAssertLessThanOrEqual(points.count, Handoff.googleMapsMaxWaypointsMobile)
    }

    func testHandoffWaypoints_keepsTo3WaypointsForMobileAnd9ElsewhereChoosingTheMostDecisiveSplits() {
        let a = world(.A)
        let many = MANY
        let mobile = Handoff.handoffWaypoints(a, many, options: HandoffOptions(maxWaypoints: 3))
        XCTAssertEqual(mobile.count, 3)
        XCTAssertEqual(mobile.flatMap(\.excludesRouteIds), ["alt-09", "alt-10", "alt-11"])
        expectWellPlaced(mobile, a, many)
        // The default is the mobile limit.
        XCTAssertEqual(Handoff.handoffWaypoints(a, many), mobile)

        let desktop = Handoff.handoffWaypoints(a, many, options: HandoffOptions(maxWaypoints: 9))
        XCTAssertEqual(desktop.count, 9)
        XCTAssertEqual(desktop.flatMap(\.excludesRouteIds), ["03", "04", "05", "06", "07", "08", "09", "10", "11"].map { "alt-\($0)" })
        expectWellPlaced(desktop, a, many)
        // Never more than Google's nine, whatever is asked.
        XCTAssertEqual(Handoff.handoffWaypoints(a, many, options: HandoffOptions(maxWaypoints: 20)).count, 9)
        XCTAssertEqual(Handoff.handoffWaypoints(a, many, options: HandoffOptions(maxWaypoints: 0)), [])
    }

    func testHandoffWaypoints_putsNoPointNearTheOriginOrDestination() throws {
        let a = world(.A)
        // Detours inside the first and last 450 m, and one starting 100 m out.
        XCTAssertEqual(Handoff.handoffWaypoints(a, [detour("start", 50, 450), detour("end", 19550, 19950)]), [])
        let early = Handoff.handoffWaypoints(a, [detour("early", 100, 1000)])
        XCTAssertEqual(early.count, 1)
        let o = HandoffOptions.default
        let first = try XCTUnwrap(early.first)
        XCTAssertGreaterThanOrEqual(first.atDistanceM, o.endpointClearanceM)
        XCTAssertLessThanOrEqual(first.atDistanceM, o.endpointClearanceM + o.sampleStepM)
        expectWellPlaced(early, a)
        // E loops north near the end; its point stays clear of the destination.
        let late = Handoff.handoffWaypoints(a, [world(.E)])
        XCTAssertEqual(late.count, 1)
        expectWellPlaced(late, a)
    }

    func testHandoffWaypoints_givesNoWaypointsForIdenticalRoutesOrNoAlternatives() {
        let a = world(.A)
        XCTAssertEqual(Handoff.handoffWaypoints(a, []), [])
        XCTAssertEqual(Handoff.handoffWaypoints(a, [a]), [])
        var same = world(.A)
        same.id = "same-roads"
        XCTAssertEqual(Handoff.handoffWaypoints(a, [same]), [])
    }

    func testHandoffWaypoints_neverPutsAPointInAShortSharedGapWhereTheAlternativeStillIs() throws {
        let a = world(.A)
        // X leaves A at 1000 m for a 160 m spur, is back on A from 1160 to 1250 m, then leaves for 650 m.
        let x = custom("X", [(0, 0), (1000, 0), (1000, 400), (1160, 400), (1160, 0), (1250, 0), (1250, 400), (1900, 400), (1900, 0), (20000, 0)])
        let points = Handoff.handoffWaypoints(a, [x])
        XCTAssertEqual(points.count, 1)
        XCTAssertEqual(points.first?.excludesRouteIds, ["X"])
        expectWellPlaced(points, a, [x])
        XCTAssertGreaterThan(try XCTUnwrap(points.first).atDistanceM, 1250)
    }

    func testHandoffWaypoints_rulesOutEveryAlternativeBeforeSpendingASecondPointOnOne() {
        let a = world(.A)
        // X has three long detours; Y one shorter one. Three points: two for X, one for Y.
        let x = custom("X", [
            (0, 0), (2000, 0), (2000, 500), (5000, 500), (5000, 0), (7000, 0), (7000, 500), (10000, 500),
            (10000, 0), (12000, 0), (12000, 500), (15000, 500), (15000, 0), (20000, 0),
        ])
        let y = detour("Y", 16000, 17000)
        let points = Handoff.handoffWaypoints(a, [x, y], options: HandoffOptions(maxWaypoints: 3))
        XCTAssertEqual(points.count, 3)
        XCTAssertEqual(points.flatMap(\.excludesRouteIds).sorted(), ["X", "X", "Y"])
        expectWellPlaced(points, a, [x, y])
    }

    func testHandoffWaypoints_ignoresDivergencesShorterThanMinDivergenceM() {
        XCTAssertEqual(Handoff.handoffWaypoints(world(.A), [detour("blip", 5000, 5200)]), [])
    }

    func testHandoffWaypoints_isDeterministicAndDoesNotDependOnTheOrderOfTheAlternatives() {
        let a = world(.A)
        let many = MANY
        let once = Handoff.handoffWaypoints(a, many, options: HandoffOptions(maxWaypoints: 9))
        XCTAssertEqual(Handoff.handoffWaypoints(a, many, options: HandoffOptions(maxWaypoints: 9)), once)
        XCTAssertEqual(Handoff.handoffWaypoints(a, many.reversed(), options: HandoffOptions(maxWaypoints: 9)), once)
    }

    func testHandoffWaypoints_pinsTheRecordedMapboxRoutes() throws {
        let routes = try fixtureRoutes("directions.ok.json")
        for accepted in routes {
            let points = Handoff.handoffWaypoints(accepted, routes)
            XCTAssertLessThanOrEqual(points.count, Handoff.googleMapsMaxWaypointsMobile)
            expectWellPlaced(points, accepted)
            XCTAssertEqual(Handoff.handoffWaypoints(accepted, routes.reversed()), points)
        }
    }

    // MARK: - describe('googleMapsUrl')

    private var origin: LngLat { at(0, 0) }
    private var destination: LngLat { at(20000, 0) }
    private func fixed6(_ v: Double) -> String { String(format: "%.6f", v) }

    func testGoogleMapsUrl_buildsAMapsUrlsDirectionsLinkWithEncodedCommasAndPipes() {
        let points = Handoff.handoffWaypoints(world(.A), [world(.B), world(.C)])
        let url = Handoff.googleMapsUrl(origin, destination, points)
        XCTAssertTrue(url.hasPrefix("https://www.google.com/maps/dir/?api=1&origin="))
        XCTAssertTrue(url.contains("&travelmode=driving"))
        XCTAssertTrue(url.contains("%2C"))
        XCTAssertTrue(url.contains("%7C"))
        let q = String(url.split(separator: "?")[1])
        XCTAssertFalse(q.contains(",") || q.contains("|"))
        XCTAssertEqual(query(url, "origin"), "\(fixed6(origin.lat)),\(fixed6(origin.lng))")
        XCTAssertEqual(query(url, "destination"), "\(fixed6(destination.lat)),\(fixed6(destination.lng))")
        let back = urlWaypoints(url)
        XCTAssertEqual(back.count, 2)
        for (i, p) in back.enumerated() where i < points.count {
            XCTAssertLessThan(Geo.distanceM(p, points[i].position), 0.5)
        }
    }

    func testGoogleMapsUrl_leavesOutWaypointsWhenThereAreNone() {
        let url = Handoff.googleMapsUrl(origin, destination, [])
        XCTAssertFalse(url.contains("waypoints"))
        XCTAssertEqual(url, "https://www.google.com/maps/dir/?api=1&origin=\(fixed6(origin.lat))%2C\(fixed6(origin.lng))"
            + "&destination=\(fixed6(destination.lat))%2C\(fixed6(destination.lng))&travelmode=driving")
    }

    func testGoogleMapsUrl_leavesTheOriginOutWhenItIsNullSoGoogleStartsFromTheDeviceItself() {
        XCTAssertEqual(
            Handoff.googleMapsUrl(nil, destination, []),
            "https://www.google.com/maps/dir/?api=1&destination=\(fixed6(destination.lat))%2C\(fixed6(destination.lng))&travelmode=driving"
        )
    }

    func testGoogleMapsUrl_staysWithin2048CharactersDroppingTheLeastDecisiveWaypointsFirst() {
        let nine = Handoff.handoffWaypoints(world(.A), MANY, options: HandoffOptions(maxWaypoints: 9))
        let full = Handoff.googleMapsUrl(origin, destination, nine)
        XCTAssertLessThanOrEqual(full.utf16.count, Handoff.googleMapsMaxUrlLength)
        XCTAssertEqual(urlWaypoints(full).count, 9)

        // A tighter cap: room for about four waypoints.
        let cap = Handoff.googleMapsUrl(origin, destination, []).utf16.count + "&waypoints=".count + 4 * 30
        let short = Handoff.googleMapsUrl(origin, destination, nine, options: HandoffOptions(maxUrlLength: Double(cap)))
        XCTAssertLessThanOrEqual(short.utf16.count, cap)
        let kept = urlWaypoints(short)
        XCTAssertGreaterThan(kept.count, 0)
        XCTAssertLessThan(kept.count, 9)
        // The kept ones are the most decisive, still in driving order.
        let expected = Array(nine.sorted { $0.decisivenessM > $1.decisivenessM }.prefix(kept.count)).sorted { $0.atDistanceM < $1.atDistanceM }
        for (i, p) in kept.enumerated() { XCTAssertLessThan(Geo.distanceM(p, expected[i].position), 0.5) }

        // A cap too small for any waypoint still gives the plain directions link.
        XCTAssertEqual(Handoff.googleMapsUrl(origin, destination, nine, options: HandoffOptions(maxUrlLength: 10)), Handoff.googleMapsUrl(origin, destination, []))
    }

    func testGoogleMapsUrl_neverSendsMoreThanNineWaypoints() throws {
        let twelve = MANY.enumerated().map { k, alt in
            HandoffWaypoint(position: at(1000 + 1500 * Double(k), 0), atDistanceM: 1000 + 1500 * Double(k), decisivenessM: Double(k), excludesRouteIds: [alt.id])
        }
        let kept = urlWaypoints(Handoff.googleMapsUrl(origin, destination, twelve))
        XCTAssertEqual(kept.count, 9)
        XCTAssertLessThan(Geo.distanceM(try XCTUnwrap(kept.first), at(1000 + 1500 * 3, 0)), 0.5)
    }

    // MARK: - describe('wazeUrl')

    func testWazeUrl_navigatesToTheDestinationOnlyLatitudeFirst() {
        XCTAssertEqual(Handoff.wazeUrl(LngLat(-80.843124, 35.227085)), "https://waze.com/ul?ll=35.227085%2C-80.843124&navigate=yes")
        XCTAssertEqual(Handoff.wazeUrl(LngLat(-80.8, 35.2)), "https://waze.com/ul?ll=35.200000%2C-80.800000&navigate=yes")
    }
}
