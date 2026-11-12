import Foundation
import XCTest
import RouteIQCore

// Mirrors tests/guidance.test.ts: what the Mapbox adapter carries per route
// (banner and voice instructions, or instructions made up from the steps),
// and the pure functions that pick what to show and what to say.
// Hand-written bodies from tests/fixtures; no network.
final class GuidanceTests: XCTestCase {
    // MARK: - Helpers

    private func fixture(_ name: String) throws -> JSONValue {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONValue.parse(Data(contentsOf: root.appendingPathComponent("tests/fixtures/\(name)")))
    }

    private func guidanceOf(_ body: JSONValue) throws -> [GuidanceStep] {
        let routes = try XCTUnwrap(Directions.parse(body).routes, "expected routes")
        return try XCTUnwrap(routes.first).guidance ?? []
    }

    private static func at(_ x: Double, _ y: Double) -> LngLat { DriveWorld.at(x, y) }

    private static func a(_ atDistanceM: Double, _ text: String) -> GuidanceAnnouncement {
        GuidanceAnnouncement(atDistanceM: atDistanceM, text: text)
    }

    /// A made-up route: set off, turn left 1 km on, turn right at 3 km, arrive at 3.5 km.
    private static let STEPS: [GuidanceStep] = [
        GuidanceStep(atDistanceM: 0, location: at(0, 0), type: "depart", modifier: nil, primaryText: "First Road", secondaryText: nil, announcements: [], synthesized: false),
        GuidanceStep(
            atDistanceM: 1000, location: at(1000, 0), type: "turn", modifier: "left", primaryText: "Second Road", secondaryText: "North",
            announcements: [
                a(0, "Drive east on First Road. Then, in half a mile, turn left onto Second Road."),
                a(600, "In a quarter mile, turn left onto Second Road."),
                a(920, "Turn left onto Second Road."),
            ],
            synthesized: false
        ),
        GuidanceStep(
            atDistanceM: 3000, location: at(1000, 2000), type: "turn", modifier: "right", primaryText: "Third Road", secondaryText: nil,
            announcements: [
                a(1000, "Continue on Second Road for 1 mile."),
                a(2200, "In half a mile, turn right onto Third Road."),
                a(2920, "Turn right onto Third Road."),
            ],
            synthesized: false
        ),
        GuidanceStep(
            atDistanceM: 3500, location: at(1500, 2000), type: "arrive", modifier: "right", primaryText: "Your destination", secondaryText: nil,
            announcements: [a(3440, "Your destination is on the right.")],
            synthesized: false
        ),
    ]

    private struct Said: Equatable {
        let alongM: Double
        let text: String
    }

    /// Drives the route in steps and collects what is said, with the distance it was said at.
    private func said(_ guidance: [GuidanceStep]?, _ alongs: [Double], _ start: GuidanceCursor) -> [Said] {
        var lines: [Said] = []
        var cursor = start
        for alongM in alongs {
            let due = Guidance.dueAnnouncement(guidance, cursor, alongM)
            cursor = due.cursor
            if let say = due.say { lines.append(Said(alongM: alongM, text: say.text)) }
        }
        return lines
    }

    private func every(_ stepM: Double, _ fromM: Double, _ toM: Double) -> [Double] {
        let count = Int(((toM - fromM) / stepM).rounded(.down)) + 1
        return (0..<count).map { fromM + Double($0) * stepM }
    }

    // MARK: - describe('Mapbox adapter: banner and voice instructions')

    // it('gives one entry per maneuver, each placed at the start of its step')
    func testAdapter_givesOneEntryPerManeuverEachPlacedAtTheStartOfItsStep() throws {
        let guidance = try guidanceOf(try fixture("directions.guidance.json"))
        XCTAssertEqual(guidance.map(\.type), ["depart", "turn", "arrive"])
        XCTAssertEqual(guidance.map(\.modifier), [nil, "right", "left"])
        XCTAssertEqual(guidance.map(\.atDistanceM), [0, 500, 2000])
        XCTAssertEqual(guidance[1].location, LngLat(-80.847, 35.2238))
    }

    // it('takes a maneuver its banner and voice from the step that leads to it')
    func testAdapter_takesAManeuverItsBannerAndVoiceFromTheStepThatLeadsToIt() throws {
        let guidance = try guidanceOf(try fixture("directions.guidance.json"))
        let turn = guidance[1]
        XCTAssertEqual(turn.primaryText, "West Morehead Street")
        XCTAssertEqual(turn.secondaryText, "US 29")
        XCTAssertFalse(turn.synthesized)
        // distanceAlongGeometry is meters before the maneuver. In driving order,
        // plain text (never the SSML), unusable entries left out.
        XCTAssertEqual(turn.announcements, [
            Self.a(0, "Drive southwest on South Tryon Street. Then, in a quarter mile, turn right onto West Morehead Street."),
            Self.a(420, "Turn right onto West Morehead Street."),
        ])
        // Setting off has nothing leading to it.
        XCTAssertEqual(guidance[0].primaryText, "South Tryon Street")
        XCTAssertEqual(guidance[0].announcements, [])
        XCTAssertFalse(guidance[0].synthesized)
    }

    // it('makes simple instructions from the step maneuver where Mapbox sent none, and says so')
    func testAdapter_makesSimpleInstructionsFromTheStepManeuverWhereMapboxSentNoneAndSaysSo() throws {
        let arrive = try guidanceOf(try fixture("directions.guidance.json"))[2]
        XCTAssertTrue(arrive.synthesized)
        XCTAssertEqual(arrive.primaryText, "West Morehead Street")
        XCTAssertNil(arrive.secondaryText)
        XCTAssertEqual(arrive.announcements, [
            Self.a(1200, "In 0.4 miles, you have arrived at your destination, on the left."),
            Self.a(1910, "You have arrived at your destination, on the left."),
        ])
    }

    // it('a response without any banner or voice fields still gives guidance for every maneuver')
    func testAdapter_aResponseWithoutAnyBannerOrVoiceFieldsStillGivesGuidanceForEveryManeuver() throws {
        let plain = try guidanceOf(try fixture("directions.ok.json"))
        XCTAssertEqual(plain.map(\.type), ["depart", "turn", "fork", "arrive"])
        XCTAssertTrue(plain.dropFirst().allSatisfy { $0.synthesized && !$0.announcements.isEmpty })
        XCTAssertEqual(plain[1].modifier, "left")
        XCTAssertEqual(plain[1].atDistanceM, 800.5)
        XCTAssertEqual(try XCTUnwrap(plain[1].announcements.last).atDistanceM, 710.5, accuracy: 0.005)
        // No steps at all: no guidance, and the route is still a route.
        let bare = Directions.parse([
            "code": "Ok",
            "routes": [["duration": 60, "distance": 500, "geometry": ["coordinates": [[-80.84, 35.22], [-80.85, 35.22]]]]],
        ])
        XCTAssertEqual(try XCTUnwrap(bare.routes?.first).guidance, [])
    }

    // it('asks Mapbox for both, with imperial distances in the spoken text')
    func testAdapter_asksMapboxForBothWithImperialDistancesInTheSpokenText() throws {
        let url = try XCTUnwrap(DirectionsRequest.urlString(origin: LngLat(-80.8431, 35.2271), destination: LngLat(-80.8295, 35.1527), token: "pk.test-token"))
        let items = try XCTUnwrap(URLComponents(string: url)?.queryItems)
        func get(_ name: String) -> String? { items.first { $0.name == name }?.value }
        XCTAssertEqual(get("steps"), "true")
        XCTAssertEqual(get("banner_instructions"), "true")
        XCTAssertEqual(get("voice_instructions"), "true")
        XCTAssertEqual(get("voice_units"), "imperial")
    }

    // MARK: - describe('what to show')

    // it('shows the first maneuver still ahead, with the distance to it')
    func testWhatToShow_showsTheFirstManeuverStillAheadWithTheDistanceToIt() throws {
        let first = try XCTUnwrap(Guidance.nextTurn(Self.STEPS, 0))
        XCTAssertEqual(first.arrow, .left)
        XCTAssertEqual(first.distanceM, 1000)
        XCTAssertEqual(first.primaryText, "Second Road")
        XCTAssertEqual(first.secondaryText, "North")
        XCTAssertEqual(Guidance.nextTurn(Self.STEPS, 640).map { [$0.arrow.rawValue, JS.string($0.distanceM)] }, ["left", "360"])
        // In the middle of the turn it is still the one shown; a little past it, the next.
        XCTAssertEqual(Guidance.nextTurn(Self.STEPS, 1010).map { [$0.arrow.rawValue, JS.string($0.distanceM)] }, ["left", "0"])
        let next = try XCTUnwrap(Guidance.nextTurn(Self.STEPS, 1020))
        XCTAssertEqual(next.arrow, .right)
        XCTAssertEqual(next.distanceM, 1980)
        XCTAssertEqual(next.primaryText, "Third Road")
        XCTAssertEqual(Guidance.nextTurn(Self.STEPS, 3100).map { [$0.arrow.rawValue, JS.string($0.distanceM)] }, ["arrive", "400"])
        XCTAssertNil(Guidance.nextTurn(Self.STEPS, 3600))
        XCTAssertNil(Guidance.nextTurn(nil, 0))
        XCTAssertNil(Guidance.nextTurn([Self.STEPS[0]], 0))
    }

    // it('names an arrow for every kind of maneuver')
    func testWhatToShow_namesAnArrowForEveryKindOfManeuver() {
        XCTAssertEqual(Guidance.arrowKind("turn", "sharp left"), .sharpLeft)
        XCTAssertEqual(Guidance.arrowKind("fork", "slight right"), .slightRight)
        XCTAssertEqual(Guidance.arrowKind("off ramp", "right"), .right)
        XCTAssertEqual(Guidance.arrowKind("continue", "uturn"), .uturn)
        XCTAssertEqual(Guidance.arrowKind("merge", "slight left"), .slightLeft)
        XCTAssertEqual(Guidance.arrowKind("merge", nil), .merge)
        XCTAssertEqual(Guidance.arrowKind("rotary", "left"), .roundabout)
        XCTAssertEqual(Guidance.arrowKind("arrive", "left"), .arrive)
        XCTAssertEqual(Guidance.arrowKind("new name", nil), .straight)
        XCTAssertEqual(Guidance.arrowKind("something new", "sideways"), .straight)
    }

    // MARK: - describe('what to say')

    // it('says each announcement once, where it becomes due')
    func testWhatToSay_saysEachAnnouncementOnceWhereItBecomesDue() {
        let lines = said(Self.STEPS, every(15, 0, 3500), Guidance.armGuidance(Self.STEPS, 0, speakDue: true))
        XCTAssertEqual(lines, [
            Said(alongM: 0, text: "Drive east on First Road. Then, in half a mile, turn left onto Second Road."),
            Said(alongM: 600, text: "In a quarter mile, turn left onto Second Road."),
            Said(alongM: 930, text: "Turn left onto Second Road."),
            Said(alongM: 1005, text: "Continue on Second Road for 1 mile."),
            Said(alongM: 2205, text: "In half a mile, turn right onto Third Road."),
            Said(alongM: 2925, text: "Turn right onto Third Road."),
            Said(alongM: 3450, text: "Your destination is on the right."),
        ])
    }

    // it('never repeats one, standing still or moving back')
    func testWhatToSay_neverRepeatsOneStandingStillOrMovingBack() {
        var cursor = Guidance.armGuidance(Self.STEPS, 0, speakDue: true)
        let first = Guidance.dueAnnouncement(Self.STEPS, cursor, 610)
        XCTAssertEqual(first.say?.text, "In a quarter mile, turn left onto Second Road.")
        XCTAssertEqual(first.say?.distanceToManeuverM, 390)
        cursor = first.cursor
        for alongM in [610.0, 612, 605, 580, 610, 640] {
            let again = Guidance.dueAnnouncement(Self.STEPS, cursor, alongM)
            XCTAssertNil(again.say)
            // Nothing new: the very same cursor comes back.
            XCTAssertEqual(again.cursor, cursor)
        }
    }

    // it('after a gap says only the newest line that still matters, not the backlog')
    func testWhatToSay_afterAGapSaysOnlyTheNewestLineThatStillMattersNotTheBacklog() {
        // From 500 m straight to 2950 m (a tunnel): five lines became due; one is still about a turn ahead.
        let cursor = Guidance.dueAnnouncement(Self.STEPS, Guidance.armGuidance(Self.STEPS, 0, speakDue: true), 500).cursor
        let after = Guidance.dueAnnouncement(Self.STEPS, cursor, 2950)
        XCTAssertEqual(after.say?.text, "Turn right onto Third Road.")
        XCTAssertEqual(after.say?.distanceToManeuverM, 50)
        XCTAssertNil(Guidance.dueAnnouncement(Self.STEPS, after.cursor, 2960).say)
        // Past the turn altogether: nothing stale is said.
        XCTAssertNil(Guidance.dueAnnouncement(Self.STEPS, cursor, 3100).say)
    }

    // it('is re-armed for a new route: lines behind the car are dropped, the rest come when due')
    func testWhatToSay_isReArmedForANewRouteLinesBehindTheCarAreDroppedTheRestComeWhenDue() {
        // After a switch the car is 30 m into the new route: its opening line is not spoken.
        let switched = said(Self.STEPS, every(15, 30, 1000), Guidance.armGuidance(Self.STEPS, 30, speakDue: false))
        XCTAssertEqual(switched.map(\.text), ["In a quarter mile, turn left onto Second Road.", "Turn left onto Second Road."])
        // Taken up in the middle (the previous route kept): only what is still ahead.
        let kept = said(Self.STEPS, every(15, 2300, 3500), Guidance.armGuidance(Self.STEPS, 2300, speakDue: false))
        XCTAssertEqual(kept.map(\.text), ["Turn right onto Third Road.", "Your destination is on the right."])
        // A fresh cursor on the same route speaks again: "once" is per cursor, so per route driven.
        XCTAssertEqual(said(Self.STEPS, [0], Guidance.armGuidance(Self.STEPS, 0, speakDue: true)).count, 1)
        // No guidance: nothing to say, and nothing breaks.
        XCTAssertNil(Guidance.dueAnnouncement(nil, Guidance.armGuidance(nil, 0, speakDue: true), 500).say)
    }

    // MARK: - describe('made-up announcements')

    // it('gives one ahead and one at the turn on a long approach')
    func testMadeUp_givesOneAheadAndOneAtTheTurnOnALongApproach() {
        XCTAssertEqual(Guidance.synthesizeAnnouncements("Turn left onto Main Street.", 0, 5000), [
            Self.a(4200, "In 0.4 miles, turn left onto Main Street."),
            Self.a(4910, "Turn left onto Main Street."),
        ])
    }

    // it('on a short approach, only the instruction, and never before the approach begins')
    func testMadeUp_onAShortApproachOnlyTheInstructionAndNeverBeforeTheApproachBegins() {
        XCTAssertEqual(Guidance.synthesizeAnnouncements("Turn right.", 950, 1000), [Self.a(950, "Turn right.")])
        XCTAssertEqual(Guidance.synthesizeAnnouncements("Turn right.", 600, 1000), [
            Self.a(600, "In 0.2 miles, turn right."),
            Self.a(910, "Turn right."),
        ])
        XCTAssertEqual(Guidance.synthesizeAnnouncements("  ", 0, 1000), [])
        // A road number at the start is not lower-cased.
        XCTAssertEqual(Guidance.synthesizeAnnouncements("I-77 South continues.", 0, 2000).first?.text, "In 0.4 miles, I-77 South continues.")
    }
}
