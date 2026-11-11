import Foundation
import RouteIQCore

/// One route as the route list shows it: everything already ranked and put
/// into words by RouteIQCore, so the SwiftUI view only lays it out.
public struct RouteRow: Hashable, Sendable, Identifiable {
    public var id: String
    /// 1 is the recommended route.
    public var rank: Int
    public var isRecommended: Bool { rank == 1 }
    /// "14 min"
    public var eta: String
    /// "5.8 mi"
    public var distance: String
    /// "3 min slower than typical", or "No typical time available".
    public var delay: String
    /// "12 signals", "≥ 9 signals (partial)" or "Signals: unknown".
    public var signals: String
    /// Why the route is ranked where it is ("Fastest right now").
    public var reason: String
    /// The line to draw, longitude first.
    public var geometry: [LngLat]
}

/// The state of the one-screen planner, as plain data.
public enum RoutePlan: Hashable, Sendable {
    case idle
    case loading
    case routes([RouteRow])
    /// A message fit to show the user.
    case failed(String)

    /// Ranks the routes (best ETA first, signals only break ties) and puts
    /// each into words. The order is the ranking, so the first row is the
    /// recommended route.
    public static func rows(for routes: [RouteCandidate], signalData: SignalData? = nil) -> [RouteRow] {
        let counted = Signals.withSignalCounts(routes, signalData).routes
        return Rank.rankRoutes(counted).map { ranked in
            let r = ranked.route
            return RouteRow(
                id: r.id,
                rank: ranked.rank,
                eta: Format.formatDuration(r.durationSec),
                distance: Format.formatDistance(r.distanceM),
                delay: Format.formatDelay(Format.delayVsTypicalSec(r)),
                signals: Format.formatSignalCount(r.signalCount, r.signalCoverage),
                reason: ranked.reasons.first ?? "",
                geometry: r.geometry
            )
        }
    }

    /// The plan for a Directions answer.
    public static func from(_ result: Directions.Result, signalData: SignalData? = nil) -> RoutePlan {
        switch result {
        case .ok(let routes):
            return .routes(rows(for: routes, signalData: signalData))
        case .failure(let kind, let message):
            // A cancelled request is replaced by the next one; there is nothing to show for it.
            return kind == .aborted ? .loading : .failed(message)
        }
    }
}

/// The trip the first screen plans, between two public test points.
public enum DemoTrip {
    public static let origin = TestPoints.uptownCharlotte
    public static let destination = TestPoints.southPark
}

/// Reads the Mapbox public token the build put into the app. Only a public
/// token ("pk.") is accepted: a secret token must never ship in an app.
public enum MapboxToken {
    public enum Status: Hashable, Sendable {
        case ok(String)
        case missing
        case secret
        case malformed
    }

    /// Ported from checkToken in src/config.ts. A build setting that was never
    /// filled in arrives as an empty string or as the literal "$(MBX_ACCESS_TOKEN)".
    public static func check(_ raw: String?) -> Status {
        let token = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if token.isEmpty || token == "pk.your_public_token_here" || token.hasPrefix("$(") { return .missing }
        if token.hasPrefix("sk.") { return .secret }
        if !token.hasPrefix("pk.") { return .malformed }
        return .ok(token)
    }

    /// Words for a token that cannot be used, or nil when it is fine.
    public static func help(_ status: Status) -> String? {
        switch status {
        case .ok: return nil
        case .missing: return "This build has no Mapbox token. Add the MAPBOX_PUBLIC_TOKEN secret to the repository and rebuild."
        case .secret: return "This build carries a secret Mapbox token (sk.). Only a public token (pk.) may ship in the app."
        case .malformed: return "The Mapbox token in this build is not a public token (it should start with pk.)."
        }
    }
}
