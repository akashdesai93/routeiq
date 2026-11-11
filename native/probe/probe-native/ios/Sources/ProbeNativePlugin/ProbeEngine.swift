import AVFoundation
import CoreLocation
import Foundation
import UIKit

/// Everything the probe measures runs here, in native code, on the main thread:
/// location, the 30 s speech, the 60 s fetch, and the observers for app state
/// and audio route. Nothing in this file depends on the WebView being alive.
///
/// Privacy: coordinates are never logged, stored or sent anywhere. The fetch
/// goes to a fixed public URL and carries no data.
final class ProbeEngine: NSObject, CLLocationManagerDelegate, AVSpeechSynthesizerDelegate {
    static let version = "0.1.0"
    private static let speechInterval: TimeInterval = 30
    private static let fetchInterval: TimeInterval = 60
    private static let fetchURL = URL(string: "https://captive.apple.com/hotspot-detect.html")!
    private static let runningKey = "probe.sessionRunning"

    private let log = ProbeLog.shared
    private let manager = CLLocationManager()
    private let synth = AVSpeechSynthesizer()
    private let urlSession = URLSession(configuration: .ephemeral)
    private let clock: DateFormatter

    private(set) var running = false
    private var waitingForPermission = false
    private var askedAlways = false
    private var sessionStartedAt: Date?

    private var fixCount = 0
    private var lastSpeed: Double = -1
    private var lastAccuracy: Double = -1
    private var lastFixAt: Date?

    private var speechCount = 0
    private var speechStartedCount = 0
    private var speechFinishedCount = 0
    private var speechFailedCount = 0
    private var currentSpeech = 0
    private var currentSpeechStarted = false
    private var currentSpeechDone = true
    private var currentSpeechStartedAt: Date?
    private var utteranceNumbers: [ObjectIdentifier: Int] = [:]

    private var fetchCount = 0
    private var fetchOkCount = 0
    private var fetchFailedCount = 0

    private var nextSpeechAt = Date.distantFuture
    private var nextFetchAt = Date.distantFuture
    private var backupTimer: Timer?
    private var lastLoggedRoute = ""

    /// Called on every location fix with count, accuracy and speed only.
    var onFix: (([String: Any]) -> Void)?

    override init() {
        clock = DateFormatter()
        clock.locale = Locale(identifier: "en_US_POSIX")
        clock.dateFormat = "h:mm"
        super.init()
        manager.delegate = self
        synth.delegate = self
    }

    // MARK: - Lifecycle

    /// Called once when the plugin loads. Observers stay registered for the
    /// life of the process so state changes are logged even between sessions.
    func attach() {
        let defaults = UserDefaults.standard
        let unclean = defaults.bool(forKey: Self.runningKey)
        defaults.set(false, forKey: Self.runningKey)
        log.append(
            "APP_LAUNCH",
            "probe=\(Self.version) ios=\(UIDevice.current.systemVersion) app=\(appState) "
                + "previousSessionEndedWithoutStop=\(unclean)"
        )

        let nc = NotificationCenter.default
        let appEvents: [(Notification.Name, String)] = [
            (UIApplication.didBecomeActiveNotification, "active"),
            (UIApplication.willResignActiveNotification, "inactive"),
            (UIApplication.didEnterBackgroundNotification, "background"),
            (UIApplication.willEnterForegroundNotification, "foreground"),
            (UIApplication.willTerminateNotification, "terminating")
        ]
        for (name, label) in appEvents {
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.log.append("APP_STATE", label)
            }
        }
        nc.addObserver(
            forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.log.append("DEVICE", "locked (protected data unavailable)")
        }
        nc.addObserver(
            forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.log.append("DEVICE", "unlocked (protected data available)")
        }
        nc.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.log.append("MEMORY_WARNING")
        }
        nc.addObserver(
            forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            self?.log.append("LOW_POWER_MODE", "\(ProcessInfo.processInfo.isLowPowerModeEnabled)")
        }
        nc.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
            self?.routeChanged(note)
        }
        nc.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            self?.audioInterrupted(note)
        }
        nc.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.log.append("AUDIO_ERROR", "media services were reset")
        }
    }

    /// Returns nil on success (or when the permission prompt is showing), or an
    /// error message the UI can display.
    func start() -> String? {
        if running { return nil }
        switch manager.authorizationStatus {
        case .notDetermined:
            waitingForPermission = true
            log.append("AUTH", "requesting when-in-use permission")
            manager.requestWhenInUseAuthorization()
            return nil
        case .denied, .restricted:
            log.append("ERROR", "location permission is \(authString); cannot start")
            return "Location permission is \(authString). Allow it in Settings, then press Start."
        default:
            begin()
            return nil
        }
    }

    func stop() {
        waitingForPermission = false
        guard running else { return }
        running = false
        manager.stopUpdatingLocation()
        backupTimer?.invalidate()
        backupTimer = nil
        currentSpeechDone = true
        if synth.isSpeaking {
            synth.stopSpeaking(at: .immediate)
        }
        deactivateAudio()
        UserDefaults.standard.set(false, forKey: Self.runningKey)
        log.append(
            "SESSION_STOP",
            "fixes=\(fixCount) speechRequested=\(speechCount) speechStarted=\(speechStartedCount) "
                + "speechFinished=\(speechFinishedCount) speechFailed=\(speechFailedCount) "
                + "fetchOk=\(fetchOkCount) fetchFailed=\(fetchFailedCount)"
        )
    }

    func status() -> [String: Any] {
        return [
            "running": running,
            "waitingForPermission": waitingForPermission,
            "auth": authString,
            "appState": appState,
            "route": routeString,
            "fixes": fixCount,
            "lastAccuracy": lastAccuracy,
            "lastSpeed": lastSpeed,
            "secondsSinceFix": lastFixAt.map { Date().timeIntervalSince($0) } ?? -1,
            "speechRequested": speechCount,
            "speechStarted": speechStartedCount,
            "speechFinished": speechFinishedCount,
            "speechFailed": speechFailedCount,
            "fetchOk": fetchOkCount,
            "fetchFailed": fetchFailedCount,
            "elapsedSeconds": sessionStartedAt.map { Date().timeIntervalSince($0) } ?? 0,
            "logBytes": log.sizeBytes()
        ]
    }

    private func begin() {
        waitingForPermission = false
        running = true
        sessionStartedAt = Date()
        fixCount = 0
        lastSpeed = -1
        lastAccuracy = -1
        lastFixAt = nil
        speechCount = 0
        speechStartedCount = 0
        speechFinishedCount = 0
        speechFailedCount = 0
        currentSpeechDone = true
        fetchCount = 0
        fetchOkCount = 0
        fetchFailedCount = 0
        utteranceNumbers.removeAll()

        log.rotateIfNeeded()
        UserDefaults.standard.set(true, forKey: Self.runningKey)
        lastLoggedRoute = routeString
        log.append(
            "SESSION_START",
            "probe=\(Self.version) ios=\(UIDevice.current.systemVersion) device=\(UIDevice.current.model) "
                + "auth=\(authString) accuracy=\(accuracyString) app=\(appState) route=\(routeString) "
                + "lowPower=\(ProcessInfo.processInfo.isLowPowerModeEnabled)"
        )

        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        if modes.contains("location") {
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
        } else {
            log.append("ERROR", "Info.plist has no location background mode; background fixes will stop")
        }
        if !modes.contains("audio") {
            log.append("ERROR", "Info.plist has no audio background mode; background speech will fail")
        }
        manager.startUpdatingLocation()

        if manager.authorizationStatus == .authorizedWhenInUse && !askedAlways {
            askedAlways = true
            log.append("AUTH", "requesting upgrade to always")
            manager.requestAlwaysAuthorization()
        }

        // First line after 5 s so the driver hears that the probe is alive.
        nextSpeechAt = Date().addingTimeInterval(5)
        nextFetchAt = Date().addingTimeInterval(10)

        // Backup trigger. Location fixes are the main clock; this timer only
        // acts when a speech or fetch is more than 3 s overdue, which means the
        // fixes stopped while the process was still running.
        backupTimer?.invalidate()
        backupTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.tick(source: "timer")
        }
    }

    private func tick(source: String) {
        guard running else { return }
        let now = Date()
        let slack: TimeInterval = source == "timer" ? 3 : 0
        if now >= nextSpeechAt.addingTimeInterval(slack) {
            nextSpeechAt = now.addingTimeInterval(Self.speechInterval)
            speak(trigger: source)
        }
        if now >= nextFetchAt.addingTimeInterval(slack) {
            nextFetchAt = now.addingTimeInterval(Self.fetchInterval)
            fetch(trigger: source)
        }
    }

    // MARK: - Location

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        log.append("AUTH", "status=\(authString) accuracy=\(accuracyString)")
        let status = manager.authorizationStatus
        if waitingForPermission {
            if status == .authorizedWhenInUse || status == .authorizedAlways {
                begin()
            } else if status == .denied || status == .restricted {
                waitingForPermission = false
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard running, let location = locations.last else { return }
        let now = Date()
        fixCount += 1
        lastSpeed = location.speed
        lastAccuracy = location.horizontalAccuracy
        lastFixAt = now
        let age = now.timeIntervalSince(location.timestamp)
        var details = "n=\(fixCount) acc=\(format(location.horizontalAccuracy, 0)) "
            + "speed=\(location.speed < 0 ? "na" : format(location.speed, 1)) "
            + "age=\(format(age, 1)) app=\(appState)"
        if locations.count > 1 {
            details += " batch=\(locations.count)"
        }
        log.append("LOC", details)
        onFix?([
            "n": fixCount,
            "accuracy": location.horizontalAccuracy,
            "speed": location.speed
        ])
        tick(source: "location")
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let ns = error as NSError
        log.append("LOC_ERROR", "domain=\(ns.domain) code=\(ns.code) app=\(appState)")
    }

    func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        log.append("LOC_PAUSED", "iOS paused location updates app=\(appState)")
    }

    func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
        log.append("LOC_RESUMED", "app=\(appState)")
    }

    // MARK: - Speech

    private func speak(trigger: String) {
        if !currentSpeechDone {
            fail(currentSpeech, "next line was due before this one ended")
            synth.stopSpeaking(at: .immediate)
        }
        speechCount += 1
        let n = speechCount
        currentSpeech = n
        currentSpeechStarted = false
        currentSpeechDone = false
        currentSpeechStartedAt = nil

        let time = clock.string(from: Date())
        let text: String
        if lastSpeed < 0 {
            text = "Probe \(n). Speed unknown. \(time)."
        } else if lastSpeed < 0.5 {
            text = "Probe \(n), standing still. \(time)."
        } else {
            text = "Probe \(n). \(time)."
        }

        let audio = AVAudioSession.sharedInstance()
        do {
            // Spoken prompt that plays over other audio: music is ducked, other
            // spoken audio (podcasts, another app's prompts) is paused briefly.
            try audio.setCategory(
                .playback,
                mode: .voicePrompt,
                options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
            )
            try audio.setActive(true)
        } catch {
            let ns = error as NSError
            log.append(
                "AUDIO_ERROR",
                "n=\(n) could not activate session domain=\(ns.domain) code=\(ns.code) app=\(appState)"
            )
            // Still try to speak: whether it works anyway is worth knowing.
        }

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utteranceNumbers[ObjectIdentifier(utterance)] = n
        log.append(
            "SPEECH_REQUEST",
            "n=\(n) trigger=\(trigger) app=\(appState) route=\(routeString) text=\"\(text)\""
        )
        synth.speak(utterance)

        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self = self, self.currentSpeech == n, !self.currentSpeechStarted,
                  !self.currentSpeechDone else { return }
            self.fail(n, "did not start within 6 s")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self = self, self.currentSpeech == n, !self.currentSpeechDone else { return }
            self.fail(n, "did not finish within 20 s")
            self.synth.stopSpeaking(at: .immediate)
        }
    }

    /// Marks the current line as failed (once) and releases the audio session.
    private func fail(_ n: Int, _ reason: String) {
        guard currentSpeech == n, !currentSpeechDone else { return }
        currentSpeechDone = true
        speechFailedCount += 1
        log.append("SPEECH_FAILED", "n=\(n) reason=\(reason) app=\(appState) route=\(routeString)")
        deactivateAudio()
    }

    private func number(of utterance: AVSpeechUtterance) -> Int {
        return utteranceNumbers[ObjectIdentifier(utterance)] ?? 0
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            let n = self.number(of: utterance)
            self.speechStartedCount += 1
            if n == self.currentSpeech {
                self.currentSpeechStarted = true
                self.currentSpeechStartedAt = Date()
            }
            self.log.append("SPEECH_STARTED", "n=\(n) app=\(self.appState) route=\(self.routeString)")
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            let n = self.number(of: utterance)
            self.utteranceNumbers[ObjectIdentifier(utterance)] = nil
            var details = "n=\(n) app=\(self.appState) route=\(self.routeString)"
            if n == self.currentSpeech, !self.currentSpeechDone {
                self.currentSpeechDone = true
                self.speechFinishedCount += 1
                if let started = self.currentSpeechStartedAt {
                    details += " ms=\(Int(Date().timeIntervalSince(started) * 1000))"
                }
                self.log.append("SPEECH_FINISHED", details)
                self.deactivateAudioSoon()
            } else {
                self.log.append("SPEECH_FINISHED_LATE", details)
            }
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            let n = self.number(of: utterance)
            self.utteranceNumbers[ObjectIdentifier(utterance)] = nil
            self.log.append("SPEECH_CANCELLED", "n=\(n) app=\(self.appState)")
            self.fail(n, "cancelled")
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            self.log.append(
                "SPEECH_PAUSED",
                "n=\(self.number(of: utterance)) iOS paused the line app=\(self.appState) route=\(self.routeString)"
            )
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            self.log.append("SPEECH_CONTINUED", "n=\(self.number(of: utterance)) app=\(self.appState)")
        }
    }

    private func deactivateAudioSoon() {
        // A short pause so the last syllable is not clipped, then give the
        // audio back so music returns to full volume.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.deactivateAudio()
        }
    }

    private func deactivateAudio() {
        if synth.isSpeaking { return }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            let ns = error as NSError
            log.append("AUDIO_ERROR", "could not deactivate session domain=\(ns.domain) code=\(ns.code)")
        }
    }

    // MARK: - Fetch

    private func fetch(trigger: String) {
        fetchCount += 1
        let n = fetchCount
        var request = URLRequest(url: Self.fetchURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let startedAt = Date()
        log.append("FETCH_REQUEST", "n=\(n) trigger=\(trigger) app=\(appState)")
        let task = urlSession.dataTask(with: request) { data, response, error in
            let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
            DispatchQueue.main.async {
                if let error = error {
                    let ns = error as NSError
                    self.fetchFailedCount += 1
                    self.log.append(
                        "FETCH_FAILED",
                        "n=\(n) ms=\(ms) domain=\(ns.domain) code=\(ns.code) app=\(self.appState)"
                    )
                    return
                }
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(code) {
                    self.fetchOkCount += 1
                    self.log.append(
                        "FETCH_OK",
                        "n=\(n) ms=\(ms) status=\(code) bytes=\(data?.count ?? 0) app=\(self.appState)"
                    )
                } else {
                    self.fetchFailedCount += 1
                    self.log.append("FETCH_FAILED", "n=\(n) ms=\(ms) status=\(code) app=\(self.appState)")
                }
            }
        }
        task.resume()
    }

    // MARK: - Audio route and interruptions

    private func routeChanged(_ note: Notification) {
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: raw) ?? .unknown
        let route = routeString
        // Our own activate/deactivate produces a category-change notification
        // for every spoken line; only log those when the output really changed.
        if reason == .categoryChange && route == lastLoggedRoute { return }
        lastLoggedRoute = route
        log.append("ROUTE_CHANGE", "route=\(route) reason=\(reasonString(reason)) app=\(appState)")
    }

    private func audioInterrupted(_ note: Notification) {
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
        let kind = AVAudioSession.InterruptionType(rawValue: raw)
        let label = kind == .began ? "began" : (kind == .ended ? "ended" : "unknown")
        log.append("AUDIO_INTERRUPTION", "\(label) app=\(appState) route=\(routeString)")
    }

    private func reasonString(_ reason: AVAudioSession.RouteChangeReason) -> String {
        switch reason {
        case .newDeviceAvailable: return "new-device"
        case .oldDeviceUnavailable: return "device-removed"
        case .categoryChange: return "category-change"
        case .override: return "override"
        case .wakeFromSleep: return "wake-from-sleep"
        case .noSuitableRouteForCategory: return "no-suitable-route"
        case .routeConfigurationChange: return "configuration-change"
        case .unknown: return "unknown"
        @unknown default: return "other"
        }
    }

    /// Output port types only (never port names, which can contain a person's
    /// or a car's name).
    private var routeString: String {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        if outputs.isEmpty { return "none" }
        return outputs.map { portName($0.portType) }.joined(separator: "+")
    }

    private func portName(_ port: AVAudioSession.Port) -> String {
        switch port {
        case .builtInSpeaker: return "speaker"
        case .builtInReceiver: return "receiver"
        case .headphones: return "headphones"
        case .carAudio: return "carplay"
        case .bluetoothA2DP: return "bluetooth-a2dp"
        case .bluetoothHFP: return "bluetooth-hfp"
        case .bluetoothLE: return "bluetooth-le"
        case .airPlay: return "airplay"
        case .usbAudio: return "usb"
        case .lineOut: return "line-out"
        case .HDMI: return "hdmi"
        default: return port.rawValue
        }
    }

    // MARK: - Small helpers

    private var appState: String {
        switch UIApplication.shared.applicationState {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown"
        }
    }

    private var authString: String {
        switch manager.authorizationStatus {
        case .notDetermined: return "not-determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "when-in-use"
        @unknown default: return "unknown"
        }
    }

    private var accuracyString: String {
        switch manager.accuracyAuthorization {
        case .fullAccuracy: return "precise"
        case .reducedAccuracy: return "approximate"
        @unknown default: return "unknown"
        }
    }

    private func format(_ value: Double, _ decimals: Int) -> String {
        return String(format: "%.\(decimals)f", value)
    }
}
