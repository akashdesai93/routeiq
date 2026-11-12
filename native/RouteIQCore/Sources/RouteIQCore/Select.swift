import Foundation

/// Route identity by path and the selected route, ported from src/core/select.ts.
public enum Select {
    /// How far apart two polylines may run and still be the same route. A
    /// refetch can return the same roads with points moved by under a meter;
    /// the next street over is tens of meters away.
    public static let sameRouteToleranceM = 10.0

    /// The grid reaches a meter past the tolerance, so that a segment exactly at the tolerance
    /// is never missed by rounding at a cell edge. It only decides which segments are measured.
    static let gridMarginM = 1.0
    /// Segments looked at ahead of the last hit (and one behind) before looking further.
    static let walkAhead = 4
    /// Misses of the walk answered by measuring the whole line, before a segment grid is built.
    static let scansBeforeGrid = 8

    /// True when every point lies within `toleranceM` of `line` (also Probe.coversRoute). Each
    /// point first tries the few segments after the one the previous point was near; a miss
    /// measures the whole line, for the first few misses, and then asks a segment grid of the
    /// line. The answer is the same as measuring every segment; the work is linear (#93).
    public static func everyPointNear(_ points: [XY], _ line: [XY], _ toleranceM: Double, _ meter: MatchMeter? = nil) -> Bool {
        let segments = line.count - 1
        if segments < 1 { return points.isEmpty }
        var grid: SegmentGrid?
        var last = 1
        var scans = 0
        for p in points {
            let to = min(segments, last + walkAhead)
            var near = false
            var i = max(1, last - 1)
            while i <= to {
                meter?.segmentChecks += 1
                if Geo.pointToSegment(p, line[i - 1], line[i]).distanceM <= toleranceM {
                    last = i
                    near = true
                    break
                }
                i += 1
            }
            if near { continue }
            var hit = 0
            if scans < scansBeforeGrid {
                scans += 1
                var j = 1
                while j <= segments && hit == 0 {
                    meter?.segmentChecks += 1
                    if Geo.pointToSegment(p, line[j - 1], line[j]).distanceM <= toleranceM { hit = j }
                    j += 1
                }
            } else {
                if grid == nil { grid = SegmentGrid(line, reachM: toleranceM + gridMarginM, meter: meter) }
                hit = grid!.segmentWithin(p, toleranceM)
            }
            if hit == 0 { return false }
            last = hit
        }
        return true
    }

    /// True when two polylines follow the same path the same way: they start
    /// and end within `toleranceM` of each other, and every vertex of each lies
    /// within `toleranceM` of the other line. Works on a flat local plane.
    public static func sameRouteGeometry(_ a: [LngLat], _ b: [LngLat], toleranceM: Double = sameRouteToleranceM, meter: MatchMeter? = nil) -> Bool {
        let lineA = a.filter(Geo.isValidLngLat)
        let lineB = b.filter(Geo.isValidLngLat)
        if lineA.count < 2 || lineB.count < 2 { return false }
        let box = Geo.boundsOfValid(lineA)
        let project = Geo.localProjector(LngLat((box.west + box.east) / 2, (box.south + box.north) / 2))
        let xyA = lineA.map(project)
        let xyB = lineB.map(project)
        func apart(_ p: XY, _ q: XY) -> Double { hypot(p.x - q.x, p.y - q.y) }
        if apart(xyA[0], xyB[0]) > toleranceM || apart(xyA[xyA.count - 1], xyB[xyB.count - 1]) > toleranceM { return false }
        return everyPointNear(xyA, xyB, toleranceM, meter) && everyPointNear(xyB, xyA, toleranceM, meter)
    }

    /// Which route is selected. A route the user picked stays selected while
    /// it keeps coming back: matched by id first, then by path. Otherwise the
    /// top-ranked route. Nil when there are no routes.
    public static func resolveSelectedId(
        _ routes: [RouteCandidate],
        pickedPath picked: (id: String, geometry: [LngLat])?,
        etaTieWindowSec: Double = Rank.defaultEtaTieWindowSec
    ) -> String? {
        if let picked {
            if routes.contains(where: { $0.id == picked.id }) { return picked.id }
            if let same = routes.first(where: { sameRouteGeometry($0.geometry, picked.geometry) }) { return same.id }
        }
        return Rank.recommendedRouteId(routes, etaTieWindowSec: etaTieWindowSec)
    }

    public static func resolveSelectedId(
        _ routes: [RouteCandidate],
        picked: RouteCandidate?,
        etaTieWindowSec: Double = Rank.defaultEtaTieWindowSec
    ) -> String? {
        resolveSelectedId(routes, pickedPath: picked.map { (id: $0.id, geometry: $0.geometry) }, etaTieWindowSec: etaTieWindowSec)
    }
}
