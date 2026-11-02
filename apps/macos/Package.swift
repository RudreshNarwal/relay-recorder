// swift-tools-version: 6.2
import PackageDescription
import Foundation

// Some standalone Command Line Tools releases ship Testing without automatic macro discovery.
let testingPlugin = "/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib"
let testSettings: [SwiftSetting] = FileManager.default.fileExists(atPath: testingPlugin) ? [.unsafeFlags(["-load-plugin-library", testingPlugin])] : []
let package = Package(
    name: "Relay", platforms: [.macOS(.v15)],
    products: [.executable(name: "Relay", targets: ["Relay"]), .library(name: "RelayCore", targets: ["RelayCore"])],
    dependencies: [.package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7", traits: [])],
    targets: [
        .target(name: "RelayCore", resources: [.copy("Resources")]),
        .executableTarget(name: "Relay", dependencies: ["RelayCore", .product(name: "FluidAudio", package: "FluidAudio")], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "RelayCoreTests", dependencies: ["RelayCore"], resources: [.copy("Fixtures")], swiftSettings: testSettings),
        .testTarget(name: "RelayModelTests", dependencies: ["Relay", "RelayCore"], swiftSettings: testSettings)
    ]
)
