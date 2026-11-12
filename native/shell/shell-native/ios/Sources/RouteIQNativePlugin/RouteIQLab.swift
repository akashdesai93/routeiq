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
    static let switchArgument = "-routeiqLabSwitch"
    static let reportName = "routeiq-lab-report.txt"
    static let snapshotName = "routeiq-lab-snapshot.png"
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

    /// Diagnostic switches for #136 (the driving screen black on the iPhone), passed as
    /// "-routeiqLabSwitch a,b,c" next to "-routeiqLab <scenario>". Each one either switches OFF
    /// one thing the app does natively when a drive starts, so the phone lab can see whether the
    /// screen stays black without it, or switches ON one candidate remedy or probe. Without the
    /// lab's launch argument there are none, whatever else was passed.
    enum Switch: String, CaseIterable {
        /// keepAwake does nothing (UIApplication.isIdleTimerDisabled is never set).
        case noIdle = "no-idle"
        /// The audio session is never configured or activated; the synthesizer still speaks.
        case noAudio = "no-audio"
        /// Nothing is spoken: speak answers "not finished" at once, no audio session, no synthesizer.
        case noSpeech = "no-speech"
        /// allowsBackgroundLocationUpdates and the blue location indicator are not set.
        case noBgLocation = "no-bglocation"
        /// CLLocationManager is never started for the drive (the native clock still ticks).
        case noLocation = "no-location"
        /// "Always" location is not asked for.
        case noAlways = "no-always"
        /// The test drive's made-up car is not started (no positions at all).
        case noTestDrive = "no-testdrive"
        /// Remedy (b): the audio session is configured and activated off the main thread.
        case audioOffMain = "audio-offmain"
        /// Remedy (c): the web view's scroll view does not add the safe area to its insets.
        case insetsNever = "insets-never"
        /// Remedy (a), one kick each, run 0.5, 2 and 5 s after the drive starts and whenever the app becomes active.
        case kickLayout = "kick-layout"
        case kickDisplay = "kick-display"
        case kickFrame = "kick-frame"
        case kickScroll = "kick-scroll"
        case kickOpaque = "kick-opaque"
        case kickReadd = "kick-readd"
        /// Probe: paints the native layers in marker colours (window cyan, web view magenta,
        /// scroll view green), so a screenshot says which layer is showing where the page is not.
        case marks = "marks"
        /// Probe: takes a native snapshot of the web view 3, 9 and 18 s into the drive. Off by
        /// default because asking for a snapshot makes the page render, which could itself cure a black screen.
        case snapshot = "snapshot"
    }

    /// The kick a switch stands for ("layout", "display" ...), or nil for any other switch.
    static func kickName(_ item: Switch) -> String? {
        item.rawValue.hasPrefix("kick-") ? String(item.rawValue.dropFirst("kick-".count)) : nil
    }

    /// The switches after "-routeiqLabSwitch". Empty when the lab is off. Unknown words are ignored.
    static func switches(arguments: [String] = ProcessInfo.processInfo.arguments) -> Set<Switch> {
        guard scenario(arguments: arguments) != nil else { return [] }
        guard let at = arguments.firstIndex(of: switchArgument), at + 1 < arguments.count else { return [] }
        let list = arguments[at + 1]
        guard list.count <= 400 else { return [] }
        return Set(list.split(separator: ",").compactMap { Switch(rawValue: $0.trimmingCharacters(in: .whitespaces)) })
    }

    /// The switches of this launch, read once.
    static let active: Set<Switch> = switches()

    /// Replaces the one snapshot file. False when the lab is off or the image is too large.
    static func writeSnapshot(_ png: Data, arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
        guard scenario(arguments: arguments) != nil, png.count <= 20_000_000 else { return false }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(snapshotName)
        do {
            try png.write(to: file, options: .atomic)
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
