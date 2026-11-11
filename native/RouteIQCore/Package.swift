// swift-tools-version:5.9
//
// RouteIQCore: the framework-free brain of RouteIQ, ported one to one from
// the web prototype's src/core (TypeScript). Foundation only: no UIKit,
// SwiftUI, Mapbox or CoreLocation, so it builds and tests on Linux as well as
// on Apple platforms. The Vitest suites under tests/ are the spec; the XCTest
// cases in Tests/RouteIQCoreTests mirror them.

import PackageDescription

let package = Package(
    name: "RouteIQCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "RouteIQCore", targets: ["RouteIQCore"]),
    ],
    targets: [
        .target(name: "RouteIQCore"),
        .testTarget(name: "RouteIQCoreTests", dependencies: ["RouteIQCore"]),
    ]
)
