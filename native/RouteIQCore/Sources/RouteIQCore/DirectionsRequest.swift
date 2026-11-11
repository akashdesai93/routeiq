import Foundation

/// The Mapbox Directions request URL, ported from buildDirectionsUrl in
/// src/providers/mapbox/client.ts. Pure: builds a string, sends nothing.
public enum DirectionsRequest {
    static let base = "https://api.mapbox.com/directions/v5/mapbox/driving-traffic"

    /// How far either side of the heading a road may point and still be the
    /// road the vehicle is on, in degrees. 45 keeps the opposite carriageway
    /// and most cross streets out.
    public static let headingRangeDeg = 45

    /// Six decimals is about 0.1 m: `Number(lng.toFixed(6))`, printed the JavaScript way.
    static func coordinate(_ p: LngLat) -> String {
        func six(_ v: Double) -> String { JS.string(Double(JS.toFixed(v, 6)) ?? v) }
        return "\(six(p.lng)),\(six(p.lat))"
    }

    /// `application/x-www-form-urlencoded`, as URLSearchParams writes it:
    /// letters, digits and `*-._` stay, a space becomes `+`, everything else
    /// is `%XX` of its UTF-8 bytes.
    static func formEncode(_ s: String) -> String {
        var out = ""
        for byte in s.utf8 {
            switch byte {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2A, 0x2D, 0x2E, 0x5F:
                out.append(Character(UnicodeScalar(byte)))
            case 0x20:
                out.append("+")
            default:
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    /// Directions request URL: traffic-aware driving, with alternatives, full
    /// GeoJSON geometry, steps, and banner and voice instructions. With
    /// `originHeadingDeg` (a moving vehicle), the origin gets a `bearings`
    /// entry so routes start in the direction of travel; the destination is
    /// left free. No `depart_at`: routes are for now, on live traffic.
    /// Nil when a coordinate is not valid.
    public static func urlString(
        origin: LngLat,
        destination: LngLat,
        token: String,
        originHeadingDeg: Double? = nil
    ) -> String? {
        guard Geo.isValidLngLat(origin), Geo.isValidLngLat(destination) else { return nil }
        var query: [(String, String)] = [
            ("alternatives", "true"),
            ("geometries", "geojson"),
            ("overview", "full"),
            ("steps", "true"),
            ("banner_instructions", "true"),
            ("voice_instructions", "true"),
            ("voice_units", "imperial"),
        ]
        if let heading = originHeadingDeg, heading.isFinite {
            // JavaScript % keeps the dividend's sign, as fmod does.
            let angle = fmod(fmod(JS.round(heading), 360) + 360, 360)
            query.append(("bearings", "\(JS.string(angle)),\(headingRangeDeg);"))
        }
        query.append(("access_token", token))
        let encoded = query.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&")
        return "\(base)/\(coordinate(origin))%3B\(coordinate(destination))?\(encoded)"
    }
}
