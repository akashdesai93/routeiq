import Capacitor
import Foundation
import UIKit

/// Thin Capacitor bridge over ProbeEngine. The web page only starts, stops and
/// displays; it is never in the path of location, speech, fetch or logging.
///
/// The Capacitor CLI finds plugin classes by taking the first Objective-C name
/// annotation in each Swift file, so the one below must stay the first in this
/// file (do not write one in a comment above it), and the other Swift files in
/// this package must not contain any.
@objc(ProbeNativePlugin)
public class ProbeNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ProbeNativePlugin"
    public let jsName = "ProbeNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "jsHeartbeat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "jsNote", returnType: CAPPluginReturnPromise)
    ]

    private var engine: ProbeEngine?

    override public func load() {
        let setUp = {
            let engine = ProbeEngine()
            engine.onFix = { [weak self] data in
                self?.notifyListeners("fix", data: data)
            }
            engine.attach()
            self.engine = engine
        }
        // CLLocationManager must be created on the main thread.
        if Thread.isMainThread {
            setUp()
        } else {
            DispatchQueue.main.sync(execute: setUp)
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let engine = self.engine else {
                call.reject("Probe engine not loaded")
                return
            }
            if let message = engine.start() {
                call.reject(message)
            } else {
                call.resolve(engine.status())
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.engine?.stop()
            call.resolve(self.engine?.status() ?? [:])
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(self.engine?.status() ?? [:])
        }
    }

    /// Text of the most recent session, for the on-screen summary.
    @objc func readLog(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(["text": ProbeLog.shared.lastSessionText()])
        }
    }

    /// Opens the iOS share sheet with the whole log file.
    @objc func exportLog(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController else {
                call.reject("No view controller to present from")
                return
            }
            let url = ProbeLog.shared.fileURL
            guard FileManager.default.fileExists(atPath: url.path) else {
                call.reject("The log is empty")
                return
            }
            ProbeLog.shared.append("EXPORT", "share sheet opened")
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = controller.view
                popover.sourceRect = CGRect(
                    x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1
                )
                popover.permittedArrowDirections = []
            }
            controller.present(sheet, animated: true) {
                call.resolve()
            }
        }
    }

    /// The page's own 10 s timer reports in here. Gaps between these lines
    /// show when iOS suspended or throttled the WebView's JavaScript.
    @objc func jsHeartbeat(_ call: CAPPluginCall) {
        let seq = call.getInt("seq") ?? -1
        let sinceLast = call.getInt("sinceLastMs") ?? -1
        let fixEvents = call.getInt("nativeFixEvents") ?? -1
        let pluginFixes = call.getInt("pluginFixes") ?? -1
        let hidden = call.getBool("hidden") ?? false
        ProbeLog.shared.append(
            "JS_TIMER",
            "seq=\(seq) sinceLastMs=\(sinceLast) nativeFixEventsSeenByJs=\(fixEvents) "
                + "geoPluginFixesSeenByJs=\(pluginFixes) pageHidden=\(hidden)"
        )
        call.resolve()
    }

    /// Free-text note from the page (errors, watcher status). Never coordinates.
    @objc func jsNote(_ call: CAPPluginCall) {
        let message = String((call.getString("message") ?? "").prefix(200))
        ProbeLog.shared.append("JS_NOTE", message)
        call.resolve()
    }
}
