import Foundation

/// Signal-data tile arithmetic, ported from src/core/tiles.ts.
///
/// Signal data is loaded in square tiles of a tenth of a degree, and only for
/// the tiles a route touches. A tile id is "<x>_<y>": the tile's west edge in
/// whole tenths of a degree of longitude and its south edge in whole tenths of
/// a degree of latitude, so "-809_352" covers longitude -80.9 to -80.8 and
/// latitude 35.2 to 35.3. A point on an edge belongs to the tile to its east
/// or north. These ids name the bundled tile files, so they must match the
/// TypeScript core exactly.
public enum Tiles {
    public static let tileSizeDeg = 0.1

    static let tilesPerDegree = 10
    static let xMin = -180 * tilesPerDegree
    static let xCount = 360 * tilesPerDegree
    static let yMin = -90 * tilesPerDegree
    static let yMax = 90 * tilesPerDegree - 1

    /// Whole tenths of a degree at or below `degrees`, always rounding down,
    /// after snapping to a whole number of 1e-7 degrees so a coordinate on a
    /// tile edge, such as -80.8, cannot land on the wrong side.
    /// Kept as a Double, as in JavaScript, so a huge or infinite coordinate
    /// cannot overflow an Int before it is wrapped or clamped.
    static func tenthsBelow(_ degrees: Double) -> Double {
        (JS.round(degrees * 1e7) / 1e6).rounded(.down)
    }

    /// Longitude wraps around the antimeridian: 180 is the same line as -180.
    /// JavaScript `%` on doubles (the sign of the dividend), done with fmod.
    static func wrapX(_ x: Double) -> Double {
        let span = Double(xCount)
        let low = Double(xMin)
        return fmod(fmod(x - low, span) + span, span) + low
    }

    static func clampY(_ y: Double) -> Double {
        JS.min(Double(yMax), JS.max(Double(yMin), y))
    }

    /// One part of a tile id: a whole number, or "NaN" where JavaScript would print it.
    static func part(_ v: Double) -> String {
        v.isNaN ? "NaN" : String(Int(v))
    }

    static func tileIdOf(_ x: Double, _ y: Double) -> String {
        "\(part(wrapX(x)))_\(part(clampY(y)))"
    }

    /// The id of the tile that holds a point. Like the TypeScript, each axis
    /// is handled on its own: an infinite latitude clamps to the pole row, and
    /// a longitude or latitude that is not a number gives "NaN" for its part.
    public static func tileIdAt(_ p: LngLat) -> String {
        tileIdOf(tenthsBelow(p.lng), tenthsBelow(p.lat))
    }

    /// The box a tile covers. Nil for anything that is not a tile id.
    public static func tileBounds(_ tileId: String) -> BBox? {
        let parts = tileId.split(separator: "_", omittingEmptySubsequences: false)
        guard parts.count == 2, let x = parseWhole(parts[0]), let y = parseWhole(parts[1]) else { return nil }
        if x < xMin || x >= xMin + xCount || y < yMin || y > yMax { return nil }
        let d = Double(tilesPerDegree)
        // Dividing a whole number by ten gives the closest value there is to the edge: -809 -> -80.9.
        return BBox(Double(x) / d, Double(y) / d, Double(x + 1) / d, Double(y + 1) / d)
    }

    /// `-?\d+`, ASCII digits only.
    static func parseWhole(_ s: Substring) -> Int? {
        var digits = s
        if digits.first == "-" { digits = digits.dropFirst() }
        let negative = digits.count < s.count
        guard !digits.isEmpty, digits.unicodeScalars.allSatisfy({ $0.value >= 48 && $0.value <= 57 }) else { return nil }
        // Number() ignores leading zeros; whatever is left that long is out of range anyway.
        let significant = digits.drop(while: { $0 == "0" })
        if significant.isEmpty { return 0 }
        guard significant.count <= 12, let value = Int(significant) else { return nil }
        return negative ? -value : value
    }

    /// A route segment is walked in pieces no longer than this, so a long one cannot step over a tile.
    static let pieceDeg = tileSizeDeg / 2

    /// Every tile a route needs signal data for: the tiles the line passes
    /// through plus any tile within `marginM` of the line. Can hold a tile
    /// the line only comes near, never fewer than needed. A segment whose ends
    /// are more than 180 degrees of longitude apart is taken the short way,
    /// across the antimeridian. Invalid points are ignored. Sorted, no repeats.
    public static func tilesForRoute(_ geometry: [LngLat], marginM: Double = 0) -> [String] {
        let line = geometry.filter(Geo.isValidLngLat)
        var ids = Set<String>()
        let margin = marginM.isFinite && marginM > 0 ? marginM : 0
        let padLat = margin / Geo.mPerDegree

        func addBox(_ lngA: Double, _ latA: Double, _ lngB: Double, _ latB: Double) {
            let south = min(latA, latB) - padLat
            let north = max(latA, latB) + padLat
            let padLng = Geo.lngDegreesFor(padLat, max(abs(south), abs(north)))
            var x0 = tenthsBelow(min(lngA, lngB) - padLng)
            var x1 = tenthsBelow(max(lngA, lngB) + padLng)
            // The TypeScript loops over the raw ranges and wraps or clamps each
            // id. The same set, without looping past what can change: a range
            // as wide as the world holds every column, and clamping is
            // monotonic, so the clamped ends bound the rows.
            if !x0.isFinite || !x1.isFinite || x1 - x0 >= Double(xCount) {
                x0 = Double(xMin)
                x1 = Double(xMin + xCount - 1)
            }
            let y0 = clampY(tenthsBelow(south))
            let y1 = clampY(tenthsBelow(north))
            guard x0 <= x1, y0 <= y1 else { return }
            for x in stride(from: x0, through: x1, by: 1) {
                for y in stride(from: y0, through: y1, by: 1) { ids.insert(tileIdOf(x, y)) }
            }
        }

        if line.count == 1 { addBox(line[0].lng, line[0].lat, line[0].lng, line[0].lat) }
        if line.count > 1 {
            for i in 1..<line.count {
                let aLng = line[i - 1].lng
                let aLat = line[i - 1].lat
                let rawLng = line[i].lng
                let bLat = line[i].lat
                // Past 180 the longitude is left unwrapped here; tileIdOf wraps it.
                let bLng = rawLng - aLng > 180 ? rawLng - 360 : (rawLng - aLng < -180 ? rawLng + 360 : rawLng)
                let pieces = max(1, Int((max(abs(bLng - aLng), abs(bLat - aLat)) / pieceDeg).rounded(.up)))
                for k in 0..<pieces {
                    let t0 = Double(k) / Double(pieces)
                    let t1 = Double(k + 1) / Double(pieces)
                    addBox(
                        aLng + (bLng - aLng) * t0,
                        aLat + (bLat - aLat) * t0,
                        aLng + (bLng - aLng) * t1,
                        aLat + (bLat - aLat) * t1
                    )
                }
            }
        }
        return ids.sorted(by: JS.less)
    }
}
