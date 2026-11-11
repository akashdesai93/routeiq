import Foundation
import XCTest
import RouteIQCore

// Mirrors tests/reroute.test.ts, assertion for assertion, except the describe
// "line helpers the engine and the simulated drive share" (in GeoTests.swift).
// Scripted drives through the reroute engine on a fake clock and a made-up road
// network (see DriveWorld.swift). No network, no timers; every position is invented.

/// Helpers that escaping closures (eta, tamper) can call without capturing the test case.
private enum RerouteFx {
    typealias RouteName = DriveWorld.RouteName
    typealias PollContext = DriveWorld.PollContext

    /// The TS `fixed(etas)`: ETAs by route name; a name left out is not offered.
    static func fixed(_ etas: KeyValuePairs<RouteName, Double>) -> (RouteName, PollContext) -> Double? {
        { name, _ in etas.first(where: { $0.key == name })?.value }
    }

    /// The TS `signals(signalCount, signalCoverage = 'full')`, as a patch.
    static func signals(_ signalCount: Int, _ signalCoverage: SignalCoverage = .full) -> DriveWorld.Patch {
        { route in
            route.signalCount = signalCount
            route.signalCoverage = signalCoverage
        }
    }

    /// `{ signalCount: null, signalCoverage: 'none' }`.
    static let noSignals: DriveWorld.Patch = { route in
        route.signalCount = nil
        route.signalCoverage = SignalCoverage.none
    }

    /// A small seeded generator (mulberry32), so the "random" drives are the same on every run.
    static func seeded(_ seed: UInt32) -> () -> Double {
        var a = seed
        return {
            a = a &+ 0x6D2B_79F5
            var t = a
            t = (t ^ (t >> 15)) &* (t | 1)
            t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
            return Double(t ^ (t >> 14)) / 4_294_967_296
        }
    }

    /// The JS `/^(Staying|Switching): \S/`.
    static func hasReasonShape(_ reason: String) -> Bool {
        for prefix in ["Staying: ", "Switching: "] where reason.hasPrefix(prefix) {
            guard let next = reason.dropFirst(prefix.count).first else { return false }
            return !next.isWhitespace
        }
        return false
    }
}

final class RerouteTests: XCTestCase {
    private typealias RouteName = DriveWorld.RouteName
    private typealias DriveScript = DriveWorld.DriveScript
    private typealias DriveLog = DriveWorld.DriveLog
    private typealias PollRecord = DriveWorld.PollRecord
    private typealias Switch = DriveWorld.Switch
    private typealias Patch = DriveWorld.Patch

    // MARK: - Helpers (as in the TS file)

    private func at(_ xM: Double, _ yM: Double) -> LngLat { DriveWorld.at(xM, yM) }

    private func candidate(_ name: RouteName, _ from: LngLat, _ durationSec: Double, _ extra: Patch? = nil) -> RouteCandidate? {
        DriveWorld.candidate(name, from, durationSec, extra)
    }

    private func drive(_ script: DriveScript) -> DriveLog { DriveWorld.drive(script) }

    private func nameOf(_ route: RouteCandidate) -> RouteName { DriveWorld.nameOf(route) }

    /// The route name in a candidate id, the TS `nameOf({ id })`; nil when there is no id.
    private func idName(_ id: String?) -> String? {
        guard let id else { return nil }
        return id.split(separator: "-", omittingEmptySubsequences: false).first.map { String($0) }
    }

    /// The poll at index `i`, failing (not trapping) when the drive was shorter.
    private func pollAt(_ log: DriveLog, _ i: Int) throws -> PollRecord {
        let found: PollRecord? = log.polls.indices.contains(i) ? log.polls[i] : nil
        return try XCTUnwrap(found, "the drive has no poll \(i)")
    }

    /// The JS `Array.prototype.slice(start, end)`, clamped, never trapping.
    private func slice<T>(_ array: [T], _ start: Int, _ end: Int? = nil) -> [T] {
        let from = min(max(start, 0), array.count)
        let to = min(max(end ?? array.count, from), array.count)
        return Array(array[from..<to])
    }

    /// One poll while driving the main road A, `xM` meters along it. `etas` in
    /// the TS key order; `extra` changes the candidate of a route, by name.
    private func pollOnA(
        xM: Double,
        etas: KeyValuePairs<RouteName, Double>,
        speedMps: Double = 5,
        nowSec: Double = 0,
        state: RerouteState = .initial,
        options: RerouteOptions = .default,
        extra: [RouteName: Patch] = [:]
    ) -> RerouteDecision {
        let here = at(xM, 0)
        let candidates = etas.compactMap { entry in candidate(entry.key, here, entry.value, extra[entry.key]) }
        let routeGeometry = candidate(.A, at(0, 0), 2000)?.geometry ?? []
        return Reroute.decideReroute(
            state,
            RerouteObservation(
                nowSec: nowSec,
                route: DrivenRoute(geometry: routeGeometry, maneuvers: [], limitedAccessSpansM: nil),
                positionAlongM: xM,
                speedMps: speedMps,
                candidates: candidates
            ),
            options: options
        )
    }

    /// Switch on the first winning poll, for tests that are about one rule only.
    private let noConfirm = RerouteOptions(confirmPolls: 1)

    // MARK: - describe('reroute thresholds')

    // it('has one documented set of defaults')
    func testRerouteThresholds_hasOneDocumentedSetOfDefaults() {
        let d = RerouteOptions.default
        XCTAssertEqual(d.minSavingSec, 120)
        XCTAssertEqual(d.minSavingFraction, 0.05)
        XCTAssertEqual(d.confirmPolls, 2)
        XCTAssertEqual(d.cooldownSec, 300)
        XCTAssertEqual(d.noReturnSec, 600)
        XCTAssertEqual(d.returnSavingFactor, 2)
        XCTAssertEqual(d.minLeadDistanceM, 400)
        XCTAssertEqual(d.minLeadTimeSec, 20)
        XCTAssertEqual(d.freewayLeadDistanceM, 1200)
        XCTAssertEqual(d.routeLostPolls, 3)
        XCTAssertEqual(d.offRouteM, 50)
        XCTAssertEqual(d.sameRouteToleranceM, 10)
        XCTAssertEqual(d.returnOverlapFraction, 0.5)
        XCTAssertEqual(d.requireTypicalDuration, true)
        XCTAssertEqual(d.etaTieWindowSec, 30)
        // The default-argument call is the same set.
        XCTAssertEqual(RerouteOptions(), d)
    }

    // it('falls back to the default for a threshold that is negative or not a number')
    func testRerouteThresholds_fallsBackToTheDefaultForAThresholdThatIsNegativeOrNotANumber() {
        let odd = RerouteOptions(minSavingSec: .nan, confirmPolls: 0, minLeadDistanceM: -1)
        // 150 s saved clears the default 120 s; confirmPolls 0 is read as 1.
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 2000, .B: 1850], options: odd).action, .switchRoute)
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 2000, .B: 1890], options: odd).code, .savingTooSmall)
        XCTAssertEqual(pollOnA(xM: 4700, etas: [.A: 2000, .B: 1850], options: odd).code, .tooLate)
    }

    // MARK: - describe('findCurrentRoute: which fresh candidate is the rest of the current route')

    // it('matches by path, never by id, from wherever the driver is')
    func testFindCurrentRoute_matchesByPathNeverByIdFromWhereverTheDriverIs() throws {
        let driven = try XCTUnwrap(candidate(.B, at(0, 0), 2000))
        let here = at(3000, 0)
        let fresh = [
            try XCTUnwrap(candidate(.A, here, 1500)),
            try XCTUnwrap(candidate(.B, here, 1600)),
            try XCTUnwrap(candidate(.C, here, 1700)),
        ]
        XCTAssertFalse(fresh.map(\.id).contains(driven.id))
        XCTAssertEqual(idName(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: fresh)?.id), "B")
        // The same id on another road proves nothing.
        var impostor = fresh[0]
        impostor.id = driven.id
        XCTAssertNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [impostor, fresh[2]]))
    }

    // it('tolerates the few meters a provider moves points between polls, and fewer or more vertices')
    func testFindCurrentRoute_toleratesTheFewMetersAProviderMovesPointsBetweenPollsAndFewerOrMoreVertices() throws {
        let driven = try XCTUnwrap(candidate(.B, at(0, 0), 2000))
        let fresh = try XCTUnwrap(candidate(.B, at(3000, 0), 1600))
        let nudged = fresh.geometry.enumerated().map { i, p in LngLat(p.lng, p.lat + (i % 2 == 0 ? 3.0 : -3.0) / 111_195) }
        let count = fresh.geometry.count
        let thinned = fresh.geometry.enumerated().filter { i, _ in i % 2 == 0 || i == count - 1 }.map { $0.element }
        var withNudged = fresh
        withNudged.geometry = nudged
        var withThinned = fresh
        withThinned.geometry = thinned
        XCTAssertNotNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [withNudged]))
        XCTAssertNotNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [withThinned]))
        // The next street over is not the same route.
        var shifted = fresh
        shifted.geometry = fresh.geometry.map { p in LngLat(p.lng, p.lat + 30 / 111_195) }
        XCTAssertNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [shifted]))
        // Nor is a route that stops short of the destination.
        var short = fresh
        short.geometry = Array(fresh.geometry.dropLast(4))
        XCTAssertNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: [short]))
        XCTAssertNil(Reroute.findCurrentRoute(driven.geometry, positionAlongM: 3000, candidates: []))
    }

    // MARK: - describe('scripted drives')

    // it('oscillating ETAs: A and B trade places every poll, and nothing ever switches')
    func testScriptedDrives_oscillatingEtasAAndBTradePlacesEveryPollAndNothingEverSwitches() throws {
        let log = drive(DriveScript(polls: 14, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return context.poll % 2 == 0 ? 1800 : 2200
            default: return nil
            }
        }))
        XCTAssertEqual(log.polls.count, 14)
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(log.codes, (0..<14).map { $0 % 2 == 0 ? "confirming" : "current-best" })
        XCTAssertEqual(try pollAt(log, 0).decision.reason, "Staying: faster route saves 3.3 minutes, confirming, check 1 of 2")
        XCTAssertEqual(try pollAt(log, 1).decision.reason, "Staying: current route is still the fastest")
    }

    // it('oscillating winners: a different alternative wins each poll, and nothing ever switches')
    func testScriptedDrives_oscillatingWinnersADifferentAlternativeWinsEachPollAndNothingEverSwitches() {
        let log = drive(DriveScript(polls: 14, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return context.poll % 2 == 0 ? 1700 : 1950
            case .C: return context.poll % 2 == 0 ? 1950 : 1700
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(Set(log.codes), ["confirming"])
        XCTAssertTrue(log.polls.allSatisfy { $0.decision.nextState.pending?.polls == 1 })
    }

    // it('a steady 3 minute gain: exactly one switch, on the second poll that confirms it')
    func testScriptedDrives_aSteady3MinuteGainExactlyOneSwitchOnTheSecondPollThatConfirmsIt() throws {
        let log = drive(DriveScript(polls: 20, eta: RerouteFx.fixed([.A: 2000, .B: 1820, .C: 2100])))
        XCTAssertEqual(log.switches, [Switch(nowSec: 60, from: .A, to: .B)])
        XCTAssertEqual(slice(log.codes, 0, 2), ["confirming", "faster-route"])
        XCTAssertEqual(try pollAt(log, 0).decision.reason, "Staying: faster route saves 3 minutes, confirming, check 1 of 2")
        // 4.7 km before the turn-off, in words to speak.
        let switched = try pollAt(log, 1).decision
        XCTAssertEqual(switched.reason, "Switching: saves 3 minutes, turn in 2.9 miles")
        let considered = try XCTUnwrap(switched.considered)
        // toMatchObject({ savingSec: 180, requiredLeadM: 400, onFreeway: false })
        XCTAssertEqual(considered.savingSec, 180)
        XCTAssertEqual(considered.requiredLeadM, 400)
        XCTAssertEqual(considered.onFreeway, false)
        XCTAssertEqual(considered.turnInM, 4700, accuracy: 0.5)
        XCTAssertEqual(considered.turnAt.lng, at(5000, 0).lng, accuracy: 0.5e-6)
        // From then on the old route is the slower alternative, and once B is alone on its own road there is none.
        XCTAssertEqual(Set(slice(log.codes, 2)), ["current-best", "no-alternative"])
    }

    // it('needs as many confirming polls as confirmPolls says')
    func testScriptedDrives_needsAsManyConfirmingPollsAsConfirmPollsSays() {
        let steady = DriveScript(polls: 8, eta: RerouteFx.fixed([.A: 2000, .B: 1820]))
        var once = steady
        once.options = RerouteOptions(confirmPolls: 1)
        var four = steady
        four.options = RerouteOptions(confirmPolls: 4)
        XCTAssertEqual(drive(once).switches.map(\.nowSec), [0])
        XCTAssertEqual(drive(four).switches.map(\.nowSec), [180])
    }

    // it('a gain that appears inside the lead distance is refused, and then the turn-off is behind')
    func testScriptedDrives_aGainThatAppearsInsideTheLeadDistanceIsRefusedAndThenTheTurnOffIsBehind() throws {
        let log = drive(DriveScript(startAlongM: 4000, polls: 8, eta: { name, context in
            // The gain shows up at the fourth poll, 100 m before the turn-off.
            switch name {
            case .A: return 2000
            case .B: return context.poll >= 3 ? 1700 : 2050
            case .C: return 2100
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(log.codes, [
            "current-best", "current-best", "current-best", "too-late",
            "current-best", "current-best", "current-best", "current-best",
        ])
        let refused = try pollAt(log, 3).decision
        XCTAssertEqual(refused.reason, "Staying: faster route turns off in 300 feet, too late to take safely")
        let considered = try XCTUnwrap(refused.considered)
        XCTAssertEqual(considered.turnInM, 100, accuracy: 0.5)
        XCTAssertEqual(considered.requiredLeadM, 400)
        // Past 5 km only C is still ahead.
        XCTAssertNil(try pollAt(log, 4).decision.nextState.pending)
    }

    // it('a confirmed gain is still refused when the second poll comes too close to the turn-off')
    func testScriptedDrives_aConfirmedGainIsStillRefusedWhenTheSecondPollComesTooCloseToTheTurnOff() {
        let log = drive(DriveScript(startAlongM: 4050, polls: 5, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return context.poll >= 1 ? 1700 : 2050
            default: return nil
            }
        }))
        // 650 m ahead: confirming. 350 m and 50 m ahead: too late. Then B is behind and nothing is left.
        XCTAssertEqual(log.codes, ["current-best", "confirming", "too-late", "too-late", "no-alternative"])
        XCTAssertEqual(log.switches, [])
    }

    // it('cooldown: a second, better route has to wait five minutes after a switch')
    func testScriptedDrives_cooldownASecondBetterRouteHasToWaitFiveMinutesAfterASwitch() throws {
        let log = drive(DriveScript(polls: 10, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return 1820
            case .D: return context.poll >= 2 ? 1500 : nil
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [
            Switch(nowSec: 60, from: .A, to: .B),
            Switch(nowSec: 360, from: .B, to: .D),
        ])
        XCTAssertEqual(log.codes, [
            "confirming", "faster-route", "confirming", "cooldown", "cooldown",
            "cooldown", "faster-route", "current-best", "current-best", "current-best",
        ])
        XCTAssertEqual(try pollAt(log, 3).decision.reason, "Staying: faster route saves 5.3 minutes, but we switched routes 2 minutes ago")
    }

    // it('no return: the route just left needs twice the saving, until ten minutes have passed')
    func testScriptedDrives_noReturnTheRouteJustLeftNeedsTwiceTheSavingUntilTenMinutesHavePassed() throws {
        let log = drive(DriveScript(polls: 14, eta: { name, context in
            // After the switch to B, A comes back 150 s faster: enough for a new route, not for a return.
            switch name {
            case .B: return 1820
            case .A: return context.poll >= 2 ? 1670 : 2000
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [
            Switch(nowSec: 60, from: .A, to: .B),
            Switch(nowSec: 720, from: .B, to: .A),
        ])
        // Refused from 120 s to 600 s, the cooldown having ended long before; free again at 660 s.
        XCTAssertEqual(slice(log.codes, 2, 11), Array(repeating: "recently-abandoned", count: 9))
        XCTAssertEqual(slice(log.codes, 11, 13), ["confirming", "faster-route"])
        XCTAssertEqual(
            try pollAt(log, 2).decision.reason,
            "Staying: faster route is the one we left 60 seconds ago, and it saves only 2.5 minutes"
        )
        XCTAssertEqual(try pollAt(log, 11).stateBefore.abandoned.count, 1)
        XCTAssertEqual(try pollAt(log, 11).decision.nextState.abandoned.count, 0)
    }

    // it('no return: twice the saving does bring the old route back, after the cooldown')
    func testScriptedDrives_noReturnTwiceTheSavingDoesBringTheOldRouteBackAfterTheCooldown() {
        let log = drive(DriveScript(polls: 9, eta: { name, context in
            switch name {
            case .B: return 1820
            case .A: return context.poll >= 2 ? 1500 : 2000
            default: return nil
            }
        }))
        XCTAssertEqual(log.switches, [
            Switch(nowSec: 60, from: .A, to: .B),
            Switch(nowSec: 360, from: .B, to: .A),
        ])
        XCTAssertEqual(slice(log.codes, 2, 7), ["confirming", "cooldown", "cooldown", "cooldown", "faster-route"])
    }

    // it('a third route that is not the one left is not held to the return rule')
    func testScriptedDrives_aThirdRouteThatIsNotTheOneLeftIsNotHeldToTheReturnRule() {
        // On B after the switch; C (off the main road farther on) is not offered from B, D is.
        let log = drive(DriveScript(polls: 9, eta: { name, context in
            switch name {
            case .A: return 2000
            case .B: return 1820
            case .D: return context.poll >= 2 ? 1690 : nil
            default: return nil
            }
        }, options: RerouteOptions(cooldownSec: 0)))
        // 130 s saved: under the doubled minimum, over the plain one.
        XCTAssertEqual(log.switches.map(\.to), [.B, .D])
    }

    // it('no alternatives: stays, every poll')
    func testScriptedDrives_noAlternativesStaysEveryPoll() throws {
        let log = drive(DriveScript(polls: 10, eta: RerouteFx.fixed([.A: 2000])))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(Set(log.codes), ["no-alternative"])
        XCTAssertEqual(try pollAt(log, 0).decision.reason, "Staying: no other route available right now")
    }

    // it('an empty answer: stays')
    func testScriptedDrives_anEmptyAnswerStays() {
        let log = drive(DriveScript(polls: 4, eta: RerouteFx.fixed([.A: 2000, .B: 1500]), tamper: { _, _ in [] }))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(Set(log.codes), ["no-routes"])
    }

    // it('failed polls change nothing but a counter, and a confirmation in progress survives them')
    func testScriptedDrives_failedPollsChangeNothingButACounterAndAConfirmationInProgressSurvivesThem() throws {
        let log = drive(DriveScript(
            polls: 8,
            eta: RerouteFx.fixed([.A: 2000, .B: 1820]),
            tamper: { candidates, context in context.poll >= 1 && context.poll <= 5 ? nil : candidates }
        ))
        XCTAssertEqual(log.codes, [
            "confirming", "poll-failed", "poll-failed", "poll-failed",
            "poll-failed", "poll-failed", "faster-route", "current-best",
        ])
        let afterFirst = try pollAt(log, 0).decision.nextState
        XCTAssertEqual(afterFirst.pending?.polls, 1)
        for failed in 1...5 {
            var expected = afterFirst
            expected.failedPolls = failed
            XCTAssertEqual(try pollAt(log, failed).decision.nextState, expected, "poll \(failed)")
            XCTAssertEqual(try pollAt(log, failed).decision.action, .stay, "poll \(failed)")
        }
        XCTAssertEqual(try pollAt(log, 1).decision.reason, "Staying: could not check for faster routes")
        XCTAssertEqual(try pollAt(log, 3).decision.reason, "Staying: could not check for faster routes, 3 tries in a row")
        XCTAssertEqual(log.switches, [Switch(nowSec: 360, from: .A, to: .B)])
        XCTAssertEqual(try pollAt(log, 6).decision.nextState.failedPolls, 0)
    }

    // it('current route not among the candidates: waits three polls, then takes the best fresh route')
    func testScriptedDrives_currentRouteNotAmongTheCandidatesWaitsThreePollsThenTakesTheBestFreshRoute() throws {
        let log = drive(DriveScript(
            polls: 6,
            eta: RerouteFx.fixed([.A: 2000, .B: 1900, .C: 1950]),
            tamper: { candidates, context in
                context.poll >= 1 ? candidates.filter { DriveWorld.nameOf($0) != .A } : candidates
            }
        ))
        XCTAssertEqual(slice(log.codes, 0, 4), ["saving-too-small", "route-lost-waiting", "route-lost-waiting", "route-lost"])
        XCTAssertEqual(try pollAt(log, 1).decision.reason, "Staying: current route is missing from the fresh routes, check 1 of 3")
        XCTAssertEqual(try pollAt(log, 3).decision.reason, "Switching: current route is no longer offered, turn in 2.5 miles")
        XCTAssertNil(try XCTUnwrap(pollAt(log, 3).decision.considered).savingSec)
        XCTAssertEqual(log.switches, [Switch(nowSec: 180, from: .A, to: .B)])
    }

    // it('current route not among the candidates: the route left a moment ago may be the one to take')
    func testScriptedDrives_currentRouteNotAmongTheCandidatesTheRouteLeftAMomentAgoMayBeTheOneToTake() throws {
        // On B since the switch at 60 s. Then the provider stops offering B and puts A first.
        let log = drive(DriveScript(
            polls: 9,
            eta: { name, context in
                switch name {
                case .A: return context.poll >= 2 ? 1700 : 2000
                case .B: return 1820
                case .C: return 1900
                default: return nil
                }
            },
            tamper: { candidates, context in
                context.poll >= 2 ? candidates.filter { DriveWorld.nameOf($0) != .B } : candidates
            }
        ))
        XCTAssertEqual(slice(log.codes, 0, 8), [
            "confirming",
            "faster-route",
            "route-lost-waiting",
            "route-lost-waiting",
            // Three polls without it, but the cooldown (until 360 s) still holds.
            "cooldown",
            "cooldown",
            "route-lost",
            "current-best",
        ])
        XCTAssertEqual(log.switches, [
            Switch(nowSec: 60, from: .A, to: .B),
            Switch(nowSec: 360, from: .B, to: .A),
        ])
        XCTAssertEqual(
            try pollAt(log, 4).decision.reason,
            "Staying: switched routes 3 minutes ago, and the current route is no longer offered"
        )
    }

    // it('forgives a position reported a little further on than where the routes were fetched from')
    func testScriptedDrives_forgivesAPositionReportedALittleFurtherOnThanWhereTheRoutesWereFetchedFrom() throws {
        let route = try XCTUnwrap(candidate(.A, at(0, 0), 2000))
        let fetchedFrom = at(3000, 0)
        func poll(_ positionAlongM: Double) throws -> RerouteDecision {
            Reroute.decideReroute(
                .initial,
                RerouteObservation(
                    nowSec: 0,
                    route: DrivenRoute(route),
                    positionAlongM: positionAlongM,
                    speedMps: 15,
                    candidates: [try XCTUnwrap(candidate(.A, fetchedFrom, 1700)), try XCTUnwrap(candidate(.B, fetchedFrom, 1800))]
                )
            )
        }
        XCTAssertEqual(try poll(3000).code, .currentBest)
        // 40 m on (a second or two of driving): still the same route.
        XCTAssertEqual(try poll(3040).code, .currentBest)
        // 300 m on, the answer is stale: nothing matches, and nothing is switched on one such poll.
        let stale = try poll(3300)
        XCTAssertEqual(stale.action, .stay)
        XCTAssertEqual(stale.code, .routeLostWaiting)
    }

    // it('current route missing for one poll only: the count starts again')
    func testScriptedDrives_currentRouteMissingForOnePollOnlyTheCountStartsAgain() {
        let log = drive(DriveScript(
            polls: 8,
            eta: RerouteFx.fixed([.A: 2000, .B: 1900]),
            tamper: { candidates, context in
                context.poll % 3 == 1 ? candidates.filter { DriveWorld.nameOf($0) != .A } : candidates
            }
        ))
        XCTAssertEqual(log.switches, [])
        XCTAssertEqual(log.codes, [
            "saving-too-small", "route-lost-waiting", "saving-too-small", "saving-too-small",
            "route-lost-waiting", "saving-too-small", "saving-too-small", "route-lost-waiting",
        ])
        XCTAssertEqual(log.polls.map { $0.decision.nextState.lostPolls }, [0, 1, 0, 0, 1, 0, 0, 1])
    }

    // it('current route no longer offered and the only other route turns off too soon: stays')
    func testScriptedDrives_currentRouteNoLongerOfferedAndTheOnlyOtherRouteTurnsOffTooSoonStays() {
        let lost = pollOnA(xM: 4700, etas: [.B: 1500], options: RerouteOptions(routeLostPolls: 1))
        XCTAssertEqual(lost.action, .stay)
        XCTAssertEqual(lost.code, .tooLate)
        XCTAssertEqual(
            lost.reason,
            "Staying: current route is no longer offered, but the other route turns off in 0.1 miles, too late to take safely"
        )
        // Inside the cooldown it waits as well.
        var cooledState = RerouteState.initial
        cooledState.lastSwitchAtSec = 0
        let cooling = pollOnA(xM: 1000, etas: [.B: 1500], nowSec: 100, state: cooledState, options: RerouteOptions(routeLostPolls: 1))
        XCTAssertEqual(cooling.action, .stay)
        XCTAssertEqual(cooling.code, .cooldown)
        let taken = pollOnA(xM: 1000, etas: [.B: 1500], options: RerouteOptions(routeLostPolls: 1))
        XCTAssertEqual(taken.action, .switchRoute)
        XCTAssertEqual(taken.code, .routeLost)
    }

    // it('off route: takes the best fresh route at once, cooldown or not')
    func testScriptedDrives_offRouteTakesTheBestFreshRouteAtOnceCooldownOrNot() throws {
        func offRoad(_ id: String, _ durationSec: Double) throws -> RouteCandidate {
            var c = try XCTUnwrap(candidate(.A, at(3000, 0), durationSec))
            c.id = id
            c.geometry = [at(3000, 200), at(3400, 200), at(20000, 0)]
            return c
        }
        var cooling = RerouteState.initial
        cooling.lastSwitchAtSec = 990
        let decision = Reroute.decideReroute(
            cooling,
            RerouteObservation(
                nowSec: 1000,
                route: DrivenRoute(try XCTUnwrap(candidate(.A, at(0, 0), 2000))),
                positionAlongM: 3000,
                speedMps: 10,
                candidates: [try offRoad("slow", 1900), try offRoad("fast", 1700)]
            )
        )
        XCTAssertEqual(decision.action, .switchRoute)
        XCTAssertEqual(decision.code, .offRoute)
        XCTAssertEqual(decision.toRouteId, "fast")
        XCTAssertEqual(decision.reason, "Switching: off the planned route, taking the fastest route from here")
        XCTAssertEqual(decision.nextState.lastSwitchAtSec, 1000)
        // The caller's own measurement (GPS) wins over where the fresh routes start.
        let measured = Reroute.decideReroute(
            .initial,
            RerouteObservation(
                nowSec: 0,
                route: DrivenRoute(try XCTUnwrap(candidate(.A, at(0, 0), 2000))),
                positionAlongM: 3000,
                speedMps: 10,
                candidates: [try XCTUnwrap(candidate(.A, at(3000, 0), 1700))],
                offRouteM: 80
            )
        )
        XCTAssertEqual(measured.code, .offRoute)
    }

    // MARK: - describe('missing data')

    // it('no typical (traffic) duration on the current route: stays')
    func testMissingData_noTypicalTrafficDurationOnTheCurrentRouteStays() {
        let decision = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1500], options: noConfirm,
            extra: [.A: { $0.typicalDurationSec = nil }]
        )
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .noTrafficData)
        XCTAssertEqual(decision.reason, "Staying: no traffic data for the current route")
    }

    // it('no typical duration on the alternative: it is passed over')
    func testMissingData_noTypicalDurationOnTheAlternativeItIsPassedOver() {
        let decision = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1500], options: noConfirm,
            extra: [.B: { $0.typicalDurationSec = nil }]
        )
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .noTrafficData)
        // Another alternative with full data is still considered.
        let other = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1500, .C: 1800], options: noConfirm,
            extra: [.B: { $0.typicalDurationSec = nil }]
        )
        XCTAssertEqual(other.action, .switchRoute)
        XCTAssertEqual(idName(other.toRouteId), "C")
    }

    // it('compares without typical durations only when told to')
    func testMissingData_comparesWithoutTypicalDurationsOnlyWhenToldTo() {
        let decision = pollOnA(
            xM: 1000,
            etas: [.A: 2000, .B: 1500],
            options: RerouteOptions(confirmPolls: 1, requireTypicalDuration: false),
            extra: [.A: { $0.typicalDurationSec = nil }, .B: { $0.typicalDurationSec = nil }]
        )
        XCTAssertEqual(decision.action, .switchRoute)
    }

    // it('no travel time at all: stays')
    func testMissingData_noTravelTimeAtAllStays() {
        let current = pollOnA(xM: 1000, etas: [.A: 2000, .B: 1500], options: noConfirm, extra: [.A: { $0.durationSec = .nan }])
        XCTAssertEqual(current.action, .stay)
        XCTAssertEqual(current.code, .noEta)
        let other = pollOnA(xM: 1000, etas: [.A: 2000, .B: 1500], options: noConfirm, extra: [.B: { $0.durationSec = .nan }])
        XCTAssertEqual(other.action, .stay)
        XCTAssertEqual(other.code, .noTrafficData)
    }

    // it('candidates without a line to drive are ignored')
    func testMissingData_candidatesWithoutALineToDriveAreIgnored() {
        let lonePoint = at(1000, 0)
        let decision = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1500],
            extra: [.A: { $0.geometry = [] }, .B: { $0.geometry = [lonePoint] }]
        )
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .noRoutes)
    }

    // MARK: - describe('minimum saving')

    // it('120 seconds is the floor, to the second')
    func testMinimumSaving_120SecondsIsTheFloorToTheSecond() {
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 2000, .B: 1880.5], options: noConfirm).code, .savingTooSmall)
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 2000, .B: 1880], options: noConfirm).action, .switchRoute)
        XCTAssertEqual(
            pollOnA(xM: 1000, etas: [.A: 2000, .B: 1960], options: noConfirm).reason,
            "Staying: faster route saves only 40 seconds"
        )
    }

    // it('a long leg: 2.5 minutes on 90 is under 5% and not worth it')
    func testMinimumSaving_aLongLeg25MinutesOn90IsUnder5PercentAndNotWorthIt() {
        let long = pollOnA(xM: 1000, etas: [.A: 5400, .B: 5250], options: noConfirm)
        XCTAssertEqual(long.action, .stay)
        XCTAssertEqual(long.code, .savingShareTooSmall)
        XCTAssertEqual(long.reason, "Staying: faster route saves only 2.5 minutes of the remaining 90 minutes")
        XCTAssertEqual(pollOnA(xM: 1000, etas: [.A: 5400, .B: 5130], options: noConfirm).action, .switchRoute)
    }

    // it('a tiny remaining trip: a third of the time saved is still only a minute')
    func testMinimumSaving_aTinyRemainingTripAThirdOfTheTimeSavedIsStillOnlyAMinute() {
        let tiny = pollOnA(xM: 17500, etas: [.A: 200, .E: 140], options: noConfirm)
        XCTAssertEqual(tiny.action, .stay)
        XCTAssertEqual(tiny.code, .savingTooSmall)
        XCTAssertEqual(tiny.reason, "Staying: faster route saves only 60 seconds")
        // And a real gain near the end is no use when the turn is 300 m away.
        let close = pollOnA(xM: 18200, etas: [.A: 400, .E: 250], options: noConfirm)
        XCTAssertEqual(close.action, .stay)
        XCTAssertEqual(close.code, .tooLate)
    }

    // MARK: - describe('too-late maneuver guard')

    // it('asks for 20 seconds of driving when that is more than 400 m')
    func testTooLateManeuverGuard_asksFor20SecondsOfDrivingWhenThatIsMoreThan400m() throws {
        let slow = pollOnA(xM: 4400, etas: [.A: 2000, .B: 1700], speedMps: 10, options: noConfirm)
        XCTAssertEqual(slow.action, .switchRoute)
        XCTAssertEqual(try XCTUnwrap(slow.considered).requiredLeadM, 400)
        let fast = pollOnA(xM: 4400, etas: [.A: 2000, .B: 1700], speedMps: 35, options: noConfirm)
        XCTAssertEqual(fast.action, .stay)
        XCTAssertEqual(fast.code, .tooLate)
        let considered = try XCTUnwrap(fast.considered)
        XCTAssertEqual(considered.requiredLeadM, 700)
        XCTAssertEqual(considered.turnInM, 600, accuracy: 0.5)
    }

    // it('freeway: the exit has to be 1200 m ahead')
    func testTooLateManeuverGuard_freewayTheExitHasToBe1200mAhead() throws {
        // B leaves the main road 800 m ahead, and the road up to there is freeway.
        let onFreeway = pollOnA(
            xM: 4200, etas: [.A: 2000, .B: 1700], options: noConfirm,
            extra: [.B: { $0.limitedAccessSpansM = [DistanceSpanM(0, 800)] }]
        )
        XCTAssertEqual(onFreeway.action, .stay)
        XCTAssertEqual(onFreeway.code, .tooLate)
        let freewayConsidered = try XCTUnwrap(onFreeway.considered)
        XCTAssertEqual(freewayConsidered.onFreeway, true)
        XCTAssertEqual(freewayConsidered.requiredLeadM, 1200)
        XCTAssertEqual(onFreeway.reason, "Staying: faster route turns off in 0.4 miles, too late to take safely")
        // The same turn from a street is fine.
        let onStreet = pollOnA(
            xM: 4200, etas: [.A: 2000, .B: 1700], options: noConfirm,
            extra: [.B: { $0.limitedAccessSpansM = [] }]
        )
        XCTAssertEqual(onStreet.action, .switchRoute)
        // Freeway that ends before the turn-off does not count.
        let leftIt = pollOnA(
            xM: 4200, etas: [.A: 2000, .B: 1700], options: noConfirm,
            extra: [.B: { $0.limitedAccessSpansM = [DistanceSpanM(0, 300)] }]
        )
        XCTAssertEqual(leftIt.action, .switchRoute)
        // With room to spare the exit is taken.
        let early = pollOnA(
            xM: 3700, etas: [.A: 2000, .B: 1700], options: noConfirm,
            extra: [.B: { $0.limitedAccessSpansM = [DistanceSpanM(0, 1300)] }]
        )
        XCTAssertEqual(early.action, .switchRoute)
        let earlyConsidered = try XCTUnwrap(early.considered)
        XCTAssertEqual(earlyConsidered.onFreeway, true)
        XCTAssertEqual(earlyConsidered.requiredLeadM, 1200)
    }

    // it('freeway: falls back on the current route when the alternative does not say what road it is')
    func testTooLateManeuverGuard_freewayFallsBackOnTheCurrentRouteWhenTheAlternativeDoesNotSayWhatRoadItIs() throws {
        let decision = pollOnA(
            xM: 4200,
            etas: [.A: 2000, .B: 1700],
            options: noConfirm,
            extra: [.A: { $0.limitedAccessSpansM = [DistanceSpanM(0, 15800)] }, .B: { $0.limitedAccessSpansM = nil }]
        )
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .tooLate)
        XCTAssertEqual(try XCTUnwrap(decision.considered).onFreeway, true)
    }

    // it('uses the first maneuver of its own when that comes before the lines part')
    func testTooLateManeuverGuard_usesTheFirstManeuverOfItsOwnWhenThatComesBeforeTheLinesPart() throws {
        // An exit lane that runs beside the main road: the lines only part 1000 m ahead, the exit is at 300 m.
        let here = at(4000, 0)
        let exitManeuver = Maneuver(atDistanceM: 300, kind: "off ramp right", location: at(4300, 0))
        func withExit(_ c: RouteCandidate) -> RouteCandidate {
            var copy = c
            copy.maneuvers = [c.maneuvers[0], exitManeuver] + Array(c.maneuvers.dropFirst())
            return copy
        }
        let driven = DrivenRoute(try XCTUnwrap(candidate(.A, at(0, 0), 2000)))
        let alternative = withExit(try XCTUnwrap(candidate(.B, here, 1700)))
        func poll(_ current: RouteCandidate) -> RerouteDecision {
            Reroute.decideReroute(
                .initial,
                RerouteObservation(nowSec: 0, route: driven, positionAlongM: 4000, speedMps: 5, candidates: [current, alternative]),
                options: noConfirm
            )
        }
        let refused = poll(try XCTUnwrap(candidate(.A, here, 2000)))
        XCTAssertEqual(refused.action, .stay)
        XCTAssertEqual(refused.code, .tooLate)
        let refusedConsidered = try XCTUnwrap(refused.considered)
        XCTAssertEqual(refusedConsidered.turnInM, 300)
        XCTAssertEqual(refusedConsidered.turnAt, at(4300, 0))
        // A maneuver the current route makes too is not the alternative's own.
        let shared = poll(withExit(try XCTUnwrap(candidate(.A, here, 2000))))
        XCTAssertEqual(shared.action, .switchRoute)
        XCTAssertEqual(try XCTUnwrap(shared.considered).turnInM, 1000, accuracy: 0.5)
    }

    // it('refuses an alternative that leaves the route right where the driver is')
    func testTooLateManeuverGuard_refusesAnAlternativeThatLeavesTheRouteRightWhereTheDriverIs() throws {
        let decision = pollOnA(xM: 5000, etas: [.A: 2000, .B: 1500], options: noConfirm)
        XCTAssertEqual(decision.action, .stay)
        XCTAssertEqual(decision.code, .tooLate)
        XCTAssertEqual(try XCTUnwrap(decision.considered).turnInM, 0)
        XCTAssertEqual(decision.reason, "Staying: faster route turns off in 0 feet, too late to take safely")
    }

    // MARK: - describe('signals never decide a switch on their own')

    // it('fewer signals with an equal or nearly equal ETA is not worth a change')
    func testSignalsNeverDecide_fewerSignalsWithAnEqualOrNearlyEqualEtaIsNotWorthAChange() {
        let equal = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 2000], options: noConfirm,
            extra: [.A: RerouteFx.signals(20), .B: RerouteFx.signals(2)]
        )
        XCTAssertEqual(equal.action, .stay)
        XCTAssertEqual(equal.code, .currentBest)
        let close = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1990], options: noConfirm,
            extra: [.A: RerouteFx.signals(20), .B: RerouteFx.signals(2)]
        )
        XCTAssertEqual(close.action, .stay)
        XCTAssertEqual(close.code, .savingTooSmall)
        let log = drive(DriveScript(
            polls: 14,
            eta: RerouteFx.fixed([.A: 2000, .B: 1990]),
            tamper: { candidates, _ in
                candidates.map { c in DriveWorld.patched(c, RerouteFx.signals(DriveWorld.nameOf(c) == .A ? 20 : 2)) }
            }
        ))
        XCTAssertEqual(log.switches, [])
    }

    // it('between alternatives that both save enough, the existing ranking picks: ETA ties go to fewer signals')
    func testSignalsNeverDecide_betweenAlternativesThatBothSaveEnoughTheExistingRankingPicksEtaTiesGoToFewerSignals() {
        let etas: KeyValuePairs<RouteName, Double> = [.A: 2000, .B: 1850, .C: 1870]
        let fewerOnC = pollOnA(
            xM: 1000, etas: etas, options: noConfirm,
            extra: [.B: RerouteFx.signals(20), .C: RerouteFx.signals(5)]
        )
        XCTAssertEqual(idName(fewerOnC.toRouteId), "C")
        // A partial count is unknown to the ranking, so the faster one is taken.
        let partial = pollOnA(
            xM: 1000, etas: etas, options: noConfirm,
            extra: [.B: RerouteFx.signals(20), .C: RerouteFx.signals(5, .partial)]
        )
        XCTAssertEqual(idName(partial.toRouteId), "B")
        // Outside the 30 s tie window signals have no say.
        let clear = pollOnA(
            xM: 1000, etas: [.A: 2000, .B: 1800, .C: 1870], options: noConfirm,
            extra: [.B: RerouteFx.signals(20), .C: RerouteFx.signals(5)]
        )
        XCTAssertEqual(idName(clear.toRouteId), "B")
    }

    // it('duplicate signals and partial coverage do not change a decision the ETA has made')
    func testSignalsNeverDecide_duplicateSignalsAndPartialCoverageDoNotChangeADecisionTheEtaHasMade() {
        let script = DriveScript(polls: 12, eta: RerouteFx.fixed([.A: 2000, .B: 1820, .C: 2100]))
        let plain = drive(script)
        // [action, code, reason] per poll.
        func outline(_ log: DriveLog) -> [[String]] {
            log.polls.map { [$0.decision.action.rawValue, $0.decision.code.rawValue, $0.decision.reason] }
        }
        let decorations: [(RouteName, DriveWorld.PollContext) -> Patch] = [
            // Every signal counted twice on the faster route.
            { name, _ in RerouteFx.signals(name == .B ? 48 : 24) },
            // Coverage comes and goes from poll to poll.
            { name, context in RerouteFx.signals(name == .B ? 30 : 3, context.poll % 2 == 0 ? .partial : .full) },
            { name, _ in name == .A ? RerouteFx.signals(0) : RerouteFx.noSignals },
            { _, context in RerouteFx.signals(context.poll, .partial) },
        ]
        for (index, decorate) in decorations.enumerated() {
            var decoratedScript = script
            decoratedScript.tamper = { candidates, context in
                candidates.map { c in DriveWorld.patched(c, decorate(DriveWorld.nameOf(c), context)) }
            }
            let decorated = drive(decoratedScript)
            XCTAssertEqual(outline(decorated), outline(plain), "decoration \(index)")
            XCTAssertEqual(decorated.switches, plain.switches, "decoration \(index)")
        }
    }

    // MARK: - describe('determinism')

    /// One poll of a drive with the route ids left out (they are new on every poll by design).
    private struct OutlineRow: Equatable {
        let nowSec: Double
        let on: DriveWorld.RouteName
        let action: RerouteAction
        let code: RerouteCode
        let reason: String
        let nextState: RerouteState
        let turnInM: Double?
    }

    private func determinismOutline(_ log: DriveLog) -> [OutlineRow] {
        log.polls.map { p in
            OutlineRow(
                nowSec: p.nowSec,
                on: p.on,
                action: p.decision.action,
                code: p.decision.code,
                reason: p.decision.reason,
                nextState: p.decision.nextState,
                turnInM: p.decision.considered?.turnInM
            )
        }
    }

    private var determinismScript: DriveScript {
        DriveScript(polls: 14, eta: { name, context in
            switch name {
            case .B: return 1820
            case .A: return context.poll >= 2 ? 1500 : 2000
            case .C: return 1900
            default: return nil
            }
        })
    }

    // it('the same drive gives the same decisions, reasons and states')
    func testDeterminism_theSameDriveGivesTheSameDecisionsReasonsAndStates() {
        XCTAssertEqual(determinismOutline(drive(determinismScript)), determinismOutline(drive(determinismScript)))
    }

    // it('the same call gives the same answer and leaves its inputs alone')
    func testDeterminism_theSameCallGivesTheSameAnswerAndLeavesItsInputsAlone() throws {
        // Swift values cannot be changed through a call, which is what the TS freeze checks;
        // the copies below are compared afterwards all the same.
        let here = at(1000, 0)
        let state = RerouteState(
            pending: RerouteState.Pending(geometry: try XCTUnwrap(candidate(.B, at(700, 0), 1800)).geometry, polls: 1),
            lastSwitchAtSec: nil,
            abandoned: [RerouteState.Abandoned(geometry: try XCTUnwrap(candidate(.C, at(0, 0), 1800)).geometry, atSec: -100)],
            failedPolls: 0,
            lostPolls: 0
        )
        let observation = RerouteObservation(
            nowSec: 60,
            route: DrivenRoute(try XCTUnwrap(candidate(.A, at(0, 0), 2000))),
            positionAlongM: 1000,
            speedMps: 12,
            candidates: [
                try XCTUnwrap(candidate(.A, here, 2000)),
                try XCTUnwrap(candidate(.B, here, 1800)),
                try XCTUnwrap(candidate(.C, here, 1900)),
            ]
        )
        let stateBefore = state
        let observationBefore = observation
        let first = Reroute.decideReroute(state, observation)
        let second = Reroute.decideReroute(state, observation)
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.action, .switchRoute)
        XCTAssertEqual(state, stateBefore)
        XCTAssertEqual(observation, observationBefore)
        // The order the candidates arrive in does not matter either.
        var reversedObservation = observation
        reversedObservation.candidates = observation.candidates.map { Array($0.reversed()) }
        let reversed = Reroute.decideReroute(state, reversedObservation)
        XCTAssertEqual(reversed, first)
    }

    // MARK: - describe('property: seeded random ETAs')

    private struct Run {
        let seed: Int
        let options: RerouteOptions
        let log: DriveWorld.DriveLog
    }

    /// Seeds 1 to 40, built once like the TS describe body.
    private static let runs: [Run] = (1...40).map { (seed: Int) -> Run in
        let nextRandom = RerouteFx.seeded(UInt32(seed))
        let options = RerouteOptions(confirmPolls: seed % 2 == 0 ? 1 : 2, noReturnSec: seed % 3 == 0 ? 0 : 600)
        // Math.round of a positive number: .rounded() rounds its halves up too.
        let script = DriveWorld.DriveScript(polls: 62, eta: { _, _ in (1400 + nextRandom() * 1200).rounded() }, options: options)
        return Run(seed: seed, options: options, log: DriveWorld.drive(script))
    }

    // it('switches never come closer together than the cooldown')
    func testPropertySeededRandomEtas_switchesNeverComeCloserTogetherThanTheCooldown() {
        var switches = 0
        for run in Self.runs {
            switches += run.log.switches.count
            for i in run.log.switches.indices where i > 0 {
                XCTAssertGreaterThanOrEqual(
                    run.log.switches[i].nowSec - run.log.switches[i - 1].nowSec,
                    RerouteOptions.default.cooldownSec,
                    "seed \(run.seed)"
                )
            }
        }
        // The check means something only if the random drives do switch.
        XCTAssertGreaterThan(switches, 40)
    }

    // it('every switch saved enough, with room to make the turn, and says so in one short sentence')
    func testPropertySeededRandomEtas_everySwitchSavedEnoughWithRoomToMakeTheTurnAndSaysSoInOneShortSentence() throws {
        for run in Self.runs {
            for p in run.log.polls {
                let decision = p.decision
                XCTAssertTrue(RerouteFx.hasReasonShape(decision.reason), "seed \(run.seed): \(decision.reason)")
                // JS string length counts UTF-16 code units.
                XCTAssertLessThan(decision.reason.utf16.count, 120)
                XCTAssertEqual(decision.toRouteId == nil, decision.action == .stay)
                if decision.action != .switchRoute { continue }
                XCTAssertEqual(decision.code, .fasterRoute)
                let considered = try XCTUnwrap(decision.considered, "seed \(run.seed)")
                let savingSec = try XCTUnwrap(considered.savingSec, "seed \(run.seed)")
                XCTAssertGreaterThanOrEqual(savingSec, RerouteOptions.default.minSavingSec)
                XCTAssertGreaterThanOrEqual(considered.turnInM, considered.requiredLeadM)
                XCTAssertNil(decision.nextState.pending)
            }
        }
    }

    // it('with the defaults, a route left is not taken again within ten minutes for less than twice the minimum')
    func testPropertySeededRandomEtas_withTheDefaultsARouteLeftIsNotTakenAgainWithinTenMinutesForLessThanTwiceTheMinimum() throws {
        for run in Self.runs {
            if run.options.noReturnSec == 0 { continue }
            let switches = run.log.switches
            for (i, s) in switches.enumerated() {
                let back = switches[0..<i].first { earlier in earlier.from == s.to && s.nowSec - earlier.nowSec < 600 }
                if back == nil { continue }
                let poll = try XCTUnwrap(run.log.polls.first { $0.nowSec == s.nowSec }, "seed \(run.seed)")
                let considered = try XCTUnwrap(poll.decision.considered, "seed \(run.seed)")
                XCTAssertGreaterThanOrEqual(try XCTUnwrap(considered.savingSec), 240, "seed \(run.seed)")
            }
        }
    }
}
