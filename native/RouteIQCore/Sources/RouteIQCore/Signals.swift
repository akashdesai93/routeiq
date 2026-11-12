import Foundation

/// The distances the signal count is built on, ported from src/core/signals.ts.
/// The first three are the rules, applied in this order:
///   (a) signal points within clusterRadiusM of each other are one intersection;
///   (b) an intersection counts when it lies within toleranceM of the route line;
///   (c) and only when the route itself has an intersection within
///       intersectionRadiusM of it.
public struct SignalMatchOptions: Hashable, Sendable {
    /// (a) Points this close, directly or through a chain, are one intersection.
    public var clusterRadiusM: Double
    /// (b) An intersection is on the route when one of its points, or their middle, is this close to the line.
    public var toleranceM: Double
    /// (c) ...and the route has an intersection of its own this close to one of them. Skipped without a list.
    public var intersectionRadiusM: Double
    /// Counted intersections this close along the route are one stop.
    public var mergeRadiusM: Double
    /// How far inside a limited-access span a signal must be before it is ignored.
    public var limitedAccessMarginM: Double

    public init(
        clusterRadiusM: Double = 60,
        toleranceM: Double = 30,
        intersectionRadiusM: Double = 40,
        mergeRadiusM: Double = 40,
        limitedAccessMarginM: Double = 30
    ) {
        self.clusterRadiusM = clusterRadiusM
        self.toleranceM = toleranceM
        self.intersectionRadiusM = intersectionRadiusM
        self.mergeRadiusM = mergeRadiusM
        self.limitedAccessMarginM = limitedAccessMarginM
    }

    /// The one place the matching distances are set.
    public static let `default` = SignalMatchOptions()

    /// A distance that is negative or not a number is treated as 0, as in the
    /// TypeScript core. (Leaving a field out there means its default; here the
    /// initializer's defaults do that.)
    func resolved() -> SignalMatchOptions {
        func nonNegative(_ v: Double) -> Double { v.isFinite && v > 0 ? v : 0 }
        return SignalMatchOptions(
            clusterRadiusM: nonNegative(clusterRadiusM),
            toleranceM: nonNegative(toleranceM),
            intersectionRadiusM: nonNegative(intersectionRadiusM),
            mergeRadiusM: nonNegative(mergeRadiusM),
            limitedAccessMarginM: nonNegative(limitedAccessMarginM)
        )
    }
}

/// What the directions provider says about the road the route is on. All optional.
public struct RouteContext: Hashable, Sendable {
    /// Where the route's own intersections are, for rule (c). Nil or empty skips the rule.
    public var intersections: [LngLat]?
    /// Stretches on controlled-access road, [startM, endM] along the route. Nil or empty changes nothing.
    public var limitedAccessSpansM: [DistanceSpanM]?

    public init(intersections: [LngLat]? = nil, limitedAccessSpansM: [DistanceSpanM]? = nil) {
        self.intersections = intersections
        self.limitedAccessSpansM = limitedAccessSpansM
    }
}

/// Several signal points that are one intersection (rule a).
public struct SignalCluster: Hashable, Sendable {
    /// The smallest id among its points, so it does not depend on input order.
    public var id: String
    /// The middle of its points.
    public var position: LngLat
    /// The first name found among its points, in id order.
    public var name: String?
    /// The most trusted source among its points.
    public var source: SignalSource
    /// Sorted.
    public var memberIds: [String]
    public var members: [LngLat]
}

public struct RouteSignals: Hashable, Sendable {
    /// Distinct signalized intersections in driving order, one entry per pass.
    public var signals: [RouteSignal]
    public var count: Int

    public static let none = RouteSignals(signals: [], count: 0)
}

/// Everything known about signals when routes are counted. The route's own
/// signal flags (the fallback) are added in memory, inside withSignalCounts.
public struct SignalData: Hashable, Sendable {
    /// Points of the primary source, from every tile that was loaded. A point may appear more than once.
    public var primary: [SignalPoint]
    /// The tiles `primary` is complete for. A needed tile not listed here is missing data.
    public var primaryTileIds: Set<String>

    public init(primary: [SignalPoint], primaryTileIds: Set<String>) {
        self.primary = primary
        self.primaryTileIds = primaryTileIds
    }
}

public struct CountedRoutes: Hashable, Sendable {
    /// The same routes, in the same order, with signalCount and signalCoverage filled.
    public var routes: [RouteCandidate]
    /// On-route signals by route id, for drawing.
    public var signalsByRouteId: [String: [RouteSignal]]
}

/// Finds the points within `radiusM` of a point without comparing every pair:
/// points go into a grid of cells at least `radiusM` wide, so only the nine
/// cells around a point need looking at. Distances are great-circle.
struct PointGrid<T> {
    struct Cell: Hashable {
        let x: Int
        let y: Int
    }

    let radiusM: Double
    let cellLat: Double
    let cellLng: Double
    var cells: [Cell: [(at: LngLat, value: T)]] = [:]

    init(radiusM: Double, points: [LngLat]) {
        self.radiusM = radiusM
        var widestLat = 0.0
        for p in points { widestLat = max(widestLat, abs(p.lat)) }
        // A little over the radius, so rounding at a cell edge cannot hide a neighbor.
        cellLat = max(radiusM * 1.01 / Geo.mPerDegree, 1e-9)
        cellLng = Geo.lngDegreesFor(cellLat, widestLat)
    }

    func cellOf(_ p: LngLat) -> Cell {
        Cell(x: Int((p.lng / cellLng).rounded(.down)), y: Int((p.lat / cellLat).rounded(.down)))
    }

    mutating func add(_ at: LngLat, _ value: T) {
        cells[cellOf(at), default: []].append((at: at, value: value))
    }

    /// Every stored value within radiusM of `at` (the edge included).
    func within(_ at: LngLat) -> [T] {
        let c = cellOf(at)
        var found: [T] = []
        for x in (c.x - 1)...(c.x + 1) {
            for y in (c.y - 1)...(c.y + 1) {
                for entry in cells[Cell(x: x, y: y)] ?? [] where Geo.distanceM(at, entry.at) <= radiusM {
                    found.append(entry.value)
                }
            }
        }
        return found
    }
}

/// Signal counting, ported from src/core/signals.ts.
public enum Signals {
    /// Side of a lookup grid cell for the route matching, in meters. Only affects speed.
    static let cellM = 250.0

    struct Sourced {
        let point: SignalPoint
        let source: SignalSource
    }

    static func clusterSourced(_ sourced: [Sourced], radiusM: Double) -> [SignalCluster] {
        // One entry per id (a point on a tile edge arrives once per tile), in id order.
        var seenIds = Set<JS.Key>()
        var unique: [Sourced] = []
        for s in sourced where Geo.isValidLngLat(s.point.position) && !seenIds.contains(JS.Key(s.point.id)) {
            seenIds.insert(JS.Key(s.point.id))
            unique.append(s)
        }
        let points = unique.jsSorted { JS.less($0.point.id, $1.point.id) ? -1 : 1 }

        var parent = Array(points.indices)
        func find(_ start: Int) -> Int {
            var i = start
            while parent[i] != i {
                parent[i] = parent[parent[i]]
                i = parent[i]
            }
            return i
        }
        if radiusM > 0 {
            var grid = PointGrid<Int>(radiusM: radiusM, points: points.map(\.point.position))
            for (i, s) in points.enumerated() {
                for j in grid.within(s.point.position) {
                    let a = find(i)
                    let b = find(j)
                    // The smaller index (the smaller id) stays the root.
                    if a != b { parent[max(a, b)] = min(a, b) }
                }
                grid.add(s.point.position, i)
            }
        }

        var groupOrder: [Int] = []
        var groups: [Int: [Sourced]] = [:]
        for (i, s) in points.enumerated() {
            let root = find(i)
            if groups[root] == nil { groupOrder.append(root) }
            groups[root, default: []].append(s)
        }
        return groupOrder.map { root in
            let group = groups[root]!
            let members = group.map(\.point.position)
            let n = Double(members.count)
            return SignalCluster(
                id: group[0].point.id,
                position: LngLat(
                    members.reduce(0) { $0 + $1.lng } / n,
                    members.reduce(0) { $0 + $1.lat } / n
                ),
                name: group.first(where: { $0.point.name != nil })?.point.name,
                source: SignalSource.allCases.first { source in group.contains { $0.source == source } }!,
                memberIds: group.map(\.point.id),
                members: members
            )
        }
    }

    /// Rule (a): groups signal points into intersections. Two points are in
    /// the same group when they are within `radiusM` of each other, or joined
    /// by a chain of such points. A point given twice (same id) is used once.
    /// Order-independent; groups come back in id order. A radius of 0 (or
    /// negative, or NaN) groups nothing.
    public static func clusterSignals(_ points: [SignalPoint], radiusM: Double = SignalMatchOptions.default.clusterRadiusM) -> [SignalCluster] {
        clusterSourced(points.map { Sourced(point: $0, source: .primary) }, radiusM: radiusM.isFinite && radiusM > 0 ? radiusM : 0)
    }

    struct Hit {
        let atDistanceM: Double
        let offsetM: Double
    }

    struct Pass {
        let cluster: SignalCluster
        let atDistanceM: Double
        let offsetM: Double
    }

    /// Rules (b) and (c), the freeway spans, then the along-route merge, for intersections already grouped.
    static func clustersOnRoute(
        _ geometry: [LngLat],
        _ clusters: [SignalCluster],
        _ options: SignalMatchOptions,
        _ context: RouteContext
    ) -> RouteSignals {
        let toleranceM = options.toleranceM
        let mergeRadiusM = options.mergeRadiusM
        let intersectionRadiusM = options.intersectionRadiusM
        let marginM = options.limitedAccessMarginM
        let spans = context.limitedAccessSpansM ?? []
        func onLimitedAccess(_ atDistanceM: Double) -> Bool {
            spans.contains { atDistanceM >= $0.startM + marginM && atDistanceM <= $0.endM - marginM }
        }
        let line = geometry.filter(Geo.isValidLngLat)
        if line.count < 2 || clusters.isEmpty { return .none }

        let box = Geo.boundsOfValid(line)
        let project = Geo.localProjector(LngLat((box.west + box.east) / 2, (box.south + box.north) / 2))
        let minXY = project(LngLat(box.west, box.south))
        let maxXY = project(LngLat(box.east, box.north))

        // Each intersection is tested at every one of its signal points and at their middle.
        // Only those inside the route's bounding box (plus the tolerance) can match.
        var probes: [(cluster: Int, xy: XY)] = []
        var probesOf: [Int: [XY]] = [:]
        for (n, cluster) in clusters.enumerated() {
            let all = ([cluster.position] + cluster.members).map(project)
            var any = false
            for xy in all {
                if xy.x < minXY.x - toleranceM || xy.x > maxXY.x + toleranceM { continue }
                if xy.y < minXY.y - toleranceM || xy.y > maxXY.y + toleranceM { continue }
                probes.append((cluster: n, xy: xy))
                any = true
            }
            if any { probesOf[n] = all }
        }
        if probes.isEmpty { return .none }

        // Bucket the probes into a grid so each segment only looks at the ones around it.
        var gridMinX = Double.infinity
        var gridMinY = Double.infinity
        var gridMaxX = -Double.infinity
        var gridMaxY = -Double.infinity
        for probe in probes {
            gridMinX = min(gridMinX, probe.xy.x)
            gridMaxX = max(gridMaxX, probe.xy.x)
            gridMinY = min(gridMinY, probe.xy.y)
            gridMaxY = max(gridMaxY, probe.xy.y)
        }
        // Cell numbers stay Doubles until clamped to the grid, as in the
        // TypeScript, so a huge tolerance cannot overflow an Int.
        func colD(_ x: Double) -> Double { ((x - gridMinX) / cellM).rounded(.down) }
        func rowD(_ y: Double) -> Double { ((y - gridMinY) / cellM).rounded(.down) }
        func col(_ x: Double) -> Int { Int(colD(x)) }
        func row(_ y: Double) -> Int { Int(rowD(y)) }
        let lastCol = col(gridMaxX)
        let lastRow = row(gridMaxY)
        /// max(low, min(high, v)) in Doubles, then an Int; an empty range stays empty.
        func clampedLow(_ v: Double, _ high: Int) -> Int { Int(Swift.max(0, Swift.min(Double(high) + 1, v))) }
        func clampedHigh(_ v: Double, _ high: Int) -> Int { Int(Swift.min(Double(high), Swift.max(-1, v))) }
        var cells: [Int: [Int]] = [:]
        for (n, probe) in probes.enumerated() {
            cells[row(probe.xy.y) * (lastCol + 1) + col(probe.xy.x), default: []].append(n)
        }

        // Rule (b): every place the line comes within tolerance of a probe, per intersection.
        var hitOrder: [Int] = []
        var hits: [Int: [Hit]] = [:]
        var a = project(line[0])
        var travelledM = 0.0
        for i in 1..<line.count {
            let b = project(line[i])
            let lengthM = hypot(b.x - a.x, b.y - a.y)
            let col0 = clampedLow(colD(min(a.x, b.x) - toleranceM), lastCol)
            let col1 = clampedHigh(colD(max(a.x, b.x) + toleranceM), lastCol)
            let row0 = clampedLow(rowD(min(a.y, b.y) - toleranceM), lastRow)
            let row1 = clampedHigh(rowD(max(a.y, b.y) + toleranceM), lastRow)
            for r in stride(from: row0, through: row1, by: 1) {
                for c in stride(from: col0, through: col1, by: 1) {
                    guard let cell = cells[r * (lastCol + 1) + c] else { continue }
                    for n in cell {
                        let probe = probes[n]
                        let hit = Geo.pointToSegment(probe.xy, a, b)
                        if hit.distanceM > toleranceM { continue }
                        if hits[probe.cluster] == nil { hitOrder.append(probe.cluster) }
                        hits[probe.cluster, default: []].append(Hit(atDistanceM: travelledM + hit.t * lengthM, offsetM: hit.distanceM))
                    }
                }
            }
            travelledM += lengthM
            a = b
        }

        // Rule (c): the route must have an intersection of its own at the signal.
        let crossings = (context.intersections ?? []).filter(Geo.isValidLngLat).map(project)
        func atRouteIntersection(_ n: Int) -> Bool {
            crossings.isEmpty
                || probesOf[n]!.contains { p in crossings.contains { x in hypot(p.x - x.x, p.y - x.y) <= intersectionRadiusM } }
        }

        // One pass per stretch of route that stays near the intersection, placed at its
        // closest approach. A route that comes back later (a loop) passes it again.
        var passes: [Pass] = []
        for n in hitOrder where atRouteIntersection(n) {
            let cluster = clusters[n]
            let all = probesOf[n]!
            let centre = all[0]
            let reachM = all.map { hypot($0.x - centre.x, $0.y - centre.y) }.max()!
            // Hits of one drive through cannot be further apart than the intersection is wide, plus the tolerance at both ends.
            let samePassM = 2 * (reachM + toleranceM) + mergeRadiusM
            let clusterHits = hits[n]!.jsSorted { JS.compare($0.atDistanceM, $1.atDistanceM) }
            var best: Hit?
            var previousM = 0.0
            func closePass() {
                if let found = best, !onLimitedAccess(found.atDistanceM) {
                    passes.append(Pass(cluster: cluster, atDistanceM: found.atDistanceM, offsetM: found.offsetM))
                }
                best = nil
            }
            for hit in clusterHits {
                if best != nil, hit.atDistanceM - previousM > samePassM { closePass() }
                if best == nil || hit.offsetM < best!.offsetM { best = hit }
                previousM = hit.atDistanceM
            }
            closePass()
        }
        passes = passes.jsSorted { p, q in
            let byDistance = JS.compare(p.atDistanceM, q.atDistanceM)
            if byDistance != 0 { return byDistance }
            let byOffset = JS.compare(p.offsetM, q.offsetM)
            if byOffset != 0 { return byOffset }
            return JS.less(p.cluster.id, q.cluster.id) ? -1 : 1
        }

        // Passes of different intersections close together along the route are one stop.
        var merged: [RouteSignal] = []
        var group: [Pass] = []
        func closeGroup() {
            guard !group.isEmpty else { return }
            let closest = group.dropFirst().reduce(group[0]) { p, q in q.offsetM < p.offsetM ? q : p }
            var ids: [String] = []
            var seen = Set<JS.Key>()
            for id in group.flatMap(\.cluster.memberIds) where !seen.contains(JS.Key(id)) {
                seen.insert(JS.Key(id))
                ids.append(id)
            }
            merged.append(RouteSignal(
                id: closest.cluster.id,
                position: closest.cluster.position,
                name: closest.cluster.name,
                source: closest.cluster.source,
                atDistanceM: closest.atDistanceM,
                offsetM: closest.offsetM,
                mergedIds: ids
            ))
            group = []
        }
        for pass in passes {
            if !group.isEmpty, pass.atDistanceM - group[0].atDistanceM > mergeRadiusM { closeGroup() }
            group.append(pass)
        }
        closeGroup()
        return RouteSignals(signals: merged, count: merged.count)
    }

    /// Which signalized intersections a route passes through, and how many.
    ///
    /// (a) The signal points are grouped into intersections (clusterSignals).
    /// (b) An intersection is on the route when one of its points, or their
    ///     middle, is within `toleranceM` of the route line.
    /// (c) With `context.intersections`, it must also have one of the route's
    ///     own intersections within `intersectionRadiusM`.
    ///
    /// Each stretch of route near an intersection is one pass, so a looping
    /// route counts it twice. A pass deep inside a limited-access span is
    /// dropped. Passes within `mergeRadiusM` along the route are merged.
    public static func signalsOnRoute(
        _ geometry: [LngLat],
        _ signals: [SignalPoint],
        options: SignalMatchOptions = .default,
        context: RouteContext = RouteContext()
    ) -> RouteSignals {
        let resolved = options.resolved()
        return clustersOnRoute(geometry, clusterSignals(signals, radiusM: resolved.clusterRadiusM), resolved, context)
    }

    /// The tiles whose signal data a route needs: those it passes through,
    /// plus any within reach of the three rule distances, so that an
    /// intersection lying across a tile edge is loaded whole.
    public static func signalTilesForRoute(_ geometry: [LngLat], options: SignalMatchOptions = .default) -> [String] {
        let r = options.resolved()
        return Tiles.tilesForRoute(geometry, marginM: r.clusterRadiusM + r.toleranceM + r.intersectionRadiusM)
    }

    /// Fills signalCount and signalCoverage on each route, from two sources,
    /// most trusted first: the primary data for loaded tiles; the route's own
    /// signal flags, only in tiles whose primary data is missing. Coverage is `full` when every needed tile was
    /// loaded, `partial` when one is missing, and `none` (nil count) when
    /// nothing at all is known. Nil `data` leaves the routes untouched.
    public static func withSignalCounts(
        _ routes: [RouteCandidate],
        _ data: SignalData?,
        options: SignalMatchOptions = .default
    ) -> CountedRoutes {
        var signalsByRouteId: [String: [RouteSignal]] = [:]
        guard let data else { return CountedRoutes(routes: routes, signalsByRouteId: signalsByRouteId) }
        let resolved = options.resolved()
        let primary = data.primary.map { Sourced(point: $0, source: .primary) }

        let counted = routes.map { route -> RouteCandidate in
            var out = route
            let needed = signalTilesForRoute(route.geometry, options: resolved)
            let missing = needed.filter { !data.primaryTileIds.contains($0) }
            if missing.count == needed.count && route.intersections == nil {
                out.signalCount = nil
                out.signalCoverage = .none
                return out
            }

            var fallback: [Sourced] = []
            if !missing.isEmpty, let intersections = route.intersections {
                for (i, intersection) in intersections.enumerated() {
                    guard intersection.signal, Geo.isValidLngLat(intersection.location) else { continue }
                    if data.primaryTileIds.contains(Tiles.tileIdAt(intersection.location)) { continue }
                    // String(i).padStart(5, '0'): pads, never truncates.
                    let digits = String(i)
                    let padded = String(repeating: "0", count: max(0, 5 - digits.count)) + digits
                    fallback.append(Sourced(
                        point: SignalPoint(id: "flag-\(padded)", position: intersection.location, name: nil),
                        source: .fallback
                    ))
                }
            }
            let clusters = clusterSourced(primary + fallback, radiusM: resolved.clusterRadiusM)

            let found = clustersOnRoute(route.geometry, clusters, resolved, RouteContext(
                intersections: route.intersections?.map(\.location),
                limitedAccessSpansM: route.limitedAccessSpansM
            ))
            signalsByRouteId[route.id] = found.signals
            out.signalCount = found.count
            out.signalCoverage = missing.isEmpty ? .full : .partial
            return out
        }
        return CountedRoutes(routes: counted, signalsByRouteId: signalsByRouteId)
    }
}
