import Foundation

/// Small helpers that reproduce JavaScript number and string semantics where
/// the TypeScript core relies on them, so the Swift port gives the same
/// answers. Internal: the public API never needs them.
package enum JS {
    /// `Math.round`: halves round toward +infinity (-2.5 gives -2), unlike
    /// Swift's `.rounded()`, which rounds halves away from zero.
    package static func round(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        let down = x.rounded(.down)
        return x - down >= 0.5 ? down + 1 : down
    }

    /// `Math.min` of two numbers: NaN if either is NaN. Swift's `min` returns
    /// the other operand instead.
    package static func min(_ a: Double, _ b: Double) -> Double {
        a.isNaN || b.isNaN ? .nan : Swift.min(a, b)
    }

    /// `Math.max` of two numbers: NaN if either is NaN.
    package static func max(_ a: Double, _ b: Double) -> Double {
        a.isNaN || b.isNaN ? .nan : Swift.max(a, b)
    }

    /// The `ToInt32` conversion behind `x | 0`: truncate, then wrap modulo 2^32.
    package static func toInt32(_ x: Double) -> Int32 {
        guard x.isFinite else { return 0 }
        let t = x.rounded(.towardZero)
        var m = fmod(t, 4_294_967_296)
        if m < 0 { m += 4_294_967_296 }
        return Int32(bitPattern: UInt32(m))
    }

    /// A number as JavaScript's `Number.prototype.toString()` (and template
    /// literals) prints it: ECMAScript Number::toString laid out on Swift's
    /// shortest round-trip digits, which are the same digits JavaScript picks.
    package static func string(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        if x == 0 { return "0" }
        if x.isInfinite { return x > 0 ? "Infinity" : "-Infinity" }
        let sign = x < 0 ? "-" : ""
        // Swift's description is "123.45", "1e-07", "1.5e+22" or "123456.0".
        let text = abs(x).description
        let parts = text.split(separator: "e", maxSplits: 1, omittingEmptySubsequences: false)
        let mantissa = parts[0]
        let exponent = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        let pieces = mantissa.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let whole = String(pieces[0])
        let fraction = pieces.count > 1 ? String(pieces[1]) : ""
        var digits = whole + fraction
        // n: the position of the decimal point relative to the start of the digits.
        var n = whole.count + exponent
        while digits.count > 1, digits.first == "0" {
            digits.removeFirst()
            n -= 1
        }
        while digits.count > 1, digits.last == "0" { digits.removeLast() }
        let k = digits.count
        if k <= n && n <= 21 {
            return sign + digits + String(repeating: "0", count: n - k)
        }
        if 0 < n && n <= 21 {
            let i = digits.index(digits.startIndex, offsetBy: n)
            return sign + String(digits[..<i]) + "." + String(digits[i...])
        }
        if -6 < n && n <= 0 {
            return sign + "0." + String(repeating: "0", count: -n) + digits
        }
        let e = n - 1
        let exp = e < 0 ? "-\(-e)" : "+\(e)"
        if k == 1 { return sign + digits + "e" + exp }
        return sign + String(digits.prefix(1)) + "." + String(digits.dropFirst()) + "e" + exp
    }

    /// `Number.prototype.toFixed(digits)` for 0...20 digits: the decimal
    /// string closest to x, picking the larger one on an exact tie, with no
    /// sign on negative zero.
    package static func toFixed(_ x: Double, _ fractionDigits: Int) -> String {
        if x.isNaN { return "NaN" }
        if abs(x) >= 1e21 || x.isInfinite { return string(x) }
        let sign = x < 0 ? "-" : ""
        // glibc and Apple's libc print the exact binary value with enough digits.
        let exact = String(format: "%.80f", abs(x))
        let pieces = exact.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        var digits = Array(String(pieces[0]) + String((pieces.count > 1 ? pieces[1] : "").prefix(fractionDigits)))
            .map { Int($0.asciiValue! - 48) }
        let rest = pieces.count > 1 ? String(pieces[1].dropFirst(fractionDigits)) : ""
        // Round half up on the exact expansion: the first dropped digit decides.
        if let first = rest.first, first >= "5" {
            var i = digits.count - 1
            while i >= 0 {
                if digits[i] == 9 {
                    digits[i] = 0
                    i -= 1
                } else {
                    digits[i] += 1
                    break
                }
            }
            if i < 0 { digits.insert(1, at: 0) }
        }
        let text = digits.map(String.init).joined()
        let wholeCount = text.count - fractionDigits
        let wholePart = text.prefix(wholeCount)
        let fractionPart = text.suffix(fractionDigits)
        let body = fractionDigits == 0 ? String(wholePart) : "\(wholePart).\(fractionPart)"
        // (-0.00001).toFixed(4) is "-0.0000" in JavaScript: the sign comes from x < 0, not from the digits.
        return sign + body
    }

    /// The `<` of two JavaScript strings: UTF-16 code unit order.
    package static func less(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    /// A three-way comparison like the TypeScript `compare` helper: 0 when
    /// neither is less (equal, or either is NaN).
    package static func compare(_ a: Double, _ b: Double) -> Int {
        a < b ? -1 : (a > b ? 1 : 0)
    }

    package static func compare(_ a: String, _ b: String) -> Int {
        less(a, b) ? -1 : (less(b, a) ? 1 : 0)
    }

    package static func compare(_ a: Int, _ b: Int) -> Int {
        a < b ? -1 : (a > b ? 1 : 0)
    }

    /// `String.prototype.trim`: drops JavaScript white space and line
    /// terminators (Unicode Zs, tab, vertical tab, form feed, no-break space,
    /// BOM, line feed, carriage return, U+2028, U+2029) from both ends. Not
    /// Swift's `.whitespacesAndNewlines`, which also drops U+0085 and keeps the BOM.
    package static func trim(_ s: String) -> String {
        func isSpace(_ u: Unicode.Scalar) -> Bool {
            switch u.value {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0xFEFF, 0x2028, 0x2029: return true
            default: return u.properties.generalCategory == .spaceSeparator
            }
        }
        let scalars = Array(s.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end && isSpace(scalars[start]) { start += 1 }
        while end > start && isSpace(scalars[end - 1]) { end -= 1 }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars[start..<end])
        return String(out)
    }

    /// A string as a JavaScript Map or Set key: equal only when the UTF-16
    /// code units are equal. Swift's String equality also merges canonically
    /// equivalent strings ("é" and "e" + combining accent), JavaScript's does not.
    struct Key: Hashable {
        let units: [UInt16]

        init(_ s: String) {
            units = Array(s.utf16)
        }
    }

    /// `n + 1` that stops at Int.max instead of trapping. (A JavaScript
    /// counter is a double and never overflows.)
    package static func increment(_ n: Int) -> Int {
        n == .max ? .max : n + 1
    }
}

extension Array {
    /// `Array.prototype.sort` with a comparator: stable, like every modern
    /// JavaScript engine, whatever Swift's own sort guarantees.
    func jsSorted(_ compare: (Element, Element) -> Int) -> [Element] {
        enumerated()
            .sorted { a, b in
                let c = compare(a.element, b.element)
                return c != 0 ? c < 0 : a.offset < b.offset
            }
            .map(\.element)
    }
}
