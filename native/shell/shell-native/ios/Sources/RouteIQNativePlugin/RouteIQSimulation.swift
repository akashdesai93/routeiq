import Foundation

/// The "Test drive": a made-up car that drives along a line of points, for
/// trying a drive at home with the phone locked. The web app writes the line
/// and the script (src/drive/testDrive.ts in the repository root); this only
/// moves the car. RouteIQEngine asks it for a position about once a second
/// and hands that on in place of the GPS's.
///
/// SIMULATED data: every position here comes from the points it was given,
/// never from the phone. Nothing is kept, logged or sent.
///
/// A plain value with no clock of its own: time comes in with each call, so
/// it does the same thing every time.
struct RouteIQSimulation {
    /// On reaching `atM` meters along the points: the speed becomes
    /// `speedMps` (when given) and the car stands for `stopSec` (when given).
    struct Step {
        let atM: Double
        let speedMps: Double?
        let stopSec: Double?
    }

    /// More points than this are not taken (a route has a few thousand).
    static let maxPoints = 50_000
    static let maxSteps = 100
    /// No faster than this, whatever the script says, in meters per second.
    static let maxSpeedMps: Double = 70
    /// One stop lasts no longer than this, in seconds.
    static let maxStopSec: Double = 600
    /// Time handed in at once counts up to this, in seconds, so a timer that
    /// was held back does not make the car leap.
    static let maxAdvanceSec: Double = 3
    /// The radius each made-up position reports, in meters.
    static let accuracyM: Double = 5

    private let lngs: [Double]
    private let lats: [Double]
    /// Meters from the first point to each point.
    private let along: [Double]
    private let steps: [Step]
    private var nextStep = 0
    private var speedMps: Double
    private var alongM: Double = 0
    private var stopLeftSec: Double = 0
    /// The segment the car is on: from point `segment` to the next.
    private var segment = 0

    /// Nil when no point is a usable coordinate.
    init?(points: [(lng: Double, lat: Double)], speedMps: Double, steps: [Step]) {
        var lngs: [Double] = []
        var lats: [Double] = []
        for point in points.prefix(Self.maxPoints) {
            guard point.lng.isFinite, point.lat.isFinite, abs(point.lng) <= 180, abs(point.lat) <= 90 else { continue }
            lngs.append(point.lng)
            lats.append(point.lat)
        }
        guard !lngs.isEmpty else { return nil }
        var along: [Double] = [0]
        if lngs.count > 1 {
            for i in 1..<lngs.count {
                along.append(along[i - 1] + Self.distanceM(lngs[i - 1], lats[i - 1], lngs[i], lats[i]))
            }
        }
        self.lngs = lngs
        self.lats = lats
        self.along = along
        self.speedMps = Self.speed(speedMps)
        self.steps = steps
            .filter { $0.atM.isFinite && $0.atM >= 0 }
            .sorted { $0.atM < $1.atM }
            .prefix(Self.maxSteps)
            .map { $0 }
    }

    private static func speed(_ value: Double) -> Double {
        return value.isFinite ? min(max(value, 0), maxSpeedMps) : 0
    }

    private var lengthM: Double { along[along.count - 1] }

    /// Moves the car on by `seconds` and answers where it is then, in the
    /// shape of a position fix: lng, lat, accuracy, speed, and the course
    /// while it moves. `timestampMs` is put in as given.
    mutating func advance(bySec seconds: Double, timestampMs: Double) -> [String: Any] {
        let dt = seconds.isFinite ? min(max(seconds, 0), Self.maxAdvanceSec) : 0
        let before = alongM
        var left = dt
        // Every pass through the loop either applies a step, uses up time or ends it.
        while true {
            while nextStep < steps.count && steps[nextStep].atM <= alongM + 0.001 {
                let step = steps[nextStep]
                nextStep += 1
                if let speed = step.speedMps { speedMps = Self.speed(speed) }
                if let stop = step.stopSec, stop.isFinite, stop > 0 { stopLeftSec += min(stop, Self.maxStopSec) }
            }
            if left <= 0 { break }
            if stopLeftSec > 0 {
                let used = min(stopLeftSec, left)
                stopLeftSec -= used
                left -= used
                continue
            }
            if speedMps <= 0 || alongM >= lengthM { break }
            let limit = nextStep < steps.count ? min(lengthM, steps[nextStep].atM) : lengthM
            let room = limit - alongM
            let reach = speedMps * left
            if reach < room {
                alongM += reach
                left = 0
            } else {
                alongM = limit
                left -= room / speedMps
            }
        }

        while segment < lngs.count - 2 && along[segment + 1] < alongM { segment += 1 }
        var lng = lngs[segment]
        var lat = lats[segment]
        var course: Double?
        if segment + 1 < lngs.count {
            let length = along[segment + 1] - along[segment]
            if length > 0 {
                let t = min(max((alongM - along[segment]) / length, 0), 1)
                lng += (lngs[segment + 1] - lng) * t
                lat += (lats[segment + 1] - lat) * t
                course = Self.bearingDeg(lngs[segment], lats[segment], lngs[segment + 1], lats[segment + 1])
            }
        }
        let moved = dt > 0 ? (alongM - before) / dt : 0
        var fix: [String: Any] = [
            "lng": lng,
            "lat": lat,
            "accuracy": Self.accuracyM,
            "speed": moved,
            "timestamp": timestampMs,
            "simulated": true
        ]
        // A phone standing still reports no course.
        if moved > 0.5, let course = course { fix["course"] = course }
        return fix
    }

    // MARK: - Geometry

    private static let earthRadiusM: Double = 6_371_008.8

    private static func rad(_ degrees: Double) -> Double {
        return degrees * Double.pi / 180
    }

    /// Great-circle distance in meters (haversine), as the web app measures it.
    private static func distanceM(_ lngA: Double, _ latA: Double, _ lngB: Double, _ latB: Double) -> Double {
        let dLat = rad(latB - latA)
        let dLng = rad(lngB - lngA)
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(rad(latA)) * cos(rad(latB)) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * earthRadiusM * asin(min(1, h.squareRoot()))
    }

    /// Degrees clockwise from true north, 0 to 360.
    private static func bearingDeg(_ lngA: Double, _ latA: Double, _ lngB: Double, _ latB: Double) -> Double {
        let dLng = rad(lngB - lngA)
        let y = sin(dLng) * cos(rad(latB))
        let x = cos(rad(latA)) * sin(rad(latB)) - sin(rad(latA)) * cos(rad(latB)) * cos(dLng)
        let degrees = atan2(y, x) * 180 / Double.pi
        return (degrees + 360).truncatingRemainder(dividingBy: 360)
    }
}
