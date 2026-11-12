import Foundation

// Turn guidance for a live drive, ported from src/core/guidance.ts: what to
// show ("next turn: arrow, distance, road") and what to say, given how far
// along the route the car is. Pure: the route's guidance
// (RouteCandidate.guidance, filled by the Directions parser) and the meters
// driven come in, plain data comes out.

/// The picture of a maneuver: which arrow to draw.
public enum ArrowKind: String, Hashable, Sendable, CaseIterable {
    case straight
    case slightLeft = "slight-left"
    case left
    case sharpLeft = "sharp-left"
    case slightRight = "slight-right"
    case right
    case sharpRight = "sharp-right"
    case uturn
    case merge
    case roundabout
    case depart
    case arrive
}

/// What the drive view shows about the maneuver ahead.
public struct NextTurn: Hashable, Sendable {
    public var arrow: ArrowKind
    /// Meters from the car to the maneuver. Never below 0.
    public var distanceM: Double
    public var primaryText: String
    public var secondaryText: String?
    public var type: String
    public var modifier: String?
    public var location: LngLat
}

/// Which announcements of a route have been dealt with: all those before
/// `next` in the order they become due. Plain data, kept by the caller for
/// one route; a new route gets a new cursor (armGuidance).
public struct GuidanceCursor: Hashable, Sendable {
    public var next: Int

    public init(next: Int) {
        self.next = next
    }
}

/// Something that is due to be said now.
public struct DueAnnouncement: Hashable, Sendable {
    public var text: String
    /// Meters from the car to the maneuver it is about.
    public var distanceToManeuverM: Double
}

public enum Guidance {
    static let byModifier: [String: ArrowKind] = [
        "straight": .straight,
        "slight left": .slightLeft,
        "left": .left,
        "sharp left": .sharpLeft,
        "slight right": .slightRight,
        "right": .right,
        "sharp right": .sharpRight,
        "uturn": .uturn,
    ]

    /// The arrow for a maneuver type and modifier as the Directions API names them. Anything unknown is "straight".
    public static func arrowKind(_ type: String, _ modifier: String?) -> ArrowKind {
        if type == "arrive" { return .arrive }
        if type == "depart" { return .depart }
        if type == "roundabout" || type == "rotary" || type == "roundabout turn" { return .roundabout }
        // A JavaScript object lookup: only the key's exact UTF-16 code units match.
        let found = modifier.flatMap { m in byModifier.first { JS.Key($0.key) == JS.Key(m) }?.value }
        if type == "merge" && (found == nil || found == .straight) { return .merge }
        return found ?? .straight
    }

    /// A maneuver this many meters behind the car is still "the next one": the car is in the middle of it.
    public static let maneuverPassedM = 15.0

    /// The maneuver to show: the first one still ahead of the car (or within
    /// maneuverPassedM behind it), setting off left aside. Nil when the route
    /// has no guidance or nothing is left of it.
    public static func nextTurn(_ guidance: [GuidanceStep]?, _ alongM: Double) -> NextTurn? {
        guard let step = (guidance ?? []).first(where: { $0.type != "depart" && $0.atDistanceM >= alongM - maneuverPassedM }) else { return nil }
        return NextTurn(
            arrow: arrowKind(step.type, step.modifier),
            distanceM: JS.max(0, step.atDistanceM - alongM),
            primaryText: step.primaryText,
            secondaryText: step.secondaryText,
            type: step.type,
            modifier: step.modifier,
            location: step.location
        )
    }

    /// One announcement of a route, with the maneuver it is about.
    struct Flat {
        let atDistanceM: Double
        let text: String
        let maneuverAtM: Double
    }

    /// Every announcement of a route in the order it becomes due.
    static func flat(_ guidance: [GuidanceStep]) -> [Flat] {
        guidance
            .flatMap { g in g.announcements.map { Flat(atDistanceM: $0.atDistanceM, text: $0.text, maneuverAtM: g.atDistanceM) } }
            .filter { $0.atDistanceM.isFinite && !$0.text.isEmpty }
            // Stable: announcements due at the same place keep the order of their maneuvers.
            .jsSorted { JS.compare($0.atDistanceM, $1.atDistanceM) }
    }

    /// The cursor to start a route with, for a car `alongM` meters along it.
    /// Announcements already behind the car are never spoken. `speakDue`:
    /// true at the start of a drive, so the line due where the car starts is
    /// spoken; false after a switch, where the switch announcement has just
    /// said what comes next.
    public static func armGuidance(_ guidance: [GuidanceStep]?, _ alongM: Double, speakDue: Bool) -> GuidanceCursor {
        // Keep the newest of the lines due here; dueAnnouncement drops the older ones itself.
        if speakDue { return GuidanceCursor(next: 0) }
        let all = flat(guidance ?? [])
        var next = 0
        while next < all.count && all[next].atDistanceM <= alongM { next += 1 }
        return GuidanceCursor(next: next)
    }

    /// The announcement that is due for a car `alongM` meters along the
    /// route, and the cursor to pass next time. Each announcement is due
    /// once. When several have become due since the last call, only the
    /// newest whose maneuver is still ahead is said; the rest are dropped.
    public static func dueAnnouncement(
        _ guidance: [GuidanceStep]?,
        _ cursor: GuidanceCursor,
        _ alongM: Double
    ) -> (say: DueAnnouncement?, cursor: GuidanceCursor) {
        let all = flat(guidance ?? [])
        var next = max(0, cursor.next)
        var due: Flat?
        while next < all.count && all[next].atDistanceM <= alongM {
            let a = all[next]
            if a.maneuverAtM >= alongM - maneuverPassedM { due = a }
            next += 1
        }
        if next == cursor.next { return (nil, cursor) }
        return (
            due.map { DueAnnouncement(text: $0.text, distanceToManeuverM: JS.max(0, $0.maneuverAtM - alongM)) },
            GuidanceCursor(next: next)
        )
    }

    /// How far before a maneuver the first made-up announcement comes, at most, in meters (half a mile).
    public static let synthFarM = 800.0
    /// How far before a maneuver the last made-up announcement comes, in meters.
    public static let synthNearM = 90.0

    /// "Turn left onto ..." reads on after "In 0.4 miles, "; a road name at the start ("I-77 ...") is left alone.
    static func lowerFirst(_ text: String) -> String {
        let units = Array(text.utf16)
        guard units.count >= 2, (65...90).contains(units[0]), (97...122).contains(units[1]) else { return text }
        return String(decoding: [units[0] + 32] + units[1...], as: UTF16.self)
    }

    /// Simple announcements for a maneuver the provider sent no voice
    /// instructions for, made from its plain instruction: one well ahead
    /// ("In 0.4 miles, turn left onto Main Street."), when the stretch leading
    /// to it is long enough, and the instruction itself shortly before.
    /// `approachFromM` is where the stretch leading to the maneuver begins;
    /// nothing is set before it.
    public static func synthesizeAnnouncements(_ instruction: String, _ approachFromM: Double, _ atDistanceM: Double) -> [GuidanceAnnouncement] {
        let text = JS.trim(instruction)
        if text.isEmpty || !atDistanceM.isFinite { return [] }
        let fromM = JS.max(0, approachFromM.isFinite ? JS.min(approachFromM, atDistanceM) : 0)
        let leadM = atDistanceM - fromM
        var out: [GuidanceAnnouncement] = []
        if leadM >= synthNearM * 3 {
            let farM = JS.min(leadM, synthFarM)
            out.append(GuidanceAnnouncement(atDistanceM: atDistanceM - farM, text: "In \(Reroute.spokenDistance(farM)), \(lowerFirst(text))"))
        }
        out.append(GuidanceAnnouncement(atDistanceM: JS.max(fromM, atDistanceM - synthNearM), text: text))
        return out
    }
}
