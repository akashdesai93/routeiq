import Foundation
import XCTest
import RouteIQCore

/// Mirrors describe('buildDirectionsUrl') in tests/mapbox.test.ts.
final class DirectionsRequestTests: XCTestCase {
    /// A placeholder, not a real token.
    static let token = "pk.test-token"
    static let uptown = TestPoints.uptownCharlotte.position
    static let southPark = TestPoints.southPark.position

    static func url(_ heading: Double? = nil) -> String {
        DirectionsRequest.urlString(origin: uptown, destination: southPark, token: token, originHeadingDeg: heading)!
    }

    /// The decoded query, as `new URL(url).searchParams` gives it.
    static func query(_ url: String) -> [String: String] {
        let comps = URLComponents(string: url.replacingOccurrences(of: "+", with: "%20"))!
        var out: [String: String] = [:]
        for item in comps.queryItems ?? [] { out[item.name] = item.value ?? "" }
        return out
    }

    func testPutsCoordinatesInLongitudeLatitudeOrderOriginFirst() {
        XCTAssertTrue(Self.url().contains(
            "https://api.mapbox.com/directions/v5/mapbox/driving-traffic/-80.8431,35.2271%3B-80.8295,35.1527?"
        ))
    }

    func testAsksForTrafficAwareAlternativesWithFullGeoJSONAndSteps() {
        let q = Self.query(Self.url())
        XCTAssertEqual(q["alternatives"], "true")
        XCTAssertEqual(q["geometries"], "geojson")
        XCTAssertEqual(q["overview"], "full")
        XCTAssertEqual(q["steps"], "true")
        XCTAssertEqual(q["access_token"], Self.token)
        // Turn guidance for a live drive.
        XCTAssertEqual(q["banner_instructions"], "true")
        XCTAssertEqual(q["voice_instructions"], "true")
        XCTAssertEqual(q["voice_units"], "imperial")
    }

    func testEncodesTheTokenAndTrimsLongCoordinates() throws {
        let odd = try XCTUnwrap(DirectionsRequest.urlString(
            origin: LngLat(-80.84312345678, 35.2), destination: LngLat(-80.8, 35.1), token: "pk.a b&c=d"
        ))
        XCTAssertTrue(odd.contains("/-80.843123,35.2%3B-80.8,35.1?"))
        XCTAssertFalse(odd.contains("a b&c=d"))
        XCTAssertEqual(Self.query(odd)["access_token"], "pk.a b&c=d")
        // URLSearchParams writes a space as "+".
        XCTAssertTrue(odd.hasSuffix("access_token=pk.a+b%26c%3Dd"))
    }

    func testIsNilForACoordinateThatIsNotOnTheMap() {
        XCTAssertNil(DirectionsRequest.urlString(origin: LngLat(.nan, 35), destination: Self.southPark, token: Self.token))
        XCTAssertNil(DirectionsRequest.urlString(origin: Self.uptown, destination: LngLat(-80, 91), token: Self.token))
    }

    func testSendsNoBearingsForATripPlannedFromAPin() {
        XCTAssertNil(Self.query(Self.url())["bearings"])
        XCTAssertFalse(Self.url().contains("depart_at"))
        XCTAssertEqual(Self.url(.nan), Self.url())
    }

    func testSendsTheHeadingOfAMovingVehicleForTheOriginOnly() {
        func bearings(_ heading: Double) -> String? { Self.query(Self.url(heading))["bearings"] }
        // "angle,range" for the origin, then an empty entry for the destination.
        XCTAssertEqual(bearings(187.4), "187,45;")
        XCTAssertEqual(bearings(0), "0,45;")
        // Mapbox takes 0 to 360; headings are brought into range.
        XCTAssertEqual(bearings(359.7), "0,45;")
        XCTAssertEqual(bearings(-90), "270,45;")
        XCTAssertEqual(bearings(450), "90,45;")
        // Everything else about the request is the same, and the semicolon is encoded.
        let withHeading = Self.url(187)
        XCTAssertTrue(withHeading.contains("bearings=187%2C45%3B"))
        XCTAssertEqual(withHeading.replacingOccurrences(of: "&bearings=187%2C45%3B", with: ""), Self.url())
    }
}
