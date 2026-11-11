import Foundation
import XCTest
import RouteIQCore
import RouteIQKit

/// Stands in for the network: records each request and answers with a canned response.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    enum Answer {
        case respond(Int, Data)
        case fail(Error)
        /// Never answers until the task is cancelled, then throws CancellationError.
        case hang
    }

    private let lock = NSLock()
    private var _urls: [URL] = []
    let answer: Answer

    init(_ answer: Answer) { self.answer = answer }

    var urls: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return _urls
    }

    func get(_ url: URL) async throws -> (status: Int, body: Data) {
        lock.lock()
        _urls.append(url)
        lock.unlock()
        switch answer {
        case .respond(let status, let body):
            return (status, body)
        case .fail(let error):
            throw error
        case .hang:
            while !Task.isCancelled { try await Task.sleep(nanoseconds: 5_000_000) }
            throw CancellationError()
        }
    }

    static func json(_ status: Int, _ value: JSONValue) -> FakeTransport {
        .init(.respond(status, try! JSONEncoder().encode(value)))
    }

    static func text(_ status: Int, _ text: String) -> FakeTransport {
        .init(.respond(status, Data(text.utf8)))
    }
}

/// Mirrors describe('fetchDirections') in tests/mapbox.test.ts.
final class DirectionsClientTests: XCTestCase {
    /// A placeholder, not a real token.
    static let token = "pk.test-token"
    static let origin = TestPoints.uptownCharlotte.position
    static let destination = TestPoints.southPark.position

    static func fixtureData(_ name: String) throws -> Data {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try Data(contentsOf: root.appendingPathComponent("tests").appendingPathComponent("fixtures").appendingPathComponent(name))
    }

    func fetch(_ transport: FakeTransport, heading: Double? = nil, origin: LngLat = origin) async -> Directions.Result {
        await DirectionsClient(transport: transport).fetch(origin: origin, destination: Self.destination, token: Self.token, originHeadingDeg: heading)
    }

    func kind(_ result: Directions.Result) -> Directions.ErrorKind? {
        if case .failure(let kind, _) = result { return kind }
        return nil
    }

    func message(_ result: Directions.Result) -> String {
        if case .failure(_, let message) = result { return message }
        return ""
    }

    func testRequestsTheBuiltURLAndReturnsRoutes() async throws {
        let transport = FakeTransport(.respond(200, try Self.fixtureData("directions.ok.json")))
        let result = await fetch(transport)
        XCTAssertEqual(result.routes?.count, 3)
        XCTAssertEqual(transport.urls.count, 1)
        XCTAssertEqual(transport.urls.first?.absoluteString, DirectionsRequest.urlString(origin: Self.origin, destination: Self.destination, token: Self.token))
    }

    func testPassesTheHeadingOfAMovingVehicleOnToTheRequest() async throws {
        let transport = FakeTransport(.respond(200, try Self.fixtureData("directions.ok.json")))
        let result = await fetch(transport, heading: 187)
        XCTAssertNotNil(result.routes)
        XCTAssertTrue(transport.urls.first?.absoluteString.contains("bearings=187%2C45%3B") ?? false)
    }

    func testPassesA200NoRouteBodyThroughAsNoRoute() async throws {
        let result = await fetch(FakeTransport(.respond(200, try Self.fixtureData("directions.noroute.json"))))
        XCTAssertEqual(kind(result), .noRoute)
    }

    func testExplains401And403AsTokenProblems() async {
        let unauthorized = await fetch(.json(401, ["message": "Not Authorized - Invalid Token"]))
        XCTAssertEqual(kind(unauthorized), .token)
        XCTAssertTrue(message(unauthorized).contains("rejected the token"))
        let forbidden = await fetch(.json(403, ["message": "Forbidden"]))
        XCTAssertEqual(kind(forbidden), .token)
        // The web app points at its localhost URL here; an app has no page URL, so it names the status.
        XCTAssertTrue(message(forbidden).contains("403"))
    }

    func testExplains429AsRateLimiting() async {
        let limited = await fetch(.json(429, ["message": "Too Many Requests"]))
        XCTAssertEqual(kind(limited), .rateLimit)
        XCTAssertTrue(message(limited).contains("429"))
    }

    func testKeepsMapboxExplanationForA422AndIsGenericForA500() async throws {
        let invalid = await fetch(FakeTransport(.respond(422, try Self.fixtureData("directions.invalidinput.json"))))
        XCTAssertEqual(kind(invalid), .api)
        XCTAssertTrue(message(invalid).contains("Coordinate is invalid"))
        let down = await fetch(.text(500, "Internal Server Error"))
        XCTAssertEqual(kind(down), .api)
        XCTAssertTrue(message(down).contains("HTTP 500"))
    }

    func testReportsA200ThatIsNotJSONAsMalformed() async {
        let result = await fetch(.text(200, "<html>proxy login</html>"))
        XCTAssertEqual(kind(result), .malformed)
    }

    func testReportsANetworkFailureWithoutLeakingTheRequest() async {
        struct Offline: Error, CustomStringConvertible { var description: String { "Failed to fetch \(DirectionsClientTests.token)" } }
        let result = await fetch(FakeTransport(.fail(Offline())))
        XCTAssertEqual(kind(result), .network)
        XCTAssertFalse(message(result).contains(Self.token))
    }

    func testReportsACancelledRequestAsAborted() async {
        // Cancelled while waiting for the answer.
        let transport = FakeTransport(.hang)
        let pending = Task { await self.fetch(transport) }
        try? await Task.sleep(nanoseconds: 20_000_000)
        pending.cancel()
        let waited = await pending.value
        XCTAssertEqual(kind(waited), .aborted)

        // Cancelled before it started, with the answer ready: still not a result to show.
        let late = Task { () -> Directions.Result in
            withUnsafeCurrentTask { $0?.cancel() }
            return await self.fetch(.json(200, ["code": "Ok", "routes": []]))
        }
        let early = await late.value
        XCTAssertEqual(kind(early), .aborted)
    }

    func testNeverShowsTheTokenEvenIfMapboxEchoesItBack() async {
        let echo: JSONValue = ["code": "InvalidInput", "message": .string("Bad query: access_token=\(Self.token)")]
        let result = await fetch(.json(422, echo))
        XCTAssertFalse(message(result).contains(Self.token))
        XCTAssertTrue(message(result).contains("[token]"))
    }

    func testDoesNotCallTheNetworkForAnInvalidCoordinate() async {
        let transport = FakeTransport.json(200, ["code": "Ok"])
        let result = await fetch(transport, origin: LngLat(.nan, .nan))
        XCTAssertEqual(kind(result), .malformed)
        XCTAssertEqual(transport.urls.count, 0)
    }
}
