import Foundation

/// Route identity from geometry, ported from src/core/hash.ts. Gives the
/// same strings as the TypeScript core, so ids stored by either agree.
public enum Hash {
    /// Coordinates are compared at 1e-6 degrees (about 0.1 m), the precision Mapbox sends.
    static let quantumPerDegree = 1e6

    static func fnv1a(_ values: [Int32], seed: UInt32) -> UInt32 {
        var h = seed
        for v in values {
            let bits = UInt32(bitPattern: v)
            // Four bytes per 32-bit value, low byte first.
            for shift in stride(from: 0, to: 32, by: 8) {
                h ^= (bits >> UInt32(shift)) & 0xff
                h = h &* 0x0100_0193
            }
        }
        return h
    }

    /// Deterministic 64-bit fingerprint of a polyline, as 16 hex digits. Two
    /// FNV-1a passes with different seeds; for identity only, not for security.
    public static func geometryHash(_ geometry: [LngLat]) -> String {
        var values: [Int32] = [Int32(truncatingIfNeeded: geometry.count)]
        values.reserveCapacity(1 + geometry.count * 2)
        for p in geometry {
            values.append(JS.toInt32(JS.round(p.lng * quantumPerDegree)))
            values.append(JS.toInt32(JS.round(p.lat * quantumPerDegree)))
        }
        func hex(_ n: UInt32) -> String {
            let s = String(n, radix: 16)
            return String(repeating: "0", count: 8 - s.count) + s
        }
        return hex(fnv1a(values, seed: 0x811c_9dc5)) + hex(fnv1a(values, seed: 0x9747_b28c))
    }

    /// Route id from its geometry, so a route that comes back point for point
    /// in a later response keeps its id. Select.sameRouteGeometry answers
    /// "is this the same path?" when the points differ slightly.
    public static func routeIdFromGeometry(_ geometry: [LngLat]) -> String {
        "route-\(geometryHash(geometry))"
    }
}
