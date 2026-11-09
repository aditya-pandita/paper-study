// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PaperStudy",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "PaperStudy", path: "Sources/PaperStudy")
    ]
)
