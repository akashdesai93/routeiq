import Foundation
import XCTest
import RouteIQCore

// Mirrors, from the Vitest suites:
// - tests/core.test.ts, describe "core geo helpers" (the token check and the
//   framework-free scan are web-only and not ported).
// - tests/signals.test.ts, describe "geo helpers for signal matching".
// - tests/reroute.test.ts, describe "line helpers the engine and the simulated drive share".
// Every position is a public landmark from TestPoints or an invented coordinate.
final class GeoTests: XCTestCase {
    // MARK: - Helpers

    // tests/signals.test.ts: geometry laid out in meters around a point in Charlotte.
    private static let here = LngLat(-80.84, 35.2)
    private static let signalMPerDegree = (6_371_008.8 * Double.pi) / 180
    private static let signalMPerDegreeLng = signalMPerDegree * cos((here.lat * Double.pi) / 180)

    /// The point `eastM` meters east and `northM` meters north of `here` (signals.test.ts `at`).
    private static func signalAt(_ eastM: Double, _ northM: Double) -> LngLat {
        LngLat(here.lng + eastM / signalMPerDegreeLng, here.lat + northM / signalMPerDegree)
    }

    // tests/helpers/driveWorld.ts: a made-up flat plane around a made-up origin.
    private static let origin = LngLat(-81, 35)
    private static let mPerDegree = 111_195.0
    private static let mPerDegreeLng = mPerDegree * cos((35 * Double.pi) / 180)

    /// The coordinate `xM` meters east and `yM` meters north of the origin (driveWorld.ts `at`).
    private static func at(_ xM: Double, _ yM: Double) -> LngLat {
        LngLat(origin.lng + xM / mPerDegreeLng, origin.lat + yM / mPerDegree)
    }

    /// reroute.test.ts: `const line = [at(0, 0), at(1000, 0), at(1000, 500)]`.
    private static let line: [LngLat] = [at(0, 0), at(1000, 0), at(1000, 500)]

    // MARK: - describe('core geo helpers')

    // it('test points are valid and in the Charlotte area')
    func testCoreGeoHelpers_testPointsAreValidAndInTheCharlotteArea() {
        XCTAssertFalse(TestPoints.all.isEmpty)
        for p in TestPoints.all {
            XCTAssertTrue(Geo.isValidLngLat(p.position), p.id)
            XCTAssertGreaterThan(p.position.lng, -81.1, p.id)
            XCTAssertLessThan(p.position.lng, -80.6, p.id)
            // Indian Land is just over the state line in South Carolina.
            XCTAssertGreaterThan(p.position.lat, 34.9, p.id)
            XCTAssertLessThan(p.position.lat, 35.4, p.id)
        }
    }

    // it('boundsOf wraps every point')
    func testCoreGeoHelpers_boundsOfWrapsEveryPoint() throws {
        let box = try Geo.boundsOf(TestPoints.all.map { $0.position })
        for p in TestPoints.all {
            XCTAssertGreaterThanOrEqual(p.position.lng, box.west, p.id)
            XCTAssertLessThanOrEqual(p.position.lng, box.east, p.id)
            XCTAssertGreaterThanOrEqual(p.position.lat, box.south, p.id)
            XCTAssertLessThanOrEqual(p.position.lat, box.north, p.id)
        }
        XCTAssertThrowsError(try Geo.boundsOf([]))
        XCTAssertThrowsError(try Geo.boundsOf([LngLat(200, 0)]))
    }

    // it('distanceM is about 8 km Uptown to SouthPark')
    func testCoreGeoHelpers_distanceMIsAbout8kmUptownToSouthPark() {
        let d = Geo.distanceM(TestPoints.uptownCharlotte.position, TestPoints.southPark.position)
        XCTAssertGreaterThan(d, 7_500)
        XCTAssertLessThan(d, 9_000)
    }

    // MARK: - describe('geo helpers for signal matching')

    // it('localProjector gives meters east and north of its origin')
    func testSignalMatchingGeo_localProjectorGivesMetersEastAndNorthOfItsOrigin() {
        let project = Geo.localProjector(Self.here)
        XCTAssertEqual(project(Self.here), XY(0, 0))
        let xy = project(Self.signalAt(300, -400))
        // toBeCloseTo(v, 6)
        XCTAssertEqual(xy.x, 300, accuracy: 0.5e-6)
        XCTAssertEqual(xy.y, -400, accuracy: 0.5e-6)
    }

    // it('pointToSegment measures to the segment, not the endless line')
    func testSignalMatchingGeo_pointToSegmentMeasuresToTheSegmentNotTheEndlessLine() {
        XCTAssertEqual(Geo.pointToSegment(XY(5, 3), XY(0, 0), XY(10, 0)), SegmentHit(distanceM: 3, t: 0.5))
        XCTAssertEqual(Geo.pointToSegment(XY(-4, 3), XY(0, 0), XY(10, 0)), SegmentHit(distanceM: 5, t: 0))
        XCTAssertEqual(Geo.pointToSegment(XY(13, 4), XY(0, 0), XY(10, 0)), SegmentHit(distanceM: 5, t: 1))
        // A zero-length segment is just its point.
        XCTAssertEqual(Geo.pointToSegment(XY(3, 4), XY(0, 0), XY(0, 0)), SegmentHit(distanceM: 5, t: 0))
    }

    // MARK: - describe('line helpers the engine and the simulated drive share')

    // it('pointAtDistance walks the line and reports the heading')
    func testLineHelpers_pointAtDistanceWalksTheLineAndReportsTheHeading() throws {
        let line = Self.line
        let start = try XCTUnwrap(Geo.pointAtDistance(line, 0))
        XCTAssertEqual(start.index, 0)
        XCTAssertEqual(start.bearingDeg, 90, accuracy: 0.5)
        let mid = try XCTUnwrap(Geo.pointAtDistance(line, 400))
        XCTAssertEqual(Geo.alongRouteM([line[0], mid.point])[1], 400, accuracy: 0.5)
        let up = try XCTUnwrap(Geo.pointAtDistance(line, 1200))
        XCTAssertEqual(up.index, 1)
        XCTAssertEqual(up.bearingDeg, 0, accuracy: 0.5)
        // Clamped at both ends; an empty line has no point.
        XCTAssertEqual(try XCTUnwrap(Geo.pointAtDistance(line, -50)).point, line[0])
        XCTAssertEqual(try XCTUnwrap(Geo.pointAtDistance(line, 99_999)).point, line[2])
        XCTAssertEqual(try XCTUnwrap(Geo.pointAtDistance(line, Double.nan)).point, line[0])
        XCTAssertNil(Geo.pointAtDistance([], 10))
        XCTAssertEqual(Geo.pointAtDistance([line[0]], 10), PointOnLine(point: line[0], index: 0, bearingDeg: 0))
    }

    // it('lineFrom is the rest of the line from a distance on')
    func testLineHelpers_lineFromIsTheRestOfTheLineFromADistanceOn() throws {
        let line = Self.line
        let rest = Geo.lineFrom(line, 400)
        XCTAssertEqual(rest.count, 3)
        let restLength = try XCTUnwrap(Geo.alongRouteM(rest).last)
        let lineLength = try XCTUnwrap(Geo.alongRouteM(line).last)
        XCTAssertEqual(restLength, lineLength - 400, accuracy: 0.5)
        // On a vertex, the vertex is not listed twice.
        XCTAssertEqual(Geo.lineFrom(line, Geo.alongRouteM(line)[1]), [line[1], line[2]])
        XCTAssertEqual(Geo.lineFrom(line, 0), line)
        XCTAssertEqual(Geo.lineFrom(line, 99_999), [line[2]])
        XCTAssertEqual(Geo.lineFrom([], 5), [])
    }

    // it('bearingDeg runs clockwise from north')
    func testLineHelpers_bearingDegRunsClockwiseFromNorth() {
        XCTAssertEqual(Geo.bearingDeg(Self.at(0, 0), Self.at(0, 100)), 0, accuracy: 0.5)
        XCTAssertEqual(Geo.bearingDeg(Self.at(0, 0), Self.at(100, 0)), 90, accuracy: 0.5)
        XCTAssertEqual(Geo.bearingDeg(Self.at(0, 0), Self.at(0, -100)), 180, accuracy: 0.5)
        XCTAssertEqual(Geo.bearingDeg(Self.at(0, 0), Self.at(-100, 0)), 270, accuracy: 0.5)
    }
}
