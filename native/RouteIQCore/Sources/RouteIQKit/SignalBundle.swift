import Foundation
import RouteIQCore

/// A set of tiles written as runs along each row, as index.json stores it
/// (src/providers/osm/bundle.ts, TileRows): the key is the row (the y of the
/// tile id) and the value a flat list of inclusive runs of x,
/// [x0, x1, x0, x1, ...]. { "352": [-812, -805] } is -812_352 to -805_352.
public struct TileRows: Hashable, Sendable {
    let rows: [Int: [Int]]

    /// Nil unless every key is a whole number and every list is an even
    /// number of whole numbers in increasing, non-touching runs (isTileRows).
    public init?(_ raw: [String: [Double]]) {
        var rows: [Int: [Int]] = [:]
        for (key, runs) in raw {
            guard let y = Int(key), runs.count % 2 == 0 else { return nil }
            var xs: [Int] = []
            for (i, value) in runs.enumerated() {
                guard value.isFinite, value == value.rounded(), abs(value) < 1e9 else { return nil }
                let x = Int(value)
                if i > 0 {
                    // The end of a run is at or after its start; the next run starts past a gap.
                    let ok = i % 2 == 1 ? x >= xs[i - 1] : x > xs[i - 1] + 1
                    if !ok { return nil }
                }
                xs.append(x)
            }
            rows[y] = xs
        }
        self.rows = rows
    }

    /// True when the tile is in the set (tileRowsHas).
    public func has(_ tileId: String) -> Bool {
        guard Tiles.tileBounds(tileId) != nil else { return false }
        let parts = tileId.split(separator: "_")
        guard parts.count == 2, let x = Int(parts[0]), let y = Int(parts[1]), let runs = rows[y] else { return false }
        var i = 0
        while i + 1 < runs.count {
            if x >= runs[i] && x <= runs[i + 1] { return true }
            i += 2
        }
        return false
    }

    /// How many tiles the set holds.
    public var count: Int {
        rows.values.reduce(0) { total, runs in
            var n = 0
            var i = 0
            while i + 1 < runs.count {
                n += runs[i + 1] - runs[i] + 1
                i += 2
            }
            return total + n
        }
    }
}

/// The OpenStreetMap signal tiles shipped inside the app, ported from the
/// web app's bundle layer (src/providers/osm/bundleLayer.ts) and
/// loadSignalData (src/signalData.ts), with the bundle as the only source:
/// the app asks no signal server, so nothing about a trip leaves the phone.
///
/// - A tile inside the covered area is the whole answer: its file, or no
///   signals at all when it has none.
/// - A tile outside it is missing, so a route that needs it gets a partial
///   count. If the bundle has a clipped file for it (the tile reaches past the
///   extracts' edge), that file's signals still count, as a lower bound.
///
/// The data is © OpenStreetMap contributors under the ODbL 1.0; the license
/// file ships next to it and the credit is shown with every count.
public struct SignalBundle: Sendable {
    /// How the bundle stands on one tile (BundleCoverage).
    public enum Coverage: Hashable, Sendable {
        case covered
        case clipped
        case none
    }

    struct Node: Decodable, Hashable, Sendable {
        let id: Int64
        let lng: Double
        let lat: Double
    }

    struct Tile: Decodable, Sendable {
        let tileId: String
        let fetchedAt: Double
        let nodes: [Node]
    }

    struct Index: Decodable, Sendable {
        let version: Int
        let dataDate: Double
        let covered: [String: [Double]]
        let files: [String: [Double]]
        let attribution: String?
        let license: String?
    }

    struct Packed: Decodable {
        let version: Int
        let index: Index
        let tiles: [Tile]
    }

    /// When the data was current, in milliseconds since 1970.
    public let dataDate: Double
    public let covered: TileRows
    public let files: TileRows
    /// "© OpenStreetMap contributors"
    public let attribution: String
    let tiles: [String: Tile]

    public enum LoadError: Error, Equatable {
        case notABundle(String)
    }

    /// Reads the packed bundle (one JSON file: the index and every tile, as
    /// native/scripts/pack-signal-bundle.mjs writes it).
    public init(packed data: Data) throws {
        let packed: Packed
        do {
            packed = try JSONDecoder().decode(Packed.self, from: data)
        } catch {
            throw LoadError.notABundle("not a packed signal bundle")
        }
        guard packed.version == 1 else { throw LoadError.notABundle("unknown packed version \(packed.version)") }
        try self.init(index: packed.index, tiles: packed.tiles)
    }

    /// Reads the bundle as the web app serves it: index.json and the tile files.
    public init(indexJSON: Data, tileFiles: [Data]) throws {
        let decoder = JSONDecoder()
        guard let index = try? decoder.decode(Index.self, from: indexJSON) else {
            throw LoadError.notABundle("index.json is not a bundle index")
        }
        // A file that is not a well-formed tile reads as missing, as in the web app.
        let tiles = tileFiles.compactMap { try? decoder.decode(Tile.self, from: $0) }
        try self.init(index: index, tiles: tiles)
    }

    init(index: Index, tiles: [Tile]) throws {
        // isOsmBundleIndex: version 2, a finite date, well-formed tile rows.
        guard index.version == 2, index.dataDate.isFinite else { throw LoadError.notABundle("unsupported index") }
        guard let covered = TileRows(index.covered), let files = TileRows(index.files) else {
            throw LoadError.notABundle("malformed tile rows")
        }
        self.dataDate = index.dataDate
        self.covered = covered
        self.files = files
        self.attribution = index.attribution ?? "© OpenStreetMap contributors"
        var byId: [String: Tile] = [:]
        for tile in tiles where files.has(tile.tileId) { byId[tile.tileId] = tile }
        self.tiles = byId
    }

    /// How the bundle stands on one tile.
    public func coverage(_ tileId: String) -> Coverage {
        if covered.has(tileId) { return .covered }
        return files.has(tileId) && tiles[tileId] != nil ? .clipped : .none
    }

    /// What the signal counting needs for some routes, and what it could not have.
    public struct Loaded: Sendable {
        /// What Signals.withSignalCounts takes. No gap-fill source in the app.
        public let data: SignalData
        /// Tiles the routes need that the bundle does not cover. Empty when every count will be full.
        public let missingTileIds: [String]
        /// The data date of the tiles used (ms since 1970), or nil when none was.
        public let dataDate: Double?
    }

    /// The signal data for a set of routes: the tiles they touch and no others.
    public func signalData(for routes: [RouteCandidate]) -> Loaded {
        let needed = Array(Set(routes.flatMap { Signals.signalTilesForRoute($0.geometry) })).sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) })
        var loaded: [String] = []
        var missing: [String] = []
        // Tiles whose nodes become signal points: loaded ones, then the clipped part of missing ones.
        var withNodes: [Tile] = []
        var partial: [Tile] = []
        for id in needed {
            switch coverage(id) {
            case .covered:
                if !files.has(id) {
                    // Inside the covered area, no file means no signals: that is knowledge, not a gap.
                    loaded.append(id)
                } else if let tile = tiles[id] {
                    loaded.append(id)
                    withNodes.append(tile)
                } else {
                    // Listed in the index but its file could not be read: missing, as in the web app.
                    missing.append(id)
                }
            case .clipped:
                missing.append(id)
                if let tile = tiles[id] { partial.append(tile) }
            case .none:
                missing.append(id)
            }
        }
        return Loaded(
            data: SignalData(
                primary: Self.signalPoints(withNodes + partial),
                primaryTileIds: Set(loaded),
                gapFill: nil
            ),
            missingTileIds: missing,
            dataDate: loaded.isEmpty ? nil : dataDate
        )
    }

    /// The nodes of some tiles as SignalPoints (osmSignalPoints): each node
    /// once, as "osm-<node id>", with no name.
    static func signalPoints(_ tiles: [Tile]) -> [SignalPoint] {
        var seen = Set<Int64>()
        var points: [SignalPoint] = []
        for tile in tiles {
            for node in tile.nodes where !seen.contains(node.id) {
                seen.insert(node.id)
                points.append(SignalPoint(id: "osm-\(node.id)", position: LngLat(node.lng, node.lat), name: nil))
            }
        }
        return points
    }

    /// The credit line the license asks for, with the data month: "Signals: © OpenStreetMap contributors, Nov 2026".
    public var creditLine: String {
        let month = Format.formatDataMonth(dataDate)
        return month.map { "Signals: \(attribution), \($0)" } ?? "Signals: \(attribution)"
    }
}
