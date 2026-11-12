import Foundation

/// The phone lab (docs/phone-lab.md): unattended tests on a real iPhone, run
/// from the PC over USB. Everything here is OFF unless the app was started
/// with the launch argument "-routeiqLab <scenario>", which only a computer
/// the phone trusts can pass. Opened by hand, the app never has it.
///
/// With the argument: the web view can be inspected from that computer, the
/// web app's test hook is told the scenario, the hook may write its report
/// (counts, times and fixed words; no position, address or token) to one
/// file in the app's temporary folder for the computer to pull, and, with
/// "-routeiqLabWeb" as well, the web app is loaded from a folder the computer
/// pushed into the app instead of the one built in.
enum RouteIQLab {
    static let argument = "-routeiqLab"
    static let webArgument = "-routeiqLabWeb"
    static let reportName = "routeiq-lab-report.txt"
    static let webFolder = "routeiq-lab-www"
    /// The report is small; anything larger is refused.
    static let reportLimit = 200_000

    /// The scenario after the launch argument: a short lowercase word. Nil: the lab is off.
    static func scenario(arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
        guard let at = arguments.firstIndex(of: argument), at + 1 < arguments.count else { return nil }
        let name = arguments[at + 1]
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        guard !name.isEmpty, name.count <= 32, name.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return name
    }

    /// Replaces the one report file. False when the lab is off or the text is too long.
    static func writeReport(_ text: String, arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
        guard scenario(arguments: arguments) != nil, text.utf8.count <= reportLimit else { return false }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(reportName)
        do {
            try text.write(to: file, atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    /// The pushed web app's folder, when the lab is on, "-routeiqLabWeb" was
    /// passed and the folder holds a page. Nil otherwise: the built-in web app is used.
    static func webDirectory(arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
        guard scenario(arguments: arguments) != nil, arguments.contains(webArgument) else { return nil }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(webFolder, isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("index.html").path) else { return nil }
        return folder.path
    }
}
