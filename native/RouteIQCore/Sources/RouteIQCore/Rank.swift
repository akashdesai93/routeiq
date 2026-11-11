import Foundation

/// Route ranking, ported from src/core/rank.ts.
///
/// The rule: **best traffic-aware ETA first; the signal count only breaks ties.**
/// There is deliberately NO per-signal time penalty: a traffic-aware ETA
/// already contains the typical delay at every signal on the route.
public enum Rank {
    /// Two routes whose ETAs are this close are a tie that signals may break.
    public static let defaultEtaTieWindowSec = 30.0

    /// A duration that is not a real number sorts last.
    static func eta(_ route: RouteCandidate) -> Double {
        route.durationSec.isFinite ? route.durationSec : .infinity
    }

    /// The fallback order everywhere: ETA, then distance, then id.
    static func byEta(_ a: RouteCandidate, _ b: RouteCandidate) -> Int {
        let c = JS.compare(eta(a), eta(b))
        if c != 0 { return c }
        let d = JS.compare(a.distanceM, b.distanceM)
        if d != 0 { return d }
        return JS.compare(a.id, b.id)
    }

    /// The signal count, when it is the whole answer. A partial count is a lower bound, so unknown here.
    static func knownSignals(_ route: RouteCandidate) -> Int? {
        route.signalCoverage == .full ? route.signalCount : nil
    }

    /// "3 fewer signals", "1 more signal".
    static func signalGap(_ n: Int, _ word: String) -> String {
        "\(n) \(word) \(n == 1 ? "signal" : "signals")"
    }

    /// Orders routes from most to least recommended and says why.
    ///
    /// 1. The fastest route has the lowest durationSec.
    /// 2. Every route within `etaTieWindowSec` of the fastest (30 s is a tie,
    ///    31 s is not) is tied with it; ties never chain.
    /// 3. Among the tied routes, fewer signals wins; same count falls back to
    ///    ETA, then distance, then id.
    /// 4. A tied route with an unknown count (nil, or coverage not full) keeps
    ///    the place its ETA gives it; only known counts are reordered among
    ///    the places they hold.
    /// 5. Routes outside the window follow, by ETA, then distance, then id.
    ///
    /// Pure and deterministic: any input order gives the same ranking. A
    /// window that is negative or not a number is 0 (exact ties only).
    public static func rankRoutes(_ routes: [RouteCandidate], etaTieWindowSec: Double = defaultEtaTieWindowSec) -> [RankedRoute] {
        let windowSec = etaTieWindowSec.isFinite && etaTieWindowSec > 0 ? etaTieWindowSec : 0

        let sorted = routes.jsSorted(byEta)
        guard let fastest = sorted.first else { return [] }
        let bestSec = eta(fastest)
        func isTied(_ r: RouteCandidate) -> Bool { eta(r) == bestSec || eta(r) - bestSec <= windowSec }

        // Work with positions in `sorted`, since two routes can be equal as values.
        let tied = sorted.indices.filter { isTied(sorted[$0]) }
        var known = tied
            .filter { knownSignals(sorted[$0]) != nil }
            .jsSorted { a, b in
                let c = JS.compare(knownSignals(sorted[a])!, knownSignals(sorted[b])!)
                return c != 0 ? c : byEta(sorted[a], sorted[b])
            }
        var ordered: [Int] = tied.map { i in knownSignals(sorted[i]) == nil ? i : known.removeFirst() }
        ordered += sorted.indices.filter { !isTied(sorted[$0]) }

        let top = ordered[0]
        let fastestIndex = 0
        let sharedBest = sorted.filter { eta($0) == bestSec }.count > 1

        func reason(_ i: Int) -> String {
            let route = sorted[i]
            if ordered.count == 1 { return "Only route found" }
            if eta(route) == .infinity { return "No travel time available" }
            let behindSec = eta(route) - bestSec
            if !isTied(route) {
                let whole = behindSec.rounded(.up)
                return "\(whole < 60 ? "\(JS.string(whole)) s" : Format.formatDuration(behindSec)) slower than the fastest"
            }
            let time = behindSec > 0
                ? "Within \(JS.string(JS.round(windowSec))) s of the fastest"
                : (sharedBest ? "Tied for fastest" : "Fastest right now")
            // What the signals had to do with it. The recommended route is compared
            // with the route it beat on signals (the fastest one, or the one sharing
            // its ETA); every other tied route is compared with the recommended one.
            let isTop = i == top
            let other: Int? = !isTop
                ? top
                : (i != fastestIndex ? fastestIndex : ordered.first { $0 != i && eta(sorted[$0]) == bestSec })
            guard let mine = knownSignals(route), let o = other, let theirs = knownSignals(sorted[o]) else { return time }
            if isTop { return mine < theirs ? "\(time), \(signalGap(theirs - mine, "fewer"))" : time }
            if mine == theirs { return "\(time), same number of signals as the recommended route" }
            return mine > theirs
                ? "\(time), \(signalGap(mine - theirs, "more")) than the recommended route"
                : "\(time), \(signalGap(theirs - mine, "fewer")) than the recommended route"
        }

        return ordered.enumerated().map { rank, i in
            RankedRoute(route: sorted[i], rank: rank + 1, reasons: [reason(i)])
        }
    }

    /// The id of the top-ranked route: the default selection. Nil when there are no routes.
    public static func recommendedRouteId(_ routes: [RouteCandidate], etaTieWindowSec: Double = defaultEtaTieWindowSec) -> String? {
        rankRoutes(routes, etaTieWindowSec: etaTieWindowSec).first?.route.id
    }
}
