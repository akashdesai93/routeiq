import Foundation

/// A point on a flat local plane, in meters east (x) and north (y) of the plane's origin.
public struct XY: Hashable, Sendable {
    public var x: Double
    public var y: Double

    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }
}

/// The closest approach of a point to a segment (see Geo.pointToSegment).
public struct SegmentHit: Hashable, Sendable {
    public var distanceM: Double
    /// Where along the segment the closest point lies, from 0 (at A) to 1 (at B).
    public var t: Double

    public init(distanceM: Double, t: Double) {
        self.distanceM = distanceM
        self.t = t
    }
}

/// A place on a polyline: the point itself, which segment it is on, and the heading of that segment.
public struct PointOnLine: Hashable, Sendable {
    public var point: LngLat
    /// Index of the vertex at or before the point.
    public var index: Int
    /// Heading of travel there, degrees clockwise from true north (0 when the line has no length).
    public var bearingDeg: Double

    public init(point: LngLat, index: Int, bearingDeg: Double) {
        self.point = point
        self.index = index
        self.bearingDeg = bearingDeg
    }
}

public enum GeoError: Error, Equatable {
    case emptyPointList
    case invalidCoordinate(LngLat)
}

/// Geometry helpers, ported from src/core/geo.ts.
public enum Geo {
    static let earthRadiusM = 6_371_008.8
    /// Meters in one degree of latitude (and of longitude at the equator).
    public static let mPerDegree = earthRadiusM * Double.pi / 180

    /// Degrees of longitude that span as much ground as `latDegrees` of
    /// latitude, at latitude `lat`. A degree of longitude shrinks toward the
    /// poles; the floor near them keeps the answer finite.
    public static func lngDegreesFor(_ latDegrees: Double, _ lat: Double) -> Double {
        latDegrees / JS.max(0.01, cos(JS.min(89.9, abs(lat)) * Double.pi / 180))
    }

    public static func isValidLngLat(_ p: LngLat) -> Bool {
        p.lng.isFinite && p.lat.isFinite && p.lng >= -180 && p.lng <= 180 && p.lat >= -90 && p.lat <= 90
    }

    /// Smallest box that holds every point. Throws on an empty or invalid list.
    public static func boundsOf(_ points: [LngLat]) throws -> BBox {
        if points.isEmpty { throw GeoError.emptyPointList }
        var west = Double.infinity
        var south = Double.infinity
        var east = -Double.infinity
        var north = -Double.infinity
        for p in points {
            if !isValidLngLat(p) { throw GeoError.invalidCoordinate(p) }
            west = Swift.min(west, p.lng)
            east = Swift.max(east, p.lng)
            south = Swift.min(south, p.lat)
            north = Swift.max(north, p.lat)
        }
        return BBox(west, south, east, north)
    }

    /// boundsOf for a list already known to be non-empty and valid.
    static func boundsOfValid(_ points: [LngLat]) -> BBox {
        // swiftlint:disable:next force_try
        try! boundsOf(points)
    }

    /// Great-circle distance in meters (haversine).
    public static func distanceM(_ a: LngLat, _ b: LngLat) -> Double {
        let toRad = { (d: Double) in d * Double.pi / 180 }
        let dLat = toRad(b.lat - a.lat)
        let dLng = toRad(b.lng - a.lng)
        let h = pow(sin(dLat / 2), 2) + cos(toRad(a.lat)) * cos(toRad(b.lat)) * pow(sin(dLng / 2), 2)
        return 2 * earthRadiusM * asin(JS.min(1, h.squareRoot()))
    }

    /// Distance from the start of a polyline to each of its points, in meters
    /// (great-circle, summed segment by segment). One entry per point, starting at 0.
    public static func alongRouteM(_ line: [LngLat]) -> [Double] {
        var along: [Double] = []
        along.reserveCapacity(line.count)
        var total = 0.0
        for (i, p) in line.enumerated() {
            if i > 0 { total += distanceM(line[i - 1], p) }
            along.append(total)
        }
        return along
    }

    /// Equirectangular projection around `origin`: fast, and accurate to well
    /// under a meter per kilometer at city scale. Not for the antimeridian or poles.
    public static func localProjector(_ origin: LngLat) -> (LngLat) -> XY {
        let lng0 = origin.lng
        let lat0 = origin.lat
        let mPerDegreeLng = mPerDegree * cos(lat0 * Double.pi / 180)
        let mPerDegreeLat = mPerDegree
        return { p in XY((p.lng - lng0) * mPerDegreeLng, (p.lat - lat0) * mPerDegreeLat) }
    }

    /// Closest approach of point P to the segment A-B on a flat plane.
    /// A zero-length segment is treated as the point A.
    public static func pointToSegment(_ p: XY, _ a: XY, _ b: XY) -> SegmentHit {
        let dx = b.x - a.x
        let dy = b.y - a.y
        let lengthSq = dx * dx + dy * dy
        let t = lengthSq == 0 ? 0 : JS.min(1, JS.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
        return SegmentHit(distanceM: hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)), t: t)
    }

    /// True when P lies within `toleranceM` of some segment of the line (flat
    /// plane). A line of fewer than two points is near nothing.
    public static func nearLine(_ p: XY, _ line: [XY], _ toleranceM: Double) -> Bool {
        guard line.count >= 2 else { return false }
        for i in 1..<line.count where pointToSegment(p, line[i - 1], line[i]).distanceM <= toleranceM {
            return true
        }
        return false
    }

    /// Meters along `line` (as alongRouteM counts them) of the line's point
    /// closest to `p`. The first of equally close points wins. 0 for a line of
    /// fewer than two points.
    public static func nearestAlongM(_ line: [LngLat], _ p: LngLat) -> Double {
        let project = localProjector(p)
        let along = alongRouteM(line)
        var bestDistanceM = Double.infinity
        var bestAtM = 0.0
        if line.count >= 2 {
            for i in 1..<line.count {
                let hit = pointToSegment(XY(0, 0), project(line[i - 1]), project(line[i]))
                if hit.distanceM < bestDistanceM {
                    bestDistanceM = hit.distanceM
                    bestAtM = along[i - 1] + hit.t * (along[i] - along[i - 1])
                }
            }
        }
        return bestAtM
    }

    /// True when every point lies inside the box (edges included).
    public static func allWithin(_ points: [LngLat], _ box: BBox) -> Bool {
        points.allSatisfy { $0.lng >= box.west && $0.lng <= box.east && $0.lat >= box.south && $0.lat <= box.north }
    }

    /// Compass heading of the straight line from A to B: degrees clockwise from true north, 0 to 360.
    public static func bearingDeg(_ a: LngLat, _ b: LngLat) -> Double {
        let toRad = { (d: Double) in d * Double.pi / 180 }
        let dLng = toRad(b.lng - a.lng)
        let y = sin(dLng) * cos(toRad(b.lat))
        let x = cos(toRad(a.lat)) * sin(toRad(b.lat)) - sin(toRad(a.lat)) * cos(toRad(b.lat)) * cos(dLng)
        let deg = atan2(y, x) * 180 / Double.pi
        // JavaScript's % keeps the sign of the dividend, as truncatingRemainder does.
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    /// The point `alongM` meters from the start of a polyline (the same meters
    /// as alongRouteM), clamped to the line. Nil when the line has no point.
    public static func pointAtDistance(_ line: [LngLat], _ alongM: Double) -> PointOnLine? {
        guard !line.isEmpty else { return nil }
        let along = alongRouteM(line)
        let target = JS.min(JS.max(alongM.isFinite ? alongM : 0, 0), along[along.count - 1])
        // The first segment with a length that reaches the target.
        var index = 0
        if line.count > 1 {
            for i in 0..<(line.count - 1) where along[i + 1] >= target && along[i + 1] > along[i] {
                index = i
                break
            }
        }
        let a = line[index]
        guard index + 1 < line.count else { return PointOnLine(point: a, index: index, bearingDeg: 0) }
        let b = line[index + 1]
        let length = along[index + 1] - along[index]
        let t = length > 0 ? JS.min(1, JS.max(0, (target - along[index]) / length)) : 0
        return PointOnLine(
            point: LngLat(a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t),
            index: index,
            bearingDeg: length > 0 ? bearingDeg(a, b) : 0
        )
    }

    /// The rest of a polyline from `alongM` meters after its start: the point
    /// there, then every later vertex. An empty line gives an empty line.
    public static func lineFrom(_ line: [LngLat], _ alongM: Double) -> [LngLat] {
        guard let at = pointAtDistance(line, alongM) else { return [] }
        let rest = Array(line[(at.index + 1)...])
        // Standing exactly on a vertex: do not list it twice.
        if let next = rest.first, next.lng == at.point.lng, next.lat == at.point.lat { return rest }
        return [at.point] + rest
    }
}

/// Counts the work of matching (findCurrentRoute, sameRouteGeometry, coversRoute and mergeProbeRoutes), for tests and benchmarks:
/// point-to-segment distance checks, and entries put in a segment grid. A
/// count, not a time, so that it is the same on every machine.
public final class MatchMeter {
    public var segmentChecks: Int
    public var gridEntries: Int

    public init(segmentChecks: Int = 0, gridEntries: Int = 0) {
        self.segmentChecks = segmentChecks
        self.gridEntries = gridEntries
    }
}

/// A bounding-box index of a line's segments: square cells as wide as `reachM`,
/// each listing the segments that pass through it (a long segment is cut into
/// pieces no longer than a cell). A point then looks at the segments of the
/// 3 x 3 cells around it. Built once per line and comparison. (geo.ts segmentGrid)
final class SegmentGrid {
    struct Cell: Hashable {
        let x: Double
        let y: Double
    }

    let line: [XY]
    let cellM: Double
    var cells: [Cell: [Int]] = [:]
    let meter: MatchMeter?
    /// Which segments this query has measured already (a segment can be listed in several of its cells).
    var seen: [Int]
    var query = 0

    init(_ line: [XY], reachM: Double, meter: MatchMeter?) {
        self.line = line
        self.meter = meter
        let cellM = JS.max(1, reachM)
        self.cellM = cellM
        seen = Array(repeating: 0, count: line.count)
        func cellOf(_ v: Double) -> Double { (v / cellM).rounded(.down) }
        for i in stride(from: 1, to: line.count, by: 1) {
            let a = line[i - 1]
            let b = line[i]
            let pieces = JS.max(1, (hypot(a.x - b.x, a.y - b.y) / cellM).rounded(.up))
            var k = 0.0
            while k < pieces {
                let x0 = a.x + (b.x - a.x) * k / pieces
                let y0 = a.y + (b.y - a.y) * k / pieces
                let x1 = a.x + (b.x - a.x) * (k + 1) / pieces
                let y1 = a.y + (b.y - a.y) * (k + 1) / pieces
                var ix = cellOf(JS.min(x0, x1))
                let ixEnd = cellOf(JS.max(x0, x1))
                while ix <= ixEnd {
                    var iy = cellOf(JS.min(y0, y1))
                    let iyEnd = cellOf(JS.max(y0, y1))
                    while iy <= iyEnd {
                        let key = Cell(x: ix, y: iy)
                        // A segment's pieces come one after another, so it can only be listed twice at the end.
                        if cells[key] == nil {
                            cells[key] = [i]
                            meter?.gridEntries += 1
                        } else if cells[key]!.last != i {
                            cells[key]!.append(i)
                            meter?.gridEntries += 1
                        }
                        iy += 1
                    }
                    ix += 1
                }
                k += 1
            }
        }
    }

    /// Looks at the segments of the 3 x 3 cells around p; `visit` gets the segment index and
    /// its distance, and returns true to stop.
    func search(_ p: XY, _ visit: (Int, Double) -> Bool) {
        query += 1
        func cellOf(_ v: Double) -> Double { (v / cellM).rounded(.down) }
        var ix = cellOf(p.x - cellM)
        let ixEnd = cellOf(p.x + cellM)
        while ix <= ixEnd {
            var iy = cellOf(p.y - cellM)
            let iyEnd = cellOf(p.y + cellM)
            while iy <= iyEnd {
                for i in cells[Cell(x: ix, y: iy)] ?? [] {
                    if seen[i] == query { continue }
                    seen[i] = query
                    meter?.segmentChecks += 1
                    if visit(i, Geo.pointToSegment(p, line[i - 1], line[i]).distanceM) { return }
                }
                iy += 1
            }
            ix += 1
        }
    }

    /// The distance from `p` to the line when it is at most the grid's reach, infinity when
    /// it is farther. Stops looking at the first segment within `enoughM`.
    func distanceWithin(_ p: XY, _ enoughM: Double) -> Double {
        var best = Double.infinity
        search(p) { _, d in
            best = JS.min(best, d)
            return best <= enoughM
        }
        return best <= cellM ? best : .infinity
    }

    /// The index `i` of a segment (line[i - 1] to line[i]) within `withinM` of `p`, the first
    /// one found; 0 when there is none. `withinM` must not be more than the grid's reach.
    func segmentWithin(_ p: XY, _ withinM: Double) -> Int {
        var found = 0
        search(p) { i, d in
            if d <= withinM { found = i }
            return found != 0
        }
        return found
    }
}
