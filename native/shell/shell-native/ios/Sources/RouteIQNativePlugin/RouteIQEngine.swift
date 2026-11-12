import AVFoundation
import CoreLocation
import Foundation
import UIKit

/// The native half of the RouteIQ shell: the GPS and the voice, which iOS
/// keeps running while the phone is locked or another app is in front. The
/// web app inside the shell decides everything (which route, what to say);
/// this file only reports positions and speaks the lines it is given.
///
/// Adapted from the probe's ProbeEngine (branch native-probe): the same
/// CLLocationManager settings and the same audio session.
///
/// Privacy: a position is handed to the web app and kept nowhere. Nothing in
/// this file logs, stores or sends one.
///
/// Everything here runs on the main thread.
final class RouteIQEngine: NSObject, CLLocationManagerDelegate, AVSpeechSynthesizerDelegate {
    private static let askedAlwaysKey = "routeiq.askedAlwaysLocation"
    /// A fix older than this on arrival is a cached one and is not passed on.
    private static let maxFixAgeSec: TimeInterval = 10
    /// Giving the audio back can fail while a line is still stopping; it is tried again this often.
    private static let deactivateRetries = 3

    private let manager = CLLocationManager()
    private let synth = AVSpeechSynthesizer()

    // Location
    private var updating = false
    private var pendingStart: ((String?) -> Void)?
    private var pendingOnce: [(_ fix: [String: Any]?, _ error: String?) -> Void] = []
    private var onceRequested = false
    private var heartbeat: Timer?

    // The "Test drive": a made-up car in place of the GPS (RouteIQSimulation).
    // While it is set, positions from the GPS are discarded.
    private var simulation: RouteIQSimulation?
    private var simulationTimer: Timer?
    private var simulationLastStep: Date?

    // Speech: the line being spoken, and who to tell when it ends.
    private var currentUtterance: AVSpeechUtterance?
    private var currentDone: ((Bool) -> Void)?
    private var speechNumber = 0

    /// One position: lng, lat, accuracy, and speed, course and timestamp when known.
    var onFix: (([String: Any]) -> Void)?
    /// "denied" or "unavailable".
    var onLocationError: ((String) -> Void)?
    /// About once a second while the location stream is on.
    var onTick: (() -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        synth.delegate = self
    }

    // MARK: - Location stream

    /// Starts the stream. `done(nil)` once it is running, `done("denied")`
    /// when the permission is refused. Asks for the permission if it has not
    /// been asked yet.
    func startLocation(_ done: @escaping (String?) -> Void) {
        if updating {
            done(nil)
            return
        }
        switch manager.authorizationStatus {
        case .notDetermined:
            pendingStart?("unavailable")
            pendingStart = done
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            done("denied")
        default:
            begin()
            done(nil)
        }
    }

    func stopLocation() {
        // Ending a drive always ends a test drive too, whatever the web app did or did not call.
        stopSimulatedRoute()
        if let pending = pendingStart {
            pendingStart = nil
            pending("unavailable")
        }
        guard updating else { return }
        updating = false
        manager.stopUpdatingLocation()
        heartbeat?.invalidate()
        heartbeat = nil
        // Someone was waiting for the stream's next fix: ask for one instead.
        if !pendingOnce.isEmpty {
            requestOnce()
        }
    }

    var authorization: String {
        switch manager.authorizationStatus {
        case .notDetermined: return "not-determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "when-in-use"
        @unknown default: return "unknown"
        }
    }

    private func begin() {
        // A one-shot request ("Use my location") still out would end the stream
        // after its single fix. Drop it; the stream's first fix answers it.
        if onceRequested {
            manager.stopUpdatingLocation()
            onceRequested = false
        }
        updating = true
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        // Setting allowsBackgroundLocationUpdates without the background mode
        // in Info.plist is a crash, so check first.
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        if modes.contains("location") {
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
        }
        manager.startUpdatingLocation()

        // "While Using" is enough to keep going in the background once a
        // drive was started with the app in front (the blue indicator shows).
        // "Always" is asked for once, as the probe did: iOS then also lets
        // the stream be started from the background.
        let defaults = UserDefaults.standard
        if manager.authorizationStatus == .authorizedWhenInUse && !defaults.bool(forKey: Self.askedAlwaysKey) {
            defaults.set(true, forKey: Self.askedAlwaysKey)
            manager.requestAlwaysAuthorization()
        }

        // A native clock for the web app: a web page's own timers may be
        // slowed down or held back while the phone is locked.
        heartbeat?.invalidate()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self, self.updating else { return }
            self.onTick?()
        }
        RunLoop.main.add(timer, forMode: .common)
        heartbeat = timer
    }

    // MARK: - Test drive (simulated positions)

    /// From now on `onFix` gets made-up positions, about one a second, along
    /// `points`; the first one at once. Positions from the GPS are discarded
    /// until `stopSimulatedRoute` or `stopLocation`. The GPS itself is not
    /// touched: with the location stream on, it is what keeps the app (and
    /// this timer) running while the phone is locked, exactly as on a real
    /// drive. Calling this again replaces the route. False when no point is
    /// usable; a simulation that was running then carries on.
    func startSimulatedRoute(points: [(lng: Double, lat: Double)], speedMps: Double, steps: [RouteIQSimulation.Step]) -> Bool {
        guard let next = RouteIQSimulation(points: points, speedMps: speedMps, steps: steps) else { return false }
        let wasRunning = simulation != nil && simulationTimer != nil
        simulation = next
        // A route that replaces another carries on in the same rhythm: the
        // next tick of the timer moves the car along the new one.
        if wasRunning { return true }
        simulationLastStep = nil
        simulationTimer?.invalidate()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.stepSimulation()
        }
        RunLoop.main.add(timer, forMode: .common)
        simulationTimer = timer
        // The first position at once, like a phone that already knows where it is.
        stepSimulation()
        return true
    }

    func stopSimulatedRoute() {
        simulationTimer?.invalidate()
        simulationTimer = nil
        simulation = nil
        simulationLastStep = nil
    }

    var isSimulating: Bool { simulation != nil }

    /// Moves the made-up car on by the time since the last step and reports where it is.
    private func stepSimulation() {
        guard var current = simulation else { return }
        let now = Date()
        let elapsed = simulationLastStep.map { now.timeIntervalSince($0) } ?? 0
        simulationLastStep = now
        let fix = current.advance(bySec: elapsed, timestampMs: now.timeIntervalSince1970 * 1000)
        simulation = current
        onFix?(fix)
    }

    // MARK: - One position ("Use my location")

    /// One position without starting a stream. `done(fix, nil)` or
    /// `done(nil, "denied" | "unavailable")`.
    func currentPosition(_ done: @escaping (_ fix: [String: Any]?, _ error: String?) -> Void) {
        switch manager.authorizationStatus {
        case .denied, .restricted:
            done(nil, "denied")
            return
        case .notDetermined:
            pendingOnce.append(done)
            manager.requestWhenInUseAuthorization()
            return
        default:
            pendingOnce.append(done)
            requestOnce()
        }
    }

    private func requestOnce() {
        // While the stream is on, the next fix answers. Otherwise ask for one.
        if updating || onceRequested { return }
        onceRequested = true
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.requestLocation()
    }

    private func answerOnce(fix: [String: Any]?, error: String?) {
        onceRequested = false
        let waiting = pendingOnce
        pendingOnce.removeAll()
        for done in waiting {
            done(fix, error)
        }
    }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        if status == .notDetermined { return }
        let allowed = status == .authorizedWhenInUse || status == .authorizedAlways
        if let pending = pendingStart {
            pendingStart = nil
            if allowed {
                begin()
                pending(nil)
            } else {
                pending("denied")
            }
        } else if updating && !allowed {
            // Taken away in Settings during a drive.
            onLocationError?("denied")
        }
        if !pendingOnce.isEmpty {
            if allowed {
                requestOnce()
            } else {
                answerOnce(fix: nil, error: "denied")
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0 else { return }
        var fix: [String: Any] = [
            "lng": location.coordinate.longitude,
            "lat": location.coordinate.latitude,
            "accuracy": location.horizontalAccuracy,
            "timestamp": location.timestamp.timeIntervalSince1970 * 1000
        ]
        // Core Location says "unknown" with a negative number; the web app with a missing value.
        if location.speed >= 0 { fix["speed"] = location.speed }
        if location.course >= 0 { fix["course"] = location.course }
        if !pendingOnce.isEmpty {
            answerOnce(fix: fix, error: nil)
        }
        // Core Location may first hand over a fix it kept from earlier. The
        // web app stamps fixes on arrival, so an old one must not look new.
        // During a test drive the GPS's position is discarded here: the
        // stream is only on to keep the app running.
        if updating && simulation == nil && location.timestamp.timeIntervalSinceNow > -Self.maxFixAgeSec {
            onFix?(fix)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        let kind = denied ? "denied" : "unavailable"
        if !pendingOnce.isEmpty && (!updating || denied) {
            answerOnce(fix: nil, error: kind)
        }
        // Indoors, on a test drive, "no position right now" is expected and not the drive's problem.
        if updating && (simulation == nil || denied) {
            onLocationError?(kind)
        }
    }

    // MARK: - Speech

    /// Speaks one line over whatever else is playing. `done(true)` when it
    /// was spoken to the end, `done(false)` when it was cut off or failed.
    /// A new line cuts off the one being spoken.
    func speak(_ text: String, _ done: @escaping (Bool) -> Void) {
        endCurrent(finished: false)
        if synth.isSpeaking {
            synth.stopSpeaking(at: .immediate)
        }

        let audio = AVAudioSession.sharedInstance()
        do {
            // A spoken prompt over other audio: music is lowered while it
            // plays; other spoken audio (a podcast) is paused for it.
            try audio.setCategory(
                .playback,
                mode: .voicePrompt,
                options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
            )
            try audio.setActive(true)
        } catch {
            // Still try to speak: the synthesizer may manage by itself.
        }

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        speechNumber += 1
        let number = speechNumber
        currentUtterance = utterance
        currentDone = done
        synth.speak(utterance)

        // If iOS never reports the end (an interruption, a failed voice), do
        // not leave the web app waiting: it has its own, shorter, limit too.
        let limit = 10 + Double(text.count) * 0.15
        DispatchQueue.main.asyncAfter(deadline: .now() + limit) { [weak self] in
            guard let self = self, self.speechNumber == number, self.currentDone != nil else { return }
            self.endCurrent(finished: false)
            self.synth.stopSpeaking(at: .immediate)
            self.deactivateAudioSoon()
        }
    }

    func cancelSpeech() {
        endCurrent(finished: false)
        if synth.isSpeaking {
            synth.stopSpeaking(at: .immediate)
        }
        deactivateAudioSoon()
    }

    /// Tells whoever asked for the current line that it is over (once).
    private func endCurrent(finished: Bool) {
        let done = currentDone
        currentDone = nil
        currentUtterance = nil
        done?(finished)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            // A line that was cut off earlier may report in late; only the current one counts.
            guard utterance === self.currentUtterance else { return }
            self.endCurrent(finished: true)
            self.deactivateAudioSoon()
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            if utterance === self.currentUtterance {
                self.endCurrent(finished: false)
            }
            // Also after cancelSpeech, which has already forgotten the line:
            // only now has the synthesizer really stopped. This does nothing
            // when another line has started meanwhile.
            self.deactivateAudioSoon()
        }
    }

    private func deactivateAudioSoon() {
        // A short pause so the last syllable is not clipped, then give the
        // audio back so music returns to full volume.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.deactivateAudio()
        }
    }

    private func deactivateAudio(attempt: Int = 0) {
        // Another line has started meanwhile: it needs the session.
        if currentDone != nil { return }
        var released = false
        if !synth.isSpeaking {
            do {
                try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                released = true
            } catch {
                // Still busy stopping; tried again below.
            }
        }
        // Otherwise music would stay quiet until the next line, which after
        // a mute never comes.
        if !released && attempt < Self.deactivateRetries {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.deactivateAudio(attempt: attempt + 1)
            }
        }
    }

    // MARK: - Screen

    func keepAwake(_ on: Bool) {
        UIApplication.shared.isIdleTimerDisabled = on
    }
}
