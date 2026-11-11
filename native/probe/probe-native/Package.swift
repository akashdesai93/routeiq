// swift-tools-version: 5.9
import PackageDescription

// Local Capacitor plugin for the RouteIQ Probe. The package and product name
// must stay "RouteiqProbeNative": the Capacitor CLI derives that name from the
// npm package name (routeiq-probe-native) when it writes CapApp-SPM/Package.swift.
let package = Package(
    name: "RouteiqProbeNative",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "RouteiqProbeNative",
            targets: ["ProbeNativePlugin"]
        )
    ],
    dependencies: [
        .package(
            url: "https://github.com/ionic-team/capacitor-swift-pm.git",
            "8.0.0"..<"9.0.0"
        )
    ],
    targets: [
        .target(
            name: "ProbeNativePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/ProbeNativePlugin"
        )
    ]
)
