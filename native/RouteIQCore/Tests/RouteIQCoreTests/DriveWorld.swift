import Foundation
import RouteIQCore

/// A port of tests/helpers/driveWorld.ts: a made-up road network for scripted
/// drives, a 20 km main road running east with a few detours off it. Positions
/// are meters on a flat plane, turned into coordinates around a made-up origin.
/// Nothing here is a real place.
///
/// Everything lives in this namespace (`DriveWorld.at`, `DriveWorld.drive`, ...)
/// so its names cannot clash with the helpers of other test files, which share
/// one module.
enum DriveWorld {
    static let origin = LngLat(-81, 35)
    static let mPerDegree = 111_195.0
    static let mPerDegreeLng = mPerDegree * cos((35 * Double.pi) / 180)

    /// The coordinate `xM` meters east and `yM` meters north of the origin.
    static func at(_ xM: Double, _ yM: Double) -> LngLat {
        LngLat(origin.lng + xM / mPerDegreeLng, origin.lat + yM / mPerDegree)
    }

    /// One corner of a road, in meters east and north of the origin.
    struct Corner: Hashable {
        let x: Double
        let y: Double

        init(_ x: Double, _ y: Double) {
            self.x = x
            self.y = y
        }
    }

    /// A road through the corners, with a vertex every 250 m the way a real route has them.
    static func road(_ corners: [Corner]) -> [LngLat] {
        var line: [LngLat] = []
        for (i, corner) in corners.enumerated() {
            if i > 0 {
                let previous = corners[i - 1]
                let length = hypot(corner.x - previous.x, corner.y - previous.y)
                // Math.round of a positive number: halves go up, as .rounded() does them.
                let pieces = max(1, Int((length / 250).rounded()))
                for k in stride(from: 1, to: pieces, by: 1) {
                    let kd = Double(k)
                    let pd = Double(pieces)
                    line.append(at(
                        previous.x + ((corner.x - previous.x) * kd) / pd,
                        previous.y + ((corner.y - previous.y) * kd) / pd
                    ))
                }
            }
            line.append(at(corner.x, corner.y))
        }
        return line
    }

    /// The routes of the network, in the TS key order, then the side streets
    /// (the TS `RouteName | SideStreetName`). ROUTE_NAMES leaves the side streets out.
    enum RouteName: String, CaseIterable, Hashable {
        case A, B, C, D, BA, E
        /// A side street (SIDE_STREETS): leaves A at 6 km, runs 500 m south of it, rejoins at 14 km.
        case S
    }

    /// The routes of the network, each from the start (0, 0) to the end (20 km, 0):
    /// - A: the main road, straight east.
    /// - B: leaves A at 5 km, runs 1 km north of it, rejoins at 15 km.
    /// - C: leaves A at 8 km, runs 1 km south of it, rejoins at 12 km.
    /// - D: B, but from 9 km it swings another 1 km north until 14 km.
    /// - BA: B as far as 10 km, then back down to A.
    /// - E: A, with a short loop north between 18.5 and 19.5 km.
    static let CORNERS: [RouteName: [Corner]] = [
        .A: [Corner(0, 0), Corner(20000, 0)],
        .B: [Corner(0, 0), Corner(5000, 0), Corner(5000, 1000), Corner(15000, 1000), Corner(15000, 0), Corner(20000, 0)],
        .C: [Corner(0, 0), Corner(8000, 0), Corner(8000, -1000), Corner(12000, -1000), Corner(12000, 0), Corner(20000, 0)],
        .D: [
            Corner(0, 0), Corner(5000, 0), Corner(5000, 1000), Corner(9000, 1000), Corner(9000, 2000),
            Corner(14000, 2000), Corner(14000, 1000), Corner(15000, 1000), Corner(15000, 0), Corner(20000, 0),
        ],
        .BA: [Corner(0, 0), Corner(5000, 0), Corner(5000, 1000), Corner(10000, 1000), Corner(10000, 0), Corner(20000, 0)],
        .E: [Corner(0, 0), Corner(18500, 0), Corner(18500, 300), Corner(19500, 300), Corner(19500, 0), Corner(20000, 0)],
        // SIDE_STREETS: the provider never offers these among its routes (side-street
        // probing): only a request through a via point beside A finds them.
        .S: [Corner(0, 0), Corner(6000, 0), Corner(6000, -500), Corner(14000, -500), Corner(14000, 0), Corner(20000, 0)],
    ]

    /// The provider's routes, without the side streets, so drive() never offers one by itself.
    static let ROUTE_NAMES: [RouteName] = [.A, .B, .C, .D, .BA, .E]

    static let LINES: [RouteName: [LngLat]] = {
        var lines: [RouteName: [LngLat]] = [:]
        for name in DriveWorld.RouteName.allCases {
            lines[name] = DriveWorld.road(DriveWorld.CORNERS[name] ?? [])
        }
        return lines
    }()

    /// The whole line of a route or side street, from the start (0, 0) to the end (20 km, 0).
    static func lineOf(_ name: RouteName) -> [LngLat] { LINES[name] ?? [] }

    /// Where on a line the point lies, in meters from the line's start. Nil when it is more than a meter off it.
    static func alongOf(_ line: [LngLat], _ point: LngLat) -> Double? {
        let project = Geo.localProjector(point)
        let xy = line.map(project)
        let along = Geo.alongRouteM(line)
        for i in stride(from: 1, to: xy.count, by: 1) {
            let hit = Geo.pointToSegment(XY(0, 0), xy[i - 1], xy[i])
            if hit.distanceM <= 1 { return along[i - 1] + hit.t * (along[i] - along[i - 1]) }
        }
        return nil
    }

    /// A change to a candidate before it is handed out: the TS `extra: Partial<RouteCandidate>`.
    typealias Patch = (inout RouteCandidate) -> Void

    /// Applies a patch to a copy of the candidate: the TS `{ ...c, ...extra }`.
    static func patched(_ route: RouteCandidate, _ patch: Patch) -> RouteCandidate {
        var copy = route
        patch(&copy)
        return copy
    }

    /// Per process, so ids are new on every call (as the TS module-level counter).
    static var pollCounter = 0

    /// The route `name` as a directions query from `from` would return it: the
    /// rest of the route from that point, a maneuver at each corner still ahead,
    /// and an id that is new on every call (ids must never be relied on between
    /// polls). Nil when the point is not on the route.
    static func candidate(_ name: RouteName, _ from: LngLat, _ durationSec: Double, _ extra: Patch? = nil) -> RouteCandidate? {
        let full = LINES[name] ?? []
        guard let fromM = alongOf(full, from) else { return nil }
        let geometry = Geo.lineFrom(full, fromM)
        if geometry.count < 2 { return nil }
        var maneuvers = [Maneuver(atDistanceM: 0, kind: "depart", location: geometry[0])]
        let corners = CORNERS[name] ?? []
        for corner in corners.dropFirst().dropLast() {
            let cornerAt = at(corner.x, corner.y)
            if let cornerM = alongOf(full, cornerAt), cornerM > fromM {
                maneuvers.append(Maneuver(atDistanceM: cornerM - fromM, kind: "turn", location: cornerAt))
            }
        }
        let distanceM = Geo.alongRouteM(geometry).last ?? 0
        maneuvers.append(Maneuver(atDistanceM: distanceM, kind: "arrive", location: geometry[geometry.count - 1]))
        pollCounter += 1
        let made = RouteCandidate(
            id: "\(name.rawValue)-\(pollCounter)",
            geometry: geometry,
            durationSec: durationSec,
            typicalDurationSec: durationSec,
            distanceM: distanceM,
            signalCount: nil,
            signalCoverage: SignalCoverage.none,
            providerSignalCount: nil,
            intersections: nil,
            limitedAccessSpansM: [],
            maneuvers: maneuvers
        )
        guard let extra else { return made }
        return patched(made, extra)
    }

    /// The route name a candidate made here was built from.
    static func nameOf(_ route: RouteCandidate) -> RouteName {
        let prefix = route.id.split(separator: "-", omittingEmptySubsequences: false).first.map { String($0) } ?? route.id
        guard let name = RouteName(rawValue: prefix) else {
            preconditionFailure("not a DriveWorld candidate id: \(route.id)")
        }
        return name
    }

    struct PollContext {
        /// 0 for the first poll.
        let poll: Int
        let nowSec: Double
        /// The route being driven.
        let on: RouteName
        /// Where the driver is.
        let position: LngLat
    }

    struct DriveScript {
        /// The route the drive starts on, and how far along it.
        var start: RouteName = .A
        var startAlongM: Double = 0
        var speedMps: Double = 5
        var pollEverySec: Double = 60
        var polls: Int
        /// The ETA of each route at a poll, in seconds, or nil when the route is
        /// not offered. Asked only for routes the driver could still take.
        var eta: (RouteName, PollContext) -> Double?
        /// Changes a poll's candidates before the engine sees them; nil makes the poll fail.
        var tamper: (([RouteCandidate], PollContext) -> [RouteCandidate]?)? = nil
        /// What a request for the current path itself answers at a poll
        /// (RerouteObservation.baseline), given the poll's candidates. Nil: not asked.
        var baseline: (([RouteCandidate], PollContext) -> [RouteCandidate]?)? = nil
        var options: RerouteOptions = .default
    }

    struct PollRecord {
        let nowSec: Double
        let on: RouteName
        let decision: RerouteDecision
        /// The state the engine was handed for this poll.
        let stateBefore: RerouteState
    }

    struct Switch: Equatable {
        let nowSec: Double
        let from: RouteName
        let to: RouteName
    }

    struct DriveLog {
        let polls: [PollRecord]
        /// The polls that switched, in order.
        let switches: [Switch]
        /// The decision codes as the TS strings (RerouteCode.rawValue).
        let codes: [String]
        let finalState: RerouteState
    }

    /// Drives the network on a fake clock: every `pollEverySec` the driver has
    /// moved `speedMps` x that far along the current route, a "directions query"
    /// returns the routes still open from there, and the engine decides. A switch
    /// is applied the way an app would: the chosen candidate becomes the route.
    /// No network, no timers, no randomness.
    static func drive(_ script: DriveScript) -> DriveLog {
        var on = script.start
        var route = DrivenRoute(geometry: LINES[script.start] ?? [], maneuvers: [], limitedAccessSpansM: nil)
        var alongM = script.startAlongM
        var state = RerouteState.initial
        var records: [PollRecord] = []
        var switches: [Switch] = []

        for poll in 0..<max(0, script.polls) {
            let nowSec = Double(poll) * script.pollEverySec
            if poll > 0 { alongM += script.speedMps * script.pollEverySec }
            guard let here = Geo.pointAtDistance(route.geometry, alongM),
                  let routeEndM = Geo.alongRouteM(route.geometry).last,
                  !(alongM >= routeEndM) else { break }
            let context = PollContext(poll: poll, nowSec: nowSec, on: on, position: here.point)

            // The current route first, so that of two names with the same road ahead it is the one kept.
            var offered: [RouteCandidate] = []
            for name in [on] + ROUTE_NAMES.filter({ $0 != on }) {
                guard let sec = script.eta(name, context) else { continue }
                guard let made = candidate(name, here.point, sec) else { continue }
                let sameRoadAhead = offered.contains { o in
                    o.geometry.count == made.geometry.count
                        && o.geometry.indices.allSatisfy { i in
                            hypot(o.geometry[i].lng - made.geometry[i].lng, o.geometry[i].lat - made.geometry[i].lat) < 1e-9
                        }
                }
                if !sameRoadAhead { offered.append(made) }
            }
            let candidates: [RouteCandidate]?
            if let tamper = script.tamper {
                candidates = tamper(offered, context)
            } else {
                candidates = offered
            }

            var asked: [RouteCandidate]?
            if let candidates, let baseline = script.baseline { asked = baseline(candidates, context) }
            let decision = Reroute.decideReroute(
                state,
                RerouteObservation(
                    nowSec: nowSec, route: route, positionAlongM: alongM, speedMps: script.speedMps,
                    candidates: candidates, baseline: asked
                ),
                options: script.options
            )
            records.append(PollRecord(nowSec: nowSec, on: on, decision: decision, stateBefore: state))
            state = decision.nextState
            if decision.action == .switchRoute, let to = candidates?.first(where: { $0.id == decision.toRouteId }) {
                let toName = nameOf(to)
                switches.append(Switch(nowSec: nowSec, from: on, to: toName))
                on = toName
                route = DrivenRoute(to)
                alongM = 0
            }
        }
        return DriveLog(polls: records, switches: switches, codes: records.map { $0.decision.code.rawValue }, finalState: state)
    }
}
