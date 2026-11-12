import XCTest
import RouteIQCore

// Mirrors describe('speech queue rules') in tests/device.test.ts. The rest of
// that file is browser wrappers (speech engine, wake lock, geolocation) and is
// not core.
final class SpeechQueueTests: XCTestCase {
    private func turn(_ text: String, _ distanceToManeuverM: Double) -> SpokenLine {
        SpokenLine(text: text, priority: .turn, distanceToManeuverM: distanceToManeuverM)
    }
    private func urgent(_ text: String) -> SpokenLine { SpokenLine(text: text, priority: .urgent) }
    private func info(_ text: String) -> SpokenLine { SpokenLine(text: text, priority: .info) }
    private let empty = SpeechQueue.empty

    // it('says a line at once when nothing is being said')
    func testSpeechQueue_saysALineAtOnceWhenNothingIsBeingSaid() {
        let (queue, action) = Speech.enqueueSpeech(empty, turn("Turn left.", 80))
        XCTAssertEqual(action, .speak)
        XCTAssertEqual(queue.speaking?.text, "Turn left.")
    }

    // it('a switch announcement pre-empts a turn prompt that is still far away')
    func testSpeechQueue_aSwitchAnnouncementPreEmptsATurnPromptThatIsStillFarAway() {
        let far = Speech.enqueueSpeech(empty, turn("In 2 miles, turn left.", 3200)).queue
        let (queue, action) = Speech.enqueueSpeech(far, urgent("Switching to a faster route."))
        XCTAssertEqual(action, .interrupt)
        XCTAssertEqual(queue.speaking?.text, "Switching to a faster route.")
    }

    // it('but not one for a turn that is right ahead, nor another urgent line: it waits its turn')
    func testSpeechQueue_butNotOneForATurnThatIsRightAheadNorAnotherUrgentLineItWaitsItsTurn() {
        let near = Speech.enqueueSpeech(empty, turn("Turn left.", 150)).queue
        let waited = Speech.enqueueSpeech(near, urgent("Switching to a faster route."))
        XCTAssertEqual(waited.action, .wait)
        XCTAssertEqual(waited.queue.speaking?.text, "Turn left.")
        XCTAssertEqual(waited.queue.waiting?.text, "Switching to a faster route.")
        let busy = Speech.enqueueSpeech(empty, urgent("You are off the route.")).queue
        XCTAssertEqual(Speech.enqueueSpeech(busy, urgent("New route.")).action, .wait)
    }

    // it('never holds more than two lines: the more important one waits, and of equals the newer')
    func testSpeechQueue_neverHoldsMoreThanTwoLinesTheMoreImportantOneWaitsAndOfEqualsTheNewer() {
        var queue = Speech.enqueueSpeech(empty, turn("Turn left.", 100)).queue
        queue = Speech.enqueueSpeech(queue, turn("In a mile, turn right.", 1600)).queue
        // A newer turn prompt replaces the one waiting.
        let newer = Speech.enqueueSpeech(queue, turn("In half a mile, turn right.", 800))
        XCTAssertEqual(newer.action, .wait)
        XCTAssertEqual(newer.queue.waiting?.text, "In half a mile, turn right.")
        // Something that can be lost does not push a turn prompt out.
        let lost = Speech.enqueueSpeech(newer.queue, info("RouteIQ started"))
        XCTAssertEqual(lost.action, .drop)
        XCTAssertEqual(lost.queue, newer.queue)
        // An urgent line takes the waiting place from a turn prompt.
        let pushed = Speech.enqueueSpeech(newer.queue, urgent("Switching to a faster route."))
        XCTAssertEqual(pushed.queue.waiting?.text, "Switching to a faster route.")
        XCTAssertEqual(Speech.enqueueSpeech(queue, SpokenLine(text: "  ", priority: .urgent)).action, .drop)
    }

    // it('a line that must be heard is not replaced while it waits: the follow-up is said after it')
    func testSpeechQueue_aLineThatMustBeHeardIsNotReplacedWhileItWaitsTheFollowUpIsSaidAfterIt() throws {
        // A switch is being announced when the car leaves the route; a second later the new route is there.
        var offRoute = urgent("You are off the route. Finding a new one.")
        offRoute.mustHear = true
        var queue = Speech.enqueueSpeech(empty, urgent("Switching to a faster route.")).queue
        queue = Speech.enqueueSpeech(queue, offRoute).queue
        XCTAssertEqual(queue.waiting, offRoute)
        let followed = Speech.enqueueSpeech(queue, urgent("New route. 12 minutes to your destination."))
        XCTAssertEqual(followed.action, .wait)
        XCTAssertEqual(followed.queue.speaking?.text, "Switching to a faster route.")
        let joined = try XCTUnwrap(followed.queue.waiting)
        XCTAssertEqual(joined.text, "You are off the route. Finding a new one. New route. 12 minutes to your destination.")
        XCTAssertEqual(joined.priority, .urgent)
        XCTAssertTrue(joined.mustHear)
        // A still newer follow-up takes the place of the older one, not of the reason: never more than two lines.
        let again = Speech.enqueueSpeech(followed.queue, urgent("New route. 11 minutes to your destination."))
        XCTAssertEqual(again.queue.waiting?.text, "You are off the route. Finding a new one. New route. 11 minutes to your destination.")
        // Something less important is still dropped.
        XCTAssertEqual(Speech.enqueueSpeech(again.queue, turn("In a mile, turn right.", 1600)).action, .drop)
        // Its turn comes: the reason first, in one go.
        let next = Speech.speechFinished(again.queue)
        XCTAssertTrue(try XCTUnwrap(next.next).text.hasPrefix("You are off the route. Finding a new one. New route."))
        XCTAssertNil(next.queue.waiting)
        // Being spoken, it is not cut off by the follow-up either: that one waits, as any urgent line does.
        let speaking = Speech.enqueueSpeech(empty, offRoute).queue
        let held = Speech.enqueueSpeech(speaking, urgent("New route. 12 minutes to your destination."))
        XCTAssertEqual(held.action, .wait)
        XCTAssertEqual(held.queue.speaking?.text, offRoute.text)
        XCTAssertEqual(held.queue.waiting?.text, "New route. 12 minutes to your destination.")
        // And without the mark the old rule holds: of two equals the newer.
        let plain = Speech.enqueueSpeech(Speech.enqueueSpeech(empty, urgent("One.")).queue, urgent("Two.")).queue
        XCTAssertEqual(Speech.enqueueSpeech(plain, urgent("Three.")).queue.waiting?.text, "Three.")
    }

    // it('moves the waiting line up when the spoken one ends')
    func testSpeechQueue_movesTheWaitingLineUpWhenTheSpokenOneEnds() {
        var queue = Speech.enqueueSpeech(empty, urgent("One.")).queue
        queue = Speech.enqueueSpeech(queue, urgent("Two.")).queue
        let after = Speech.speechFinished(queue)
        XCTAssertEqual(after.next?.text, "Two.")
        XCTAssertEqual(after.queue, SpeechQueue(speaking: SpokenLine(text: "Two.", priority: .urgent), waiting: nil))
        let drained = Speech.speechFinished(Speech.speechFinished(after.queue).queue)
        XCTAssertEqual(drained.queue, SpeechQueue.empty)
        XCTAssertNil(drained.next)
    }
}
