import Capacitor
import Foundation
import UIKit

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
        CAPPluginMethod(name: "httpCancel", returnType: CAPPluginReturnPromise)
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
}
