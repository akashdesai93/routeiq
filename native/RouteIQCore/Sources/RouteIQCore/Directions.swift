import Foundation

/// Mapbox Directions API v5 JSON (geometries=geojson, steps=true, for turn
/// guidance banner_instructions=true and voice_instructions=true, and for
/// per-segment traffic annotations=congestion,duration with overview=full) to
/// RouteCandidates, ported from src/providers/mapbox/adapter.ts.
///
/// The Mapbox Navigation SDK for iOS wraps this same response (its routes
/// are Codable MapboxDirections types), so the app can encode a route back
/// to this JSON and read it here, with the same rules the web prototype uses
/// for signal flags, intersections and freeway spans. Pure; never throws.
public enum Directions {
    public enum ErrorKind: String, Hashable, Sendable {
        /// Mapbox answered, but there is no drivable route (code NoRoute, or no routes).
        case noRoute = "no-route"
        /// A pin is too far from any road (code NoSegment).
        case noSegment = "no-segment"
        /// Any other Mapbox error code, such as InvalidInput.
        case api
        /// The body is not a Directions response, or no route in it is usable.
        case malformed
        /// Filled by the fetch client (RouteIQKit), never by the parser.
        case token
        case rateLimit = "rate-limit"
        case network
        case aborted
    }

    public enum Result: Hashable, Sendable {
        case ok([RouteCandidate])
        /// `message` is written for the user and never contains the token.
        case failure(ErrorKind, String)

        public var routes: [RouteCandidate]? {
            if case .ok(let r) = self { return r }
            return nil
        }
    }

    static let noRouteHelp = "No driving route found between these two points. Try moving a pin."
    static let malformedHelp = "Mapbox sent a response RouteIQ could not read. Try again."

    /// Mapbox Streets v8 road classes that are controlled-access: freeway mainline, and its ramps and connectors.
    static let limitedAccessClasses: Set<String> = ["motorway", "motorway_link"]

    /// An intersection must sit this close to the route point its geometry_index names, or the index is not trusted.
    static let geometryIndexCheckM = 5.0

    static func nonNegative(_ v: JSONValue?) -> Double? {
        guard let n = v?.numberValue, n.isFinite, n >= 0 else { return nil }
        return n
    }

    static func toLngLat(_ v: JSONValue?) -> LngLat? {
        guard let a = v?.arrayValue, a.count >= 2, let lng = a[0].numberValue, let lat = a[1].numberValue else { return nil }
        let p = LngLat(lng, lat)
        return Geo.isValidLngLat(p) ? p : nil
    }

    /// "turn right", "depart", "fork slight left": Mapbox maneuver type plus modifier.
    static func maneuverKind(_ maneuver: [String: JSONValue]) -> String {
        var type = "unknown"
        if let t = maneuver["type"]?.stringValue, !t.isEmpty { type = t }
        let modifier = maneuver["modifier"]?.stringValue ?? ""
        return modifier.isEmpty ? type : "\(type) \(modifier)"
    }

    /// The steps of every usable leg, in order. Odd legs and steps are skipped.
    static func steps(_ legs: JSONValue?) -> [[String: JSONValue]]? {
        guard let legs = legs?.arrayValue else { return nil }
        return legs.compactMap { $0.objectValue?["steps"]?.arrayValue }.flatMap { $0.compactMap(\.objectValue) }
    }

    /// One maneuver per step, at the step's start, so atDistanceM is the sum of
    /// the step distances before it (across legs).
    static func toManeuvers(_ legs: JSONValue?) -> [Maneuver] {
        var maneuvers: [Maneuver] = []
        var atDistanceM = 0.0
        for step in steps(legs) ?? [] {
            if let maneuver = step["maneuver"]?.objectValue, let location = toLngLat(maneuver["location"]) {
                maneuvers.append(Maneuver(atDistanceM: atDistanceM, kind: maneuverKind(maneuver), location: location))
            }
            atDistanceM += nonNegative(step["distance"]) ?? 0
        }
        return maneuvers
    }

    /// How many intersections Mapbox flags with `traffic_signal`. A
    /// cross-check only. Nil when no step carries an intersections list. An
    /// intersection repeating the location of the one just before is counted once.
    static func countSignalFlags(_ legs: JSONValue?) -> Int? {
        guard let steps = steps(legs) else { return nil }
        var sawIntersections = false
        var count = 0
        var previous: LngLat?
        for step in steps {
            guard let intersections = step["intersections"]?.arrayValue else { continue }
            sawIntersections = true
            for case .object(let intersection) in intersections {
                let here = toLngLat(intersection["location"])
                if intersection["traffic_signal"] == JSONValue.bool(true) && (here == nil || here != previous) { count += 1 }
                previous = here
            }
        }
        return sawIntersections ? count : nil
    }

    /// Every intersection with a usable location, in driving order, with its
    /// `traffic_signal` flag (only a literal true counts). A repeat of the
    /// location just before is listed once, flagged if either copy is. Nil
    /// when no step carries an intersections list.
    static func toIntersections(_ legs: JSONValue?) -> [RouteIntersection]? {
        guard let steps = steps(legs) else { return nil }
        var sawIntersections = false
        var found: [RouteIntersection] = []
        for step in steps {
            guard let intersections = step["intersections"]?.arrayValue else { continue }
            sawIntersections = true
            for case .object(let intersection) in intersections {
                guard let location = toLngLat(intersection["location"]) else { continue }
                let signal = intersection["traffic_signal"] == JSONValue.bool(true)
                if let last = found.last, last.location.lng == location.lng, last.location.lat == location.lat {
                    if signal && !last.signal { found[found.count - 1] = RouteIntersection(location: location, signal: signal) }
                    continue
                }
                found.append(RouteIntersection(location: location, signal: signal))
            }
        }
        return sawIntersections ? found : nil
    }

    /// True when the road LEAVING this intersection is controlled-access:
    /// `classes` contains "motorway", or `mapbox_streets_v8.class` is motorway or motorway_link.
    static func leavesOnLimitedAccess(_ intersection: [String: JSONValue]) -> Bool {
        if let classes = intersection["classes"]?.arrayValue, classes.contains(.string("motorway")) { return true }
        guard let cls = intersection["mapbox_streets_v8"]?.objectValue?["class"]?.stringValue else { return false }
        return limitedAccessClasses.contains(cls)
    }

    /// The stretches of the route on controlled-access road, as [startM, endM]
    /// along `geometry`. A span opens at the first intersection whose exit is
    /// controlled-access and closes at the next one whose exit is not. Nil
    /// (unknown) whenever the data is not exactly as expected.
    /// `geometry_index` counts from the start of its leg; the next leg starts
    /// at the point where the last one arrived.
    static func toLimitedAccessSpans(_ legs: JSONValue?, _ geometry: [LngLat]) -> [DistanceSpanM]? {
        guard let legs = legs?.arrayValue else { return nil }
        let along = Geo.alongRouteM(geometry)
        var spans: [DistanceSpanM] = []
        var legStart = 0
        var previous = -1
        var openedAtM: Double?
        func close(_ startM: Double, _ endM: Double) {
            // A waypoint in the middle of a freeway ends one leg and starts the next at the same point: one span.
            if let last = spans.last, last.endM == startM {
                spans[spans.count - 1] = DistanceSpanM(last.startM, endM)
            } else if endM > startM {
                spans.append(DistanceSpanM(startM, endM))
            }
        }
        for leg in legs {
            guard let steps = leg.objectValue?["steps"]?.arrayValue else { return nil }
            if previous >= 0 { legStart = previous }
            for step in steps {
                guard let intersections = step.objectValue?["intersections"]?.arrayValue else { return nil }
                for item in intersections {
                    guard let intersection = item.objectValue else { return nil }
                    guard let offset = intersection["geometry_index"]?.numberValue,
                          offset.isFinite, offset == offset.rounded(), offset >= 0,
                          let location = toLngLat(intersection["location"]) else { return nil }
                    guard offset < Double(Int.max / 2) else { return nil }
                    let index = legStart + Int(offset)
                    if index >= geometry.count || index < previous { return nil }
                    if Geo.distanceM(location, geometry[index]) > geometryIndexCheckM { return nil }
                    previous = index
                    let atM = along[index]
                    if leavesOnLimitedAccess(intersection) {
                        if openedAtM == nil { openedAtM = atM }
                    } else if let opened = openedAtM {
                        close(opened, atM)
                        openedAtM = nil
                    }
                }
            }
        }
        if previous < 0 { return nil }
        if let opened = openedAtM { close(opened, along[along.count - 1]) }
        return spans
    }

    /// The JavaScript `text`: a string with something in it, trimmed (JavaScript white space). Nil otherwise.
    static func text(_ v: JSONValue?) -> String? {
        guard let s = v?.stringValue else { return nil }
        let trimmed = JS.trim(s)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The first usable banner of a step: the one shown from farthest away.
    static func firstBanner(_ step: [String: JSONValue]) -> [String: JSONValue]? {
        guard let banners = step["bannerInstructions"]?.arrayValue else { return nil }
        for banner in banners {
            if let b = banner.objectValue, let primary = b["primary"]?.objectValue, text(primary["text"]) != nil { return b }
        }
        return nil
    }

    /// A step's voice instructions as announcements for the maneuver at its
    /// END: `distanceAlongGeometry` meters before `endM`, and never before the
    /// step begins. The plain `announcement` text; `ssmlAnnouncement` is ignored.
    static func voiceAnnouncements(_ step: [String: JSONValue], _ startM: Double, _ endM: Double) -> [GuidanceAnnouncement] {
        guard let voices = step["voiceInstructions"]?.arrayValue else { return [] }
        var out: [GuidanceAnnouncement] = []
        for item in voices {
            guard let voice = item.objectValue else { continue }
            guard let said = text(voice["announcement"]), let before = nonNegative(voice["distanceAlongGeometry"]) else { continue }
            out.append(GuidanceAnnouncement(atDistanceM: JS.max(startM, endM - before), text: said))
        }
        return out.jsSorted { JS.compare($0.atDistanceM, $1.atDistanceM) }
    }

    /// Turn-by-turn guidance: one entry per step maneuver, in driving order.
    /// Mapbox hangs what is shown and said on the way to a maneuver on the
    /// step BEFORE it, so each maneuver takes its banner and announcements
    /// from the step that leads to it. Where either is missing, the entry is
    /// built from the maneuver itself and marked `synthesized`. A step
    /// without a usable maneuver location is skipped, as in toManeuvers.
    static func toGuidance(_ legs: JSONValue?) -> [GuidanceStep] {
        var guidance: [GuidanceStep] = []
        guard let legs = legs?.arrayValue else { return guidance }
        var atDistanceM = 0.0
        var approach: (step: [String: JSONValue], startM: Double)?
        for leg in legs {
            guard let steps = leg.objectValue?["steps"]?.arrayValue else { continue }
            for item in steps {
                guard let step = item.objectValue else { continue }
                let maneuver = step["maneuver"]?.objectValue
                if let maneuver, let location = toLngLat(maneuver["location"]) {
                    let banner = approach.flatMap { firstBanner($0.step) }
                    let primary = banner?["primary"]?.objectValue
                    let secondary = banner?["secondary"]?.objectValue.flatMap { text($0["text"]) }
                    let instruction = text(maneuver["instruction"])
                    let voiced = approach.map { voiceAnnouncements($0.step, $0.startM, atDistanceM) } ?? []
                    let type = text(primary?["type"]) ?? text(maneuver["type"]) ?? "unknown"
                    let isDepart = approach == nil
                    let modifier = primary != nil && text(primary?["type"]) != nil ? text(primary?["modifier"]) : text(maneuver["modifier"])
                    let announcements: [GuidanceAnnouncement]
                    if !voiced.isEmpty || isDepart || instruction == nil {
                        announcements = voiced
                    } else {
                        announcements = Guidance.synthesizeAnnouncements(instruction!, approach!.startM, atDistanceM)
                    }
                    guidance.append(GuidanceStep(
                        atDistanceM: atDistanceM,
                        location: location,
                        type: type,
                        modifier: modifier,
                        primaryText: text(primary?["text"]) ?? text(step["name"]) ?? instruction ?? type,
                        secondaryText: secondary,
                        announcements: announcements,
                        synthesized: !isDepart && (primary == nil || voiced.isEmpty)
                    ))
                }
                approach = (step, atDistanceM)
                atDistanceM += nonNegative(step["distance"]) ?? 0
            }
        }
        return guidance
    }

    /// One annotation list (`legs[].annotation.<key>`) for the whole route:
    /// the legs' lists one after another. Nil when any leg lacks the list, an
    /// entry is unusable, or the total is not exactly `segments` long.
    static func annotationList<T>(_ legs: JSONValue?, _ key: String, _ segments: Int, _ entry: (JSONValue) -> T?) -> [T]? {
        guard let legs = legs?.arrayValue, !legs.isEmpty else { return nil }
        var out: [T] = []
        for leg in legs {
            guard let annotation = leg.objectValue?["annotation"]?.objectValue else { return nil }
            guard let list = annotation[key]?.arrayValue else { return nil }
            for raw in list {
                guard let value = entry(raw) else { return nil }
                out.append(value)
            }
        }
        return out.count == segments ? out : nil
    }

    /// Per-segment congestion and travel time (see RouteCandidate.segmentTraffic).
    /// A congestion entry Mapbox does not document reads as `unknown`; a
    /// duration entry that is not a number of 0 or more makes the whole
    /// duration list nil. Nil when neither list is usable.
    static func toSegmentTraffic(_ legs: JSONValue?, _ segments: Int) -> SegmentTraffic? {
        if segments < 1 { return nil }
        let congestion: [CongestionLevel]? = annotationList(legs, "congestion", segments) { v in
            // Only the exact words: a JavaScript Set of strings compares code units.
            guard let s = v.stringValue else { return .unknown }
            return CongestionLevel.allCases.first { JS.Key($0.rawValue) == JS.Key(s) } ?? .unknown
        }
        let durationSec: [Double]? = annotationList(legs, "duration", segments) { nonNegative($0) }
        if congestion == nil && durationSec == nil { return nil }
        return SegmentTraffic(congestion: congestion, durationSec: durationSec)
    }

    /// Nil when the route lacks what the app cannot do without: a line, a time, a length.
    static func toCandidate(_ raw: JSONValue) -> RouteCandidate? {
        guard let route = raw.objectValue else { return nil }
        guard let durationSec = nonNegative(route["duration"]), let distanceM = nonNegative(route["distance"]) else { return nil }
        guard let coordinates = route["geometry"]?.objectValue?["coordinates"]?.arrayValue else { return nil }
        let geometry = coordinates.compactMap { toLngLat($0) }
        guard geometry.count >= 2 else { return nil }
        let legs = route["legs"]
        return RouteCandidate(
            id: Hash.routeIdFromGeometry(geometry),
            geometry: geometry,
            durationSec: durationSec,
            // Only the driving-traffic profile sends this. Missing stays nil, never guessed.
            typicalDurationSec: nonNegative(route["duration_typical"]),
            distanceM: distanceM,
            signalCount: nil,
            signalCoverage: .none,
            providerSignalCount: countSignalFlags(legs),
            intersections: toIntersections(legs),
            // A dropped point shifts every geometry_index after it, so the spans would be misplaced.
            limitedAccessSpansM: geometry.count == coordinates.count ? toLimitedAccessSpans(legs, geometry) : nil,
            maneuvers: toManeuvers(legs),
            guidance: toGuidance(legs),
            // Annotations line up with the line Mapbox sent: with a point dropped they would be misplaced.
            segmentTraffic: geometry.count == coordinates.count ? toSegmentTraffic(legs, geometry.count - 1) : nil
        )
    }

    /// Turns a Directions API v5 body into RouteCandidates. Anything
    /// unexpected comes back as a typed failure. If two routes in one
    /// response share a geometry, the later one gets a "-2" style suffix.
    public static func parse(_ body: JSONValue?) -> Result {
        guard let body = body?.objectValue else { return .failure(.malformed, malformedHelp) }
        guard let code = body["code"]?.stringValue else { return .failure(.malformed, malformedHelp) }
        if code == "NoRoute" { return .failure(.noRoute, noRouteHelp) }
        if code == "NoSegment" { return .failure(.noSegment, "A pin is too far from a road. Move it closer to a street.") }
        if code != "Ok" {
            let message = body["message"]?.stringValue ?? ""
            return .failure(.api, "Mapbox Directions error (\(code))\(message.isEmpty ? "" : ": \(message)")")
        }
        guard let rawRoutes = body["routes"]?.arrayValue else { return .failure(.malformed, malformedHelp) }
        if rawRoutes.isEmpty { return .failure(.noRoute, noRouteHelp) }
        var copies: [String: Int] = [:]
        var routes: [RouteCandidate] = []
        for raw in rawRoutes {
            guard var route = toCandidate(raw) else { continue }
            let copy = (copies[route.id] ?? 0) + 1
            copies[route.id] = copy
            if copy > 1 { route.id = "\(route.id)-\(copy)" }
            routes.append(route)
        }
        if routes.isEmpty { return .failure(.malformed, malformedHelp) }
        return .ok(routes)
    }

    /// Parses raw JSON bytes. Text that is not JSON is malformed.
    public static func parse(data: Data) -> Result {
        guard let value = try? JSONValue.parse(data) else { return .failure(.malformed, malformedHelp) }
        return parse(value)
    }
}
