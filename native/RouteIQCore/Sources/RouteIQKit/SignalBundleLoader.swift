import Foundation

/// Reads the packed signal bundle once, off the main thread, and keeps it.
/// The app hands it the URL of `osm-signals.json` in its resources; nil (no
/// bundle in this build) or a file that cannot be read gives no bundle, and
/// every signal count then reads "unknown".
public actor SignalBundleLoader {
    private let url: URL?
    private var loaded: SignalBundle??

    public init(url: URL?) {
        self.url = url
    }

    /// The bundle, read on the first call only.
    public func bundle() -> SignalBundle? {
        if let loaded { return loaded }
        let bundle = url.flatMap { try? SignalBundle(packed: Data(contentsOf: $0)) }
        loaded = .some(bundle)
        return bundle
    }
}
