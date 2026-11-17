import QuartzCore
import UIKit
import WebKit

/// The phone lab's native eyes on the web view, for #136 (the driving screen black on the
/// iPhone while the page is laid out and answers script). Created only in lab mode
/// (RouteIQNativePlugin.setUpLab): it watches the main thread for stalls, notes when the web
/// content process ends, reads where the web view and its scroll view are, takes a snapshot when
/// asked, and runs the candidate "kicks" that make a web view present again.
///
/// What it reports is sizes, times, counts and fixed words: nothing about where the phone is.
/// Everything except the stall watch runs on the main thread.
final class RouteIQLabMonitor: NSObject {
    /// A main-thread wait this long or longer is written down, in milliseconds.
    static let stallMs = 100
    /// How often the stall watch pings the main thread, in seconds.
    static let pingSec = 0.05
    /// How many stalls and events are kept.
    static let keep = 40
    /// When the kicks of a "kick-…" switch run after the drive starts, in seconds.
    static let kickAfterSec: [Double] = [0.5, 2, 5]
    /// When the "snapshot" switch takes its snapshots after the drive starts, in seconds.
    static let snapshotAfterSec: [Double] = [3, 9, 18]

    private weak var webView: WKWebView?
    private let launchedAt = CACurrentMediaTime()
    /// Written on the main thread under the lock; read by the stall watch under the lock.
    private var driveStartedAt: Double?

    // The stall watch: written on its own queue, read on the main thread, behind the lock.
    private let lock = NSLock()
    private let watchQueue = DispatchQueue(label: "routeiq.lab.stallwatch")
    private var watchTimer: DispatchSourceTimer?
    private var pingSentAt: Double?
    private var stalls: [String] = []
    private var longestStallMs = 0
    private var longestStallAt = 0.0
    private var longestAfterStartMs = 0

    private var events: [String] = []
    private var terminations = 0
    private var lastSnapshot: [String: Any]?
    private var navigationProxy: RouteIQLabNavigationProxy?
    private var observers: [NSObjectProtocol] = []

    init(webView: WKWebView?) {
        self.webView = webView
        super.init()
    }

    // MARK: - Start

    /// Starts the watches and applies the switches that act on the web view from the start.
    func start() {
        let switches = RouteIQLab.active
        note("lab monitor on, switches \(switches.map(\.rawValue).sorted().joined(separator: "+"))")
        startStallWatch()
        if let webView = webView {
            // Told when the web content process ends, without taking the delegate's place.
            let proxy = RouteIQLabNavigationProxy(original: webView.navigationDelegate) { [weak self] in
                self?.terminations += 1
                self?.note("web content process terminated")
            }
            navigationProxy = proxy
            webView.navigationDelegate = proxy
            if switches.contains(.insetsNever) {
                webView.scrollView.contentInsetAdjustmentBehavior = .never
                note("scroll view insets: never")
            }
            if switches.contains(.marks) { paintMarks(webView) }
        }
        let states: [(Notification.Name, String)] = [
            (UIApplication.didBecomeActiveNotification, "active"),
            (UIApplication.willResignActiveNotification, "inactive"),
            (UIApplication.didEnterBackgroundNotification, "background"),
            (UIApplication.willEnterForegroundNotification, "foreground"),
            (UIApplication.didReceiveMemoryWarningNotification, "memory warning")
        ]
        for (name, word) in states {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self = self else { return }
                self.note("app \(word)")
                if word == "active" { self.runSwitchKicks(reason: "active") }
            })
        }
    }

    /// The window cyan, the web view magenta, its scroll view green: whichever colour a
    /// screenshot shows where the page should be is the layer that is on the glass.
    private func paintMarks(_ webView: WKWebView) {
        webView.window?.backgroundColor = .cyan
        webView.backgroundColor = .magenta
        webView.scrollView.backgroundColor = .green
        // The window may not be there yet while the plugins load.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak webView] in
            webView?.window?.backgroundColor = .cyan
        }
        note("marks painted: window cyan, web view magenta, scroll view green")
    }

    // MARK: - The drive starts

    /// Called when the web app starts the location stream for a drive.
    func driveStarted() {
        let now = CACurrentMediaTime()
        if let at = driveStartedAt, now - at < 30 { return }
        lock.lock()
        driveStartedAt = now
        longestAfterStartMs = 0
        lock.unlock()
        note("drive started (location stream asked for)")
        for after in Self.kickAfterSec {
            DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in
                self?.runSwitchKicks(reason: "drive +\(after) s")
            }
        }
        if RouteIQLab.active.contains(.snapshot) {
            for after in Self.snapshotAfterSec {
                DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in
                    self?.snapshot { _ in }
                }
            }
        }
    }

    private func runSwitchKicks(reason: String) {
        for item in RouteIQLab.active.sorted(by: { $0.rawValue < $1.rawValue }) {
            guard let name = RouteIQLab.kickName(item) else { continue }
            note("kick \(name) (\(reason)): \(kick(name))")
        }
    }

    // MARK: - Kicks (remedy a)

    /// Kicks that might make a web view that stopped presenting present again, mildest first.
    static let kicks = ["layout", "display", "scroll", "frame", "opaque", "readd"]

    /// Runs one kick on the web view. Returns what it did, as fixed words.
    func kick(_ name: String) -> String {
        guard let webView = webView else { return "no web view" }
        let scroll = webView.scrollView
        switch name {
        case "layout":
            webView.setNeedsLayout()
            webView.layoutIfNeeded()
            scroll.setNeedsLayout()
            scroll.layoutIfNeeded()
            return "setNeedsLayout + layoutIfNeeded on the web view and its scroll view"
        case "display":
            webView.setNeedsDisplay()
            scroll.setNeedsDisplay()
            webView.layer.setNeedsLayout()
            return "setNeedsDisplay on the web view and its scroll view"
        case "scroll":
            let offset = scroll.contentOffset
            scroll.setContentOffset(CGPoint(x: offset.x, y: offset.y + 1), animated: false)
            DispatchQueue.main.async { scroll.setContentOffset(offset, animated: false) }
            return "scroll offset 1 point down and back"
        case "frame":
            let frame = webView.frame
            webView.frame = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height - 1)
            webView.layoutIfNeeded()
            DispatchQueue.main.async {
                webView.frame = frame
                webView.layoutIfNeeded()
            }
            return "frame 1 point shorter and back"
        case "opaque":
            let was = webView.isOpaque
            webView.isOpaque = !was
            DispatchQueue.main.async { webView.isOpaque = was }
            return "isOpaque toggled and back (was \(was))"
        case "readd":
            guard let parent = webView.superview, let index = parent.subviews.firstIndex(of: webView) else { return "no superview" }
            webView.removeFromSuperview()
            parent.insertSubview(webView, at: index)
            return "removed from its superview and put back"
        default:
            return "unknown kick"
        }
    }

    // MARK: - Snapshot

    /// A native snapshot of the web view: did the web content render? Writes it to the lab's
    /// snapshot file and answers with how flat it is. Tells "nothing rendered" (flat) from
    /// "rendered but not on the glass" (detailed snapshot, black screenshot).
    func snapshot(_ done: @escaping ([String: Any]) -> Void) {
        guard let webView = webView else {
            done(["failed": "no web view"])
            return
        }
        let asked = CACurrentMediaTime()
        webView.takeSnapshot(with: nil) { [weak self] image, error in
            var out: [String: Any] = ["ms": Int((CACurrentMediaTime() - asked) * 1000), "at": self?.since() ?? ""]
            if let image = image {
                out["size"] = [Int(image.size.width), Int(image.size.height)]
                if let look = RouteIQLabMonitor.look(image) {
                    out["flat"] = look.flat
                    out["shade"] = look.shade
                }
                if let png = image.pngData() { out["saved"] = RouteIQLab.writeSnapshot(png) }
            } else {
                out["failed"] = error == nil ? "no image" : "error"
            }
            self?.lastSnapshot = out
            self?.note("snapshot: \(out["flat"].map { "flat \($0)" } ?? "failed")")
            done(out)
        }
    }

    /// The share of a small grey copy of the image within a few shades of its commonest shade.
    static func look(_ image: UIImage) -> (flat: Double, shade: Int)? {
        guard let cg = image.cgImage else { return nil }
        let width = 45, height = 90
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn: Bool = pixels.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        var histogram = [Int](repeating: 0, count: 256)
        for p in pixels { histogram[Int(p)] += 1 }
        let commonest = histogram.indices.max(by: { histogram[$0] < histogram[$1] }) ?? 0
        let near = histogram[max(0, commonest - 6)...min(255, commonest + 6)].reduce(0, +)
        return (flat: Double(near) / Double(width * height), shade: commonest)
    }

    // MARK: - Probe

    /// Where the web view is and how it is set up, plus the stalls and events so far. Reading
    /// these changes nothing on the screen.
    func probe() -> [String: Any] {
        var out: [String: Any] = ["at": since()]
        let state: String
        switch UIApplication.shared.applicationState {
        case .active: state = "active"
        case .inactive: state = "inactive"
        case .background: state = "background"
        @unknown default: state = "unknown"
        }
        out["appState"] = state
        if let webView = webView {
            let scroll = webView.scrollView
            out["webView"] = [
                "frame": rect(webView.frame),
                "inWindow": webView.window != nil,
                "hidden": webView.isHidden,
                "alpha": Double(webView.alpha),
                "opaque": webView.isOpaque,
                "background": colour(webView.backgroundColor),
                "layerInTree": webView.layer.superlayer != nil,
                "layerHidden": webView.layer.isHidden,
                "sublayers": webView.layer.sublayers?.count ?? 0,
                "safeArea": insets(webView.safeAreaInsets),
                "loading": webView.isLoading
            ]
            out["scrollView"] = [
                "frame": rect(scroll.frame),
                "offset": [Int(scroll.contentOffset.x), Int(scroll.contentOffset.y)],
                "contentSize": [Int(scroll.contentSize.width), Int(scroll.contentSize.height)],
                "inset": insets(scroll.contentInset),
                "adjustedInset": insets(scroll.adjustedContentInset),
                "behavior": scroll.contentInsetAdjustmentBehavior == .never ? "never" : scroll.contentInsetAdjustmentBehavior == .always ? "always" : "other",
                "background": colour(scroll.backgroundColor),
                "zoom": Double(scroll.zoomScale)
            ]
            if let window = webView.window {
                out["window"] = ["frame": rect(window.frame), "background": colour(window.backgroundColor), "safeArea": insets(window.safeAreaInsets)]
            }
        } else {
            out["webView"] = "none"
        }
        out["idleTimerDisabled"] = UIApplication.shared.isIdleTimerDisabled
        lock.lock()
        out["stall"] = ["longestMs": longestStallMs, "longestAt": String(format: "%.1f", longestStallAt), "longestSinceDriveMs": longestAfterStartMs, "list": stalls]
        lock.unlock()
        out["terminations"] = terminations
        out["events"] = events
        if let shot = lastSnapshot { out["snapshot"] = shot }
        return out
    }

    // MARK: - Stall watch

    /// Pings the main thread from a queue of its own; a ping that waits is a stalled main thread.
    private func startStallWatch() {
        let timer = DispatchSource.makeTimerSource(queue: watchQueue)
        timer.schedule(deadline: .now() + Self.pingSec, repeating: Self.pingSec)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            // One ping out at a time: its age when it lands is the length of the stall.
            if self.pingSentAt != nil { return }
            let sent = CACurrentMediaTime()
            self.pingSentAt = sent
            DispatchQueue.main.async {
                let waitedMs = Int((CACurrentMediaTime() - sent) * 1000)
                self.watchQueue.async {
                    self.pingSentAt = nil
                    self.recordStall(waitedMs, at: sent)
                }
            }
        }
        timer.resume()
        watchTimer = timer
    }

    private func recordStall(_ ms: Int, at: Double) {
        guard ms >= Self.stallMs else { return }
        lock.lock()
        defer { lock.unlock() }
        let t = at - launchedAt
        if ms > longestStallMs {
            longestStallMs = ms
            longestStallAt = t
        }
        var drive = ""
        if let started = driveStartedAt {
            drive = String(format: " (drive %+.1f s)", at - started)
            if at >= started { longestAfterStartMs = max(longestAfterStartMs, ms) }
        }
        stalls.append(String(format: "%.1f s: %d ms", t, ms) + drive)
        if stalls.count > Self.keep { stalls.removeFirst() }
    }

    // MARK: - Words

    func note(_ what: String) {
        events.append("\(since()) \(what)")
        if events.count > Self.keep { events.removeFirst() }
    }

    /// Seconds since launch, and since the drive started when it has.
    private func since() -> String {
        let now = CACurrentMediaTime()
        let launch = String(format: "%.1f", now - launchedAt)
        guard let started = driveStartedAt else { return "t\(launch)" }
        return "t\(launch)/d\(String(format: "%.1f", now - started))"
    }

    private func rect(_ r: CGRect) -> [Int] { [Int(r.minX), Int(r.minY), Int(r.width), Int(r.height)] }
    private func insets(_ i: UIEdgeInsets) -> [Int] { [Int(i.top), Int(i.left), Int(i.bottom), Int(i.right)] }
    private func colour(_ c: UIColor?) -> String {
        guard let c = c else { return "none" }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.resolvedColor(with: UITraitCollection.current).getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "%02x%02x%02x/%.2f", Int(r * 255), Int(g * 255), Int(b * 255), a)
    }
}

/// Stands in as the web view's navigation delegate to hear that the web content process ended,
/// and hands every message on to the delegate it replaced (Capacitor's, which reloads the page).
final class RouteIQLabNavigationProxy: NSObject, WKNavigationDelegate {
    private weak var original: WKNavigationDelegate?
    private let onTerminate: () -> Void

    init(original: WKNavigationDelegate?, onTerminate: @escaping () -> Void) {
        self.original = original
        self.onTerminate = onTerminate
        super.init()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        onTerminate()
        original?.webViewWebContentProcessDidTerminate?(webView)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (original?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let original = original, original.responds(to: aSelector) { return original }
        return super.forwardingTarget(for: aSelector)
    }
}
