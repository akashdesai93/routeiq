import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import RouteIQKit

/// A URLProtocol that accepts every request and never answers, so a request
/// only ends when it is cancelled. Records when loading starts and stops.
final class StallingURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var _started = 0
    private static var _stopped = 0

    static var started: Int { lock.lock(); defer { lock.unlock() }; return _started }
    static var stopped: Int { lock.lock(); defer { lock.unlock() }; return _stopped }

    static func reset() {
        lock.lock()
        _started = 0
        _stopped = 0
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self._started += 1
        Self.lock.unlock()
    }

    override func stopLoading() {
        Self.lock.lock()
        Self._stopped += 1
        Self.lock.unlock()
    }
}

/// Issue #42: cancelling the Task must cancel the URLSession request itself,
/// not just report "aborted" while the request runs on to its timeout.
final class URLSessionTransportTests: XCTestCase {
    static func stallingSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StallingURLProtocol.self]
        return URLSession(configuration: config)
    }

    /// Set once, from any thread.
    final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
        func set() { lock.lock(); value = true; lock.unlock() }
    }

    /// True when `task` finishes within `seconds`. Never waits longer, even if
    /// the task never ends (which is exactly the bug these tests catch).
    static func finishes<T>(_ task: Task<T, Error>, within seconds: Double) async -> Bool {
        let done = Flag()
        Task { _ = try? await task.value; done.set() }
        return await eventually(seconds) { done.isSet }
    }

    static func finishes<T>(_ task: Task<T, Never>, within seconds: Double) async -> Bool {
        let done = Flag()
        Task { _ = await task.value; done.set() }
        return await eventually(seconds) { done.isSet }
    }

    /// Waits up to `seconds` for `condition`, checking every 10 ms.
    static func eventually(_ seconds: Double, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return condition()
    }

    func testCancellingTheTaskCancelsTheRequest() async throws {
        StallingURLProtocol.reset()
        let transport = URLSessionTransport(session: Self.stallingSession())
        let url = try XCTUnwrap(URL(string: "https://api.mapbox.com/directions/v5/stall"))
        let request = Task { try await transport.get(url) }

        let started = await Self.eventually(5) { StallingURLProtocol.started == 1 }
        XCTAssertTrue(started, "the request never started")
        request.cancel()

        // The call ends promptly, well before the 20 s timeout, with an error...
        let ended = await Self.finishes(request, within: 5)
        XCTAssertTrue(ended, "the cancelled request kept running")
        guard ended else { return }
        do {
            _ = try await request.value
            XCTFail("a cancelled request returned a response")
        } catch {}
        // ...because the request itself was stopped.
        let stopped = await Self.eventually(5) { StallingURLProtocol.stopped == 1 }
        XCTAssertTrue(stopped, "the URLSession request was not cancelled")
    }

    func testATaskCancelledBeforeTheRequestStartsNeverLeavesItRunning() async throws {
        StallingURLProtocol.reset()
        let transport = URLSessionTransport(session: Self.stallingSession())
        let url = try XCTUnwrap(URL(string: "https://api.mapbox.com/directions/v5/stall"))
        let request = Task { () -> (status: Int, body: Data) in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await transport.get(url)
        }
        let ended = await Self.finishes(request, within: 5)
        XCTAssertTrue(ended, "the cancelled request kept running")
        guard ended else { return }
        do {
            _ = try await request.value
            XCTFail("a cancelled request returned a response")
        } catch {}
        // Whether or not loading began, nothing is left loading.
        let settled = await Self.eventually(5) { StallingURLProtocol.started == StallingURLProtocol.stopped }
        XCTAssertTrue(settled, "started \(StallingURLProtocol.started), stopped \(StallingURLProtocol.stopped)")
    }

    func testTheClientReportsACancelledRequestAsAborted() async throws {
        StallingURLProtocol.reset()
        let client = DirectionsClient(transport: URLSessionTransport(session: Self.stallingSession()))
        let fetch = Task {
            await client.fetch(
                origin: TestPointsForKit.origin, destination: TestPointsForKit.destination, token: "pk.test-token"
            )
        }
        let started = await Self.eventually(5) { StallingURLProtocol.started == 1 }
        XCTAssertTrue(started)
        fetch.cancel()
        let ended = await Self.finishes(fetch, within: 5)
        XCTAssertTrue(ended, "the cancelled fetch kept running")
        guard ended else { return }
        let result = await fetch.value
        guard case .failure(let kind, _) = result else { return XCTFail("expected a failure") }
        XCTAssertEqual(kind, .aborted)
        let stopped = await Self.eventually(5) { StallingURLProtocol.stopped == 1 }
        XCTAssertTrue(stopped)
    }
}

import RouteIQCore

enum TestPointsForKit {
    static let origin = TestPoints.uptownCharlotte.position
    static let destination = TestPoints.southPark.position
}
