import Foundation

// Route hand-off to Google Maps and Waze (PLAN step 9), ported from
// src/core/handoff.ts. Google Maps picks its own route between origin and
// destination; handoffWaypoints puts a few points on the accepted route just
// after each place where an alternative leaves it, so a route through them
// cannot be that alternative. Waze deep links take a destination only.
// Pure and deterministic.

public struct HandoffOptions: Hashable, Sendable {
    /// Most waypoints returned: 3 for a mobile browser, 9 elsewhere (Google's limits).
    public var maxWaypoints: Double
    /// The accepted route is sampled every this many meters to find where alternatives leave it.
    public var sampleStepM: Double
    /// A sample this close (meters) to an alternative's line counts as on that alternative too.
    public var sharedToleranceM: Double
    /// A stretch away from the accepted route must be at least this long (meters) to count as a split.
    public var minDivergenceM: Double
    /// A shared stretch shorter than this (meters) inside a divergence does not end it.
    public var minSharedM: Double
    /// The waypoint goes this many meters past the split, on the accepted route.
    public var afterSplitM: Double
    /// No waypoint within this many meters of the origin or destination, along the route or in a straight line.
    public var endpointClearanceM: Double
    /// Google Maps URL length cap; waypoints are dropped, least decisive first, until the URL fits.
    public var maxUrlLength: Double
    /// Decimal places for coordinates in URLs. 6 is about 0.1 m.
    public var coordinateDecimals: Int

    public init(
        maxWaypoints: Double = Double(Handoff.googleMapsMaxWaypointsMobile),
        sampleStepM: Double = 25,
        sharedToleranceM: Double = 30,
        minDivergenceM: Double = 300,
        minSharedM: Double = 200,
        afterSplitM: Double = 150,
        endpointClearanceM: Double = 500,
        maxUrlLength: Double = Double(Handoff.googleMapsMaxUrlLength),
        coordinateDecimals: Int = 6
    ) {
        self.maxWaypoints = maxWaypoints
        self.sampleStepM = sampleStepM
        self.sharedToleranceM = sharedToleranceM
        self.minDivergenceM = minDivergenceM
        self.minSharedM = minSharedM
        self.afterSplitM = afterSplitM
        self.endpointClearanceM = endpointClearanceM
        self.maxUrlLength = maxUrlLength
        self.coordinateDecimals = coordinateDecimals
    }

    public static let `default` = HandoffOptions()
}

/// One point to route Google Maps through, on the accepted route.
public struct HandoffWaypoint: Hashable, Sendable {
    public var position: LngLat
    /// Where it sits on the accepted route, in meters from the start.
    public var atDistanceM: Double
    /// How long the longest divergence it rules out is, in meters. The least decisive are dropped first.
    public var decisivenessM: Double
    /// Ids of the alternatives a route through this point cannot be.
    public var excludesRouteIds: [String]

    public init(position: LngLat, atDistanceM: Double, decisivenessM: Double, excludesRouteIds: [String]) {
        self.position = position
        self.atDistanceM = atDistanceM
        self.decisivenessM = decisivenessM
        self.excludesRouteIds = excludesRouteIds
    }
}

public enum Handoff {
    /// Google Maps URLs: "up to three waypoints supported on mobile browsers".
    public static let googleMapsMaxWaypointsMobile = 3
    /// Google Maps URLs: "a maximum of nine waypoints supported otherwise".
    public static let googleMapsMaxWaypoints = 9
    /// Google Maps URLs: "URLs are limited to 2,048 characters for each request".
    public static let googleMapsMaxUrlLength = 2048

    struct Divergence {
        let startM: Double
        let endM: Double
        let routeId: String
        /// Per sample of the accepted route: true where this alternative is away from it.
        let off: [Bool]
    }

    static func usable(_ line: [LngLat]) -> Bool { line.count >= 2 && line.allSatisfy(Geo.isValidLngLat) }

    /// Stretches of the accepted route where `off[i]` holds, merged across short shared gaps.
    static func divergences(_ samplesM: [Double], _ off: [Bool], _ routeId: String, _ o: HandoffOptions) -> [Divergence] {
        var runs: [(startM: Double, endM: Double)] = []
        var start: Double?
        for (i, isOff) in off.enumerated() {
            if isOff && start == nil { start = samplesM[i] }
            if !isOff, let s = start {
                runs.append((s, samplesM[i - 1]))
                start = nil
            }
        }
        if let s = start { runs.append((s, samplesM[samplesM.count - 1])) }
        var merged: [(startM: Double, endM: Double)] = []
        for run in runs {
            if let last = merged.last, run.startM - last.endM < o.minSharedM {
                merged[merged.count - 1].endM = run.endM
            } else {
                merged.append(run)
            }
        }
        return merged.filter { $0.endM - $0.startM >= o.minDivergenceM }.map { Divergence(startM: $0.startM, endM: $0.endM, routeId: routeId, off: off) }
    }

    /// Points on `accepted` that pin Google Maps to it, in driving order: one
    /// just after each split where an alternative leaves the accepted route.
    /// At most `maxWaypoints`; each alternative's longest divergence first,
    /// then the others, longest first. Empty when no alternative differs,
    /// when every split is too close to an end, or the route is unusable.
    public static func handoffWaypoints(_ accepted: RouteCandidate, _ alternatives: [RouteCandidate], options o: HandoffOptions = .default) -> [HandoffWaypoint] {
        let maxWaypoints = JS.min(o.maxWaypoints.rounded(.down), Double(googleMapsMaxWaypoints))
        // As in the TypeScript, a NaN maxWaypoints passes this test and then limits nothing.
        if !usable(accepted.geometry) || maxWaypoints <= 0 || !(o.sampleStepM > 0) { return [] }
        let line = accepted.geometry
        let lengthM = Geo.alongRouteM(line)[line.count - 1]
        let origin = line[0]
        let destination = line[line.count - 1]
        let box = Geo.boundsOfValid(line)
        let project = Geo.localProjector(LngLat((box.west + box.east) / 2, (box.south + box.north) / 2))

        var samplesM: [Double] = []
        var m = 0.0
        while m < lengthM {
            samplesM.append(m)
            m += o.sampleStepM
        }
        samplesM.append(lengthM)
        let samples = samplesM.map { project(Geo.pointAtDistance(line, $0)!.point) }

        let others = alternatives.filter { alt in
            !(JS.Key(alt.id) == JS.Key(accepted.id)) && usable(alt.geometry) && !Select.sameRouteGeometry(alt.geometry, line)
        }
        var all: [Divergence] = []
        for alt in others {
            let altXY = alt.geometry.map(project)
            let off = samples.map { !Geo.nearLine($0, altXY, o.sharedToleranceM) }
            all.append(contentsOf: divergences(samplesM, off, alt.id, o))
        }
        // Most decisive first; ties go to the earlier split, then the smaller id, so input order never matters.
        all = all.jsSorted { a, b in
            let byLength = JS.sign((b.endM - b.startM) - (a.endM - a.startM))
            if byLength != 0 { return byLength }
            let byStart = JS.sign(a.startM - b.startM)
            if byStart != 0 { return byStart }
            return JS.less(a.routeId, b.routeId) ? -1 : (JS.less(b.routeId, a.routeId) ? 1 : 0)
        }

        // Waypoints sit on samples only, and only where the alternative they rule out is away from the accepted route.
        func rulesOut(_ i: Int, _ d: Divergence) -> Bool { samplesM[i] >= d.startM && samplesM[i] <= d.endM && d.off[i] }
        struct Chosen {
            let i: Int
            let position: LngLat
            let decisivenessM: Double
            /// A JavaScript Set: insertion order kept, keys by code units.
            var excludes: [String]

            mutating func add(_ id: String) {
                if !excludes.contains(where: { JS.Key($0) == JS.Key(id) }) { excludes.append(id) }
            }

            func has(_ id: String) -> Bool { excludes.contains { JS.Key($0) == JS.Key(id) } }
        }
        var chosen: [Chosen] = []
        func place(_ d: Divergence) {
            if let covering = chosen.firstIndex(where: { rulesOut($0.i, d) }) {
                chosen[covering].add(d.routeId)
                return
            }
            if Double(chosen.count) >= maxWaypoints { return }
            // Just past the split, moved on a sample at a time until off the alternative and clear of both ends.
            let fromM = JS.max(d.startM + o.afterSplitM, o.endpointClearanceM)
            let toM = JS.min(d.endM, lengthM - o.endpointClearanceM)
            var i = 0
            while i < samplesM.count && samplesM[i] <= toM {
                defer { i += 1 }
                if samplesM[i] < fromM || !rulesOut(i, d) { continue }
                let p = Geo.pointAtDistance(line, samplesM[i])!.point
                if Geo.distanceM(p, origin) < o.endpointClearanceM || Geo.distanceM(p, destination) < o.endpointClearanceM { continue }
                chosen.append(Chosen(i: i, position: p, decisivenessM: d.endM - d.startM, excludes: [d.routeId]))
                return
            }
        }
        // First every alternative's most decisive divergence, then the remaining ones, longest first.
        var firsts: [Int] = []
        for (k, d) in all.enumerated() {
            if !chosen.contains(where: { $0.has(d.routeId) }) && !firsts.contains(where: { JS.Key(all[$0].routeId) == JS.Key(d.routeId) }) {
                firsts.append(k)
                place(d)
            }
        }
        for (k, d) in all.enumerated() where !firsts.contains(k) { place(d) }
        return chosen
            .jsSorted { JS.compare($0.i, $1.i) }
            .map { c in
                HandoffWaypoint(
                    position: c.position,
                    atDistanceM: samplesM[c.i],
                    decisivenessM: c.decisivenessM,
                    excludesRouteIds: c.excludes.jsSorted { JS.compare($0, $1) }
                )
            }
    }

    /// "lat,lng" with a fixed number of decimals (Google and Waze both take latitude first).
    static func latLng(_ p: LngLat, _ decimals: Int) -> String {
        "\(JS.toFixed(p.lat, decimals)),\(JS.toFixed(p.lng, decimals))"
    }

    /// A Google Maps URLs API directions link (driving) from origin to
    /// destination through the waypoints, in their order, percent-encoded.
    /// Waypoints past nine, then any that would take the URL past
    /// `maxUrlLength`, are dropped least decisive first (ties: the later
    /// one). A nil origin is left out: Google then starts from the device.
    public static func googleMapsUrl(_ origin: LngLat?, _ destination: LngLat, _ waypoints: [HandoffWaypoint], options: HandoffOptions = .default) -> String {
        let decimals = options.coordinateDecimals
        func build(_ kept: [HandoffWaypoint]) -> String {
            var params = ["api=1"]
            if let origin { params.append("origin=\(JS.encodeURIComponent(latLng(origin, decimals)))") }
            params.append("destination=\(JS.encodeURIComponent(latLng(destination, decimals)))")
            params.append("travelmode=driving")
            if !kept.isEmpty {
                params.append("waypoints=\(JS.encodeURIComponent(kept.map { latLng($0.position, decimals) }.joined(separator: "|")))")
            }
            return "https://www.google.com/maps/dir/?\(params.joined(separator: "&"))"
        }
        // Drop order: least decisive first, the later one first on a tie.
        let dropOrder = waypoints.enumerated()
            .map { (w: $0.element, i: $0.offset) }
            .jsSorted { a, b in
                let byDecisive = JS.sign(a.w.decisivenessM - b.w.decisivenessM)
                return byDecisive != 0 ? byDecisive : JS.compare(b.i, a.i)
            }
            .map(\.i)
        var dropped = Set<Int>()
        func kept() -> [HandoffWaypoint] { waypoints.enumerated().filter { !dropped.contains($0.offset) }.map(\.element) }
        var next = 0
        while kept().count > googleMapsMaxWaypoints {
            dropped.insert(dropOrder[next])
            next += 1
        }
        var url = build(kept())
        while Double(url.utf16.count) > options.maxUrlLength && next < dropOrder.count {
            dropped.insert(dropOrder[next])
            next += 1
            url = build(kept())
        }
        return url
    }

    /// A Waze deep link that starts navigation to the destination. Waze takes no waypoints.
    public static func wazeUrl(_ destination: LngLat, options: HandoffOptions = .default) -> String {
        "https://waze.com/ul?ll=\(JS.encodeURIComponent(latLng(destination, options.coordinateDecimals)))&navigate=yes"
    }
}
