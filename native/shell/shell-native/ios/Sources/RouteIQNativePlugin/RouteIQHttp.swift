import Foundation

/// What a request came back with: an HTTP answer (any status), or one of
/// "not-allowed", "cancelled", "timeout" and "network".
enum RouteIQHttpOutcome {
    case response(status: Int, body: String, ms: Int)
    case failure(code: String)
}

/// Route requests for the web app, made by iOS itself (URLSession) instead of
/// by the web view. A web view's own requests may be held back while the
/// phone is locked; native ones go on for as long as the app runs, which
/// during a drive the location stream sees to.
///
/// Only GET, and only to Mapbox's API host. Redirects are not followed, so a
/// request cannot be sent on to another host.
///
/// Privacy: the URL holds the Mapbox token and the driver's position. It is
/// used for the request and kept nowhere; nothing in this file logs or stores
/// a URL, a response or an error (an error can carry the URL, so only its
/// kind is passed on).
///
/// `get` and `cancel` are called on the main thread, and every answer is
/// given on the main thread.
final class RouteIQHttp {
    /// The only place a request may go.
    static let allowedPrefix = "https://api.mapbox.com/"
    static let allowedHost = "api.mapbox.com"
    static let minTimeoutSec: TimeInterval = 1
    static let maxTimeoutSec: TimeInterval = 60

    /// One request that has not been answered yet.
    private final class Pending {
        var task: URLSessionDataTask?
        var done: ((RouteIQHttpOutcome) -> Void)?
    }

    /// Answers every redirect with "do not follow": the 3xx itself comes back.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    private let session: URLSession
    private var pending: [String: Pending] = [:]

    init() {
        // Nothing is kept between requests: no cache, no cookies.
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.waitsForConnectivity = false
        config.timeoutIntervalForResource = RouteIQHttp.maxTimeoutSec
        session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    /// The URL when it is an https address on Mapbox's API host, nil for anything else.
    static func allowedURL(_ text: String) -> URL? {
        guard text.hasPrefix(allowedPrefix),
              let url = URL(string: text),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https",
              parts.host == allowedHost,
              parts.user == nil,
              parts.password == nil,
              parts.port == nil
        else { return nil }
        return url
    }

    /// Starts a GET. `done` is called exactly once, on the main thread: with
    /// the answer, or with why there is none. `id` names the request for `cancel`.
    func get(id: String, url text: String, timeoutSec: TimeInterval, _ done: @escaping (RouteIQHttpOutcome) -> Void) {
        guard let url = RouteIQHttp.allowedURL(text) else {
            done(.failure(code: "not-allowed"))
            return
        }
        // The same id again: the earlier request is over.
        if let earlier = pending[id] {
            finish(id, earlier, .failure(code: "cancelled"))
        }
        let limit = min(max(timeoutSec, RouteIQHttp.minTimeoutSec), RouteIQHttp.maxTimeoutSec)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = limit
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let entry = Pending()
        entry.done = done
        let startedAt = Date()
        let task = session.dataTask(with: request) { [weak self] data, response, error in
            // On the session's own queue: read the answer here, hand it over on the main thread.
            let outcome = RouteIQHttp.outcome(data: data, response: response, error: error, startedAt: startedAt)
            DispatchQueue.main.async {
                self?.finish(id, entry, outcome)
            }
        }
        entry.task = task
        pending[id] = entry
        // The request's own timeout counts idle time only. This one is the
        // whole request, so a slow trickle cannot keep it open.
        DispatchQueue.main.asyncAfter(deadline: .now() + limit) { [weak self] in
            self?.finish(id, entry, .failure(code: "timeout"))
        }
        task.resume()
    }

    /// Stops the request with this id, if it is still out. It is answered with "cancelled".
    func cancel(id: String) {
        guard let entry = pending[id] else { return }
        finish(id, entry, .failure(code: "cancelled"))
    }

    /// Answers a request once and stops its task. Later calls for the same request do nothing.
    private func finish(_ id: String, _ entry: Pending, _ outcome: RouteIQHttpOutcome) {
        guard let done = entry.done else { return }
        entry.done = nil
        if pending[id] === entry {
            pending[id] = nil
        }
        // Does nothing when the task has already ended.
        entry.task?.cancel()
        entry.task = nil
        done(outcome)
    }

    private static func outcome(data: Data?, response: URLResponse?, error: Error?, startedAt: Date) -> RouteIQHttpOutcome {
        if let error = error {
            let failure = error as NSError
            if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled {
                return .failure(code: "cancelled")
            }
            if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorTimedOut {
                return .failure(code: "timeout")
            }
            return .failure(code: "network")
        }
        guard let http = response as? HTTPURLResponse else {
            return .failure(code: "network")
        }
        let body = String(decoding: data ?? Data(), as: UTF8.self)
        let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
        return .response(status: http.statusCode, body: body, ms: ms)
    }
}
