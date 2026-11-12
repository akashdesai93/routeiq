import Foundation

// What is said when, ported from src/core/speechQueue.ts: the rules for a
// voice that must never fall behind the drive. Pure: the queue is plain data,
// the speech engine is somewhere else and only does what these functions answer.
//
// At most two lines exist at any time: the one being spoken and one waiting.
// A line the driver must hear (`mustHear`) is never lost from the waiting
// place: what comes after it is said after it, as part of the same line.

/// How much a line matters.
public enum SpeechPriority: String, Hashable, Sendable {
    /// A change of route, off the route, arrival.
    case urgent
    /// A turn prompt.
    case turn
    /// Anything that can be lost ("RouteIQ started").
    case info

    var rank: Int {
        switch self {
        case .info: return 1
        case .turn: return 2
        case .urgent: return 3
        }
    }
}

/// One thing to say.
public struct SpokenLine: Hashable, Sendable {
    public var text: String
    public var priority: SpeechPriority
    /// For a turn prompt: meters from the car to the maneuver when the line was made.
    public var distanceToManeuverM: Double?
    /// True for a line that explains what happens next and so must not be
    /// replaced before it has been said. (The TypeScript leaves it out for false.)
    public var mustHear: Bool
    /// Set by the queue on a line it has joined to a follow-up: the must-hear words at its start.
    public var mustHearText: String?

    public init(text: String, priority: SpeechPriority, distanceToManeuverM: Double? = nil, mustHear: Bool = false, mustHearText: String? = nil) {
        self.text = text
        self.priority = priority
        self.distanceToManeuverM = distanceToManeuverM
        self.mustHear = mustHear
        self.mustHearText = mustHearText
    }
}

public struct SpeechQueue: Hashable, Sendable {
    public var speaking: SpokenLine?
    public var waiting: SpokenLine?

    public init(speaking: SpokenLine? = nil, waiting: SpokenLine? = nil) {
        self.speaking = speaking
        self.waiting = waiting
    }

    public static let empty = SpeechQueue()
}

/// What the speech engine is to do with a new line.
public enum SpeechAction: String, Hashable, Sendable {
    /// Nothing is being said; say it now.
    case speak
    /// Stop what is being said and say this instead.
    case interrupt
    /// It is next, after the line being spoken.
    case wait
    /// It is not said at all.
    case drop
}

public enum Speech {
    /// A turn prompt for a maneuver this close is not interrupted: the driver needs it now. In meters.
    public static let nearTurnM = 200.0

    /// Adds a line. Nothing being said: said at once. An urgent line cuts off
    /// whatever is being said, unless that is urgent itself or a turn prompt
    /// within nearTurnM. Otherwise it waits; only one line waits: the more
    /// important stays, and of two equals the newer. A waiting must-hear line
    /// is not replaced: the follow-up is joined after it.
    public static func enqueueSpeech(_ queue: SpeechQueue, _ line: SpokenLine) -> (queue: SpeechQueue, action: SpeechAction) {
        if JS.trim(line.text).isEmpty { return (queue, .drop) }
        guard let speaking = queue.speaking else { return (SpeechQueue(speaking: line, waiting: queue.waiting), .speak) }
        let nearTurn = speaking.priority == .turn && (speaking.distanceToManeuverM ?? .infinity) <= nearTurnM
        if line.priority == .urgent && speaking.priority != .urgent && !nearTurn {
            return (SpeechQueue(speaking: line, waiting: queue.waiting), .interrupt)
        }
        guard let waiting = queue.waiting else { return (SpeechQueue(speaking: speaking, waiting: line), .wait) }
        if line.priority.rank < waiting.priority.rank { return (queue, .drop) }
        if waiting.mustHear && !line.mustHear {
            // `mustHearText` is the part that has to stay; a newer follow-up takes the place of an older one.
            let first = waiting.mustHearText ?? waiting.text
            return (
                SpeechQueue(speaking: speaking, waiting: SpokenLine(text: "\(first) \(line.text)", priority: line.priority, mustHear: true, mustHearText: first)),
                .wait
            )
        }
        return (SpeechQueue(speaking: speaking, waiting: line), .wait)
    }

    /// The line being spoken has ended (or failed): the waiting one, if any, is next.
    public static func speechFinished(_ queue: SpeechQueue) -> (queue: SpeechQueue, next: SpokenLine?) {
        (SpeechQueue(speaking: queue.waiting, waiting: nil), queue.waiting)
    }
}
