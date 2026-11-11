import Foundation
import XCTest
import RouteIQCore
@testable import RouteIQKit

/// The bundle folder the web app serves, public/seed/osm-signals, read from the repository.
enum RepoBundle {
    static var root: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url
    }

    static var folder: URL { root.appendingPathComponent("public/seed/osm-signals") }

    static func indexData() throws -> Data { try Data(contentsOf: folder.appendingPathComponent("index.json")) }

    static func tileFiles() throws -> [Data] {
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
            .filter { $0.hasSuffix(".json") && $0 != "index.json" }
            .sorted()
        return try names.map { try Data(contentsOf: folder.appendingPathComponent($0)) }
    }

    /// The bundle as the app ships it: one packed file, built here the way
    /// native/scripts/pack-signal-bundle.mjs writes it (index and tiles verbatim).
    static func packedData() throws -> Data {
        var data = Data(#"{"version":1,"index":"#.utf8)
        data.append(try indexData())
        data.append(Data(#","tiles":["#.utf8))
        let tiles = try tileFiles()
        for (i, tile) in tiles.enumerated() {
            if i > 0 { data.append(Data(",".utf8)) }
            data.append(tile)
        }
        data.append(Data("]}".utf8))
        return data
    }

    static let shared: SignalBundle = try! SignalBundle(packed: packedData())
}

final class TileRowsTests: XCTestCase {
    func testReadsRunsAlongARowLikeTheWebIndex() throws {
        let rows = try XCTUnwrap(TileRows(["352": [-812, -810, -805, -805], "-1": [0, 0]]))
        XCTAssertTrue(rows.has("-812_352"))
        XCTAssertTrue(rows.has("-811_352"))
        XCTAssertTrue(rows.has("-810_352"))
        XCTAssertFalse(rows.has("-809_352"))
        XCTAssertTrue(rows.has("-805_352"))
        XCTAssertTrue(rows.has("0_-1"))
        XCTAssertFalse(rows.has("-812_353"))
        XCTAssertFalse(rows.has("not a tile"))
        XCTAssertEqual(rows.count, 5)
    }

    func testRefusesMalformedRowsAsIsTileRowsDoes() {
        XCTAssertNil(TileRows(["352": [-812]]))            // odd length
        XCTAssertNil(TileRows(["x": [0, 1]]))              // row is not a number
        XCTAssertNil(TileRows(["352": [0.5, 1]]))          // not whole
        XCTAssertNil(TileRows(["352": [3, 1]]))            // run ends before it starts
        XCTAssertNil(TileRows(["352": [0, 2, 3, 4]]))      // runs touch
        XCTAssertNotNil(TileRows(["352": [0, 2, 4, 4]]))
        XCTAssertNotNil(TileRows([:]))
    }
}

final class SignalBundleTests: XCTestCase {
    func testThePackedBundleHoldsEveryTileTheIndexLists() throws {
        let bundle = RepoBundle.shared
        XCTAssertEqual(bundle.tiles.count, bundle.files.count)
        XCTAssertGreaterThan(bundle.files.count, 800)
        XCTAssertGreaterThan(bundle.covered.count, 2000)
        XCTAssertEqual(bundle.attribution, "© OpenStreetMap contributors")
        // Both ways of reading it agree.
        let fromFolder = try SignalBundle(indexJSON: RepoBundle.indexData(), tileFiles: RepoBundle.tileFiles())
        XCTAssertEqual(fromFolder.tiles.count, bundle.tiles.count)
        XCTAssertEqual(fromFolder.covered, bundle.covered)
        XCTAssertEqual(fromFolder.dataDate, bundle.dataDate)
    }

    func testCoverageIsCoveredClippedOrNone() {
        let bundle = RepoBundle.shared
        // Uptown Charlotte: inside the Carolinas, with signals.
        XCTAssertEqual(bundle.coverage(Tiles.tileIdAt(TestPoints.uptownCharlotte.position)), .covered)
        // Atlanta: outside the extracts.
        XCTAssertEqual(bundle.coverage(Tiles.tileIdAt(LngLat(-84.388, 33.749))), .none)
        XCTAssertEqual(bundle.coverage("nonsense"), .none)
    }

    func testACoveredTileWithoutAFileIsKnownToBeEmpty() throws {
        let index = Data(#"{"version":2,"dataDate":0,"covered":{"352":[-810,-808]},"files":{"352":[-809,-809]}}"#.utf8)
        let tile = Data(#"{"tileId":"-809_352","fetchedAt":0,"nodes":[{"id":7,"lng":-80.85,"lat":35.25}]}"#.utf8)
        let bundle = try SignalBundle(indexJSON: index, tileFiles: [tile])
        // A route inside -808_352 only: covered, no file, so a full count of zero.
        let route = RouteCandidate(id: "r", geometry: [LngLat(-80.75, 35.25), LngLat(-80.74, 35.26)], durationSec: 60, typicalDurationSec: 60, distanceM: 1000)
        let loaded = bundle.signalData(for: [route])
        XCTAssertEqual(loaded.missingTileIds, [])
        XCTAssertTrue(loaded.data.primary.isEmpty)
        let counted = Signals.withSignalCounts([route], loaded.data).routes[0]
        XCTAssertEqual(counted.signalCount, 0)
        XCTAssertEqual(counted.signalCoverage, .full)
        XCTAssertEqual(Format.formatSignalCount(counted.signalCount, counted.signalCoverage), "0 signals")
    }

    func testRefusesSomethingThatIsNotABundle() {
        XCTAssertThrowsError(try SignalBundle(packed: Data("{}".utf8)))
        XCTAssertThrowsError(try SignalBundle(packed: Data(#"{"version":2,"index":{},"tiles":[]}"#.utf8)))
        let oldIndex = Data(#"{"version":1,"dataDate":0,"covered":{},"files":{}}"#.utf8)
        XCTAssertThrowsError(try SignalBundle(indexJSON: oldIndex, tileFiles: []))
        let badRows = Data(#"{"version":2,"dataDate":0,"covered":{"1":[0]},"files":{}}"#.utf8)
        XCTAssertThrowsError(try SignalBundle(indexJSON: badRows, tileFiles: []))
    }

    func testTheCreditNamesOpenStreetMapAndTheDataMonth() {
        let line = RepoBundle.shared.creditLine
        XCTAssertTrue(line.hasPrefix("Signals: © OpenStreetMap contributors, "), line)
        XCTAssertEqual(line, "Signals: © OpenStreetMap contributors, \(Format.formatDataMonth(RepoBundle.shared.dataDate)!)")
    }

    func testTheLoaderReadsThePackedFileOnceAndCopesWithoutOne() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("routeiq-bundle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("osm-signals.json")
        try RepoBundle.packedData().write(to: file)

        let loader = SignalBundleLoader(url: file)
        let first = await loader.bundle()
        XCTAssertEqual(first?.tiles.count, RepoBundle.shared.tiles.count)
        // Read once: removing the file changes nothing for this loader.
        try FileManager.default.removeItem(at: file)
        let second = await loader.bundle()
        XCTAssertEqual(second?.dataDate, first?.dataDate)

        let none = await SignalBundleLoader(url: nil).bundle()
        XCTAssertNil(none)
        let missing = await SignalBundleLoader(url: dir.appendingPathComponent("absent.json")).bundle()
        XCTAssertNil(missing)
    }

    func testTheDemoTripGetsFullSignalCounts() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/directions.ok.json"))
        guard case .routes(let rows) = RoutePlan.from(Directions.parse(data: data), signals: RepoBundle.shared) else {
            return XCTFail("expected routes")
        }
        XCTAssertEqual(rows.count, 3)
        // Every route lies in covered tiles: every count is a plain number.
        for row in rows {
            XCTAssertTrue(row.signals.hasSuffix("signal") || row.signals.hasSuffix("signals"), row.signals)
            XCTAssertFalse(row.signals.contains("unknown"))
            XCTAssertFalse(row.signals.contains("partial"))
        }
    }
}

/// The same signal counts as the web app, on the same bundle: the expected
/// values come from the web app's own TypeScript (bundle layer, tile source,
/// withSignalCounts), written by native/scripts/signal-parity-reference.mjs.
final class SignalBundleParityTests: XCTestCase {
    static func reference() throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/signal-parity.json")
        return try JSONValue.parse(Data(contentsOf: url))
    }

    static func lngLat(_ v: JSONValue) -> LngLat {
        let a = v.arrayValue!
        return LngLat(a[0].numberValue!, a[1].numberValue!)
    }

    static func route(_ v: JSONValue) -> RouteCandidate {
        let geometry = v["geometry"]!.arrayValue!.map(lngLat)
        let intersections = v["intersections"]?.arrayValue.map { list in
            list.map { RouteIntersection(location: lngLat($0["location"]!), signal: $0["signal"] == JSONValue.bool(true)) }
        }
        let spans = v["limitedAccessSpansM"]?.arrayValue.map { list in
            list.map { DistanceSpanM($0.arrayValue![0].numberValue!, $0.arrayValue![1].numberValue!) }
        }
        return RouteCandidate(
            id: Hash.routeIdFromGeometry(geometry), geometry: geometry, durationSec: 600, typicalDurationSec: 600,
            distanceM: Geo.alongRouteM(geometry).last ?? 0,
            intersections: intersections, limitedAccessSpansM: spans
        )
    }

    func testEverySetCountsExactlyAsTheWebAppDoes() throws {
        let reference = try Self.reference()
        XCTAssertEqual(reference["bundleDataDate"]?.numberValue, RepoBundle.shared.dataDate, "reference is from another bundle")
        let sets = try XCTUnwrap(reference["sets"]?.arrayValue)
        XCTAssertEqual(sets.count, 7)
        var coverages = Set<String>()
        for set in sets {
            let name = set["name"]!.stringValue!
            let routes = set["routes"]!.arrayValue!.map(Self.route)
            let loaded = RepoBundle.shared.signalData(for: routes)
            XCTAssertEqual(loaded.missingTileIds, set["missingTileIds"]!.arrayValue!.map { $0.stringValue! }, name)
            XCTAssertEqual(Double(loaded.data.primary.count), set["primaryPointCount"]!.numberValue!, name)
            let counted = Signals.withSignalCounts(routes, loaded.data)
            for (i, expected) in set["results"]!.arrayValue!.enumerated() {
                let got = counted.routes[i]
                XCTAssertEqual(got.signalCount.map(Double.init), expected["signalCount"]!.numberValue, "\(name) route \(i)")
                XCTAssertEqual(got.signalCoverage.rawValue, expected["signalCoverage"]!.stringValue!, "\(name) route \(i)")
                XCTAssertEqual(
                    counted.signalsByRouteId[got.id]?.map(\.id) ?? [],
                    expected["signalIds"]!.arrayValue!.map { $0.stringValue! },
                    "\(name) route \(i)"
                )
                coverages.insert(got.signalCoverage.rawValue)
            }
        }
        // The reference exercises both kinds of answer, not just the easy one.
        XCTAssertEqual(coverages, ["full", "partial"])
    }
}
