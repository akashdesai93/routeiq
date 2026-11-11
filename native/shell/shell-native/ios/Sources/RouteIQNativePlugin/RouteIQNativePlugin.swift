import Capacitor
import Foundation
import UIKit

/// Thin Capacitor bridge over RouteIQEngine. The web app calls these methods
/// and listens for the events "fix", "locationError" and "tick"
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
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise)
    ]

    private var engine: RouteIQEngine?

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
}
