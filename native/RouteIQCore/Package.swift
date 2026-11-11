// swift-tools-version:5.9
//
// RouteIQCore: the framework-free brain of RouteIQ, ported one to one from
// the web prototype's src/core (TypeScript). Foundation only: no UIKit,
// SwiftUI, Mapbox or CoreLocation, so it builds and tests on Linux and
// Windows as well as on Apple platforms. The Vitest suites under tests/ are
// the spec; the XCTest cases in Tests/RouteIQCoreTests mirror them.
//
// RouteIQKit sits on top: the Mapbox Directions network client and the
// plain-data state the app's screens show. Still Foundation only, so it is
// tested here too, and the iOS app target stays a thin SwiftUI layer.

import PackageDescription

let package = Package(
    name: "RouteIQCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "RouteIQCore", targets: ["RouteIQCore"]),
        .library(name: "RouteIQKit", targets: ["RouteIQKit"]),
    ],
    targets: [
        .target(name: "RouteIQCore"),
        .target(name: "RouteIQKit", dependencies: ["RouteIQCore"]),
        .testTarget(name: "RouteIQCoreTests", dependencies: ["RouteIQCore"]),
        .testTarget(name: "RouteIQKitTests", dependencies: ["RouteIQKit", "RouteIQCore"]),
    ]
)
