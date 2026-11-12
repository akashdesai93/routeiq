import Foundation

// Side-street probing (PLAN step 11), ported from src/core/probe.ts.
//
// Mapbox Directions returns at most three routes, so a faster cut-through that
// is not among them is never seen. selectViaPoints picks a few points just off
// the fastest route's surface-street stretches (aimed at its jams when the
// route carries live traffic); asking for origin -> via -> destination can then
// surface a parallel street. The rest: how many probes a plan or a drive may
// make, how probed routes join the provider's, and what a drive remembers.
// Pure and deterministic.

public struct ProbeOptions: Hashable, Sendable {
    /// Most via points returned. Each one costs a Directions request later.
    public var maxPoints: Int
    /// Trips shorter than this (meters, fastest route) get no probes.
    public var minTripM: Double
    /// No probing within this many meters of the origin or destination.
    public var endpointClearanceM: Double
    /// A surface-street stretch (after the endpoint clearance) must be at least this long, in meters.
    public var minStretchM: Double
    /// Perpendicular distances from the route tried for each side, in meters, nearest first.
    public var offsetsM: [Double]
    /// A via point closer than this (meters) to any candidate's line is dropped.
    public var clearOfRoutesM: Double
    /// The route heading at a probe spot is taken over this many meters before and after it.
    public var headingWindowM: Double
    /// How far Mapbox may move the via point to snap it onto a road, in meters (its `radiuses` entry).
    public var viaRadiusM: Double
    /// A probed route covering a known route, sampled this often (meters), is that route plus a detour.
    public var coverSampleM: Double
    /// Congestion levels that count as a jam worth going round. Unknown never does.
    public var congestedLevels: [CongestionLevel]
    /// Congested runs this close together or closer, in meters, are one jam.
    public var congestionGapM: Double
    /// A stretch is aimed at by the data only when at least this much of it, in meters, is congested.
    public var minCongestedM: Double

    public init(
        maxPoints: Int = 3,
        minTripM: Double = 3000,
        endpointClearanceM: Double = 1000,
        minStretchM: Double = 1500,
        offsetsM: [Double] = [500, 800],
        clearOfRoutesM: Double = 250,
        headingWindowM: Double = 150,
        viaRadiusM: Double = 250,
        coverSampleM: Double = 10,
        congestedLevels: [CongestionLevel] = [.heavy, .severe],
        congestionGapM: Double = 200,
        minCongestedM: Double = 300
    ) {
        self.maxPoints = maxPoints
        self.minTripM = minTripM
        self.endpointClearanceM = endpointClearanceM
        self.minStretchM = minStretchM
        self.offsetsM = offsetsM
        self.clearOfRoutesM = clearOfRoutesM
        self.headingWindowM = headingWindowM
        self.viaRadiusM = viaRadiusM
        self.coverSampleM = coverSampleM
        self.congestedLevels = congestedLevels
        self.congestionGapM = congestionGapM
        self.minCongestedM = minCongestedM
    }

    public static let `default` = ProbeOptions()
}

/// Which side of the base route, facing the direction of travel.
public enum ProbeSide: String, Hashable, Sendable {
    case left
    case right
}

/// One place to route through, and why.
public struct ViaPoint: Hashable, Sendable {
    public var position: LngLat
    /// Plain-English line for logs and the UI.
    public var reason: String
    /// Id of the candidate the point was placed off.
    public var baseRouteId: String
    /// The surface-street stretch of the base route it targets, in meters from the route start.
    public var targetSpanM: DistanceSpanM
    /// Where along the base route the point sits beside, in meters from the route start.
    public var atDistanceM: Double
    public var side: ProbeSide
    /// Perpendicular distance from the base route, in meters (one of options.offsetsM).
    public var offsetM: Double
    /// The jam the point is aimed at, inside targetSpanM. Nil when placed without traffic data.
    public var congestedSpanM: DistanceSpanM?
}

/// How many probe requests a plan may make, and when.
public struct ProbeBudget: Hashable, Sendable {
    /// Most probe requests per plan. A fraction is rounded down; under 1, or not finite, turns probing off.
    public var requestsPerPlan: Double
    /// How long the main routes must stay on screen before the probes go out, in milliseconds.
    public var debounceMs: Double

    public init(requestsPerPlan: Double = 2, debounceMs: Double = 800) {
        self.requestsPerPlan = requestsPerPlan
        self.debounceMs = debounceMs
    }

    public static let `default` = ProbeBudget()
}

/// How many side-street probes a drive may make (PLAN step 11c, #5).
public struct DriveProbeBudget: Hashable, Sendable {
    /// Most probe requests per check. Rounded down; under 1, or not finite, turns probing off during a drive.
    public var requestsPerCheck: Double
    /// Most probe requests per drive.
    public var requestsPerDrive: Double
    /// A check probes only when the route being driven is held up: a jam ahead, or this many seconds over its typical time.
    public var minDelaySec: Double
    /// How long a check's probes (and their path check) may take in all, in seconds.
    public var timeoutSec: Double
    /// Before a probe, one request per poll interval until the expected arrival, times this
    /// factor, is kept back for the plain checks, so the drive never goes blind (#183).
    public var arrivalReserve: Double
    /// Requests kept back on top of the plain checks: for the odd plain check that needs its path check.
    public var reserveMargin: Double

    public init(requestsPerCheck: Double = 1, requestsPerDrive: Double = 20, minDelaySec: Double = 120, timeoutSec: Double = 8, arrivalReserve: Double = 1, reserveMargin: Double = 3) {
        self.requestsPerCheck = requestsPerCheck
        self.requestsPerDrive = requestsPerDrive
        self.minDelaySec = minDelaySec
        self.timeoutSec = timeoutSec
        self.arrivalReserve = arrivalReserve
        self.reserveMargin = reserveMargin
    }

    public static let `default` = DriveProbeBudget()

    /// A delay or timeout that is not a number of 0 or more falls back to its default. The request counts are taken as given.
    public func resolved() -> DriveProbeBudget {
        let d = DriveProbeBudget.default
        func n(_ v: Double, _ fallback: Double) -> Double { v.isFinite && v >= 0 ? v : fallback }
        return DriveProbeBudget(
            requestsPerCheck: requestsPerCheck,
            requestsPerDrive: requestsPerDrive,
            minDelaySec: n(minDelaySec, d.minDelaySec),
            timeoutSec: n(timeoutSec, d.timeoutSec),
            arrivalReserve: n(arrivalReserve, d.arrivalReserve),
            reserveMargin: n(reserveMargin, d.reserveMargin)
        )
    }
}

/// What a drive remembers about its probes between checks. Plain data: keep it, pass it back.
public struct CheckProbeMemory: Hashable, Sendable {
    /// Probe requests made so far on this drive.
    public var used: Int
    /// Checks that made a probe so far: which via point comes first next time.
    public var round: Int
    /// The via point of the probed route the reroute engine is confirming. Nil when there is none.
    public var keep: LngLat?

    public init(used: Int = 0, round: Int = 0, keep: LngLat? = nil) {
        self.used = used
        self.round = round
        self.keep = keep
    }

    public static let initial = CheckProbeMemory()
}

public struct CheckProbeInput: Sendable {
    /// The route being driven, and how far along it the check was asked from.
    public var route: [LngLat]
    public var alongM: Double
    /// The check's fresh routes, from the car.
    public var fresh: [RouteCandidate]
    /// The answer to the check's request for the current path itself, when one was made.
    public var baseline: [RouteCandidate]?
    public var memory: CheckProbeMemory
    /// How many probe requests this check may make (checkProbeAllowance).
    public var allowed: Double
    /// The engine's thresholds in use, so the current route is found as the engine finds it.
    public var rerouteOptions: RerouteOptions
    /// For minDelaySec.
    public var budget: DriveProbeBudget

    public init(
        route: [LngLat],
        alongM: Double,
        fresh: [RouteCandidate],
        baseline: [RouteCandidate]? = nil,
        memory: CheckProbeMemory,
        allowed: Double,
        rerouteOptions: RerouteOptions = .default,
        budget: DriveProbeBudget = .default
    ) {
        self.route = route
        self.alongM = alongM
        self.fresh = fresh
        self.baseline = baseline
        self.memory = memory
        self.allowed = allowed
        self.rerouteOptions = rerouteOptions
        self.budget = budget
    }
}

public enum Probe {
    static func usable(_ c: RouteCandidate) -> Bool {
        c.durationSec.isFinite && c.geometry.count >= 2 && c.geometry.allSatisfy(Geo.isValidLngLat)
    }

    /// Position of the fastest usable candidate; ties go to the smaller id so the choice never depends on input order.
    static func fastest(_ candidates: [RouteCandidate]) -> Int? {
        var best: Int?
        for (i, c) in candidates.enumerated() where usable(c) {
            guard let b = best else { best = i; continue }
            let bc = candidates[b]
            if c.durationSec < bc.durationSec || (c.durationSec == bc.durationSec && JS.less(c.id, bc.id)) { best = i }
        }
        return best
    }

    /// The parts of [fromM, toM] not covered by the limited-access spans.
    /// Unknown road kinds (nil spans) count as surface street; a span with a
    /// NaN bound, or one that covers nothing, is ignored.
    static func surfaceStretches(_ spans: [DistanceSpanM]?, _ fromM: Double, _ toM: Double) -> [DistanceSpanM] {
        var out: [DistanceSpanM] = []
        var cursor = fromM
        let sorted = (spans ?? []).filter { $0.endM > $0.startM }.jsSorted { JS.sign($0.startM - $1.startM) }
        for span in sorted {
            if span.startM > cursor { out.append(DistanceSpanM(cursor, JS.min(span.startM, toM))) }
            cursor = JS.max(cursor, span.endM)
            if cursor >= toM { break }
        }
        if cursor < toM { out.append(DistanceSpanM(cursor, toM)) }
        return out.filter { $0.endM > $0.startM }
    }

    /// The congested runs of a route, in driving order, runs `gapM` or less apart joined.
    /// Empty without a congestion list of exactly one entry per segment.
    static func congestedRuns(_ route: RouteCandidate, _ along: [Double], _ levels: [CongestionLevel], _ gapM: Double) -> [DistanceSpanM] {
        guard let congestion = route.segmentTraffic?.congestion, congestion.count == route.geometry.count - 1 else { return [] }
        let gap = gapM.isFinite && gapM > 0 ? gapM : 0
        var runs: [DistanceSpanM] = []
        for (i, level) in congestion.enumerated() {
            // Unknown is never a jam, even when listed.
            if level == .unknown || !levels.contains(level) { continue }
            let start = along[i]
            let end = along[i + 1]
            if let last = runs.last, start - last.endM <= gap {
                runs[runs.count - 1] = DistanceSpanM(last.startM, end)
            } else {
                runs.append(DistanceSpanM(start, end))
            }
        }
        return runs.filter { $0.endM > $0.startM }
    }

    /// The parts of `runs` inside `span`, clipped to it.
    static func within(_ runs: [DistanceSpanM], _ span: DistanceSpanM) -> [DistanceSpanM] {
        runs.map { DistanceSpanM(JS.max($0.startM, span.startM), JS.min($0.endM, span.endM)) }.filter { $0.endM > $0.startM }
    }

    static func spanLength(_ s: DistanceSpanM) -> Double { s.endM - s.startM }

    /// Shortest distance from a point to a polyline, in meters. A single-point line is that point.
    static func distanceToLineM(_ point: LngLat, _ line: [LngLat]) -> Double {
        if line.isEmpty { return .infinity }
        if line.count == 1 { return Geo.distanceM(point, line[0]) }
        let project = Geo.localProjector(point)
        let p = project(point)
        var best = Double.infinity
        for i in 1..<line.count {
            best = JS.min(best, Geo.pointToSegment(p, project(line[i - 1]), project(line[i])).distanceM)
        }
        return best
    }

    /// The point `offsetM` meters to one side of `p`, square to the heading.
    static func offsetPoint(_ p: LngLat, _ headingDeg: Double, _ side: ProbeSide, _ offsetM: Double) -> LngLat {
        let per = Geo.localProjector(p)(LngLat(p.lng + 1, p.lat + 1))
        let normal = (headingDeg + (side == .left ? -90 : 90)) * Double.pi / 180
        return LngLat(p.lng + sin(normal) * offsetM / per.x, p.lat + cos(normal) * offsetM / per.y)
    }

    static func km(_ m: Double) -> String { "\(JS.toFixed(m / 1000, 1)) km" }

    /// Up to `options.maxPoints` via points off the fastest candidate's
    /// slowest surface-street stretches, best first (see src/core/probe.ts).
    /// `base`, when given and usable, is the route to probe beside instead of
    /// the fastest. Swift values have no identity: `base` is taken to be the
    /// first candidate equal to it, if any (the TypeScript compares objects).
    public static func selectViaPoints(_ candidates: [RouteCandidate], options: ProbeOptions = .default, base: RouteCandidate? = nil) -> [ViaPoint] {
        if let base, usable(base) {
            return selectViaPoints(candidates, options, baseIndex: candidates.firstIndex(of: base), external: base)
        }
        guard let i = fastest(candidates) else { return [] }
        return selectViaPoints(candidates, options, baseIndex: i, external: candidates[i])
    }

    /// `baseIndex`: the base's position in `candidates`, nil when it is not one of them.
    static func selectViaPoints(_ candidates: [RouteCandidate], _ options: ProbeOptions, baseIndex: Int?, external base: RouteCandidate) -> [ViaPoint] {
        if options.maxPoints <= 0 { return [] }
        let along = Geo.alongRouteM(base.geometry)
        let lengthM = along[along.count - 1]
        if lengthM < options.minTripM { return [] }
        let origin = base.geometry[0]
        let destination = base.geometry[base.geometry.count - 1]
        let clear = options.endpointClearanceM
        // Jams (runs joined across short gaps) are what is aimed at; only congested road itself is counted.
        let runs = congestedRuns(base, along, options.congestedLevels, options.congestionGapM)
        let congestedOnly = congestedRuns(base, along, options.congestedLevels, 0)
        let stretches = surfaceStretches(base.limitedAccessSpansM, clear, lengthM - clear)
            .filter { $0.endM - $0.startM >= options.minStretchM }
            .map { span -> (span: DistanceSpanM, jam: DistanceSpanM?, congestedM: Double) in
                let jams = within(runs, span)
                let congestedM = within(congestedOnly, span).reduce(0) { $0 + spanLength($1) }
                // The longest jam; equal ones go to the earlier, so the choice is deterministic.
                let jam = !jams.isEmpty && congestedM >= options.minCongestedM
                    ? jams.dropFirst().reduce(jams[0]) { x, y in spanLength(y) > spanLength(x) ? y : x }
                    : nil
                return (span, jam, jam == nil ? 0 : congestedM)
            }
            .jsSorted { x, y in
                let a = JS.sign(y.congestedM - x.congestedM)
                if a != 0 { return a }
                let b = JS.sign(spanLength(y.span) - spanLength(x.span))
                if b != 0 { return b }
                return JS.sign(x.span.startM - y.span.startM)
            }
        // Only usable lines measure room: one NaN coordinate would make every room NaN and hide the side order.
        let others = candidates.enumerated().filter { $0.offset != baseIndex && usable($0.element) }.map(\.element)
        let known = baseIndex != nil ? candidates : candidates + [base]
        let offsets = options.offsetsM.filter { $0.isFinite && $0 > 0 }.jsSorted { JS.sign($0 - $1) }

        var rounds: [[ViaPoint]] = [[], []]
        for (span, jam, _) in stretches {
            let aim = jam ?? span
            let midM = (aim.startM + aim.endM) / 2
            let here = Geo.pointAtDistance(base.geometry, midM)!
            let mid = here.point
            let before = Geo.pointAtDistance(base.geometry, midM - options.headingWindowM)!.point
            let after = Geo.pointAtDistance(base.geometry, midM + options.headingWindowM)!.point
            // A chord much shorter than the window means a hairpin there: use the segment's own heading.
            let heading = Geo.distanceM(before, after) < options.headingWindowM
                ? here.bearingDeg
                : atan2((after.lng - before.lng) * cos(mid.lat * Double.pi / 180), after.lat - before.lat) * (180 / Double.pi)
            var found: [(point: ViaPoint, roomM: Double)] = []
            for side in [ProbeSide.left, .right] {
                for offsetM in offsets {
                    let position = offsetPoint(mid, heading, side, offsetM)
                    if !Geo.isValidLngLat(position) { continue }
                    if Geo.distanceM(position, origin) < clear || Geo.distanceM(position, destination) < clear { continue }
                    if known.contains(where: { distanceToLineM(position, $0.geometry) < options.clearOfRoutesM }) { continue }
                    let roomM = others.reduce(Double.infinity) { JS.min($0, distanceToLineM(position, $1.geometry)) }
                    let reason = jam.map { j in
                        "\(JS.string(offsetM)) m \(side.rawValue) of the fastest route's \(km(j.endM - j.startM)) jam on surface street "
                            + "(\(km(j.startM)) to \(km(j.endM)) from the start)"
                    } ?? "\(JS.string(offsetM)) m \(side.rawValue) of the fastest route's \(km(span.endM - span.startM)) surface-street stretch "
                        + "(\(km(span.startM)) to \(km(span.endM)) from the start)"
                    found.append((
                        ViaPoint(
                            position: position, reason: reason, baseRouteId: base.id, targetSpanM: span,
                            atDistanceM: midM, side: side, offsetM: offsetM, congestedSpanM: jam
                        ),
                        roomM
                    ))
                    break
                }
            }
            // More room first; equal (or unknown) room keeps left before right.
            for (i, f) in found.jsSorted({ a, b in b.roomM > a.roomM ? 1 : (b.roomM < a.roomM ? -1 : 0) }).enumerated() {
                rounds[i].append(f.point)
            }
        }
        return Array(rounds.flatMap { $0 }.prefix(options.maxPoints))
    }

    /// The via points to probe for one plan: selectViaPoints, cut to the budget.
    public static func planProbes(_ candidates: [RouteCandidate], budget: ProbeBudget = .default, options: ProbeOptions = .default) -> [ViaPoint] {
        let allowed = budget.requestsPerPlan.isFinite ? budget.requestsPerPlan.rounded(.down) : 0
        let maxPoints = JS.min(allowed, Double(options.maxPoints))
        if maxPoints <= 0 { return [] }
        var cut = options
        cut.maxPoints = Int(maxPoints)
        return selectViaPoints(candidates, options: cut)
    }

    /// The line sampled every `sampleM` meters along it, its own vertices included.
    static func sampled(_ line: [LngLat], _ sampleM: Double) -> [LngLat] {
        if !(sampleM.isFinite && sampleM > 0) { return line }
        var out: [LngLat] = []
        for (i, p) in line.enumerated() {
            if i > 0 {
                let prev = line[i - 1]
                let pieces = (Geo.distanceM(prev, p) / sampleM).rounded(.up)
                var k = 1.0
                while k < pieces {
                    out.append(LngLat(prev.lng + (p.lng - prev.lng) * k / pieces, prev.lat + (p.lat - prev.lat) * k / pieces))
                    k += 1
                }
            }
            out.append(p)
        }
        return out
    }

    /// True when `probe` passes within `toleranceM` of every point of `known`,
    /// `known` sampled every `sampleM` meters: the probe drives all of the
    /// known route and something more, so it can only be slower. One-way.
    /// Linear in the routes' length (#93); `meter` counts the work.
    public static func coversRoute(
        _ probe: [LngLat],
        _ known: [LngLat],
        toleranceM: Double = Select.sameRouteToleranceM,
        sampleM: Double = ProbeOptions.default.coverSampleM,
        meter: MatchMeter? = nil
    ) -> Bool {
        if probe.count < 2 || known.count < 2 { return false }
        let project = Geo.localProjector(known[0])
        // Each sample looks only at the probe's segments near it (SegmentGrid), not the whole line.
        return Select.everyPointNear(sampled(known, sampleM).map(project), probe.map(project), toleranceM, meter)
    }

    /// The provider's routes with the probed ones added, each tagged `.probe`
    /// and kept only when it is a new path (not the same roads as a route in
    /// the set, and not covering one). Probes are deduplicated among
    /// themselves, the earlier kept; one with no usable time or line is dropped.
    public static func mergeProbeRoutes(
        _ candidates: [RouteCandidate],
        _ probed: [RouteCandidate],
        toleranceM: Double = Select.sameRouteToleranceM,
        coverSampleM: Double = ProbeOptions.default.coverSampleM,
        meter: MatchMeter? = nil
    ) -> [RouteCandidate] {
        var merged = candidates
        for route in probed {
            if !usable(route) { continue }
            if merged.contains(where: { Select.sameRouteGeometry($0.geometry, route.geometry, toleranceM: toleranceM, meter: meter) }) { continue }
            if merged.contains(where: { usable($0) && coversRoute(route.geometry, $0.geometry, toleranceM: toleranceM, sampleM: coverSampleM, meter: meter) }) { continue }
            var tagged = route
            tagged.source = .probe
            merged.append(tagged)
        }
        return merged
    }

    /// The line to tell the user when a probed route is recommended, from
    /// rankRoutes' order. Nil when the top route is not a probed one, or
    /// there is no provider route to compare it with.
    public static func sideStreetNotice(_ ranked: [RankedRoute]) -> String? {
        guard let top = ranked.first?.route, top.source == .probe else { return nil }
        guard let known = ranked.first(where: { $0.route.source != .probe })?.route else { return nil }
        let savedSec = known.durationSec - top.durationSec
        if !savedSec.isFinite { return nil }
        if savedSec <= 0 {
            // Fewer signals is said only when both counts are whole and known (unknown is never zero).
            func full(_ r: RouteCandidate) -> Int? { r.signalCoverage == .full ? r.signalCount : nil }
            if let t = full(top), let k = full(known), t < k {
                return "Route via side streets recommended: about the same time, fewer signals."
            }
            return "Route via side streets recommended: about the same time."
        }
        let minutes = JS.round(savedSec / 60)
        return minutes < 1
            ? "Faster route found via side streets, saves under a minute."
            : "Faster route found via side streets, saves \(JS.string(minutes)) min."
    }

    /// The TypeScript `whole`: a count rounded down, never below 0; not finite is 0.
    static func whole(_ v: Double) -> Double { v.isFinite ? JS.max(0, v.rounded(.down)) : 0 }

    /// The requests to keep back for the plain checks still due: one per poll
    /// interval of the time left, times arrivalReserve, rounded up. Nil when the
    /// time left is not known: an unknown reserve is never zero (#183).
    public static func plainCheckReserve(remainingSec: Double?, pollIntervalSec: Double, budget: DriveProbeBudget = .default) -> Double? {
        guard let remainingSec, remainingSec.isFinite, pollIntervalSec.isFinite, pollIntervalSec > 0 else { return nil }
        let b = budget.resolved()
        return (JS.max(0, remainingSec) * b.arrivalReserve / pollIntervalSec).rounded(.up) + b.reserveMargin.rounded(.up)
    }

    /// How many probe requests the check being sent may make. `requestsUsed`
    /// counts the drive's requests so far, this check included; `probesUsed`
    /// the probes among them. One request is always left over for the check's
    /// own path check, and `reserve` (plainCheckReserve) for the plain checks
    /// until the arrival; nil allows no probe. Zero once the per-drive cap or
    /// the budget is reached.
    public static func checkProbeAllowance(requestsUsed: Double, probesUsed: Double, maxRequests: Double, budget: DriveProbeBudget = .default, reserve: Double?) -> Int {
        let perCheck = whole(budget.requestsPerCheck)
        let perDrive = whole(budget.requestsPerDrive)
        guard let reserve else { return 0 }
        if ![requestsUsed, probesUsed, maxRequests, reserve].allSatisfy(\.isFinite) { return 0 }
        let room = maxRequests.rounded(.down) - requestsUsed - 1 - JS.max(0, reserve.rounded(.up))
        let allowed = JS.max(0, JS.min(JS.min(perCheck, perDrive - probesUsed), room))
        return allowed >= Double(Int.max) ? Int.max : Int(allowed)
    }

    /// The via points to probe on one check of a drive, at most `allowed`:
    /// selectViaPoints' from the car, beside the route being driven as this
    /// check found it. The kept via of a side street being confirmed comes
    /// first while it is still beside the road ahead; the others take turns,
    /// check by check. Empty when the route is not held up, nothing may be
    /// asked, the current route was not found, or there is nothing to probe.
    public static func checkProbes(_ input: CheckProbeInput, options: ProbeOptions = .default) -> [LngLat] {
        let allowed = whole(input.allowed)
        if allowed <= 0 { return [] }
        let known = (input.fresh + (input.baseline ?? [])).filter(usable)
        if known.isEmpty { return [] }
        // Without the current route's own fresh line the engine compares nothing this check
        // (route-unconfirmed), and a probe could snap back onto the current path. So no probe then.
        guard let baseIndex = Reroute.findCurrentRouteIndex(input.route, positionAlongM: input.alongM, candidates: known, options: input.rerouteOptions) else { return [] }
        let base = known[baseIndex]
        let selected = selectViaPoints(known, options, baseIndex: baseIndex, external: base)
        // Only a route that is held up is worth a probe: a jam ahead on it, or a real delay over its typical time.
        let minDelaySec = input.budget.resolved().minDelaySec
        let delaySec = base.typicalDurationSec.map { base.durationSec - $0 }
        let heldUp = selected.contains { $0.congestedSpanM != nil } || (delaySec.map { $0.isFinite && $0 >= minDelaySec } ?? false)
        if !heldUp { return [] }
        let points = selected.map(\.position)

        var out: [LngLat] = []
        if let keep = input.memory.keep, Geo.isValidLngLat(keep) {
            let lengthM = Geo.alongRouteM(base.geometry).last ?? 0
            let atM = Geo.nearestAlongM(base.geometry, keep)
            let clear = options.endpointClearanceM
            let beside = lengthM >= options.minTripM
                && atM >= clear
                && atM <= lengthM - clear
                && Geo.distanceM(keep, base.geometry[0]) >= clear
                && Geo.distanceM(keep, base.geometry[base.geometry.count - 1]) >= clear
                && !known.contains(where: { distanceToLineM(keep, $0.geometry) < options.clearOfRoutesM })
            if beside { out.append(keep) }
        }
        let kept = out.first
        let others = points.filter { p in kept.map { Geo.distanceM(p, $0) >= options.clearOfRoutesM } ?? true }
        let start = others.isEmpty ? 0 : max(0, input.memory.round) % others.count
        let turn = Array(others[start...] + others[..<start])
        return Array((out + turn).prefix(allowed >= Double(Int.max) ? Int.max : Int(allowed)))
    }

    /// The check's fresh routes with its probed routes added, each new
    /// against the fresh routes AND the answer for the current path itself,
    /// tagged `.probe`. The fresh routes come first, as they came; that
    /// answer is not added.
    public static func mergeCheckProbes(_ fresh: [RouteCandidate], _ baseline: [RouteCandidate]?, _ probed: [RouteCandidate]) -> [RouteCandidate] {
        let known = fresh + (baseline ?? [])
        let added = mergeProbeRoutes(known, probed).dropFirst(known.count)
        return fresh + added
    }

    /// The probe memory after a check has been decided. `asked`: the probe
    /// requests the check made (those not counted yet are added to `used`);
    /// `routes`: the routes the engine was given (nil for a failed check).
    /// The kept via is the one of the probed route the engine is now
    /// confirming or holding; a failed check keeps it; anything else drops it.
    public static func rememberCheckProbes(
        _ memory: CheckProbeMemory,
        _ asked: Int,
        _ decision: RerouteDecision,
        _ routes: [RouteCandidate]?,
        alreadyCounted: Int = 0
    ) -> CheckProbeMemory {
        let made = max(0, asked)
        let uncounted = max(0, made - max(0, alreadyCounted))
        var counted = memory
        counted.used = memory.used + uncounted
        counted.round = made > 0 ? JS.increment(memory.round) : memory.round
        guard let routes else { return counted }
        let pending = decision.action == .stay && decision.nextState.pending != nil ? decision.considered : nil
        let route = pending.flatMap { p in routes.first { $0.id == p.routeId } }
        if let route, route.source == .probe, let via = route.via, Geo.isValidLngLat(via) {
            counted.keep = via
        } else {
            counted.keep = nil
        }
        return counted
    }
}
