import Foundation

/// Battery (#98): which GPS fixes and native ticks are handed to the web app
/// while the car stands still.
///
/// Core Location keeps running exactly as set up for the drive
/// (BestForNavigation, no distance filter, never paused by iOS), so the
/// background location session stays alive and iOS does not suspend the app.
/// Only what crosses the bridge into the web view changes. The web view's work
/// per fix is what costs CPU while nobody looks at the phone.
///
/// Once the car has stood still for `holdAfterSec`, a fix is passed on only
/// every `keepAliveSec`. With the GPS's own second on top, that stays under the
/// web app's `maxFixAgeSec` (10 s, src/core/live.ts) and under the drive
/// diagnostics' TICK_GAP_EVENT_MS (5 s, a pause iOS imposed), so the web side still has a fresh position, still
/// sees the car standing, and still pauses its checks by its own rule
/// (`stationaryPauseSec`). The first fix that moves (speed, or distance from
/// where the car stopped) is passed on at once, and that ends the hold.
///
/// The native tick follows the same rule while holding: one event of either
/// kind every `keepAliveSec`, so the web side's clock still moves (a GPS lost
/// while parked is still noticed). While fixes are flowing (one passed on in
/// the last `tickQuietSec`), they are the web app's clock and no tick is sent;
/// when they stop (a tunnel), the ticks come back within `tickQuietSec`.
///
/// Pure: time comes in as an argument (seconds on a monotonic clock), so the
/// rules can be tested without a phone (native/shell/shell-native/ios/Tests).
struct RouteIQStillness {
    struct Options: Equatable {
        /// Below this speed (m/s), a fix counts as standing still. The web app's
        /// tracker calls a car stopped below 1 m/s; this is stricter.
        var stillSpeedMps: Double
        /// A fix further than this (m) from where the car came to a stop counts as moving.
        var stillRadiusM: Double
        /// Standing still for this long (s) before fixes are held back.
        var holdAfterSec: Double
        /// While holding, one fix (and one event of any kind) at least this often (s).
        var keepAliveSec: Double
        /// No tick while a fix was passed on less than this long ago (s).
        var tickQuietSec: Double
    }

    static let defaultOptions = Options(stillSpeedMps: 0.5, stillRadiusM: 25, holdAfterSec: 10, keepAliveSec: 3, tickQuietSec: 1.5)

    let options: Options
    /// Where the car came to a stop, and since when (s). Nil while moving.
    private(set) var stoppedAt: (lat: Double, lng: Double)?
    private(set) var stillSinceSec: Double?
    private var lastFixSentSec: Double?
    private var lastEventSentSec: Double?

    init(options: Options = RouteIQStillness.defaultOptions) {
        self.options = options
    }

    /// True when fixes are being held back at `nowSec`: the car has stood still for `holdAfterSec`.
    func holding(nowSec: Double) -> Bool {
        guard let since = stillSinceSec else { return false }
        return nowSec - since >= options.holdAfterSec
    }

    /// A new fix at `nowSec`. True: pass it on to the web app.
    /// `speedMps` nil (unknown) counts as moving: when in doubt, pass it on.
    mutating func fix(lat: Double, lng: Double, speedMps: Double?, nowSec: Double) -> Bool {
        let moving: Bool
        if let speed = speedMps, speed < options.stillSpeedMps {
            if let at = stoppedAt {
                moving = Self.meters(at.lat, at.lng, lat, lng) > options.stillRadiusM
            } else {
                moving = false
            }
        } else {
            moving = true
        }
        if moving {
            stoppedAt = nil
            stillSinceSec = nil
            return send(fix: true, nowSec: nowSec)
        }
        if stillSinceSec == nil || stoppedAt == nil {
            stillSinceSec = nowSec
            stoppedAt = (lat, lng)
        }
        // A clock that went backwards makes this negative: the fix is passed on.
        let stillFor = nowSec - (stillSinceSec ?? nowSec)
        if stillFor < options.holdAfterSec { return send(fix: true, nowSec: nowSec) }
        guard let last = lastFixSentSec, nowSec >= last, nowSec - last < options.keepAliveSec else {
            return send(fix: true, nowSec: nowSec)
        }
        return false
    }

    /// The native one-second timer fired at `nowSec`. True: send the web app a tick.
    mutating func tick(nowSec: Double) -> Bool {
        if let lastFix = lastFixSentSec, nowSec >= lastFix, nowSec - lastFix < options.tickQuietSec { return false }
        guard holding(nowSec: nowSec) else { return send(fix: false, nowSec: nowSec) }
        guard let last = lastEventSentSec, nowSec >= last, nowSec - last < options.keepAliveSec else {
            return send(fix: false, nowSec: nowSec)
        }
        return false
    }

    /// A new drive (or the stream started again): nothing is held.
    mutating func reset() {
        stoppedAt = nil
        stillSinceSec = nil
        lastFixSentSec = nil
        lastEventSentSec = nil
    }

    private mutating func send(fix: Bool, nowSec: Double) -> Bool {
        if fix { lastFixSentSec = nowSec }
        lastEventSentSec = nowSec
        return true
    }

    /// Great-circle distance in meters (haversine), enough for tens of meters.
    static func meters(_ lat1: Double, _ lng1: Double, _ lat2: Double, _ lng2: Double) -> Double {
        let rad = Double.pi / 180
        let dLat = (lat2 - lat1) * rad
        let dLng = (lng2 - lng1) * rad
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1 * rad) * cos(lat2 * rad) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * 6_371_008.8 * asin(min(1, sqrt(h)))
    }
}
