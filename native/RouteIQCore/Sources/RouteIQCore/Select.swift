import Foundation

/// Route identity by path and the selected route, ported from src/core/select.ts.
public enum Select {
    /// How far apart two polylines may run and still be the same route. A
    /// refetch can return the same roads with points moved by under a meter;
    /// the next street over is tens of meters away.
    public static let sameRouteToleranceM = 10.0

    static func everyPointNear(_ points: [XY], _ line: [XY], _ toleranceM: Double) -> Bool {
        points.allSatisfy { p in
            for i in stride(from: 1, to: line.count, by: 1) where Geo.pointToSegment(p, line[i - 1], line[i]).distanceM <= toleranceM {
                return true
            }
            return false
        }
    }

    /// True when two polylines follow the same path the same way: they start
    /// and end within `toleranceM` of each other, and every vertex of each lies
    /// within `toleranceM` of the other line. Works on a flat local plane.
    public static func sameRouteGeometry(_ a: [LngLat], _ b: [LngLat], toleranceM: Double = sameRouteToleranceM) -> Bool {
        let lineA = a.filter(Geo.isValidLngLat)
        let lineB = b.filter(Geo.isValidLngLat)
        if lineA.count < 2 || lineB.count < 2 { return false }
        let box = Geo.boundsOfValid(lineA)
        let project = Geo.localProjector(LngLat((box.west + box.east) / 2, (box.south + box.north) / 2))
        let xyA = lineA.map(project)
        let xyB = lineB.map(project)
        func apart(_ p: XY, _ q: XY) -> Double { hypot(p.x - q.x, p.y - q.y) }
        if apart(xyA[0], xyB[0]) > toleranceM || apart(xyA[xyA.count - 1], xyB[xyB.count - 1]) > toleranceM { return false }
        return everyPointNear(xyA, xyB, toleranceM) && everyPointNear(xyB, xyA, toleranceM)
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
