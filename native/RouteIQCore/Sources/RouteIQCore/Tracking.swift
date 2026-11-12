import Foundation

// Position tracking for a live drive, ported from src/core/tracking.ts: turns
// the device's raw position fixes into "where on the route is the car": a
// point on the route line, the meters driven along it, a steady speed, a
// heading, and two verdicts that are not given lightly: off the route, and
// arrived. Pure: the state is plain data the caller keeps between fixes, time
// comes in with each fix. A native shell feeds it Core Location fixes unchanged.

/// One reading from a position source (GPS). Kept in memory only, never stored or logged.
public struct PositionFix: Hashable, Sendable {
    public var lng: Double
    public var lat: Double
    /// Radius of the fix in meters (the device's 68% circle). NaN when the device gives none.
    public var accuracyM: Double
    /// Ground speed from the device, in meters per second. Nil when it gives none.
    public var speedMps: Double?
    /// Direction of travel from the device, degrees clockwise from true north. Nil when it gives none.
    public var headingDeg: Double?
    /// When the fix was taken, in milliseconds on a clock that only moves forward.
    public var timeMs: Double

    public init(lng: Double, lat: Double, accuracyM: Double, speedMps: Double?, headingDeg: Double?, timeMs: Double) {
        self.lng = lng
        self.lat = lat
        self.accuracyM = accuracyM
        self.speedMps = speedMps
        self.headingDeg = headingDeg
        self.timeMs = timeMs
    }
}

/// Every threshold of the tracker, in one place. The initializer's defaults are the values.
public struct TrackingOptions: Hashable, Sendable {
    /// A fix whose accuracy radius is larger than this is ignored altogether, in meters.
    public var maxAccuracyM: Double
    /// Farther than this from the route line, a fix is "off the line", in meters.
    public var offRouteM: Double
    /// The driver is off the route once fixes have been off the line for this many seconds...
    public var offRoutePatienceSec: Double
    /// ...or for this many good fixes in a row, whichever comes first. Never on one fix (below 2 counts as 2).
    public var offRouteFixes: Int
    /// Arrived when this close to the destination, along the route or in a straight line, in meters.
    public var arrivalRadiusM: Double
    /// The straight-line arrival test only applies this many meters or less from the route's end.
    public var arrivalZoneM: Double
    /// A fix that snaps up to this many meters behind the last position leaves the position where it was.
    public var backwardToleranceM: Double
    /// A fix that snaps farther back, or farther ahead than the car could have driven, is believed only after this many in a row.
    public var jumpFixes: Int
    /// The fastest the car is taken to move, in meters per second.
    public var maxSpeedMps: Double
    /// A fix may always snap this far ahead of the last position, in meters.
    public var minReachM: Double
    /// Weight of the newest speed reading in the smoothed speed, from 0 to 1.
    public var speedSmoothing: Double
    /// Below this smoothed speed the car counts as standing still, in meters per second.
    public var stoppedSpeedMps: Double

    public init(
        maxAccuracyM: Double = 50,
        offRouteM: Double = 50,
        offRoutePatienceSec: Double = 8,
        offRouteFixes: Int = 3,
        arrivalRadiusM: Double = 40,
        arrivalZoneM: Double = 400,
        backwardToleranceM: Double = 30,
        jumpFixes: Int = 3,
        maxSpeedMps: Double = 50,
        minReachM: Double = 150,
        speedSmoothing: Double = 0.4,
        stoppedSpeedMps: Double = 1
    ) {
        self.maxAccuracyM = maxAccuracyM
        self.offRouteM = offRouteM
        self.offRoutePatienceSec = offRoutePatienceSec
        self.offRouteFixes = offRouteFixes
        self.arrivalRadiusM = arrivalRadiusM
        self.arrivalZoneM = arrivalZoneM
        self.backwardToleranceM = backwardToleranceM
        self.jumpFixes = jumpFixes
        self.maxSpeedMps = maxSpeedMps
        self.minReachM = minReachM
        self.speedSmoothing = speedSmoothing
        self.stoppedSpeedMps = stoppedSpeedMps
    }

    /// The one place the defaults are set.
    public static let `default` = TrackingOptions()

    func resolved() -> TrackingOptions {
        let d = TrackingOptions.default
        func pick(_ v: Double, _ fallback: Double) -> Double { v.isFinite && v >= 0 ? v : fallback }
        func count(_ v: Int, _ fallback: Int, atLeast: Int) -> Int { max(atLeast, v >= 0 ? v : fallback) }
        return TrackingOptions(
            maxAccuracyM: pick(maxAccuracyM, d.maxAccuracyM),
            offRouteM: pick(offRouteM, d.offRouteM),
            offRoutePatienceSec: pick(offRoutePatienceSec, d.offRoutePatienceSec),
            offRouteFixes: count(offRouteFixes, d.offRouteFixes, atLeast: 2),
            arrivalRadiusM: pick(arrivalRadiusM, d.arrivalRadiusM),
            arrivalZoneM: pick(arrivalZoneM, d.arrivalZoneM),
            backwardToleranceM: pick(backwardToleranceM, d.backwardToleranceM),
            jumpFixes: count(jumpFixes, d.jumpFixes, atLeast: 1),
            maxSpeedMps: pick(maxSpeedMps, d.maxSpeedMps),
            minReachM: pick(minReachM, d.minReachM),
            speedSmoothing: min(1, pick(speedSmoothing, d.speedSmoothing)),
            stoppedSpeedMps: pick(stoppedSpeedMps, d.stoppedSpeedMps)
        )
    }
}

/// A route line prepared for tracking: its usable points and the meters along it to each.
public struct TrackedRoute: Hashable, Sendable {
    public let line: [LngLat]
    public let alongM: [Double]
    public let lengthM: Double

    /// Prepares a route geometry for tracking.
    public init(_ geometry: [LngLat]) {
        line = geometry.filter(Geo.isValidLngLat)
        alongM = Geo.alongRouteM(line)
        lengthM = alongM.last ?? 0
    }
}

/// Where the car is on the route, as of the last good fix. Plain data: keep it, pass it back.
public struct TrackingState: Hashable, Sendable {
    /// The last good fix as the device gave it.
    public var fix: PositionFix
    /// Where to draw the car: the point on the route line while on it, the raw fix while off the line.
    public var position: LngLat
    /// Meters driven along the route, from its start. Does not move back on noise.
    public var alongRouteM: Double
    /// Meters of route still ahead.
    public var remainingM: Double
    /// Smoothed speed, in meters per second.
    public var speedMps: Double
    /// Direction of travel, degrees clockwise from north.
    public var headingDeg: Double
    /// How far the last good fix was from the route line, in meters.
    public var distanceFromRouteM: Double
    /// The verdict, given with patience: off the route.
    public var offRoute: Bool
    /// The verdict: at the destination, or past the end of the route.
    public var arrived: Bool
    /// Since when the car has been standing still (the time of that fix). Nil while it moves.
    public var stoppedSinceMs: Double?
    /// Since when fixes have been off the line. Nil while on it.
    public var offSinceMs: Double?
    /// Good fixes in a row that were off the line.
    public var offFixes: Int
    /// Good fixes in a row that snapped outside where the car could be.
    public var jumpFixes: Int
    /// True after a confirmed move backwards, until the car makes progress again.
    public var reversing: Bool
    /// Fixes ignored so far (poor accuracy, not a coordinate, out of order).
    public var ignoredFixes: Int
}

public enum Tracking {
    /// True when a fix is good enough to track with. A fix without an accuracy is taken on trust.
    public static func isUsableFix(_ fix: PositionFix, options: TrackingOptions = .default) -> Bool {
        let maxAccuracyM = options.resolved().maxAccuracyM
        return Geo.isValidLngLat(LngLat(fix.lng, fix.lat)) && fix.timeMs.isFinite && !(fix.accuracyM > maxAccuracyM)
    }

    /// A place where the route passes the fix: the closest point of one unbroken stretch of nearby route.
    struct Pass {
        let alongM: Double
        let distanceM: Double
        let point: LngLat
        let bearingDeg: Double
    }

    /// Every pass of the route within `withinM` of the fix, in driving order,
    /// and the closest point of the whole line.
    static func passesNear(_ route: TrackedRoute, _ at: LngLat, _ withinM: Double) -> (passes: [Pass], nearest: Pass?) {
        let project = Geo.localProjector(at)
        let line = route.line
        let alongM = route.alongM
        var passes: [Pass] = []
        var nearest: Pass?
        var open: Pass?
        var previous = line.first.map(project)
        var i = 1
        while i < line.count, let prev = previous {
            let next = project(line[i])
            let hit = Geo.pointToSegment(XY(0, 0), prev, next)
            previous = next
            let a = line[i - 1]
            let b = line[i]
            let lengthM = alongM[i] - alongM[i - 1]
            let pass = Pass(
                alongM: alongM[i - 1] + hit.t * lengthM,
                distanceM: hit.distanceM,
                point: LngLat(a.lng + (b.lng - a.lng) * hit.t, a.lat + (b.lat - a.lat) * hit.t),
                bearingDeg: lengthM > 0 ? Geo.bearingDeg(a, b) : (open?.bearingDeg ?? 0)
            )
            if nearest == nil || pass.distanceM < nearest!.distanceM { nearest = pass }
            if pass.distanceM <= withinM {
                if open == nil || pass.distanceM < open!.distanceM { open = pass }
            } else if let o = open {
                passes.append(o)
                open = nil
            }
            i += 1
        }
        if let o = open { passes.append(o) }
        if nearest == nil, let only = line.first {
            // A route of one point.
            let single = Pass(alongM: 0, distanceM: Geo.distanceM(at, only), point: only, bearingDeg: 0)
            nearest = single
            if single.distanceM <= withinM { passes.append(single) }
        }
        return (passes, nearest)
    }

    /// Two passes whose distances from the fix differ by less than this are equally likely, in meters.
    static let samePassSlackM = 15.0

    static func closest(_ passes: [Pass]) -> Pass {
        passes.dropFirst().reduce(passes[0]) { best, p in p.distanceM < best.distanceM ? p : best }
    }

    static func smoothedSpeed(_ previous: Double?, _ reading: Double, _ weight: Double) -> Double {
        guard let previous else { return reading }
        return previous + weight * (reading - previous)
    }

    /// Takes one fix into account and returns where the car is now. `state`
    /// is what the last call returned for THIS route, or nil for the first
    /// fix on it. See src/core/tracking.ts for the rules: poor fixes ignored,
    /// snapping to the pass that fits the progress, no going back on noise,
    /// speed, heading, off route only with patience, arrived.
    /// `hintAlongM`: with no state, about where along the route the car is known to be.
    public static func trackFix(
        _ state: TrackingState?,
        _ route: TrackedRoute,
        _ fix: PositionFix,
        options: TrackingOptions = .default,
        hintAlongM: Double? = nil
    ) -> TrackingState? {
        let opts = options.resolved()
        if !isUsableFix(fix, options: opts) || (state.map { fix.timeMs <= $0.fix.timeMs } ?? false) {
            guard var ignored = state else { return nil }
            ignored.ignoredFixes = JS.increment(ignored.ignoredFixes)
            return ignored
        }
        let at = LngLat(fix.lng, fix.lat)
        let (passes, maybeNearest) = passesNear(route, at, opts.offRouteM)
        guard let nearest = maybeNearest else { return state }

        let dtSec = state.map { (fix.timeMs - $0.fix.timeMs) / 1000 } ?? 0
        let last: Double? = state?.alongRouteM ?? (hintAlongM.flatMap { $0.isFinite ? $0 : nil })
        let reachM = JS.max(opts.minReachM, opts.maxSpeedMps * dtSec + opts.minReachM)

        var alongM: Double
        var pass: Pass?
        var jumpFixes = 0
        var reversing = state?.reversing ?? false
        if passes.isEmpty {
            // Off the line: progress stays where it was.
            alongM = last ?? nearest.alongM
        } else if let last {
            if state == nil {
                // A route taken up again: the pass nearest to where the car is known to be.
                let p = passes.dropFirst().reduce(passes[0]) { best, p in abs(p.alongM - last) < abs(best.alongM - last) ? p : best }
                pass = p
                alongM = p.alongM
            } else {
                let within = passes.filter { $0.alongM >= last - opts.backwardToleranceM && $0.alongM <= last + reachM }
                if !within.isEmpty {
                    // Of those it could have reached, the first that is about as near to the fix as any.
                    let nearM = closest(within).distanceM + samePassSlackM
                    let p = within.first { $0.distanceM <= nearM }!
                    pass = p
                    if p.alongM >= last { reversing = false }
                    alongM = reversing ? p.alongM : JS.max(last, p.alongM)
                } else {
                    // Only passes the car could not simply have driven to: behind it, or far ahead.
                    let behind = passes.filter { $0.alongM < last }
                    let p = behind.last ?? passes[0]
                    pass = p
                    jumpFixes = JS.increment(state?.jumpFixes ?? 0)
                    if reversing && p.alongM < last {
                        alongM = p.alongM
                    } else if jumpFixes >= opts.jumpFixes {
                        alongM = p.alongM
                        reversing = p.alongM < last
                        jumpFixes = 0
                    } else {
                        alongM = last
                    }
                }
            }
        } else {
            let p = closest(passes)
            pass = p
            alongM = p.alongM
        }
        alongM = JS.min(route.lengthM, JS.max(0, alongM))

        let onLine = pass != nil
        let offFixes = onLine ? 0 : JS.increment(state?.offFixes ?? 0)
        let offSinceMs: Double? = onLine ? nil : (state?.offSinceMs ?? fix.timeMs)
        let offRoute = !onLine && offFixes >= 2
            && (offFixes >= opts.offRouteFixes || fix.timeMs - (offSinceMs ?? fix.timeMs) >= opts.offRoutePatienceSec * 1000)

        // Speed: the device's, else what the fixes say.
        var reading: Double?
        if let s = fix.speedMps, s.isFinite, s >= 0 {
            reading = s
        } else if let state, dtSec > 0 {
            let movedM = onLine && state.offFixes == 0
                ? abs(alongM - state.alongRouteM)
                : Geo.distanceM(LngLat(state.fix.lng, state.fix.lat), at)
            reading = movedM / dtSec
        }
        let speedMps = reading.map { smoothedSpeed(state?.speedMps, JS.min($0, opts.maxSpeedMps), opts.speedSmoothing) } ?? (state?.speedMps ?? 0)
        let stopped = speedMps < opts.stoppedSpeedMps
        let stoppedSinceMs: Double? = stopped ? (state?.stoppedSinceMs ?? fix.timeMs) : nil

        // Heading: the device knows best while moving; standing still it wanders.
        var headingDeg = state?.headingDeg ?? pass?.bearingDeg ?? nearest.bearingDeg
        if let h = fix.headingDeg, h.isFinite, !stopped {
            // JavaScript % keeps the dividend's sign, as truncatingRemainder does.
            headingDeg = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        } else if let pass {
            headingDeg = pass.bearingDeg
        } else if let state, Geo.distanceM(LngLat(state.fix.lng, state.fix.lat), at) > 5 {
            headingDeg = Geo.bearingDeg(LngLat(state.fix.lng, state.fix.lat), at)
        }

        let remainingM = JS.max(0, route.lengthM - alongM)
        let end = route.line[route.line.count - 1]
        let arrived = (onLine && remainingM <= opts.arrivalRadiusM)
            || (remainingM <= opts.arrivalZoneM && Geo.distanceM(at, end) <= opts.arrivalRadiusM)

        var position = at
        if let pass {
            // Held back by the no-going-back rule: draw the car where its progress is.
            position = pass.alongM == alongM ? pass.point : (pointAlong(route, alongM) ?? pass.point)
        }

        return TrackingState(
            fix: fix,
            position: position,
            alongRouteM: alongM,
            remainingM: remainingM,
            speedMps: speedMps,
            headingDeg: headingDeg,
            distanceFromRouteM: nearest.distanceM,
            offRoute: offRoute,
            arrived: arrived,
            stoppedSinceMs: stoppedSinceMs,
            offSinceMs: offSinceMs,
            offFixes: offFixes,
            jumpFixes: jumpFixes,
            reversing: reversing,
            ignoredFixes: state?.ignoredFixes ?? 0
        )
    }

    /// The point `alongM` meters along a prepared route. Nil for a route without points.
    static func pointAlong(_ route: TrackedRoute, _ alongM: Double) -> LngLat? {
        let line = route.line
        let along = route.alongM
        if line.isEmpty { return nil }
        var i = 1
        while i < line.count - 1 && along[i] < alongM { i += 1 }
        let a = line[i - 1]
        let b = i < line.count ? line[i] : a
        let lengthM = (i < along.count ? along[i] : 0) - along[i - 1]
        let t = lengthM > 0 ? JS.min(1, JS.max(0, (alongM - along[i - 1]) / lengthM)) : 0
        return LngLat(a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t)
    }

    /// The same car on another route (after a switch, or back on the route it
    /// was on): its last good fix snapped onto `route` afresh, keeping its
    /// speed and how long it has stood still.
    public static func retrack(_ state: TrackingState, _ route: TrackedRoute, options: TrackingOptions = .default, hintAlongM: Double? = nil) -> TrackingState {
        guard var fresh = trackFix(nil, route, state.fix, options: options, hintAlongM: hintAlongM) else { return state }
        fresh.speedMps = state.speedMps
        fresh.stoppedSinceMs = state.stoppedSinceMs
        fresh.ignoredFixes = state.ignoredFixes
        return fresh
    }
}
