import XCTest
import RouteIQCore

// Mirrors tests/tracking.test.ts: position tracking on the made-up road network
// of DriveWorld.swift: a straight 20 km road running east (A), and a road that
// crosses itself. No real place, no clock. toBeCloseTo(v, d) is accuracy 0.5 * 10^-d.
final class TrackingTests: XCTestCase {
    private func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }

    private var MAIN: TrackedRoute { TrackedRoute(DriveWorld.candidate(.A, at(0, 0), 1300)!.geometry) }

    /// A fix `xM` east and `yM` north of the network's origin, taken `tSec` into the drive.
    private func fix(_ xM: Double, _ yM: Double, _ tSec: Double, accuracyM: Double = 8, speedMps: Double? = nil, headingDeg: Double? = nil) -> PositionFix {
        let p = at(xM, yM)
        return PositionFix(lng: p.lng, lat: p.lat, accuracyM: accuracyM, speedMps: speedMps, headingDeg: headingDeg, timeMs: tSec * 1000)
    }

    /// Feeds fixes one after another and returns the state after each.
    private func follow(_ route: TrackedRoute, _ fixes: [PositionFix], _ from: TrackingState? = nil) -> [TrackingState] {
        var states: [TrackingState] = []
        var state = from
        for f in fixes {
            state = Tracking.trackFix(state, route, f)
            if let state { states.append(state) }
        }
        return states
    }

    private func alongs(_ states: [TrackingState]) -> [Double] { states.map { $0.alongRouteM.rounded() } }

    // MARK: - describe('tracking options')

    func testTrackingOptions_hasTheDocumentedDefaultsInOnePlace() {
        let d = TrackingOptions.default
        XCTAssertEqual(d.maxAccuracyM, 50)
        XCTAssertEqual(d.offRouteM, 50)
        XCTAssertEqual(d.offRoutePatienceSec, 8)
        XCTAssertEqual(d.offRouteFixes, 3)
        XCTAssertEqual(d.arrivalRadiusM, 40)
    }

    // MARK: - describe('snapping and progress')

    func testSnapping_snapsAFixBesideTheRoadOntoItAndMeasuresTheDistanceAlongIt() throws {
        let state = try XCTUnwrap(follow(MAIN, [fix(1000, 12, 0)]).first)
        XCTAssertEqual(state.alongRouteM, 1000, accuracy: 0.5)
        XCTAssertEqual(state.distanceFromRouteM, 12, accuracy: 0.5)
        XCTAssertEqual(state.remainingM, 19_000, accuracy: 5)
        // Drawn on the line, not where the device put it.
        XCTAssertEqual(state.position.lat, at(1000, 0).lat, accuracy: 0.5e-6)
        XCTAssertFalse(state.offRoute)
    }

    func testSnapping_noiseNeverMovesTheCarBackwards() throws {
        // A car at 15 m/s whose fixes are thrown up to 12 m along and across the road, and a
        // stretch standing still where they scatter around one spot.
        let wobble: [Double] = [9, -12, 4, -7, 11, -3, 8, -10, 2, -6]
        var fixes: [PositionFix] = []
        for t in 0..<60 { fixes.append(fix(15 * Double(t) + wobble[t % 10], wobble[(t + 3) % 10], Double(t))) }
        for t in 60..<90 { fixes.append(fix(900 + wobble[t % 10], wobble[(t + 5) % 10], Double(t))) }
        let states = follow(MAIN, fixes)
        for i in states.indices.dropFirst() {
            XCTAssertGreaterThanOrEqual(states[i].alongRouteM, states[i - 1].alongRouteM)
        }
        XCTAssertTrue(states.allSatisfy { !$0.offRoute && !$0.reversing })
        // One fix 25 m back is noise: the car stays where it was.
        let pair = follow(MAIN, [fix(1000, 0, 0), fix(975, 0, 1)])
        XCTAssertEqual(pair[1].alongRouteM, pair[0].alongRouteM)
    }

    func testSnapping_aRealUTurnDoesMoveItBackAfterAFewFixesAgreeAndIsThenFollowedAtOnce() {
        let states = follow(MAIN, [fix(1000, 0, 0), fix(960, 0, 1), fix(920, 0, 2), fix(880, 0, 3), fix(840, 0, 4), fix(860, 0, 5)])
        // Two fixes behind prove nothing; the third does.
        XCTAssertEqual(states[1].alongRouteM, 1000, accuracy: 0.5)
        XCTAssertEqual(states[2].alongRouteM, 1000, accuracy: 0.5)
        XCTAssertEqual(states[3].alongRouteM, 880, accuracy: 0.5)
        XCTAssertTrue(states[3].reversing)
        XCTAssertEqual(states[4].alongRouteM, 840, accuracy: 0.5)
        // Forward again: back to normal.
        XCTAssertEqual(states[5].alongRouteM, 860, accuracy: 0.5)
        XCTAssertFalse(states[5].reversing)
        // One stray fix far behind is forgotten when the next is where it should be.
        let stray = follow(MAIN, [fix(1000, 0, 0), fix(700, 0, 1), fix(1030, 0, 2)])
        XCTAssertEqual(alongs(stray), [1000, 1000, 1030])
        XCTAssertEqual(stray[2].jumpFixes, 0)
    }

    func testSnapping_onARouteThatCrossesItselfItTakesThePassThatFitsTheProgressSoFar() throws {
        // East 1 km, north 500 m, west 500 m, then south across the first stretch at (500, 0):
        // the route passes that spot 500 m and 2500 m along.
        let loop = TrackedRoute([at(0, 0), at(1000, 0), at(1000, 500), at(500, 500), at(500, -500)])
        let first = follow(loop, [fix(470, 2, 0), fix(485, 2, 1), fix(500, 2, 2), fix(515, 2, 3)])
        XCTAssertEqual(alongs(first), [470, 485, 500, 515])
        // Coming down the last stretch the same spot is 2500 m along.
        let second = follow(loop, [fix(502, 60, 100), fix(502, 30, 102), fix(502, 2, 104), fix(502, -28, 106)])
        XCTAssertEqual(alongs(second), [2440, 2470, 2498, 2528])
        // The globally nearest point at (500, 2) on the way down would be the first pass.
        XCTAssertFalse(second[2].offRoute)
        // A route taken up again with a hint lands on the pass the hint names.
        let hinted = try XCTUnwrap(Tracking.trackFix(nil, loop, fix(500, 1, 0), hintAlongM: 2480))
        XCTAssertEqual(hinted.alongRouteM, 2499, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(Tracking.trackFix(nil, loop, fix(500, 1, 0), hintAlongM: 480)).alongRouteM, 500, accuracy: 0.5)
    }

    func testSnapping_carriesOnAfterAGapInTheFixesATunnelAsFarAsTheCarCouldHaveDriven() {
        let states = follow(MAIN, [fix(1000, 0, 0), fix(2500, 0, 60)])
        XCTAssertEqual(states[1].alongRouteM, 2500, accuracy: 0.5)
        // The same leap in one second is not believed at once.
        let leap = follow(MAIN, [fix(1000, 0, 0), fix(3000, 0, 1), fix(3015, 0, 2), fix(3030, 0, 3)])
        XCTAssertEqual(alongs(leap), [1000, 1000, 1000, 3030])
    }

    // MARK: - describe('fixes that are not good enough')

    func testNotGoodEnough_ignoresAFixWithPoorAccuracyAFixThatIsNotACoordinateAndOneOutOfOrder() throws {
        let good = try XCTUnwrap(follow(MAIN, [fix(1000, 0, 10)]).first)
        let poor = try XCTUnwrap(Tracking.trackFix(good, MAIN, fix(5000, 300, 11, accuracyM: 80)))
        var expected = good
        expected.ignoredFixes = 1
        XCTAssertEqual(poor, expected)
        var notACoordinate = fix(1100, 0, 12)
        notACoordinate.lat = 135
        XCTAssertEqual(Tracking.trackFix(good, MAIN, notACoordinate)?.alongRouteM, good.alongRouteM)
        XCTAssertEqual(Tracking.trackFix(good, MAIN, fix(1100, 0, 9))?.alongRouteM, good.alongRouteM)
        // Nothing to fall back on yet: no state.
        XCTAssertNil(Tracking.trackFix(nil, MAIN, fix(1000, 0, 0, accuracyM: 51)))
        XCTAssertTrue(Tracking.isUsableFix(fix(0, 0, 0, accuracyM: 50)))
        XCTAssertFalse(Tracking.isUsableFix(fix(0, 0, 0, accuracyM: 50.1)))
        // A device that gives no accuracy is taken on trust; the threshold can be set.
        XCTAssertTrue(Tracking.isUsableFix(fix(0, 0, 0, accuracyM: .nan)))
        XCTAssertTrue(Tracking.isUsableFix(fix(0, 0, 0, accuracyM: 80), options: TrackingOptions(maxAccuracyM: 100)))
    }

    // MARK: - describe('off route, with patience')

    func testOffRoute_oneFixOffTheLineIsNeverOffRouteAndProgressHoldsMeanwhile() {
        let states = follow(MAIN, [fix(1000, 0, 0), fix(1015, 90, 1), fix(1030, 0, 2)])
        XCTAssertFalse(states[1].offRoute)
        XCTAssertEqual(states[1].offFixes, 1)
        XCTAssertEqual(states[1].distanceFromRouteM, 90, accuracy: 0.5)
        XCTAssertEqual(states[1].alongRouteM, 1000, accuracy: 0.5)
        // Off the line the car is drawn where the device says it is.
        XCTAssertEqual(states[1].position, at(1015, 90))
        XCTAssertFalse(states[2].offRoute)
        XCTAssertEqual(states[2].offFixes, 0)
        XCTAssertNil(states[2].offSinceMs)
        XCTAssertEqual(states[2].alongRouteM, 1030, accuracy: 0.5)
    }

    func testOffRoute_threeGoodFixesInARowOffTheLineAreOffRoute() {
        let states = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 1), fix(1020, 85, 2), fix(1030, 90, 3)])
        XCTAssertEqual(states.map(\.offRoute), [false, false, false, true])
        // A poor fix in between is not one of the three.
        let withPoor = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 1), fix(1020, 400, 2, accuracyM: 90), fix(1020, 85, 3)])
        XCTAssertEqual(withPoor.last?.offRoute, false)
        // 50 m is still on the line; a little more is not.
        XCTAssertEqual(follow(MAIN, [fix(1000, 49, 0)]).first?.offFixes, 0)
        XCTAssertEqual(follow(MAIN, [fix(1000, 52, 0)]).first?.offFixes, 1)
    }

    func testOffRoute_orTwoFixesEightSecondsApartButNeverOneFixHoweverLongItHasBeen() {
        let slow = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 1), fix(1040, 90, 9)])
        XCTAssertEqual(slow.map(\.offRoute), [false, false, true])
        let sooner = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 1), fix(1040, 90, 8)])
        XCTAssertEqual(sooner.last?.offRoute, false)
        let single = follow(MAIN, [fix(1000, 0, 0), fix(1010, 80, 600)])
        XCTAssertEqual(single.last?.offRoute, false)
        // The very first fix of a drive, far from the route, is one reading too.
        XCTAssertEqual(follow(MAIN, [fix(1000, 300, 0)]).first?.offRoute, false)
    }

    // MARK: - describe('speed and heading')

    func testSpeedAndHeading_usesTheDeviceSpeedWhenThereIsOneSmoothed() {
        let states = follow(MAIN, [fix(0, 0, 0, speedMps: 10), fix(10, 0, 1, speedMps: 20)])
        XCTAssertEqual(states[0].speedMps, 10)
        XCTAssertEqual(states[1].speedMps, 14, accuracy: 0.005)
    }

    func testSpeedAndHeading_worksTheSpeedOutFromTheFixesWhenTheDeviceGivesNone() throws {
        let states = follow(MAIN, (0..<30).map { fix(15 * Double($0), 0, Double($0)) })
        let last = try XCTUnwrap(states.last)
        XCTAssertEqual(last.speedMps, 15, accuracy: 0.5)
        XCTAssertNil(last.stoppedSinceMs)
        // Standing still, with fixes scattering around one spot: the speed falls to nothing.
        let parked = follow(MAIN, (0..<30).map { i in fix(435 + (i % 2 != 0 ? 6 : -6), Double(i % 3), 30 + Double(i)) }, last)
        let end = try XCTUnwrap(parked.last)
        XCTAssertLessThan(end.speedMps, 0.5)
        let since = try XCTUnwrap(end.stoppedSinceMs)
        XCTAssertLessThan(since, 45_000)
    }

    func testSpeedAndHeading_takesTheDeviceHeadingWhileMovingAndTheDirectionOfTheRouteOtherwise() {
        XCTAssertEqual(follow(MAIN, [fix(0, 0, 0, speedMps: 12, headingDeg: 84)]).first?.headingDeg, 84)
        // The road runs east.
        XCTAssertEqual(follow(MAIN, [fix(500, 3, 0)]).first?.headingDeg ?? .nan, 90, accuracy: 0.5)
        // Standing still the device's heading points anywhere: the route's is kept.
        XCTAssertEqual(follow(MAIN, [fix(500, 3, 0, speedMps: 0, headingDeg: 200)]).first?.headingDeg ?? .nan, 90, accuracy: 0.5)
    }

    // MARK: - describe('arrival')

    func testArrival_arrivesWithin40mOfTheDestinationAlongTheRouteNotBefore() {
        XCTAssertEqual(follow(MAIN, [fix(19_900, 0, 0)]).first?.arrived, false)
        XCTAssertEqual(follow(MAIN, [fix(19_965, 5, 0)]).first?.arrived, true)
        // Driven past the end.
        XCTAssertEqual(follow(MAIN, [fix(20_030, 0, 0)]).first?.arrived, true)
    }

    func testArrival_arrivesBesideTheDestinationTooACarParkButOnlyAtTheEndOfTheRoute() {
        let parked = follow(MAIN, [fix(19_800, 0, 0), fix(19_990, 38, 13)])
        XCTAssertTrue(parked[1].arrived)
        // A loop that starts where it ends has not arrived at its start.
        let loop = TrackedRoute([at(0, 0), at(1000, 0), at(1000, 1000), at(0, 1000), at(0, 10)])
        XCTAssertEqual(follow(loop, [fix(5, 0, 0)]).first?.arrived, false)
        XCTAssertEqual(follow(loop, [fix(5, 0, 0)]).first?.alongRouteM ?? .nan, 5, accuracy: 0.5)
    }

    // MARK: - describe('retrack')

    func testRetrack_putsTheCarOnAnotherRouteWhereItIsKeepingItsSpeed() throws {
        let on = try XCTUnwrap(follow(MAIN, [fix(6000, 0, 0, speedMps: 14)]).first)
        let other = TrackedRoute(try XCTUnwrap(DriveWorld.candidate(.B, at(5000, 0), 900)).geometry)
        // B turns north at 5 km; 6 km along A is nowhere near it.
        let off = Tracking.retrack(on, other)
        XCTAssertEqual(off.offFixes, 1)
        XCTAssertFalse(off.offRoute)
        XCTAssertEqual(off.speedMps, 14)
        let fresh = TrackedRoute(try XCTUnwrap(DriveWorld.candidate(.A, at(5900, 0), 900)).geometry)
        XCTAssertEqual(Tracking.retrack(on, fresh).alongRouteM, 100, accuracy: 0.5)
    }

    // it('prepares a geometry once'): the TypeScript caches by array identity; a Swift
    // TrackedRoute is a value, so only the length assertion carries over.
    func testRetrack_preparesAGeometryOnce() throws {
        let geometry = try XCTUnwrap(DriveWorld.candidate(.A, at(0, 0), 1300)).geometry
        XCTAssertEqual(TrackedRoute(geometry).lengthM, 20_000, accuracy: 50)
    }
}
