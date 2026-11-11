import XCTest
import RouteIQCore

/// Mirrors tests/tiles.test.ts. Method names keep the TS describe/it structure:
/// test_<describe>_<it>.
final class TilesTests: XCTestCase {
    private let uptown = TestPoints.uptownCharlotte.position
    private let southPark = TestPoints.southPark.position

    // MARK: - describe('tileIdAt')

    // it('names a tile by its south-west corner in whole tenths of a degree')
    func test_tileIdAt_namesTileBySouthWestCornerInWholeTenths() {
        XCTAssertEqual(Tiles.tileSizeDeg, 0.1)
        XCTAssertEqual(Tiles.tileIdAt(uptown), "-809_352")
        XCTAssertEqual(Tiles.tileIdAt(southPark), "-809_351")
        // North-east, south-east and south-west of the origin.
        XCTAssertEqual(Tiles.tileIdAt(LngLat(2.3522, 48.8566)), "23_488")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(151.2093, -33.8568)), "1512_-339")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-58.3816, -34.6037)), "-584_-347")
    }

    // it('rounds down, not toward zero: negative coordinates are where truncating goes wrong')
    func test_tileIdAt_roundsDownNotTowardZero() {
        // Charlotte is at negative longitude. Truncating -808.43 gives -808, the tile next door to the east.
        XCTAssertNotEqual(Tiles.tileIdAt(LngLat(-80.8431, 35.2271)), "-808_352")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-80.8431, 35.2271)), "-809_352")
        // Either side of zero is two different tiles, not one double-width tile.
        XCTAssertEqual(Tiles.tileIdAt(LngLat(0.05, 0.05)), "0_0")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-0.05, -0.05)), "-1_-1")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-0.05, 0.05)), "-1_0")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(0, 0)), "0_0")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-0.0, -0.0)), "0_0")
    }

    // it('puts a point on a tile edge in the tile to its east or north, without floating-point drift')
    func test_tileIdAt_putsEdgePointInTileToEastOrNorthWithoutDrift() {
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-80.8, 35.2)), "-808_352")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-80.80001, 35.19999)), "-809_351")
        // Sums that do not land exactly on the tenth they mean.
        let pointOne: Double = 0.1
        let pointTwo: Double = 0.2
        let pointThree: Double = 0.3
        XCTAssertNotEqual(pointOne + pointTwo, pointThree)
        XCTAssertEqual(Tiles.tileIdAt(LngLat(0.1 + 0.2, 0.1 + 0.2)), "3_3")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(0.1 - 0.4, 0.7 - 0.8)), "-3_-1")
        // Every edge there is: x tenths of a degree is the west edge of tile x.
        for x in -1800..<1800 {
            XCTAssertEqual(Tiles.tileIdAt(LngLat(Double(x) / 10, 0)), "\(x)_0")
        }
        for y in -900..<900 {
            XCTAssertEqual(Tiles.tileIdAt(LngLat(0, Double(y) / 10)), "0_\(y)")
        }
        for x in stride(from: -1800, to: 1800, by: 7) {
            XCTAssertEqual(Tiles.tileIdAt(LngLat(Double(x) * 0.1, 0)), "\(x)_0")
        }
    }

    // it('wraps longitude at the antimeridian and stops latitude at the poles')
    func test_tileIdAt_wrapsLongitudeAtAntimeridianAndStopsLatitudeAtPoles() {
        XCTAssertEqual(Tiles.tileIdAt(LngLat(179.95, 0)), "1799_0")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-179.95, 0)), "-1800_0")
        // 180 and -180 are the same line.
        XCTAssertEqual(Tiles.tileIdAt(LngLat(180, 0)), "-1800_0")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(-180, 0)), "-1800_0")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(0, 90)), "0_899")
        XCTAssertEqual(Tiles.tileIdAt(LngLat(0, -90)), "0_-900")
    }

    // MARK: - describe('tileBounds')

    // it('gives the box of a tile, with clean edges')
    func test_tileBounds_givesBoxOfTileWithCleanEdges() {
        XCTAssertEqual(Tiles.tileBounds("-809_352"), BBox(-80.9, 35.2, -80.8, 35.3))
        XCTAssertEqual(Tiles.tileBounds("0_0"), BBox(0, 0, 0.1, 0.1))
        XCTAssertEqual(Tiles.tileBounds("-1_-1"), BBox(-0.1, -0.1, 0, 0))
        XCTAssertEqual(Tiles.tileBounds("1799_899"), BBox(179.9, 89.9, 180, 90))
    }

    // it('agrees with tileIdAt: the south-west corner and the middle of a tile are in it')
    func test_tileBounds_agreesWithTileIdAt() {
        let ids = ["-809_352", "-808_351", "0_0", "-1_-1", "1512_-339", "-1800_-900", "1799_899", "3_3"]
        for id in ids {
            guard let box = Tiles.tileBounds(id) else {
                XCTFail("tileBounds(\(id)) is nil")
                continue
            }
            XCTAssertEqual(Tiles.tileIdAt(LngLat(box.west, box.south)), id)
            XCTAssertEqual(Tiles.tileIdAt(LngLat((box.west + box.east) / 2, (box.south + box.north) / 2)), id)
        }
    }

    // it('is null for anything that is not a tile id')
    func test_tileBounds_isNilForAnythingThatIsNotATileId() {
        let bads = ["", "x", "-809", "-809_", "_352", "1800_0", "-1801_0", "0_900", "0_-901", "1.5_2", "-809_352_1"]
        for bad in bads {
            XCTAssertNil(Tiles.tileBounds(bad), bad)
        }
    }

    // MARK: - describe('tilesForRoute')

    // it('lists the tiles the line is in, sorted, each once')
    func test_tilesForRoute_listsTilesSortedEachOnce() {
        XCTAssertEqual(Tiles.tilesForRoute([uptown, southPark]), ["-809_351", "-809_352"])
        let back = [southPark, uptown, southPark]
        XCTAssertEqual(Tiles.tilesForRoute(back), ["-809_351", "-809_352"])
        XCTAssertEqual(Tiles.tilesForRoute([LngLat(-80.85, 35.25), LngLat(-80.84, 35.26)]), ["-809_352"])
    }

    // it('includes the tiles a long segment crosses, not only the ones its ends are in')
    func test_tilesForRoute_includesTilesALongSegmentCrosses() {
        // Two points 40 km apart: five tiles in a row.
        XCTAssertEqual(Tiles.tilesForRoute([LngLat(-80.95, 35.25), LngLat(-80.55, 35.25)]), [
            "-806_352",
            "-807_352",
            "-808_352",
            "-809_352",
            "-810_352",
        ])
        // A long diagonal: every tile a point of the line falls in is listed.
        let a = LngLat(-81.03, 35.02)
        let b = LngLat(-80.31, 35.77)
        let tileSet = Set(Tiles.tilesForRoute([a, b]))
        for i in 0...5000 {
            let t = Double(i) / 5000
            let p = LngLat(a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t)
            XCTAssertTrue(tileSet.contains(Tiles.tileIdAt(p)), "i = \(i)")
        }
        // And not the whole bounding box: the corners far from the line are left out.
        XCTAssertFalse(tileSet.contains(Tiles.tileIdAt(LngLat(-81.03, 35.75))))
        XCTAssertFalse(tileSet.contains(Tiles.tileIdAt(LngLat(-80.31, 35.03))))
    }

    // it('adds the neighboring tile when the line runs within the margin of an edge')
    func test_tilesForRoute_addsNeighboringTileWithinMarginOfAnEdge() {
        // North along a road 18 m east of the tile edge at longitude -80.8.
        let road = [LngLat(-80.7998, 35.21), LngLat(-80.7998, 35.29)]
        XCTAssertEqual(Tiles.tilesForRoute(road), ["-808_352"])
        XCTAssertEqual(Tiles.tilesForRoute(road, marginM: 10), ["-808_352"])
        XCTAssertEqual(Tiles.tilesForRoute(road, marginM: 130), ["-808_352", "-809_352"])
        // A margin that is negative or not a number is no margin.
        XCTAssertEqual(Tiles.tilesForRoute(road, marginM: -500), ["-808_352"])
        XCTAssertEqual(Tiles.tilesForRoute(road, marginM: Double.nan), ["-808_352"])
        // The signal rules reach 60 + 30 + 40 m, so that is the margin signal data is loaded with.
        XCTAssertEqual(Signals.signalTilesForRoute(road), ["-808_352", "-809_352"])
        XCTAssertEqual(
            Signals.signalTilesForRoute(road, options: SignalMatchOptions(clusterRadiusM: 0, toleranceM: 5, intersectionRadiusM: 5)),
            ["-808_352"]
        )
        // A corner: within the margin of two edges means four tiles.
        XCTAssertEqual(Tiles.tilesForRoute([LngLat(-80.7999, 35.2001), LngLat(-80.7998, 35.2002)], marginM: 130), [
            "-808_351",
            "-808_352",
            "-809_351",
            "-809_352",
        ])
    }

    // it('takes a segment across the antimeridian the short way')
    func test_tilesForRoute_takesSegmentAcrossAntimeridianTheShortWay() {
        // 11 km across the 180 degree line, not 359.9 degrees around the world.
        XCTAssertEqual(Tiles.tilesForRoute([LngLat(179.95, 10.05), LngLat(-179.95, 10.05)]), ["-1800_100", "1799_100"])
        XCTAssertEqual(Tiles.tilesForRoute([LngLat(-179.95, 10.05), LngLat(179.95, 10.05)]), ["-1800_100", "1799_100"])
        // The margin wraps too.
        XCTAssertEqual(
            Tiles.tilesForRoute([LngLat(179.9995, 10.05), LngLat(179.9996, 10.05)], marginM: 130),
            ["-1800_100", "1799_100"]
        )
        // Just short of half way round is still taken as drawn.
        XCTAssertGreaterThan(Tiles.tilesForRoute([LngLat(-80, 0.05), LngLat(80, 0.05)]).count, 1500)
    }

    // it('ignores invalid points and handles empty and single-point lines')
    func test_tilesForRoute_ignoresInvalidPointsAndHandlesEmptyAndSinglePointLines() {
        XCTAssertEqual(Tiles.tilesForRoute([]), [])
        XCTAssertEqual(Tiles.tilesForRoute([LngLat(Double.nan, 35)]), [])
        XCTAssertEqual(Tiles.tilesForRoute([uptown]), ["-809_352"])
        XCTAssertEqual(
            Tiles.tilesForRoute([uptown, LngLat(999, 0), LngLat(Double.nan, Double.nan), southPark]),
            ["-809_351", "-809_352"]
        )
    }
}
