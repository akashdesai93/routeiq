import XCTest
import RouteIQCore

// Mirrors tests/live.test.ts: the live drive as a state machine, on the made-up
// road network of DriveWorld.swift with a clock counted by hand. No network, no
// device, no timers: events in, effects out. toBeCloseTo(v, d) is accuracy
// 0.5 * 10^-d; toMatchObject is one assertion per listed field; toBe on an
// object (the same route, the same state) is value equality, the closest Swift
// has for structs.

private let T0 = 1_000_000.0
private func at(_ xM: Double, _ yM: Double) -> LngLat { DriveWorld.at(xM, yM) }
private let DESTINATION = at(20_000, 0)
private typealias RouteName = DriveWorld.RouteName

/// What the shell answered for the current path: the TS `baseline` argument, where
/// `undefined` (not asked) and `null` (asked, and failed) are told apart.
private enum Baseline {
    case notAsked
    case answered([RouteCandidate]?)
}

/// One live drive under test: feeds events, keeps the state, and remembers every effect with its time.
private final class Session {
    private(set) var state = LiveState.idle
    private(set) var effects: [(atSec: Double, effect: LiveEffect)] = []
    private(set) var nowSec = 0.0
    let options: LiveOptions

    init(_ options: LiveOptions = .default) {
        self.options = options
    }

    @discardableResult
    func send(_ event: LiveEvent) -> [LiveEffect] {
        let step = Live.liveStep(state, event, options: options)
        state = step.state
        for effect in step.effects { effects.append((nowSec, effect)) }
        return step.effects
    }

    func nowMs() -> Double { T0 + nowSec * 1000 }

    func setTime(_ sec: Double) { nowSec = sec }

    @discardableResult
    func start(_ route: RouteCandidate? = nil) -> [LiveEffect] {
        send(.start(nowMs: nowMs(), destination: DESTINATION, route: route))
    }

    @discardableResult
    func fix(_ xM: Double, _ yM: Double = 0, accuracyM: Double = 8, speedMps: Double? = nil, headingDeg: Double? = nil) -> [LiveEffect] {
        let p = at(xM, yM)
        return send(.fix(nowMs: nowMs(), fix: PositionFix(lng: p.lng, lat: p.lat, accuracyM: accuracyM, speedMps: speedMps, headingDeg: headingDeg, timeMs: nowMs())))
    }

    @discardableResult
    func tick() -> [LiveEffect] { send(.tick(nowMs: nowMs())) }

    @discardableResult
    func answer(_ routes: [RouteCandidate]?, _ message: String? = nil, _ baseline: Baseline = .notAsked) -> [LiveEffect] {
        let asked: [RouteCandidate]?
        let requests: Int?
        switch baseline {
        case .notAsked:
            asked = nil
            requests = nil
        case let .answered(b):
            asked = b
            requests = 2
        }
        // The TS `state.request!.id` throws when no request is out; here that fails the test without crashing the run.
        guard let id = state.request?.id else {
            XCTFail("no request is out to answer")
            return []
        }
        return send(.routes(nowMs: nowMs(), requestId: id, routes: routes, message: message, baseline: asked, requests: requests))
    }

    func requests() -> [(atSec: Double, effect: LiveRouteRequest)] {
        effects.compactMap { e in
            if case let .requestRoutes(r) = e.effect { return (e.atSec, r) }
            return nil
        }
    }

    func spoken() -> [String] {
        effects.compactMap { e in
            if case let .speak(line) = e.effect { return line.text }
            return nil
        }
    }

    func of(_ type: String) -> [(atSec: Double, effect: LiveEffect)] { effects.filter { $0.effect.type == type } }

    func view() -> LiveView { Live.liveView(state, nowMs(), options: options) }
}

private func candidate(_ name: RouteName, _ from: LngLat, _ eta: Double, _ extra: DriveWorld.Patch? = nil) -> RouteCandidate? {
    DriveWorld.candidate(name, from, eta, extra)
}

private func nameOf(_ route: RouteCandidate) -> RouteName { DriveWorld.nameOf(route) }

/// `array[i]`, failing the test instead of crashing the run when there is no such element
/// (where the TS would throw a TypeError on `undefined`).
private func item<T>(_ array: [T], _ i: Int, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    try XCTUnwrap(array.indices.contains(i) ? array[i] : nil, "no element \(i) among \(array.count)", file: file, line: line)
}

private func types(_ effects: [LiveEffect]) -> [String] { effects.map(\.type) }

/// The routes a query from `xM` meters along the main road returns: A, and others with the given times.
private func routesAt(_ xM: Double, _ etas: KeyValuePairs<RouteName, Double>) -> [RouteCandidate] {
    etas.compactMap { name, eta in candidate(name, at(xM, 0), eta) }
}

/// Starts a drive on the main road: Start, a first fix at the origin, the first route.
/// Leaves the session driving at time 0 with one request used.
private func driving(_ options: LiveOptions = .default, _ first: RouteCandidate? = nil) -> Session {
    let s = Session(options)
    s.start()
    s.fix(0)
    s.answer([first ?? candidate(.A, at(0, 0), 1300)!])
    return s
}

/// Drives east along the main road at 15 m/s, a fix every second, from the present time
/// to `untilSec`. Every check that goes out is answered at once by `answer` (the default:
/// the main road alone, still the fastest).
private func cruise(
    _ s: Session,
    _ untilSec: Double,
    _ answer: (Double) -> [RouteCandidate]? = { xM in routesAt(xM, [.A: 1300]) },
    _ speedMps: Double = 15
) {
    for t in stride(from: s.nowSec + 1, through: untilSec, by: 1) {
        s.setTime(t)
        let xM = speedMps * t
        s.fix(xM)
        s.tick()
        if s.state.request != nil { s.answer(answer(xM)) }
    }
}

final class LiveTests: XCTestCase {
    // MARK: - describe('starting')

    // it('has the documented defaults in one place')
    func testStarting_hasTheDocumentedDefaultsInOnePlace() throws {
        let d = LiveOptions.default
        XCTAssertEqual(d.pollIntervalSec, 60)
        XCTAssertEqual(d.minRequestGapSec, 10)
        XCTAssertEqual(d.stationaryPauseSec, 120)
        XCTAssertEqual(d.maxRequests, 60)
        XCTAssertEqual(d.switchBannerSec, 8)
        XCTAssertEqual(d.requestTimeoutSec, 30)
    }

    // it('Start watches the position, holds the screen awake and speaks at once (the tap primes the voice)')
    func testStarting_startWatchesThePositionHoldsTheScreenAwakeAndSpeaksAtOnce() throws {
        let s = Session()
        let effects = s.start()
        XCTAssertEqual(types(effects), ["set-muted", "prime-speech", "watch-position", "acquire-wake-lock"])
        XCTAssertEqual(try item(effects, 1), .primeSpeech(text: "RouteIQ started"))
        XCTAssertEqual(s.state.status, .locating)
        XCTAssertEqual(s.view().statusLine, "Finding your position…")
        // A second tap while it runs does nothing.
        XCTAssertEqual(s.start(), [])
    }

    // it('waits for a good fix, then plans a route from it and starts on the best one')
    func testStarting_waitsForAGoodFixThenPlansARouteFromItAndStartsOnTheBestOne() throws {
        let s = Session()
        s.start()
        s.fix(0, 0, accuracyM: 120)
        XCTAssertEqual(s.state.status, .locating)
        XCTAssertEqual(s.view().warnings, ["Waiting for a better position fix (within 50 m)."])
        XCTAssertEqual(s.requests().count, 0)

        s.setTime(2)
        s.fix(3, 4)
        XCTAssertEqual(s.state.status, .planning)
        let asked = try XCTUnwrap(s.requests().first).effect
        XCTAssertEqual(asked.purpose, .plan)
        XCTAssertEqual(asked.origin, at(3, 4))
        XCTAssertNil(asked.headingDeg)
        XCTAssertEqual(s.state.requestsUsed, 1)
        XCTAssertEqual(s.view().warnings, [])

        // The faster of two is taken, whatever order they come in.
        s.setTime(3)
        let effects = s.answer([candidate(.C, at(0, 0), 1400)!, candidate(.A, at(0, 0), 1300)!])
        XCTAssertEqual(s.state.status, .driving)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        XCTAssertEqual(try item(effects, 0).type, "follow-route")
        XCTAssertEqual(try XCTUnwrap(s.state.tracking).alongRouteM, 3, accuracy: 0.5)
        let view = s.view()
        XCTAssertEqual(try XCTUnwrap(view.remainingSec), 1300, accuracy: 0.5)
        XCTAssertEqual(view.checkedAgoSec, 0)
        XCTAssertEqual(view.statusLine, "Watching for a faster route.")
    }

    // it('a device moving at the first fix sends its heading with the first request')
    func testStarting_aDeviceMovingAtTheFirstFixSendsItsHeadingWithTheFirstRequest() throws {
        let s = Session()
        s.start()
        s.fix(0, 0, speedMps: 12, headingDeg: 91)
        XCTAssertEqual(try item(s.requests(), 0).effect.headingDeg, 91)
    }

    // it('says why when no route can be planned, and lets go of the device')
    func testStarting_saysWhyWhenNoRouteCanBePlannedAndLetsGoOfTheDevice() throws {
        let s = Session()
        s.start()
        s.fix(0)
        let effects = s.answer(nil, "Could not reach Mapbox.")
        XCTAssertEqual(s.state.status, .failed)
        XCTAssertEqual(s.state.message, "Could not find a route from here. Could not reach Mapbox.")
        XCTAssertEqual(types(effects), ["cancel-request", "stop-watching", "release-wake-lock"])
        // An answer nobody asked for changes nothing.
        let before = s.state
        s.send(.routes(nowMs: s.nowMs(), requestId: 99, routes: []))
        XCTAssertEqual(s.state, before)
    }

    // MARK: - describe('the route picked on the plan screen (#66)')

    /// B (a side street here: it leaves the main road at 5 km), as the plan screen's probe found it.
    private func sideStreet() -> RouteCandidate { candidate(.B, at(0, 0), 1250, { $0.source = .probe })! }
    /// What the provider offers from the main road by itself: never the side street.
    private func offered(_ xM: Double, _ a: Double = 1300) -> [RouteCandidate] { routesAt(xM, [.A: a, .C: 1320]) }

    /// Drives B's first 5 km (the stretch it shares with A) at 15 m/s, answering each check
    /// with `answer`: the provider's own routes, and what came back for the current path.
    private func cruiseOnB(_ s: Session, _ untilSec: Double, _ answer: (Double) -> (routes: [RouteCandidate], baseline: Baseline)) {
        for t in stride(from: s.nowSec + 1, through: untilSec, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
            if s.state.request != nil {
                let (routes, baseline) = answer(15 * t)
                s.answer(routes, nil, baseline)
            }
        }
    }

    // it('Start drives the picked side-street route at once: no request, and the first check a poll interval later')
    func testThePickedRoute_startDrivesThePickedSideStreetRouteAtOnce() throws {
        let s = Session()
        let picked = sideStreet()
        s.start(picked)
        let effects = s.fix(0)
        XCTAssertEqual(s.state.status, .driving)
        XCTAssertEqual(s.state.route, picked)
        XCTAssertNil(s.state.picked)
        XCTAssertEqual(try item(effects, 0), .followRoute(geometry: picked.geometry))
        XCTAssertEqual(s.requests().count, 0)
        XCTAssertEqual(s.state.requestsUsed, 0)
        let view = s.view()
        XCTAssertEqual(try XCTUnwrap(view.remainingSec), 1250, accuracy: 0.5)
        XCTAssertEqual(view.checkedAgoSec, 0)
        cruiseOnB(s, 59) { xM in (self.offered(xM), .notAsked) }
        XCTAssertEqual(s.requests().count, 0)
        cruiseOnB(s, 60) { xM in (self.offered(xM), .notAsked) }
        let requests = s.requests()
        XCTAssertEqual(requests.map(\.atSec), [60])
        XCTAssertEqual(requests.map(\.effect.purpose), [.poll])
        XCTAssertEqual(requests.map(\.effect.baseline), [true])
    }

    // it('the answer of the plan is the last check: "checked N s ago" counts from when the answer of the plan came (#71)')
    func testThePickedRoute_theAnswerOfThePlanIsTheLastCheckCheckedNSAgoCountsFromWhenTheAnswerOfThePlanCame() throws {
        let s = Session()
        // The trip was planned 40 s before the Start tap.
        s.send(.start(nowMs: s.nowMs(), destination: DESTINATION, route: sideStreet(), routeFetchedAtMs: s.nowMs() - 40_000))
        s.fix(0)
        XCTAssertEqual(s.state.status, .driving)
        XCTAssertEqual(s.view().checkedAgoSec, 40)
        s.setTime(5)
        XCTAssertEqual(s.view().checkedAgoSec, 45)
        // The first check comes a poll interval after the plan, not after the Start tap.
        cruiseOnB(s, 19) { xM in (self.offered(xM), .notAsked) }
        XCTAssertEqual(s.requests().count, 0)
        cruiseOnB(s, 20) { xM in (self.offered(xM), .notAsked) }
        XCTAssertEqual(s.requests().map(\.atSec), [20])
        XCTAssertEqual(s.requests().map(\.effect.purpose), [.poll])
        XCTAssertEqual(s.view().checkedAgoSec, 0)
    }

    // it('a plan older than the poll interval is checked at once, and a check alone never switches')
    func testThePickedRoute_aPlanOlderThanThePollIntervalIsCheckedAtOnceAndACheckAloneNeverSwitches() throws {
        let s = Session()
        s.send(.start(nowMs: s.nowMs(), destination: DESTINATION, route: sideStreet(), routeFetchedAtMs: s.nowMs() - 600_000))
        s.fix(0)
        let view = s.view()
        XCTAssertEqual(view.checkedAgoSec, 600)
        XCTAssertTrue(view.checking)
        // Asked from the first fix on the route.
        XCTAssertEqual(s.requests().map(\.atSec), [0])
        XCTAssertEqual(s.requests().map(\.effect.purpose), [.poll])
        s.setTime(1)
        s.fix(15)
        // Even a much faster route is only a first sighting: confirmation needs the next check too.
        s.answer(offered(15, 800), nil, .answered([candidate(.B, at(15, 0), 1250, { $0.source = .probe })!]))
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.confirming))
    }

    // it('without the time of the plan, or with one from the future, the Start tap counts as the last check, as before')
    func testThePickedRoute_withoutTheTimeOfThePlanOrWithOneFromTheFutureTheStartTapCountsAsTheLastCheck() throws {
        // Swift nil stands for both the TS undefined and null.
        let times: [Double?] = [nil, .nan, 1e15]
        for routeFetchedAtMs in times {
            let label = String(describing: routeFetchedAtMs)
            let s = Session()
            s.send(.start(nowMs: s.nowMs(), destination: DESTINATION, route: sideStreet(), routeFetchedAtMs: routeFetchedAtMs))
            s.fix(0)
            XCTAssertEqual(s.view().checkedAgoSec, 0, label)
            // And the checks keep their minute: a time from the future must not hold them back.
            cruiseOnB(s, 60) { xM in (self.offered(xM), .notAsked) }
            XCTAssertEqual(s.requests().map(\.atSec), [60], label)
        }
        // A drive that asks for its own route (the fix was not on the pick) counts its own answer.
        let s = Session()
        s.send(.start(nowMs: s.nowMs(), destination: DESTINATION, route: sideStreet(), routeFetchedAtMs: s.nowMs() - 40_000))
        s.fix(2000, 600)
        s.setTime(3)
        s.answer([candidate(.A, at(0, 0), 1300)!])
        XCTAssertEqual(s.view().checkedAgoSec, 0)
    }

    // it('a slower route picked on purpose is driven too, not the fastest')
    func testThePickedRoute_aSlowerRoutePickedOnPurposeIsDrivenTooNotTheFastest() throws {
        let s = Session()
        let slower = candidate(.C, at(0, 0), 1400)!
        s.start(slower)
        s.fix(0)
        XCTAssertEqual(s.state.route, slower)
        XCTAssertEqual(s.requests().count, 0)
    }

    // it('a picked route with no line to drive is ignored: the drive plans its own')
    func testThePickedRoute_aPickedRouteWithNoLineToDriveIsIgnored() throws {
        let s = Session()
        s.start(DriveWorld.patched(sideStreet()) { $0.geometry = [at(0, 0)] })
        XCTAssertNil(s.state.picked)
        s.fix(0)
        XCTAssertEqual(try item(s.requests(), 0).effect.purpose, .plan)
    }

    // it('a first fix away from the picked route asks for a route from there, as without a pick')
    func testThePickedRoute_aFirstFixAwayFromThePickedRouteAsksForARouteFromThere() throws {
        let s = Session()
        s.start(sideStreet())
        s.fix(2000, 600)
        XCTAssertEqual(s.state.status, .planning)
        XCTAssertEqual(try item(s.requests(), 0).effect.purpose, .plan)
        XCTAssertEqual(try item(s.requests(), 0).effect.origin, at(2000, 600))
        s.answer([candidate(.A, at(0, 0), 1300)!])
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        XCTAssertNil(s.state.picked)
    }

    // it("checks that offer only the provider's own routes do not lose the side street")
    func testThePickedRoute_checksThatOfferOnlyTheProvidersOwnRoutesDoNotLoseTheSideStreet() throws {
        let s = Session()
        let picked = sideStreet()
        s.start(picked)
        s.fix(0)
        // Five checks: A and C only, and the current path's own time could not be had
        // (not asked or failed: null; or answered with another road).
        var n = 0
        cruiseOnB(s, 320) { xM in
            n += 1
            return (self.offered(xM), .answered(n % 2 == 0 ? nil : self.offered(xM)))
        }
        XCTAssertEqual(s.requests().count, 5)
        XCTAssertEqual(s.state.route, picked)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.spoken(), [])
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.routeUnconfirmed))
        // Routes came back, but not the side street's own time: the saving is unknown, never guessed (#175).
        XCTAssertEqual(s.state.lastDecision?.routes, 2)
        XCTAssertNil(s.state.lastDecision?.savingSec)
        XCTAssertEqual(s.state.engine.lostPolls, 0)
        XCTAssertFalse(s.view().offRoute)
    }

    // it("with the side street's own time from the via request, it is compared like for like, and kept while it is faster")
    func testThePickedRoute_withTheSideStreetsOwnTimeItIsComparedLikeForLikeAndKeptWhileFaster() throws {
        let s = Session()
        let picked = sideStreet()
        s.start(picked)
        s.fix(0)
        cruiseOnB(s, 320) { xM in
            (self.offered(xM), .answered([candidate(.B, at(xM, 0), 1250 - xM / 15, { $0.source = .probe })!]))
        }
        XCTAssertEqual(s.requests().count, 5)
        XCTAssertEqual(s.state.route, picked)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertNotEqual(try XCTUnwrap(s.state.lastDecision).code, .reroute(.routeUnconfirmed))
        // The side street's fresh time, from the last check (at 300 s, 4.5 km in), is the one shown.
        XCTAssertEqual(try XCTUnwrap(s.state.eta).durationSec, 950, accuracy: 0.5)
    }

    // it('leaves the side street only for a route that saves enough, confirmed, under the usual rules')
    func testThePickedRoute_leavesTheSideStreetOnlyForARouteThatSavesEnoughConfirmed() throws {
        let s = Session()
        s.start(sideStreet())
        s.fix(0)
        let own = { (xM: Double) in [candidate(.B, at(xM, 0), 1250, { $0.source = .probe })!] }
        // The main road becomes 100 s faster than the side street: under the two-minute minimum. Stay.
        cruiseOnB(s, 130) { xM in (self.offered(xM, 1150), .answered(own(xM))) }
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.savingTooSmall))
        // Then five minutes faster: one check to see it, a second to confirm it, then the switch.
        cruiseOnB(s, 190) { xM in (self.offered(xM, 950), .answered(own(xM))) }
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.confirming))
        cruiseOnB(s, 250) { xM in (self.offered(xM, 950), .answered(own(xM))) }
        XCTAssertEqual(s.state.switches.count, 1)
        XCTAssertEqual(try item(s.state.switches, 0).code, .fasterRoute)
        // The switch keeps the saving it claimed, for the drive log (#107): 5 minutes, less the drive since.
        XCTAssertGreaterThan(try XCTUnwrap(try item(s.state.switches, 0).savingSec), 120)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
    }

    // MARK: - describe('position problems')

    // it('permission denied ends the drive with words that say what to do')
    func testPositionProblems_permissionDeniedEndsTheDriveWithWordsThatSayWhatToDo() throws {
        let s = Session()
        s.start()
        let effects = s.send(.positionError(nowMs: s.nowMs(), kind: .denied))
        XCTAssertEqual(s.state.status, .failed)
        XCTAssertEqual(s.state.message, Live.positionErrorMessages[.denied])
        XCTAssertTrue(try XCTUnwrap(s.state.message).contains("Location permission was denied"))
        XCTAssertTrue(try XCTUnwrap(s.state.message).contains("browser settings"))
        XCTAssertEqual(types(effects), ["cancel-request", "stop-watching", "release-wake-lock"])
        XCTAssertEqual(s.view().statusLine, Live.positionErrorMessages[.denied])
    }

    // it('an unavailable position and a timeout are passing notes: the drive keeps trying')
    func testPositionProblems_anUnavailablePositionAndATimeoutArePassingNotes() throws {
        for (kind, words) in [(PositionErrorKind.unavailable, "not available right now. Still trying"), (.timeout, "No position fix yet. Still trying")] {
            let s = Session()
            s.start()
            XCTAssertEqual(s.send(.positionError(nowMs: s.nowMs(), kind: kind)), [])
            XCTAssertEqual(s.state.status, .locating)
            XCTAssertTrue(try item(s.view().warnings, 0).contains(words))
            // The next good fix clears the note and the drive goes on.
            s.fix(0)
            XCTAssertEqual(s.state.status, .planning)
            XCTAssertEqual(s.view().warnings, [])
        }
        // The same while driving: a note, nothing more.
        let d = driving()
        d.send(.positionError(nowMs: d.nowMs(), kind: .timeout))
        XCTAssertEqual(d.state.status, .driving)
        XCTAssertEqual(d.view().warnings, [try XCTUnwrap(Live.positionErrorMessages[.timeout])])
    }

    // it('a page that cannot locate at all says so')
    func testPositionProblems_aPageThatCannotLocateAtAllSaysSo() throws {
        for kind in [PositionErrorKind.insecure, .unsupported] {
            let s = Session()
            s.start()
            s.send(.positionError(nowMs: s.nowMs(), kind: kind))
            XCTAssertEqual(s.state.status, .failed)
            XCTAssertEqual(s.state.message, Live.positionErrorMessages[kind])
        }
        XCTAssertTrue(try XCTUnwrap(Live.positionErrorMessages[.insecure]).contains("HTTPS or localhost"))
    }

    // MARK: - describe('poll cadence')

    // it('checks every 60 seconds, from the point on the route with the heading of travel')
    func testPollCadence_checksEvery60SecondsFromThePointOnTheRouteWithTheHeadingOfTravel() throws {
        let s = driving()
        cruise(s, 400)
        let polls = Array(s.requests().dropFirst())
        XCTAssertEqual(polls.map(\.atSec), [60, 120, 180, 240, 300, 360])
        XCTAssertTrue(polls.allSatisfy { $0.effect.purpose == .poll })
        // Asked from the car's place on the road (east of the start), heading east.
        XCTAssertEqual(try item(polls, 0).effect.origin.lng, at(900, 0).lng, accuracy: 0.5e-5)
        XCTAssertEqual(try XCTUnwrap(item(polls, 0).effect.headingDeg), 90, accuracy: 0.5)
        XCTAssertEqual(s.state.requestsUsed, 7)
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.noAlternative))
        XCTAssertEqual(s.view().statusLine, "Staying: no other route available right now")
        XCTAssertEqual(s.view().checkedAgoSec, 40)
    }

    // it('never faster than every 10 seconds, whatever the setting')
    func testPollCadence_neverFasterThanEvery10SecondsWhateverTheSetting() throws {
        let s = driving(LiveOptions(pollIntervalSec: 2))
        cruise(s, 100)
        XCTAssertEqual(s.requests().map(\.atSec), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
        XCTAssertEqual(Live.livePollGate(s.state, s.nowMs() + 9_000, options: LiveOptions(pollIntervalSec: 2)), .requestGap)
    }

    // it('waits for the answer of one check before sending another')
    func testPollCadence_waitsForTheAnswerOfOneCheckBeforeSendingAnother() throws {
        // A long request time limit, so the checks of seconds 120 and 180 fall due while it is out
        // (past the limit: see "a request that never answers").
        let s = driving(LiveOptions(requestTimeoutSec: 300))
        for t in stride(from: 1.0, through: 200, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
        }
        // The check of second 60 was not answered: no other was sent.
        XCTAssertEqual(s.requests().map(\.atSec), [0, 60])
        XCTAssertEqual(Live.livePollGate(s.state, s.nowMs()), .inFlight)
        XCTAssertTrue(s.view().checking)
    }

    // it('pauses while standing still for more than two minutes, and checks again at once when moving')
    func testPollCadence_pausesWhileStandingStillForMoreThanTwoMinutesAndChecksAgainWhenMoving() throws {
        let s = driving()
        cruise(s, 30)
        // Stopped at 450 m from second 31 on.
        for t in 31...400 {
            s.setTime(Double(t))
            s.fix(450 + Double(t % 2))
            s.tick()
            if s.state.request != nil { s.answer(routesAt(450, [.A: 1300])) }
        }
        // Checks went on for the first two minutes of the stop, then stopped.
        let duringStop = s.requests().map(\.atSec).filter { $0 > 30 }
        XCTAssertEqual(duringStop, [60, 120])
        XCTAssertEqual(Live.livePollGate(s.state, s.nowMs()), .stationary)
        XCTAssertEqual(s.view().statusLine, "Standing still: checks are paused until you move.")
        // Off again: the first check goes out as soon as the car is seen moving.
        for t in 401...420 {
            s.setTime(Double(t))
            s.fix(450 + 15 * Double(t - 400))
            s.tick()
            if s.state.request != nil { s.answer(routesAt(450 + 15 * Double(t - 400), [.A: 1300])) }
        }
        let after = s.requests().map(\.atSec).filter { $0 > 400 }
        XCTAssertEqual(after.count, 1)
        XCTAssertLessThanOrEqual(try XCTUnwrap(after.first), 405)
        // Standing still the heading is not sent: it could point anywhere.
        XCTAssertNil(try XCTUnwrap(s.requests().first { $0.atSec == 120 }).effect.headingDeg)
    }

    // it('does not check from a stale position (a tunnel), and catches up when fixes return')
    func testPollCadence_doesNotCheckFromAStalePositionAndCatchesUpWhenFixesReturn() throws {
        let s = driving()
        cruise(s, 45)
        // No fixes from second 46 to 99; the timer keeps going.
        for t in stride(from: 46.0, through: 99, by: 1) {
            s.setTime(t)
            s.tick()
        }
        XCTAssertEqual(s.requests().map(\.atSec), [0])
        XCTAssertEqual(Live.livePollGate(s.state, s.nowMs()), .noFix)
        XCTAssertEqual(s.view().statusLine, "Waiting for a position fix…")
        s.setTime(100)
        s.fix(1500)
        XCTAssertEqual(s.requests().map(\.atSec), [0, 100])
        XCTAssertEqual(try XCTUnwrap(s.state.tracking).alongRouteM, 1500, accuracy: 0.5)
    }

    // it('stops at the request budget and says so')
    func testPollCadence_stopsAtTheRequestBudgetAndSaysSo() throws {
        let s = driving(LiveOptions(maxRequests: 3))
        cruise(s, 600)
        XCTAssertEqual(s.requests().map(\.atSec), [0, 60, 120])
        XCTAssertEqual(s.state.requestsUsed, 3)
        XCTAssertEqual(Live.livePollGate(s.state, s.nowMs(), options: LiveOptions(maxRequests: 3)), .budgetSpent)
        let view = s.view()
        XCTAssertEqual(view.statusLine, "Request budget used up (3): driving on without checking for faster routes.")
        XCTAssertEqual(view.requestsUsed, 3)
        XCTAssertEqual(view.maxRequests, 3)
    }

    // MARK: - describe('a request that never answers (#29)')

    /// Drives at 15 m/s from now to `untilSec` with a fix and a tick every second, answering nothing.
    private func silent(_ s: Session, _ untilSec: Double) {
        for t in stride(from: s.nowSec + 1, through: untilSec, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
        }
    }

    // it('a check that never answers is given up after requestTimeoutSec, and the checks after it still go out')
    func testARequestThatNeverAnswers_aCheckThatNeverAnswersIsGivenUpAfterRequestTimeoutSecAndTheChecksAfterItStillGoOut() throws {
        let s = driving()
        cruise(s, 59)
        s.setTime(60)
        s.fix(900)
        s.tick()
        XCTAssertEqual(s.state.request?.purpose, .poll) // the fetch now hangs
        let hung = try XCTUnwrap(s.state.request).id
        let before = s.requests().count
        // The repro from #29: 15 minutes of driving with that check never answered.
        for t in stride(from: 61.0, through: 960, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
            if let request = s.state.request, request.id != hung { s.answer(routesAt(15 * t, [.A: 1300])) }
        }
        XCTAssertGreaterThan(s.requests().count - before, 0)
        // Cancelled once, 30 s after it was sent, and the next check came at the usual minute.
        XCTAssertEqual(s.of("cancel-request").map(\.atSec), [90])
        XCTAssertEqual(Array(s.requests().map(\.atSec).prefix(4)), [0, 60, 120, 180])
    }

    // it('it counts as a failed check: the engine counts it, says why, and nothing else changes')
    func testARequestThatNeverAnswers_itCountsAsAFailedCheckTheEngineCountsItSaysWhyAndNothingElseChanges() throws {
        let s = driving()
        cruise(s, 59)
        s.setTime(60)
        s.fix(900)
        s.tick()
        let before = s.state
        let hung = try XCTUnwrap(s.state.request).id
        silent(s, 89)
        XCTAssertNotNil(s.state.request)
        XCTAssertTrue(s.view().checking)
        s.setTime(90)
        let effects = s.tick()
        XCTAssertEqual(effects, [.cancelRequest])
        XCTAssertNil(s.state.request)
        var engine = before.engine
        engine.failedPolls = 1
        XCTAssertEqual(s.state.engine, engine)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.pollFailed))
        XCTAssertEqual(s.state.lastDecision?.reason, "Staying: could not check for faster routes (\(Live.requestTimedOut))")
        let view = s.view()
        XCTAssertFalse(view.checking)
        XCTAssertEqual(view.statusLine, "Staying: could not check for faster routes (\(Live.requestTimedOut))")
        // toBe (the same route object) is value equality here.
        XCTAssertEqual(s.state.route, before.route)
        XCTAssertEqual(s.state.lastCheckedAtMs, before.lastCheckedAtMs)
        XCTAssertEqual(s.state.requestsUsed, before.requestsUsed)
        XCTAssertEqual(s.spoken(), [])
        // Its answer, if it ever comes, is ignored: the request it belonged to is gone.
        let followed = s.of("follow-route").count
        s.send(.routes(nowMs: s.nowMs(), requestId: hung, routes: routesAt(1350, [.A: 1300, .B: 600])))
        // toBe (the same route object) is value equality here.
        XCTAssertEqual(s.state.route, before.route)
        XCTAssertEqual(s.of("follow-route").count, followed)
        // Every check hangs: each is a failed poll in a row, and the drive carries on.
        silent(s, 300)
        XCTAssertEqual(s.state.engine.failedPolls, 4)
        XCTAssertEqual(s.of("cancel-request").map(\.atSec), [90, 150, 210, 270])
    }

    // it('a timed-out check counts the probes it sent once, and keeps the side street being confirmed')
    func testARequestThatNeverAnswers_aTimedOutCheckCountsTheProbesItSentOnceAndKeepsTheSideStreetBeingConfirmed() throws {
        let s = driving()
        cruise(s, 59)
        s.setTime(60)
        s.fix(900)
        s.tick()
        let id = try XCTUnwrap(s.state.request).id
        let before = (requests: s.state.requestsUsed, probes: s.state.probes.used)
        // The shell sent the check's path check and one side-street probe, then nothing came back.
        s.send(.requestSent(requestId: id, probe: false))
        s.send(.requestSent(requestId: id, probe: true))
        let keep = at(5000, -400)
        var sent = s.state
        sent.probes.keep = keep
        XCTAssertEqual(sent.requestsUsed, before.requests + 2)
        XCTAssertEqual(sent.probes.used, before.probes + 1)
        let step = Live.liveStep(sent, .tick(nowMs: s.nowMs() + 30_000))
        XCTAssertEqual(try item(step.effects, 0), .cancelRequest)
        // Counted as they went out, and not again now.
        XCTAssertEqual(step.state.requestsUsed, before.requests + 2)
        XCTAssertEqual(step.state.probes.used, before.probes + 1)
        // One more check made probes: the next one asks through the next via point.
        XCTAssertEqual(step.state.probes.round, sent.probes.round + 1)
        // A failed check keeps the via being confirmed, as the engine keeps its confirmation.
        XCTAssertEqual(step.state.probes.keep, keep)
    }

    // it('an answer just before the limit is used as usual')
    func testARequestThatNeverAnswers_anAnswerJustBeforeTheLimitIsUsedAsUsual() throws {
        let s = driving()
        cruise(s, 59)
        s.setTime(60)
        s.fix(900)
        s.tick()
        silent(s, 89)
        s.answer(routesAt(1335, [.A: 1300]))
        XCTAssertNotEqual(try XCTUnwrap(s.state.lastDecision).code, .reroute(.pollFailed))
        XCTAssertEqual(s.state.lastCheckedAtMs, s.nowMs())
        XCTAssertEqual(s.state.engine.failedPolls, 0)
        XCTAssertEqual(s.of("cancel-request").count, 0)
    }

    // it('a first route that never comes ends the start with a message, as a failed one does')
    func testARequestThatNeverAnswers_aFirstRouteThatNeverComesEndsTheStartWithAMessageAsAFailedOneDoes() throws {
        let s = Session()
        s.start()
        s.fix(0)
        XCTAssertEqual(s.state.status, .planning)
        s.setTime(29)
        s.tick()
        XCTAssertEqual(s.state.status, .planning)
        s.setTime(30)
        s.tick()
        XCTAssertEqual(s.state.status, .failed)
        XCTAssertEqual(s.state.message, "Could not find a route from here. \(Live.requestTimedOut)")
        XCTAssertEqual(s.of("cancel-request").count, 1)
    }

    // it('a search for a new route that hangs is given up, and another is asked for')
    func testARequestThatNeverAnswers_aSearchForANewRouteThatHangsIsGivenUpAndAnotherIsAskedFor() throws {
        let s = driving()
        cruise(s, 20)
        // Off to the side, square to the road: the car leaves the route.
        for t in stride(from: 21.0, through: 40, by: 1) {
            s.setTime(t)
            s.fix(300, 40 * (t - 20))
            s.tick()
        }
        let replans = { s.requests().filter { $0.effect.purpose == .replan } }
        XCTAssertEqual(replans().count, 1)
        let sentAt = try item(replans(), 0).atSec
        for t in stride(from: 41.0, through: sentAt + 60, by: 1) {
            s.setTime(t)
            s.fix(300, 40 * (t - 20))
            s.tick()
        }
        XCTAssertTrue(s.of("cancel-request").map(\.atSec).contains(sentAt + 30))
        XCTAssertGreaterThan(replans().count, 1)
    }

    // it('the limit is a setting: a bad value falls back to the default, never to 0')
    func testARequestThatNeverAnswers_theLimitIsASettingABadValueFallsBackToTheDefaultNeverTo0() throws {
        for requestTimeoutSec in [0, -5, Double.nan] {
            let s = driving(LiveOptions(requestTimeoutSec: requestTimeoutSec))
            cruise(s, 59)
            s.setTime(60)
            s.fix(900)
            s.tick()
            silent(s, 89)
            XCTAssertNotNil(s.state.request, "\(requestTimeoutSec)")
        }
        let s = driving(LiveOptions(requestTimeoutSec: 5))
        cruise(s, 59)
        s.setTime(60)
        s.fix(900)
        s.tick()
        silent(s, 65)
        XCTAssertEqual(s.of("cancel-request").map(\.atSec), [65])
    }

    // MARK: - describe('checks that change nothing')

    // it('a failed check leaves the route, the car and the voice alone')
    func testChecksThatChangeNothing_aFailedCheckLeavesTheRouteTheCarAndTheVoiceAlone() throws {
        let s = driving()
        cruise(s, 59)
        let before = s.state
        s.setTime(60)
        s.fix(900)
        XCTAssertNotNil(s.state.request)
        let effects = s.answer(nil, "Could not reach Mapbox.")
        XCTAssertEqual(effects, [])
        XCTAssertEqual(s.state.route, before.route)
        var engine = before.engine
        engine.failedPolls = 1
        XCTAssertEqual(s.state.engine, engine)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.pollFailed))
        XCTAssertEqual(s.state.lastDecision?.reason, "Staying: could not check for faster routes (Could not reach Mapbox.)")
        // No answer: no route count and no saving (#175).
        XCTAssertNil(s.state.lastDecision?.routes)
        XCTAssertNil(s.state.lastDecision?.savingSec)
        // The last good check is still the last one answered.
        XCTAssertEqual(s.state.lastCheckedAtMs, before.lastCheckedAtMs)
        XCTAssertEqual(s.state.candidates, before.candidates)
        XCTAssertEqual(s.spoken(), [])
        // Several in a row: still nothing, and the next check comes a minute later as usual.
        cruise(s, 190) { _ in nil }
        XCTAssertEqual(s.state.engine.failedPolls, 3)
        XCTAssertEqual(s.requests().map(\.atSec), [0, 60, 120, 180])
        XCTAssertEqual(s.spoken(), [])
    }

    // it('a check where the route driven is the fastest says so with a known saving of 0, for the diagnostics (#175)')
    func testChecksThatChangeNothing_currentBestHasAKnownSavingOfZero() throws {
        let s = driving()
        cruise(s, 130) { xM in routesAt(xM, [.A: 1300, .B: 1420]) }
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.currentBest))
        XCTAssertEqual(s.state.lastDecision?.routes, 2)
        XCTAssertEqual(s.state.lastDecision?.savingSec, 0)
    }

    // it('staying is never spoken')
    func testChecksThatChangeNothing_stayingIsNeverSpoken() throws {
        let s = driving()
        // A faster route that saves too little, at every check.
        cruise(s, 320) { xM in routesAt(xM, [.A: 1300, .B: 1260]) }
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.savingTooSmall))
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.spoken(), [])
        XCTAssertEqual(s.view().statusLine, "Staying: faster route saves only 40 seconds")
        XCTAssertEqual(s.state.lastDecision?.routes, 2)
        XCTAssertEqual(s.state.lastDecision?.savingSec, 40)
    }

    // MARK: - describe('the route being driven is not among the fresh routes')

    // it('keeps the route and its guidance, says nothing, and lets the shell ask for the current path')
    func testNotAmongTheFreshRoutes_keepsTheRouteSaysNothingAndLetsTheShellAskForTheCurrentPath() throws {
        let s = driving()
        let route = s.state.route
        // Ten checks in a row come back with B and C only. (The old rule left the route after three.)
        cruise(s, 620, { xM in routesAt(xM, [.B: 1250, .C: 1280]) }, 5)
        XCTAssertEqual(s.state.route, route)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.spoken(), [])
        XCTAssertNil(s.state.switchBanner)
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.routeUnconfirmed))
        XCTAssertEqual(try XCTUnwrap(s.state.tracking).alongRouteM, 3100, accuracy: 50)
        XCTAssertFalse(s.view().offRoute)
        // Every check carried leave for one more request; the first route did not.
        XCTAssertEqual(s.requests().map(\.effect.baseline), [false] + Array(repeating: true, count: 10))
    }

    // it('the answer for the current path is the like-for-like ETA: shown, counted, and what a switch is measured against')
    func testNotAmongTheFreshRoutes_theAnswerForTheCurrentPathIsTheLikeForLikeEta() throws {
        let s = driving()
        cruise(s, 59)
        s.setTime(60)
        s.fix(900)
        // B alone comes back; asked for the main road itself, the provider says 1200 s. B saves 50 s: stay.
        s.answer(routesAt(900, [.B: 1150]), nil, .answered(routesAt(900, [.A: 1200])))
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.savingTooSmall))
        XCTAssertEqual(s.state.eta?.durationSec, 1200)
        // Two requests went into that check.
        XCTAssertEqual(s.state.requestsUsed, 3)
        // From now on the main road is five minutes slower than B: confirmed over two checks, then an ordinary switch.
        for t in stride(from: 61.0, through: 180, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
            if s.state.request != nil { s.answer(routesAt(15 * t, [.B: 1000]), nil, .answered(routesAt(15 * t, [.A: 1300]))) }
        }
        XCTAssertEqual(s.state.switches.count, 1)
        XCTAssertEqual(s.state.switches.first?.code, .fasterRoute)
        XCTAssertEqual(s.spoken(), ["Switching to a faster route. Saves 5 minutes. Turn in 1.4 miles."])
        XCTAssertEqual(s.state.requestsUsed, 7)
    }

    // it('leave for the second request ends when the budget has no room for it')
    func testNotAmongTheFreshRoutes_leaveForTheSecondRequestEndsWhenTheBudgetHasNoRoomForIt() throws {
        let s = driving(LiveOptions(maxRequests: 4))
        cruise(s, 200) { xM in routesAt(xM, [.A: 1300]) }
        // Requests 2 and 3 could each have been followed by one more; the fourth and last could not.
        XCTAssertEqual(s.requests().map(\.effect.baseline), [false, true, true, false])
    }

    // it('asked three times for the road ahead and no route found along it: switches, and says why')
    func testNotAmongTheFreshRoutes_askedThreeTimesForTheRoadAheadAndNoRouteFoundSwitchesAndSaysWhy() throws {
        let s = driving()
        cruise(s, 59)
        for t in stride(from: 60.0, through: 180, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
            if s.state.request != nil { s.answer(routesAt(15 * t, [.B: 1250]), nil, .answered([])) }
        }
        XCTAssertEqual(s.state.switches.count, 1)
        XCTAssertEqual(s.state.switches.first?.code, .routeLost)
        XCTAssertEqual(s.state.switches.first?.atMs, s.nowMs())
        XCTAssertEqual(s.spoken(), ["Switching routes. The road ahead on your route looks closed. Turn in 1.4 miles."])
        XCTAssertEqual(s.state.switchBanner?.text, "Switching routes. The road ahead on your route looks closed. Turn in 1.4 miles.")
        XCTAssertEqual(s.state.switchBanner?.canKeep, true)
        XCTAssertNil(s.state.switchBanner?.beforeSec)
    }

    // MARK: - describe('switching by itself')

    /// B saves five minutes from the first check on.
    private func faster(_ xM: Double) -> [RouteCandidate] { routesAt(xM, [.A: 1300, .B: 1000]) }

    // it('a confirmed faster route is switched to, and announced once')
    func testSwitchingByItself_aConfirmedFasterRouteIsSwitchedToAndAnnouncedOnce() throws {
        let s = driving()
        cruise(s, 60, faster)
        // First sighting: confirming. Nothing said, the turn-off marked as pending.
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.confirming))
        XCTAssertEqual(s.state.turn?.pending, true)
        XCTAssertEqual(s.spoken(), [])

        cruise(s, 120, faster)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .B)
        XCTAssertEqual(s.state.switches.count, 1)
        XCTAssertEqual(s.state.switches.first?.code, .fasterRoute)
        XCTAssertEqual(s.state.switches.first?.reason, "Switching: saves 5 minutes, turn in 1.9 miles")
        XCTAssertEqual(s.spoken(), ["Switching to a faster route. Saves 5 minutes. Turn in 1.9 miles."])
        XCTAssertEqual(s.state.switchBanner?.text, "Switching to a faster route. Saves 5 minutes. Turn in 1.9 miles.")
        XCTAssertEqual(s.state.switchBanner?.canKeep, true)
        XCTAssertEqual(s.state.turn?.at, at(5000, 0))
        XCTAssertEqual(s.state.turn?.pending, false)
        // The new route starts where the check was sent from: the car is at its beginning.
        XCTAssertLessThan(try XCTUnwrap(s.state.tracking).alongRouteM, 20)
        XCTAssertEqual(s.of("follow-route").count, 2)
        XCTAssertEqual(try XCTUnwrap(s.view().remainingSec), 1000, accuracy: 5)

        // On B from here on (same road until 5 km): no second announcement, no second switch.
        cruise(s, 300) { xM in routesAt(xM, [.B: 1000, .A: 1300]) }
        XCTAssertEqual(s.state.switches.count, 1)
        XCTAssertEqual(s.spoken().count, 1)
        // The banner went away by itself after eight seconds.
        XCTAssertNil(s.state.switchBanner)
        XCTAssertNil(s.state.undo)
    }

    // it('"Keep previous route" goes back, and the engine does not offer that route again')
    func testSwitchingByItself_keepPreviousRouteGoesBackAndTheEngineDoesNotOfferThatRouteAgain() throws {
        let s = driving()
        cruise(s, 120, faster)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .B)
        let previous = try XCTUnwrap(s.state.undo).route
        s.setTime(124)
        s.fix(1860)
        let effects = s.send(.keepPrevious(nowMs: s.nowMs()))
        XCTAssertEqual(s.state.route, previous)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        XCTAssertEqual(try XCTUnwrap(s.state.tracking).alongRouteM, 1860, accuracy: 0.5)
        XCTAssertEqual(types(effects), ["follow-route", "speak"])
        XCTAssertEqual(s.spoken().last, Live.Spoken.keptPrevious)
        XCTAssertNil(s.state.switchBanner)
        XCTAssertNil(s.state.undo)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.state.declinedSwitches, 1)
        XCTAssertEqual(s.state.lastDecision?.code, .keptPrevious)
        XCTAssertNil(s.state.lastDecision?.routes)
        XCTAssertNil(s.state.lastDecision?.savingSec)
        // As if the switch had not been made: no cooldown, but B is declined for noReturnSec (600 s).
        XCTAssertNil(s.state.engine.lastSwitchAtSec)
        XCTAssertEqual(s.state.engine.declined.count, 1)
        XCTAssertEqual(try XCTUnwrap(s.state.engine.declined.first).untilSec, 724, accuracy: 0.5)

        // B stays five minutes faster at every check: it is not taken again while declined.
        cruise(s, 320, faster)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.driverDeclined))
        XCTAssertEqual(try XCTUnwrap(s.state.lastDecision).reason, "Staying: faster route saves 5 minutes, but you chose to keep this route")
        XCTAssertEqual(s.spoken().filter { $0.hasPrefix("Switching") }.count, 1)
        XCTAssertEqual(s.state.switches, [])
    }

    // it('doing nothing accepts: once the banner is gone the button does nothing')
    func testSwitchingByItself_doingNothingAcceptsOnceTheBannerIsGoneTheButtonDoesNothing() throws {
        let s = driving()
        cruise(s, 120, faster)
        cruise(s, 129, faster)
        XCTAssertNil(s.state.switchBanner)
        let before = s.state
        XCTAssertEqual(s.send(.keepPrevious(nowMs: s.nowMs())), [])
        XCTAssertEqual(s.state, before)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .B)
    }

    // it('turn prompts are spoken once each, and are re-armed for the new route after a switch')
    func testSwitchingByItself_turnPromptsAreSpokenOnceEachAndAreReArmedForTheNewRouteAfterASwitch() throws {
        /// Guidance for a route of the network: a turn at each of its maneuvers, announced the made-up way.
        func guided(_ c: RouteCandidate) -> RouteCandidate {
            let name = nameOf(c).rawValue
            let guidance: [GuidanceStep] = c.maneuvers.enumerated().map { i, m in
                GuidanceStep(
                    atDistanceM: m.atDistanceM,
                    location: m.location,
                    type: m.kind,
                    modifier: m.kind == "turn" ? "left" : nil,
                    primaryText: "\(name) road \(i)",
                    secondaryText: nil,
                    announcements: i == 0
                        ? []
                        : Guidance.synthesizeAnnouncements(
                            m.kind == "arrive" ? "Your destination is ahead." : "Turn onto \(name) road \(i).",
                            c.maneuvers[i - 1].atDistanceM,
                            m.atDistanceM
                        ),
                    synthesized: true
                )
            }
            return DriveWorld.patched(c) { $0.guidance = guidance }
        }
        func offer(_ xM: Double, _ yM: Double, _ etas: KeyValuePairs<RouteName, Double>) -> [RouteCandidate] {
            etas.compactMap { n, eta in candidate(n, at(xM, yM), eta) }.map(guided)
        }

        let s = driving(.default, guided(candidate(.A, at(0, 0), 1300)!))
        // A has no turn: its only prompts are about arriving, 20 km on.
        XCTAssertEqual(s.view().nextTurn?.arrow, .arrive)
        XCTAssertEqual(s.view().nextTurn?.primaryText, "A road 1")
        cruise(s, 120) { xM in offer(xM, 0, [.A: 1300, .B: 1000]) }
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .B)
        XCTAssertEqual(s.view().nextTurn?.arrow, .left)
        XCTAssertEqual(s.view().nextTurn?.primaryText, "B road 1")
        XCTAssertEqual(try XCTUnwrap(s.view().nextTurn).distanceM, 3200, accuracy: 50)

        // On to the turn at 5 km, then north along B for a while.
        cruise(s, 333) { xM in offer(xM, 0, [.B: 1000]) }
        for t in stride(from: 334.0, through: 396, by: 1) {
            s.setTime(t)
            s.fix(5000, 15 * (t - 333))
            s.tick()
            if s.state.request != nil { s.answer(offer(5000, 15 * (t - 333), [.B: 900])) }
        }
        XCTAssertEqual(s.spoken(), [
            "Switching to a faster route. Saves 5 minutes. Turn in 1.9 miles.",
            "In 0.4 miles, turn onto B road 1.",
            "Turn onto B road 1.",
            "In 0.4 miles, turn onto B road 2.",
            "Turn onto B road 2.",
        ])
        // Turn prompts carry how far the turn is, for the voice's queue rules.
        let prompts: [SpokenLine] = s.of("speak").compactMap { e in
            if case let .speak(line) = e.effect { return line }
            return nil
        }
        XCTAssertEqual(try item(prompts, 0).priority, .urgent)
        XCTAssertEqual(try item(prompts, 1).priority, .turn)
        XCTAssertEqual(try XCTUnwrap(try item(prompts, 1).distanceToManeuverM), 800, accuracy: 50)
        XCTAssertLessThan(try XCTUnwrap(try item(prompts, 2).distanceToManeuverM), 100)
    }

    // MARK: - describe('off the route')

    /// A route from wherever the car is, off the network, straight to the destination.
    private func fromHere(_ xM: Double, _ yM: Double) -> RouteCandidate {
        DriveWorld.patched(candidate(.A, at(0, 0), 1100)!) {
            $0.id = "replanned"
            $0.geometry = [at(xM, yM), at(xM + 500, yM), at(20_000, 0)]
            $0.maneuvers = []
        }
    }

    // it('one stray fix is not off the route; a sustained excursion replans at once and says so')
    func testOffTheRoute_oneStrayFixIsNotOffTheRouteASustainedExcursionReplansAtOnceAndSaysSo() throws {
        let s = driving()
        cruise(s, 65)
        XCTAssertEqual(s.requests().map(\.atSec), [0, 60])
        // A single fix 120 m to the side, then back on the road.
        s.setTime(66)
        s.fix(990, 120)
        s.setTime(67)
        s.fix(1005)
        XCTAssertEqual(s.spoken(), [])
        XCTAssertEqual(s.requests().count, 2)

        // Now a real excursion: three fixes in a row, 120 m off.
        for t in [68.0, 69] {
            s.setTime(t)
            s.fix(15 * t, 120)
        }
        XCTAssertEqual(s.spoken(), [])
        s.setTime(70)
        let effects = s.fix(1050, 120)
        // Said once, and a new route asked for at once: ten seconds after the last check,
        // not a minute, and from the device's position, not from the route line.
        XCTAssertEqual(types(effects), ["speak", "request-routes"])
        XCTAssertEqual(s.spoken(), ["You are off the route. Finding a new one."])
        // Marked so that the "New route" line a second later cannot take its place in the voice's queue.
        guard case let .speak(line) = try item(effects, 0) else { return XCTFail("not a speak effect") }
        XCTAssertEqual(line.priority, .urgent)
        XCTAssertTrue(line.mustHear)
        guard case let .requestRoutes(asked) = try item(effects, 1) else { return XCTFail("not a request") }
        XCTAssertEqual(asked.purpose, .replan)
        XCTAssertFalse(asked.baseline)
        let replan = try XCTUnwrap(s.requests().last)
        XCTAssertEqual(replan.atSec, 70)
        XCTAssertEqual(replan.effect.purpose, .replan)
        XCTAssertEqual(replan.effect.origin, at(1050, 120))
        let view = s.view()
        XCTAssertTrue(view.offRoute)
        XCTAssertNil(view.nextTurn)
        XCTAssertEqual(view.statusLine, "Off the route. Finding a new one…")

        // Still off while the request is out: nothing is said or asked twice.
        s.setTime(71)
        XCTAssertEqual(s.fix(1065, 120), [])

        s.setTime(72)
        let applied = s.answer([fromHere(1050, 120)])
        XCTAssertEqual(try XCTUnwrap(s.state.route).id, "replanned")
        XCTAssertEqual(s.state.switches.last?.code, .offRoute)
        XCTAssertNotNil(s.state.switches.last)
        XCTAssertNil(s.state.switches.last?.savingSec)
        XCTAssertEqual(types(applied), ["follow-route", "speak"])
        XCTAssertEqual(s.spoken().last, "New route. 18 minutes to your destination.")
        // There is no previous route to keep after leaving it.
        XCTAssertEqual(s.state.switchBanner?.text, s.spoken().last)
        XCTAssertEqual(s.state.switchBanner?.canKeep, false)
        XCTAssertNil(s.state.switchBanner?.beforeSec)
        XCTAssertNil(s.state.switchBanner?.turnInM)
        XCTAssertNil(s.state.undo)
        XCTAssertEqual(try XCTUnwrap(s.state.tracking).offFixes, 0)
        XCTAssertFalse(s.view().offRoute)
    }

    // it('replans even when a check was sent a second ago, dropping that check')
    func testOffTheRoute_replansEvenWhenACheckWasSentASecondAgoDroppingThatCheck() throws {
        let s = driving()
        cruise(s, 57)
        for t in [58.0, 59] {
            s.setTime(t)
            s.fix(15 * t, 150)
        }
        // Back on the line for one fix at second 60, where the minute's check goes out...
        s.setTime(60)
        s.fix(900)
        XCTAssertEqual(s.state.request?.purpose, .poll)
        // ...and off again for three.
        for t in [61.0, 62, 63] {
            s.setTime(t)
            s.fix(15 * t, 150)
        }
        XCTAssertEqual(s.state.request?.purpose, .replan)
        let types = s.effects.filter { $0.atSec == 63 }.map(\.effect.type)
        XCTAssertEqual(types, ["speak", "cancel-request", "request-routes"])
    }

    // it('while still off after a new route (a car park) it asks again only every 30 s, without repeating itself')
    func testOffTheRoute_whileStillOffAfterANewRouteItAsksAgainOnlyEvery30SWithoutRepeatingItself() throws {
        let s = driving()
        cruise(s, 10)
        // Parked-lot wandering 150 m off the road from second 11 on; every answer is a route
        // that starts on the road, so the car stays off it.
        let onRoad = { (xM: Double) in routesAt(xM, [.A: 1250]) }
        for t in 11...130 {
            s.setTime(Double(t))
            s.fix(150 + Double(t % 5) * 3, 150, speedMps: 3)
            s.tick()
            if s.state.request != nil { s.answer(onRoad(150)) }
        }
        let replans = s.requests().filter { $0.effect.purpose == .replan }.map(\.atSec)
        XCTAssertEqual(replans.first, 13)
        for i in replans.indices where i > 0 {
            XCTAssertGreaterThanOrEqual(replans[i] - replans[i - 1], 30)
        }
        XCTAssertLessThanOrEqual(replans.count, 4)
        XCTAssertEqual(s.spoken().filter { $0 == Live.Spoken.offRoute }.count, 1)
        XCTAssertEqual(s.spoken().filter { $0.hasPrefix("New route") }.count, 1)
        // Back on a road: the excursion is over, and the next one would be announced again.
        s.setTime(131)
        s.fix(200, 0)
        XCTAssertFalse(s.state.offRouteNotified)
        XCTAssertEqual(s.state.offRouteReplans, 0)
    }

    // MARK: - describe('the page in the background')

    // it('records the gap, takes the screen lock again and rechecks routes at once on return')
    func testThePageInTheBackground_recordsTheGapTakesTheScreenLockAgainAndRechecksRoutesAtOnceOnReturn() throws {
        let s = driving()
        cruise(s, 70)
        XCTAssertEqual(s.requests().map(\.atSec), [0, 60])
        s.setTime(71)
        XCTAssertEqual(s.send(.visibility(nowMs: s.nowMs(), hidden: true)), [])
        // Hidden for 95 seconds. A browser gives few fixes or none; whatever comes, no check goes out.
        for t in stride(from: 72.0, through: 165, by: 10) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
        }
        XCTAssertEqual(s.requests().count, 2)
        XCTAssertEqual(Live.livePollGate(s.state, s.nowMs()), .hidden)

        s.setTime(166)
        s.fix(15 * 166)
        let effects = s.send(.visibility(nowMs: s.nowMs(), hidden: false))
        XCTAssertEqual(types(effects), ["acquire-wake-lock", "request-routes"])
        XCTAssertEqual(s.state.pausedNote?.seconds, 95)
        XCTAssertEqual(s.view().warnings, ["RouteIQ was paused for 95 s while in the background."])
        let last = try XCTUnwrap(s.requests().last)
        XCTAssertEqual(last.atSec, 166)
        XCTAssertEqual(last.effect.purpose, .poll)
        // The note goes away by itself.
        s.answer(routesAt(15 * 166, [.A: 1300]))
        s.setTime(182)
        s.tick()
        XCTAssertEqual(s.view().warnings, [])
    }

    // it('rechecks on return even a few seconds after a check, as soon as the request gap allows')
    func testThePageInTheBackground_rechecksOnReturnEvenAFewSecondsAfterACheckAsSoonAsTheRequestGapAllows() throws {
        let s = driving()
        cruise(s, 60)
        s.setTime(61)
        s.send(.visibility(nowMs: s.nowMs(), hidden: true))
        s.setTime(68)
        s.fix(15 * 68)
        // Back after 7 s: 8 s since the last request, so not yet.
        XCTAssertEqual(types(s.send(.visibility(nowMs: s.nowMs(), hidden: false))), ["acquire-wake-lock"])
        XCTAssertTrue(s.state.recheck)
        cruise(s, 75)
        XCTAssertEqual(s.requests().map(\.atSec), [0, 60, 70])
        XCTAssertFalse(s.state.recheck)
    }

    // it('a glance away is not mentioned and costs no request')
    func testThePageInTheBackground_aGlanceAwayIsNotMentionedAndCostsNoRequest() throws {
        let s = driving()
        cruise(s, 30)
        s.send(.visibility(nowMs: s.nowMs(), hidden: true))
        s.setTime(33)
        let effects = s.send(.visibility(nowMs: s.nowMs(), hidden: false))
        XCTAssertEqual(types(effects), ["acquire-wake-lock"])
        XCTAssertNil(s.state.pausedNote)
        XCTAssertFalse(s.state.recheck)
    }

    // it('warns in one line when the screen cannot be kept awake, and carries on')
    func testThePageInTheBackground_warnsInOneLineWhenTheScreenCannotBeKeptAwakeAndCarriesOn() throws {
        let s = driving()
        s.send(.wakeLock(result: .unavailable))
        XCTAssertEqual(s.view().warnings, [Live.wakeLockWarning])
        XCTAssertTrue(Live.wakeLockWarning.contains("Keep the screen on yourself"))
        XCTAssertEqual(s.state.status, .driving)
        s.send(.wakeLock(result: .held))
        XCTAssertEqual(s.view().warnings, [])
    }

    // MARK: - describe('arriving and ending')

    // it('arrival stops tracking, releases the screen and sums the trip up')
    func testArrivingAndEnding_arrivalStopsTrackingReleasesTheScreenAndSumsTheTripUp() throws {
        let s = driving()
        cruise(s, 120) { xM in routesAt(xM, [.A: 1300, .B: 1000]) }
        XCTAssertEqual(s.state.switches.count, 1)
        // Jump to the end of the drive: the last stretch of B is the main road again.
        s.setTime(1290)
        let last = try XCTUnwrap(try XCTUnwrap(s.state.route).geometry.last)
        let effects = s.send(.fix(nowMs: s.nowMs(), fix: PositionFix(lng: last.lng, lat: last.lat, accuracyM: 8, speedMps: 3, headingDeg: 90, timeMs: s.nowMs())))
        XCTAssertEqual(s.state.status, .arrived)
        XCTAssertEqual(types(effects), ["cancel-request", "stop-watching", "release-wake-lock", "speak"])
        XCTAssertEqual(s.spoken().last, "You have arrived. Trip time 21 minutes. RouteIQ changed route once.")
        let summary = try XCTUnwrap(s.state.summary)
        XCTAssertEqual(summary.tripSec, 1290)
        XCTAssertEqual(summary.declined, 0)
        XCTAssertEqual(summary.requestsUsed, 3)
        XCTAssertEqual(summary.switches.map(\.reason), ["Switching: saves 5 minutes, turn in 1.9 miles"])
        // Nothing more happens after arrival.
        s.setTime(1300)
        XCTAssertEqual(s.fix(20_000), [])
        XCTAssertEqual(s.tick(), [])
    }

    // it('End stops everything and forgets the drive, the position included')
    func testArrivingAndEnding_endStopsEverythingAndForgetsTheDriveThePositionIncluded() throws {
        let s = driving()
        cruise(s, 60)
        let effects = s.send(.end)
        XCTAssertEqual(types(effects), ["cancel-request", "stop-watching", "release-wake-lock", "stop-speaking"])
        XCTAssertEqual(s.state, LiveState.idle)
        XCTAssertNil(s.state.lastFix)
    }

    // it('Mute is an effect for the voice and is remembered for the next drive')
    func testArrivingAndEnding_muteIsAnEffectForTheVoiceAndIsRememberedForTheNextDrive() throws {
        let s = driving()
        XCTAssertEqual(s.send(.mute(muted: true)), [.setMuted(muted: true)])
        s.send(.end)
        XCTAssertTrue(s.state.muted)
        XCTAssertEqual(try item(s.start(), 0), .setMuted(muted: true))
    }

    // MARK: - describe('stalls and stale answers (#26, #27, #28)')

    // it('#26: keep-previous with a check in flight lets checks go on at the poll interval')
    func testStallsAndStaleAnswers_26KeepPreviousWithACheckInFlightLetsChecksGoOnAtThePollInterval() throws {
        let opts = LiveOptions(pollIntervalSec: 10)
        let faster = { (xM: Double) in routesAt(xM, [.A: 1300, .B: 1000]) }
        let s = driving(opts)
        var sentAt: Double?
        var t = 0.0
        // Every answer takes 3 s, so a check is out while the switch banner is still up.
        while s.state.switches.isEmpty && t < 400 {
            t += 1
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
            if s.state.request != nil && sentAt == nil { sentAt = t }
            if s.state.request != nil, let at = sentAt, t - at >= 3 {
                s.answer(faster(15 * at))
                sentAt = nil
            }
        }
        while s.state.request == nil {
            t += 1
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
        }
        XCTAssertNotNil(s.state.switchBanner)
        // The runner aborts the fetch: no 'routes' event will come for it.
        let effects = s.send(.keepPrevious(nowMs: s.nowMs()))
        XCTAssertEqual(try item(effects, 0), .cancelRequest)
        XCTAssertNil(s.state.request)
        let before = s.requests().count
        for k in stride(from: t + 1, through: t + 600, by: 1) {
            s.setTime(k)
            s.fix(15 * k)
            s.tick()
            if s.state.request != nil { s.answer(routesAt(15 * k, [.A: 1300])) }
        }
        XCTAssertGreaterThan(s.requests().count - before, 0)
    }

    // it('#27: a replan answered after the car is back on the line does not force an off-route switch')
    func testStallsAndStaleAnswers_27AReplanAnsweredAfterTheCarIsBackOnTheLineDoesNotForceAnOffRouteSwitch() throws {
        let s = driving()
        cruise(s, 65)
        for t in [66.0, 67, 68] {
            s.setTime(t)
            s.fix(15 * t, 120) // 3 fixes 120 m to the side: replan sent
        }
        XCTAssertEqual(s.state.request?.purpose, .replan)
        for t in [69.0, 70] {
            s.setTime(t)
            s.fix(15 * t, 0) // back on A
        }
        XCTAssertEqual(try XCTUnwrap(s.state.tracking).offFixes, 0)
        s.setTime(71)
        s.answer(routesAt(15 * 68, [.A: 1300, .C: 1290])) // A itself, and C only 10 s faster
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        XCTAssertEqual(s.state.switches, [])
        // The answer went through the usual rules: 10 s is below the minimum saving.
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.savingTooSmall))
        XCTAssertFalse(s.spoken().contains { $0.hasPrefix("New route") })
    }

    // it('#28: keep-previous after a route-lost switch waits for the full count again')
    func testStallsAndStaleAnswers_28KeepPreviousAfterARouteLostSwitchWaitsForTheFullCountAgain() throws {
        let s = driving()
        cruise(s, 59)
        // The road ahead on A is never found again (baseline: []): lost checks, then a route-lost switch.
        func lost(_ t: Double) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
            if s.state.request != nil { s.answer(routesAt(15 * t, [.B: 1300, .C: 1310]), nil, .answered([])) }
        }
        var t = 60.0
        while s.state.switches.isEmpty && t <= 400 {
            lost(t)
            t += 1
        }
        XCTAssertEqual(s.state.switches.map(\.code), [.routeLost])
        s.setTime(t)
        s.fix(15 * t)
        s.send(.keepPrevious(nowMs: s.nowMs())) // driver keeps A
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        // The next lost check after the decline is check 1 of 3, not a second switch.
        let checksBefore = s.requests().count
        let until = t + 200
        t += 1
        while s.requests().count == checksBefore && t <= until {
            lost(t)
            t += 1
        }
        XCTAssertEqual(s.requests().count, checksBefore + 1)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.routeUnconfirmed))
        XCTAssertTrue(try XCTUnwrap(s.state.lastDecision).reason.contains("check 1 of 3"))
    }

    // MARK: - describe('side-street probes on the checks (#5)')

    /// S, the side street the provider never offers (500 m south of A from 6 to 14 km), as a check's probe found it.
    private func probed(_ xM: Double, _ eta: Double) -> RouteCandidate {
        DriveWorld.patched(candidate(.S, at(xM, 0), eta)!) {
            $0.source = .probe
            $0.via = at(10_000, -500)
        }
    }

    /// Answers the check that is out with the provider's routes and a probe's route, the current path
    /// asked through via points as the probe was (the path check a probe needs), and the requests they
    /// took. With `sent`, the shell reported the path check and the probe as it sent them.
    @discardableResult
    private func answerWithProbe(_ s: Session, _ xM: Double, _ sEta: Double, sent: Bool = false, pathCheck: Bool = true) -> [LiveEffect] {
        // The TS `s.state.request!.id` throws when no check is out; here that fails the test without crashing the run.
        guard let requestId = s.state.request?.id else {
            XCTFail("no check is out to answer")
            return []
        }
        if sent {
            s.send(.requestSent(requestId: requestId, probe: true))
            if pathCheck { s.send(.requestSent(requestId: requestId, probe: false)) }
        }
        return s.send(.routes(
            nowMs: s.nowMs(),
            requestId: requestId,
            routes: routesAt(xM, [.A: 1300]) + [probed(xM, sEta)],
            baseline: pathCheck ? [candidate(.A, at(xM, 0), 1300)!] : nil,
            requests: pathCheck ? 3 : 2,
            probes: 1
        ))
    }

    /// Drives on A at 15 m/s to `untilSec`, answering every check with a probe that found S.
    private func cruiseWithProbes(_ s: Session, _ untilSec: Double, _ sEta: Double, sent: Bool = false, pathCheck: Bool = true) {
        for t in stride(from: s.nowSec + 1, through: untilSec, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
            if s.state.request != nil { answerWithProbe(s, 15 * t, sEta, sent: sent, pathCheck: pathCheck) }
        }
    }

    // it('each check may make one probe, and says what to ask through and within what time; a search for the first route or a new one may not')
    func testSideStreetProbes_eachCheckMayMakeOneProbeAndASearchForTheFirstRouteOrANewOneMayNot() throws {
        let s = Session()
        s.start()
        s.fix(0)
        XCTAssertEqual(try item(s.requests(), 0).effect.purpose, .plan)
        XCTAssertEqual(try item(s.requests(), 0).effect.probes.allowed, 0)
        s.answer([candidate(.A, at(0, 0), 1300)!])
        cruise(s, 60)
        let check = try item(s.requests(), 1).effect
        XCTAssertEqual(check.purpose, .poll)
        XCTAssertTrue(check.baseline)
        XCTAssertEqual(check.probes.allowed, 1)
        XCTAssertEqual(check.probes.memory, CheckProbeMemory.initial)
        XCTAssertEqual(check.probes.budget.timeoutSec, 8)
        XCTAssertEqual(check.probes.budget.minDelaySec, 120)
        // Off the route: a new route at once, with no probe.
        for k in stride(from: 1.0, through: 4, by: 1) {
            s.setTime(60 + k)
            s.fix(900, 400)
        }
        let replan = try XCTUnwrap(s.requests().last).effect
        XCTAssertEqual(replan.purpose, .replan)
        XCTAssertEqual(replan.probes.allowed, 0)
    }

    // it('probes share the request budget: never the request the path check needs, and none once it is spent')
    func testSideStreetProbes_probesShareTheRequestBudgetNeverTheRequestThePathCheckNeeds() throws {
        // 4 requests: the first route, then checks. The 2nd request may probe (room for it and a path check);
        // the 3rd may not (the 4th is the path check's); the 4th has no room for either.
        // (Nothing kept back for the checks until the arrival here: the next test is about that.)
        let s = driving(LiveOptions(maxRequests: 4, probes: DriveProbeBudget(arrivalReserve: 0)))
        cruise(s, 60)
        cruise(s, 120)
        cruise(s, 180)
        let requests = s.requests().map(\.effect)
        XCTAssertEqual(requests.map(\.purpose), [.plan, .poll, .poll, .poll])
        XCTAssertEqual(requests.map(\.baseline), [false, true, true, false])
        XCTAssertEqual(requests.map(\.probes.allowed), [0, 1, 0, 0])
    }

    // it('probes never take the requests the plain checks until the arrival need (#183)')
    func testSideStreetProbes_probesNeverTakeTheRequestsThePlainChecksUntilTheArrivalNeed() throws {
        let first = candidate(.A, at(0, 0), 1300)!
        let reserve = (1300 * ((first.distanceM - 900) / first.distanceM) * 1.5 / 60).rounded(.up)
        XCTAssertGreaterThan(reserve, 20)
        let tight = driving(LiveOptions(maxRequests: 3 + reserve), first)
        cruise(tight, 60)
        XCTAssertEqual(tight.requests().map(\.effect.probes.allowed), [0, 0])
        let room = driving(LiveOptions(maxRequests: 4 + reserve), first)
        cruise(room, 60)
        XCTAssertEqual(room.requests().map(\.effect.probes.allowed), [0, 1])
        // A slower answer (more time left) keeps more back: the check after it may not probe.
        cruise(room, 120) { xM in routesAt(xM, [.A: 1700]) }
        cruise(room, 180) { xM in routesAt(xM, [.A: 1700]) }
        XCTAssertEqual(room.requests().map(\.effect.probes.allowed).last, 0)
        XCTAssertEqual(room.requests().count, 4)
        // The time left is what the view shows too.
        XCTAssertEqual(Live.remainingDriveSec(room.state), Live.liveView(room.state, room.nowMs()).remainingSec)
    }

    // it('a side street found by the probes is confirmed through the same via, switched to by the usual rules, and announced as such')
    func testSideStreetProbes_aSideStreetFoundByTheProbesIsConfirmedThroughTheSameViaAndAnnouncedAsSuch() throws {
        let s = driving()
        cruiseWithProbes(s, 60, 1000)
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.confirming))
        // The probe and its path check count against the budget, and its via is asked first next time.
        XCTAssertEqual(s.state.requestsUsed, 4)
        XCTAssertEqual(s.state.probes, CheckProbeMemory(used: 1, round: 1, keep: at(10_000, -500)))

        cruiseWithProbes(s, 120, 1000)
        XCTAssertEqual(try item(s.requests(), 2).effect.probes.memory.keep, at(10_000, -500))
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .S)
        XCTAssertEqual(try XCTUnwrap(s.state.route).source, .probe)
        XCTAssertEqual(s.state.switches.count, 1)
        XCTAssertEqual(s.spoken(), ["Switching to a faster route via side streets. Saves 5 minutes. Turn in 2.6 miles."])
        XCTAssertEqual(s.state.switchBanner?.text, "Switching to a faster route via side streets. Saves 5 minutes. Turn in 2.6 miles.")
        XCTAssertEqual(s.state.switchBanner?.canKeep, true)
        XCTAssertEqual(s.state.probes, CheckProbeMemory(used: 2, round: 2, keep: nil))
    }

    // it('without the path check a probe needs, a side street never counts')
    func testSideStreetProbes_withoutThePathCheckAProbeNeedsASideStreetNeverCounts() throws {
        let s = driving()
        cruiseWithProbes(s, 300, 1000, pathCheck: false)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.probeUnconfirmed))
        XCTAssertNil(s.state.probes.keep)
    }

    // it('a side street that saves only 60 s is found every check and never switched to')
    func testSideStreetProbes_aSideStreetThatSavesOnly60SIsFoundEveryCheckAndNeverSwitchedTo() throws {
        let s = driving()
        // Six checks, all before S leaves A at 6 km.
        cruiseWithProbes(s, 360, 1240)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.state.lastDecision?.action, .stay)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.savingTooSmall))
        XCTAssertEqual(s.state.lastDecision?.reason, "Staying: faster route saves only 60 seconds")
        XCTAssertNil(s.state.probes.keep)
        XCTAssertEqual(s.spoken(), [])
    }

    // it('requests are counted as the shell sends them, once, and those of a check cancelled before its answer still count')
    func testSideStreetProbes_requestsAreCountedAsTheShellSendsThemOnceAndThoseOfACancelledCheckStillCount() throws {
        let s = driving()
        cruiseWithProbes(s, 60, 1000, sent: true)
        // The check, its probe and the probe's path check: 1 + 3, each counted once.
        XCTAssertEqual(s.state.requestsUsed, 4)
        XCTAssertEqual(s.state.probes.used, 1)
        // The next check sends a probe, then the car leaves the route: the check is cancelled, its answer never comes.
        cruise(s, 119)
        s.setTime(120)
        s.fix(1800)
        s.tick()
        let id = try XCTUnwrap(s.state.request).id
        s.send(.requestSent(requestId: id, probe: true))
        for k in stride(from: 1.0, through: 4, by: 1) {
            s.setTime(120 + k)
            s.fix(1800 + 15 * k, 400)
        }
        XCTAssertEqual(try XCTUnwrap(s.state.request).purpose, .replan)
        // 4, the cancelled check and its probe, and the search for a new route.
        XCTAssertEqual(s.state.requestsUsed, 7)
        XCTAssertEqual(s.state.probes.used, 2)
    }

    // MARK: - describe('a slow answer (#5 review)')

    // it('a check whose probes ran out of time answers without them, and the checks keep their cadence')
    func testASlowAnswer_aCheckWhoseProbesRanOutOfTimeAnswersWithoutThemAndTheChecksKeepTheirCadence() throws {
        let s = driving()
        var sentAt: [Double] = []
        for t in stride(from: 1.0, through: 300, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
            s.tick()
            if let out = s.state.request, !sentAt.contains(out.sentAtMs) { sentAt.append(out.sentAtMs) }
            // The shell answers 8 s after sending (the probe never did; its time limit cancelled it).
            if let out = s.state.request, s.nowMs() - out.sentAtMs >= 8000 {
                s.send(.requestSent(requestId: out.id, probe: true))
                s.answer(routesAt(15 * t, [.A: 1300]))
            }
        }
        XCTAssertEqual(sentAt.map { ($0 - T0) / 1000 }, [60, 120, 180, 240, 300])
    }

    // it('the turn-off is judged from where the car is when the answer comes, not where it was asked from')
    func testASlowAnswer_theTurnOffIsJudgedFromWhereTheCarIsWhenTheAnswerComes() throws {
        // Asked at 4.2 km (B turns off 800 m ahead), answered 30 s later with the car 450 m on: 350 m left, too late.
        let s = driving(LiveOptions(pollIntervalSec: 280))
        cruise(s, 279, faster)
        s.setTime(280)
        s.fix(15 * 280)
        s.tick()
        XCTAssertEqual(try XCTUnwrap(s.state.request).alongM, 4200, accuracy: 5)
        for t in stride(from: 281.0, through: 310, by: 1) {
            s.setTime(t)
            s.fix(15 * t)
        }
        s.answer(faster(4200))
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.tooLate))
        XCTAssertEqual(s.state.switches, [])
    }
}

// describe('the switch moment on screen (#84)'): the pending, confirmed and kept stages, as
// the drive view shows them. The same cases as tests/live.test.ts.
final class LiveSwitchMomentTests: XCTestCase {
    /// B saves five minutes from the first check on.
    private func faster(_ xM: Double) -> [RouteCandidate] { routesAt(xM, [.A: 1300, .B: 1000]) }

    /// A full with 12 lights; B with 10, full or only partly counted.
    private func withLights(_ bCoverage: SignalCoverage) -> (Double) -> [RouteCandidate] {
        { xM in
            self.faster(xM).map { c in
                var c = c
                if nameOf(c) == .A {
                    c.signalCount = 12
                    c.signalCoverage = .full
                } else {
                    c.signalCount = 10
                    c.signalCoverage = bCoverage
                }
                return c
            }
        }
    }

    private func aWithLights() -> RouteCandidate {
        var a = candidate(.A, at(0, 0), 1300)!
        a.signalCount = 12
        a.signalCoverage = .full
        return a
    }

    private func step(_ at: Double, _ location: LngLat, _ text: String, modifier: String? = "left", type: String = "turn") -> GuidanceStep {
        GuidanceStep(atDistanceM: at, location: location, type: type, modifier: modifier, primaryText: text, secondaryText: nil, announcements: [], synthesized: true)
    }

    func testPending_theFirstSightingSaysWhatItWouldSaveAndWhatItDoesToTheLightsAndNothingIsSwitched() throws {
        let s = driving(.default, aWithLights())
        cruise(s, 60, withLights(.full))
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.confirming))
        let offer = try XCTUnwrap(s.state.offer)
        XCTAssertEqual(offer.savingSec, 300)
        XCTAssertEqual(offer.lightsDelta, -2)
        XCTAssertFalse(offer.again)
        XCTAssertEqual(s.view().moment, .pending(title: "Checking a faster route", detail: "Would save 5 min · 2 fewer lights"))
        XCTAssertEqual(s.view().moment?.canKeep, true)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        XCTAssertNil(s.state.switchBanner)
    }

    func testPending_aPartlyCountedRouteIsNeverComparedOnLights() throws {
        let s = driving(.default, aWithLights())
        cruise(s, 60, withLights(.partial))
        XCTAssertNil(try XCTUnwrap(s.state.offer).lightsDelta)
        XCTAssertEqual(s.view().moment, .pending(title: "Checking a faster route", detail: "Would save 5 min · lights: can't compare"))
    }

    func testPending_endsWhenACheckFindsNothingFaster() {
        let s = driving()
        cruise(s, 60, faster)
        XCTAssertEqual(s.view().moment?.stage, "pending")
        cruise(s, 120)
        XCTAssertNil(s.state.offer)
        XCTAssertNil(s.view().moment)
    }

    func testConfirmed_theBannerIsTheSpokenLineAndTheBeforeAndAfterFiguresDifferByExactlyTheSavingSaid() throws {
        let s = driving()
        cruise(s, 120, faster)
        let banner = try XCTUnwrap(s.state.switchBanner)
        XCTAssertEqual(banner.text, s.spoken().last)
        XCTAssertEqual(banner.atMs, s.nowMs())
        XCTAssertEqual(banner.afterSec, 1000)
        XCTAssertEqual(banner.beforeSec, 1300)
        XCTAssertEqual(s.view().moment, .confirmed(
            title: "Switching to a faster route. Saves 5 minutes. Turn in 1.9 miles.",
            before: SwitchMoment.Figures(sec: 1300, arriveAtMs: s.nowMs() + 1_300_000),
            after: SwitchMoment.Figures(sec: 1000, arriveAtMs: s.nowMs() + 1_000_000),
            canKeep: true
        ))
        // Once the banner closes, the offer it settled does not come back as "Checking a faster route".
        cruise(s, 129, faster)
        XCTAssertNil(s.state.switchBanner)
        XCTAssertNil(s.view().moment)
    }

    func testConfirmed_theTurnCardHoldsTheDistanceTheLineSaidWhileTheBannerShowsThenCountsDown() throws {
        // B with a turn at each of its corners: the first is the turn-off, 5 km along the main road.
        let offer = { (xM: Double) in
            self.faster(xM).map { c -> RouteCandidate in
                var c = c
                c.guidance = c.maneuvers.enumerated().map { i, m in
                    self.step(m.atDistanceM, m.location, "\(nameOf(c)) road \(i)", modifier: m.kind == "turn" ? "left" : nil, type: m.kind)
                }
                return c
            }
        }
        let s = driving()
        cruise(s, 120, offer)
        XCTAssertTrue(try XCTUnwrap(s.spoken().last).hasSuffix("Turn in 1.9 miles."))
        XCTAssertEqual(s.view().heldTurnText, "1.9 mi")
        // Four seconds on, 60 m nearer: still the figure that was said.
        cruise(s, 124, offer)
        XCTAssertLessThan(try XCTUnwrap(s.view().nextTurn).distanceM, try XCTUnwrap(s.state.switchBanner?.turnInM) - 50)
        XCTAssertEqual(s.view().heldTurnText, "1.9 mi")
        // The banner has closed: the real distance again.
        cruise(s, 129, offer)
        XCTAssertNil(s.state.switchBanner)
        XCTAssertNil(s.view().heldTurnText)
    }

    func testConfirmed_aSharedTurnBeforeTheTurnOffKeepsItsOwnDistance() throws {
        let withShared = { (xM: Double) in
            self.faster(xM).map { c -> RouteCandidate in
                var c = c
                c.guidance = [self.step(400, at(xM + 400, 0), "Shared bend", modifier: "right")]
                    + c.maneuvers.dropFirst().map { self.step($0.atDistanceM, $0.location, "Turn-off", type: $0.kind) }
                return c
            }
        }
        let s = driving()
        cruise(s, 120, withShared)
        XCTAssertTrue(try XCTUnwrap(s.spoken().last).hasSuffix("Turn in 1.9 miles."))
        XCTAssertEqual(s.view().nextTurn?.primaryText, "Shared bend")
        XCTAssertLessThan(try XCTUnwrap(s.view().nextTurn).distanceM, 500)
        XCTAssertNil(s.view().heldTurnText)
    }

    func testConfirmed_aTurnBackAtTheTurnOffButFartherAlongIsNotGivenTheSpokenDistance() throws {
        // B's only turn is at the turn-off's place, but 4 km farther along (the road loops back past it).
        let looped = { (xM: Double) in
            self.faster(xM).map { c -> RouteCandidate in
                var c = c
                if nameOf(c) == .B, c.maneuvers.count > 1 {
                    let turnOff = c.maneuvers[1]
                    c.guidance = [self.step(turnOff.atDistanceM + 4000, turnOff.location, "Loop")]
                }
                return c
            }
        }
        let s = driving()
        cruise(s, 120, looped)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .B)
        let banner = try XCTUnwrap(s.state.switchBanner)
        XCTAssertEqual(s.view().nextTurn?.primaryText, "Loop")
        XCTAssertGreaterThan(try XCTUnwrap(s.view().nextTurn).distanceM, try XCTUnwrap(banner.turnInM) + 1000)
        XCTAssertNil(s.view().heldTurnText)
    }

    func testPending_anOfferWhileOffTheRouteIsNotShown() {
        let s = driving()
        cruise(s, 60, faster)
        XCTAssertEqual(s.view().moment?.stage, "pending")
        for t in stride(from: 61.0, through: 75, by: 1) {
            s.setTime(t)
            s.fix(15 * t, 200)
        }
        XCTAssertTrue(s.view().offRoute)
        XCTAssertNil(s.view().moment)
    }

    func testPending_anOfferThatArrivesAfterTheCarHasLeftTheRouteIsNotShown() throws {
        let s = driving()
        cruise(s, 60, faster)
        let offer = try XCTUnwrap(s.state.offer)
        for t in stride(from: 61.0, through: 75, by: 1) {
            s.setTime(t)
            s.fix(15 * t, 200)
        }
        var late = s.state
        late.offer = offer
        XCTAssertTrue(Live.liveView(late, s.nowMs()).offRoute)
        XCTAssertNil(Live.liveView(late, s.nowMs()).moment)
    }

    func testKeepMyRouteWhilePending_dropsTheSideStreetViaBeingConfirmed() {
        let s = driving()
        cruise(s, 60, faster)
        var state = s.state
        state.probes.keep = at(2000, 300)
        let kept = Live.liveStep(state, .keepPrevious(nowMs: s.nowMs()))
        XCTAssertNil(kept.state.probes.keep)
    }

    func testANewOfferReplacesTheCalmKeptBannerAtOnce() {
        // Checks every 10 s and a 30 s banner, so the next offer comes while "kept" still shows.
        let s = driving(LiveOptions(pollIntervalSec: 10, switchBannerSec: 30))
        cruise(s, 10, faster)
        XCTAssertEqual(s.view().moment?.stage, "pending")
        s.send(.keepPrevious(nowMs: s.nowMs()))
        XCTAssertEqual(s.view().moment?.stage, "kept")
        // C turns up at the next check: a different route, not the one turned down.
        cruise(s, 20) { xM in routesAt(xM, [.A: 1300, .C: 1000]) }
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.confirming))
        XCTAssertNil(s.state.kept)
        XCTAssertEqual(s.view().moment, .pending(title: "Checking a faster route", detail: "Would save 5 min · lights: can't compare"))
    }

    func testADifferentRouteOfferedAfterOneWasTurnedDownIsAFirstOffer() {
        let s = driving()
        cruise(s, 60, faster)
        s.send(.keepPrevious(nowMs: s.nowMs()))
        cruise(s, 121) { xM in routesAt(xM, [.A: 1300, .C: 1000]) }
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.confirming))
        XCTAssertEqual(s.view().moment, .pending(title: "Checking a faster route", detail: "Would save 5 min · lights: can't compare"))
    }

    func testKeepMyRouteWhilePending_nothingToUndoTheConfirmationIsDroppedAndThatRouteIsNotTaken() throws {
        let s = driving()
        cruise(s, 60, faster)
        s.setTime(62)
        s.fix(930)
        let effects = s.send(.keepPrevious(nowMs: s.nowMs()))
        XCTAssertEqual(types(effects), ["speak"])
        XCTAssertEqual(s.spoken().last, Live.Spoken.keptPrevious)
        XCTAssertNil(s.state.offer)
        XCTAssertNil(s.state.turn)
        XCTAssertEqual(s.state.declinedSwitches, 1)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertNil(s.state.engine.pending)
        XCTAssertEqual(try item(s.state.engine.declined, 0).untilSec, 662, accuracy: 0.5)
        XCTAssertEqual(s.view().moment, .kept(title: "Staying on your route.", detail: "Won't offer that route again for 10 min."))
        XCTAssertEqual(s.view().moment?.canKeep, false)
        // B stays five minutes faster: it is never switched to while declined.
        cruise(s, 300, faster)
        XCTAssertEqual(nameOf(try XCTUnwrap(s.state.route)), .A)
        XCTAssertEqual(s.state.switches, [])
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.driverDeclined))
        XCTAssertNil(s.state.offer)
    }

    func testKeepMyRouteAfterTheSwitch_theCalmBannerShowsForTheBannerTimeThenGoes() {
        let s = driving()
        cruise(s, 120, faster)
        s.setTime(122)
        s.fix(1830)
        s.send(.keepPrevious(nowMs: s.nowMs()))
        XCTAssertEqual(s.view().moment?.stage, "kept")
        cruise(s, 129, faster)
        XCTAssertEqual(s.view().moment?.stage, "kept")
        cruise(s, 130, faster)
        XCTAssertNil(s.state.kept)
        XCTAssertNil(s.view().moment)
    }

    func testOfferedAgainOnceTheNoReturnTimeIsUp_stillFasterCheckingAgain() {
        // Slowly (5 m/s), so B's turn-off at 5 km is still ahead twelve minutes on.
        let s = driving()
        cruise(s, 60, faster, 5)
        s.send(.keepPrevious(nowMs: s.nowMs()))
        cruise(s, 659, faster, 5)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.driverDeclined))
        XCTAssertNil(s.view().moment)
        // Declined until 660 s: the check then sees B again, as a new offer.
        cruise(s, 661, faster, 5)
        XCTAssertEqual(s.state.lastDecision?.code, .reroute(.confirming))
        XCTAssertEqual(s.view().moment, .pending(title: "Still faster. Checking again.", detail: "Would save 5 min · lights: can't compare"))
    }

    func testCardDistance_isTheSpokenDistanceAsTheTurnCardSetsIt() {
        XCTAssertEqual(Live.cardDistance("0.8 miles"), "0.8 mi")
        XCTAssertEqual(Live.cardDistance("1 mile"), "1 mi")
        XCTAssertEqual(Live.cardDistance("450 feet"), "450 ft")
    }
}
