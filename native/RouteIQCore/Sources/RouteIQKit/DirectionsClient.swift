import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import RouteIQCore

/// One HTTP GET: the status code and the body. Swapped out in tests so they
/// never touch the network.
public protocol HTTPTransport: Sendable {
    func get(_ url: URL) async throws -> (status: Int, body: Data)
}

/// The real transport: URLSession, no caching, a 20 s timeout.
public struct URLSessionTransport: HTTPTransport {
    public init() {}

    public func get(_ url: URL) async throws -> (status: Int, body: Data) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = "GET"
        return try await withCheckedThrowingContinuation { continuation in
            let task = URLSession.shared.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                continuation.resume(returning: (status, data ?? Data()))
            }
            task.resume()
        }
    }
}

/// Asks Mapbox for routes, ported from fetchDirections in
/// src/providers/mapbox/client.ts. Never throws: HTTP, network and
/// cancellation failures come back as a typed result with a message fit to
/// show the user, and the token never appears in a message.
public struct DirectionsClient: Sendable {
    let transport: HTTPTransport

    public init(transport: HTTPTransport = URLSessionTransport()) {
        self.transport = transport
    }

    static let cancelled = Directions.Result.failure(.aborted, "Route request cancelled.")

    /// Setup help for a token Mapbox refused, or nil when the status is not about the token.
    /// Unlike the web app, there is no page URL to allow-list: an app's token is set at build time.
    public static func tokenErrorHelp(_ status: Int) -> String? {
        if status == 401 {
            return "Mapbox rejected the token (401). Check that the app was built with a valid, active public token (MAPBOX_PUBLIC_TOKEN)."
        }
        if status == 403 {
            return "Mapbox refused the token (403). Check the token's scopes and any restrictions on it."
        }
        return nil
    }

    public func fetch(
        origin: LngLat,
        destination: LngLat,
        token: String,
        originHeadingDeg: Double? = nil
    ) async -> Directions.Result {
        guard
            let urlString = DirectionsRequest.urlString(origin: origin, destination: destination, token: token, originHeadingDeg: originHeadingDeg),
            let url = URL(string: urlString)
        else {
            return .failure(.malformed, "A pin is not at a valid map coordinate.")
        }
        if Task.isCancelled { return Self.cancelled }

        let status: Int
        let body: Data
        do {
            (status, body) = try await transport.get(url)
        } catch {
            if Task.isCancelled || error is CancellationError { return Self.cancelled }
            // The error itself is deliberately not shown: it adds nothing for the user and may echo the URL.
            return .failure(.network, "Could not reach Mapbox. Check your internet connection and try again.")
        }
        if Task.isCancelled { return Self.cancelled }

        if let help = Self.tokenErrorHelp(status) { return .failure(.token, help) }
        if status == 429 {
            return .failure(.rateLimit, "Mapbox is rate limiting route requests (429). Wait a minute, then try again.")
        }
        // Error bodies below 500 are JSON too ({ code, message }); anything else reads as malformed.
        let result = Directions.parse(data: body)
        if (200..<300).contains(status) { return Self.redact(result, token) }
        // Non-2xx: keep Mapbox's own explanation when it sent one (422 InvalidInput, 404 ProfileNotFound).
        if case .failure(.api, _) = result { return Self.redact(result, token) }
        return .failure(.api, "Mapbox Directions is not available right now (HTTP \(status)). Try again shortly.")
    }

    /// Belt and braces: an API message that echoes the request must not show the token.
    static func redact(_ result: Directions.Result, _ token: String) -> Directions.Result {
        guard case .failure(let kind, let message) = result, !token.isEmpty, message.contains(token) else { return result }
        return .failure(kind, message.replacingOccurrences(of: token, with: "[token]"))
    }
}
