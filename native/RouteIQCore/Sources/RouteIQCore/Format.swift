import Foundation

/// Route facts and the words the UI shows for them, ported from
/// src/core/facts.ts and src/core/format.ts. US units, plain English.
public enum Format {
    static let mPerMile = 1609.344
    static let ftPerMile = 5280.0
    static let notAvailable = "n/a"

    /// How much slower (positive) or faster (negative) the route is right now
    /// than its typical time, in seconds. Nil when there is no typical time.
    public static func delayVsTypicalSec(durationSec: Double, typicalDurationSec: Double?) -> Double? {
        guard let typical = typicalDurationSec else { return nil }
        guard durationSec.isFinite, typical.isFinite else { return nil }
        return durationSec - typical
    }

    public static func delayVsTypicalSec(_ route: RouteCandidate) -> Double? {
        delayVsTypicalSec(durationSec: route.durationSec, typicalDurationSec: route.typicalDurationSec)
    }

    /// "14 min", "1 h 5 min". Rounds to the minute and never shows less than 1 min.
    public static func formatDuration(_ sec: Double) -> String {
        guard sec.isFinite, sec >= 0 else { return notAvailable }
        let totalMin = max(1, JS.round(sec / 60))
        if totalMin < 60 { return "\(JS.string(totalMin)) min" }
        let h = (totalMin / 60).rounded(.down)
        let minutes = totalMin.truncatingRemainder(dividingBy: 60)
        return minutes == 0 ? "\(JS.string(h)) h" : "\(JS.string(h)) h \(JS.string(minutes)) min"
    }

    /// US units: "5.8 mi", "12 mi", or feet (to the nearest 10) under a tenth of a mile.
    public static func formatDistance(_ meters: Double) -> String {
        guard meters.isFinite, meters >= 0 else { return notAvailable }
        let miles = meters / mPerMile
        if miles < 0.1 { return "\(JS.string(JS.round(miles * ftPerMile / 10) * 10)) ft" }
        let tenths = JS.round(miles * 10) / 10
        return tenths < 10 ? "\(String(format: "%.1f", tenths)) mi" : "\(JS.string(JS.round(miles))) mi"
    }

    /// Words for the difference from typical time. Nil means no typical time, and says so.
    public static func formatDelay(_ delaySec: Double?) -> String {
        guard let delay = delaySec, delay.isFinite else { return "No typical time available" }
        if JS.round(delay / 60) == 0 { return "About the typical time" }
        return delay > 0
            ? "\(formatDuration(delay)) slower than typical"
            : "\(formatDuration(-delay)) faster than typical"
    }

    /// "14 signals", "1 signal", "0 signals" for a full count; "≥ 9 signals
    /// (partial)" for a partial one; "Signals: unknown" for anything else.
    /// A count not known in full is never shown as a plain number.
    public static func formatSignalCount(_ count: Int?, _ coverage: SignalCoverage = .full) -> String {
        guard let count, count >= 0, coverage != .none else { return "Signals: unknown" }
        if coverage == .partial {
            if count == 0 { return "Signals: unknown" }
            return "≥ \(count) \(count == 1 ? "signal" : "signals") (partial)"
        }
        return count == 1 ? "1 signal" : "\(count) signals"
    }

    /// One line explaining a signal count that is not the whole answer. Nil for a full count.
    public static func signalCountNote(_ count: Int?, _ coverage: SignalCoverage = .full) -> String? {
        let label = formatSignalCount(count, coverage)
        if label == "Signals: unknown" { return "Signal data for this route could not be loaded." }
        if coverage == .partial { return "Signal data for part of this route is missing, so this is a lower bound." }
        return nil
    }

    static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    /// The largest time a JavaScript Date can hold, in milliseconds either side of 1970.
    static let maxDateMs = 8.64e15

    /// The month a dataset dates from, "Nov 2026", read in UTC. Takes
    /// milliseconds since 1970. Nil when there is no usable date.
    public static func formatDataMonth(_ ms: Double?) -> String? {
        guard let ms, ms.isFinite, abs(ms) <= maxDateMs else { return nil }
        // A JavaScript Date drops fractional milliseconds toward zero, then
        // reads the proleptic Gregorian calendar in UTC (year 0 exists).
        let t = ms.rounded(.towardZero)
        let days = Int((t / 86_400_000).rounded(.down))
        let (year, month) = civilFromDays(days)
        return "\(months[month - 1]) \(year)"
    }

    /// Year and month (1-12) of a day count from 1970-01-01, proleptic
    /// Gregorian (Howard Hinnant's civil_from_days).
    static func civilFromDays(_ z0: Int) -> (year: Int, month: Int) {
        let z = z0 + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let month = mp < 10 ? mp + 3 : mp - 9
        let year = yoe + era * 400 + (month <= 2 ? 1 : 0)
        return (year, month)
    }

    /// Latitude first, the way people read coordinates: "35.2271, -80.8431".
    public static func formatLatLng(_ p: LngLat) -> String {
        "\(fixed4(p.lat)), \(fixed4(p.lng))"
    }

    /// `toFixed(4)`, exactly (ties round up, no sign on negative zero).
    static func fixed4(_ x: Double) -> String {
        JS.toFixed(x, 4)
    }
}
