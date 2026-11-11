import Foundation

/// Append-only text log in the app's Documents folder.
///
/// One line per event: `<ISO-8601 local time with offset> TAB <EVENT> TAB <details>`.
/// Every line is written straight to the file, so the log survives the app
/// being killed. The file uses "until first unlock" data protection so it can
/// still be written while the phone is locked.
final class ProbeLog {
    static let shared = ProbeLog()

    let fileURL: URL
    private let previousURL: URL
    private let lock = NSLock()
    private var handle: FileHandle?
    private let formatter: DateFormatter
    private let rotateAboveBytes: UInt64 = 8 * 1024 * 1024

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = docs.appendingPathComponent("routeiq-probe-log.txt")
        previousURL = docs.appendingPathComponent("routeiq-probe-log-previous.txt")
        formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"
    }

    func append(_ event: String, _ details: String = "") {
        lock.lock()
        defer { lock.unlock() }
        var line = formatter.string(from: Date()) + "\t" + event
        if !details.isEmpty {
            line += "\t" + details.replacingOccurrences(of: "\n", with: " ")
        }
        line += "\n"
        guard let data = line.data(using: .utf8) else { return }
        do {
            let h = try openHandle()
            try h.seekToEnd()
            try h.write(contentsOf: data)
        } catch {
            // Drop the handle so the next append reopens the file.
            try? handle?.close()
            handle = nil
        }
    }

    /// Called at the start of a session: keeps the file from growing forever.
    func rotateIfNeeded() {
        lock.lock()
        defer { lock.unlock() }
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: fileURL.path),
              let size = attrs[.size] as? NSNumber,
              size.uint64Value > rotateAboveBytes else { return }
        try? handle?.close()
        handle = nil
        try? fm.removeItem(at: previousURL)
        try? fm.moveItem(at: fileURL, to: previousURL)
    }

    func sizeBytes() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        return (attrs?[.size] as? NSNumber)?.intValue ?? 0
    }

    func readAll() -> String {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: fileURL) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Text from the most recent SESSION_START line to the end of the file.
    func lastSessionText() -> String {
        let text = readAll()
        guard let marker = text.range(of: "\tSESSION_START", options: .backwards) else {
            return text
        }
        let head = text[..<marker.lowerBound]
        if let newline = head.lastIndex(of: "\n") {
            return String(text[text.index(after: newline)...])
        }
        return text
    }

    private func openHandle() throws -> FileHandle {
        if let h = handle { return h }
        let fm = FileManager.default
        if !fm.fileExists(atPath: fileURL.path) {
            fm.createFile(
                atPath: fileURL.path,
                contents: nil,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
        }
        let h = try FileHandle(forWritingTo: fileURL)
        handle = h
        return h
    }
}
