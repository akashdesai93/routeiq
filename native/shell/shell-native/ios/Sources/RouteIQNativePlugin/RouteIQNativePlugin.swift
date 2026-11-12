import Capacitor
import Foundation
import UIKit
import WebKit

/// Thin Capacitor bridge over RouteIQEngine. The web app calls these methods
/// and listens for the events "fix", "locationError", "tick" and "appState"
/// (src/device/native in the repository root is the other side).
///
/// The Capacitor CLI finds plugin classes by taking the first Objective-C name
/// annotation in each Swift file, so the one below must stay the first in this
/// file (do not write one in a comment above it), and the other Swift files in
/// this package must not contain any.
@objc(RouteIQNativePlugin)
public class RouteIQNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RouteIQNativePlugin"
    public let jsName = "RouteIQNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "httpGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "httpCancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSimulatedRoute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSimulatedRoute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lab", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "labReport", returnType: CAPPluginReturnPromise)
    ]

    private var engine: RouteIQEngine?
    private var http: RouteIQHttp?
    private var appStateObservers: [NSObjectProtocol] = []

    override public func load() {
        let setUp = {
            let engine = RouteIQEngine()
            engine.onFix = { [weak self] fix in
                self?.notifyListeners("fix", data: fix)
            }
            engine.onLocationError = { [weak self] kind in
                self?.notifyListeners("locationError", data: ["kind": kind])
            }
            engine.onTick = { [weak self] in
                self?.notifyListeners("tick", data: [:])
            }
            self.engine = engine
            self.http = RouteIQHttp()
            // For the web app's drive diagnostics: when the app went to the
            // background (the phone was locked) and when it came back.
            let states: [(Notification.Name, String)] = [
                (UIApplication.didBecomeActiveNotification, "active"),
                (UIApplication.willResignActiveNotification, "inactive"),
                (UIApplication.didEnterBackgroundNotification, "background")
            ]
            for (name, state) in states {
                let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.notifyListeners("appState", data: ["state": state])
                }
                self.appStateObservers.append(observer)
            }
            self.setUpLab()
        }
        // CLLocationManager must be created on the main thread.
        if Thread.isMainThread {
            setUp()
        } else {
            DispatchQueue.main.sync(execute: setUp)
        }
    }

    @objc func startLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let engine = self.engine else {
                call.reject("The location engine is not loaded", "unavailable")
                return
            }
            engine.startLocation { error in
                if let error = error {
                    call.reject("Location is not available: \(error)", error)
                } else {
                    call.resolve(["authorization": engine.authorization])
                }
            }
        }
    }

    @objc func stopLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.engine?.stopLocation()
            call.resolve()
        }
    }

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let engine = self.engine else {
                call.reject("The location engine is not loaded", "unavailable")
                return
            }
            engine.currentPosition { fix, error in
                if let fix = fix {
                    call.resolve(fix)
                } else {
                    let kind = error ?? "unavailable"
                    call.reject("Location is not available: \(kind)", kind)
                }
            }
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async {
            guard let engine = self.engine, !text.isEmpty else {
                call.resolve(["finished": false])
                return
            }
            engine.speak(text) { finished in
                call.resolve(["finished": finished])
            }
        }
    }

    @objc func cancelSpeech(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.engine?.cancelSpeech()
            call.resolve()
        }
    }

    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            self.engine?.keepAwake(on)
            call.resolve()
        }
    }

    // MARK: - Test drive (simulated positions)

    /// The "Test drive": "fix" events are made up from now on, along `points`
    /// ([lng, lat] pairs) at `speedMps`, following `script` (steps with `atM`
    /// and `speedMps` and/or `stopSec`). Rejects with the code "invalid" when
    /// no point is usable. The points are the web app's made-up route; they
    /// are never put in a message or a log.
    @objc func startSimulatedRoute(_ call: CAPPluginCall) {
        var points: [(lng: Double, lat: Double)] = []
        for item in call.getArray("points") ?? [] {
            if points.count >= RouteIQSimulation.maxPoints { break }
            guard let pair = item as? NSArray, pair.count >= 2,
                  let lng = pair[0] as? NSNumber, let lat = pair[1] as? NSNumber else { continue }
            points.append((lng: lng.doubleValue, lat: lat.doubleValue))
        }
        var steps: [RouteIQSimulation.Step] = []
        for item in call.getArray("script") ?? [] {
            guard let step = item as? NSDictionary, let atM = step["atM"] as? NSNumber else { continue }
            steps.append(RouteIQSimulation.Step(
                atM: atM.doubleValue,
                speedMps: (step["speedMps"] as? NSNumber)?.doubleValue,
                stopSec: (step["stopSec"] as? NSNumber)?.doubleValue
            ))
        }
        let speedMps = call.getDouble("speedMps") ?? 0
        DispatchQueue.main.async {
            guard let engine = self.engine else {
                call.reject("The location engine is not loaded", "unavailable")
                return
            }
            if engine.startSimulatedRoute(points: points, speedMps: speedMps, steps: steps) {
                call.resolve()
            } else {
                call.reject("The simulated route has no usable point", "invalid")
            }
        }
    }

    @objc func stopSimulatedRoute(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.engine?.stopSimulatedRoute()
            call.resolve()
        }
    }

    // MARK: - Share

    /// Opens the iOS share sheet with the given text (the drive diagnostics:
    /// counts and timings). Resolves when the sheet is closed, with whether
    /// something was done with it. The text goes to the sheet and nowhere else.
    @objc func share(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async {
            guard !text.isEmpty, let root = self.bridge?.viewController else {
                call.reject("There is nothing to share", "unavailable")
                return
            }
            // Whatever is on top presents it; a sheet already up cannot present another.
            var presenter: UIViewController = root
            while let above = presenter.presentedViewController {
                if above is UIActivityViewController {
                    call.reject("The share sheet is already open", "busy")
                    return
                }
                presenter = above
            }
            // A presenter that is going away or is not on screen would fail without a word.
            guard !presenter.isBeingDismissed, presenter.viewIfLoaded?.window != nil else {
                call.reject("The share sheet cannot be shown right now", "unavailable")
                return
            }
            let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
            // iOS can report more than once (an activity cancelled back to the sheet): answer the first time only.
            var answered = false
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                if answered { return }
                answered = true
                call.resolve(["completed": completed])
            }
            // On an iPad the sheet is a popover and needs to know where from.
            if let popover = sheet.popoverPresentationController, let view = presenter.view {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 1, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true)
        }
    }

    // MARK: - Route requests

    /// GET to Mapbox through URLSession. Resolves with the HTTP status, the
    /// body as text and how long it took; rejects with the code "not-allowed",
    /// "cancelled", "timeout", "network" or "unavailable". The URL holds the
    /// token and a position, so it is never put in a message or a log.
    @objc func httpGet(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let url = call.getString("url") ?? ""
        let timeoutMs = call.getDouble("timeoutMs") ?? 20000
        DispatchQueue.main.async {
            guard let http = self.http, !id.isEmpty else {
                call.reject("The request could not be made", "unavailable")
                return
            }
            http.get(id: id, url: url, timeoutSec: timeoutMs / 1000) { outcome in
                switch outcome {
                case let .response(status, body, ms):
                    call.resolve(["status": status, "body": body, "ms": ms])
                case let .failure(code):
                    call.reject("The request failed: \(code)", code)
                }
            }
        }
    }

    @objc func httpCancel(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        DispatchQueue.main.async {
            self.http?.cancel(id: id)
            call.resolve()
        }
    }

    // MARK: - Phone lab (off unless started with the lab's launch argument)

    /// With the launch argument only: lets the trusted computer inspect the
    /// web view and, when asked, loads the web app the computer pushed.
    private func setUpLab() {
        guard RouteIQLab.scenario() != nil else { return }
        if #available(iOS 16.4, *) {
            self.bridge?.webView?.isInspectable = true
        }
        guard let folder = RouteIQLab.webDirectory() else { return }
        // Later, not now: the view controller has no bridge yet while plugins load.
        DispatchQueue.main.async {
            (self.bridge?.viewController as? CAPBridgeViewController)?.setServerBasePath(path: folder)
        }
    }

    /// Tells the web app whether the lab is on, and the scenario to run.
    @objc func lab(_ call: CAPPluginCall) {
        if let scenario = RouteIQLab.scenario() {
            call.resolve(["enabled": true, "scenario": scenario])
        } else {
            call.resolve(["enabled": false])
        }
    }

    /// Replaces the lab's report file. Refused when the lab is off.
    @objc func labReport(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        if RouteIQLab.writeReport(text) {
            call.resolve()
        } else {
            call.reject("The lab is off", "not-allowed")
        }
    }
}
