import Foundation

// The live drive, ported from src/core/live.ts: the reroute engine
// (Reroute.swift) fed by the device's real position. One tap starts it; after
// that it follows the car, checks for faster routes on a timer, changes route
// by itself and says so.
//
// A pure state machine: `Live.liveStep(state, event, options:)` answers the
// next state and a list of effects (watch the position, ask for routes, speak,
// hold the screen awake). It reads no clock and touches no device: every event
// carries its time, and the shell carries the effects out with its own
// position source, voice and screen lock.
//
// The position is used in memory only. Nothing here stores or logs it.
//
// Identity: the TypeScript compares two objects with `===` in a few places.
// Swift structs are values, so each of those is replaced by an exact equivalent:
// - the candidate a switch goes to is found by id (`toRouteId`), as in the TS;
// - the guidance cursor is compared by value: the TS dueAnnouncement hands back
//   the same object exactly when its `next` is unchanged, so `!==` there is `!=`;
// - the TS caches `trackedRoute(geometry)` by the geometry array's identity, a
//   pure optimisation: here a fresh `TrackedRoute` is made each time.

/// Where a live drive is.
public enum LiveStatus: String, Hashable, Sendable, CaseIterable {
    /// No drive.
    case idle
    /// Started; waiting for the first good position fix.
    case locating
    /// Has a position; waiting for the first route.
    case planning
    case driving
    case arrived
    /// Could not start, or cannot go on: `message` says why.
    case failed
}

/// Every setting of the live drive, in one place. The initializer's defaults
/// are the values (`LiveOptions.default`, the TS DEFAULT_LIVE_OPTIONS). The TS
/// `Partial<LiveOptions>` is this full struct; a number that is negative or not
/// finite falls back to its default, as the TS `resolve` does.
public struct LiveOptions: Hashable, Sendable {
    /// A check for faster routes is due every this many seconds.
    public var pollIntervalSec: Double
    /// No two route requests closer together than this, whatever asks for them, in seconds. Also the floor of pollIntervalSec.
    public var minRequestGapSec: Double
    /// After standing still for this long, no checks are made until the car moves again, in seconds.
    public var stationaryPauseSec: Double
    /// The most route requests one drive may make (the first route and every check). After that it drives on without checking.
    /// A number, as in the TS: it is rounded (Math.round) when the options are resolved.
    public var maxRequests: Double
    /// Requests kept back, on top of maxRequests, for finding a new route when off the route. Rounded like maxRequests.
    public var offRouteReserve: Double
    /// No check is sent from a position older than this, in seconds (a tunnel): it would be asked from the wrong place.
    public var maxFixAgeSec: Double
    /// How long the "switched route" banner and its "Keep previous route" button stay, in seconds.
    public var switchBannerSec: Double
    /// A spell in the background shorter than this is not mentioned, in seconds.
    public var hiddenNoteMinSec: Double
    /// How long the "was paused in the background" note stays, in seconds.
    public var pausedNoteSec: Double
    /// While still off the route after a new one was found, another is looked for no sooner than this, in seconds.
    public var replanGapSec: Double
    /// Below this speed the device's heading is not sent with a request, in meters per second: standing still it points anywhere.
    public var minHeadingSpeedMps: Double
    /// A route request (the first route, a check with everything it asks, a search for a new
    /// route) not answered within this long is given up, in seconds: cancelled and counted as a
    /// failed answer, so a hung connection cannot hold back the checks after it.
    public var requestTimeoutSec: Double
    public var tracking: TrackingOptions
    public var reroute: RerouteOptions
    /// Side-street probes during the checks (Probe.swift, DriveProbeBudget); they share maxRequests.
    public var probes: DriveProbeBudget

    public init(
        pollIntervalSec: Double = 60,
        minRequestGapSec: Double = 10,
        stationaryPauseSec: Double = 120,
        maxRequests: Double = 60,
        offRouteReserve: Double = 5,
        maxFixAgeSec: Double = 10,
        switchBannerSec: Double = 8,
        hiddenNoteMinSec: Double = 5,
        pausedNoteSec: Double = 15,
        replanGapSec: Double = 30,
        minHeadingSpeedMps: Double = 2,
        requestTimeoutSec: Double = 30,
        tracking: TrackingOptions = .default,
        reroute: RerouteOptions = .default,
        probes: DriveProbeBudget = .default
    ) {
        self.pollIntervalSec = pollIntervalSec
        self.minRequestGapSec = minRequestGapSec
        self.stationaryPauseSec = stationaryPauseSec
        self.maxRequests = maxRequests
        self.offRouteReserve = offRouteReserve
        self.maxFixAgeSec = maxFixAgeSec
        self.switchBannerSec = switchBannerSec
        self.hiddenNoteMinSec = hiddenNoteMinSec
        self.pausedNoteSec = pausedNoteSec
        self.replanGapSec = replanGapSec
        self.minHeadingSpeedMps = minHeadingSpeedMps
        self.requestTimeoutSec = requestTimeoutSec
        self.tracking = tracking
        self.reroute = reroute
        self.probes = probes
    }

    /// The one place the defaults are set.
    public static let `default` = LiveOptions()

    /// The TS `resolve`. Idempotent, so resolving resolved options changes nothing.
    func resolved() -> LiveOptions {
        let d = LiveOptions.default
        func n(_ v: Double, _ fallback: Double) -> Double { v.isFinite && v >= 0 ? v : fallback }
        let minRequestGapSec = JS.max(d.minRequestGapSec, n(minRequestGapSec, d.minRequestGapSec))
        return LiveOptions(
            // Never faster than the request gap, whatever is typed into a settings box.
            pollIntervalSec: JS.max(minRequestGapSec, n(pollIntervalSec, d.pollIntervalSec)),
            minRequestGapSec: minRequestGapSec,
            stationaryPauseSec: n(stationaryPauseSec, d.stationaryPauseSec),
            maxRequests: JS.round(n(maxRequests, d.maxRequests)),
            offRouteReserve: JS.round(n(offRouteReserve, d.offRouteReserve)),
            maxFixAgeSec: n(maxFixAgeSec, d.maxFixAgeSec),
            switchBannerSec: n(switchBannerSec, d.switchBannerSec),
            hiddenNoteMinSec: n(hiddenNoteMinSec, d.hiddenNoteMinSec),
            pausedNoteSec: n(pausedNoteSec, d.pausedNoteSec),
            replanGapSec: JS.max(minRequestGapSec, n(replanGapSec, d.replanGapSec)),
            minHeadingSpeedMps: n(minHeadingSpeedMps, d.minHeadingSpeedMps),
            // 0 would give up on every request before it could be answered.
            requestTimeoutSec: requestTimeoutSec > 0 ? n(requestTimeoutSec, d.requestTimeoutSec) : d.requestTimeoutSec,
            tracking: tracking,
            reroute: reroute,
            probes: probes
        )
    }
}

/// Why a position could not be had. The same kinds as the geolocation wrapper's.
public enum PositionErrorKind: String, Hashable, Sendable, CaseIterable {
    case denied
    case unavailable
    case timeout
    case insecure
    case unsupported

    /// What the driver is told (Live.positionErrorMessages).
    public var message: String {
        switch self {
        case .denied:
            return "Location permission was denied. RouteIQ cannot follow the drive without it. Allow location for this site in the browser settings, then start again."
        case .unavailable: return "Your position is not available right now. Still trying."
        case .timeout: return "No position fix yet. Still trying: this can take a while indoors."
        case .insecure: return "Browsers only share location on secure pages (HTTPS or localhost), so a live drive cannot start here."
        case .unsupported: return "This browser cannot share its location, so a live drive cannot start here."
        }
    }

    /// The TS FATAL set: the drive cannot go on.
    var isFatal: Bool { self == .denied || self == .insecure || self == .unsupported }
}

/// What a route request is for.
public enum RequestPurpose: String, Hashable, Sendable, CaseIterable {
    case plan
    case poll
    case replan
}

public enum WakeLockStatus: String, Hashable, Sendable, CaseIterable {
    case pending
    case held
    case unavailable
    case released
}

/// What the shell reports about the screen lock (the TS `'held' | 'unavailable' | 'released'`).
public enum WakeLockResult: String, Hashable, Sendable, CaseIterable {
    case held
    case unavailable
    case released

    var status: WakeLockStatus {
        switch self {
        case .held: return .held
        case .unavailable: return .unavailable
        case .released: return .released
        }
    }
}

public struct LiveSwitch: Hashable, Sendable {
    public var atMs: Double
    public var code: RerouteCode
    /// The engine's sentence for it.
    public var reason: String
    /// The time the engine said the switch saves, in seconds: the fresh time of the route left
    /// minus that of the new one. Nil when it claimed none (a closure ahead, a new route after
    /// leaving the old one). For the drive log (#107).
    public var savingSec: Double?

    public init(atMs: Double, code: RerouteCode, reason: String, savingSec: Double? = nil) {
        self.atMs = atMs
        self.code = code
        self.reason = reason
        self.savingSec = savingSec
    }
}

public struct LiveSummary: Hashable, Sendable {
    /// From the Start tap to arrival, in seconds.
    public var tripSec: Double
    /// The route changes that were made and kept, in order.
    public var switches: [LiveSwitch]
    /// Switches the driver turned down with "Keep previous route".
    public var declined: Int
    public var requestsUsed: Int
}

/// The code of the engine's latest word: one of the engine's, or the driver's own "Keep previous route"
/// (the TS `RerouteCode | 'kept-previous'`).
public enum LiveDecisionCode: Hashable, Sendable {
    case reroute(RerouteCode)
    case keptPrevious

    /// The TS string.
    public var rawValue: String {
        switch self {
        case let .reroute(code): return code.rawValue
        case .keptPrevious: return "kept-previous"
        }
    }
}

/// The whole of a live drive between two events. Plain data: keep it, pass it back.
public struct LiveState: Hashable, Sendable {
    /// The route request that is out.
    public struct Request: Hashable, Sendable {
        public var id: Int
        public var purpose: RequestPurpose
        public var sentAtMs: Double
        /// Where along the route the car was when it was sent: the engine is asked about that place.
        public var alongM: Double
        public var distanceFromRouteM: Double
        /// Requests made for it after the first (its path check, its probes), counted as the shell sent them. Nil: none.
        public var extraSent: Int?
        /// How many of those were side-street probes. Nil: none.
        public var probesSent: Int?
    }

    /// The engine's latest word.
    public struct Decision: Hashable, Sendable {
        public var action: RerouteAction
        public var code: LiveDecisionCode
        public var reason: String
        public var atMs: Double
    }

    /// The travel time last heard for the route being driven, and how much of the route it was for.
    public struct Eta: Hashable, Sendable {
        public var durationSec: Double
        public var remainingM: Double
    }

    /// Where a switch that is waiting (pending) or was just made leaves the old route.
    public struct Turn: Hashable, Sendable {
        public var at: LngLat
        public var pending: Bool
    }

    public struct SwitchBanner: Hashable, Sendable {
        public var untilMs: Double
        public var text: String
        public var canKeep: Bool
    }

    /// What "Keep previous route" goes back to.
    public struct Undo: Hashable, Sendable {
        public var route: RouteCandidate
        public var alongM: Double
        public var engine: RerouteState
        public var eta: Eta?
    }

    public struct PausedNote: Hashable, Sendable {
        public var seconds: Double
        public var untilMs: Double
    }

    public var status: LiveStatus
    public var destination: LngLat?
    public var startedAtMs: Double?
    /// The route picked on the plan screen, handed over at Start (a side-street
    /// probe route included). The drive starts on it when the first good fix is
    /// on its line; otherwise it asks for a route from where the car is. Kept
    /// until then only.
    public var picked: RouteCandidate?
    /// When the plan screen's answer with the picked route's travel times came, on the
    /// session's clock. A drive that starts on the pick counts that as its last check (#71).
    /// Nil: not known, the start counts instead.
    public var pickedAtMs: Double?
    /// Why the drive failed. Nil otherwise.
    public var message: String?
    /// A passing note about the position (no fix yet, poor accuracy). Nil when there is none.
    public var gpsNote: String?
    /// The last usable fix. In memory only.
    public var lastFix: PositionFix?
    /// The route being driven.
    public var route: RouteCandidate?
    public var tracking: TrackingState?
    public var engine: RerouteState
    public var guidance: GuidanceCursor
    /// The route request that is out.
    public var request: Request?
    public var nextRequestId: Int
    /// Route requests made so far on this drive (side-street probes included).
    public var requestsUsed: Int
    /// The side-street probes of the checks: how many were made, whose turn is next, and the via being confirmed.
    public var probes: CheckProbeMemory
    public var lastRequestAtMs: Double?
    /// When the last check was answered. Nil before the first route.
    public var lastCheckedAtMs: Double?
    /// A check is wanted as soon as one may be sent (back from the background).
    public var recheck: Bool
    public var lastDecision: Decision?
    /// What the last answered check returned.
    public var candidates: [RouteCandidate]?
    public var eta: Eta?
    public var turn: Turn?
    /// Shown for a few seconds after a switch.
    public var switchBanner: SwitchBanner?
    /// What "Keep previous route" goes back to, while the banner is up.
    public var undo: Undo?
    public var switches: [LiveSwitch]
    public var declinedSwitches: Int
    /// True once "off the route" has been said for the present excursion (it ends with a fix back on a route line).
    public var offRouteNotified: Bool
    /// New routes asked for during the present excursion.
    public var offRouteReplans: Int
    /// Since when the page has been in the background. Nil while it is in front.
    public var hiddenSinceMs: Double?
    public var pausedNote: PausedNote?
    public var wakeLock: WakeLockStatus
    public var muted: Bool
    public var summary: LiveSummary?

    /// No drive: the TS LIVE_IDLE.
    public static let idle = LiveState(
        status: .idle,
        destination: nil,
        startedAtMs: nil,
        picked: nil,
        pickedAtMs: nil,
        message: nil,
        gpsNote: nil,
        lastFix: nil,
        route: nil,
        tracking: nil,
        engine: .initial,
        guidance: GuidanceCursor(next: 0),
        request: nil,
        nextRequestId: 1,
        requestsUsed: 0,
        probes: .initial,
        lastRequestAtMs: nil,
        lastCheckedAtMs: nil,
        recheck: false,
        lastDecision: nil,
        candidates: nil,
        eta: nil,
        turn: nil,
        switchBanner: nil,
        undo: nil,
        switches: [],
        declinedSwitches: 0,
        offRouteNotified: false,
        offRouteReplans: 0,
        hiddenSinceMs: nil,
        pausedNote: nil,
        wakeLock: .pending,
        muted: false,
        summary: nil
    )
}

/// Something that happened, for the live drive to take into account.
public enum LiveEvent: Hashable, Sendable {
    /// The Start tap. `route`: the route picked on the plan screen, to be driven
    /// (see LiveState.picked). Nil: the drive asks for its own.
    /// `routeFetchedAtMs`: when the answer with that route's travel times came, on the same
    /// clock as `nowMs` (see LiveState.pickedAtMs). Nil: unknown.
    case start(nowMs: Double, destination: LngLat, route: RouteCandidate? = nil, routeFetchedAtMs: Double? = nil)
    case fix(nowMs: Double, fix: PositionFix)
    case positionError(nowMs: Double, kind: PositionErrorKind)
    /// The answer to a `.requestRoutes` effect. `routes` nil: the request failed (`message` says how).
    /// `baseline`: what came back when the current path itself was asked for; nil when it was not asked or failed.
    /// `requests`: how many requests the answer took, when more than the one the effect counted.
    /// `probes`: how many of those were side-street probes; nil, none.
    case routes(
        nowMs: Double,
        requestId: Int,
        routes: [RouteCandidate]?,
        message: String? = nil,
        baseline: [RouteCandidate]? = nil,
        requests: Int? = nil,
        probes: Int? = nil
    )
    /// The shell is sending one more request for the check `requestId` (its path
    /// check, or a side-street probe, or the path check a probe needs). Counted at once.
    case requestSent(requestId: Int, probe: Bool)
    /// About once a second.
    case tick(nowMs: Double)
    case visibility(nowMs: Double, hidden: Bool)
    case wakeLock(result: WakeLockResult)
    /// The driver pressed "Keep previous route".
    case keepPrevious(nowMs: Double)
    case mute(muted: Bool)
    /// The End tap, or the drive view being closed.
    case end

    /// The TS discriminant.
    public var type: String {
        switch self {
        case .start: return "start"
        case .fix: return "fix"
        case .positionError: return "position-error"
        case .routes: return "routes"
        case .requestSent: return "request-sent"
        case .tick: return "tick"
        case .visibility: return "visibility"
        case .wakeLock: return "wake-lock"
        case .keepPrevious: return "keep-previous"
        case .mute: return "mute"
        case .end: return "end"
        }
    }
}

/// The side-street probes a check may make (PLAN step 11c): at most `allowed`
/// requests, through the via points Probe.checkProbes picks from the fresh
/// routes with `memory`. `allowed` is 0 for anything but a check, and when the
/// budget has no room (Probe.checkProbeAllowance).
public struct LiveProbeLeave: Hashable, Sendable {
    public var allowed: Int
    public var memory: CheckProbeMemory
    public var budget: DriveProbeBudget
}

/// A route request for the shell to send.
public struct LiveRouteRequest: Hashable, Sendable {
    public var requestId: Int
    public var purpose: RequestPurpose
    public var origin: LngLat
    /// The direction of travel to send with the request. Nil: none (standing still, or unknown).
    public var headingDeg: Double?
    /// True when the shell may spend ONE more request on this check: if the
    /// fresh routes do not include the route being driven, it asks for that
    /// path itself (baselineProbe) and answers with it as `baseline`.
    public var baseline: Bool
    public var probes: LiveProbeLeave
}

/// What the shell has to do.
public enum LiveEffect: Hashable, Sendable {
    case watchPosition
    case stopWatching
    case acquireWakeLock
    case releaseWakeLock
    case requestRoutes(LiveRouteRequest)
    case cancelRequest
    case speak(line: SpokenLine)
    /// Said inside the Start tap, which is what lets a phone browser speak later; silent when muted.
    case primeSpeech(text: String)
    case stopSpeaking
    case setMuted(muted: Bool)
    /// The route being driven changed: for a position source that follows it (the replay).
    case followRoute(geometry: [LngLat])

    /// The TS discriminant.
    public var type: String {
        switch self {
        case .watchPosition: return "watch-position"
        case .stopWatching: return "stop-watching"
        case .acquireWakeLock: return "acquire-wake-lock"
        case .releaseWakeLock: return "release-wake-lock"
        case .requestRoutes: return "request-routes"
        case .cancelRequest: return "cancel-request"
        case .speak: return "speak"
        case .primeSpeech: return "prime-speech"
        case .stopSpeaking: return "stop-speaking"
        case .setMuted: return "set-muted"
        case .followRoute: return "follow-route"
        }
    }
}

public struct LiveStep: Hashable, Sendable {
    public var state: LiveState
    public var effects: [LiveEffect]

    public init(state: LiveState, effects: [LiveEffect]) {
        self.state = state
        self.effects = effects
    }
}

/// Whether a check for faster routes may be sent now, and if not, what it is waiting for.
public enum LivePollGate: String, Hashable, Sendable, CaseIterable {
    case due
    case notDriving = "not-driving"
    case inFlight = "in-flight"
    /// The page is in the background.
    case hidden
    case budgetSpent = "budget-spent"
    /// Too soon after the last request.
    case requestGap = "request-gap"
    case notYet = "not-yet"
    /// Standing still for longer than stationaryPauseSec.
    case stationary
    /// The last position is too old (a tunnel).
    case noFix = "no-fix"
    /// The last fix was off the route line: a check from there would not be about this route.
    case offLine = "off-line"
}

/// What the drive view shows, worked out from the state and the time.
public struct LiveView: Hashable, Sendable {
    public var status: LiveStatus
    public var nextTurn: NextTurn?
    public var remainingM: Double?
    /// Time left, scaled from the last travel time heard for this route by the distance left.
    public var remainingSec: Double?
    /// When the car gets there, on the clock `nowMs` is from.
    public var arrivalAtMs: Double?
    /// The quiet line: the engine's latest reason, or what the drive is waiting for.
    public var statusLine: String
    /// Seconds since the last answered check. Nil before the first.
    public var checkedAgoSec: Double?
    public var checking: Bool
    public var offRoute: Bool
    /// One-line warnings, most pressing first.
    public var warnings: [String]
    public var requestsUsed: Int
    public var maxRequests: Double
}

public enum Live {
    /// The lines that are spoken (the TS SPOKEN). Turn prompts come from the route's guidance.
    public enum Spoken {
        public static let started = "RouteIQ started"
        public static let offRoute = "You are off the route. Finding a new one."
        public static let keptPrevious = "Keeping the previous route."
    }

    /// What the driver is told for each kind (the TS POSITION_ERROR_MESSAGES). The first three keep trying or need the driver; the text says which.
    public static let positionErrorMessages: [PositionErrorKind: String] = Dictionary(
        uniqueKeysWithValues: PositionErrorKind.allCases.map { ($0, $0.message) }
    )

    public static let wakeLockWarning = "This browser cannot keep the screen awake. Keep the screen on yourself."

    static func times(_ n: Int) -> String {
        n == 1 ? "once" : n == 2 ? "twice" : "\(n) times"
    }

    /// "Switching to a faster route. Saves 3 minutes. Turn in 0.8 miles." and its relatives.
    /// `sideStreet`: the new route was found by a side-street probe, and the line says so.
    public static func switchLine(_ code: RerouteCode, _ savingSec: Double?, _ turnInM: Double?, _ newDurationSec: Double, sideStreet: Bool = false) -> String {
        let turn = turnInM.map { " Turn in \(Reroute.spokenDistance($0))." } ?? ""
        if code == .offRoute { return "New route. \(Reroute.spokenDuration(newDurationSec)) to your destination." }
        if code == .fasterRoute, let savingSec {
            return "Switching to a faster route\(sideStreet ? " via side streets" : ""). Saves \(Reroute.spokenDuration(savingSec)).\(turn)"
        }
        // The only other switch (route-lost): asked several times, the provider found no route along the road ahead.
        return "Switching routes. The road ahead on your route looks closed.\(turn)"
    }

    public static func arrivalLine(_ summary: LiveSummary) -> String {
        let changed = summary.switches.isEmpty ? "" : " RouteIQ changed route \(times(summary.switches.count))."
        return "You have arrived. Trip time \(Reroute.spokenDuration(summary.tripSec)).\(changed)"
    }

    /// `a + b` for counts that stops at Int.max instead of trapping. (A JavaScript counter is a double and never overflows.)
    static func add(_ a: Int, _ b: Int) -> Int {
        let (sum, overflow) = a.addingReportingOverflow(b)
        return overflow ? (b > 0 ? .max : .min) : sum
    }

    /// The poll rule. A check is due `pollIntervalSec` after the last request, or
    /// at once when one is wanted (back from the background); never within
    /// `minRequestGapSec` of the last request, never with the budget spent, never
    /// while the page is hidden, never from a stale position or one off the
    /// route line, and not while the car has stood still for more than
    /// `stationaryPauseSec`.
    public static func livePollGate(_ state: LiveState, _ nowMs: Double, options: LiveOptions = .default) -> LivePollGate {
        let opts = options.resolved()
        guard state.status == .driving, let tracking = state.tracking, state.route != nil else { return .notDriving }
        if state.request != nil { return .inFlight }
        if state.hiddenSinceMs != nil { return .hidden }
        if !(Double(state.requestsUsed) < opts.maxRequests) { return .budgetSpent }
        // A drive that started on the route picked on the plan screen has made no request yet:
        // that route's answer counts as the first one, so the first check is a poll interval later.
        let lastAskedMs = state.lastRequestAtMs ?? state.lastCheckedAtMs
        let sinceRequestSec = lastAskedMs.map { (nowMs - $0) / 1000 } ?? .infinity
        if sinceRequestSec < opts.minRequestGapSec { return .requestGap }
        if !state.recheck && sinceRequestSec < opts.pollIntervalSec { return .notYet }
        if (nowMs - tracking.fix.timeMs) / 1000 > opts.maxFixAgeSec { return .noFix }
        if tracking.offFixes > 0 { return .offLine }
        if let stoppedSince = tracking.stoppedSinceMs, (nowMs - stoppedSince) / 1000 > opts.stationaryPauseSec { return .stationary }
        return .due
    }

    static let stopEffects: [LiveEffect] = [.cancelRequest, .stopWatching, .releaseWakeLock]

    static func fail(_ state: LiveState, _ message: String) -> LiveStep {
        var next = state
        next.status = .failed
        next.message = message
        next.request = nil
        next.switchBanner = nil
        next.undo = nil
        return LiveStep(state: next, effects: stopEffects)
    }

    /// A route with a line to drive.
    static func drivable(_ route: RouteCandidate?) -> Bool {
        guard let route else { return false }
        return route.geometry.filter(Geo.isValidLngLat).count >= 2
    }

    static func headingFor(_ tracking: TrackingState, _ opts: LiveOptions) -> Double? {
        tracking.speedMps >= opts.minHeadingSpeedMps ? tracking.headingDeg : nil
    }

    /// Sends a route request from where the car is. The caller has checked that one may be sent.
    static func request(_ state: LiveState, _ purpose: RequestPurpose, _ nowMs: Double, _ opts: LiveOptions) -> LiveStep {
        let tracking = state.tracking
        guard let fix = state.lastFix else { return LiveStep(state: state, effects: []) }
        let id = state.nextRequestId
        // On the route: ask from the point on its line, so the fresh routes start on it.
        // Off it (or before there is a route): from the fix itself.
        let origin: LngLat = tracking != nil && purpose == .poll ? tracking!.position : LngLat(fix.lng, fix.lat)
        let headingDeg: Double?
        if let tracking {
            headingDeg = headingFor(tracking, opts)
        } else if let speed = fix.speedMps, speed >= opts.minHeadingSpeedMps, let heading = fix.headingDeg, heading.isFinite {
            headingDeg = heading
        } else {
            headingDeg = nil
        }
        var next = state
        next.request = LiveState.Request(
            id: id,
            purpose: purpose,
            sentAtMs: nowMs,
            alongM: tracking?.alongRouteM ?? 0,
            distanceFromRouteM: tracking?.distanceFromRouteM ?? 0
        )
        next.nextRequestId = JS.increment(id)
        next.requestsUsed = JS.increment(state.requestsUsed)
        next.lastRequestAtMs = nowMs
        next.recheck = false
        let allowed = purpose == .poll
            ? Probe.checkProbeAllowance(
                requestsUsed: Double(state.requestsUsed) + 1,
                probesUsed: Double(state.probes.used),
                maxRequests: opts.maxRequests,
                budget: opts.probes
            )
            : 0
        let effect = LiveRouteRequest(
            requestId: id,
            purpose: purpose,
            origin: origin,
            headingDeg: headingDeg,
            // Room for this request and one more within the budget of ordinary checks.
            baseline: purpose == .poll && Double(state.requestsUsed) + 2 <= opts.maxRequests,
            probes: LiveProbeLeave(allowed: allowed, memory: state.probes, budget: opts.probes.resolved())
        )
        return LiveStep(state: next, effects: [.requestRoutes(effect)])
    }

    /// After anything that may make a check due: sends one when the poll rule says so.
    static func maybePoll(_ step: LiveStep, _ nowMs: Double, _ opts: LiveOptions) -> LiveStep {
        if livePollGate(step.state, nowMs, options: opts) != .due { return step }
        let sent = request(step.state, .poll, nowMs, opts)
        return LiveStep(state: sent.state, effects: step.effects + sent.effects)
    }

    static func arrive(_ state: LiveState, _ nowMs: Double) -> LiveStep {
        let summary = LiveSummary(
            tripSec: JS.max(0, (nowMs - (state.startedAtMs ?? nowMs)) / 1000),
            switches: state.switches,
            declined: state.declinedSwitches,
            requestsUsed: state.requestsUsed
        )
        var next = state
        next.status = .arrived
        next.summary = summary
        next.request = nil
        next.turn = nil
        next.switchBanner = nil
        next.undo = nil
        next.pausedNote = nil
        return LiveStep(state: next, effects: stopEffects + [.speak(line: SpokenLine(text: arrivalLine(summary), priority: .urgent))])
    }

    /// A good fix while driving: where is the car now, and what follows from that.
    static func drive(_ state: LiveState, _ fix: PositionFix, _ nowMs: Double, _ opts: LiveOptions) -> LiveStep {
        let route = state.route!
        guard let tracking = Tracking.trackFix(state.tracking, TrackedRoute(route.geometry), fix, options: opts.tracking) else {
            return LiveStep(state: state, effects: [])
        }
        var next = state
        next.tracking = tracking
        next.lastFix = tracking.fix
        next.gpsNote = nil
        if tracking.arrived { return arrive(next, nowMs) }

        var effects: [LiveEffect] = []
        if tracking.offRoute {
            let firstWord = !next.offRouteNotified
            if firstWord {
                next.offRouteNotified = true
                next.switchBanner = nil
                next.undo = nil
                // Must be heard: the "New route" line that follows within a second or two would
                // otherwise take its place in the queue, and the driver would never hear why.
                effects.append(.speak(line: SpokenLine(text: Spoken.offRoute, priority: .urgent, mustHear: true)))
            }
            // A new route at once, the first time, whatever was asked a moment ago. If the car is
            // still off after that (a car park, a road the map does not know), again only every
            // replanGapSec, and not while it stands still.
            let sinceRequestSec = next.lastRequestAtMs.map { (nowMs - $0) / 1000 } ?? .infinity
            let parked = tracking.stoppedSinceMs.map { (nowMs - $0) / 1000 > opts.stationaryPauseSec } ?? false
            let again = next.offRouteReplans > 0 && next.request == nil && sinceRequestSec >= opts.replanGapSec && !parked
            let inBudget = Double(next.requestsUsed) < opts.maxRequests + opts.offRouteReserve
            if inBudget && next.hiddenSinceMs == nil && (next.offRouteReplans == 0 || again) {
                if next.request != nil { effects.append(.cancelRequest) }
                var asking = next
                asking.request = nil
                asking.offRouteReplans = JS.increment(next.offRouteReplans)
                let sent = request(asking, .replan, nowMs, opts)
                return LiveStep(state: sent.state, effects: effects + sent.effects)
            }
            return LiveStep(state: next, effects: effects)
        }
        if tracking.offFixes == 0 {
            if next.offRouteNotified || next.offRouteReplans > 0 {
                next.offRouteNotified = false
                next.offRouteReplans = 0
            }
            let due = Guidance.dueAnnouncement(route.guidance, next.guidance, tracking.alongRouteM)
            // By value: the TS hands back the same cursor object exactly when it is unchanged.
            if due.cursor != next.guidance { next.guidance = due.cursor }
            if let say = due.say {
                effects.append(.speak(line: SpokenLine(text: say.text, priority: .turn, distanceToManeuverM: say.distanceToManeuverM)))
            }
        }
        return maybePoll(LiveStep(state: next, effects: effects), nowMs, opts)
    }

    /// The drive begins on `route`, from `fix`. `checkedAtMs`: when its travel times
    /// came, the drive's last check (the plan's answer for a picked route).
    static func begin(_ state: LiveState, _ route: RouteCandidate, _ candidates: [RouteCandidate], _ fix: PositionFix, _ nowMs: Double, _ opts: LiveOptions, checkedAtMs: Double? = nil) -> LiveStep {
        var started = state
        started.status = .driving
        started.picked = nil
        started.pickedAtMs = nil
        started.route = route
        started.tracking = nil
        started.request = nil
        started.candidates = candidates
        started.lastCheckedAtMs = checkedAtMs ?? nowMs
        started.eta = LiveState.Eta(durationSec: route.durationSec, remainingM: route.distanceM)
        started.guidance = Guidance.armGuidance(route.guidance, 0, speakDue: true)
        started.lastDecision = nil
        let step = drive(started, fix, nowMs, opts)
        return LiveStep(state: step.state, effects: [.followRoute(geometry: route.geometry)] + step.effects)
    }

    /// The first good fix, with a route picked on the plan screen: the drive starts
    /// on that route, with no request, when the fix is on its line (the tracker's
    /// own test, within its offRouteM). Nil when it is not: the car is somewhere
    /// else, and a route is asked for from there as without a pick.
    static func startOnPicked(_ state: LiveState, _ fix: PositionFix, _ nowMs: Double, _ opts: LiveOptions) -> LiveStep? {
        guard let picked = state.picked else { return nil }
        guard let onIt = Tracking.trackFix(nil, TrackedRoute(picked.geometry), fix, options: opts.tracking), onIt.offFixes <= 0 else { return nil }
        var located = state
        located.lastFix = fix
        located.gpsNote = nil
        // The plan's answer is the last check, as old as it is (#71): "checked N s ago" tells the
        // truth from the start, and a plan older than the poll interval is checked at once.
        let checkedAtMs = state.pickedAtMs.map { JS.min($0, nowMs) } ?? nowMs
        return begin(located, picked, [picked], fix, nowMs, opts, checkedAtMs: checkedAtMs)
    }

    /// The first route has come back.
    static func planned(_ state: LiveState, _ routes: [RouteCandidate]?, _ message: String?, _ nowMs: Double, _ opts: LiveOptions) -> LiveStep {
        let best = routes.flatMap { Rank.rankRoutes($0).first?.route }
        guard let routes, let best, let fix = state.lastFix else {
            return fail(state, "Could not find a route from here. \(message ?? "Try again in a moment.")")
        }
        return begin(state, best, routes, fix, nowMs, opts)
    }

    /// What a request given up on (requestTimeoutSec) is answered with: the same as a failed answer.
    public static let requestTimedOut = "The route request timed out."

    /// The request that is out has had requestTimeoutSec: it is cancelled, and its answer is
    /// taken to be a failure (no routes), exactly as if it had failed.
    static func timedOut(_ state: LiveState, _ nowMs: Double, _ opts: LiveOptions) -> LiveStep {
        guard let request = state.request else { return LiveStep(state: state, effects: []) }
        // planned's failure already cancels the request (the stop effects).
        if request.purpose == .plan { return planned(state, nil, requestTimedOut, nowMs, opts) }
        if state.status != .driving || state.route == nil || state.tracking == nil {
            var next = state
            next.request = nil
            return LiveStep(state: next, effects: [.cancelRequest])
        }
        // Its probes the shell reported sending are made and counted already; nothing more came of them.
        let probesSent = request.probesSent ?? 0
        let step = checked(state, nil, requestTimedOut, nil, probesSent, probesSent, nowMs, opts)
        return LiveStep(state: step.state, effects: [.cancelRequest] + step.effects)
    }

    /// A check, or a search for a new route, has come back.
    static func checked(
        _ state: LiveState,
        _ routes: [RouteCandidate]?,
        _ message: String?,
        _ baseline: [RouteCandidate]?,
        _ probes: Int,
        _ probesCounted: Int,
        _ nowMs: Double,
        _ opts: LiveOptions
    ) -> LiveStep {
        let sent = state.request!
        let route = state.route!
        let tracking = state.tracking!
        let nowSec = (nowMs - (state.startedAtMs ?? nowMs)) / 1000
        // The TS reads the given value (`?? default`) without resolving it; so does this.
        let rerouteOffRouteM = opts.reroute.offRouteM
        let decision = Reroute.decideReroute(
            state.engine,
            RerouteObservation(
                nowSec: nowSec,
                route: DrivenRoute(route),
                positionAlongM: sent.alongM,
                speedMps: tracking.speedMps,
                candidates: routes,
                // The tracker's verdict, not one reading: only a search for a new route says "off",
                // and only while the car is still off the line when it is answered. Answered once
                // the car is back on, it goes through the usual rules like any check.
                offRouteM: sent.purpose == .replan && tracking.offFixes > 0 ? JS.max(sent.distanceFromRouteM, rerouteOffRouteM + 1) : 0,
                baseline: baseline,
                // The answer is used where the car is now, not where it was asked from (a slow answer, a probe).
                drivenSinceM: JS.max(0, tracking.alongRouteM - sent.alongM)
            ),
            options: opts.reroute
        )
        let reason = routes == nil && message != nil ? "\(decision.reason) (\(message!))" : decision.reason
        var next = state
        next.request = nil
        next.engine = decision.nextState
        next.probes = Probe.rememberCheckProbes(state.probes, probes, decision, routes, alreadyCounted: probesCounted)
        next.lastDecision = LiveState.Decision(action: decision.action, code: .reroute(decision.code), reason: reason, atMs: nowMs)
        guard let routes else { return LiveStep(state: next, effects: []) }

        next.candidates = routes
        next.lastCheckedAtMs = nowMs
        // By id, as the TS: the candidate the engine chose among this check's routes.
        let chosen = decision.action == .switchRoute
            ? routes.first { c in decision.toRouteId.map { JS.Key(c.id) == JS.Key($0) } ?? false }
            : nil
        guard let chosen else {
            let pending = decision.code == .confirming || decision.code == .cooldown
            if let current = decision.current {
                next.eta = LiveState.Eta(durationSec: current.durationSec, remainingM: current.distanceM)
            }
            next.turn = decision.considered.flatMap { pending ? LiveState.Turn(at: $0.turnAt, pending: true) : nil }
            return LiveStep(state: next, effects: [])
        }

        let offRoute = decision.code == .offRoute
        // A second new route in one excursion (still off the first) is taken without another word.
        let quiet = offRoute && state.offRouteReplans > 1
        let saving = decision.considered?.savingSec
        let sideStreet = chosen.source == .probe
        let onNew = Tracking.retrack(tracking, TrackedRoute(chosen.geometry), options: opts.tracking)
        let made = LiveSwitch(atMs: nowMs, code: decision.code, reason: decision.reason, savingSec: offRoute ? nil : saving)
        next.route = chosen
        next.tracking = onNew
        next.guidance = Guidance.armGuidance(chosen.guidance, onNew.alongRouteM, speakDue: false)
        next.eta = LiveState.Eta(durationSec: chosen.durationSec, remainingM: chosen.distanceM)
        next.turn = decision.considered.map { LiveState.Turn(at: $0.turnAt, pending: false) }
        next.switches = quiet ? state.switches : state.switches + [made]
        let bannerText: String
        if offRoute {
            bannerText = "New route from here"
        } else if let saving {
            bannerText = "Switched to a faster route\(sideStreet ? " via side streets" : ""): saves \(Reroute.spokenDuration(saving))"
        } else {
            bannerText = "Switched routes: the road ahead looks closed"
        }
        next.switchBanner = quiet ? nil : LiveState.SwitchBanner(untilMs: nowMs + opts.switchBannerSec * 1000, text: bannerText, canKeep: !offRoute)
        // Off the route there is no previous route to keep.
        next.undo = offRoute ? nil : LiveState.Undo(route: route, alongM: tracking.alongRouteM, engine: state.engine, eta: state.eta)
        let say = LiveEffect.speak(line: SpokenLine(
            text: switchLine(decision.code, saving, decision.considered?.turnInM, chosen.durationSec, sideStreet: sideStreet),
            priority: .urgent
        ))
        return LiveStep(state: next, effects: [.followRoute(geometry: chosen.geometry)] + (quiet ? [] : [say]))
    }

    /// One step of the live drive: the state after `event`, and what the shell
    /// has to do about it. Never throws; an event that does not apply to the
    /// present state changes nothing. See src/core/live.ts for the rules of each event.
    public static func liveStep(_ state: LiveState, _ event: LiveEvent, options: LiveOptions = .default) -> LiveStep {
        let opts = options.resolved()
        let active = state.status == .locating || state.status == .planning || state.status == .driving
        let unchanged = LiveStep(state: state, effects: [])
        switch event {
        case let .start(nowMs, destination, route, routeFetchedAtMs):
            if active { return unchanged }
            var next = LiveState.idle
            next.status = .locating
            next.destination = destination
            next.startedAtMs = nowMs
            next.picked = drivable(route) ? route : nil
            next.pickedAtMs = drivable(route) ? routeFetchedAtMs.flatMap { $0.isFinite ? $0 : nil } : nil
            next.muted = state.muted
            return LiveStep(state: next, effects: [
                .setMuted(muted: state.muted),
                .primeSpeech(text: Spoken.started),
                .watchPosition,
                .acquireWakeLock,
            ])

        case .end:
            if state.status == .idle { return unchanged }
            var next = LiveState.idle
            next.muted = state.muted
            return LiveStep(state: next, effects: stopEffects + [.stopSpeaking])

        case let .mute(muted):
            var next = state
            next.muted = muted
            return LiveStep(state: next, effects: [.setMuted(muted: muted)])

        case let .wakeLock(result):
            // A lock the system took away ('released': the page went into the background) is asked for again on return.
            var next = state
            next.wakeLock = result.status
            return LiveStep(state: next, effects: [])

        case let .positionError(_, kind):
            if !active { return unchanged }
            let message = kind.message
            if kind.isFatal { return fail(state, message) }
            var next = state
            next.gpsNote = message
            return LiveStep(state: next, effects: [])

        case let .fix(nowMs, fix):
            if !active { return unchanged }
            if !Tracking.isUsableFix(fix, options: opts.tracking) {
                // The TS reads the given value (`?? default`) without resolving it; so does this.
                let limitM = opts.tracking.maxAccuracyM
                var next = state
                next.gpsNote = state.status == .locating ? "Waiting for a better position fix (within \(JS.string(limitM)) m)." : state.gpsNote
                if var tracking = state.tracking {
                    tracking.ignoredFixes = JS.increment(tracking.ignoredFixes)
                    next.tracking = tracking
                }
                return LiveStep(state: next, effects: [])
            }
            if state.status == .locating {
                if let onPicked = startOnPicked(state, fix, nowMs, opts) { return onPicked }
                var located = state
                located.status = .planning
                located.lastFix = fix
                located.gpsNote = nil
                return request(located, .plan, nowMs, opts)
            }
            if state.status == .planning {
                var next = state
                next.lastFix = fix
                next.gpsNote = nil
                return LiveStep(state: next, effects: [])
            }
            return drive(state, fix, nowMs, opts)

        case let .routes(nowMs, requestId, routes, message, baseline, requests, probes):
            guard let out = state.request, out.id == requestId else { return unchanged }
            if out.purpose == .plan { return planned(state, routes, message, nowMs, opts) }
            if state.status != .driving || state.route == nil || state.tracking == nil {
                var next = state
                next.request = nil
                return LiveStep(state: next, effects: [])
            }
            // More requests made for this answer (the current path's own travel time, side-street probes) count
            // too: those the shell reported as it sent them already are, the rest are counted now.
            // (The TS rounds `requests` and `probes`; here they are whole numbers already.)
            let sentExtra = out.extraSent ?? 0
            let sentProbes = out.probesSent ?? 0
            let asked = requests ?? 1
            let extra = asked <= 1 ? 0 : max(0, (asked - 1) - sentExtra)
            var counted = state
            if extra != 0 { counted.requestsUsed = add(state.requestsUsed, extra) }
            let probesMade = max(0, probes ?? 0)
            return checked(counted, routes, message, baseline, probesMade, sentProbes, nowMs, opts)

        case let .requestSent(requestId, probe):
            if !active { return unchanged }
            var next = state
            next.requestsUsed = JS.increment(state.requestsUsed)
            if probe { next.probes.used = JS.increment(state.probes.used) }
            if var out = state.request, out.id == requestId {
                out.extraSent = JS.increment(out.extraSent ?? 0)
                out.probesSent = add(out.probesSent ?? 0, probe ? 1 : 0)
                next.request = out
            }
            return LiveStep(state: next, effects: [])

        case let .keepPrevious(nowMs):
            guard state.status == .driving, let undo = state.undo, let route = state.route, let tracking = state.tracking, state.switchBanner != nil else {
                return unchanged
            }
            let nowSec = (nowMs - (state.startedAtMs ?? nowMs)) / 1000
            // The TS reads the given value (`?? default`) without resolving it; so does this.
            let noReturnSec = opts.reroute.noReturnSec
            let back = Tracking.retrack(tracking, TrackedRoute(undo.route.geometry), options: opts.tracking, hintAlongM: undo.alongM)
            var next = state
            next.route = undo.route
            next.tracking = back
            next.engine = Reroute.declineRoute(undo.engine, Geo.lineFrom(route.geometry, tracking.alongRouteM), untilSec: nowSec + noReturnSec)
            // The engine's confirmation is dropped, and with it the probe being confirmed.
            next.probes.keep = nil
            next.guidance = Guidance.armGuidance(undo.route.guidance, back.alongRouteM, speakDue: false)
            next.eta = undo.eta
            next.turn = nil
            // The check that is out is cancelled below; its answer will never come.
            next.request = nil
            next.switchBanner = nil
            next.undo = nil
            next.switches = Array(state.switches.dropLast())
            next.declinedSwitches = JS.increment(state.declinedSwitches)
            next.lastDecision = LiveState.Decision(action: .stay, code: .keptPrevious, reason: "Staying: you chose to keep the previous route", atMs: nowMs)
            // A check that is out was asked about the route just left behind.
            let cancel: [LiveEffect] = state.request == nil ? [] : [.cancelRequest]
            return LiveStep(state: next, effects: cancel + [
                .followRoute(geometry: undo.route.geometry),
                .speak(line: SpokenLine(text: Spoken.keptPrevious, priority: .urgent)),
            ])

        case let .visibility(nowMs, hidden):
            if !active { return unchanged }
            if hidden {
                var next = state
                if state.hiddenSinceMs == nil { next.hiddenSinceMs = nowMs }
                return LiveStep(state: next, effects: [])
            }
            guard let hiddenSinceMs = state.hiddenSinceMs else { return LiveStep(state: state, effects: [.acquireWakeLock]) }
            let seconds = JS.round((nowMs - hiddenSinceMs) / 1000)
            let long = seconds >= opts.hiddenNoteMinSec
            var back = state
            back.hiddenSinceMs = nil
            if long { back.pausedNote = LiveState.PausedNote(seconds: seconds, untilMs: nowMs + opts.pausedNoteSec * 1000) }
            back.recheck = state.recheck || (long && state.status == .driving)
            return maybePoll(LiveStep(state: back, effects: [.acquireWakeLock]), nowMs, opts)

        case let .tick(nowMs):
            if !active { return unchanged }
            var next = state
            if let banner = next.switchBanner, nowMs >= banner.untilMs {
                next.switchBanner = nil
                next.undo = nil
            }
            if let note = next.pausedNote, nowMs >= note.untilMs { next.pausedNote = nil }
            if let request = next.request, nowMs - request.sentAtMs >= opts.requestTimeoutSec * 1000 {
                return maybePoll(timedOut(next, nowMs, opts), nowMs, opts)
            }
            return maybePoll(LiveStep(state: next, effects: []), nowMs, opts)
        }
    }

    public static func liveView(_ state: LiveState, _ nowMs: Double, options: LiveOptions = .default) -> LiveView {
        let opts = options.resolved()
        let tracking = state.tracking
        let route = state.route
        let remainingM = tracking?.remainingM
        var remainingSec: Double?
        if let remainingM, let eta = state.eta {
            remainingSec = eta.remainingM > 0 ? eta.durationSec * JS.min(1, remainingM / eta.remainingM) : 0
        }
        let gate = livePollGate(state, nowMs, options: opts)
        let offRoute = tracking?.offRoute ?? false

        let statusLine: String
        if state.status == .locating {
            statusLine = "Finding your position…"
        } else if state.status == .planning {
            statusLine = "Finding a route…"
        } else if state.status == .failed {
            statusLine = state.message ?? "The drive could not go on."
        } else if state.status == .arrived {
            statusLine = "Arrived"
        } else if offRoute {
            statusLine = "Off the route. Finding a new one…"
        } else if gate == .budgetSpent {
            statusLine = "Request budget used up (\(JS.string(opts.maxRequests))): driving on without checking for faster routes."
        } else if gate == .stationary {
            statusLine = "Standing still: checks are paused until you move."
        } else if gate == .noFix {
            statusLine = "Waiting for a position fix…"
        } else {
            statusLine = state.lastDecision?.reason ?? "Watching for a faster route."
        }

        var warnings: [String] = []
        if let note = state.pausedNote { warnings.append("RouteIQ was paused for \(JS.string(note.seconds)) s while in the background.") }
        if let gps = state.gpsNote, state.status != .failed { warnings.append(gps) }
        if state.wakeLock == .unavailable { warnings.append(wakeLockWarning) }

        var nextTurn: NextTurn?
        if let route, let tracking, !offRoute { nextTurn = Guidance.nextTurn(route.guidance, tracking.alongRouteM) }

        return LiveView(
            status: state.status,
            nextTurn: nextTurn,
            remainingM: remainingM,
            remainingSec: remainingSec,
            arrivalAtMs: remainingSec.map { nowMs + $0 * 1000 },
            statusLine: statusLine,
            checkedAgoSec: state.lastCheckedAtMs.map { JS.max(0, JS.round((nowMs - $0) / 1000)) },
            checking: state.request != nil,
            offRoute: offRoute,
            warnings: warnings,
            requestsUsed: state.requestsUsed,
            maxRequests: opts.maxRequests
        )
    }
}
